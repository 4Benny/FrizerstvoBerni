'use strict';
/**
 * Stock movement tests: supply in, sales out, corrections, and the per-month
 * figures the salon uses to see how many were bought, how many were sold and at
 * what price — including after the product's price has been changed.
 *
 *   node tests/products.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-products-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
process.env.SALON_DB = DB;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
}
function section(n) { console.log(`\n== ${n} ==`); }

const products = require(path.join(__dirname, '..', 'src', 'repo', 'products'));
const moves = require(path.join(__dirname, '..', 'src', 'repo', 'product-moves'));

/** A fixed clock, so the month grouping is deterministic. */
const JAN = new Date(2026, 0, 15, 10, 0, 0);
const FEB = new Date(2026, 1, 10, 10, 0, 0);

section('supply and sales move the stock');

const shampoo = products.create({
  name: 'Šampon', description: '', quantity: 0, price_cents: 990, active: 1,
});
ok('product starts empty', shampoo.quantity === 0, shampoo.quantity);

let r = moves.record({
  product_id: shampoo.id, kind: 'in', quantity: 12, unit_price_cents: 600, now: JAN,
});
ok('supply is accepted', r.ok === true, r);
ok('supply raises the stock', r.product.quantity === 12, r.product.quantity);
ok('supply is stored as a positive movement', r.move.quantity === 12, r.move.quantity);
ok('supply total is quantity times price', r.move.total_cents === 12 * 600, r.move.total_cents);

r = moves.record({
  product_id: shampoo.id, kind: 'out', quantity: 3, unit_price_cents: 990, now: JAN,
});
ok('a sale is accepted', r.ok === true, r);
ok('a sale lowers the stock', r.product.quantity === 9, r.product.quantity);
ok('a sale is stored as a negative movement', r.move.quantity === -3, r.move.quantity);

r = moves.record({ product_id: shampoo.id, kind: 'adjust', quantity: -1, now: JAN });
ok('a correction is accepted', r.ok === true, r);
ok('a negative correction lowers the stock', r.product.quantity === 8, r.product.quantity);
ok('a correction carries no money', r.move.total_cents === 0, r.move.total_cents);

section('refusals');

ok('an unknown kind is refused',
  moves.record({ product_id: shampoo.id, kind: 'nonsense', quantity: 1 }).ok === false);
ok('a missing product is refused',
  moves.record({ product_id: 99999, kind: 'in', quantity: 1 }).ok === false);
ok('zero quantity is refused',
  moves.record({ product_id: shampoo.id, kind: 'in', quantity: 0 }).ok === false);
ok('a non-numeric quantity is refused',
  moves.record({ product_id: shampoo.id, kind: 'in', quantity: 'veliko' }).ok === false);
ok('an absurd quantity is refused',
  moves.record({ product_id: shampoo.id, kind: 'in', quantity: 10000000 }).ok === false);
ok('the stock survived the refusals', products.get(shampoo.id).quantity === 8,
  products.get(shampoo.id).quantity);

section('stock never goes negative, but the sale is still recorded');

const rare = products.create({
  name: 'Serum', description: '', quantity: 1, price_cents: 2500, active: 1,
});
r = moves.record({
  product_id: rare.id, kind: 'out', quantity: 5, unit_price_cents: 2500, now: JAN,
});
ok('overselling is allowed to be recorded', r.ok === true, r);
ok('stock is clamped at zero', r.product.quantity === 0, r.product.quantity);
ok('the full sale is still in the history', r.move.quantity === -5, r.move.quantity);
ok('revenue counts all five', r.move.total_cents === 5 * 2500, r.move.total_cents);

section('monthly figures for one product');

// A second month, at a different price, to prove the history is per-month.
moves.record({
  product_id: shampoo.id, kind: 'in', quantity: 6, unit_price_cents: 700, now: FEB,
});
moves.record({
  product_id: shampoo.id, kind: 'out', quantity: 2, unit_price_cents: 1090, now: FEB,
});
// The product's current price changes — the history must not follow it.
products.update(shampoo.id, {
  name: 'Šampon', description: '', price_cents: 1290, active: 1,
});

const monthly = moves.monthlyForProduct(shampoo.id);
ok('one row per month, newest first',
  monthly.length === 2 && monthly[0].month === '2026-02' && monthly[1].month === '2026-01',
  monthly.map((m) => m.month));

