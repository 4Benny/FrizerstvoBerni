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

/**
 * Find a customer by phone number, comparing only the digits so "031 123 456",
 * "031123456" and "+38631123456" all reach the same person. A customer booking
 * on the website would otherwise get a duplicate record every visit.
 *
 * The comparison is done in JavaScript over the whole table rather than in SQL,
 * because the stored numbers are free text and normalising them in a query
 * would need nested REPLACEs that are easy to get subtly wrong. A salon has
 * thousands of customers at most, and this runs once per booking.
 */
function nationalDigits(phone) {
  let digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (!digits) return '';
  // 00386 51 … and +386 51 … reach the same place.
  if (digits.startsWith('00')) digits = digits.slice(2);
  const country = (process.env.SMS_COUNTRY_CODE || '386').replace(/\D/g, '');
  if (country && digits.startsWith(country) && digits.length > country.length) {
    digits = digits.slice(country.length);
  }
  // The trunk zero is only there in the local spelling.
  return digits.replace(/^0+/, '');
}

function byPhone(phone) {
  const wanted = nationalDigits(phone);
  // Short enough to match half the table is not a match at all.
  if (wanted.length < 6) return null;
  const rows = db.prepare('SELECT * FROM customers ORDER BY id').all();
  return rows.find((row) => nationalDigits(row.phone) === wanted) || null;
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
  byPhone,
  nationalDigits,
  list,
  search,
  create,
  update,
  setVisitCount,
  adjustVisitCount,
};
