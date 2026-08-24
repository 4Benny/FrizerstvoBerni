'use strict';

const express = require('express');
const services = require('../repo/services');
const employees = require('../repo/employees');
const availability = require('../availability');
const booking = require('../booking');
const settings = require('../settings');
const util = require('../util');

const router = express.Router();

/**
 * Customers booking themselves.
 *
 * Four steps, each a plain server-rendered page so it works without
 * JavaScript: pick a service, pick a time, give a name and number, type the
 * code that arrives by SMS. The choice is kept in the session between steps,
 * never in a hidden field, so it cannot be edited on the way through — and it
 * is validated again at the write regardless.
 */

function unavailable(res) {
  return res.status(404).render('public/booking-off', {
    title: 'Spletno naročanje',
  });
}

/** Every step needs the feature switched on. */
router.use((req, res, next) => {
  if (!booking.isEnabled()) return unavailable(res);
  res.locals.step = 0;
  return next();
});

function draft(req) {
  if (!req.session.booking) req.session.booking = {};
  return req.session.booking;
}

/* ------------------------------------------------------------ 1. service */

router.get('/', (req, res) => {
  req.session.booking = {};
  res.render('public/booking-service', {
    title: 'Naročanje',
    services: services.active(),
  });
});

/* --------------------------------------------------------------- 2. time */

router.get('/termin', (req, res) => {
  const service = services.get(req.query.service);
  if (!service || !service.active) return res.redirect('/narocanje');

  const employeeId = Number(req.query.employee) || null;
  const date = util.isIsoDate(req.query.date) ? req.query.date : null;

  const days = availability.daysWithSlots(service.duration_min, { employeeId });
  const chosenDate = date && days.some((d) => d.date === date) ? date : days[0] ? days[0].date : null;

  res.render('public/booking-time', {
    title: `Naročanje — ${service.name}`,
    service,
    employees: employees.bookable(),
    employeeId,
    days,
    chosenDate,
    options: chosenDate
      ? availability.dayOptions(chosenDate, service.duration_min, { employeeId })
      : [],
    leadHours: Math.round(availability.LEAD_MINUTES / 60),
  });
});

/* ------------------------------------------------------------ 3. details */

router.post('/podatki', (req, res) => {
  const service = services.get(req.body.service_id);
  const employee = employees.get(req.body.employee_id);
  const date = util.isIsoDate(req.body.date) ? req.body.date : null;
  const startMin = Math.round(Number(req.body.start_min));

  if (!service || !employee || !date || !Number.isFinite(startMin)) {
    return res.redirect('/narocanje');
  }

  Object.assign(draft(req), {
    serviceId: service.id,
    employeeId: employee.id,
    date,
    startMin,
  });

  res.render('public/booking-details', {
    title: 'Vaši podatki',
    service,
    employee,
    date,
    startMin,
    values: {},
    error: null,
  });
});

/** Re-render step three with an error, keeping what was typed. */
function detailsAgain(res, req, error) {
  const d = draft(req);
  return res.status(400).render('public/booking-details', {
    title: 'Vaši podatki',
    service: services.get(d.serviceId),
    employee: employees.get(d.employeeId),
    date: d.date,
    startMin: d.startMin,
    values: req.body,
    error,
  });
}

/* --------------------------------------------------------------- 4. code */

router.post('/koda', (req, res) => {
  const d = draft(req);
  if (!d.serviceId) return res.redirect('/narocanje');

  const firstName = util.str(req.body.first_name, 80).trim();
  if (!firstName) return detailsAgain(res, req, 'Vpišite svoje ime.');

  const requested = booking.requestCode(req.body.phone);
  if (!requested.ok) return detailsAgain(res, req, requested.error);

  Object.assign(d, {
    firstName,
    lastName: util.str(req.body.last_name, 80).trim(),
    note: util.str(req.body.note, 500),
    phone: requested.phone,
    codeId: requested.id,
  });

  res.render('public/booking-code', {
    title: 'Potrdite številko',
    phone: requested.phone,
    minutes: booking.CODE_TTL_MINUTES,
    error: null,
  });
});

router.post('/potrdi', (req, res) => {
  const d = draft(req);
  if (!d.codeId) return res.redirect('/narocanje');

  const again = (error) =>
    res.status(400).render('public/booking-code', {
      title: 'Potrdite številko',
      phone: d.phone,
      minutes: booking.CODE_TTL_MINUTES,
      error,
    });

  const checked = booking.verifyCode(d.codeId, req.body.code);
  if (!checked.ok) return again(checked.error);

  const result = booking.book({
    phone: d.phone,
    firstName: d.firstName,
    lastName: d.lastName,
    serviceId: d.serviceId,
    employeeId: d.employeeId,
    date: d.date,
    startMin: d.startMin,
    note: d.note,
  });

  if (!result.ok) {
    // A slot taken while the customer was reading the SMS is the one failure
    // worth sending them back to the times rather than showing a dead end.
    if (result.taken) {
      req.session.booking = {};
      return res.status(409).render('public/booking-taken', {
        title: 'Termin ni več prost',
        service: services.get(d.serviceId),
        message: result.error,
      });
    }
    return again(result.error);
  }

  req.session.booking = {};
  return res.render('public/booking-done', {
    title: 'Termin je potrjen',
    appointment: result.appointment,
    employee: employees.get(result.appointment.employee_id),
    isFree: result.appointment.is_free === 1,
    salonPhone: settings.get('phone'),
  });
});

module.exports = router;
