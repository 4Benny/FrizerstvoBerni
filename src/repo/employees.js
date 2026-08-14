'use strict';

const { db } = require('../db');
const util = require('../util');

const PALETTE = [
  '#4f6df5',
  '#e0709a',
  '#2f9e79',
  '#d98324',
  '#7a5cd6',
  '#3a8fbf',
  '#b3543f',
  '#5f8a2e',
];

function get(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));
}

function byUsername(username) {
  return db
    .prepare('SELECT * FROM employees WHERE username = ? COLLATE NOCASE')
    .get(util.str(username, 80));
}

/** Login accepts either username or email. */
function byLogin(login) {
  const value = util.str(login, 120);
  return db
    .prepare(
      `SELECT * FROM employees
       WHERE username = ? COLLATE NOCASE
          OR (email <> '' AND email = ? COLLATE NOCASE)
       LIMIT 1`
    )
    .get(value, value);
}

function list({ activeOnly = false } = {}) {
  const sql =
    'SELECT * FROM employees' +
    (activeOnly ? ' WHERE active = 1' : '') +
    " ORDER BY role = 'admin', first_name COLLATE NOCASE, last_name COLLATE NOCASE";
  return db.prepare(sql).all();
}

/** Employees selectable as the person performing an appointment. */
function bookable() {
  return list({ activeOnly: true });
}

function nextColor() {
  const used = db.prepare('SELECT color FROM employees').all().map((r) => r.color);
  return PALETTE.find((c) => !used.includes(c)) || PALETTE[used.length % PALETTE.length];
}

function create(data) {
  const info = db
    .prepare(
      `INSERT INTO employees
         (first_name, last_name, username, email, password_hash, role, active, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      util.str(data.first_name, 80),
      util.str(data.last_name, 80),
      util.str(data.username, 80),
      util.str(data.email, 120),
      util.hashPassword(data.password),
      data.role === 'admin' ? 'admin' : 'employee',
      util.boolInt(data.active),
      data.color || nextColor(),
      util.nowStamp()
    );
  return get(info.lastInsertRowid);
}

function update(id, data) {
  db.prepare(
    `UPDATE employees SET
       first_name = ?, last_name = ?, username = ?, email = ?,
       role = ?, active = ?, color = ?
     WHERE id = ?`
  ).run(
    util.str(data.first_name, 80),
    util.str(data.last_name, 80),
    util.str(data.username, 80),
    util.str(data.email, 120),
    data.role === 'admin' ? 'admin' : 'employee',
    util.boolInt(data.active),
    util.str(data.color, 20) || '#4f6df5',
    Number(id)
  );
  return get(id);
}

function setPassword(id, plain) {
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(
    util.hashPassword(plain),
    Number(id)
  );
  return get(id);
}

function countActiveAdmins(excludeId = null) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM employees
       WHERE role = 'admin' AND active = 1 AND id <> ?`
    )
    .get(Number(excludeId) || 0);
  return row.n;
}

module.exports = {
  PALETTE,
  get,
  byUsername,
  byLogin,
  list,
  bookable,
  create,
  update,
  setPassword,
  countActiveAdmins,
  nextColor,
};
