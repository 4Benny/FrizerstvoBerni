'use strict';

const express = require('express');
const products = require('../repo/products');
const moves = require('../repo/product-moves');
const productsPdf = require('../reports/products-pdf');
const util = require('../util');
const { requireLogin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

/**
 * The one-click +/- buttons. Minus is a sale at the product's current price,
 * because that is what it almost always is at the counter; plus is supply
 * arriving, with no purchase price since none was typed. Anything else —
 * breakage, salon use, a miscount — goes through Popravek on the product page.
 */
function quickMove(product, delta, user) {
  const selling = delta < 0;
  return moves.record({
    product_id: product.id,
    kind: selling ? 'out' : 'in',
    quantity: Math.abs(delta),
    unit_price_cents: selling ? product.price_cents : 0,
    employee_id: user && user.id,
  });
}

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
    values: { name: '', description: '', quantity: 0, price: '', cost: '', active: 1 },
  });
});

function readForm(body) {
  return {
    name: util.str(body.name, 120),
    description: util.str(body.description, 1000),
    quantity: Number(body.quantity),
    price_cents: util.parseMoney(body.price),
    // Blank cost is 0, not invalid: the salon may not know it yet.
    cost_cents: String(body.cost == null ? "" : body.cost).trim() === ""
      ? 0
      : util.parseMoney(body.cost),
    active: util.boolInt(body.active),
  };
}

function validate(values) {
  if (!values.name) return 'Vpišite ime izdelka.';
  if (!Number.isFinite(values.quantity) || values.quantity < 0) {
    return 'Količina mora biti 0 ali več.';
  }
  if (values.price_cents === null) return 'Vpišite veljavno prodajno ceno.';
  if (values.cost_cents === null) return 'Nabavna cena ni v pravi obliki.';
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
      values: { ...values, price: req.body.price, cost: req.body.cost },
    });
  }
  const product = products.create(values);
  setFlash(req, 'success', 'Izdelek je shranjen.');
  res.redirect(`/app/products/${product.id}`);
});

/**
 * Hand the browser a file to save. With ?inline=1 it is shown in the browser
 * instead, so a worker can check the report before keeping it.
 */
function sendPdf(res, out, inline = false) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${out.filename}"`
  );
  res.setHeader('Content-Length', out.buffer.length);
  // A report is a snapshot of a moving table; never let one be cached.
  res.setHeader('Cache-Control', 'no-store');
  return res.end(out.buffer);
}

/**
 * The monthly figures as a PDF, so a worker can keep a copy before the
 * retention window forgets the month. `month=all` exports everything kept.
 *
 * Declared before /:id, or "report.pdf" would be read as a product id.
 */
router.get('/report.pdf', (req, res) => {
  const inline = req.query.inline === '1';
  const wanted = String(req.query.month || '');
  if (wanted === 'all') {
    return sendPdf(res, productsPdf.allMonthsReport(), inline);
  }
  const available = moves.months();
  const month =
    /^\d{4}-\d{2}$/.test(wanted) && available.includes(wanted)
      ? wanted
      : available[0] || moves.monthKey();
  return sendPdf(res, productsPdf.monthReport(month), inline);
});

/**
 * Monthly overview across all products. Mounted before /:id so that the word
 * "report" is not taken for a product id.
 */
router.get('/report', (req, res) => {
  const available = moves.months();
  const month =
    /^\d{4}-\d{2}$/.test(String(req.query.month || '')) && available.includes(req.query.month)
      ? req.query.month
      : available[0] || moves.monthKey();

  res.render('staff/product-report', {
    title: 'Mesečno poročilo izdelkov',
    month,
    months: available,
    rows: moves.monthlySummary(month),
    totals: moves.monthTotals(month),
    historyMonths: moves.HISTORY_MONTHS,
  });
});

router.get('/:id', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();
  res.render('staff/product-page', {
    title: product.name,
    product,
    monthly: moves.monthlyForProduct(product.id),
    history: moves.listForProduct(product.id, 30),
    historyMonths: moves.HISTORY_MONTHS,
  });
});

router.get('/:id/history.pdf', (req, res, next) => {
  const out = productsPdf.productReport(req.params.id);
  if (!out) return next();
  return sendPdf(res, out, req.query.inline === '1');
});

