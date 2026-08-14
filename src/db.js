'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.SALON_DB || path.join(__dirname, '..', 'data', 'salon.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL DEFAULT '',
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee',
  active        INTEGER NOT NULL DEFAULT 1,
  color         TEXT NOT NULL DEFAULT '#4f6df5',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  visit_count INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_last  ON customers(last_name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS services (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  price_cents  INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- service_name / duration_min / price_cents are snapshots taken when the
-- appointment is created, so later edits to the service never change history.
CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  service_id    INTEGER REFERENCES services(id),
  service_name  TEXT NOT NULL,
  date          TEXT NOT NULL,
  start_min     INTEGER NOT NULL,
  duration_min  INTEGER NOT NULL,
  end_min       INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',
  notes         TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_date     ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_appt_emp_date ON appointments(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_appt_customer ON appointments(customer_id);

CREATE TABLE IF NOT EXISTS sms_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER,
  customer_id    INTEGER,
  phone          TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL,
  error          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_appt ON sms_log(appointment_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
`);

module.exports = { db, DB_FILE };
