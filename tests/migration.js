'use strict';
/**
 * Upgrade test. Builds a database with the *old* sms_log schema — no retry
 * bookkeeping, no provider id, and rows still marked 'sent' — then loads the
 * app's schema over it and checks the existing data survived.
 *
 * This is the path the salon's live database takes on the next deploy, so a
 * failure here means a broken upgrade rather than a broken feature.
 *
 *   node tests/migration.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(os.tmpdir(), `salon-migration-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
}
function section(n) { console.log(`\n== ${n} ==`); }

section('a database from the previous release');

// The schema exactly as it shipped before the outbox existed.
{
  const old = new DatabaseSync(DB);
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sms_log (
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
  `);
  old.prepare(
    `INSERT INTO sms_log (id, appointment_id, customer_id, phone, kind, body, status, created_at)
     VALUES (1, 7, 3, '+38631331636', 'booked', 'staro sporocilo', 'sent', '2026-01-01T10:00:00.000Z')`
  ).run();
  old.prepare(
    `INSERT INTO sms_log (id, appointment_id, customer_id, phone, kind, body, status, error, created_at)
     VALUES (2, 8, 4, '+38641222333', 'cancelled', 'neuspelo', 'failed', 'prehod 500', '2026-01-02T10:00:00.000Z')`
  ).run();
  // A setting the salon had already saved, including an empty logo.
  old.prepare("INSERT INTO settings (key, value) VALUES ('salon_name', 'Frizerski salon Berni')").run();
  old.prepare("INSERT INTO settings (key, value) VALUES ('logo_url', '')").run();
  old.close();
}

section('loading the current schema over it');

process.env.SALON_DB = DB;
const { db } = require(path.join(__dirname, '..', 'src', 'db'));

const columns = db.prepare('PRAGMA table_info(sms_log)').all().map((c) => c.name);
for (const column of ['attempts', 'next_attempt_at', 'provider_id', 'updated_at']) {
  ok(`column ${column} was added`, columns.includes(column), columns);
}

const rows = db.prepare('SELECT * FROM sms_log ORDER BY id').all();
ok('both existing rows survived', rows.length === 2, rows.length);
ok('the message body is untouched', rows[0].body === 'staro sporocilo', rows[0].body);
ok('the phone number is untouched', rows[0].phone === '+38631331636', rows[0].phone);
ok('the old error text is kept', rows[1].error === 'prehod 500', rows[1].error);

ok("'sent' was renamed to 'accepted'", rows[0].status === 'accepted', rows[0].status);
ok('added columns took their defaults', rows[0].attempts === 0 && rows[0].provider_id === '',
  { attempts: rows[0].attempts, provider_id: rows[0].provider_id });

// The old 'failed' meant one attempt and no retry, which is what 'dead' means
// now, so it is renamed too and becomes requeueable on the log screen.
ok("'failed' was renamed to 'dead'", rows[1].status === 'dead', rows[1].status);

section('the outbox works on the upgraded database');

const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const sms = require(path.join(__dirname, '..', 'src', 'sms'));

ok('a setting saved before the upgrade is still readable',
  settings.get('salon_name') === 'Frizerski salon Berni', settings.get('salon_name'));
// The point of the caveat in the notes: a stored empty value still wins over
// the new default, so the salon must set the logo once in Nastavitve.
ok('an empty stored setting still overrides the new default',
  settings.get('logo_url') === '', settings.get('logo_url'));

settings.set('sms_enabled', '1');
const queued = sms.enqueue('booked', { id: 1, first_name: 'Ana', phone: '031 123 456' }, {
  id: 99, date: '2026-09-01', start_min: 600, service_name: 'Striženje',
});
ok('a new message can be queued after the upgrade', queued.status === 'queued', queued);
ok('the queued row reads back correctly', sms.get(queued.id).status === 'queued');
ok('the log still lists the pre-upgrade rows', sms.list({ limit: 10 }).length === 3,
  sms.list({ limit: 10 }).length);
ok('an upgraded dead row can be requeued from the log screen',
  sms.get(2).can_requeue === true, sms.get(2));
ok('every upgraded row has a human label',
  sms.list({ limit: 10 }).every((r) => !!r.status_label),
  sms.list({ limit: 10 }).map((r) => r.status_label));
ok('counts include old and new rows', sms.counts().total === 3, sms.counts());

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
