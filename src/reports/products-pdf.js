'use strict';

const pdf = require('../pdf');
const moves = require('../repo/product-moves');
const products = require('../repo/products');
const settings = require('../settings');
const util = require('../util');

const MONTH_NAMES = [
  'januar', 'februar', 'marec', 'april', 'maj', 'junij',
  'julij', 'avgust', 'september', 'oktober', 'november', 'december',
];

/** '2026-08' -> 'avgust 2026'. Left as-is if it is not a month key. */
function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return String(month || '');
  return `${MONTH_NAMES[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

function salonName() {
  return settings.get('salon_name') || 'Salon';
}

const MONTH_COLUMNS = [
  { header: 'Izdelek', width: 3.1 },
  { header: 'Dobava', width: 1, align: 'right' },
  { header: 'Prodano', width: 1, align: 'right' },
  { header: 'Povpr.prod.', width: 1.35, align: 'right' },
  { header: 'Prihodek', width: 1.35, align: 'right' },
  { header: 'Stroški', width: 1.35, align: 'right' },
  { header: 'Zaloga', width: 1, align: 'right' },
];

function monthRows(month) {
  const rows = moves.monthlySummary(month).map((row) => ({
    cells: [
      row.name,
      String(row.in_qty),
      String(row.out_qty),
      row.avg_sale_display,
      row.revenue_display,
      row.cost_display,
      String(row.stock),
    ],
  }));

  const totals = moves.monthTotals(month);
  rows.push({
    bold: true,
    cells: [
      'SKUPAJ',
      String(totals.in_qty),
      String(totals.out_qty),
      '',
      totals.revenue_display,
      totals.cost_display,
      '',
    ],
  });
  return { rows, totals };
}

/** Adds one month's table, or a note when the month is empty. */
function addMonthSection(doc, month, { heading = true } = {}) {
  if (heading) doc.heading(monthLabel(month));
  const { rows } = monthRows(month);
  if (rows.length === 1) {
    doc.paragraph('V tem mesecu ni zabeleženih gibanj.');
    return;
  }
  doc.table({ columns: MONTH_COLUMNS, rows });
}

const NOTE =
  'Prihodek so prodaje po ceni, ki je bila zabeležena ob prodaji, zato se ne ' +
  'spremeni, če pozneje spremenite ceno izdelka. Stroški so dobave, pri katerih ' +
  'je bila vpisana nabavna cena. Popravki (lom, poraba v salonu) niso šteti ne ' +
  'v prodajo ne v prihodek.';

/** One month, every product. */
function monthReport(month, { now = new Date() } = {}) {
  const doc = new pdf.Document({
    title: `${salonName()} — izdelki`,
    subtitle: `Mesečno poročilo za ${monthLabel(month)} · izvoženo ${stamp(now)}`,
    footer: `${salonName()} · izdelki · ${month}`,
  });

  addMonthSection(doc, month, { heading: false });
  doc.spacer(6);
  doc.paragraph(NOTE);

  return {
    buffer: doc.toBuffer(),
    filename: `${pdf.safeFilename(salonName())}-izdelki-${month}.pdf`,
  };
}

/** Every kept month, newest first, with a note on the retention window. */
function allMonthsReport({ now = new Date() } = {}) {
  const months = moves.months();
  const doc = new pdf.Document({
    title: `${salonName()} — izdelki`,
    subtitle:
      `Celotna shranjena zgodovina (${months.length ? months.length : 0} mesecev) · ` +
      `izvoženo ${stamp(now)}`,
    footer: `${salonName()} · izdelki · vsi meseci`,
  });

  if (!months.length) {
    doc.paragraph('Ni zabeleženih gibanj.');
    return {
      buffer: doc.toBuffer(),
      filename: `${pdf.safeFilename(salonName())}-izdelki-vsi-meseci.pdf`,
    };
  }

  for (const month of months) {
    addMonthSection(doc, month);
    doc.spacer(4);
  }

  doc.spacer(4);
  doc.rule();
  doc.paragraph(
    `Zgodovina se hrani ${moves.HISTORY_MONTHS} mesecev; starejši meseci so ` +
      'samodejno pobrisani in jih v tem izvozu ni. Zaloga izdelkov s tem ni ' +
      'spremenjena.'
  );
  doc.paragraph(NOTE);

  return {
    buffer: doc.toBuffer(),
    filename: `${pdf.safeFilename(salonName())}-izdelki-vsi-meseci.pdf`,
  };
}

const PRODUCT_MONTH_COLUMNS = [
  { header: 'Mesec', width: 1.6 },
  { header: 'Dobava', width: 1, align: 'right' },
  { header: 'Prodano', width: 1, align: 'right' },
  { header: 'Prihodek', width: 1.3, align: 'right' },
  { header: 'Povpr.prod.', width: 1.3, align: 'right' },
  { header: 'Povpr.nab.', width: 1.3, align: 'right' },
  { header: 'Razlika', width: 1.2, align: 'right' },
  { header: 'Popravki', width: 1, align: 'right' },
];

const MOVE_COLUMNS = [
  { header: 'Datum', width: 2.1 },
  { header: 'Vrsta', width: 1.1 },
  { header: 'Kos', width: 0.6, align: 'right' },
  { header: 'Cena/kos', width: 1.15, align: 'right' },
  { header: 'Skupaj', width: 1.15, align: 'right' },
  { header: 'Zaposlen', width: 1.5 },
  { header: 'Opomba', width: 2.2 },
];

/** One product: its per-month figures and, optionally, every movement. */
function productReport(productId, { now = new Date(), includeMoves = true } = {}) {
  const product = products.get(productId);
  if (!product) return null;

  const doc = new pdf.Document({
    title: `${salonName()} — ${product.name}`,
    subtitle: `Zgodovina izdelka · izvoženo ${stamp(now)}`,
    footer: `${salonName()} · ${product.name}`,
  });

  doc.table({
    columns: [
      { header: 'Podatek', width: 2 },
      { header: 'Vrednost', width: 2, align: 'right' },
    ],
    rows: [
      { cells: ['Prodajna cena (stranki)', util.formatMoney(product.price_cents)] },
      {
        cells: [
          'Nabavna cena (dobavitelju)',
          product.cost_cents ? util.formatMoney(product.cost_cents) : '—',
        ],
      },
      {
        cells: [
          'Razlika na kos',
          product.cost_cents
            ? util.formatMoney(product.price_cents - product.cost_cents)
            : '—',
        ],
      },
      { cells: ['Zaloga', String(product.quantity)] },
    ],
  });

  doc.heading('Po mesecih');
  const monthly = moves.monthlyForProduct(product.id);
  if (!monthly.length) {
    doc.paragraph('Za ta izdelek ni zabeleženih gibanj.');
  } else {
    doc.table({
      columns: PRODUCT_MONTH_COLUMNS,
      rows: monthly.map((m) => ({
        cells: [
          m.month,
          String(m.in_qty),
          String(m.out_qty),
          m.revenue_display,
          m.avg_sale_display,
          m.avg_buy_display,
          m.margin_display,
          m.adjust_qty ? String(m.adjust_qty) : '—',
        ],
      })),
    });
  }

  if (includeMoves) {
    const history = moves.listForProduct(product.id, 500);
    if (history.length) {
      doc.heading('Vsa gibanja');
      doc.table({
        columns: MOVE_COLUMNS,
        rows: history.map((h) => ({
          cells: [
            String(h.created_at).replace('T', ' ').slice(0, 16),
            h.kind_label,
            h.quantity > 0 ? `+${h.quantity}` : String(h.quantity),
            h.unit_price_cents ? h.unit_price_display : '—',
            h.total_cents ? h.total_display : '—',
            h.employee_name || '—',
            h.note || '',
          ],
        })),
      });
    }
  }

  doc.spacer(6);
  doc.paragraph(NOTE);

  return {
    buffer: doc.toBuffer(),
    filename: `${pdf.safeFilename(salonName())}-${pdf.safeFilename(product.name)}-zgodovina.pdf`,
  };
}

module.exports = { monthReport, allMonthsReport, productReport, monthLabel };
