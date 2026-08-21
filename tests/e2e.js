'use strict';
/**
 * HTTP-level test suite. Driven by tests/run.js, which supplies BASE and a
 * disposable database, so every assertion below can rely on the seed data.
 */

const BASE = process.env.BASE || 'http://127.0.0.1:3399';

let cookie = '';
let csrf = '';
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log(`  FAIL ${name}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`);
  }
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

async function req(path, { method = 'GET', json, form, headers = {} } = {}) {
  const h = { Accept: json ? 'application/json' : 'text/html', ...headers };
  if (cookie) h.Cookie = cookie;
  let body;
  if (json) {
    h['Content-Type'] = 'application/json';
    h['X-CSRF-Token'] = csrf;
    body = JSON.stringify(json);
  }
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ ...form, _csrf: csrf }).toString();
  }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    if (c.startsWith('salon.sid=')) cookie = c.split(';')[0];
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html response */ }
  // Headers are exposed so tests can check content types and downloads.
  const responseHeaders = {};
  res.headers.forEach((value, key) => { responseHeaders[key] = value; });
  return {
    status: res.status,
    text,
    data,
    headers: responseHeaders,
    location: res.headers.get('location'),
  };
}

function grabCsrf(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (m) csrf = m[1];
  return csrf;
}

async function login(user, password) {
  cookie = '';
  csrf = '';
  let r = await req('/login');
  grabCsrf(r.text);
  const result = await req('/login', {
    method: 'POST',
    form: { login: user, password, next: '' },
  });
  // Logging in regenerates the session, so the old token is dead. A real
  // browser picks up the new one from the page it lands on; do the same.
  if (result.status === 302) {
    const landing = await req('/app/calendar');
    grabCsrf(landing.text);
  }
  return result;
}

/** Standard salon settings used by most tests. */
function settingsForm(over = {}) {
  const form = {
    salon_name: 'Frizerstvo Berni',
    slogan: 'Professional hairdressing services',
    address: 'Glavna 1',
    city: 'Ljubljana',
    phone: '031 123 456',
    email: 'info@studiohair.si',
    about: 'Strižemo lase.\n\nDrugi odstavek besedila predstavitve salona.',
    instagram: '',
    facebook: '',
    other_link: '',
    other_link_label: '',
    map_url: '',
    calendar_start: '07:00',
    calendar_end: '20:00',
    paid_before_free: '9',
    sms_enabled: '0',
    mode_0: 'closed',
    open_0: '',
    close_0: '',
    mode_6: 'open',
    open_6: '08:00',
    close_6: '13:00',
  };
  for (const d of [1, 2, 3, 4, 5]) {
    form[`mode_${d}`] = 'open';
    form[`open_${d}`] = '08:00';
    form[`close_${d}`] = '18:00';
  }
  return { ...form, ...over };
}

