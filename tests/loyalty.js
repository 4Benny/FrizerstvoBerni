'use strict';
/**
 * Loyalty counter tests.
 *
 * Booking counts a visit, cancelling takes it back, and reaching the threshold
 * redeems a free visit and resets the counter. The interesting cases are the
 * reversals: a cancelled redemption has to give the credit back, and it has to
 * give back what was actually spent even if the salon changed the threshold in
 * between.
 *
 *   node tests/loyalty.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-loyalty-test-${process.pid}.db`);
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

const { db } = require(path.join(__dirname, '..', 'src', 'db'));
const appointments = require(path.join(__dirname, '..', 'src', 'repo', 'appointments'));
const customers = require(path.join(__dirname, '..', 'src', 'repo', 'customers'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const loyalty = require(path.join(__dirname, '..', 'src', 'loyalty'));
const util = require(path.join(__dirname, '..', 'src', 'util'));

settings.set('paid_before_free', '3');

db.prepare(
  `INSERT INTO employees (id, first_name, last_name, username, password_hash, created_at)
   VALUES (900, 'Berni', '', 'berni-loyalty', 'x', ?)`
).run(util.nowStamp());

let day = 0;
/** Book a termin the way the API does: decide, create, apply. */
function book(customerId, price = 2500) {
  const customer = customers.get(customerId);
  const plan = loyalty.planFor(customer);
  day += 1;
  const appt = appointments.create({
    customer_id: customerId,
    employee_id: 900,
    service_id: null,
    service_name: 'Žensko striženje',
    date: `2026-09-${String(day).padStart(2, '0')}`,
    start_min: 600,
    duration_min: 30,
    price_cents: plan.isFree ? 0 : price,
    notes: '',
    is_free: plan.isFree,
    loyalty_delta: plan.delta,
    loyalty_applied: true,
  });
  customers.adjustVisitCount(customerId, plan.delta);
  return appt;
}

/** Change status the way the API does. */
function setStatus(appt, status) {
  const before = appointments.get(appt.id);
  const updated = appointments.setStatus(appt.id, status);
  loyalty.syncToStatus(before, status);
  return updated;
}

const count = (id) => customers.get(id).visit_count;

section('booking counts a visit');

const ana = customers.create({ first_name: 'Ana', last_name: 'N', phone: '031 111 111' });
ok('a new customer starts at zero', count(ana.id) === 0, count(ana.id));

const a1 = book(ana.id);
ok('booking counts one visit', count(ana.id) === 1, count(ana.id));
ok('an ordinary booking is not free', a1.is_free === 0, a1.is_free);
ok('the booking records what it did', a1.loyalty_delta === 1, a1.loyalty_delta);
ok('and that it is currently applied', a1.loyalty_applied === 1, a1.loyalty_applied);
ok('an ordinary booking keeps its price', a1.price_cents === 2500, a1.price_cents);

book(ana.id);
const a3 = book(ana.id);
ok('three bookings reach the threshold', count(ana.id) === 3, count(ana.id));
ok('the customer is now due a free visit', loyalty.stateFor(customers.get(ana.id)).eligible);

section('the next booking is the free one');

const free = book(ana.id);
ok('it is marked as the free visit', free.is_free === 1, free.is_free);
ok('it costs nothing', free.price_cents === 0, free.price_cents);
ok('the counter resets to zero', count(ana.id) === 0, count(ana.id));
ok('it recorded spending the whole balance', free.loyalty_delta === -3, free.loyalty_delta);
ok('the customer is no longer eligible', !loyalty.stateFor(customers.get(ana.id)).eligible);

const after = book(ana.id);
ok('counting starts again from one', count(ana.id) === 1, count(ana.id));
ok('and that booking is a paid one', after.is_free === 0, after.is_free);

section('cancelling gives the visit back');

const bob = customers.create({ first_name: 'Bo', last_name: 'B', phone: '031 222 222' });
const b1 = book(bob.id);
book(bob.id);
ok('two bookings, two visits', count(bob.id) === 2, count(bob.id));

setStatus(b1, 'cancelled');
ok('cancelling removes that visit', count(bob.id) === 1, count(bob.id));
ok('the appointment no longer counts',
  appointments.get(b1.id).loyalty_applied === 0, appointments.get(b1.id).loyalty_applied);

setStatus(b1, 'cancelled');
ok('cancelling twice does not double-subtract', count(bob.id) === 1, count(bob.id));

setStatus(b1, 'scheduled');
ok('re-opening counts it again', count(bob.id) === 2, count(bob.id));
setStatus(b1, 'scheduled');
ok('re-opening twice does not double-add', count(bob.id) === 2, count(bob.id));

setStatus(b1, 'completed');
ok('completing changes nothing, booking already counted', count(bob.id) === 2, count(bob.id));

setStatus(b1, 'no_show');
ok('a no-show also takes the visit back', count(bob.id) === 1, count(bob.id));

section('cancelling a free visit returns the credit');

const cvet = customers.create({ first_name: 'Cvet', last_name: 'C', phone: '031 333 333' });
book(cvet.id); book(cvet.id); book(cvet.id);
ok('at the threshold', count(cvet.id) === 3 && loyalty.stateFor(customers.get(cvet.id)).eligible);

const cFree = book(cvet.id);
ok('the free visit reset the counter', count(cvet.id) === 0, count(cvet.id));

setStatus(cFree, 'cancelled');
ok('cancelling it gives the whole balance back', count(cvet.id) === 3, count(cvet.id));
ok('so the customer is owed a free visit again',
  loyalty.stateFor(customers.get(cvet.id)).eligible);

setStatus(cFree, 'scheduled');
ok('re-opening spends it again', count(cvet.id) === 0, count(cvet.id));

section('changing the threshold does not corrupt a reversal');

const dana = customers.create({ first_name: 'Dana', last_name: 'D', phone: '031 444 444' });
book(dana.id); book(dana.id); book(dana.id);
const dFree = book(dana.id);
ok('redeemed at a threshold of three', dFree.loyalty_delta === -3, dFree.loyalty_delta);

// The salon decides free visits should come round less often.
settings.set('paid_before_free', '10');
setStatus(dFree, 'cancelled');
ok('the reversal returns what was actually spent, not the new threshold',
  count(dana.id) === 3, count(dana.id));
ok('and the customer is not eligible under the new rule',
  !loyalty.stateFor(customers.get(dana.id)).eligible);
settings.set('paid_before_free', '3');

section('the counter never goes negative');

const eva = customers.create({ first_name: 'Eva', last_name: 'E', phone: '031 555 555' });
const e1 = book(eva.id);
customers.setVisitCount(eva.id, 0); // someone corrected it by hand
setStatus(e1, 'cancelled');
ok('a reversal below zero is clamped', count(eva.id) === 0, count(eva.id));

section('a manual correction still works');

customers.setVisitCount(ana.id, 2);
ok('staff can set the counter by hand', count(ana.id) === 2, count(ana.id));
const manualNext = book(ana.id);
ok('and the automatic counting carries on from there',
  count(ana.id) === 3 && manualNext.is_free === 0, count(ana.id));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
