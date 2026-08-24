'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const appointments = require('./repo/appointments');
const customers = require('./repo/customers');
const employees = require('./repo/employees');
const services = require('./repo/services');
const availability = require('./availability');
const loyalty = require('./loyalty');
const settings = require('./settings');
const sms = require('./sms');
const util = require('./util');

/**
 * Customers booking themselves on the public website.
 *
 * The phone number is verified with a one-time code before anything reaches
 * the calendar, because this is an unauthenticated form on the open internet
 * and without it anyone could fill the salon's week with invented names.
 *
 * Three limits keep it from being abused even so: how often a number may ask
 * for a code, how many guesses each code allows, and how many termins one
 * number may hold at a time. All are deliberately generous for a real customer
 * and tight for a script.
 */

/** How long a code is good for. */
const CODE_TTL_MINUTES = Number(process.env.BOOKING_CODE_TTL_MINUTES) || 10;

/** Guesses allowed per code before it is dead. */
const MAX_CODE_ATTEMPTS = Number(process.env.BOOKING_CODE_ATTEMPTS) || 5;

/** Codes one number may request per hour. */
const MAX_CODES_PER_HOUR = Number(process.env.BOOKING_CODES_PER_HOUR) || 5;

/** Upcoming termins one number may hold through the website at once. */
const MAX_OPEN_BOOKINGS = Number(process.env.BOOKING_MAX_OPEN) || 3;

/** Both switches have to be on: the code cannot be sent without SMS. */
function isEnabled() {
  return (
    settings.get('public_booking_enabled') === '1' && settings.get('sms_enabled') === '1'
  );
}

/** Six digits, from a real random source rather than Math.random. */
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function minutesAgoIso(minutes, now) {
  return new Date(now.getTime() - minutes * 60000).toISOString();
}

/* ------------------------------------------------------------------- codes */

/**
 * Send a fresh code to a phone number.
 * Returns { ok, id } or { ok: false, error }.
 */
