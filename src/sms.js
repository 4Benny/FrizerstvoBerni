'use strict';

const { db } = require('./db');
const settings = require('./settings');
const util = require('./util');

/**
 * SMS is deliberately pluggable. The default "log" driver writes the message
 * to the server console and records it in sms_log, which keeps every piece of
 * the UI (sent / failed / retry) working without a paid provider account.
 *
 * To use a real gateway set SMS_DRIVER=twilio plus TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM in the environment.
 */
const DRIVER = process.env.SMS_DRIVER || 'log';

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
  try {
    await deliver(customer.phone, body);
    log({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: customer.phone,
      kind,
      body,
      status: 'sent',
    });
    return { status: 'sent', message: 'SMS je poslan.' };
  } catch (err) {
    log({
      appointment_id: appt && appt.id,
      customer_id: customer.id,
      phone: customer.phone,
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

module.exports = { notify, lastForAppointment, DRIVER };
