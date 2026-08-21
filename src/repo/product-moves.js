'use strict';

const { db } = require('../db');
const products = require('./products');
const util = require('../util');

/**
 * Stock movements. Every change to a product's quantity is written here as well
 * as applied to the product, so the salon can answer "how many did we buy, how
 * many did we sell, and for how much" for any month — including after the
 * product's price has been changed.
 *
 *   in      supply arrived     quantity positive, price is the purchase price
 *   out     sold to a customer quantity negative, price is the sale price
 *   adjust  correction         quantity either way, no price
 */
const KINDS = ['in', 'out', 'adjust'];

const KIND_LABELS = {
  in: 'Dobava',
  out: 'Prodaja',
  adjust: 'Popravek',
};

/** 'YYYY-MM' in the server's own timezone, matching how the salon thinks. */
function monthKey(date = new Date()) {
  return (
    date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
  );
}

function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    kind_label: KIND_LABELS[row.kind] || row.kind,
    abs_quantity: Math.abs(row.quantity),
    unit_price_display: util.formatMoney(row.unit_price_cents),
    total_display: util.formatMoney(row.total_cents),
  };
}

/**
 * Record one movement and apply it to the product's stock.
 *
 * Stock is clamped at zero by the products repo, so selling more than is on
 * hand cannot produce a negative quantity. The movement is still recorded at
 * the quantity asked for, because the sale did happen — the stock count was
 * simply wrong, and a correction is the way to fix that.
 *
 * Returns { ok, product, move } or { ok: false, error }.
 */
function record({
  product_id,
  kind,
  quantity,
  unit_price_cents = 0,
  employee_id = null,
  note = '',
  now = new Date(),
}) {
  if (!KINDS.includes(kind)) return { ok: false, error: 'Neznana vrsta gibanja.' };

  const product = products.get(product_id);
  if (!product) return { ok: false, error: 'Izdelka ni mogoče najti.' };

  const amount = Math.round(Number(quantity));
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: 'Vpišite količino.' };
  }
  if (Math.abs(amount) > 999999) return { ok: false, error: 'Količina je prevelika.' };

  // The caller passes a plain count; the sign belongs to the kind.
  const signed =
    kind === 'in' ? Math.abs(amount) : kind === 'out' ? -Math.abs(amount) : amount;

  const price = Math.max(0, Math.round(Number(unit_price_cents) || 0));
  const total = Math.abs(signed) * price;
  const stamp = util.nowStamp();

  const info = db
    .prepare(
      `INSERT INTO product_moves
         (product_id, kind, quantity, unit_price_cents, total_cents,
          employee_id, note, month, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      product.id,
      kind,
      signed,
      price,
      total,
      employee_id || null,
      util.str(note, 300),
      monthKey(now),
      stamp
    );

  const updated = products.adjustQuantity(product.id, signed);
  return {
    ok: true,
    product: updated,
    move: decorate(db.prepare('SELECT * FROM product_moves WHERE id = ?').get(info.lastInsertRowid)),
  };
}

/** Most recent movements for one product. */
function listForProduct(productId, limit = 50) {
  return db
    .prepare(
      `SELECT m.*, e.first_name AS employee_first, e.last_name AS employee_last
         FROM product_moves m
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE m.product_id = ?
        ORDER BY m.id DESC
        LIMIT ?`
    )
    .all(Number(productId), Math.min(500, Math.max(1, limit)))
    .map((row) => ({
      ...decorate(row),
      employee_name: `${row.employee_first || ''} ${row.employee_last || ''}`.trim(),
    }));
}

/**
 * Per-month totals for one product, newest month first.
 *
 * The average prices are weighted by quantity, which is the number the salon
 * actually wants: if ten went out at €9.90 and one at €5, the average sale
 * price for the month is nearer €9.90 than €7.45.
 */
function monthlyForProduct(productId) {
  return db
    .prepare(
      `SELECT month,
              COALESCE(SUM(CASE WHEN kind = 'in'  THEN quantity END), 0)  AS in_qty,
              COALESCE(SUM(CASE WHEN kind = 'out' THEN -quantity END), 0) AS out_qty,
              COALESCE(SUM(CASE WHEN kind = 'out' THEN total_cents END), 0) AS revenue_cents,
              COALESCE(SUM(CASE WHEN kind = 'in'  THEN total_cents END), 0) AS cost_cents,
              COALESCE(SUM(CASE WHEN kind = 'out' AND unit_price_cents > 0
                                THEN -quantity END), 0) AS priced_out_qty,
              COALESCE(SUM(CASE WHEN kind = 'in'  AND unit_price_cents > 0
                                THEN quantity END), 0)  AS priced_in_qty,
              COALESCE(SUM(CASE WHEN kind = 'adjust' THEN quantity END), 0) AS adjust_qty
         FROM product_moves
        WHERE product_id = ?
        GROUP BY month
        ORDER BY month DESC`
    )
    .all(Number(productId))
    .map((row) => ({
      ...row,
      revenue_display: util.formatMoney(row.revenue_cents),
      cost_display: util.formatMoney(row.cost_cents),
      // Only units that carried a price count towards the average, so a
      // quick one-click sale with no price does not drag it down to zero.
      avg_sale_cents: row.priced_out_qty
        ? Math.round(row.revenue_cents / row.priced_out_qty)
        : null,
      avg_buy_cents: row.priced_in_qty
        ? Math.round(row.cost_cents / row.priced_in_qty)
        : null,
    }))
    .map((row) => ({
      ...row,
      avg_sale_display:
        row.avg_sale_cents === null ? '—' : util.formatMoney(row.avg_sale_cents),
      avg_buy_display:
        row.avg_buy_cents === null ? '—' : util.formatMoney(row.avg_buy_cents),
      margin_display:
        row.avg_sale_cents === null || row.avg_buy_cents === null
          ? '—'
          : util.formatMoney(row.avg_sale_cents - row.avg_buy_cents),
    }));
}

/** Every product's totals for one month, for the overview page. */
function monthlySummary(month) {
  return db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(SUM(CASE WHEN m.kind = 'in'  THEN m.quantity END), 0)  AS in_qty,
              COALESCE(SUM(CASE WHEN m.kind = 'out' THEN -m.quantity END), 0) AS out_qty,
              COALESCE(SUM(CASE WHEN m.kind = 'out' THEN m.total_cents END), 0) AS revenue_cents,
              COALESCE(SUM(CASE WHEN m.kind = 'in'  THEN m.total_cents END), 0) AS cost_cents,
              COALESCE(SUM(CASE WHEN m.kind = 'out' AND m.unit_price_cents > 0
                                THEN -m.quantity END), 0) AS priced_out_qty,
              p.quantity AS stock
         FROM products p
         JOIN product_moves m ON m.product_id = p.id AND m.month = ?
        GROUP BY p.id, p.name, p.quantity
        ORDER BY revenue_cents DESC, p.name COLLATE NOCASE`
    )
    .all(String(month))
    .map((row) => ({
      ...row,
      revenue_display: util.formatMoney(row.revenue_cents),
      cost_display: util.formatMoney(row.cost_cents),
      avg_sale_display: row.priced_out_qty
        ? util.formatMoney(Math.round(row.revenue_cents / row.priced_out_qty))
        : '—',
    }));
}

