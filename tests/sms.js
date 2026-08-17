'use strict';
/**
 * SMS tests: number normalisation, and the generic HTTP driver against a fake
 * gateway that captures exactly what the app would send to a real provider.
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

// The chosen driver is read once when src/sms.js is first required, exactly as
// it is in production, so it has to be set before any require below.
process.env.SMS_DRIVER = 'http';

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
        res.end('{"status":"queued"}');
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

  const sms = require(path.join(__dirname, '..', 'src', 'sms'));
  const settings = require(path.join(__dirname, '..', 'src', 'settings'));
  settings.set('sms_enabled', '1');
  settings.set('salon_name', 'Frizerski salon Berni');

  const customer = { id: 1, first_name: 'Ana', phone: '031 123 456' };
  const appt = {
    id: 1, date: '2026-08-27', start_min: 11 * 60, service_name: 'MOŠKO MODERNO, FADE STRIŽENJE',
  };

  let result = await sms.notify('booked', customer, appt);
  ok('booking reports sent', result.status === 'sent', result);
  ok('gateway was called once', received.length === 1, received.length);

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
  ok('message is the Slovene template',
    parsed && parsed.message === 'Frizerski salon Berni: Pozdravljeni Ana, naročeni ste 27.08.2026 ob 11:00. Storitev: MOŠKO MODERNO, FADE STRIŽENJE. Lep pozdrav.',
    parsed && parsed.message);

  // A name containing a quote must not break the JSON body.
  received.length = 0;
  result = await sms.notify('booked', { id: 2, first_name: 'An"a\nNova', phone: '040 111 222' }, appt);
  ok('awkward characters still send', result.status === 'sent', result);
  let parsed2 = null;
  try { parsed2 = JSON.parse(received[0].body); } catch { /* reported below */ }
  ok('quote and newline escaped into valid JSON', !!parsed2, received[0] && received[0].body);
  ok('escaped text round-trips', parsed2 && parsed2.message.includes('An"a\nNova'),
    parsed2 && parsed2.message);

  // form-encoded gateways
  received.length = 0;
  process.env.SMS_HTTP_FORMAT = 'form';
  process.env.SMS_HTTP_BODY = 'recipient={{to}}&body={{text}}&sender={{from}}';
  result = await sms.notify('booked', customer, appt);
  ok('form format sends', result.status === 'sent', result);
  const form = new URLSearchParams(received[0] ? received[0].body : '');
  ok('form content type', /x-www-form-urlencoded/.test(received[0].contentType || ''), received[0].contentType);
  ok('form carries the number', form.get('recipient') === '+38631123456', form.get('recipient'));
  ok('form carries the message', (form.get('body') || '').startsWith('Frizerski salon Berni:'), form.get('body'));

  // a failing gateway must not lose the appointment
  received.length = 0;
  process.env.SMS_HTTP_FORMAT = 'json';
  process.env.SMS_HTTP_BODY = '{"phoneNumbers":["{{to}}"],"message":"{{text}}"}';
  process.env.SMS_HTTP_URL = `${base}/broken`;
  result = await sms.notify('booked', customer, appt);
  ok('gateway error reported, not thrown', result.status === 'failed', result);
  ok('failure message is for the employee', /ni bilo mogoče poslati/i.test(result.message), result.message);
  const logged = sms.lastForAppointment(1);
  ok('failure recorded with the gateway reason', logged && logged.status === 'failed' && /500/.test(logged.error),
    logged && logged.error);

  // unusable number
  received.length = 0;
  process.env.SMS_HTTP_URL = `${base}/send`;
  result = await sms.notify('booked', { id: 3, first_name: 'Brez', phone: 'ni telefona' }, appt);
  ok('unusable number is refused before calling out', result.status === 'failed' && received.length === 0,
    { status: result.status, calls: received.length });

  // missing customer phone
  result = await sms.notify('booked', { id: 4, first_name: 'Prazno', phone: '' }, appt);
  ok('missing number reported as no_phone', result.status === 'no_phone', result);

  // switch off
  settings.set('sms_enabled', '0');
  received.length = 0;
  result = await sms.notify('booked', customer, appt);
  ok('disabled setting sends nothing', result.status === 'disabled' && received.length === 0,
    { status: result.status, calls: received.length });

  // misconfiguration is reported clearly
  settings.set('sms_enabled', '1');
  process.env.SMS_HTTP_BODY = '{"message":"{{text}}"';
  result = await sms.notify('booked', customer, appt);
  ok('broken body template fails safely', result.status === 'failed', result);
  const bad = sms.lastForAppointment(1);
  ok('template error explains itself', bad && /veljaven JSON/.test(bad.error), bad && bad.error);

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
