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

-- price_cents is what the customer pays; cost_cents is what the salon pays the
-- supplier. Both are the current figures — the per-month history lives in
-- product_moves, which records the price each individual line went at.
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
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

-- Every change to a product's stock, so the salon can see per month how much
-- was supplied, how much was sold, and at what price it went out.
--
-- quantity is SIGNED and is the effect on stock: supply is positive, a sale is
-- negative, a correction is either. unit_price_cents is the price per unit at
-- the moment of the movement — the sale price for 'out', the purchase price for
-- 'in' — which is what makes a per-month price history possible even after the
-- product's current price is edited.
--
-- month is stored rather than derived from created_at because created_at is UTC:
-- grouping on it would put a sale made late on the 31st into the wrong month.
CREATE TABLE IF NOT EXISTS product_moves (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  kind             TEXT NOT NULL,
  quantity         INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL DEFAULT 0,
  employee_id      INTEGER,
  note             TEXT NOT NULL DEFAULT '',
  month            TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_product ON product_moves(product_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_moves_month   ON product_moves(month);

-- The SMS outbox. Rows are created the moment an appointment is saved and a
-- background worker delivers them, so the front desk never waits for a
-- gateway. The status column tracks the whole life of one message:
--   queued -> sending -> accepted -> delivered | undelivered
--                     -> retry (waits for next_attempt_at) -> dead
--   no_phone / disabled are terminal and only informational.
-- "accepted" means the gateway took the message; only "delivered" means a
-- delivery receipt confirmed it reached the handset.
CREATE TABLE IF NOT EXISTS sms_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id  INTEGER,
  customer_id     INTEGER,
  phone           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL,
  error           TEXT NOT NULL DEFAULT '',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  provider_id     TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_appt ON sms_log(appointment_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
`);

/* ------------------------------------------------------------- migrations */

/**
 * Add a column to a table that predates it. SQLite has no "ADD COLUMN IF NOT
 * EXISTS", so the current columns are read first. Existing rows take the
 * default, which is why every added column has one.
 */
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Retry bookkeeping and delivery receipts arrived after the first release.
// Databases created before that get the columns added in place.
addColumn('products', 'cost_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sms_log', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sms_log', 'next_attempt_at', "TEXT NOT NULL DEFAULT ''");
addColumn('sms_log', 'provider_id', "TEXT NOT NULL DEFAULT ''");
addColumn('sms_log', 'updated_at', "TEXT NOT NULL DEFAULT ''");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_sms_due       ON sms_log(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_sms_provider  ON sms_log(provider_id);
CREATE INDEX IF NOT EXISTS idx_sms_appt_kind ON sms_log(appointment_id, kind);
`);

// Rename the two statuses the old single-attempt sender used, so the log screen
// and the delivery-receipt matching only ever deal with one vocabulary.
// 'sent' meant the gateway accepted it; 'failed' meant one attempt and no
// retry, which is exactly what 'dead' means now.
db.exec("UPDATE sms_log SET status = 'accepted' WHERE status = 'sent'");
db.exec("UPDATE sms_log SET status = 'dead' WHERE status = 'failed'");

module.exports = { db, DB_FILE };
