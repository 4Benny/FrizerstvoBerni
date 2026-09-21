#!/usr/bin/env node
'use strict';
/**
 * Preflight for SMS sending: checks everything that has to be true before a
 * message can reach a customer, and says plainly what is missing.
 *
 *   node scripts/sms-check.js                 # check only, sends nothing
 *   node scripts/sms-check.js --send 031331636
 *
 * With --send it queues one real message to that number and delivers it
 * immediately. On a live provider that costs what a message costs.
 *
 * Honours SALON_DB, so on a server run it the way the service does:
 *   sudo -u salon --preserve-env=SALON_DB,SMS_DRIVER,TELEMACH_PFX,... \
 *     node scripts/sms-check.js
 *
 * Exit code 0 = ready to send, 1 = something blocks it.
 */

const path = require('path');
const fs = require('fs');

const sms = require(path.join(__dirname, '..', 'src', 'sms'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const { DB_FILE } = require(path.join(__dirname, '..', 'src', 'db'));

const args = process.argv.slice(2);
const sendAt = args.indexOf('--send');
const sendTo = sendAt === -1 ? '' : args[sendAt + 1] || '';

let blocking = 0;
let warnings = 0;

function ok(label, detail) {
  console.log(`  [ ok ] ${label}${detail ? ' — ' + detail : ''}`);
}
function bad(label, detail) {
  blocking++;
  console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
}
function warn(label, detail) {
  warnings++;
  console.log(`  [warn] ${label}${detail ? ' — ' + detail : ''}`);
}
function section(name) {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------- the basics */

console.log(`\nSMS preflight\nDatabase: ${DB_FILE}`);

section('Driver');

const driver = sms.DRIVER;
if (driver === 'log') {
  warn('SMS_DRIVER is "log"', 'messages go to the server log, no phone receives them');
} else {
  ok('SMS_DRIVER', driver);
}

section('Settings (Nastavitve)');

if (settings.get('sms_enabled') === '1') {
  ok('sending is switched on');
} else {
  bad('sending is switched off', 'tick "Pošlji SMS ob naročilu, prestavitvi in odpovedi"');
}

if (settings.get('sms_reminder_enabled') === '1') {
  ok('reminders are on', `${settings.get('sms_reminder_hours_before')} h before the appointment`);
} else {
  warn('reminders are off', 'optional — it adds one paid message per appointment');
}

if (settings.get('sms_plain_text') === '1') {
  ok('sending without diacritics', 'one message stays one message');
} else {
  warn('sending with diacritics', 'every message with š/č/ž is billed as two');
}

section('Timezone');

// Reminders compare the appointment against the server clock, so a server in
// UTC sends the 24 h reminder two hours off in summer.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '(unknown)';
if (/Ljubljana|Belgrade|Zagreb|Vienna|Budapest/.test(zone)) {
  ok('server timezone', zone);
} else {
  warn('server timezone is not the salon\'s', `${zone} — reminders will go out at the wrong hour`);
}

/* ---------------------------------------------------------------- drivers */

if (driver === 'telemach') {
  section('Telemach SMS Kurir');

  const sender = process.env.TELEMACH_SENDER || process.env.SMS_SENDER || '';
  if (!sender) {
    bad('TELEMACH_SENDER is not set');
  } else if (sender.length > 11) {
    bad('sender is too long', `"${sender}" is ${sender.length} characters, the limit is 11`);
  } else if (sender.length < 3) {
    bad('sender is too short', `"${sender}" — Telemach requires at least 3 characters`);
  } else if (!/^[A-Za-z0-9._\- ]+$/.test(sender)) {
    bad('sender has characters Telemach does not accept', sender);
  } else {
    ok('sender', `${sender} (must be registered with Telemach)`);
  }

  const pfx = process.env.TELEMACH_PFX;
  const cert = process.env.TELEMACH_CERT;
  const key = process.env.TELEMACH_KEY;

  if (pfx) {
    checkFile('client certificate (PKCS#12)', pfx);
    if (!process.env.TELEMACH_PASSPHRASE) {
      warn('TELEMACH_PASSPHRASE is not set', 'fine only if the .p12 has no passphrase');
    }
  } else if (cert || key) {
    if (cert && key) {
      checkFile('client certificate (PEM)', cert);
      checkFile('private key (PEM)', key);
    } else {
      bad('TELEMACH_CERT and TELEMACH_KEY must be set together');
    }
  } else {
    bad('no client certificate', 'set TELEMACH_PFX, or TELEMACH_CERT and TELEMACH_KEY');
  }

  ok('endpoint', process.env.TELEMACH_URL || 'https://customer.telemach.si/service/KurirWS/KurirService2');
  ok('appid', process.env.TELEMACH_APPID || 'kurir');

  const schedule = process.env.TELEMACH_SCHEDULE || '0';
  if (schedule === '0') {
    ok('schedule', '0 — no time limit');
  } else {
    warn('schedule', `${schedule} — Telemach will hold messages outside its window`);
  }
}

if (driver === 'http') {
  section('HTTP gateway');
  if (process.env.SMS_HTTP_URL) ok('SMS_HTTP_URL', process.env.SMS_HTTP_URL);
  else bad('SMS_HTTP_URL is not set');
}

if (driver === 'twilio') {
  section('Twilio');
  for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) {
    if (process.env[name]) ok(name);
    else bad(`${name} is not set`);
  }
}

/**
 * A certificate the salon user cannot read is the classic go-live failure:
 * root can see it, the service cannot, and every message dies with a file
 * permission error hours after anyone was watching.
 */
function checkFile(label, file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    const size = fs.statSync(file).size;
    if (size === 0) bad(`${label} is empty`, file);
    else ok(label, `${file} (${size} bytes)`);
  } catch (err) {
    bad(`${label} cannot be read`, `${file} — ${err.code || err.message}`);
  }
}

/* ----------------------------------------------------------- receipts */

section('Delivery receipts');

const secret = process.env.SMS_DLR_SECRET || '';
if (!secret) {
  warn('SMS_DLR_SECRET is not set', 'messages will never show as Dostavljeno');
} else if (secret.length < 20) {
  warn('SMS_DLR_SECRET is short', 'it is the only thing protecting the endpoint');
} else {
  const base = (process.env.BASE_URL || 'https://your-domain').replace(/\/+$/, '');
  ok('callback URL', `${base}/sms/dlr/${secret}`);
  if (!process.env.BASE_URL) {
    warn('BASE_URL is not set', 'set it so the URL above is the real one');
  }
}

/* ----------------------------------------------------------- outbox state */

section('Outbox');

const totals = sms.counts();
const stuck = (totals.pending || 0);
if (stuck) warn(`${stuck} message(s) still waiting`, 'queued, sending or retrying');
else ok('nothing stuck in the queue');
if (totals.problem) warn(`${totals.problem} message(s) failed or undelivered`, 'see SMS dnevnik');
else ok('no failures recorded');

/* -------------------------------------------------------------- test send */

(async () => {
  if (sendTo) {
    section('Test send');

    const dialled = sms.toE164(sendTo);
    if (!dialled) {
      bad('that number cannot be read', sendTo);
    } else if (blocking) {
      bad('not sending', 'fix the failures above first');
    } else {
      console.log(`  sending one message to ${dialled} …`);
      const queued = sms.enqueueText(
        'verify',
        dialled,
        sms.forSending(`${settings.get('salon_name') || 'Salon'}: testno sporocilo.`)
      );
      if (queued.status !== 'queued') {
        bad('the message was not queued', queued.message || queued.status);
      } else {
        await sms.processDue({ limit: 1 });
        const row = sms.get(queued.id);
        if (row.status === 'accepted' || row.status === 'delivered') {
          ok(`the gateway accepted it`, `status "${row.status}", id ${row.provider_id || '(none)'}`);
          console.log('\n  Accepted is not arrived. Watch SMS dnevnik for Dostavljeno,');
          console.log('  and check the handset.');
        } else {
          bad(`the message did not go out`, `status "${row.status}": ${row.error || 'no reason given'}`);
        }
      }
    }
  }

  section('Result');
  if (blocking) {
    console.log(`  ${blocking} blocking problem(s), ${warnings} warning(s). Not ready to send.\n`);
    process.exitCode = 1;
  } else {
    console.log(`  Ready to send. ${warnings} warning(s).`);
    if (!sendTo) {
      console.log('  Confirm with a real message:  node scripts/sms-check.js --send 031331636\n');
    } else {
      console.log('');
    }
  }
})();