const jan = monthly.find((m) => m.month === '2026-01');
const feb = monthly.find((m) => m.month === '2026-02');

ok('January supplied count', jan.in_qty === 12, jan.in_qty);
ok('January sold count', jan.out_qty === 3, jan.out_qty);
ok('January revenue', jan.revenue_cents === 3 * 990, jan.revenue_cents);
ok('January average sale price', jan.avg_sale_cents === 990, jan.avg_sale_cents);
ok('January average purchase price', jan.avg_buy_cents === 600, jan.avg_buy_cents);
ok('January corrections are counted separately', jan.adjust_qty === -1, jan.adjust_qty);
ok('corrections stay out of the sold count', jan.out_qty === 3, jan.out_qty);

ok('February supplied count', feb.in_qty === 6, feb.in_qty);
ok('February sold count', feb.out_qty === 2, feb.out_qty);
ok('February revenue at the new price', feb.revenue_cents === 2 * 1090, feb.revenue_cents);
ok('February keeps its own sale price', feb.avg_sale_cents === 1090, feb.avg_sale_cents);
ok('February keeps its own purchase price', feb.avg_buy_cents === 700, feb.avg_buy_cents);
ok('editing the product price did not rewrite history',
  jan.avg_sale_cents === 990 && feb.avg_sale_cents === 1090,
  { jan: jan.avg_sale_cents, feb: feb.avg_sale_cents });
ok('the margin is sale minus purchase',
  feb.avg_sale_cents - feb.avg_buy_cents === 390, feb.avg_sale_cents - feb.avg_buy_cents);

section('averages are weighted, and unpriced units do not distort them');

const wax = products.create({
  name: 'Vosek', description: '', quantity: 20, price_cents: 1000, active: 1,
});
moves.record({ product_id: wax.id, kind: 'out', quantity: 10, unit_price_cents: 1000, now: JAN });
moves.record({ product_id: wax.id, kind: 'out', quantity: 1, unit_price_cents: 500, now: JAN });
const waxJan = moves.monthlyForProduct(wax.id)[0];
// Weighted: 10500 / 11 = 954.5 -> 955, not the flat mean of 750.
ok('the average is weighted by quantity', waxJan.avg_sale_cents === 955, waxJan.avg_sale_cents);
ok('revenue is the sum of the lines', waxJan.revenue_cents === 10500, waxJan.revenue_cents);

// A one-click sale with no price recorded must not drag the average to zero.
moves.record({ product_id: wax.id, kind: 'out', quantity: 2, unit_price_cents: 0, now: JAN });
const waxAfter = moves.monthlyForProduct(wax.id)[0];
ok('an unpriced sale still counts as sold', waxAfter.out_qty === 13, waxAfter.out_qty);
ok('an unpriced sale leaves the average alone',
  waxAfter.avg_sale_cents === 955, waxAfter.avg_sale_cents);

section('the month-wide report');

const summary = moves.monthlySummary('2026-01');
ok('every product with movement appears', summary.length === 3, summary.map((s) => s.name));
ok('the report is ordered by revenue',
  summary[0].revenue_cents >= summary[1].revenue_cents, summary.map((s) => s.revenue_cents));
ok('a product with no movement that month is left out',
  !moves.monthlySummary('2026-02').some((s) => s.name === 'Serum'),
  moves.monthlySummary('2026-02').map((s) => s.name));

const totals = moves.monthTotals('2026-01');
ok('January totals add up the supply', totals.in_qty === 12, totals.in_qty);
ok('January totals add up the sales', totals.out_qty === 3 + 5 + 13, totals.out_qty);
ok('January totals add up the revenue',
  totals.revenue_cents === 3 * 990 + 5 * 2500 + 10500, totals.revenue_cents);

ok('the month list is newest first',
  JSON.stringify(moves.months()) === JSON.stringify(['2026-02', '2026-01']), moves.months());

section('history');

const history = moves.listForProduct(shampoo.id);
ok('history is newest first', history[0].month === '2026-02', history[0].month);
ok('history rows carry a readable kind', history.every((h) => !!h.kind_label));
ok('history shows the price each line went at',
  history.some((h) => h.unit_price_cents === 990) &&
  history.some((h) => h.unit_price_cents === 1090));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