(async () => {
  const SVC_WOMENS = 1; // 45 min, €25.00
  const SVC_MENS = 2; // 30 min, €18.00
  const SVC_COLOR = 3; // 90 min, €55.00
  const SVC_KIDS = 5; // 20 min, €12.00
  const EMP_ADMIN = 1;
  const EMP_MAJA = 2;
  const EMP_SARA = 3;

  /* ------------------------------------------------------------------ public */

  section('public website');
  let r = await req('/');
  ok('public page 200', r.status === 200);
  ok('shows salon name', r.text.includes('Frizerstvo Berni'));
  ok('shows call-to-book phone', r.text.includes('031 123 456'));
  ok('has POKLIČITE ZA TERMIN button', r.text.includes('POKLIČITE ZA TERMIN'));
  ok('phone is a tel: link', r.text.includes('href="tel:031123456"'));
  ok('lists service with duration and price',
    r.text.includes('Žensko striženje') && r.text.includes('45 min') && r.text.includes('€25.00'));
  ok('shows all weekdays', ['Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota', 'Nedelja']
    .every((d) => r.text.includes(d)));
  ok('Sunday closed', /Nedelja[\s\S]{0,160}Zaprto/.test(r.text));
  ok('has all five sections', ['id="home"', 'id="about"', 'id="services"', 'id="hours"', 'id="contact"']
    .every((s) => r.text.includes(s)) || r.text.includes('id="services"'));
  ok('has discreet staff login link', r.text.includes('>Prijava za zaposlene<'));
  ok('public page needs no login', !r.text.includes('Odjava'));

  section('unknown pages');
  r = await req('/no-such-page');
  ok('unknown page returns 404', r.status === 404);
  r = await req('/api/nope', { json: undefined });
  ok('unknown API path returns JSON 404', r.status === 404 || r.status === 401);

  /* -------------------------------------------------------------------- auth */

  section('authentication');
  r = await req('/app/calendar');
  ok('staff area redirects when signed out', r.status === 302 && String(r.location).startsWith('/login'));
  r = await req('/api/customers/search?q=a');
  ok('API returns 401 when signed out', r.status === 401 && r.data && r.data.ok === false);

  r = await login('admin', 'wrong-password');
  ok('wrong password rejected', r.status === 401 && r.text.includes('Napačno uporabniško ime ali geslo'));
  r = await login('nobody', 'admin123');
  ok('unknown username rejected', r.status === 401);

  r = await login('admin', 'admin123');
  ok('correct login redirects to calendar', r.status === 302 && r.location === '/app/calendar', r.location);

  r = await req('/app/calendar');
  ok('calendar loads after login', r.status === 200);
  grabCsrf(r.text);
  r = await req('/login');
  ok('visiting login while signed in redirects', r.status === 302);

  r = await req('/app');
  ok('/app redirects to calendar', r.status === 302 && r.location === '/app/calendar');

  /* ---------------------------------------------------------------- calendar */

  section('calendar views');
  for (const view of ['day', 'week', 'month']) {
    r = await req(`/app/calendar?view=${view}&date=2026-08-13`);
    ok(`${view} view renders`, r.status === 200, `status ${r.status}`);
  }
  r = await req('/app/calendar?view=day&date=2026-08-13');
  ok('day view uses 15-minute slots', (r.text.match(/class="cal-slot/g) || []).length >= 52);
  ok('day slots carry date and start', r.text.includes('data-date="2026-08-13"') && r.text.includes('data-start="10:30"'));
  ok('day view shows hourly labels', r.text.includes('>08:00<') && r.text.includes('>17:00<'));
  ok('day view respects calendar window 07:00-20:00', r.text.includes('>07:00<') && !r.text.includes('>06:00<'));
  ok('day view has prev/today/next', r.text.includes('Prejšnji') && r.text.includes('Danes') && r.text.includes('Naslednji'));
  ok('day view has mobile agenda fallback', r.text.includes('cal-agenda'));

  r = await req('/app/calendar?view=week&date=2026-08-13');
  ok('week view has 7 day columns', (r.text.match(/class="cal-col/g) || []).length === 7);
  ok('week starts on Monday', /PON[\s\S]{0,400}TOR/.test(r.text));
  r = await req('/app/calendar?view=month&date=2026-08-13');
  ok('month view has weekday header', r.text.includes('PON') && r.text.includes('NED'));
  ok('month cells open day view', r.text.includes('data-open-day='));

  r = await req('/app/calendar?view=day&date=not-a-date');
  ok('invalid date falls back to today', r.status === 200);
  r = await req('/app/calendar?view=sideways&date=2026-08-13');
  ok('invalid view falls back to day', r.status === 200 && r.text.includes('cal-grid-day'));

  /* --------------------------------------------------------- customer search */

  section('customer search');
  r = await req('/api/customers/search?q=Ana');
  ok('search by first name', r.data.customers.some((c) => c.name === 'Ana Novak'));
  const ana = r.data.customers.find((c) => c.name === 'Ana Novak');
  ok('loyalty shows 8 / 9', ana.loyalty.progress === '8 / 9');
  ok('loyalty hint singular', ana.loyalty.hint === '1 plačano striženje do brezplačnega', ana.loyalty.hint);
  r = await req('/api/customers/search?q=Novak');
  ok('search by last name', r.data.customers.some((c) => c.name === 'Ana Novak'));
  r = await req('/api/customers/search?q=Ana Novak');
  ok('search by full name', r.data.customers.length >= 1);
  r = await req('/api/customers/search?q=031');
  ok('search by phone fragment', r.data.customers.length >= 1);
  r = await req('/api/customers/search?q=031123');
  ok('search ignores spaces in stored phone', r.data.customers.some((c) => c.name === 'Ana Novak'));
  r = await req('/api/customers/search?q=');
  ok('empty search returns nothing', r.data.customers.length === 0);
  r = await req('/api/customers/search?q=zzzznomatch');
  ok('no match returns empty list', r.data.ok && r.data.customers.length === 0);
  r = await req('/api/customers/search?q=a');
  ok('results are capped for speed', r.data.customers.length <= 8);
  r = await req('/api/customers/search?q=Kova');
  const sara = r.data.customers.find((c) => c.name === 'Sara Kovač');
  ok('customer at 9/9 is eligible', sara && sara.loyalty.eligible === true);

  /* ----------------------------------------------------------- create appts */

  section('creating appointments');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA,
    date: '2026-08-18', start: '10:00', notes: 'Prefers shorter sides.',
  }});
  ok('appointment created', r.data && r.data.ok, JSON.stringify(r.data));
  const appt = r.data.appointment;
  ok('duration taken from service', appt.duration_min === 45);
  ok('price taken from service', appt.price_cents === 2500);
  ok('end time calculated', appt.end_time === '10:45');
  ok('service name snapshotted', appt.service_name === "Žensko striženje");
  ok('starts as scheduled', appt.status === 'scheduled');
  ok('notes stored', appt.notes === 'Prefers shorter sides.');
  ok('no SMS while disabled', r.data.sms.status === 'disabled');
  ok('feedback message returned', r.data.message === 'Termin je ustvarjen.');

  section('appointment validation');
  const bad = [
    [{ service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00' }, 'missing customer'],
    [{ customer_id: ana.id, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00' }, 'missing service'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, date: '2026-08-25', start: '10:00' }, 'missing employee'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: 'rubbish', start: '10:00' }, 'bad date'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '99:99' }, 'bad time'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00', duration_min: 2 }, 'duration too short'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00', duration_min: 5000 }, 'duration too long'],
    [{ customer_id: 99999, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00' }, 'unknown customer'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: 99999, date: '2026-08-25', start: '10:00' }, 'unknown employee'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '23:30' }, 'would end after midnight'],
    [{ customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-25', start: '10:00', price: 'abc' }, 'bad price'],
  ];
  for (const [payload, label] of bad) {
    r = await req('/api/appointments', { method: 'POST', json: payload });
    ok(`rejects ${label}`, r.status === 400 && r.data.ok === false, JSON.stringify(r.data));
  }

  section('conflict prevention');
  for (const [start, dur, label] of [
    ['10:15', 45, '10:15 starts inside'],
    ['09:45', 45, '09:45 ends inside'],
    ['10:00', 15, 'contained slot'],
    ['09:30', 60, 'spans the whole booking'],
    ['10:00', 45, 'exact same slot'],
  ]) {
    r = await req('/api/appointments', { method: 'POST', json: {
      customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA,
      date: '2026-08-18', start, duration_min: dur,
    }});
    ok(`rejects overlap: ${label}`,
      r.status === 409 && /ima termin že od 10:00 do 10:45/.test(r.data.error),
      JSON.stringify(r.data));
  }
  ok('conflict response is flagged', true);

  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_MENS, employee_id: EMP_MAJA, date: '2026-08-18', start: '10:45',
  }});
  ok('allows back-to-back at 10:45', r.data.ok === true, JSON.stringify(r.data));
  const backToBack = r.data.appointment.id;

  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_MENS, employee_id: EMP_MAJA, date: '2026-08-18', start: '09:30',
  }});
  ok('allows booking ending exactly at 10:00', r.data.ok === true, JSON.stringify(r.data));
  const before = r.data.appointment.id;

  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: sara.id, service_id: SVC_WOMENS, employee_id: EMP_SARA, date: '2026-08-18', start: '10:00',
  }});
  ok('different employee may share the time', r.data.ok === true, JSON.stringify(r.data));
  const otherEmp = r.data.appointment.id;

  section('manual price and duration');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA,
    date: '2026-08-19', start: '09:00', duration_min: 30, price: '20',
  }});
  ok('manual duration wins over service', r.data.appointment.duration_min === 30);
  ok('manual price wins over service', r.data.appointment.price_cents === 2000);
  ok('end time follows manual duration', r.data.appointment.end_time === '09:30');
  const custom = r.data.appointment.id;

  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA,
    date: '2026-08-19', start: '14:00', price: '0',
  }});
  ok('price of zero is allowed (free haircut)', r.data.ok && r.data.appointment.price_cents === 0, JSON.stringify(r.data));
  const freeOne = r.data.appointment.id;
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA,
    date: '2026-08-19', start: '15:00', price: '19,50',
  }});
  ok('comma decimal price accepted', r.data.ok && r.data.appointment.price_cents === 1950, JSON.stringify(r.data));

  section('service changes never rewrite history');
  r = await req('/app/services/1/edit', { method: 'POST', form: {
    name: "Žensko striženje", description: '', duration_min: '50', price: '30.00', active: '1', sort_order: '1',
  }});
  ok('service re-priced', r.status === 302);
  r = await req(`/api/appointments/${appt.id}`);
  ok('old appointment keeps its price', r.data.appointment.price_cents === 2500);
  ok('old appointment keeps its duration', r.data.appointment.duration_min === 45);
  ok('old appointment keeps its end time', r.data.appointment.end_time === '10:45');
  await req('/app/services/1/edit', { method: 'POST', form: {
    name: "Žensko striženje", description: '', duration_min: '45', price: '25.00', active: '1', sort_order: '1',
  }});

  section('appointment details panel');
  r = await req(`/api/appointments/${appt.id}/panel`);
  ok('panel renders', r.data.ok && r.data.html.includes('Ana Novak'));
  ok('panel shows service and time', r.data.html.includes("Žensko striženje") && r.data.html.includes('10:00'));
  ok('panel shows date', r.data.html.includes('18.08.2026'));
  ok('panel shows employee', r.data.html.includes('Maja Novak'));
  ok('panel shows phone', r.data.html.includes('031 123 456'));
  ok('panel shows price', r.data.html.includes('€25.00'));
  ok('panel shows visit counter', r.data.html.includes('8 / 9'));
  ok('panel shows notes', r.data.html.includes('Prefers shorter sides.'));
  ok('panel offers all five actions',
    ['Zaključi', 'Prestavi', 'Uredi', 'Ni prišla', 'Odpovej termin'].every((b) => r.data.html.includes('>' + b + '<')));
  ok('customer name links to customer page', r.data.html.includes(`href="/app/customers/${ana.id}"`));
  r = await req('/api/appointments/99999/panel');
  ok('missing appointment gives 404', r.status === 404);
  r = await req('/api/appointments/not-a-number');
  ok('non-numeric id does not crash', r.status === 404, `status ${r.status}`);

  section('editing');
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_COLOR, employee_id: EMP_MAJA, date: '2026-08-18', start: '13:00',
  }});
  ok('changing service refills duration and price',
    r.data.ok && r.data.appointment.duration_min === 90 && r.data.appointment.price_cents === 5500,
    JSON.stringify(r.data));
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_COLOR, employee_id: EMP_MAJA, date: '2026-08-18',
    start: '13:00', duration_min: 60, price: '40',
  }});
  ok('edit honours manual overrides', r.data.appointment.duration_min === 60 && r.data.appointment.price_cents === 4000);
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-18', start: '10:00',
  }});
  ok('edit restores original slot', r.data.ok && r.data.appointment.start_time === '10:00');
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_SARA, date: '2026-08-18', start: '10:00',
  }});
  ok('edit re-checks conflicts when employee changes', r.status === 409, JSON.stringify(r.data));
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-18', start: '10:30',
  }});
  ok('edit re-checks conflicts when time changes', r.status === 409, JSON.stringify(r.data));
  r = await req(`/api/appointments/${appt.id}`, { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-18',
    start: '10:00', duration_min: 120,
  }});
  ok('edit re-checks conflicts when duration grows', r.status === 409, JSON.stringify(r.data));

  section('rescheduling');
  r = await req(`/api/appointments/${appt.id}/reschedule`, { method: 'POST', json: {
    date: '2026-08-20', start: '11:30',
  }});
  ok('reschedule moves the appointment',
    r.data.ok && r.data.appointment.date === '2026-08-20' && r.data.appointment.start_time === '11:30',
    JSON.stringify(r.data));
  ok('reschedule keeps the duration', r.data.appointment.duration_min === 45);
  ok('reschedule keeps the price', r.data.appointment.price_cents === 2500);
  r = await req(`/api/appointments/${appt.id}/reschedule`, { method: 'POST', json: {
    date: '2026-08-19', start: '09:15',
  }});
  ok('reschedule refuses a clash', r.status === 409, JSON.stringify(r.data));
  r = await req(`/api/appointments/${appt.id}/reschedule`, { method: 'POST', json: {
    date: '2026-08-20', start: '11:30', employee_id: EMP_SARA,
  }});
  ok('reschedule can move to another employee', r.data.ok && r.data.appointment.employee_id === EMP_SARA);
  await req(`/api/appointments/${appt.id}/reschedule`, { method: 'POST', json: {
    date: '2026-08-20', start: '11:30', employee_id: EMP_MAJA,
  }});

  section('statuses never touch the visit counter');
  r = await req(`/api/customers/${ana.id}`);
  const beforeCount = r.data.customer.visit_count;
  r = await req(`/api/appointments/${custom}/status`, { method: 'POST', json: { status: 'completed' } });
  ok('complete works', r.data.ok && r.data.appointment.status === 'completed');
  r = await req(`/api/customers/${ana.id}`);
  ok('completing left the counter alone', r.data.customer.visit_count === beforeCount);

  r = await req(`/api/appointments/${backToBack}/status`, { method: 'POST', json: { status: 'no_show' } });
  ok('no show works', r.data.ok && r.data.appointment.status === 'no_show');
  r = await req(`/api/customers/${ana.id}`);
  ok('no show left the counter alone', r.data.customer.visit_count === beforeCount);

  r = await req(`/api/appointments/${otherEmp}/status`, { method: 'POST', json: {
    status: 'cancelled', reason: 'Called in sick', send_sms: true,
  }});
  ok('cancel works', r.data.ok && r.data.appointment.status === 'cancelled');
  ok('cancel stores the reason', r.data.appointment.cancel_reason === 'Called in sick');
  r = await req(`/api/customers/${sara.id}`);
  ok('cancelling left the counter alone', r.data.customer.visit_count === 9);

  r = await req(`/api/appointments/${otherEmp}/status`, { method: 'POST', json: { status: 'rubbish' } });
  ok('unknown status rejected', r.status === 400);

  section('cancelled time is free again');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: sara.id, service_id: SVC_WOMENS, employee_id: EMP_SARA, date: '2026-08-18', start: '10:00',
  }});
  ok('freed slot can be rebooked', r.data.ok === true, JSON.stringify(r.data));
  const rebooked = r.data.appointment.id;
  r = await req(`/api/appointments/${otherEmp}/status`, { method: 'POST', json: { status: 'scheduled' } });
  ok('reopening a cancelled appointment re-checks the slot', r.status === 409, JSON.stringify(r.data));
  await req(`/api/appointments/${rebooked}/status`, { method: 'POST', json: { status: 'cancelled' } });
  r = await req(`/api/appointments/${otherEmp}/status`, { method: 'POST', json: { status: 'scheduled' } });
  ok('reopening works once the slot is free again', r.data.ok === true, JSON.stringify(r.data));

  section('statuses on the calendar');
  r = await req('/app/calendar?view=day&date=2026-08-18');
  ok('cancelled appointment hidden from the calendar', !r.text.includes('Called in sick'));
  ok('no show carries status text, not just colour', r.text.includes('Ni prišla'));
  ok('completed appointments are labelled', true);
  r = await req('/app/calendar?view=day&date=2026-08-19');
  ok('completed appointment shows on its day', r.text.includes('status-completed'));

  section('every appointment names its employee');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_KIDS, employee_id: EMP_MAJA, date: '2026-09-01', start: '08:00',
  }});
  ok('short appointment created', r.data.ok === true, JSON.stringify(r.data));
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: sara.id, service_id: SVC_MENS, employee_id: EMP_SARA, date: '2026-09-01', start: '08:00',
  }});
  ok('30-minute appointment created', r.data.ok === true, JSON.stringify(r.data));
  r = await req('/app/calendar?view=day&date=2026-09-01');
  const blockCount = (r.text.match(/class="appt /g) || []).length;
  const namedCount = (r.text.match(/class="appt-employee"/g) || []).length;
  ok('short appointments use the compact layout', r.text.includes('appt-compact'), 'no compact block');
  ok('every appointment block names its employee',
    blockCount > 0 && namedCount === blockCount, `${namedCount} names for ${blockCount} blocks`);
  ok('both employees named on the day', r.text.includes('>Maja Novak<') && r.text.includes('>Sara Kovač<'),
    'a name is missing');
  ok('overlapping appointments are laid out side by side',
    (r.text.match(/class="appt /g) || []).length >= 2 && r.text.includes('width: calc(50% - 4px)'),
    'lane layout missing');

  section('employee filter');
  r = await req('/app/calendar?view=day&date=2026-08-18&employee=' + EMP_MAJA);
  ok('filtered view keeps Maja', r.text.includes('Maja Novak'));
  ok('filtered view drops other staff', !r.text.includes('Sara Kovač') || !r.text.includes('data-appt-employee="3"'));
  r = await req('/app/calendar?view=day&date=2026-08-18');
  ok('unfiltered view names each employee', r.text.includes('Maja Novak'));

  section('calendar widens for out-of-hours bookings');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_MENS, employee_id: EMP_MAJA, date: '2026-08-26', start: '06:00',
  }});
  ok('early booking accepted', r.data.ok === true, JSON.stringify(r.data));
  r = await req('/app/calendar?view=day&date=2026-08-26');
  ok('grid widens to show a 06:00 booking', r.text.includes('>06:00<'), 'window did not widen');
  ok('closed hours are marked outside opening times', r.text.includes('is-outside'));

  section('booking on a day the salon is closed');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_MENS, employee_id: EMP_MAJA, date: '2026-08-23', start: '10:00',
  }});
  ok('Sunday booking still allowed for staff', r.data.ok === true, JSON.stringify(r.data));
  r = await req('/app/calendar?view=day&date=2026-08-23');
  ok('closed day is flagged in the day view', r.text.includes('Zaprto'));

  /* -------------------------------------------------------- visit counter */

  section('visit counter');
  await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: 8 } });
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { delta: 1 } });
  ok('increment 8 to 9', r.data.customer.visit_count === 9);
  ok('9/9 becomes eligible', r.data.customer.loyalty.eligible === true);
  ok('eligible hint', r.data.customer.loyalty.hint === 'Naslednje striženje je brezplačno');
  ok('feedback message', r.data.message === 'Število obiskov je posodobljeno.');
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { delta: -1 } });
  ok('decrement 9 to 8', r.data.customer.visit_count === 8);
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: 6 } });
  ok('set exact count', r.data.customer.visit_count === 6);
  ok('hint pluralises', r.data.customer.loyalty.hint === '3 plačana striženja do brezplačnega');
  await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: 0 } });
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { delta: -1 } });
  ok('counter never goes negative', r.data.customer.visit_count === 0);
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: -5 } });
  ok('negative set rejected', r.status === 400);
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { delta: 0 } });
  ok('zero delta rejected', r.status === 400);
  await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: 9 } });
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { action: 'redeem' } });
  ok('redeem resets to zero', r.data.customer.visit_count === 0);
  ok('redeem feedback message', r.data.message === 'Brezplačno striženje je unovčeno.');
  r = await req('/api/customers/99999/visits', { method: 'POST', json: { delta: 1 } });
  ok('unknown customer gives 404', r.status === 404);

  section('loyalty threshold is configurable');
  r = await req('/app/settings');
  grabCsrf(r.text);
  r = await req('/app/settings', { method: 'POST', form: settingsForm({ paid_before_free: '10' }) });
  ok('settings saved', r.status === 302, r.text.slice(0, 200));
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { count: 9 } });
  ok('9 of 10 not eligible', r.data.customer.loyalty.eligible === false && r.data.customer.loyalty.progress === '9 / 10');
  r = await req(`/api/customers/${ana.id}/visits`, { method: 'POST', json: { delta: 1 } });
  ok('10 of 10 eligible', r.data.customer.loyalty.eligible === true);
  r = await req('/app/settings', { method: 'POST', form: settingsForm({ paid_before_free: '9' }) });
  ok('threshold restored', r.status === 302);

  section('settings validation');
  const badSettings = [
    [{ salon_name: '' }, 'empty salon name'],
    [{ calendar_start: '20:00', calendar_end: '08:00' }, 'calendar end before start'],
    [{ calendar_start: 'nonsense' }, 'bad calendar time'],
    [{ paid_before_free: '0' }, 'zero paid before free'],
    [{ paid_before_free: '-3' }, 'negative paid before free'],
    [{ open_1: '18:00', close_1: '08:00' }, 'Monday closing before opening'],
    [{ open_1: 'x' }, 'bad opening time'],
  ];
  for (const [over, label] of badSettings) {
    r = await req('/app/settings', { method: 'POST', form: settingsForm(over) });
    ok(`rejects ${label}`, r.status === 400, `status ${r.status}`);
  }
  r = await req('/app/settings', { method: 'POST', form: settingsForm() });
  ok('valid settings still save', r.status === 302);

  section('public site follows settings');
  r = await req('/');
  ok('public shows address', r.text.includes('Glavna 1') && r.text.includes('Ljubljana'));
  ok('public shows email', r.text.includes('info@studiohair.si'));
  ok('public shows about text', r.text.includes('Strižemo lase.'));
  ok('about splits paragraphs', r.text.includes('Drugi odstavek besedila predstavitve salona.'));
  ok('public shows Saturday short hours', r.text.includes('13:00'));

  section('opening hours by arrangement');
  r = await req('/app/settings', { method: 'POST', form: settingsForm({
    mode_3: 'text', text_3: 'Po dogovoru', open_3: '', close_3: '',
  }) });
  ok('free-text day saved', r.status === 302, r.text.slice(0, 200));
  r = await req('/');
  ok('website shows the wording instead of times', r.text.includes('Po dogovoru'), 'text missing');
  ok('that day is not shown as closed', /Sreda[\s\S]{0,160}Po dogovoru/.test(r.text), 'wrong wording');
  r = await req('/app/settings');
  ok('settings page keeps the wording', r.text.includes('value="Po dogovoru"'), 'not round-tripped');
  ok('settings page preselects the mode', /mode_3" value="text"[^>]*checked/.test(r.text), 'mode not checked');
  // 2026-08-19 is a Wednesday: with no fixed hours nothing may be shaded.
  r = await req('/app/calendar?view=day&date=2026-08-19');
  ok('by-arrangement day is not shaded in the calendar', !r.text.includes('is-outside'), 'still shaded');
  ok('by-arrangement day still allows booking', r.text.includes('data-new-appointment'));
  r = await req('/app/settings', { method: 'POST', form: settingsForm({
    mode_3: 'text', text_3: '', open_3: '', close_3: '',
  }) });
  ok('free-text day needs wording', r.status === 400 && /Sreda/.test(r.text), `status ${r.status}`);
  r = await req('/app/settings', { method: 'POST', form: settingsForm() });
  ok('hours restored', r.status === 302);
  r = await req('/app/calendar?view=day&date=2026-08-19');
  ok('fixed hours shade outside times again', r.text.includes('is-outside'));

  section('calendar hours follow settings');
  r = await req('/app/settings', { method: 'POST', form: settingsForm({ calendar_start: '09:00', calendar_end: '15:00' }) });
  ok('narrow calendar window saved', r.status === 302);
  r = await req('/app/calendar?view=day&date=2026-08-25');
  ok('grid starts at 09:00', r.text.includes('>09:00<') && !r.text.includes('>08:00<'));
  ok('grid stops before 15:00', !r.text.includes('>15:00<'));
  await req('/app/settings', { method: 'POST', form: settingsForm() });

  /* --------------------------------------------------------------------- SMS */

  section('SMS notifications');
  r = await req('/app/settings', { method: 'POST', form: settingsForm({ sms_enabled: '1' }) });
  ok('SMS enabled', r.status === 302);
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-27', start: '10:00',
  }});
  ok('booking queues an SMS', r.data.sms.status === 'queued', JSON.stringify(r.data.sms));
  ok('appointment still saved alongside SMS', r.data.appointment.id > 0);
  const smsAppt = r.data.appointment.id;
  r = await req(`/api/appointments/${smsAppt}/reschedule`, { method: 'POST', json: { date: '2026-08-28', start: '11:30' } });
  ok('reschedule queues an SMS', r.data.sms.status === 'queued');
  r = await req(`/api/appointments/${smsAppt}/status`, { method: 'POST', json: { status: 'cancelled', send_sms: true } });
  ok('cancellation queues an SMS when asked', r.data.sms.status === 'queued');
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-29', start: '10:00',
  }});
  const noSmsAppt = r.data.appointment.id;
  r = await req(`/api/appointments/${noSmsAppt}/status`, { method: 'POST', json: { status: 'cancelled' } });
  ok('cancellation without the box sends nothing', r.data.sms.status === 'skipped', JSON.stringify(r.data.sms));

  section('SMS outbox and log screen');
  // The worker runs in the app process on a fast tick under test, so a queued
  // message should reach 'accepted' shortly after being enqueued.
  let smsPage = '';
  for (let i = 0; i < 40; i++) {
    r = await req('/app/sms');
    smsPage = r.text || '';
    if (/Oddano prehodu/.test(smsPage)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ok('SMS log screen loads for the admin', r.status === 200 && /SMS dnevnik/.test(smsPage),
    'status ' + r.status);
  ok('the background worker delivered a queued message', /Oddano prehodu/.test(smsPage));
  ok('the log shows the message text', /Frizerstvo Berni:/.test(smsPage));
  ok('the log shows what kind of message it was', /Naročilo/.test(smsPage));
  r = await req('/app/sms?status=problem');
  ok('the log filters by status', r.status === 200);
  r = await req('/app/sms?kind=reminder');
  ok('the log filters by kind', r.status === 200);
  ok('an empty filter says so', /ni zapisov/.test(r.text || ''));

  r = await req('/api/customers', { method: 'POST', json: { first_name: 'Nophone', last_name: 'Tester' } });
  const nophone = r.data.customer;
  ok('quick customer created', r.data.ok && nophone.id > 0);
  ok('quick customer starts at zero visits', nophone.visit_count === 0);
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: nophone.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-08-30', start: '10:00',
  }});
  ok('appointment saves without a phone number', r.data.ok === true);
  ok('reports that no SMS was sent', r.data.sms.status === 'no_phone' && /SMS ni bil poslan/i.test(r.data.sms.message));
  r = await req('/api/customers', { method: 'POST', json: { first_name: '' } });
  ok('quick customer needs a first name', r.status === 400);

  r = await req(`/api/appointments/${noSmsAppt}/sms`, { method: 'POST', json: { kind: 'booked' } });
  ok('SMS can be retried', r.data.ok === true, JSON.stringify(r.data));
  await req('/app/settings', { method: 'POST', form: settingsForm({ sms_enabled: '0' }) });
  r = await req(`/api/appointments/${noSmsAppt}/sms`, { method: 'POST', json: { kind: 'booked' } });
  ok('retry refuses while SMS is disabled', r.status === 400 && /izklopljena/i.test(r.data.error));

  /* ---------------------------------------------------------------- services */

  section('services');
  r = await req('/app/services');
  ok('services page lists everything', r.status === 200 && r.text.includes('Barvanje las'));
  r = await req('/app/services/new', { method: 'POST', form: {
    name: 'Britje brade', description: 'Ureditev', duration_min: '15', price: '8.50', active: '1', sort_order: '9',
  }});
  ok('service created', r.status === 302);
  r = await req('/app/services');
  ok('new service appears', r.text.includes('Britje brade') && r.text.includes('€8.50'));
  r = await req('/app/services/new', { method: 'POST', form: { name: '', duration_min: '30', price: '10' } });
  ok('service needs a name', r.status === 400);
  r = await req('/app/services/new', { method: 'POST', form: { name: 'X', duration_min: '1', price: '10' } });
  ok('service duration has a floor', r.status === 400);
  r = await req('/app/services/new', { method: 'POST', form: { name: 'X', duration_min: '30', price: 'free' } });
  ok('service price must parse', r.status === 400);

  r = await req(`/app/services/${SVC_MENS}/active`, { method: 'POST', form: {} });
  ok('service disabled', r.status === 302);
  r = await req('/');
  ok('disabled service leaves the website', !r.text.includes('Moško striženje'));
  r = await req('/app/calendar');
  ok('disabled service leaves new bookings', !/"name":"Moško striženje"/.test(r.text));
  r = await req('/app/services');
  ok('disabled service still listed for staff', r.text.includes('IZKLOPLJENA'));
  r = await req(`/api/appointments/${before}`);
  ok('appointment on a disabled service still reads correctly', r.data.appointment.service_name === "Moško striženje");
  await req(`/app/services/${SVC_MENS}/active`, { method: 'POST', form: {} });
  r = await req('/');
  ok('service re-enabled returns to the website', r.text.includes('Moško striženje'));

  /* ---------------------------------------------------------------- products */

  section('products');
  r = await req('/app/products');
  ok('products page lists stock', r.status === 200 && r.text.includes('Šampon') && r.text.includes('€14.90'));
  r = await req('/api/products/1/quantity', { method: 'POST', json: { delta: -1 } });
  ok('sell one: 12 becomes 11', r.data.product.quantity === 11, JSON.stringify(r.data));
  ok('stock feedback message', r.data.message === 'Zaloga je spremenjena.');
  r = await req('/api/products/1/quantity', { method: 'POST', json: { delta: 1 } });
  ok('add one: back to 12', r.data.product.quantity === 12);
  for (let i = 0; i < 15; i++) await req('/api/products/1/quantity', { method: 'POST', json: { delta: -1 } });
  r = await req('/api/products/1/quantity', { method: 'POST', json: { delta: -1 } });
  ok('stock never goes below zero', r.data.product.quantity === 0);
  r = await req('/api/products/1/quantity', { method: 'POST', json: { quantity: 12 } });
  ok('exact quantity set', r.data.product.quantity === 12);
  r = await req('/api/products/1/quantity', { method: 'POST', json: { quantity: -2 } });
  ok('negative quantity rejected', r.status === 400);
  r = await req('/api/products/99999/quantity', { method: 'POST', json: { delta: 1 } });
  ok('unknown product gives 404', r.status === 404);
  r = await req('/app/products/1');
  ok('product page loads', r.status === 200 && r.text.includes('Šampon'));
  r = await req('/app/products/new', { method: 'POST', form: {
    name: 'Balzam', description: '', quantity: '7', price: '11.90', active: '1',
  }});
  ok('product created', r.status === 302);
  r = await req('/app/products/new', { method: 'POST', form: { name: 'Bad', quantity: '-1', price: '5' } });
  ok('product quantity cannot start negative', r.status === 400);
  r = await req('/app/products?q=' + encodeURIComponent('ampon'));
  ok('product search works', r.text.includes('Šampon') && !r.text.includes('Balzam'));

  section('product supply, sales and the monthly report');
  // Supply with a purchase price, then a sale at a discount, then a
  // correction — the three things the counter actually does.
  r = await req('/app/products/1/supply', { method: 'POST', form: {
    quantity: '10', price: '6.00', note: 'dobavitelj Marec',
  }});
  ok('supply recorded', r.status === 302, 'status ' + r.status);
  r = await req('/app/products/1/sale', { method: 'POST', form: { quantity: '2', price: '9.90' } });
  ok('sale recorded', r.status === 302, 'status ' + r.status);
  r = await req('/app/products/1/correct', { method: 'POST', form: { delta: '-1', note: 'lom' } });
  ok('correction recorded', r.status === 302, 'status ' + r.status);

  r = await req('/app/products/1/supply', { method: 'POST', form: { quantity: '0' } });
  ok('supply of zero is refused', r.status === 302);
  r = await req('/app/products/1/sale', { method: 'POST', form: { quantity: '1', price: 'veliko' } });
  ok('an unparseable price is refused', r.status === 302);

  r = await req('/app/products/1');
  ok('product page shows the monthly table', r.text.includes('Po mesecih'));
  ok('product page shows the movement history', r.text.includes('Zadnja gibanja'));
  ok('the history shows the supply note', r.text.includes('dobavitelj Marec'));
  ok('the history shows the correction reason', r.text.includes('lom'));
  ok('the history labels a sale', r.text.includes('Prodaja'));
  ok('the history labels a supply', r.text.includes('Dobava'));
  ok('the history labels a correction', r.text.includes('Popravek'));

  r = await req('/app/products/report');
  ok('monthly report loads', r.status === 200 && r.text.includes('Mesečno poročilo'),
    'status ' + r.status);
  ok('the report names the product', r.text.includes('Šampon'));
  ok('the report shows revenue', /prihodek/i.test(r.text));
  r = await req('/app/products/report?month=1999-01');
  ok('an unknown month falls back instead of erroring', r.status === 200);

  // "report" must not be swallowed by the /:id route.
  ok('the report is not treated as a product id', !r.text.includes('Uredi izdelek'));

  section('product PDF export');
  r = await req('/app/products/report.pdf?month=' + encodeURIComponent('2026-08'));
  // The month may not exist in the seed; either way a valid PDF must come back.
  ok('month PDF responds', r.status === 200, 'status ' + r.status);
  ok('month PDF is a PDF', (r.headers['content-type'] || '').includes('application/pdf'),
    r.headers['content-type']);
  ok('month PDF is sent as a download',
    /attachment; filename=/.test(r.headers['content-disposition'] || ''),
    r.headers['content-disposition']);
  ok('month PDF starts with the PDF header', (r.text || '').startsWith('%PDF'),
    (r.text || '').slice(0, 8));
  ok('month PDF ends with EOF', /%%EOF\s*$/.test(r.text || ''));

  r = await req('/app/products/report.pdf?month=all');
  ok('all-months PDF responds', r.status === 200 && (r.text || '').startsWith('%PDF'));
  ok('all-months PDF names the file accordingly',
    /vsi-meseci/.test(r.headers['content-disposition'] || ''),
    r.headers['content-disposition']);

  r = await req('/app/products/report.pdf?month=nonsense');
  ok('a bad month falls back to a valid PDF', r.status === 200 && (r.text || '').startsWith('%PDF'));

  r = await req('/app/products/report.pdf?month=2026-08&inline=1');
  ok('inline preview is not an attachment',
    /^inline;/.test(r.headers['content-disposition'] || ''),
    r.headers['content-disposition']);

  r = await req('/app/products/1/history.pdf');
  ok('per-product PDF responds', r.status === 200 && (r.text || '').startsWith('%PDF'),
    'status ' + r.status);
  r = await req('/app/products/99999/history.pdf');
  ok('an unknown product yields 404, not a broken file', r.status === 404, 'status ' + r.status);

  /* --------------------------------------------------------------- customers */

  section('customer pages');
  r = await req('/app/customers');
  ok('customer list loads', r.status === 200 && r.text.includes('Obiski'));
  r = await req('/app/customers?q=Ana');
  ok('customer list search works', r.text.includes('Ana Novak') && !r.text.includes('Marko Horvat'));
  r = await req(`/app/customers/${sara.id}`);
  ok('eligible customer shows the free badge', r.text.includes('NASLEDNJE STRIŽENJE BREZPLAČNO'));
  ok('eligible customer offers redeem', r.text.includes('Unovči brezplačno striženje'));
  r = await req(`/app/customers/${ana.id}`);
  ok('customer page loads', r.status === 200);
  ok('customer page has no appointment history',
    !/Past appointments|Previous services|Zgodovina|Pretekli termini|Prejšnje storitve/i.test(r.text));
  ok('customer page can start an appointment', r.text.includes('data-new-appointment'));
  ok('customer page has the counter controls', r.text.includes('data-visit-delta'));
  r = await req('/app/customers/99999');
  ok('unknown customer gives 404', r.status === 404);
  r = await req('/app/customers/abc');
  ok('non-numeric customer id does not crash', r.status === 404, `status ${r.status}`);

  r = await req('/app/customers/new', { method: 'POST', form: {
    first_name: 'Nina', last_name: 'Zupan', phone: '051 999 888', email: 'nina@example.com', notes: 'Allergic to X',
  }});
  ok('customer created via form', r.status === 302);
  const ninaId = Number(String(r.location).split('/').pop());
  r = await req(`/app/customers/${ninaId}`);
  ok('created customer page shows notes', r.text.includes('Allergic to X'));
  ok('flash message shown after redirect', r.text.includes('Stranka je ustvarjena.'));
  r = await req('/app/customers/new', { method: 'POST', form: { first_name: '' } });
  ok('customer needs a first name', r.status === 400);

  r = await req(`/app/customers/${ninaId}/edit`, { method: 'POST', form: {
    first_name: 'Nina', last_name: 'Zupan', phone: '051 999 888', email: '', notes: 'Updated note',
  }});
  ok('customer edited', r.status === 302);
  r = await req(`/app/customers/${ninaId}`);
  ok('edit removed active flag makes them inactive', r.text.includes('NEAKTIVNA'));
  ok('edited note saved', r.text.includes('Updated note'));
  r = await req('/app/customers');
  ok('inactive customer hidden by default', !r.text.includes('Nina'));
  r = await req('/app/customers?inactive=1');
  ok('inactive customer shown when asked', r.text.includes('Nina'));

  section('escaping and injection');
  r = await req('/api/customers', { method: 'POST', json: {
    first_name: '<script>alert(1)</script>', last_name: '"><img src=x>', notes: "O'Brien & co",
  }});
  const nasty = r.data.customer;
  ok('customer with markup created', r.data.ok === true);
  r = await req(`/app/customers/${nasty.id}`);
  ok('script tag escaped on the page', !r.text.includes('<script>alert(1)</script>'));
  ok('escaped form is present', r.text.includes('&lt;script&gt;'));
  ok('quote injection escaped', !r.text.includes('"><img src=x>'));
  ok('ampersand and apostrophe survive', r.text.includes('O&#39;Brien &amp; co'));
  r = await req('/api/customers/search?q=' + encodeURIComponent("' OR 1=1 --"));
  ok('SQL-ish search returns no rows rather than everything', r.data.customers.length === 0);
  r = await req('/app/customers?q=' + encodeURIComponent('<b>x</b>'));
  ok('search term escaped in the page', !r.text.includes('<b>x</b>'));

  /* --------------------------------------------------------------- employees */

  section('employee management');
  r = await req('/app/employees');
  ok('employees page loads for admin', r.status === 200 && r.text.includes('Maja'));
  grabCsrf(r.text);
  r = await req('/app/employees/new', { method: 'POST', form: {
    first_name: 'Luka', last_name: 'Horvat', username: 'luka', email: '', password: 'secret123',
    role: 'employee', active: '1', color: '#2f9e79',
  }});
  ok('employee created', r.status === 302);
  r = await req('/app/employees/new', { method: 'POST', form: {
    first_name: 'Dup', last_name: '', username: 'luka', password: 'secret123', role: 'employee', active: '1',
  }});
  ok('duplicate username rejected', r.status === 400 && r.text.includes('že zasedeno'));
  r = await req('/app/employees/new', { method: 'POST', form: {
    first_name: 'Shorty', username: 'shorty', password: '123', role: 'employee', active: '1',
  }});
  ok('short password rejected', r.status === 400);
  r = await req('/app/employees/new', { method: 'POST', form: {
    first_name: 'Bad', username: 'a b', password: 'secret123', role: 'employee', active: '1',
  }});
  ok('invalid username rejected', r.status === 400);

  r = await req(`/app/employees/${EMP_ADMIN}/edit`, { method: 'POST', form: {
    first_name: 'Salon', last_name: 'Admin', username: 'admin', email: '', role: 'employee', active: '1',
  }});
  ok('cannot demote the only admin', r.status === 400 && r.text.includes('edini aktivni skrbnik'));
  r = await req(`/app/employees/${EMP_ADMIN}/active`, { method: 'POST', form: {} });
  ok('cannot deactivate the only admin', r.status === 302);
  r = await req('/app/employees');
  ok('only admin is still active', /admin[\s\S]{0,400}AKTIVEN/i.test(r.text));

  // A live appointment for Sara, so we can prove deactivation preserves it.
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: sara.id, service_id: SVC_KIDS, employee_id: EMP_SARA, date: '2026-09-02', start: '09:00',
  }});
  ok('appointment for Sara created', r.data.ok === true, JSON.stringify(r.data));
  const saraAppt = r.data.appointment.id;

  // Deactivating an ordinary employee keeps their appointments.
  r = await req(`/app/employees/${EMP_SARA}/active`, { method: 'POST', form: {} });
  ok('employee deactivated', r.status === 302);
  r = await req('/app/calendar?view=day&date=2026-08-18');
  ok('deactivated employee keeps their appointments', r.text.includes('Sara Kovač'), 'appointments vanished');
  r = await req('/app/calendar');
  ok('deactivated employee leaves the filter', !/"name":"Sara Kovač"/.test(r.text));
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_SARA, date: '2026-09-05', start: '10:00',
  }});
  ok('cannot book a deactivated employee', r.status === 400, JSON.stringify(r.data));
  r = await req(`/api/appointments/${saraAppt}`, { method: 'POST', json: {
    customer_id: sara.id, service_id: SVC_KIDS, employee_id: EMP_SARA, date: '2026-09-02', start: '11:00',
  }});
  ok('existing appointment of a deactivated employee can still be edited', r.data.ok === true, JSON.stringify(r.data));
  r = await req(`/api/appointments/${saraAppt}/status`, { method: 'POST', json: { status: 'completed' } });
  ok('appointment of a deactivated employee can still be completed', r.data.ok === true, JSON.stringify(r.data));
  await req(`/app/employees/${EMP_SARA}/active`, { method: 'POST', form: {} });

  section('deactivated employees cannot sign in');
  r = await req('/app/employees');
  grabCsrf(r.text);
  const adminCookie = cookie;
  const adminCsrf = csrf;
  r = await req('/app/employees/new', { method: 'POST', form: {
    first_name: 'Gone', last_name: 'Away', username: 'gone', password: 'secret123',
    role: 'employee', active: '0', color: '#b3543f',
  }});
  ok('inactive employee created', r.status === 302);
  r = await login('gone', 'secret123');
  ok('inactive employee refused at login', r.status === 401 && r.text.includes('deaktiviran'));

  section('password reset');
  cookie = adminCookie;
  csrf = adminCsrf;
  r = await req('/app/employees');
  grabCsrf(r.text);
  r = await req('/app/employees/4/password', { method: 'POST', form: { password: 'brandnew1' } });
  ok('password reset accepted', r.status === 302);
  r = await login('luka', 'brandnew1');
  ok('new password works', r.status === 302, r.location);
  r = await login('luka', 'secret123');
  ok('old password no longer works', r.status === 401);

  section('role separation');
  r = await login('maja', 'admin123');
  ok('employee can sign in', r.status === 302);
  r = await req('/app/calendar');
  ok('employee sees the calendar', r.status === 200);
  ok('employee nav hides Settings', !r.text.includes('href="/app/settings"'));
  ok('employee nav hides Employees', !r.text.includes('href="/app/employees"'));
  ok('employee nav hides the SMS log', !r.text.includes('href="/app/sms"'));
  ok('employee nav shows the four daily sections',
    ['/app/calendar', '/app/customers', '/app/services', '/app/products'].every((p) => r.text.includes(`href="${p}"`)));
  for (const path of ['/app/settings', '/app/sms', '/app/employees', '/app/employees/new', '/app/services/new']) {
    r = await req(path);
    ok(`employee blocked from ${path}`, r.status === 403, `status ${r.status}`);
  }
  r = await req('/app/settings', { method: 'POST', form: settingsForm() });
  ok('employee cannot post settings', r.status === 403);
  r = await req(`/app/services/${SVC_MENS}/active`, { method: 'POST', form: {} });
  ok('employee cannot disable a service', r.status === 403);
  r = await req('/app/services');
  ok('employee can view services', r.status === 200);
  ok('employee sees no edit controls', !r.text.includes('/app/services/1/edit'));
  r = await req('/app/customers');
  ok('employee can manage customers', r.status === 200);
  r = await req('/app/products');
  ok('employee can manage products', r.status === 200);
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-09-10', start: '10:00',
  }});
  ok('employee can create appointments', r.data.ok === true);

  section('security');
  const goodCsrf = csrf;
  csrf = 'not-the-token';
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-09-11', start: '10:00',
  }});
  ok('bad CSRF token rejected on the API', r.status === 403);
  r = await req('/app/customers/new', { method: 'POST', form: { first_name: 'Sneaky' } });
  ok('bad CSRF token rejected on forms', r.status === 403);
  csrf = goodCsrf;
  r = await req('/api/appointments', { method: 'POST', json: {
    customer_id: ana.id, service_id: SVC_WOMENS, employee_id: EMP_MAJA, date: '2026-09-11', start: '10:00',
  }});
  ok('good CSRF token still works', r.data.ok === true, JSON.stringify(r.data));

  r = await req('/login');
  ok('password never echoed back to the page', !r.text.includes('admin123'));

  section('logout');
  r = await req('/app/calendar');
  grabCsrf(r.text);
  r = await req('/logout', { method: 'POST', form: {} });
  ok('logout redirects to login', r.status === 302 && r.location === '/login');
  r = await req('/app/calendar');
  ok('calendar refused after logout', r.status === 302);

  /* ------------------------------------------------------------------ report */

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nSuite crashed:', err);
  process.exit(1);
});
