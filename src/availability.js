'use strict';

const appointments = require('./repo/appointments');
const employees = require('./repo/employees');
const schedule = require('./schedule');
const util = require('./util');

/**
 * Free-slot search for customers booking themselves.
 *
 * The rule is per employee, which is what makes two customers at the same hour
 * with two different employees work with no extra logic: their busy lists never
 * meet.
 *
 * For one employee on one day:
 *   1. take their working window for that weekday (none -> no slots);
 *   2. collect the appointments that occupy time — cancelled and no-show
 *      release the slot, exactly as they do for staff;
 *   3. merge those, because staff are allowed to double-book deliberately and
 *      overlapping intervals would otherwise punch holes in each other;
 *   4. subtract them from the window to get the free gaps;
 *   5. inside each gap offer starts on a fixed grid where the whole service
 *      still fits: start + duration <= gap end.
 *
 * What this canNOT do is prevent two customers picking the same slot from two
 * browsers. The list is a suggestion; only the write can decide. The booking
 * route re-checks with findConflict at the moment it inserts, and that is what
 * actually prevents a double booking.
 */

/** Offered start times land on this grid, in minutes. */
const SLOT_STEP = Number(process.env.BOOKING_SLOT_STEP) || 15;

/** How soon from now a customer may book, in minutes. */
const LEAD_MINUTES = Number(process.env.BOOKING_LEAD_MINUTES) || 120;

/** Quiet gap left after each appointment, in minutes. */
const BUFFER_MINUTES = Math.max(0, Number(process.env.BOOKING_BUFFER_MINUTES) || 0);

/** How many days ahead the public booking page will look. */
const HORIZON_DAYS = Math.min(120, Number(process.env.BOOKING_HORIZON_DAYS) || 30);

/** Merge overlapping or touching intervals into the fewest that cover them. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** Everything that occupies this employee's time on this date. */
function busyFor(employeeId, isoDate) {
  const rows = appointments.listRange({
    from: isoDate,
    to: isoDate,
    employeeId: Number(employeeId),
  });
  return rows
    .filter((row) => appointments.BLOCKING.includes(row.status))
    .map((row) => ({
      start: row.start_min,
      // The buffer is added to the end, so it eats into the following gap
      // rather than the appointment itself.
      end: row.end_min + BUFFER_MINUTES,
    }));
}

/** window minus busy = the free gaps, in order. */
function gapsFor(employee, isoDate) {
  const window = schedule.windowFor(employee, isoDate);
  if (!window) return [];

  const busy = mergeIntervals(busyFor(employee.id, isoDate));
  const gaps = [];
  let cursor = window.startMin;

  for (const span of busy) {
    if (span.end <= cursor) continue;
    if (span.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(span.start, window.endMin) });
    }
    cursor = Math.max(cursor, span.end);
    if (cursor >= window.endMin) break;
  }
  if (cursor < window.endMin) gaps.push({ start: cursor, end: window.endMin });

  return gaps.filter((gap) => gap.end > gap.start);
}

/** The earliest minute-of-day that may be booked on this date. */
function earliestOn(isoDate, now) {
  const today = util.toIso(now);
  if (isoDate < today) return Infinity; // the past is never bookable
  if (isoDate > today) return 0;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return minutesNow + LEAD_MINUTES;
}

/**
 * Start times where a service of `durationMin` fits for this employee on this
 * date. Returns minutes from midnight, ascending.
 */
function slotsFor(employee, isoDate, durationMin, { now = new Date() } = {}) {
  const duration = Math.round(Number(durationMin) || 0);
  if (!employee || !employee.active || duration < 5) return [];

  const floor = earliestOn(isoDate, now);
  if (floor === Infinity) return [];

  const out = [];
  for (const gap of gapsFor(employee, isoDate)) {
    // Round the first candidate up onto the grid.
    let start = Math.max(gap.start, floor);
    start = Math.ceil(start / SLOT_STEP) * SLOT_STEP;
    for (; start + duration <= gap.end; start += SLOT_STEP) out.push(start);
  }
  return out;
}

/** The same, decorated for display. */
function slotsForDisplay(employee, isoDate, durationMin, opts) {
  return slotsFor(employee, isoDate, durationMin, opts).map((startMin) => ({
    startMin,
    label: util.formatTime(startMin),
    endLabel: util.formatTime(startMin + Math.round(Number(durationMin) || 0)),
  }));
}

/**
 * Every bookable employee with their slots for one date, skipping anyone with
 * nothing free. `employeeId` narrows it to one person.
 */
function dayOptions(isoDate, durationMin, { employeeId = null, now = new Date() } = {}) {
  const list = employeeId
    ? [employees.get(employeeId)].filter((e) => e && e.active)
    : employees.bookable();

  return list
    .map((employee) => ({
      employee,
      slots: slotsForDisplay(employee, isoDate, durationMin, { now }),
    }))
    .filter((entry) => entry.slots.length > 0);
}

/**
 * The next `HORIZON_DAYS` days that have at least one free slot, so the public
 * page can offer only dates worth clicking.
 */
function daysWithSlots(durationMin, { employeeId = null, now = new Date(), days = HORIZON_DAYS } = {}) {
  const out = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = util.toIso(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    );
    const options = dayOptions(date, durationMin, { employeeId, now });
    if (options.length) {
      out.push({
        date,
        label: util.formatDate(date),
        weekday: util.DAY_LONG[util.dayOfWeek(date)],
        count: options.reduce((sum, entry) => sum + entry.slots.length, 0),
      });
    }
  }
  return out;
}

module.exports = {
  SLOT_STEP,
  LEAD_MINUTES,
  BUFFER_MINUTES,
  HORIZON_DAYS,
  mergeIntervals,
  gapsFor,
  slotsFor,
  slotsForDisplay,
  dayOptions,
  daysWithSlots,
};
