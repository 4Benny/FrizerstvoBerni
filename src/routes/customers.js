'use strict';

const express = require('express');
const customers = require('../repo/customers');
const employees = require('../repo/employees');
const services = require('../repo/services');
const settings = require('../settings');
const util = require('../util');
const { requireLogin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

function loyaltyFor(customer) {
  return util.loyalty(customer.visit_count, settings.getInt('paid_before_free'));
}

router.get('/', (req, res) => {
  const query = util.str(req.query.q, 80);
  const showInactive = req.query.inactive === '1';
  const list = customers.list({ query, includeInactive: showInactive, limit: 300 });
  const required = settings.getInt('paid_before_free');

  res.render('staff/customers-list', {
    title: 'Stranke',
    query,
    showInactive,
    customers: list.map((c) => ({ ...c, loyalty: util.loyalty(c.visit_count, required) })),
  });
});

router.get('/new', (req, res) => {
  res.render('staff/customer-form', {
    title: 'Nova stranka',
    customer: null,
    error: null,
    values: { first_name: '', last_name: '', phone: '', email: '', notes: '', active: 1 },
  });
});

router.post('/new', (req, res) => {
  const values = {
    first_name: util.str(req.body.first_name, 80),
    last_name: util.str(req.body.last_name, 80),
    phone: util.str(req.body.phone, 40),
    email: util.str(req.body.email, 120),
    notes: util.str(req.body.notes, 2000),
    active: 1,
  };
  if (!values.first_name) {
    return res.status(400).render('staff/customer-form', {
      title: 'Nova stranka',
      customer: null,
      error: 'Vpišite vsaj ime.',
      values,
    });
  }
  const customer = customers.create(values);
  setFlash(req, 'success', 'Stranka je ustvarjena.');
  res.redirect(`/app/customers/${customer.id}`);
});

router.get('/:id', (req, res, next) => {
  const customer = customers.get(req.params.id);
  if (!customer) return next();

  res.render('staff/customer-page', {
    title: util.fullName(customer),
    customer,
    loyalty: loyaltyFor(customer),
    employees: employees.bookable(),
    services: services.active(),
    defaultEmployeeId: req.user.id,
    today: util.todayIso(),
  });
});

router.get('/:id/edit', (req, res, next) => {
  const customer = customers.get(req.params.id);
  if (!customer) return next();
  res.render('staff/customer-form', {
    title: `Uredi ${util.fullName(customer)}`,
    customer,
    error: null,
    values: customer,
  });
});

router.post('/:id/edit', (req, res, next) => {
  const customer = customers.get(req.params.id);
  if (!customer) return next();

  const values = {
    first_name: util.str(req.body.first_name, 80),
    last_name: util.str(req.body.last_name, 80),
    phone: util.str(req.body.phone, 40),
    email: util.str(req.body.email, 120),
    notes: util.str(req.body.notes, 2000),
    active: util.boolInt(req.body.active),
  };
  if (!values.first_name) {
    return res.status(400).render('staff/customer-form', {
      title: `Uredi ${util.fullName(customer)}`,
      customer,
      error: 'Vpišite vsaj ime.',
      values: { ...values, id: customer.id },
    });
  }

  customers.update(customer.id, values);
  setFlash(req, 'success', 'Stranka je posodobljena.');
  res.redirect(`/app/customers/${customer.id}`);
});

/**
 * Non-JavaScript fallbacks for the visit counter. The + / - buttons on the
 * customer page normally go through /api so the page never reloads.
 */
router.post('/:id/visits', (req, res, next) => {
  const customer = customers.get(req.params.id);
  if (!customer) return next();

  if (req.body.action === 'redeem') {
    customers.setVisitCount(customer.id, 0);
    setFlash(req, 'success', 'Brezplačno striženje je unovčeno.');
  } else if (req.body.action === 'set') {
    const count = Number(req.body.count);
    if (!Number.isFinite(count) || count < 0) {
      setFlash(req, 'error', 'Vpišite število obiskov 0 ali več.');
    } else {
      customers.setVisitCount(customer.id, count);
      setFlash(req, 'success', 'Število obiskov je posodobljeno.');
    }
  } else {
    const delta = Number(req.body.delta) || 0;
    if (delta) {
      customers.adjustVisitCount(customer.id, delta);
      setFlash(req, 'success', 'Število obiskov je posodobljeno.');
    }
  }

  res.redirect(`/app/customers/${customer.id}`);
});

module.exports = router;
