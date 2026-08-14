'use strict';

const { db } = require('../db');
const util = require('../util');

function get(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
}

function list({ activeOnly = false, query = '' } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('active = 1');
  const q = String(query || '').trim();
  if (q) {
    where.push('name LIKE ?');
    params.push(`%${q}%`);
  }
  const sql =
    'SELECT * FROM products' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all(...params);
}

function create(data) {
  const info = db
    .prepare(
      `INSERT INTO products
         (name, description, quantity, price_cents, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      util.str(data.name, 120),
      util.str(data.description, 1000),
      Math.max(0, Number(data.quantity) || 0),
      Math.max(0, Number(data.price_cents) || 0),
      util.boolInt(data.active),
      util.nowStamp()
    );
  return get(info.lastInsertRowid);
}

function update(id, data) {
  db.prepare(
    `UPDATE products SET
       name = ?, description = ?, price_cents = ?, active = ?
     WHERE id = ?`
  ).run(
    util.str(data.name, 120),
    util.str(data.description, 1000),
    Math.max(0, Number(data.price_cents) || 0),
    util.boolInt(data.active),
    Number(id)
  );
  return get(id);
}

/** Quantity is clamped at zero — stock may never go below zero. */
function setQuantity(id, quantity) {
  const value = Math.max(0, Math.min(999999, Math.round(Number(quantity) || 0)));
  db.prepare('UPDATE products SET quantity = ? WHERE id = ?').run(value, Number(id));
  return get(id);
}

function adjustQuantity(id, delta) {
  const product = get(id);
  if (!product) return null;
  return setQuantity(id, product.quantity + Number(delta));
}

module.exports = { get, list, create, update, setQuantity, adjustQuantity };
