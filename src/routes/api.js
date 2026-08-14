'use strict';

const express = require('express');
const appointments = require('../repo/appointments');
const customers = require('../repo/customers');
const employees = require('../repo/employees');
const services = require('../repo/services');
const products = require('../repo/products');
const settings = require('../settings');
const sms = require('../sms');
const util = require('../util');
const { requireLogin } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

const MAX_DURATION = 12 * 60;

/* ------------------------------------------------------------------ helpers */

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function loyaltyFor(customer) {
  return util.loyalty(customer.visit_count, settings.getInt('paid_before_free'));
}

function customerPayload(customer) {
  const state = loyaltyFor(customer);
  return {
    id: customer.id,
    first_name: customer.first_name,
    last_name: customer.last_name,
    name: util.fullName(customer),
    phone: customer.phone,
    email: customer.email,
    notes: customer.notes,
    visit_count: customer.visit_count,
    active: !!customer.active,
    loyalty: state,
  };
}

/**
 * Validates an appointment payload and resolves the stored values, including
 * the service snapshot. Returns { error } or { data }.
 */
function buildAppointment(body, { existing = null } = {}) {
  const customerId = Number(body.customer_id) || (existing && existing.customer_id);
  const customer = customerId ? customers.get(customerId) : null;
  if (!customer) return { error: 'Izberite stranko za ta termin.' };

  const employeeId = Number(body.employee_id) || (existing && existing.employee_id);
  const employee = employeeId ? employees.get(employeeId) : null;
  if (!employee) return { error: 'Izberite zaposlenega za ta termin.' };
  if (!employee.active && (!existing || existing.employee_id !== employee.id)) {
    return { error: 'Ta zaposleni je deaktiviran.' };
  }

  const date = util.isIsoDate(body.date) ? body.date : existing && existing.date;
  if (!util.isIsoDate(date)) return { error: 'Izberite veljaven datum.' };

  let startMin =
    body.start !== undefined && body.start !== ''
      ? util.parseTime(body.start)
      : body.start_min !== undefined && body.start_min !== ''
        ? Number(body.start_min)
        : existing && existing.start_min;
  if (!Number.isFinite(startMin) || startMin < 0 || startMin >= 24 * 60) {
    return { error: 'Izberite veljaven začetek.' };
  }
  startMin = Math.round(startMin);

  // A selected service supplies the defaults; explicit values still win so the
  // employee can price or time a one-off differently.
  let service = null;
  const hasServiceField = body.service_id !== undefined;
  const serviceId = hasServiceField
    ? Number(body.service_id) || null
    : existing
      ? existing.service_id
      : null;
  if (serviceId) service = services.get(serviceId);

  let serviceName = util.str(body.service_name, 120);
  if (!serviceName) serviceName = service ? service.name : existing ? existing.service_name : '';
  if (!serviceName) return { error: 'Izberite storitev.' };

  let duration =
    body.duration_min !== undefined && body.duration_min !== ''
      ? Number(body.duration_min)
      : service
        ? service.duration_min
        : existing
          ? existing.duration_min
          : null;
  if (!Number.isFinite(duration) || duration < 5) {
    return { error: 'Trajanje mora biti vsaj 5 minut.' };
  }
  duration = Math.round(duration);
  if (duration > MAX_DURATION) return { error: 'Trajanje je predolgo.' };
  if (startMin + duration > 24 * 60) {
    return { error: 'Termin bi se končal po polnoči. Izberite zgodnejši čas.' };
  }

  let priceCents;
  if (body.price !== undefined && body.price !== '') {
    priceCents = util.parseMoney(body.price);
    if (priceCents === null) return { error: 'Vpišite veljavno ceno.' };
  } else if (body.price_cents !== undefined && body.price_cents !== '') {
    priceCents = Math.max(0, Math.round(Number(body.price_cents) || 0));
  } else if (service) {
    priceCents = service.price_cents;
  } else if (existing) {
    priceCents = existing.price_cents;
  } else {
    priceCents = 0;
  }

  return {
    data: {
      customer_id: customer.id,
      employee_id: employee.id,
      service_id: service ? service.id : null,
      service_name: serviceName,
      date,
      start_min: startMin,
      duration_min: duration,
      price_cents: priceCents,
      notes:
        body.notes !== undefined ? util.str(body.notes, 2000) : existing ? existing.notes : '',
    },
    customer,
    employee,
  };
}

function conflictMessage(conflict) {
  return (
    `${conflict.employee_name} ima termin že od ${conflict.start_time} ` +
    `do ${conflict.end_time}. Izberite drug čas.`
  );
}

/** Renders the details panel partial to an HTML string. */
function renderPanel(res, appointment) {
  const customer = customers.get(appointment.customer_id);
  return new Promise((resolve, reject) => {
    res.render(
      'staff/partials/appointment-panel',
      {
        appt: appointment,
        loyalty: loyaltyFor(customer),
        employees: employees.bookable(),
        services: services.active(),
        lastSms: sms.lastForAppointment(appointment.id),
        smsEnabled: settings.get('sms_enabled') === '1',
        layout: false,
      },
      (err, html) => (err ? reject(err) : resolve(html))
    );
  });
}

