'use strict';
/**
 * Public self-booking tests.
 *
 * This is an unauthenticated form on the open internet, so the assertions that
 * matter are the refusals: a wrong code, an expired code, too many guesses, too
 * many codes, a slot outside the employee's hours, a slot already taken, and a
 * slot taken during the seconds the customer spent reading the SMS.
 *
 *   node tests/booking.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-booking-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
process.env.SALON_DB = DB;
process.env.BOOKING_LEAD_MINUTES = '120';

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
const employees = require(path.join(__dirname, '..', 'src', 'repo', 'employees'));
const customers = require(path.join(__dirname, '..', 'src', 'repo', 'customers'));
const services = require(path.join(__dirname, '..', 'src', 'repo', 'services'));
const appointments = require(path.join(__dirname, '..', 'src', 'repo', 'appointments'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const schedule = require(path.join(__dirname, '..', 'src', 'schedule'));
const booking = require(path.join(__dirname, '..', 'src', 'booking'));
const util = require(path.join(__dirname, '..', 'src', 'util'));

/** The code only exists as a hash, so tests read it out of the queued SMS. */
function lastCode() {
  const row = db
    .prepare("SELECT body FROM sms_log WHERE kind = 'verify' ORDER BY id DESC LIMIT 1")
    .get();
  const m = row && /(\d{6})/.exec(row.body);
  return m ? m[1] : null;
}
function lastCodeId() {
  return db.prepare('SELECT id FROM booking_codes ORDER BY id DESC LIMIT 1').get().id;
}

const FRI = '2027-01-08'; // a Friday, far enough ahead that lead time is moot
const worker = employees.create({
  first_name: 'Ana', last_name: 'A', username: 'ana-book', password: 'geslo123',
  role: 'employee', active: 1,
});
employees.setWorkHours(worker.id, schedule.readForm({
  mode_5: 'open', open_5: '09:00', close_5: '17:00',
}).json);

const cut = services.create({
  name: 'Striženje', description: '', duration_min: 30, price_cents: 2000, active: 1,
});
const long = services.create({
  name: 'Barvanje', description: '', duration_min: 180, price_cents: 6000, active: 1,
});

const base = () => ({
  phone: '031 777 888',
  firstName: 'Nova',
  lastName: 'Stranka',
  serviceId: cut.id,
  employeeId: worker.id,
  date: FRI,
  startMin: 10 * 60,
});

section('matching a phone number however it is written');
{
  // Slovenian national numbers are eight digits, so comparing a fixed number
  // of trailing digits gets +386 51 … and 051 … wrong. Staff type the local
  // form; the website stores the international one. They have to meet.
  const n = customers.nationalDigits;
  ok('local and international agree', n('051 321 321') === n('+386 51 321 321'),
    [n('051 321 321'), n('+386 51 321 321')]);
  ok('00386 agrees too', n('00386 51 321 321') === n('051 321 321'));
  ok('spacing and punctuation do not matter',
    n('(031) 123-456') === n('031123456'));
  ok('a nine-digit mobile still works', n('031 123 456') === n('+386 31 123 456'),
    [n('031 123 456'), n('+386 31 123 456')]);
  ok('two different numbers stay different', n('031 123 456') !== n('031 123 457'));
  ok('nothing matches nothing', n('') === '' && n(null) === '');

  const typed = customers.create({
    first_name: 'Ročno', last_name: 'Vpisana', phone: '051 321 999',
  });
  ok('a hand-typed customer is found by the international form',
    customers.byPhone('+38651321999') &&
    customers.byPhone('+38651321999').id === typed.id);
  ok('a number too short to be meaningful matches nobody',
    customers.byPhone('12345') === null);
}

section('the feature has to be switched on');

settings.set('public_booking_enabled', '0');
settings.set('sms_enabled', '0');
ok('off by default', !booking.isEnabled());
ok('a code cannot be requested', booking.requestCode('031 777 888').ok === false);
ok('and nothing can be booked', booking.book(base()).ok === false);

