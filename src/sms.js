'use strict';

const { db } = require('./db');
const settings = require('./settings');
const util = require('./util');
const appointments = require('./repo/appointments');

/**
 * SMS is deliberately pluggable. Choose a driver with SMS_DRIVER:
 *
 *   log     (default) writes the message to the server log and records it, so
 *           the whole queue / retry / delivery flow works without a provider
 *   http    posts to any gateway that accepts an HTTP request — a Slovenian
 *           A2P provider, or a phone running an SMS-gateway app in cloud mode
 *   twilio  Twilio's REST API
 *
 * Nothing is sent from the request that saved the appointment. Messages go into
 * an outbox table and a background worker delivers them, which keeps the front
 * desk fast and lets a failed message be retried automatically.
 *
 * See SETUP.md for worked configurations.
 */
const DRIVER = process.env.SMS_DRIVER || 'log';

/** Default country for local numbers, without the plus. Slovenia is 386. */
const COUNTRY_CODE = (process.env.SMS_COUNTRY_CODE || '386').replace(/\D/g, '');

/* ----------------------------------------------------------------- outbox */

/**
 * How many times one message is attempted before it is given up on, and how
 * long to wait before each retry. Index 0 is the wait after the first failure.
 * A gateway that is briefly unreachable costs the salon nothing this way.
 */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SMS_MAX_ATTEMPTS) || 5);
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

/** How often the worker looks for due messages, and how many it takes at once. */
const SEND_TICK_MS = Math.max(1000, Number(process.env.SMS_TICK_MS) || 15000);
const REMINDER_TICK_MS = Math.max(
  10000,
  Number(process.env.SMS_REMINDER_TICK_MS) || 300000
);
const BATCH = Math.max(1, Number(process.env.SMS_BATCH) || 5);

/**
 * Statuses a row can hold. `accepted` means the gateway took the message —
 * that is not the same as arriving, which only `delivered` proves.
 */
const STATUS_LABELS = {
  queued: 'V vrsti',
  sending: 'Pošiljanje',
  accepted: 'Oddano prehodu',
  delivered: 'Dostavljeno',
  undelivered: 'Ni dostavljeno',
  retry: 'Čaka na ponovni poskus',
  dead: 'Neuspešno',
  no_phone: 'Ni telefonske številke',
  disabled: 'SMS izklopljen',
};

/** Rows the worker may pick up. */
const DUE_STATUSES = ['queued', 'retry'];

/** Rows that still expect something to happen. Used by the log screen. */
const PENDING_STATUSES = ['queued', 'sending', 'retry'];

/* ------------------------------------------------------------ phone numbers */

/**
 * Gateways expect E.164 (+38631331636), while the salon types numbers the way
 * they are written locally ("031 331 636", "+386 31 331 636", "00386 31…").
 * Returns null when nothing usable is left.
 */
function toE164(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return null;

  const hadPlus = value.startsWith('+');
  let digits = value.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) return '+' + digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  // A single leading zero is the national trunk prefix: 031… -> +38631…
  if (digits.startsWith('0')) return '+' + COUNTRY_CODE + digits.replace(/^0+/, '');
  if (digits.startsWith(COUNTRY_CODE)) return '+' + digits;
  return '+' + COUNTRY_CODE + digits;
}

/* ------------------------------------------------------------- templates */

function templates() {
  return { salon: settings.get('salon_name') || 'Salon' };
}

function bookedBody(customer, appt) {
  const { salon } = templates();
  return (
    `${salon}: Pozdravljeni ${customer.first_name}, naročeni ste ` +
    `${util.formatDate(appt.date)} ob ${util.formatTime(appt.start_min)}. ` +
    `Storitev: ${appt.service_name}. Lep pozdrav.`
  );
}

function rescheduledBody(customer, appt) {
  const { salon } = templates();
  return (
    `${salon}: Vaš termin je bil prestavljen. Novi termin je ` +
    `${util.formatDate(appt.date)} ob ${util.formatTime(appt.start_min)}. Lep pozdrav.`
  );
}