/* ------------------------------------------------------------- appointments */

router.get('/appointments/:id', (req, res) => {
  const appt = appointments.getFull(req.params.id);
  if (!appt) return fail(res, 404, 'Termina ni mogoče najti.');
  return res.json({ ok: true, appointment: appt });
});

router.get('/appointments/:id/panel', async (req, res, next) => {
  try {
    const appt = appointments.getFull(req.params.id);
    if (!appt) return fail(res, 404, 'Termina ni mogoče najti.');
    const html = await renderPanel(res, appt);
    return res.json({ ok: true, html, appointment: appt });
  } catch (err) {
    return next(err);
  }
});

router.post('/appointments', async (req, res, next) => {
  try {
    const built = buildAppointment(req.body);
    if (built.error) return fail(res, 400, built.error);

    const conflict = appointments.findConflict({
      employeeId: built.data.employee_id,
      date: built.data.date,
      startMin: built.data.start_min,
      endMin: built.data.start_min + built.data.duration_min,
    });
    if (conflict) return fail(res, 409, conflictMessage(conflict), { conflict: true });

    // Save first — the appointment must exist even if the SMS fails.
    const appt = appointments.create(built.data);
    const result = await sms.notify('booked', built.customer, appt);

    return res.json({
      ok: true,
      appointment: appt,
      message: 'Termin je ustvarjen.',
      sms: result,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/appointments/:id', (req, res, next) => {
  try {
    const existing = appointments.get(req.params.id);
    if (!existing) return fail(res, 404, 'Termina ni mogoče najti.');
    if (existing.status === 'cancelled') {
      return fail(res, 400, 'Ta termin je odpovedan in ga ni mogoče urejati.');
    }

    const built = buildAppointment(req.body, { existing });
    if (built.error) return fail(res, 400, built.error);

    const conflict = appointments.findConflict({
      employeeId: built.data.employee_id,
      date: built.data.date,
      startMin: built.data.start_min,
      endMin: built.data.start_min + built.data.duration_min,
      excludeId: existing.id,
    });
    if (conflict) return fail(res, 409, conflictMessage(conflict), { conflict: true });

    const appt = appointments.update(existing.id, built.data);
    return res.json({ ok: true, appointment: appt, message: 'Termin je posodobljen.' });
  } catch (err) {
    return next(err);
  }
});

router.post('/appointments/:id/reschedule', async (req, res, next) => {
  try {
    const existing = appointments.get(req.params.id);
    if (!existing) return fail(res, 404, 'Termina ni mogoče najti.');
    if (existing.status === 'cancelled') {
      return fail(res, 400, 'Ta termin je odpovedan in ga ni mogoče prestaviti.');
    }

    const date = util.isIsoDate(req.body.date) ? req.body.date : existing.date;
    const startMin =
      req.body.start !== undefined && req.body.start !== ''
        ? util.parseTime(req.body.start)
        : Number(req.body.start_min);
    if (!Number.isFinite(startMin) || startMin < 0 || startMin >= 24 * 60) {
      return fail(res, 400, 'Izberite veljaven čas.');
    }

    const employeeId = Number(req.body.employee_id) || existing.employee_id;
    const employee = employees.get(employeeId);
    if (!employee) return fail(res, 400, 'Izberite zaposlenega.');
    if (!employee.active && employee.id !== existing.employee_id) {
      return fail(res, 400, 'Ta zaposleni je deaktiviran.');
    }

    const duration = existing.duration_min;
    if (startMin + duration > 24 * 60) {
      return fail(res, 400, 'Termin bi se končal po polnoči.');
    }

    const conflict = appointments.findConflict({
      employeeId: employee.id,
      date,
      startMin,
      endMin: startMin + duration,
      excludeId: existing.id,
    });
    if (conflict) return fail(res, 409, conflictMessage(conflict), { conflict: true });

    const appt = appointments.reschedule(existing.id, {
      date,
      start_min: startMin,
      employee_id: employee.id,
      duration_min: duration,
    });

    const moved = date !== existing.date || startMin !== existing.start_min;
    const result = moved
      ? await sms.notify('rescheduled', customers.get(appt.customer_id), appt)
      : { status: 'skipped', message: '' };

    return res.json({
      ok: true,
      appointment: appt,
      message: 'Termin je prestavljen.',
      sms: result,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/appointments/:id/status', async (req, res, next) => {
  try {
    const existing = appointments.get(req.params.id);
    if (!existing) return fail(res, 404, 'Termina ni mogoče najti.');

    const status = String(req.body.status || '');
    if (!appointments.STATUSES.includes(status)) {
      return fail(res, 400, 'Neznano stanje termina.');
    }

    // Cancelling and no-show release the slot, so moving back to an occupying
    // status has to re-check the time — someone may have booked it meanwhile.
    const wasFree = existing.status === 'cancelled' || existing.status === 'no_show';
    if (wasFree && appointments.BLOCKING.includes(status)) {
      const conflict = appointments.findConflict({
        employeeId: existing.employee_id,
        date: existing.date,
        startMin: existing.start_min,
        endMin: existing.end_min,
        excludeId: existing.id,
      });
      if (conflict) return fail(res, 409, conflictMessage(conflict), { conflict: true });
    }

    // Marking an appointment completed or no-show never touches the customer's
    // visit counter; that counter is manual only.
    const appt = appointments.setStatus(
      existing.id,
      status,
      status === 'cancelled' ? req.body.reason : ''
    );

    const messages = {
      completed: 'Termin je zaključen.',
      cancelled: 'Termin je odpovedan.',
      no_show: 'Termin označen kot ni prišla.',
      scheduled: 'Termin je ponovno odprt.',
    };

    let result = { status: 'skipped', message: '' };
    const wantsSms =
      status === 'cancelled' &&
      (req.body.send_sms === true || req.body.send_sms === 'on' || req.body.send_sms === '1');
    if (wantsSms) {
      result = await sms.notify('cancelled', customers.get(appt.customer_id), appt);
    }

    return res.json({
      ok: true,
      appointment: appt,
      message: messages[status] || 'Termin je posodobljen.',
      sms: result,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/appointments/:id/sms', async (req, res, next) => {
  try {
    const appt = appointments.getFull(req.params.id);
    if (!appt) return fail(res, 404, 'Termina ni mogoče najti.');
    const kind = ['booked', 'rescheduled', 'cancelled'].includes(req.body.kind)
      ? req.body.kind
      : 'booked';
    const result = await sms.notify(kind, customers.get(appt.customer_id), appt);
    if (result.status === 'sent') {
      return res.json({ ok: true, message: 'SMS je poslan.', sms: result });
    }
    if (result.status === 'disabled') {
      return fail(res, 400, 'SMS obvestila so v nastavitvah izklopljena.');
    }
    return fail(res, 400, result.message || 'SMS ni bilo mogoče poslati.');
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------------------------------------------- customers */

router.get('/customers/search', (req, res) => {
  const found = customers.search(req.query.q, 8);
  return res.json({ ok: true, customers: found.map(customerPayload) });
});

router.get('/customers/:id', (req, res) => {
  const customer = customers.get(req.params.id);
  if (!customer) return fail(res, 404, 'Stranke ni mogoče najti.');
  return res.json({ ok: true, customer: customerPayload(customer) });
});

router.post('/customers', (req, res) => {
  const firstName = util.str(req.body.first_name, 80);
  if (!firstName) return fail(res, 400, 'Vpišite vsaj ime.');
  const customer = customers.create({
    first_name: firstName,
    last_name: req.body.last_name,
    phone: req.body.phone,
    email: req.body.email,
    notes: req.body.notes,
  });
  return res.json({
    ok: true,
    customer: customerPayload(customer),
    message: 'Stranka je ustvarjena.',
  });
});

router.post('/customers/:id/visits', (req, res) => {
  const customer = customers.get(req.params.id);
  if (!customer) return fail(res, 404, 'Stranke ni mogoče najti.');

  let updated;
  let message = 'Število obiskov je posodobljeno.';

  if (req.body.action === 'redeem') {
    // Redeeming is always manual and always resets to zero.
    updated = customers.setVisitCount(customer.id, 0);
    message = 'Brezplačno striženje je unovčeno.';
  } else if (req.body.count !== undefined && req.body.count !== '') {
    const count = Number(req.body.count);
    if (!Number.isFinite(count) || count < 0) {
      return fail(res, 400, 'Vpišite število obiskov 0 ali več.');
    }
    updated = customers.setVisitCount(customer.id, count);
  } else {
    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) return fail(res, 400, 'Ni česa spremeniti.');
    updated = customers.adjustVisitCount(customer.id, delta);
  }

  return res.json({ ok: true, customer: customerPayload(updated), message });
});

/* ------------------------------------------------------------------ products */

router.post('/products/:id/quantity', (req, res) => {
  const product = products.get(req.params.id);
  if (!product) return fail(res, 404, 'Izdelka ni mogoče najti.');

  let updated;
  if (req.body.quantity !== undefined && req.body.quantity !== '') {
    const value = Number(req.body.quantity);
    if (!Number.isFinite(value) || value < 0) {
      return fail(res, 400, 'Vpišite količino 0 ali več.');
    }
    updated = products.setQuantity(product.id, value);
  } else {
    const delta = Number(req.body.delta);
    if (!Number.isFinite(delta) || delta === 0) return fail(res, 400, 'Ni česa spremeniti.');
    updated = products.adjustQuantity(product.id, delta);
  }

  return res.json({
    ok: true,
    product: { id: updated.id, quantity: updated.quantity },
    message: 'Zaloga je spremenjena.',
  });
});

module.exports = router;