settings.set('public_booking_enabled', '1');
ok('still off while SMS is off — the code could not be sent', !booking.isEnabled());
settings.set('sms_enabled', '1');
ok('on once both are set', booking.isEnabled());

section('the code proves the number');

const first = booking.requestCode('031 777 888');
ok('a code is issued', first.ok === true, first);
ok('the number is normalised', first.phone === '+38631777888', first.phone);
ok('the code was queued as an SMS', !!lastCode(), 'no verify SMS');
ok('the stored code is a hash, not the code',
  !db.prepare('SELECT code_hash FROM booking_codes WHERE id = ?').get(first.id)
    .code_hash.includes(lastCode()));

const code = lastCode();
ok('a wrong code is refused', booking.verifyCode(first.id, '000000').ok === false);
ok('a code for another id is refused', booking.verifyCode(99999, code).ok === false);
ok('the right code is accepted', booking.verifyCode(first.id, code).ok === true);
ok('and cannot be used twice', booking.verifyCode(first.id, code).ok === false);

section('guessing is limited');

const guessing = booking.requestCode('031 777 888');
const realCode = lastCode();
for (let i = 0; i < 5; i += 1) booking.verifyCode(guessing.id, '111111');
const afterGuesses = booking.verifyCode(guessing.id, realCode);
ok('the right code no longer works after too many guesses',
  afterGuesses.ok === false, afterGuesses);
ok('and it says so', /Preveč/.test(afterGuesses.error), afterGuesses.error);

section('an expired code is dead');

const expiring = booking.requestCode('031 777 888');
const expiringCode = lastCode();
const later = new Date(Date.now() + (booking.CODE_TTL_MINUTES + 1) * 60000);
const expired = booking.verifyCode(expiring.id, expiringCode, { now: later });
ok('an expired code is refused', expired.ok === false, expired);
ok('and it says why', /potekla/.test(expired.error), expired.error);

section('codes per number are limited');

// Three were already requested above; the cap is five per hour.
booking.requestCode('031 777 888');
booking.requestCode('031 777 888');
const tooMany = booking.requestCode('031 777 888');
ok('the sixth request in an hour is refused', tooMany.ok === false, tooMany);
ok('a different number is unaffected', booking.requestCode('040 111 222').ok === true);

section('what may be booked');

ok('a slot outside the working day is refused',
  booking.book({ ...base(), startMin: 8 * 60 }).ok === false, 'expected 08:00 refused');
ok('a day she does not work is refused',
  booking.book({ ...base(), date: '2027-01-09' }).ok === false, 'expected Saturday refused');
ok('a service that does not fit the day is refused',
  booking.book({ ...base(), serviceId: long.id, startMin: 15 * 60 }).ok === false,
  '3h from 15:00 runs past 17:00');
ok('a slot off the grid is refused',
  booking.book({ ...base(), startMin: 10 * 60 + 7 }).ok === false, 'expected 10:07 refused');
ok('a date in the past is refused',
  booking.book({ ...base(), date: '2020-01-03' }).ok === false);
ok('an unknown service is refused', booking.book({ ...base(), serviceId: 9999 }).ok === false);
ok('an unknown employee is refused', booking.book({ ...base(), employeeId: 9999 }).ok === false);
ok('a missing name is refused', booking.book({ ...base(), firstName: '  ' }).ok === false);
ok('an unusable phone is refused', booking.book({ ...base(), phone: 'ni telefona' }).ok === false);

section('a booking that works');

const made = booking.book(base());
ok('it is accepted', made.ok === true, made);
ok('the appointment is at the chosen time',
  made.appointment.date === FRI && made.appointment.start_min === 600,
  { date: made.appointment.date, start: made.appointment.start_min });
ok('it takes the service duration and price',
  made.appointment.duration_min === 30 && made.appointment.price_cents === 2000,
  made.appointment);
ok('a customer record was created', !!made.customer && made.customer.id > 0);
ok('the number was stored in international form',
  made.customer.phone === '+38631777888', made.customer.phone);
ok('the visit counter moved with it', made.customer.visit_count === 1,
  made.customer.visit_count);
