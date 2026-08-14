'use strict';

const { db } = require('../db');
const util = require('../util');

const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
const STATUS_LABELS = {
  scheduled: 'Naročen',
  completed: 'Zaključen',
  cancelled: 'Odpovedan',
  no_show: 'Ni prišla',
};

// Statuses that occupy the employee's time. Cancelled and no-show release the
// slot so it can be booked again.
const BLOCKING = ['scheduled', 'completed'];

const SELECT_FULL = `
  SELECT a.*,
         c.first_name  AS customer_first,
         c.last_name   AS customer_last,
         c.phone       AS customer_phone,
         c.email       AS customer_email,
         c.notes       AS customer_notes,
         c.visit_count AS customer_visits,
         e.first_name  AS employee_first,
         e.last_name   AS employee_last,
         e.color       AS employee_color
  FROM appointments a
  JOIN customers c ON c.id = a.customer_id
  JOIN employees e ON e.id = a.employee_id
`;

/** Adds the display-ready fields the templates and calendar JSON both need. */
function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    customer_name: `${row.customer_first || ''} ${row.customer_last || ''}`.trim(),
    employee_name: `${row.employee_first || ''} ${row.employee_last || ''}`.trim(),
    start_time: util.formatTime(row.start_min),
    end_time: util.formatTime(row.end_min),
    date_display: util.formatDate(row.date),
    price_display: util.formatMoney(row.price_cents),
    status_label: STATUS_LABELS[row.status] || row.status,
  };
}

function get(id) {
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(id));
}

function getFull(id) {
  return decorate(db.prepare(`${SELECT_FULL} WHERE a.id = ?`).get(Number(id)));
}

/**
 * Appointments in an inclusive date range.
 * Cancelled appointments are excluded unless `includeCancelled` is set.
 */
function listRange({ from, to, employeeId = null, includeCancelled = false } = {}) {
  const where = ['a.date >= ?', 'a.date <= ?'];
  const params = [from, to];
  if (employeeId) {
    where.push('a.employee_id = ?');
    params.push(Number(employeeId));
  }
  if (!includeCancelled) where.push("a.status <> 'cancelled'");
  const sql =
    `${SELECT_FULL} WHERE ${where.join(' AND ')} ` +
    'ORDER BY a.date, a.start_min, e.first_name';
  return db.prepare(sql).all(...params).map(decorate);
}

/**
 * The overlap rule: two appointments for the same employee on the same day
 * collide when newStart < existingEnd AND newEnd > existingStart. Touching
 * edges (10:45 starting right after 10:00-10:45) are allowed.
 */
function findConflict({ employeeId, date, startMin, endMin, excludeId = null }) {
  const placeholders = BLOCKING.map(() => '?').join(', ');
  const row = db
    .prepare(
      `${SELECT_FULL}
       WHERE a.employee_id = ?
         AND a.date = ?
         AND a.status IN (${placeholders})
         AND a.id <> ?
         AND ? < a.end_min
         AND ? > a.start_min
       ORDER BY a.start_min LIMIT 1`
    )
    .get(
      Number(employeeId),
      date,
      ...BLOCKING,
      Number(excludeId) || 0,
      Number(startMin),
      Number(endMin)
    );
  return decorate(row);
}

function create(data) {
  const now = util.nowStamp();
  const startMin = Number(data.start_min);
  const duration = Number(data.duration_min);
  const info = db
    .prepare(
      `INSERT INTO appointments
         (customer_id, employee_id, service_id, service_name, date,
          start_min, duration_min, end_min, price_cents, status, notes,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`
    )
    .run(
      Number(data.customer_id),
      Number(data.employee_id),
      data.service_id ? Number(data.service_id) : null,
      util.str(data.service_name, 120),
      data.date,
      startMin,
      duration,
      startMin + duration,
      Math.max(0, Number(data.price_cents) || 0),
      util.str(data.notes, 2000),
      now,
      now
    );
  return getFull(info.lastInsertRowid);
}

function update(id, data) {
  const startMin = Number(data.start_min);
  const duration = Number(data.duration_min);
  db.prepare(
    `UPDATE appointments SET
       customer_id = ?, employee_id = ?, service_id = ?, service_name = ?,
       date = ?, start_min = ?, duration_min = ?, end_min = ?,
       price_cents = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    Number(data.customer_id),
    Number(data.employee_id),
    data.service_id ? Number(data.service_id) : null,
    util.str(data.service_name, 120),
    data.date,
    startMin,
    duration,
    startMin + duration,
    Math.max(0, Number(data.price_cents) || 0),
    util.str(data.notes, 2000),
    util.nowStamp(),
    Number(id)
  );
  return getFull(id);
}

function reschedule(id, { date, start_min, employee_id, duration_min }) {
  const duration = Number(duration_min);
  db.prepare(
    `UPDATE appointments SET
       date = ?, start_min = ?, duration_min = ?, end_min = ?,
       employee_id = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    date,
    Number(start_min),
    duration,
    Number(start_min) + duration,
    Number(employee_id),
    util.nowStamp(),
    Number(id)
  );
  return getFull(id);
}

function setStatus(id, status, reason = '') {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  db.prepare(
    'UPDATE appointments SET status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?'
  ).run(status, util.str(reason, 500), util.nowStamp(), Number(id));
  return getFull(id);
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  BLOCKING,
  decorate,
  get,
  getFull,
  listRange,
  findConflict,
  create,
  update,
  reschedule,
  setStatus,
};
