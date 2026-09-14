'use strict';
/**
 * SMS tests: number normalisation, the generic HTTP driver against a fake
 * gateway that captures exactly what the app would send to a real provider,
 * and the outbox — queueing, retry with backoff, giving up, reminders,
 * delivery receipts and the log screen's queries, plus Telemach's SMS Kurir
 * driver against a fake KurirWS.
 *
 *   node tests/sms.js
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-sms-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
process.env.SALON_DB = DB;

// The chosen driver and the retry budget are read once when src/sms.js is first
// required, exactly as in production, so they have to be set before any require
// below. Three attempts keeps the "gives up" test short.
process.env.SMS_DRIVER = 'http';
process.env.SMS_MAX_ATTEMPTS = '3';

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

/* ------------------------------------------------- number normalisation --- */

section('phone numbers to E.164');
{
  const { toE164 } = require(path.join(__dirname, '..', 'src', 'sms'));
  const cases = [
    ['031 331 636', '+38631331636', 'local mobile with spaces'],
    ['031123456', '+38631123456', 'local mobile, no spaces'],
    ['+386 31 331 636', '+38631331636', 'already international'],
    ['00386 31 331 636', '+38631331636', 'international with 00'],
    ['386 31 331 636', '+38631331636', 'country code, no plus'],
    ['(031) 331-636', '+38631331636', 'punctuation'],
    ['02 620 12 34', '+38626201234', 'landline'],
    ['', null, 'empty'],
    ['   ', null, 'whitespace only'],
    ['ni telefona', null, 'no digits at all'],
  ];
  for (const [input, expected, label] of cases) {
    const actual = toE164(input);
    ok(`${label}: ${JSON.stringify(input)} -> ${expected}`, actual === expected, actual);
  }
}

/* ---------------------------------------------------- body building ------- */

section('separators inside the message cannot corrupt the body');
{
  const sms = require(path.join(__dirname, '..', 'src', 'sms'));

  // A service name with an ampersand used to end the value early and append a
  // junk parameter, silently truncating the customer's message.
  const text = 'Frizerstvo Berni: Storitev: Barvanje & striženje = lepo. Lep pozdrav.';
  const form = new URLSearchParams(
    sms.renderForm('recipient={{to}}&body={{text}}&sender={{from}}', {
      to: '+38631123456',
      text,
      from: 'Berni',
    })
  );
  ok('ampersand in the message survives intact', form.get('body') === text, form.get('body'));
  ok('equals sign in the message survives intact', /= lepo/.test(form.get('body') || ''),
    form.get('body'));
  ok('no junk parameters appear', [...form.keys()].join(',') === 'recipient,body,sender',
    [...form.keys()]);
  ok('number is still correct', form.get('recipient') === '+38631123456', form.get('recipient'));
  ok('sender is still correct', form.get('sender') === 'Berni', form.get('sender'));

  // The same characters in JSON mode.
  const json = JSON.parse(
    sms.renderJson('{"to":"{{to}}","text":"{{text}}"}', { to: '+386', text })
  );
  ok('ampersand is fine in JSON mode too', json.text === text, json.text);
}

/* --------------------------------------------------- one message, one SMS - */