ok('a confirmation SMS was queued',
  !!db.prepare("SELECT id FROM sms_log WHERE kind = 'booked' ORDER BY id DESC LIMIT 1").get());

section('the same person does not become two customers');

const again = booking.book({ ...base(), phone: '+386 31 777 888', startMin: 11 * 60 });
ok('a second booking is accepted', again.ok === true, again);
ok('written differently, the same number finds the same customer',
  again.customer.id === made.customer.id, { first: made.customer.id, second: again.customer.id });
ok('and the counter kept counting', again.customer.visit_count === 2, again.customer.visit_count);

section('a taken slot cannot be taken twice');

const clash = booking.book({ ...base(), phone: '041 222 333', firstName: 'Druga' });
ok('the same slot is refused', clash.ok === false, clash);
ok('it is reported as taken rather than a plain error', clash.taken === true, clash);

// Staff booking over it directly still works — this only governs the website.
const staffAppt = appointments.create({
  customer_id: made.customer.id, employee_id: worker.id, service_id: null,
  service_name: 'Staff overlap', date: FRI, start_min: 10 * 60, duration_min: 30,
  price_cents: 0, notes: '',
});
ok('staff may still double-book deliberately', staffAppt.id > 0);

section('a slot taken while the customer was reading the SMS');

// The offered list was correct when the page was built; somebody else got in
// first. The write has to notice, which is the whole point of re-checking.
const late = { ...base(), phone: '041 555 666', firstName: 'Pozna', startMin: 13 * 60 };
ok('the slot is free when offered',
  require(path.join(__dirname, '..', 'src', 'availability'))
    .slotsFor(employees.get(worker.id), FRI, 30).includes(13 * 60));
appointments.create({
  customer_id: made.customer.id, employee_id: worker.id, service_id: null,
  service_name: 'Sneaked in', date: FRI, start_min: 13 * 60, duration_min: 30,
  price_cents: 0, notes: '',
});
const lost = booking.book(late);
ok('the booking loses the race cleanly', lost.ok === false && lost.taken === true, lost);
// Refused before anything is written, so a failed booking leaves no half
// customer behind to clutter the list.
ok('a refused booking creates no customer record',
  customers.byPhone('+38641555666') === null,
  customers.byPhone('+38641555666'));

// Note what this does and does not prove. The refusal above came from the
// availability check, which rebuilds the offered list at write time. The
// conflict check inside the transaction is the backstop for the far narrower
// window between that check and the insert; it cannot be reached from a single
// thread, which is exactly why it has to be inside the transaction rather than
// relied on from outside.

section('open bookings per number are limited');

const spammer = { ...base(), phone: '040 999 000', firstName: 'Veliko' };
const times = [9 * 60, 9 * 60 + 30, 11 * 60 + 30, 12 * 60];
const results = times.map((startMin) => booking.book({ ...spammer, startMin }));
ok('the first three are accepted', results.slice(0, 3).every((r) => r.ok === true),
  results.map((r) => r.ok));
ok('the fourth is refused', results[3].ok === false, results[3]);
ok('the refusal points at the phone', /pokličite/i.test(results[3].error), results[3].error);

section('a returning customer redeems their free visit');

// A number of its own: the earlier customer has already hit the open-bookings
// cap, which would refuse this booking for an unrelated reason.
settings.set('paid_before_free', '2');
const loyalPhone = '051 321 321';
const loyal = customers.create({
  first_name: 'Zvesta', last_name: 'Z', phone: loyalPhone, visit_count: 2,
});
const freeOne = booking.book({
  ...base(), phone: loyalPhone, firstName: 'Zvesta', startMin: 14 * 60,
});
ok('the booking is accepted', freeOne.ok === true, freeOne);
ok('it is the free one', freeOne.appointment.is_free === 1, freeOne.appointment.is_free);
ok('and it costs nothing', freeOne.appointment.price_cents === 0, freeOne.appointment.price_cents);
ok('the counter reset', freeOne.customer.visit_count === 0, freeOne.customer.visit_count);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
