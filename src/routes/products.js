'use strict';

const express = require('express');
const products = require('../repo/products');
const util = require('../util');
const { requireLogin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const query = util.str(req.query.q, 80);
  res.render('staff/products-list', {
    title: 'Izdelki',
    query,
    products: products.list({ query }),
  });
});

router.get('/new', (req, res) => {
  res.render('staff/product-form', {
    title: 'Dodaj izdelek',
    product: null,
    error: null,
    values: { name: '', description: '', quantity: 0, price: '', active: 1 },
  });
});

function readForm(body) {
  return {
    name: util.str(body.name, 120),
    description: util.str(body.description, 1000),
    quantity: Number(body.quantity),
    price_cents: util.parseMoney(body.price),
    active: util.boolInt(body.active),
  };
}

function validate(values) {
  if (!values.name) return 'Vpišite ime izdelka.';
  if (!Number.isFinite(values.quantity) || values.quantity < 0) {
    return 'Količina mora biti 0 ali več.';
  }
  if (values.price_cents === null) return 'Vpišite veljavno ceno.';
  return null;
}

router.post('/new', (req, res) => {
  const values = readForm(req.body);
  const error = validate(values);
  if (error) {
    return res.status(400).render('staff/product-form', {
      title: 'Dodaj izdelek',
      product: null,
      error,
      values: { ...values, price: req.body.price },
    });
  }
  const product = products.create(values);
  setFlash(req, 'success', 'Izdelek je shranjen.');
  res.redirect(`/app/products/${product.id}`);
});

router.get('/:id', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();
  res.render('staff/product-page', { title: product.name, product });
});

router.get('/:id/edit', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();
  res.render('staff/product-form', {
    title: `Uredi ${product.name}`,
    product,
    error: null,
    values: { ...product, price: (product.price_cents / 100).toFixed(2) },
  });
});

router.post('/:id/edit', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();

  const values = readForm(req.body);
  const error = validate(values);
  if (error) {
    return res.status(400).render('staff/product-form', {
      title: `Uredi ${product.name}`,
      product,
      error,
      values: { ...values, price: req.body.price },
    });
  }
  products.update(product.id, values);
  // Quantity is edited through the +/- controls and the exact-value field, but
  // the form carries it too so a single save can correct everything at once.
  products.setQuantity(product.id, values.quantity);
  setFlash(req, 'success', 'Izdelek je shranjen.');
  res.redirect(`/app/products/${product.id}`);
});

/** Non-JavaScript fallback for the stock buttons. */
router.post('/:id/quantity', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();

  if (req.body.action === 'set') {
    const value = Number(req.body.quantity);
    if (!Number.isFinite(value) || value < 0) {
      setFlash(req, 'error', 'Količina mora biti 0 ali več.');
    } else {
      products.setQuantity(product.id, value);
      setFlash(req, 'success', 'Zaloga je spremenjena.');
    }
  } else {
    const delta = Number(req.body.delta) || 0;
    if (delta) {
      products.adjustQuantity(product.id, delta);
      setFlash(req, 'success', 'Zaloga je spremenjena.');
    }
  }
  res.redirect(req.body.back === 'list' ? '/app/products' : `/app/products/${product.id}`);
});

module.exports = router;