function cancelledBody(customer, appt) {
  const { salon } = templates();
  return (
    `${salon}: Vaš termin ${util.formatDate(appt.date)} ob ` +
    `${util.formatTime(appt.start_min)} je bil odpovedan. Lep pozdrav.`
  );
}

function reminderBody(customer, appt) {
  const { salon } = templates();
  return (
    `${salon}: Opomnik — vaš termin je ${util.formatDate(appt.date)} ob ` +
    `${util.formatTime(appt.start_min)}. Storitev: ${appt.service_name}. ` +
    `Se vidimo!`
  );
}

const BODY_BUILDERS = {
  booked: bookedBody,
  rescheduled: rescheduledBody,
  cancelled: cancelledBody,
  reminder: reminderBody,
};

const KIND_LABELS = {
  booked: 'Naročilo',
  rescheduled: 'Prestavitev',
  cancelled: 'Odpoved',
  reminder: 'Opomnik',
};

/* ---------------------------------------------------------------- drivers */

async function deliverLog(phone, body) {
  console.log(`[SMS -> ${phone}] ${body}`);
  return { providerId: '' };
}

/** Substitute {{to}}, {{text}} and {{from}} with raw (unescaped) values. */
function substitute(text, values) {
  return String(text).replace(/\{\{(to|text|from)\}\}/g, (_, key) =>
    values[key] == null ? '' : String(values[key])
  );
}

/**
 * Build a JSON body. Each value is escaped for JSON, so a quote or a newline in
 * a customer name cannot break the request.
 */
function renderJson(template, values) {
  return String(template).replace(/\{\{(to|text|from)\}\}/g, (_, key) => {
    const value = values[key] == null ? '' : String(values[key]);
    // JSON.stringify gives us a quoted, escaped string; drop the outer quotes
    // because the template already supplies them.
    return JSON.stringify(value).slice(1, -1);
  });
}

/**
 * Build a urlencoded body. The template is split into key=value pairs *before*
 * the values are substituted, so an "&" or "=" inside a service name — think
 * "Barvanje & striženje" — can never be mistaken for a separator and truncate
 * the message. URLSearchParams then percent-encodes each value.
 */
function renderForm(template, values) {
  const params = new URLSearchParams();
  for (const pair of String(template).split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const key = at === -1 ? pair : pair.slice(0, at);
    const value = at === -1 ? '' : pair.slice(at + 1);
    params.append(substitute(key, values), substitute(value, values));
  }
  return params.toString();
}

