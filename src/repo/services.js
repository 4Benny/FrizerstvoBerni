'use strict';

const { db } = require('../db');
const util = require('../util');

function get(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(id));
}

function list({ activeOnly = false } = {}) {
  const sql =
    'SELECT * FROM services' +
    (activeOnly ? ' WHERE active = 1' : '') +
    ' ORDER BY sort_order, name COLLATE NOCASE';
  return db.prepare(sql).all();
}

function active() {
  return list({ activeOnly: true });
}

function create(data) {
  const info = db
    .prepare(
      `INSERT INTO services
         (name, description, duration_min, price_cents, active, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      util.str(data.name, 120),
      util.str(data.description, 1000),
      Math.max(5, Number(data.duration_min) || 30),
      Math.max(0, Number(data.price_cents) || 0),
      util.boolInt(data.active),
      Number(data.sort_order) || 0,
      util.nowStamp()
    );
  return get(info.lastInsertRowid);
}

function update(id, data) {
  db.prepare(
    `UPDATE services SET
       name = ?, description = ?, duration_min = ?, price_cents = ?,
       active = ?, sort_order = ?
     WHERE id = ?`
  ).run(
    util.str(data.name, 120),
    util.str(data.description, 1000),
    Math.max(5, Number(data.duration_min) || 30),
    Math.max(0, Number(data.price_cents) || 0),
    util.boolInt(data.active),
    Number(data.sort_order) || 0,
    Number(id)
  );
  return get(id);
}

module.exports = { get, list, active, create, update };
