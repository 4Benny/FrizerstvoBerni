'use strict';
/**
 * Working hours and free-slot tests.
 *
 * These are the sums behind customers booking themselves, so the cases that
 * matter are the awkward ones: gaps that are exactly long enough, a service
 * that is one minute too long, appointments that overlap each other, a
 * cancellation that gives the time back, and two employees at the same hour.
 *
 *   node tests/availability.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-avail-test-${process.pid}.db`);
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
const appointments = require(path.join(__dirname, '..', 'src', 'repo', 'appointments'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const schedule = require(path.join(__dirname, '..', 'src', 'schedule'));
const availability = require(path.join(__dirname, '..', 'src', 'availability'));
const util = require(path.join(__dirname, '..', 'src', 'util'));

const hhmm = (min) => util.formatTime(min);

// A Friday, a Saturday and a Sunday well in the future so the lead time never
// interferes. 2027-01-08 is a Friday.
const FRI = '2027-01-08';
const SAT = '2027-01-09';
const SUN = '2027-01-10';
const NOW = new Date(2027, 0, 1, 9, 0, 0);

ok('the fixture dates are the weekdays they claim',
  util.dayOfWeek(FRI) === 5 && util.dayOfWeek(SAT) === 6 && util.dayOfWeek(SUN) === 0,
  [util.dayOfWeek(FRI), util.dayOfWeek(SAT), util.dayOfWeek(SUN)]);

const worker1 = employees.create({
  first_name: 'Ana', last_name: 'A', username: 'ana-w', password: 'geslo123', role: 'employee', active: 1,
});
const worker2 = employees.create({
  first_name: 'Bea', last_name: 'B', username: 'bea-w', password: 'geslo123', role: 'employee', active: 1,
});
const client = customers.create({ first_name: 'Cita', last_name: 'C', phone: '031 000 111' });

let seq = 0;
function bookFor(employeeId, date, startMin, durationMin, status = 'scheduled') {
  seq += 1;
  const appt = appointments.create({
    customer_id: client.id,
    employee_id: employeeId,
    service_id: null,
    service_name: `Test ${seq}`,
    date,
    start_min: startMin,
    duration_min: durationMin,
    price_cents: 0,
    notes: '',
  });
  if (status !== 'scheduled') appointments.setStatus(appt.id, status);
  return appt;
}

section('a schedule the worker sets herself');

// Exactly the example: Friday 9–17, Saturday off, Sunday 10–13.
const week = schedule.readForm({
  mode_1: 'closed', mode_2: 'closed', mode_3: 'closed', mode_4: 'closed',
  mode_5: 'open', open_5: '09:00', close_5: '17:00',
  mode_6: 'closed',
  mode_0: 'open', open_0: '10:00', close_0: '13:00',
});
ok('the form is accepted', !week.error, week.error);
employees.setWorkHours(worker1.id, week.json);
const w1 = employees.get(worker1.id);

ok('works Friday 09:00-17:00',
  hhmm(schedule.windowFor(w1, FRI).startMin) === '09:00' &&
  hhmm(schedule.windowFor(w1, FRI).endMin) === '17:00',
  schedule.windowFor(w1, FRI));
ok('does not work Saturday', schedule.windowFor(w1, SAT) === null);
ok('works Sunday 10:00-13:00',
  hhmm(schedule.windowFor(w1, SUN).startMin) === '10:00' &&
  hhmm(schedule.windowFor(w1, SUN).endMin) === '13:00',
  schedule.windowFor(w1, SUN));
ok('Sunday counts even though the salon is closed then',
  settings.openingHours()['0'].closed === true && schedule.worksOn(w1, SUN),
  'a worker may work when the salon shows closed');

ok('a start after the end is refused',
  !!schedule.readForm({ mode_5: 'open', open_5: '17:00', close_5: '09:00' }).error);
ok('a missing time is refused',
  !!schedule.readForm({ mode_5: 'open', open_5: '', close_5: '17:00' }).error);

section('an employee with no schedule follows the salon');

const w2 = employees.get(worker2.id);
ok('reported as inherited', schedule.listForEmployee(w2).inherited === true);
ok('inherits the salon Friday window',
  hhmm(schedule.windowFor(w2, FRI).startMin) === '08:00', schedule.windowFor(w2, FRI));
ok('inherits the salon Sunday closure', schedule.windowFor(w2, SUN) === null);

section('free slots inside an empty day');

let slots = availability.slotsFor(w1, FRI, 30, { now: NOW });
ok('the first slot is at the start of the shift', hhmm(slots[0]) === '09:00', hhmm(slots[0]));
ok('the last 30-minute slot ends exactly at close',
  hhmm(slots[slots.length - 1]) === '16:30', hhmm(slots[slots.length - 1]));
ok('slots sit on the 15-minute grid',
  slots.every((s) => s % availability.SLOT_STEP === 0));
// 09:00 to 16:30 inclusive on a 15-minute grid.
ok('an 8-hour shift holds 31 half-hour starts', slots.length === 31, slots.length);

ok('nothing is offered on a day she does not work',
  availability.slotsFor(w1, SAT, 30, { now: NOW }).length === 0);

section('a booking removes the time it uses');

bookFor(worker1.id, FRI, 10 * 60, 60); // 10:00-11:00
slots = availability.slotsFor(w1, FRI, 30, { now: NOW }).map(hhmm);
ok('the booked hour is gone',
  !slots.includes('10:00') && !slots.includes('10:30'), slots.slice(0, 10));
ok('a start that would run into it is gone', !slots.includes('09:45'), slots.slice(0, 8));
ok('the slot ending exactly at the booking is kept', slots.includes('09:30'), slots.slice(0, 8));
ok('the slot starting exactly at its end is kept', slots.includes('11:00'), slots.slice(0, 12));

section('a service only appears if it fits the gap');

// Leave exactly 45 minutes free: 11:00-11:45, then busy 11:45-13:00.
bookFor(worker1.id, FRI, 11 * 60 + 45, 75);
const gaps = availability.gapsFor(w1, FRI);
const gap = gaps.find((g) => g.start === 11 * 60);
ok('the gap is exactly 45 minutes', gap && gap.end - gap.start === 45, gap);

ok('a 45-minute service fits exactly',
  availability.slotsFor(w1, FRI, 45, { now: NOW }).map(hhmm).includes('11:00'));
ok('a 60-minute service does not fit',
  !availability.slotsFor(w1, FRI, 60, { now: NOW }).map(hhmm).includes('11:00'));
ok('one minute too long is still too long',
  !availability.slotsFor(w1, FRI, 46, { now: NOW }).map(hhmm).includes('11:00'));

section('overlapping staff bookings do not punch holes');

// Staff may double-book on purpose; the merged busy list must not leave a
// phantom gap between two overlapping appointments.
const over1 = bookFor(worker2.id, FRI, 9 * 60, 60);   // 09:00-10:00
bookFor(worker2.id, FRI, 9 * 60 + 30, 60);            // 09:30-10:30, overlapping
const w2gaps = availability.gapsFor(w2, FRI);
ok('the two overlapping bookings count as one busy block',
  !w2gaps.some((g) => g.start >= 9 * 60 && g.end <= 10 * 60 + 30), w2gaps);
ok('free time resumes after the later end',
  w2gaps.some((g) => g.start === 10 * 60 + 30), w2gaps);

section('cancelled and no-show give the time back');

const cancelled = bookFor(worker1.id, FRI, 14 * 60, 60, 'cancelled');
ok('a cancelled booking frees its slot',
  availability.slotsFor(w1, FRI, 60, { now: NOW }).map(hhmm).includes('14:00'),
  'expected 14:00 free again');
appointments.setStatus(cancelled.id, 'scheduled');
ok('re-opening takes it back',
  !availability.slotsFor(w1, FRI, 60, { now: NOW }).map(hhmm).includes('14:00'));
appointments.setStatus(cancelled.id, 'no_show');
ok('a no-show frees it too',
  availability.slotsFor(w1, FRI, 60, { now: NOW }).map(hhmm).includes('14:00'));
appointments.setStatus(cancelled.id, 'cancelled');

section('two employees at the same time');

employees.setWorkHours(worker2.id, week.json);
const bea = employees.get(worker2.id);
appointments.setStatus(over1.id, 'cancelled');
db.prepare("UPDATE appointments SET status = 'cancelled' WHERE employee_id = ? AND date = ?")
  .run(worker2.id, FRI);

bookFor(worker1.id, SUN, 10 * 60, 60); // Ana busy 10:00-11:00 on Sunday
const anaSun = availability.slotsFor(w1, SUN, 60, { now: NOW }).map(hhmm);
const beaSun = availability.slotsFor(bea, SUN, 60, { now: NOW }).map(hhmm);
ok('the busy employee cannot take 10:00', !anaSun.includes('10:00'), anaSun);
ok('the free employee still can', beaSun.includes('10:00'), beaSun);
ok('one hour, two employees, no interference',
  availability.dayOptions(SUN, 60, { now: NOW }).some((entry) =>
    entry.employee.id === bea.id && entry.slots.some((s) => s.label === '10:00')));

section('the past and the lead time');

const monday = '2027-01-04';
ok('a date in the past offers nothing',
  availability.slotsFor(w1, monday, 30, { now: NOW }).length === 0);

// Same day, 09:00 now, two hours' notice: nothing before 11:00.
const today = util.toIso(NOW);
employees.setWorkHours(worker1.id, schedule.readForm({
  mode_0: 'open', open_0: '08:00', close_0: '20:00',
  mode_1: 'open', open_1: '08:00', close_1: '20:00',
  mode_2: 'open', open_2: '08:00', close_2: '20:00',
  mode_3: 'open', open_3: '08:00', close_3: '20:00',
  mode_4: 'open', open_4: '08:00', close_4: '20:00',
  mode_5: 'open', open_5: '08:00', close_5: '20:00',
  mode_6: 'open', open_6: '08:00', close_6: '20:00',
}).json);
const wAll = employees.get(worker1.id);
const todaySlots = availability.slotsFor(wAll, today, 30, { now: NOW }).map(hhmm);
ok('nothing is offered inside the notice period',
  !todaySlots.includes('09:30') && !todaySlots.includes('10:45'), todaySlots.slice(0, 5));
ok('the first slot respects the two-hour notice',
  todaySlots[0] === '11:00', todaySlots[0]);

section('the day list only offers days worth clicking');

const days = availability.daysWithSlots(30, { employeeId: wAll.id, now: NOW, days: 5 });
ok('every listed day really has slots', days.every((d) => d.count > 0), days);
ok('days are in order', days.every((d, i) => i === 0 || days[i - 1].date < d.date));
ok('a deactivated employee offers nothing',
  availability.dayOptions(SUN, 60, { employeeId: 99999, now: NOW }).length === 0);

section('interval merging');

const merged = availability.mergeIntervals([
  { start: 60, end: 120 }, { start: 100, end: 140 }, { start: 200, end: 260 },
]);
ok('overlapping intervals merge', merged.length === 2, merged);
ok('the merged block spans both', merged[0].start === 60 && merged[0].end === 140, merged[0]);
ok('touching intervals merge too',
  availability.mergeIntervals([{ start: 0, end: 60 }, { start: 60, end: 90 }]).length === 1);
ok('an empty list merges to nothing', availability.mergeIntervals([]).length === 0);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