/** Follow a dotted path into a parsed JSON response, e.g. "messages.0.id". */
function dig(source, path) {
  let current = source;
  for (const key of String(path).split('.')) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Pull the gateway's own message id out of its response, so a later delivery
 * receipt can be matched back to this row. Configured with SMS_HTTP_ID_PATH,
 * e.g. "messageId" or "messages.0.messageId". Absent id is not an error — it
 * only means delivery receipts cannot be matched.
 */
function extractProviderId(rawBody, path) {
  if (!path || !rawBody) return '';
  try {
    const value = dig(JSON.parse(rawBody), path);
    return value == null ? '' : String(value).slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Post to any HTTP gateway. Configured entirely by environment:
 *
 *   SMS_HTTP_URL          required, the endpoint
 *   SMS_HTTP_METHOD       default POST
 *   SMS_HTTP_FORMAT       json (default) or form
 *   SMS_HTTP_BODY         template using {{to}}, {{text}}, {{from}}
 *   SMS_HTTP_HEADERS      extra headers as a JSON object
 *   SMS_HTTP_USER / _PASS basic authentication
 *   SMS_HTTP_ID_PATH      where the message id sits in the response
 *   SMS_SENDER            value for {{from}}
 */
async function deliverHttp(phone, body) {
  const url = process.env.SMS_HTTP_URL;
  if (!url) throw new Error('SMS_HTTP_URL ni nastavljen');

  const format = (process.env.SMS_HTTP_FORMAT || 'json').toLowerCase();
  const asJson = format === 'json';
  const template =
    process.env.SMS_HTTP_BODY ||
    (asJson ? '{"to":"{{to}}","text":"{{text}}"}' : 'to={{to}}&text={{text}}');

  const values = { to: phone, text: body, from: process.env.SMS_SENDER || '' };
  let payload;

  if (asJson) {
    payload = renderJson(template, values);
    // Fail loudly on a malformed template rather than sending nonsense.
    try {
      JSON.parse(payload);
    } catch {
      throw new Error('SMS_HTTP_BODY ni veljaven JSON po vstavljanju vrednosti');
    }
  } else {
    payload = renderForm(template, values);
  }

  const headers = {
    'Content-Type': asJson ? 'application/json' : 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (process.env.SMS_HTTP_HEADERS) {
    try {
      Object.assign(headers, JSON.parse(process.env.SMS_HTTP_HEADERS));
    } catch {
      throw new Error('SMS_HTTP_HEADERS ni veljaven JSON');
    }
  }
  if (process.env.SMS_HTTP_USER) {
    const pair = `${process.env.SMS_HTTP_USER}:${process.env.SMS_HTTP_PASS || ''}`;
    headers.Authorization = 'Basic ' + Buffer.from(pair).toString('base64');
  }

  // Never let a hanging gateway hold the worker open.
  const timeoutMs = Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000;
  const res = await fetch(url, {
    method: process.env.SMS_HTTP_METHOD || 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Prehod je odgovoril ${res.status}: ${text.slice(0, 200)}`);
  }
  return { providerId: extractProviderId(text, process.env.SMS_HTTP_ID_PATH) };
}

async function deliverTwilio(phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    throw new Error('Twilio credentials are not configured');
  }
  const form = new URLSearchParams({ To: phone, From: from, Body: body });
  // Ask Twilio to report the real outcome, when a callback URL is configured.
  if (process.env.TWILIO_STATUS_CALLBACK) {
    form.set('StatusCallback', process.env.TWILIO_STATUS_CALLBACK);
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000),
    }
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Twilio responded ${res.status}: ${text.slice(0, 200)}`);
  }
  return { providerId: extractProviderId(text, 'sid') };
}

async function deliver(phone, body) {
  if (DRIVER === 'twilio') return deliverTwilio(phone, body);
  if (DRIVER === 'http') return deliverHttp(phone, body);
  return deliverLog(phone, body);
}

/* ------------------------------------------------------------------ writes */

function insert(entry) {
  const now = util.nowStamp();
  const info = db
    .prepare(
      `INSERT INTO sms_log
         (appointment_id, customer_id, phone, kind, body, status, error,
          attempts, next_attempt_at, provider_id, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, ?)`
    )
    .run(
      entry.appointment_id ?? null,
      entry.customer_id ?? null,
      entry.phone || '',
      entry.kind,
      entry.body || '',
      entry.status,
      entry.error || '',
      entry.next_attempt_at || '',
      now,
      now
    );
  return Number(info.lastInsertRowid);
}

/**
 * Put one notification in the outbox and return straight away.
 *
 * Never throws — the caller has already saved the appointment and only needs to
 * know what to tell the employee. Returns { status, message } where status is:
 *   'queued' | 'failed' | 'disabled' | 'no_phone'
 */
function enqueue(kind, customer, appt) {
  const build = BODY_BUILDERS[kind];
  if (!build) return { status: 'failed', message: 'Neznana vrsta SMS sporočila.' };

  if (settings.get('sms_enabled') !== '1') {
    return { status: 'disabled', message: '' };
  }
  if (!customer || !customer.phone) {
    insert({
      appointment_id: appt && appt.id,
      customer_id: customer && customer.id,
      phone: '',
      kind,
      body: '',
      status: 'no_phone',
    });
    return {
      status: 'no_phone',
      message: 'Stranka nima telefonske številke. SMS ni bil poslan.',
    };
  }

  const body = build(customer, appt);

  // Gateways need E.164; the salon stores numbers as they are written locally.
  const dialled = toE164(customer.phone);
  if (!dialled) {
    insert({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: customer.phone,
      kind,
      body,
      status: 'dead',
      error: 'Telefonske številke ni mogoče pretvoriti v mednarodno obliko',
    });
    return {
      status: 'failed',
      message: 'Telefonska številka stranke ni v uporabni obliki. SMS ni bil poslan.',
    };
  }

  const id = insert({
    appointment_id: appt && appt.id,
    customer_id: customer.id,
    phone: dialled,
    kind,
    body,
    status: 'queued',
    next_attempt_at: util.nowStamp(),
  });

  return { status: 'queued', message: 'SMS je v vrsti za pošiljanje.', id };
}

/* ------------------------------------------------------------------ worker */

/**
 * Take up to `limit` due messages and mark them 'sending' in the same step, so
 * a second tick can never pick up a row that is already in flight.
 */
function claimDue(limit, nowIso) {
  const rows = db
    .prepare(
      `SELECT * FROM sms_log
        WHERE status IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY id LIMIT ?`
    )
    .all(nowIso, limit);

  const claim = db.prepare(
    `UPDATE sms_log SET status = 'sending', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retry')`
  );

  const claimed = [];
  for (const row of rows) {
    if (claim.run(nowIso, row.id).changes === 1) claimed.push(row);
  }
  return claimed;
}

/** Deliver one claimed row and record the outcome. Returns the new status. */
async function attempt(row, now) {
  const attempts = Number(row.attempts || 0) + 1;
  const stamp = now.toISOString();

  try {
    const out = await deliver(row.phone, row.body);
    db.prepare(
      `UPDATE sms_log
          SET status = 'accepted', attempts = ?, error = '', provider_id = ?,
              next_attempt_at = '', updated_at = ?
        WHERE id = ?`
    ).run(attempts, (out && out.providerId) || '', stamp, row.id);
    return 'accepted';
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 500);

    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE sms_log
            SET status = 'dead', attempts = ?, error = ?, next_attempt_at = '',
                updated_at = ?
          WHERE id = ?`
      ).run(attempts, message, stamp, row.id);
      return 'dead';
    }

    const waitMinutes =
      BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
    const next = new Date(now.getTime() + waitMinutes * 60000).toISOString();
    db.prepare(
      `UPDATE sms_log
          SET status = 'retry', attempts = ?, error = ?, next_attempt_at = ?,
              updated_at = ?
        WHERE id = ?`
    ).run(attempts, message, next, stamp, row.id);
    return 'retry';
  }
}

/** One pass of the outbox. Safe to call directly from tests. */
async function processDue({ limit = BATCH, now = new Date() } = {}) {
  const tally = { accepted: 0, retry: 0, dead: 0 };
  for (const row of claimDue(limit, now.toISOString())) {
    tally[await attempt(row, now)] += 1;
  }
  return tally;
}

/* --------------------------------------------------------------- reminders */

/**
 * The appointment's start as a real moment in the server's own timezone. The
 * salon stores a date plus minutes-from-midnight in local time, so the server
 * clock must be set to the salon's timezone (Europe/Ljubljana).
 */
function appointmentStart(appt) {
  const [year, month, day] = String(appt.date).split('-').map(Number);
  return new Date(year, month - 1, day, 0, Number(appt.start_min) || 0, 0, 0);
}

function reminderAlreadyLogged(appointmentId) {
  return !!db
    .prepare(
      `SELECT 1 FROM sms_log WHERE appointment_id = ? AND kind = 'reminder' LIMIT 1`
    )
    .get(appointmentId);
}

/**
 * Queue reminders for appointments whose start is now inside the lead time.
 *
 * An appointment booked *after* the window opened is skipped: the confirmation
 * it already received would otherwise be followed by a near-identical reminder
 * minutes later. Each appointment is reminded at most once, which is what makes
 * this safe to run on a timer and safe across restarts.
 */
function scanReminders({ now = new Date() } = {}) {
  const result = { queued: 0, skipped: 0 };
  if (settings.get('sms_enabled') !== '1') return result;
  if (settings.get('sms_reminder_enabled') !== '1') return result;

  const hours = Math.max(1, settings.getInt('sms_reminder_hours_before') || 24);
  const leadMs = hours * 3600000;

  // Look far enough ahead to cover the lead time, plus a day of slack so an
  // appointment late on the last day is still inside the range.
  const from = util.toIso(now);
  const to = util.toIso(new Date(now.getTime() + leadMs + 86400000));

  for (const appt of appointments.listRange({ from, to })) {
    if (appt.status !== 'scheduled') continue;

    const startAt = appointmentStart(appt);
    const untilStart = startAt.getTime() - now.getTime();
    if (untilStart <= 0 || untilStart > leadMs) continue;

    // Booked inside the window — the confirmation already did this job.
    const createdAt = new Date(appt.created_at).getTime();
    if (Number.isFinite(createdAt) && createdAt > startAt.getTime() - leadMs) {
      result.skipped += 1;
      continue;
    }

    if (reminderAlreadyLogged(appt.id)) continue;

    const outcome = enqueue(
      'reminder',
      {
        id: appt.customer_id,
        first_name: appt.customer_first,
        phone: appt.customer_phone,
      },
      appt
    );
    if (outcome.status === 'queued') result.queued += 1;
  }

  return result;
}

/* ------------------------------------------------------- delivery receipts */

const DLR_DEFAULTS = {
  idField: DRIVER === 'twilio' ? 'MessageSid' : 'id',
  statusField: DRIVER === 'twilio' ? 'MessageStatus' : 'status',
  delivered: 'delivered,DELIVERED,delivrd,DELIVRD,DELIVERED_TO_HANDSET',
  failed: 'undelivered,UNDELIVERED,failed,FAILED,rejected,REJECTED,expired,EXPIRED',
};

function dlrList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Apply a delivery receipt posted by the gateway. Providers all name their
 * fields differently, so the mapping is configuration rather than code:
 *
 *   SMS_DLR_ID_FIELD      field holding the message id  (Twilio: MessageSid)
 *   SMS_DLR_STATUS_FIELD  field holding the status      (Twilio: MessageStatus)
 *   SMS_DLR_DELIVERED     comma-separated values that mean "arrived"
 *   SMS_DLR_FAILED        comma-separated values that mean "did not arrive"
 *
 * Returns { ok, status } or { ok: false, error } — never throws.
 */
function applyReceipt(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Prazno sporočilo o dostavi.' };
  }

  const idField = process.env.SMS_DLR_ID_FIELD || DLR_DEFAULTS.idField;
  const statusField = process.env.SMS_DLR_STATUS_FIELD || DLR_DEFAULTS.statusField;
  const providerId = String(dig(payload, idField) ?? '').trim();
  const reported = String(dig(payload, statusField) ?? '').trim();

  if (!providerId) return { ok: false, error: `Manjka polje ${idField}.` };
  if (!reported) return { ok: false, error: `Manjka polje ${statusField}.` };

  const delivered = dlrList(process.env.SMS_DLR_DELIVERED || DLR_DEFAULTS.delivered);
  const failed = dlrList(process.env.SMS_DLR_FAILED || DLR_DEFAULTS.failed);
  const lowered = reported.toLowerCase();

  let status;
  if (delivered.includes(lowered)) status = 'delivered';
  else if (failed.includes(lowered)) status = 'undelivered';
  // Anything else is an interim state such as "sent" or "queued" at the
  // provider. Recording it would overwrite a later, final receipt.
  else return { ok: true, status: null, ignored: reported };

  const row = db
    .prepare('SELECT id FROM sms_log WHERE provider_id = ? ORDER BY id DESC LIMIT 1')
    .get(providerId);
  if (!row) return { ok: false, error: 'Sporočila s tem id-jem ni v dnevniku.' };

  db.prepare(
    `UPDATE sms_log
        SET status = ?, error = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    status,
    status === 'undelivered' ? `Prehod je sporočil: ${reported}`.slice(0, 500) : '',
    util.nowStamp(),
    row.id
  );

  return { ok: true, status, id: row.id };
}

/* -------------------------------------------------------------- log screen */

/** Latest SMS attempt for an appointment, used to offer RETRY SMS. */
function lastForAppointment(appointmentId) {
  return db
    .prepare(
      `SELECT * FROM sms_log WHERE appointment_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(appointmentId);
}

function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    status_label: STATUS_LABELS[row.status] || row.status,
    kind_label: KIND_LABELS[row.kind] || row.kind,
    is_pending: PENDING_STATUSES.includes(row.status),
    can_requeue: ['dead', 'undelivered', 'retry'].includes(row.status),
  };
}

/**
 * One page of the outbox, newest first. `status` accepts a single status or the
 * pseudo-values 'pending' and 'problem' used by the filter buttons.
 */
function list({ status = '', kind = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (status === 'pending') {
    where.push(`status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
    params.push(...PENDING_STATUSES);
  } else if (status === 'problem') {
    where.push("status IN ('dead', 'undelivered', 'no_phone')");
  } else if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }

  const sql =
    'SELECT * FROM sms_log' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(500, Math.max(1, limit)), Math.max(0, offset));

  return db.prepare(sql).all(...params).map(decorate);
}

/** Row counts per status, so the log screen can show what needs attention. */
function counts() {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM sms_log GROUP BY status')
    .all();
  const out = { total: 0, pending: 0, problem: 0 };
  for (const row of rows) {
    out[row.status] = row.n;
    out.total += row.n;
    if (PENDING_STATUSES.includes(row.status)) out.pending += row.n;
    if (['dead', 'undelivered', 'no_phone'].includes(row.status)) out.problem += row.n;
  }
  return out;
}

function get(id) {
  return decorate(db.prepare('SELECT * FROM sms_log WHERE id = ?').get(Number(id)));
}

/**
 * Put a finished-but-unsuccessful row back in the queue with a clean slate, so
 * the operator gets the full set of attempts again.
 */
function requeue(id) {
  const row = get(id);
  if (!row) return { ok: false, error: 'Sporočila ni mogoče najti.' };
  if (!row.phone) {
    return { ok: false, error: 'Sporočilo nima telefonske številke.' };
  }
  if (row.is_pending) return { ok: false, error: 'Sporočilo je že v vrsti.' };

  db.prepare(
    `UPDATE sms_log
        SET status = 'queued', attempts = 0, error = '', next_attempt_at = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(util.nowStamp(), util.nowStamp(), row.id);
  return { ok: true };
}

/* ------------------------------------------------------------------ timers */

let sendTimer = null;
let reminderTimer = null;

/**
 * Start the background worker. Called once from server.js — never from tests,
 * which drive processDue() and scanReminders() directly.
 */
function startWorker() {
  if (sendTimer) return;

  sendTimer = setInterval(() => {
    processDue().catch((err) => {
      console.error('[SMS] napaka pri pošiljanju:', (err && err.message) || err);
    });
  }, SEND_TICK_MS);

  reminderTimer = setInterval(() => {
    try {
      const out = scanReminders();
      if (out.queued) console.log(`[SMS] v vrsto dodanih opomnikov: ${out.queued}`);
    } catch (err) {
      console.error('[SMS] napaka pri opomnikih:', (err && err.message) || err);
    }
  }, REMINDER_TICK_MS);

  // Anything left 'sending' belongs to a process that died mid-flight. Put it
  // back in the queue so the message is not lost, and log it.
  const stuck = db
    .prepare(
      `UPDATE sms_log SET status = 'queued', next_attempt_at = ?, updated_at = ?
        WHERE status = 'sending'`
    )
    .run(util.nowStamp(), util.nowStamp());
  if (stuck.changes) {
    console.log(`[SMS] ponovno v vrsto po ponovnem zagonu: ${stuck.changes}`);
  }

  console.log(
    `[SMS] gonilnik: ${DRIVER}; pošiljanje vsakih ${Math.round(SEND_TICK_MS / 1000)}s`
  );
}

function stopWorker() {
  if (sendTimer) clearInterval(sendTimer);
  if (reminderTimer) clearInterval(reminderTimer);
  sendTimer = null;
  reminderTimer = null;
}

module.exports = {
  DRIVER,
  STATUS_LABELS,
  KIND_LABELS,
  DUE_STATUSES,
  PENDING_STATUSES,
  MAX_ATTEMPTS,
  toE164,
  enqueue,
  processDue,
  scanReminders,
  applyReceipt,
  lastForAppointment,
  list,
  counts,
  get,
  requeue,
  startWorker,
  stopWorker,
  // exported for tests
  renderForm,
  renderJson,
  appointmentStart,
};
