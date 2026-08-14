'use strict';

const { db } = require('../db');
const util = require('../util');

function get(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
}

function list({ query = '', includeInactive = false, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push('active = 1');
  const q = String(query || '').trim();
  if (q) {
    where.push(
      `(first_name LIKE ? OR last_name LIKE ?
        OR (first_name || ' ' || last_name) LIKE ?
        OR REPLACE(REPLACE(phone, ' ', ''), '-', '') LIKE ?)`
    );
    const like = `%${q}%`;
    params.push(like, like, like, `%${q.replace(/[\s-]/g, '')}%`);
  }
  const sql =
    'SELECT * FROM customers' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE LIMIT ?';
  params.push(Number(limit));
  return db.prepare(sql).all(...params);
}

/** Fast type-ahead search used by the appointment form. */
function search(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  return list({ query: q, limit });
}

function create(data) {
  const info = db
    .prepare(
      `INSERT INTO customers
         (first_name, last_name, phone, email, notes, visit_count, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      util.str(data.first_name, 80),
      util.str(data.last_name, 80),
      util.str(data.phone, 40),
      util.str(data.email, 120),
      util.str(data.notes, 2000),
      Math.max(0, Number(data.visit_count) || 0),
      util.nowStamp()
    );
  return get(info.lastInsertRowid);
}

function update(id, data) {
  db.prepare(
    `UPDATE customers SET
       first_name = ?, last_name = ?, phone = ?, email = ?, notes = ?, active = ?
     WHERE id = ?`
  ).run(
    util.str(data.first_name, 80),
    util.str(data.last_name, 80),
    util.str(data.phone, 40),
    util.str(data.email, 120),
    util.str(data.notes, 2000),
    util.boolInt(data.active),
    Number(id)
  );
  return get(id);
}

/** Clamped at zero — the counter may never go negative. */
function setVisitCount(id, count) {
  const value = Math.max(0, Math.min(9999, Math.round(Number(count) || 0)));
  db.prepare('UPDATE customers SET visit_count = ? WHERE id = ?').run(value, Number(id));
  return get(id);
}

function adjustVisitCount(id, delta) {
  const customer = get(id);
  if (!customer) return null;
  return setVisitCount(id, customer.visit_count + Number(delta));
}

module.exports = {
  get,
  list,
  search,
  create,
  update,
  setVisitCount,
  adjustVisitCount,
};
