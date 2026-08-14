'use strict';

const express = require('express');
const services = require('../repo/services');
const util = require('../util');
const { requireLogin, requireAdmin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  res.render('staff/services-list', {
    title: 'Storitve',
    services: services.list(),
  });
});

/** Creating and changing services is an administrator action. */
router.use(requireAdmin);

function readForm(body) {
  return {
    name: util.str(body.name, 120),
    description: util.str(body.description, 1000),
    duration_min: Number(body.duration_min),
    price_cents: util.parseMoney(body.price),
    active: util.boolInt(body.active),
    sort_order: Number(body.sort_order) || 0,
  };
}

function validate(values) {
  if (!values.name) return 'Vpišite ime storitve.';
  if (!Number.isFinite(values.duration_min) || values.duration_min < 5) {
    return 'Trajanje mora biti vsaj 5 minut.';
  }
  if (values.price_cents === null) return 'Vpišite veljavno ceno.';
  return null;
}

router.get('/new', (req, res) => {
  res.render('staff/service-form', {
    title: 'Dodaj storitev',
    service: null,
    error: null,
    values: { name: '', description: '', duration_min: 30, price: '', active: 1, sort_order: 0 },
  });
});

router.post('/new', (req, res) => {
  const values = readForm(req.body);
  const error = validate(values);
  if (error) {
    return res.status(400).render('staff/service-form', {
      title: 'Dodaj storitev',
      service: null,
      error,
      values: { ...values, price: req.body.price },
    });
  }
  services.create(values);
  setFlash(req, 'success', 'Storitev je shranjena.');
  res.redirect('/app/services');
});

router.get('/:id/edit', (req, res, next) => {
  const service = services.get(req.params.id);
  if (!service) return next();
  res.render('staff/service-form', {
    title: `Uredi ${service.name}`,
    service,
    error: null,
    values: { ...service, price: (service.price_cents / 100).toFixed(2) },
  });
});

router.post('/:id/edit', (req, res, next) => {
  const service = services.get(req.params.id);
  if (!service) return next();

  const values = readForm(req.body);
  const error = validate(values);
  if (error) {
    return res.status(400).render('staff/service-form', {
      title: `Uredi ${service.name}`,
      service,
      error,
      values: { ...values, price: req.body.price },
    });
  }
  services.update(service.id, values);
  setFlash(req, 'success', 'Storitev je shranjena.');
  res.redirect('/app/services');
});

/** Toggle active state straight from the list. */
router.post('/:id/active', (req, res, next) => {
  const service = services.get(req.params.id);
  if (!service) return next();
  services.update(service.id, { ...service, active: service.active ? 0 : 1 });
  setFlash(
    req,
    'success',
    service.active ? `${service.name} je izklopljena.` : `${service.name} je vklopljena.`
  );
  res.redirect('/app/services');
});

module.exports = router;