/** Months that have any movement at all, newest first, for the month picker. */
function months() {
  return db
    .prepare('SELECT DISTINCT month FROM product_moves ORDER BY month DESC')
    .all()
    .map((row) => row.month);
}

/** Totals across all products for one month. */
function monthTotals(month) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'in'  THEN quantity END), 0)  AS in_qty,
              COALESCE(SUM(CASE WHEN kind = 'out' THEN -quantity END), 0) AS out_qty,
              COALESCE(SUM(CASE WHEN kind = 'out' THEN total_cents END), 0) AS revenue_cents,
              COALESCE(SUM(CASE WHEN kind = 'in'  THEN total_cents END), 0) AS cost_cents
         FROM product_moves WHERE month = ?`
    )
    .get(String(month));
  return {
    ...row,
    revenue_display: util.formatMoney(row.revenue_cents),
    cost_display: util.formatMoney(row.cost_cents),
  };
}

/* ------------------------------------------------------------- retention */

/**
 * How much history is kept. The salon wants recent prices, not an archive: a
 * February from four years ago is of no use and only grows the database.
 */
const HISTORY_MONTHS = Math.max(
  1,
  Math.round(Number(process.env.PRODUCT_HISTORY_MONTHS) || 12)
);

/** The oldest month that is kept: the current month less `months`. */
function cutoffMonth(months = HISTORY_MONTHS, now = new Date()) {
  return monthKey(new Date(now.getFullYear(), now.getMonth() - months, 1));
}

/**
 * Delete movements older than the retention window.
 *
 * Month keys are 'YYYY-MM', so a plain string comparison orders them correctly.
 *
 * This does **not** touch a product's stock count. `products.quantity` is the
 * authoritative figure and is kept up to date as movements are recorded, so
 * forgetting last year's history leaves today's zaloga exactly as it was. The
 * consequence, deliberately accepted, is that stock can no longer be
 * recalculated from the movement list — which was never how it was read.
 */
function prune({ months = HISTORY_MONTHS, now = new Date() } = {}) {
  const cutoff = cutoffMonth(months, now);
  const info = db.prepare('DELETE FROM product_moves WHERE month < ?').run(cutoff);
  return { deleted: info.changes, cutoff };
}

let pruneTimer = null;

/**
 * Prune once at startup and then daily. Called from server.js; tests drive
 * prune() directly with a fixed clock.
 */
function startPruning() {
  if (pruneTimer) return;

  const run = () => {
    try {
      const out = prune();
      if (out.deleted) {
        console.log(
          `[izdelki] pobrisanih starih gibanj: ${out.deleted} (pred ${out.cutoff})`
        );
      }
    } catch (err) {
      console.error('[izdelki] napaka pri čiščenju zgodovine:', (err && err.message) || err);
    }
  };

  run();
  pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
  console.log(`[izdelki] zgodovina gibanj: ${HISTORY_MONTHS} mesecev`);
}

function stopPruning() {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

module.exports = {
  KINDS,
  KIND_LABELS,
  HISTORY_MONTHS,
  monthKey,
  cutoffMonth,
  record,
  listForProduct,
  monthlyForProduct,
  monthlySummary,
  monthTotals,
  months,
  prune,
  startPruning,
  stopPruning,
};