function requestCode(rawPhone, { now = new Date() } = {}) {
  if (!isEnabled()) return { ok: false, error: 'Spletno naročanje ni na voljo.' };

  const phone = sms.toE164(rawPhone);
  if (!phone) return { ok: false, error: 'Vpišite veljavno telefonsko številko.' };

  const recent = db
    .prepare('SELECT COUNT(*) AS n FROM booking_codes WHERE phone = ? AND created_at > ?')
    .get(phone, minutesAgoIso(60, now)).n;
  if (recent >= MAX_CODES_PER_HOUR) {
    return { ok: false, error: 'Preveč poskusov. Poskusite čez eno uro ali nas pokličite.' };
  }

  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO booking_codes (phone, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(phone, util.hashPassword(code), expiresAt, util.nowStamp());

  const salon = settings.get('salon_name') || 'Salon';
  sms.enqueueText(
    'verify',
    phone,
    `${salon}: Koda za potrditev termina je ${code}. Velja ${CODE_TTL_MINUTES} minut.`
  );
  // The customer is waiting on the page, so do not leave the code sitting in
  // the outbox until the next tick. Failures are the worker's problem.
  sms.processDue({ limit: 3 }).catch(() => {});

  return { ok: true, id: Number(info.lastInsertRowid), phone };
}

/**
 * Check a code. Consumes it on success so it cannot be replayed.
 * Returns { ok } or { ok: false, error }.
 */
function verifyCode(id, supplied, { now = new Date() } = {}) {
  const row = db.prepare('SELECT * FROM booking_codes WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: 'Koda ni veljavna. Zahtevajte novo.' };
  if (row.consumed) return { ok: false, error: 'Ta koda je že bila uporabljena.' };
  if (row.expires_at <= now.toISOString()) {
    return { ok: false, error: 'Koda je potekla. Zahtevajte novo.' };
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, error: 'Preveč napačnih poskusov. Zahtevajte novo kodo.' };
  }

  db.prepare('UPDATE booking_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  const clean = String(supplied == null ? '' : supplied).replace(/\D/g, '');
  if (!clean || !util.verifyPassword(clean, row.code_hash)) {
    const left = MAX_CODE_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      error:
        left > 0
          ? `Koda ni pravilna. Poskusov še: ${left}.`
          : 'Preveč napačnih poskusov. Zahtevajte novo kodo.',
    };
  }

  db.prepare('UPDATE booking_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return { ok: true, phone: row.phone };
}

/* ---------------------------------------------------------------- booking */

/** Upcoming termins this number already holds. */
function openBookingsFor(phone, { now = new Date() } = {}) {
  const customer = customers.byPhone(phone);
  if (!customer) return 0;
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM appointments
        WHERE customer_id = ? AND status = 'scheduled' AND date >= ?`
    )
    .get(customer.id, util.toIso(now)).n;
}

/**
 * Validate a chosen slot and write it, re-checking for a conflict at the moment
 * of the insert.
 *
 * This re-check is the part that actually prevents a double booking. The slot
 * list a customer chose from was correct when the page was built; two people
 * looking at the same page can still pick the same time, and only the write
 * can decide between them.
 *
 * Returns { ok, appointment, customer } or { ok: false, error, taken }.
 */
function book({ phone, firstName, lastName, serviceId, employeeId, date, startMin, note = '' },
  { now = new Date() } = {}) {
  if (!isEnabled()) return { ok: false, error: 'Spletno naročanje ni na voljo.' };

  const dialled = sms.toE164(phone);
  if (!dialled) return { ok: false, error: 'Telefonska številka ni v uporabni obliki.' };

  const name = util.str(firstName, 80).trim();
  if (!name) return { ok: false, error: 'Vpišite svoje ime.' };

  const service = services.get(serviceId);
  if (!service || !service.active) return { ok: false, error: 'Izberite storitev.' };

  const employee = employees.get(employeeId);
  if (!employee || !employee.active) return { ok: false, error: 'Izberite frizerko.' };

  if (!util.isIsoDate(date)) return { ok: false, error: 'Izberite datum.' };

  const start = Math.round(Number(startMin));
  if (!Number.isFinite(start)) return { ok: false, error: 'Izberite uro.' };

  if (openBookingsFor(dialled, { now }) >= MAX_OPEN_BOOKINGS) {
    return {
      ok: false,
      error:
        'Na to številko je že naročenih več terminov. Za dodatnega nas prosim pokličite.',
    };
  }

  // The offered list is rebuilt here rather than trusted from the form, so a
  // hand-edited request cannot book outside the employee's hours or into an
  // occupied slot.
  const offered = availability.slotsFor(employee, date, service.duration_min, { now });
  if (!offered.includes(start)) {
    return { ok: false, error: 'Ta termin ni več prost. Izberite drugega.', taken: true };
  }

  const customer =
    customers.byPhone(dialled) ||
    customers.create({
      first_name: name,
      last_name: util.str(lastName, 80),
      phone: dialled,
      email: '',
      notes: '',
      visit_count: 0,
    });

  // node:sqlite has no transaction() helper, so the boundary is explicit. The
  // conflict check and the insert have to sit inside it together: checking
  // outside would leave exactly the window the check exists to close.
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const conflict = appointments.findConflict({
      employeeId: employee.id,
      date,
      startMin: start,
      endMin: start + service.duration_min,
    });
    if (conflict) {
      result = { conflict: true };
    } else {
      const plan = loyalty.planFor(customer);
      const appt = appointments.create({
        customer_id: customer.id,
        employee_id: employee.id,
        service_id: service.id,
        service_name: service.name,
        date,
        start_min: start,
        duration_min: service.duration_min,
        price_cents: plan.isFree ? 0 : service.price_cents,
        notes: util.str(note, 500),
        is_free: plan.isFree,
        loyalty_delta: plan.delta,
        loyalty_applied: true,
      });
      customers.adjustVisitCount(customer.id, plan.delta);
      result = { appt };
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  if (result.conflict) {
    return { ok: false, error: 'Ta termin je bil pravkar zaseden. Izberite drugega.', taken: true };
  }

  const fresh = customers.get(customer.id);
  sms.enqueue('booked', fresh, result.appt);
  sms.processDue({ limit: 3 }).catch(() => {});

  return { ok: true, appointment: result.appt, customer: fresh };
}

module.exports = {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  MAX_CODES_PER_HOUR,
  MAX_OPEN_BOOKINGS,
  isEnabled,
  requestCode,
  verifyCode,
  book,
  openBookingsFor,
};