section('messages are kept inside a single SMS');
{
  const sms = require(path.join(__dirname, '..', 'src', 'sms'));

  // The GSM-7 alphabet holds 160 characters per message. One character
  // outside it drops the limit to 70, so a normal confirmation would be
  // billed twice. These are the exact letters that would do it.
  const GSM_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const GSM_EXTENDED = '^{}\\[~]|€';
  const singleSms = (text) =>
    [...text].every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c)) &&
    text.length <= 160;

  ok('s-caron loses its mark', sms.toPlain('š') === 's');
  ok('c-caron loses its mark', sms.toPlain('č') === 'c');
  ok('z-caron loses its mark', sms.toPlain('ž') === 'z');
  ok('capitals too', sms.toPlain('ŠČŽ') === 'SCZ', sms.toPlain('ŠČŽ'));
  ok('an em dash becomes a hyphen', sms.toPlain('a — b') === 'a - b', sms.toPlain('a — b'));
  ok('Slovene quotes become plain ones', sms.toPlain('„citat“') === '"citat"',
    sms.toPlain('„citat“'));
  ok('an ellipsis is spelled out', sms.toPlain('a…') === 'a...', sms.toPlain('a…'));
  ok('plain text is left alone', sms.toPlain('Ana Novak 12:30') === 'Ana Novak 12:30');
  ok('the euro sign survives', sms.toPlain('25 €') === '25 €', sms.toPlain('25 €'));
  ok('something with no plain form does not corrupt the message',
    sms.toPlain('日') === '?', sms.toPlain('日'));

  const confirmation =
    'Frizerstvo Berni: Pozdravljeni Ana, naročeni ste 27.08.2026 ob 11:00. ' +
    'Storitev: Žensko striženje. Lep pozdrav.';
  ok('a real confirmation would otherwise need two messages',
    !singleSms(confirmation));
  ok('stripped, it fits one', singleSms(sms.toPlain(confirmation)),
    sms.toPlain(confirmation).length);

  const reminder =
    'Frizerstvo Berni: Opomnik — vaš termin je 27.08.2026 ob 11:00. ' +
    'Storitev: Žensko striženje. Se vidimo!';
  ok('the reminder fits one too', singleSms(sms.toPlain(reminder)),
    sms.toPlain(reminder).length);

  // A customer whose own name carries the letters must not break it either.
  ok('an awkward customer name still fits',
    singleSms(sms.toPlain('Frizerstvo Berni: Pozdravljeni Špela Čuk, naročeni ste.')));

  const settings = require(path.join(__dirname, '..', 'src', 'settings'));
  settings.set('sms_plain_text', '0');
  ok('the salon can turn it off', sms.forSending('šč') === 'šč', sms.forSending('šč'));
  settings.set('sms_plain_text', '1');
  ok('and back on', sms.forSending('šč') === 'sc', sms.forSending('šč'));
}

/* ------------------------------------------------------- HTTP driver ----- */