router.get('/:id/edit', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();
  res.render('staff/product-form', {
    title: `Uredi ${product.name}`,
    product,
    error: null,
    values: {
      ...product,
      price: (product.price_cents / 100).toFixed(2),
      cost: product.cost_cents ? (product.cost_cents / 100).toFixed(2) : '',
    },
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
      values: { ...values, price: req.body.price, cost: req.body.cost },
    });
  }
  products.update(product.id, values);
  // Quantity is edited through the +/- controls and the exact-value field, but
  // the form carries it too so a single save can correct everything at once.
  // Recorded as a correction rather than written straight to the product, so
  // the stock history has no unexplained jumps.
  const quantityDelta = values.quantity - product.quantity;
  if (quantityDelta) {
    moves.record({
      product_id: product.id,
      kind: 'adjust',
      quantity: quantityDelta,
      employee_id: req.user && req.user.id,
      note: 'Popravljeno pri urejanju izdelka',
    });
  }
  setFlash(req, 'success', 'Izdelek je shranjen.');
  res.redirect(`/app/products/${product.id}`);
});

/**
 * Record supply arriving. The purchase price is optional — the salon may only
 * care how many came in — but when given it is what makes the per-month price
 * history and the margin column possible.
 */
router.post('/:id/supply', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();

  const quantity = Number(req.body.quantity);
  const priceRaw = String(req.body.price == null ? '' : req.body.price).trim();
  const price = priceRaw === '' ? 0 : util.parseMoney(priceRaw);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    setFlash(req, 'error', 'Vpišite količino dobave.');
  } else if (price === null) {
    setFlash(req, 'error', 'Nabavna cena ni v pravi obliki.');
  } else {
    const result = moves.record({
      product_id: product.id,
      kind: 'in',
      quantity,
      unit_price_cents: price,
      employee_id: req.user && req.user.id,
      note: util.str(req.body.note, 300),
    });
    setFlash(
      req,
      result.ok ? 'success' : 'error',
      result.ok ? 'Dobava je zabeležena.' : result.error
    );
  }
  res.redirect(`/app/products/${product.id}`);
});

/** Record a sale. The price defaults to the product's current price. */
router.post('/:id/sale', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();

  const quantity = Number(req.body.quantity);
  const priceRaw = String(req.body.price == null ? '' : req.body.price).trim();
  const price = priceRaw === '' ? product.price_cents : util.parseMoney(priceRaw);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    setFlash(req, 'error', 'Vpišite prodano količino.');
  } else if (price === null) {
    setFlash(req, 'error', 'Prodajna cena ni v pravi obliki.');
  } else {
    const result = moves.record({
      product_id: product.id,
      kind: 'out',
      quantity,
      unit_price_cents: price,
      employee_id: req.user && req.user.id,
      note: util.str(req.body.note, 300),
    });
    setFlash(
      req,
      result.ok ? 'success' : 'error',
      result.ok ? 'Prodaja je zabeležena.' : result.error
    );
  }
  res.redirect(`/app/products/${product.id}`);
});

/**
 * A correction: stock was miscounted, something broke, or was taken for use in
 * the salon. Deliberately carries no price, so it never touches the revenue or
 * the average price for the month.
 */
router.post('/:id/correct', (req, res, next) => {
  const product = products.get(req.params.id);
  if (!product) return next();

  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    setFlash(req, 'error', 'Vpišite popravek, na primer -2 ali 3.');
  } else {
    const result = moves.record({
      product_id: product.id,
      kind: 'adjust',
      quantity: delta,
      employee_id: req.user && req.user.id,
      note: util.str(req.body.note, 300),
    });
    setFlash(
      req,
      result.ok ? 'success' : 'error',
      result.ok ? 'Popravek je zabeležen.' : result.error
    );
  }
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
      // Setting an exact count is a correction of the difference, so the stock
      // history stays complete rather than jumping without explanation.
      const delta = value - product.quantity;
      if (delta) {
        moves.record({
          product_id: product.id,
          kind: 'adjust',
          quantity: delta,
          employee_id: req.user && req.user.id,
          note: 'Nastavljena točna količina',
        });
      }
      setFlash(req, 'success', 'Zaloga je spremenjena.');
    }
  } else {
    const delta = Number(req.body.delta) || 0;
    if (delta) {
      quickMove(product, delta, req.user);
      setFlash(req, 'success', 'Zaloga je spremenjena.');
    }
  }
  res.redirect(req.body.back === 'list' ? '/app/products' : `/app/products/${product.id}`);
});

module.exports = router;
