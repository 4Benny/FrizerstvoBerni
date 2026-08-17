'use strict';

const { db } = require('./db');
const settings = require('./settings');
const util = require('./util');

/**
 * SMS is deliberately pluggable. Choose a driver with SMS_DRIVER:
 *
 *   log     (default) writes the message to the server log and records it, so
 *           the whole sent / failed / retry flow works without a provider
 *   http    posts to any gateway that accepts an HTTP request — a Slovenian
 *           A2P provider, or an Android phone running an SMS-gateway app so
 *           messages come from the salon's own number
 *   twilio  Twilio's REST API
 *
 * See DEPLOY.md for worked configurations.
 */
const DRIVER = process.env.SMS_DRIVER || 'log';

/** Default country for local numbers, without the plus. Slovenia is 386. */
const COUNTRY_CODE = (process.env.SMS_COUNTRY_CODE || '386').replace(/\D/g, '');

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

const BODY_BUILDERS = {
  booked: bookedBody,
  rescheduled: rescheduledBody,
  cancelled: cancelledBody,
};

/* ---------------------------------------------------------------- drivers */

async function deliverLog(phone, body) {
  console.log(`[SMS -> ${phone}] ${body}`);
}

/**
 * Fill {{to}}, {{text}} and {{from}} into a body template, escaping each value
 * for the target format so a quote or newline in a customer name cannot break
 * the request.
 */
function renderTemplate(template, values, asJson) {
  return String(template).replace(/\{\{(to|text|from)\}\}/g, (_, key) => {
    const value = values[key] == null ? '' : String(values[key]);
    // JSON.stringify gives us a quoted, escaped string; drop the outer quotes
    // because the template already supplies them.
    return asJson ? JSON.stringify(value).slice(1, -1) : value;
  });
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
  let payload = renderTemplate(template, values, asJson);

  if (asJson) {
    // Fail loudly on a malformed template rather than sending nonsense.
    try {
      JSON.parse(payload);
    } catch {
      throw new Error('SMS_HTTP_BODY ni veljaven JSON po vstavljanju vrednosti');
    }
  } else {
    payload = new URLSearchParams(
      payload.split('&').filter(Boolean).map((pair) => {
        const at = pair.indexOf('=');
        return at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
      })
    ).toString();
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

  // Never let a hanging gateway hold the employee's request open.
  const timeoutMs = Number(process.env.SMS_HTTP_TIMEOUT_MS) || 10000;
  const res = await fetch(url, {
    method: process.env.SMS_HTTP_METHOD || 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Prehod je odgovoril ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function deliverTwilio(phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    throw new Error('Twilio credentials are not configured');
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: body }).toString(),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio responded ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function deliver(phone, body) {
  if (DRIVER === 'twilio') return deliverTwilio(phone, body);
  if (DRIVER === 'http') return deliverHttp(phone, body);
  return deliverLog(phone, body);
}

/* ------------------------------------------------------------------- send */

function log(entry) {
  db.prepare(
    `INSERT INTO sms_log
       (appointment_id, customer_id, phone, kind, body, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.appointment_id ?? null,
    entry.customer_id ?? null,
    entry.phone || '',
    entry.kind,
    entry.body || '',
    entry.status,
    entry.error || '',
    util.nowStamp()
  );
}

/**
 * Attempt to send one notification. Never throws — the caller has already
 * saved the appointment and only needs to know what to tell the employee.
 *
 * Returns { status, message } where status is one of:
 *   'sent' | 'failed' | 'disabled' | 'no_phone'
 */
async function notify(kind, customer, appt) {
  const build = BODY_BUILDERS[kind];
  if (!build) return { status: 'failed', message: 'Neznana vrsta SMS sporočila.' };

  if (settings.get('sms_enabled') !== '1') {
    return { status: 'disabled', message: '' };
  }
  if (!customer || !customer.phone) {
    log({
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
    log({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: customer.phone,
      kind,
      body,
      status: 'failed',
      error: 'Telefonske številke ni mogoče pretvoriti v mednarodno obliko',
    });
    return {
      status: 'failed',
      message: 'Telefonska številka stranke ni v uporabni obliki. SMS ni bil poslan.',
    };
  }

  try {
    await deliver(dialled, body);
    log({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: dialled,
      kind,
      body,
      status: 'sent',
    });
    return { status: 'sent', message: 'SMS je poslan.' };
  } catch (err) {
    log({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: dialled,
      kind,
      body,
      status: 'failed',
      error: String((err && err.message) || err).slice(0, 500),
    });
    return { status: 'failed', message: 'SMS ni bilo mogoče poslati.' };
  }
}

/** Latest SMS attempt for an appointment, used to offer RETRY SMS. */
function lastForAppointment(appointmentId) {
  return db
    .prepare(
      `SELECT * FROM sms_log WHERE appointment_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(appointmentId);
}

module.exports = { notify, lastForAppointment, toE164, DRIVER };