(async () => {
  section('HTTP driver against a fake gateway');

  const received = [];
  const gateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        contentType: req.headers['content-type'],
        apiKey: req.headers['x-api-key'] || null,
        body,
      });
      if (req.url === '/broken') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('gateway exploded');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"queued","messageId":"MID-' + received.length + '"}');
      }
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  // Everything except the driver choice is read per call, so it can be set here.
  process.env.SMS_HTTP_URL = `${base}/send`;
  process.env.SMS_HTTP_FORMAT = 'json';
  process.env.SMS_HTTP_BODY = '{"phoneNumbers":["{{to}}"],"message":"{{text}}","from":"{{from}}"}';
  process.env.SMS_HTTP_USER = 'salon';
  process.env.SMS_HTTP_PASS = 'geslo';
  process.env.SMS_SENDER = 'Berni';
  process.env.SMS_HTTP_HEADERS = '{"X-Api-Key":"abc123"}';
  process.env.SMS_HTTP_ID_PATH = 'messageId';

  const sms = require(path.join(__dirname, '..', 'src', 'sms'));
  const settings = require(path.join(__dirname, '..', 'src', 'settings'));
  const { db } = require(path.join(__dirname, '..', 'src', 'db'));
  const util = require(path.join(__dirname, '..', 'src', 'util'));
  settings.set('sms_enabled', '1');
  settings.set('salon_name', 'Frizerstvo Berni');

  /**
   * Queue a message and run the worker once — the real production path, since
   * nothing is ever delivered from the request that saved the appointment.
   */
  async function send(kind, customer, appt, opts) {
    const queued = sms.enqueue(kind, customer, appt);
    if (queued.status !== 'queued') return queued;
    await sms.processDue({ limit: 10, ...(opts || {}) });
    const row = sms.get(queued.id);
    return { ...queued, row, status: row.status };
  }

  const customer = { id: 1, first_name: 'Ana', phone: '031 123 456' };
  const appt = {
    id: 1, date: '2026-08-27', start_min: 11 * 60, service_name: 'MOŠKO MODERNO, FADE STRIŽENJE',
  };

  section('queueing and delivery');

  const queuedOnly = sms.enqueue('booked', customer, appt);
  ok('enqueue returns immediately as queued', queuedOnly.status === 'queued', queuedOnly);
  ok('nothing is sent from the enqueueing call', received.length === 0, received.length);
  ok('the queued row is visible right away',
    sms.get(queuedOnly.id).status === 'queued', sms.get(queuedOnly.id));

  await sms.processDue({ limit: 10 });
  ok('the worker delivers it', sms.get(queuedOnly.id).status === 'accepted',
    sms.get(queuedOnly.id).status);
  ok('gateway was called once', received.length === 1, received.length);
  ok('provider id is stored for later receipts',
    sms.get(queuedOnly.id).provider_id === 'MID-1', sms.get(queuedOnly.id).provider_id);

  const call = received[0] || {};
  ok('correct method', call.method === 'POST', call.method);
  ok('correct path', call.url === '/send', call.url);
  ok('JSON content type', /application\/json/.test(call.contentType || ''), call.contentType);
  ok('basic auth sent', call.auth === 'Basic ' + Buffer.from('salon:geslo').toString('base64'), call.auth);
  ok('custom header sent', call.apiKey === 'abc123', call.apiKey);

  let parsed = null;
  try { parsed = JSON.parse(call.body); } catch { /* reported below */ }
  ok('body is valid JSON', !!parsed, call.body);
  ok('number converted to E.164', parsed && parsed.phoneNumbers[0] === '+38631123456',
    parsed && parsed.phoneNumbers);
  ok('sender from SMS_SENDER', parsed && parsed.from === 'Berni', parsed && parsed.from);
  // Sent without the diacritics, so the whole message stays inside one SMS.
  ok('message is the Slovene template, without the diacritics',
    parsed && parsed.message === 'Frizerstvo Berni: Pozdravljeni Ana, naroceni ste 27.08.2026 ob 11:00. Storitev: MOSKO MODERNO, FADE STRIZENJE. Lep pozdrav.',
    parsed && parsed.message);

  // A name containing a quote must not break the JSON body.
  received.length = 0;
  let result = await send('booked', { id: 2, first_name: 'An"a\nNova', phone: '040 111 222' }, appt);
  ok('awkward characters still send', result.status === 'accepted', result.status);
  let parsed2 = null;
  try { parsed2 = JSON.parse(received[0].body); } catch { /* reported below */ }
  ok('quote and newline escaped into valid JSON', !!parsed2, received[0] && received[0].body);
  ok('escaped text round-trips', parsed2 && parsed2.message.includes('An"a\nNova'),
    parsed2 && parsed2.message);

  // form-encoded gateways
  received.length = 0;
  process.env.SMS_HTTP_FORMAT = 'form';
  process.env.SMS_HTTP_BODY = 'recipient={{to}}&body={{text}}&sender={{from}}';
  result = await send('booked', customer, appt);
  ok('form format sends', result.status === 'accepted', result.status);
  const form = new URLSearchParams(received[0] ? received[0].body : '');
  ok('form content type', /x-www-form-urlencoded/.test(received[0].contentType || ''), received[0].contentType);
  ok('form carries the number', form.get('recipient') === '+38631123456', form.get('recipient'));
  ok('form carries the message', (form.get('body') || '').startsWith('Frizerstvo Berni:'), form.get('body'));

  // An ampersand end to end, through the real gateway call.
  received.length = 0;
  result = await send('booked', customer, {
    ...appt, service_name: 'Barvanje & striženje',
  });
  const ampForm = new URLSearchParams(received[0] ? received[0].body : '');
  ok('ampersand survives a real form-mode send',
    (ampForm.get('body') || '').includes('Barvanje & strizenje'), ampForm.get('body'));

  section('retry, backoff and giving up');

  received.length = 0;
  process.env.SMS_HTTP_FORMAT = 'json';
  process.env.SMS_HTTP_BODY = '{"phoneNumbers":["{{to}}"],"message":"{{text}}"}';
  process.env.SMS_HTTP_URL = `${base}/broken`;

  const failing = sms.enqueue('booked', customer, appt);
  await sms.processDue({ limit: 10 });
  let row = sms.get(failing.id);
  ok('a failed send is scheduled for retry, not lost', row.status === 'retry', row.status);
  ok('the attempt is counted', row.attempts === 1, row.attempts);
  ok('the gateway reason is recorded', /500/.test(row.error), row.error);
  ok('a next attempt time is set', !!row.next_attempt_at, row.next_attempt_at);

  // Backoff means it is not picked up again immediately.
  await sms.processDue({ limit: 10 });
  ok('backoff prevents an instant second attempt', sms.get(failing.id).attempts === 1,
    sms.get(failing.id).attempts);

  // Pretend an hour has passed: attempt 2, then attempt 3 exhausts the budget.
  const later = new Date(Date.now() + 3600000);
  await sms.processDue({ limit: 10, now: later });
  ok('after the backoff it tries again', sms.get(failing.id).attempts === 2,
    sms.get(failing.id).attempts);

  const muchLater = new Date(Date.now() + 6 * 3600000);
  await sms.processDue({ limit: 10, now: muchLater });
  row = sms.get(failing.id);
  ok('it gives up after the attempt budget', row.status === 'dead', row.status);
  ok('the final attempt count is kept', row.attempts === 3, row.attempts);

  section('sending it again by hand');

  const requeued = sms.requeue(failing.id);
  ok('a dead message can be requeued', requeued.ok === true, requeued);
  ok('requeueing resets the attempts', sms.get(failing.id).attempts === 0,
    sms.get(failing.id).attempts);
  ok('requeueing puts it back in the queue', sms.get(failing.id).status === 'queued',
    sms.get(failing.id).status);
  ok('a queued message cannot be requeued twice',
    sms.requeue(failing.id).ok === false, sms.requeue(failing.id));

  process.env.SMS_HTTP_URL = `${base}/send`;
  await sms.processDue({ limit: 10 });
  ok('the requeued message goes out once the gateway is back',
    sms.get(failing.id).status === 'accepted', sms.get(failing.id).status);

  section('refusals that never reach a gateway');

  received.length = 0;
  result = sms.enqueue('booked', { id: 3, first_name: 'Brez', phone: 'ni telefona' }, appt);
  await sms.processDue({ limit: 10 });
  ok('unusable number is refused before calling out',
    result.status === 'failed' && received.length === 0,
    { status: result.status, calls: received.length });

  result = sms.enqueue('booked', { id: 4, first_name: 'Prazno', phone: '' }, appt);
  ok('missing number reported as no_phone', result.status === 'no_phone', result);

  settings.set('sms_enabled', '0');
  received.length = 0;
  result = sms.enqueue('booked', customer, appt);
  await sms.processDue({ limit: 10 });
  ok('disabled setting sends nothing', result.status === 'disabled' && received.length === 0,
    { status: result.status, calls: received.length });

  settings.set('sms_enabled', '1');
  process.env.SMS_HTTP_BODY = '{"message":"{{text}}"';
  const broken = sms.enqueue('booked', customer, appt);
  await sms.processDue({ limit: 10 });
  ok('broken body template fails safely', sms.get(broken.id).status === 'retry',
    sms.get(broken.id).status);
  ok('template error explains itself', /veljaven JSON/.test(sms.get(broken.id).error),
    sms.get(broken.id).error);
  process.env.SMS_HTTP_BODY = '{"phoneNumbers":["{{to}}"],"message":"{{text}}"}';

  section('delivery receipts');

  received.length = 0;
  const tracked = await send('booked', customer, appt);
  const providerId = sms.get(tracked.id).provider_id;
  ok('a delivered receipt marks it delivered',
    sms.applyReceipt({ id: providerId, status: 'delivered' }).status === 'delivered');
  ok('the row really is delivered', sms.get(tracked.id).status === 'delivered',
    sms.get(tracked.id).status);

  const tracked2 = await send('booked', customer, appt);
  const providerId2 = sms.get(tracked2.id).provider_id;
  sms.applyReceipt({ id: providerId2, status: 'undelivered' });
  ok('a failed receipt marks it undelivered', sms.get(tracked2.id).status === 'undelivered',
    sms.get(tracked2.id).status);
  ok('the receipt reason is recorded', /undelivered/.test(sms.get(tracked2.id).error),
    sms.get(tracked2.id).error);

  const interim = sms.applyReceipt({ id: providerId, status: 'sent' });
  ok('an interim receipt is ignored, not recorded', interim.ok && interim.status === null, interim);
  ok('an interim receipt does not undo delivered',
    sms.get(tracked.id).status === 'delivered', sms.get(tracked.id).status);

  ok('an unknown message id is reported',
    sms.applyReceipt({ id: 'nic-takega', status: 'delivered' }).ok === false);
  ok('a receipt without an id is reported',
    sms.applyReceipt({ status: 'delivered' }).ok === false);
  ok('an empty receipt is reported', sms.applyReceipt(null).ok === false);

  section('reminders before the appointment');

  settings.set('sms_reminder_enabled', '1');
  settings.set('sms_reminder_hours_before', '24');

  // Minimal rows so the calendar query has something to join against.
  const now = util.nowStamp();
  db.prepare(
    `INSERT INTO customers (id, first_name, last_name, phone, created_at)
     VALUES (900, 'Maja', 'Kos', '031 555 777', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO employees (id, first_name, last_name, username, password_hash, created_at)
     VALUES (900, 'Berni', '', 'berni-test', 'x', ?)`
  ).run(now);

  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  let nextId = 900;
  /** An appointment exactly `msAhead` from now, in the server's local time. */
  function makeAppt(msAhead, { status = 'scheduled', createdAt = threeDaysAgo } = {}) {
    const at = new Date(Date.now() + msAhead);
    const id = ++nextId;
    db.prepare(
      `INSERT INTO appointments
         (id, customer_id, employee_id, service_name, date, start_min, duration_min,
          end_min, price_cents, status, created_at, updated_at)
       VALUES (?, 900, 900, 'Žensko striženje', ?, ?, 30, ?, 2500, ?, ?, ?)`
    ).run(
      id,
      util.toIso(at),
      at.getHours() * 60 + at.getMinutes(),
      at.getHours() * 60 + at.getMinutes() + 30,
      status,
      createdAt,
      createdAt
    );
    return id;
  }

  const soonId = makeAppt(12 * 3600000);                       // inside the 24h window
  const bookedLateId = makeAppt(2 * 3600000, { createdAt: now }); // booked inside the window
  const farId = makeAppt(48 * 3600000);                        // beyond the window
  const cancelledId = makeAppt(10 * 3600000, { status: 'cancelled' });

  received.length = 0;
  let scan = sms.scanReminders();
  ok('one reminder is queued', scan.queued === 1, scan);

  const reminderRows = sms.list({ kind: 'reminder' });
  ok('the reminder belongs to the appointment inside the window',
    reminderRows.length === 1 && reminderRows[0].appointment_id === soonId,
    reminderRows.map((r) => r.appointment_id));
  ok('the reminder text is the reminder template',
    /Opomnik/.test(reminderRows[0].body), reminderRows[0].body);
  ok('the reminder goes to the right number',
    reminderRows[0].phone === '+38631555777', reminderRows[0].phone);

  ok('an appointment booked inside the window gets no reminder',
    !sms.list({ kind: 'reminder' }).some((r) => r.appointment_id === bookedLateId));
  ok('an appointment beyond the window gets no reminder',
    !sms.list({ kind: 'reminder' }).some((r) => r.appointment_id === farId));
  ok('a cancelled appointment gets no reminder',
    !sms.list({ kind: 'reminder' }).some((r) => r.appointment_id === cancelledId));

  scan = sms.scanReminders();
  ok('scanning again sends no duplicate', scan.queued === 0, scan);

  await sms.processDue({ limit: 10 });
  ok('the reminder is actually delivered',
    sms.list({ kind: 'reminder' })[0].status === 'accepted',
    sms.list({ kind: 'reminder' })[0].status);

  settings.set('sms_reminder_enabled', '0');
  makeAppt(11 * 3600000);
  ok('no reminders at all when the setting is off',
    sms.scanReminders().queued === 0);

  settings.set('sms_reminder_enabled', '1');
  settings.set('sms_enabled', '0');
  ok('no reminders when SMS itself is off', sms.scanReminders().queued === 0);
  settings.set('sms_enabled', '1');

  section('the log is kept for a year, then forgotten');

  // Plant rows at known ages. created_at is written directly because the
  // whole point is to have messages older than the retention window.
  const plant = (createdAt, status, kind) => {
    const info = db
      .prepare(
        `INSERT INTO sms_log
           (appointment_id, customer_id, phone, kind, body, status, error,
            attempts, next_attempt_at, provider_id, updated_at, created_at)
         VALUES (NULL, 1, '+38631000000', ?, 'staro sporocilo', ?, '', 1, '', '', ?, ?)`
      )
      .run(kind, status, createdAt, createdAt);
    return Number(info.lastInsertRowid);
  };

  const NOW = new Date(2027, 0, 20, 12, 0, 0);
  const iso = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).toISOString();

  const ancient = plant(iso(2023, 2, 10), 'delivered', 'booked');
  const oldFailed = plant(iso(2024, 11, 5), 'dead', 'cancelled');
  const justOutside = plant(iso(2025, 12, 1), 'accepted', 'booked');
  const justInside = plant(iso(2026, 3, 1), 'delivered', 'reminder');
  const recent = plant(iso(2027, 1, 2), 'accepted', 'booked');
  // Old but unfinished: still owed to a customer, must survive.
  const stillQueued = plant(iso(2023, 5, 5), 'queued', 'booked');
  const stillRetrying = plant(iso(2023, 6, 6), 'retry', 'booked');

  ok('the cutoff is twelve months back',
    sms.pruneCutoff(12, NOW).startsWith('2026-01-20'), sms.pruneCutoff(12, NOW));

  const pruned = sms.prune({ months: 12, now: NOW });
  ok('pruning reports what it removed', pruned.deleted === 3, pruned);

  const alive = (id) => !!sms.get(id);
  ok('a message from four years ago is gone', !alive(ancient));
  ok('an old failed message is gone', !alive(oldFailed));
  ok('the month just outside the window is gone', !alive(justOutside));
  ok('a message inside the window is kept', alive(justInside));
  ok('a recent message is kept', alive(recent));

  // The guard that matters: an unfinished message is never deleted, however
  // old, because deleting it would mean the customer silently never gets it.
  ok('an old but still queued message survives', alive(stillQueued));
  ok('an old but still retrying message survives', alive(stillRetrying));

  ok('pruning again changes nothing', sms.prune({ months: 12, now: NOW }).deleted === 0);

  // Once it finishes, it becomes eligible on the next pass.
  db.prepare("UPDATE sms_log SET status = 'dead' WHERE id = ?").run(stillQueued);
  ok('it becomes prunable once it has finished',
    sms.prune({ months: 12, now: NOW }).deleted === 1);
  ok('and is then really gone', !alive(stillQueued));

  // Cleaned up so the counts below are not thrown off.
  db.prepare('DELETE FROM sms_log WHERE id IN (?, ?, ?, ?)')
    .run(justInside, recent, stillRetrying, oldFailed);

  section('Telemach SMS Kurir');

  // A stand-in for KurirWS: it records the envelope and answers the way the
  // real one does — HTTP 200 whether it accepted the message or refused it.
  const soapCalls = [];
  const kurir = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      soapCalls.push({
        contentType: req.headers['content-type'],
        soapAction: req.headers.soapaction,
        body,
      });
      const guid = (/guid="([^"]*)"/.exec(body) || [])[1] || '';
      let answer;
      if (req.url === '/refused') {
        answer =
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
          '<ns2:KurirResponse xmlns:ns2="http://webservices.tusmobil.si/kurir">' +
          `<Response guid="${guid}" status="PARAMETER_ERROR" error="Invalid bcode format">` +
          `<SendSmsResponse guid="${guid}" status="PARAMETER_ERROR" error="Invalid bcode format"/>` +
          '</Response></ns2:KurirResponse></soap:Body></soap:Envelope>';
      } else if (req.url === '/fault') {
        answer =
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
          '<soap:Fault><faultcode>soap:Server</faultcode>' +
          '<faultstring>Access denied</faultstring></soap:Fault>' +
          '</soap:Body></soap:Envelope>';
      } else {
        answer =
          '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
          '<ns2:KurirResponse xmlns:ns2="http://webservices.tusmobil.si/kurir">' +
          `<Response guid="${guid}" status="OK">` +
          `<SendSmsResponse guid="${guid}" status="OK" sender="Berni" queue="sms_queue_fast"/>` +
          '</Response></ns2:KurirResponse></soap:Body></soap:Envelope>';
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(answer);
    });
  });
  await new Promise((r) => kurir.listen(0, '127.0.0.1', r));
  const kurirBase = `http://127.0.0.1:${kurir.address().port}`;

  process.env.TELEMACH_URL = `${kurirBase}/send`;
  process.env.TELEMACH_SENDER = 'Berni';

  {
    const out = await sms.deliverTelemach('+38631331636', 'Pozdravljeni Ana, naroceni ste');
    const sent = soapCalls[soapCalls.length - 1];

    ok('the envelope is sent as XML', /text\/xml/.test(sent.contentType), sent.contentType);
    ok('a SOAPAction header is present', sent.soapAction !== undefined, sent.soapAction);
    ok('the recipient loses the plus', /recipient="38631331636"/.test(sent.body), sent.body);
    ok('the registered sender is used', /sender="Berni"/.test(sent.body));
    ok('appid defaults to kurir', /appid="kurir"/.test(sent.body));
    ok('schedule defaults to 0, not Telemach\'s 8am-9pm window',
      /schedule="0"/.test(sent.body), sent.body);
    ok('the message text is the element body',
      /<SendSms[^>]*>Pozdravljeni Ana, naroceni ste<\/SendSms>/.test(sent.body), sent.body);
    ok('no billing code is sent when none is configured', !/bcode=/.test(sent.body));
    ok('the guid is returned as the provider id',
      !!out.providerId && sent.body.includes(`guid="${out.providerId}"`), out.providerId);
  }

  {
    // The salon really has a service called "Barvanje & striženje"; an
    // unescaped ampersand would make the envelope unparseable at Telemach.
    await sms.deliverTelemach('031 331 636', 'Barvanje & striženje <1> "termin"');
    const sent = soapCalls[soapCalls.length - 1];
    ok('an ampersand in the text is escaped', /Barvanje &amp; stri/.test(sent.body), sent.body);
    ok('angle brackets in the text are escaped',
      /&lt;1&gt;/.test(sent.body) && !/<1>/.test(sent.body), sent.body);
    ok('the envelope has no stray unescaped entity',
      !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(sent.body), sent.body);
    ok('a local number is still normalised', /recipient="38631331636"/.test(sent.body), sent.body);
  }

  {
    let threw = '';
    process.env.TELEMACH_URL = `${kurirBase}/refused`;
    try { await sms.deliverTelemach('+38631331636', 'Test'); } catch (e) { threw = e.message; }
    ok('a refusal inside a 200 response is an error, not an accepted message',
      /PARAMETER_ERROR/.test(threw), threw);
    ok('the reason from Telemach is kept', /Invalid bcode format/.test(threw), threw);
  }

  {
    let threw = '';
    process.env.TELEMACH_URL = `${kurirBase}/fault`;
    try { await sms.deliverTelemach('+38631331636', 'Test'); } catch (e) { threw = e.message; }
    ok('a SOAP fault is an error', /Access denied/.test(threw), threw);
  }

  {
    process.env.TELEMACH_URL = `${kurirBase}/send`;
    process.env.TELEMACH_SENDER = 'PredolgoIme';
    process.env.TELEMACH_SCHEDULE = '1';
    let threw = '';
    try { await sms.deliverTelemach('+38631331636', 'Test'); } catch (e) { threw = e.message; }
    ok('a sender of exactly 11 characters is accepted', threw === '', threw);

    process.env.TELEMACH_SENDER = 'PredolgoImeX';
    threw = '';
    try { await sms.deliverTelemach('+38631331636', 'Test'); } catch (e) { threw = e.message; }
    ok('a sender of 12 characters is refused before sending',
      /daljši od 11/.test(threw), threw);

    process.env.TELEMACH_SENDER = 'Berni';
    await sms.deliverTelemach('+38631331636', 'Test');
    ok('the schedule can be set back to Telemach\'s window',
      /schedule="1"/.test(soapCalls[soapCalls.length - 1].body));
    delete process.env.TELEMACH_SCHEDULE;
  }

  {
    let threw = '';
    try { await sms.deliverTelemach('ni telefona', 'Test'); } catch (e) { threw = e.message; }
    ok('a number with no digits never reaches the gateway',
      /telefonska/.test(threw), threw);
  }

  ok('the outcome reader accepts a plain OK',
    sms.telemachOutcome('<Response guid="1" status="OK"/>').ok);
  ok('the outcome reader catches a per-message refusal the envelope hid',
    sms.telemachOutcome(
      '<Response status="OK"><SendSmsResponse status="ACCESS_ERROR" error="Denied"/></Response>'
    ).ok === false);
  ok('an unrecognisable response is an error, not a success',
    sms.telemachOutcome('nekaj popolnoma drugega').ok === false);

  section('Kurir Notify receipts');

  // Kurir Notify nests everything under SmsStatus and names two status fields.
  process.env.SMS_DLR_ID_FIELD = 'SmsStatus.guid';
  process.env.SMS_DLR_STATUS_FIELD = 'SmsStatus.deliveryStatus,SmsStatus.sendStatus';
  process.env.SMS_DLR_DELIVERED = 'DELIVERED';
  process.env.SMS_DLR_FAILED = 'EXPIRED,BLOCKED,SUBSCRIBER_UNKNOWN,ERROR';

  /** Give an existing log row a known guid, the way a real send would. */
  function rowWithGuid(guid) {
    const row = sms.list({ limit: 1 })[0];
    db.prepare('UPDATE sms_log SET provider_id = ?, status = ? WHERE id = ?')
      .run(guid, 'accepted', row.id);
    return row.id;
  }

  {
    const id = rowWithGuid('GUID-DELIVERED');
    const out = sms.applyReceipt({
      SmsStatus: {
        messageId: 'SA777888999444',
        guid: 'GUID-DELIVERED',
        recipient: '38631331636',
        sendStatus: 'SENT',
        deliveryStatus: 'DELIVERED',
        deliveryTime: '30.01.2019 12:32:06',
      },
    });
    ok('a nested Kurir Notify receipt is matched by guid', out.status === 'delivered', out);
    ok('the row is marked delivered', sms.get(id).status === 'delivered', sms.get(id).status);
  }

  {
    const id = rowWithGuid('GUID-EXPIRED');
    sms.applyReceipt({ SmsStatus: { guid: 'GUID-EXPIRED', deliveryStatus: 'EXPIRED' } });
    ok('an expired message is marked undelivered',
      sms.get(id).status === 'undelivered', sms.get(id).status);
  }

  {
    // A message that failed at sending has no deliveryStatus at all, so the
    // second configured field is what saves it from being left as accepted.
    const id = rowWithGuid('GUID-SENDERROR');
    sms.applyReceipt({ SmsStatus: { guid: 'GUID-SENDERROR', sendStatus: 'ERROR' } });
    ok('a send error falls through to the second status field',
      sms.get(id).status === 'undelivered', sms.get(id).status);
  }

  {
    const id = rowWithGuid('GUID-WAITING');
    sms.applyReceipt({ SmsStatus: { guid: 'GUID-WAITING', deliveryStatus: 'NOT_DELIVERED' } });
    ok('NOT_DELIVERED means still trying, so the row is left alone',
      sms.get(id).status === 'accepted', sms.get(id).status);
  }

  for (const name of [
    'SMS_DLR_ID_FIELD', 'SMS_DLR_STATUS_FIELD', 'SMS_DLR_DELIVERED', 'SMS_DLR_FAILED',
  ]) delete process.env[name];

  await new Promise((resolve) => kurir.close(resolve));

  section('the log screen queries');

  ok('the log lists rows newest first', sms.list({ limit: 5 }).length > 0);
  const totals = sms.counts();
  ok('counts add up to something', totals.total > 0, totals);
  ok('counts separate the problems', typeof totals.problem === 'number', totals);
  ok('filtering by status narrows the list',
    sms.list({ status: 'delivered' }).every((r) => r.status === 'delivered'));
  ok('filtering by kind narrows the list',
    sms.list({ kind: 'reminder' }).every((r) => r.kind === 'reminder'));
  ok('the pending filter only returns unfinished rows',
    sms.list({ status: 'pending' }).every((r) => r.is_pending));
  ok('rows carry a human label', !!sms.list({ limit: 1 })[0].status_label,
    sms.list({ limit: 1 })[0].status_label);

  await new Promise((resolve) => gateway.close(resolve));

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
  console.log('');

  // Let the loop drain rather than calling process.exit, which on Windows can
  // abort while the database and server handles are still closing.
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});

// Temporary database files go once everything else has shut down.
process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
