/**
 * Client-side test suite for public/js/app.js.
 *
 * The HTTP suite (npm test) cannot reach the browser code, so this file builds a
 * synthetic staff DOM, stubs window.fetch with scripted responses, loads app.js
 * and drives the real event handlers.
 *
 * HOW TO RUN
 *   1. npm start
 *   2. Open http://localhost:3000/ and open DevTools (F12) -> Console
 *   3. Paste the whole contents of this file and press Enter
 *   4. Results print as a table; every row should say "ok"
 *
 * It runs on the public page on purpose: no login is needed, because every
 * network call is stubbed.
 *
 * Note: successful saves in app.js call window.location.reload(), which would
 * end the run, so the save paths are asserted through the request payload and
 * the failure branch instead.
 */
(async function () {
  'use strict';

  const R = [];
  const ok = (name, cond, detail) =>
    R.push({ result: cond ? 'ok' : 'FAIL', test: name, detail: cond ? '' : String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------- harness */

  const T = { calls: [], next: null };
  window.__T = T;

  function buildDom(html) {
    document.body.innerHTML = `
      <div id="toasts" class="toasts"></div>
      ${html}
      <div id="modal-root" class="modal-root" hidden>
        <div class="modal-backdrop" data-modal-close></div>
        <div class="modal-window"><div id="modal-content"></div></div>
      </div>`;
  }

  function installData(data) {
    const old = document.getElementById('salon-data');
    if (old) old.remove();
    const el = document.createElement('script');
    el.id = 'salon-data';
    el.type = 'application/json';
    el.textContent = JSON.stringify(data);
    document.body.appendChild(el);
    window.CSRF_TOKEN = 'test-token';
  }

  const ANA = {
    id: 4, name: 'Ana Novak', phone: '031 123 456', visit_count: 8,
    loyalty: { count: 8, required: 9, eligible: false, progress: '8 / 9',
               hint: '1 paid haircut until free', percent: 89 },
  };
  const FREE = {
    id: 8, name: 'Sara Kovac', phone: '040 222 333', visit_count: 9,
    loyalty: { count: 9, required: 9, eligible: true, progress: '9 / 9',
               hint: 'Next haircut is free', percent: 100 },
  };
  const EVIL = {
    id: 9, name: '<script>alert(1)</script>', phone: '', visit_count: 0,
    loyalty: { count: 0, required: 9, eligible: false, progress: '0 / 9',
               hint: '9 paid haircuts until free', percent: 0 },
  };

  function respond(url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    T.calls.push({
      url, method: (opts && opts.method) || 'GET', body,
      csrf: opts && opts.headers && opts.headers['X-CSRF-Token'],
    });
    if (T.next) { const n = T.next; T.next = null; return n; }
    if (url.includes('/api/customers/search')) {
      const q = decodeURIComponent(url.split('q=')[1] || '');
      if (q === 'zzz') return { ok: true, customers: [] };
      if (q === 'free') return { ok: true, customers: [FREE] };
      if (q === 'evil') return { ok: true, customers: [EVIL] };
      return { ok: true, customers: [ANA] };
    }
    if (/\/api\/customers\/\d+$/.test(url)) return { ok: true, customer: ANA };
    if (url.includes('/visits')) return { ok: true, message: 'Visit count updated.',
      customer: { id: 5, visit_count: 4, loyalty: { count: 4, required: 9, eligible: false,
        progress: '4 / 9', hint: '5 paid haircuts until free', percent: 44 } } };
    if (url.includes('/quantity')) return { ok: true, message: 'Stock changed.',
      product: { id: 9, quantity: 11 } };
    if (url.includes('/panel')) return { ok: true, appointment: { id: 77 },
      html: '<div class="panel"><h2 id="modal-title">Ana Novak</h2></div>' };
    if (url === '/api/customers') return { ok: true, message: 'Customer created.',
      customer: { id: 12, name: 'Nina Zupan', phone: '051 999 888', visit_count: 0,
        loyalty: { count: 0, required: 9, eligible: false, progress: '0 / 9',
                   hint: '9 paid haircuts until free', percent: 0 } } };
    if (url === '/api/appointments/77') return { ok: true, appointment: {
      id: 77, customer_id: 4, customer_name: 'Ana Novak', customer_phone: '031 123 456',
      customer_visits: 8, employee_id: 99, employee_name: 'Luka Horvat',
      service_id: 1, service_name: "Women's haircut", date: '2026-08-18',
      start_time: '10:00', end_time: '10:45', duration_min: 45, price_cents: 2500,
      notes: '', status: 'scheduled', date_display: '18.08.2026' } };
    return { ok: false, error: 'unstubbed: ' + url };
  }

  window.fetch = (url, opts) => {
    const p = respond(url, opts);
    return Promise.resolve({
      status: p.ok ? 200 : (p.__status || 400),
      json: () => Promise.resolve(JSON.parse(JSON.stringify(p))),
      text: () => Promise.resolve(JSON.stringify(p)),
    });
  };

  function loadApp() {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/js/app.js?t=' + Date.now();
      s.onload = res;
      s.onerror = rej;
      document.body.appendChild(s);
    });
  }

  const mc = () => document.getElementById('modal-content');
  const root = () => document.getElementById('modal-root');
  const form = () => mc().querySelector('[data-appt-form]');
  const fld = (n) =>
    form().querySelector(`input[data-${n}], textarea[data-${n}]`);

  /* ------------------------------------------- part 1: appointment form */

  buildDom(`
    <button id="newBtn" data-new-appointment data-date="2026-08-18" data-start="10:30">new</button>
    <button id="openBtn" data-appointment="77">open</button>
    <div id="visits" data-customer="5">
      <p class="visit-count" data-visit-badge>3 / 9</p>
      <div class="progress"><div class="progress-bar" data-visit-bar style="width:33%"></div></div>
      <p class="visit-hint" data-visit-hint>6 paid haircuts until free</p>
      <output class="counter-value" data-visit-value>3</output>
      <button id="visitUp" data-visit-delta="1">+</button>
    </div>
    <div data-product="9">
      <output data-stock-value="9">12</output>
      <button id="stockDown" data-stock-delta="-1" data-id="9">-</button>
    </div>`);
  installData({
    services: [
      { id: 1, name: "Women's haircut", duration_min: 45, price_cents: 2500, price: '25.00' },
      { id: 3, name: 'Hair coloring', duration_min: 90, price_cents: 5500, price: '55.00' },
    ],
    employees: [{ id: 2, name: 'Maja Novak', color: '#4f6df5' },
                { id: 3, name: 'Sara Kovac', color: '#e0709a' }],
    defaultEmployeeId: 2, paidBeforeFree: 9, today: '2026-08-13', smsEnabled: true,
  });
  await loadApp();

  document.getElementById('newBtn').click();
  await wait(60);
  ok('modal opens from a calendar slot', root().hidden === false, 'hidden');
  ok('appointment form rendered', !!form(), 'missing');
  ok('date prefilled from the slot', fld('date').value === '2026-08-18', fld('date').value);
  ok('start prefilled from the slot', fld('start').value === '10:30', fld('start').value);
  ok('employee defaults to filter/current user', form().querySelector('[data-employee]').value === '2',
    form().querySelector('[data-employee]').value);
  ok('service list shows duration and price',
    form().querySelector('[data-service]').innerHTML.includes('45 min'), 'missing');

  const svc = form().querySelector('[data-service]');
  svc.value = '1';
  svc.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(30);
  ok('service fills the duration', fld('duration').value === '45', fld('duration').value);
  ok('service fills the price', fld('price').value === '25.00', fld('price').value);
  ok('service option value not corrupted', svc.value === '1', svc.value);
  ok('readout shows the end time', form().querySelector('[data-out-end]').textContent === '11:15',
    form().querySelector('[data-out-end]').textContent);
  ok('readout shows the duration', form().querySelector('[data-out-duration]').textContent === '45 min',
    form().querySelector('[data-out-duration]').textContent);
  ok('readout shows the price', form().querySelector('[data-out-price]').textContent === '€25.00',
    form().querySelector('[data-out-price]').textContent);

  svc.value = '3';
  svc.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(30);
  ok('switching service updates duration', fld('duration').value === '90', fld('duration').value);
  ok('switching service updates end time', form().querySelector('[data-out-end]').textContent === '12:00',
    form().querySelector('[data-out-end]').textContent);
  svc.value = '1';
  svc.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(20);

  fld('duration').value = '30';
  fld('duration').dispatchEvent(new Event('input', { bubbles: true }));
  await wait(20);
  ok('manual duration recalculates the end', form().querySelector('[data-out-end]').textContent === '11:00',
    form().querySelector('[data-out-end]').textContent);
  fld('price').value = '19,50';
  fld('price').dispatchEvent(new Event('input', { bubbles: true }));
  await wait(20);
  ok('comma decimals accepted', form().querySelector('[data-out-price]').textContent === '€19.50',
    form().querySelector('[data-out-price]').textContent);
  fld('duration').value = '45';
  fld('price').value = '25.00';

  /* ----------------------------------------------- part 2: customer search */

  let inp = mc().querySelector('[data-customer-input]');
  inp.value = 'Ana';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(350);
  ok('search returns a result', mc().querySelectorAll('[data-pick-customer]').length === 1,
    mc().querySelectorAll('[data-pick-customer]').length);
  ok('search calls the right endpoint',
    T.calls.some((c) => c.url.includes('/api/customers/search?q=Ana')), 'no call');
  ok('result shows the phone number', mc().innerHTML.includes('031 123 456'), 'missing');
  ok('result shows visit progress', mc().innerHTML.includes('8 / 9'), 'missing');
  ok('create-new offered next to results', !!mc().querySelector('[data-create-customer]'), 'missing');

  mc().querySelector('[data-pick-customer]').click();
  await wait(60);
  ok('selected customer recorded', form().querySelector('[data-customer-id]').value === '4',
    form().querySelector('[data-customer-id]').value);
  ok('summary shows the name', mc().innerHTML.includes('Ana Novak'), 'missing');
  ok('summary shows the loyalty hint', mc().innerHTML.includes('1 paid haircut until free'), 'missing');
  ok('search input replaced by the summary', !mc().querySelector('[data-customer-input]'), 'still present');

  /* --------------------------------------------------- part 3: saving */

  T.calls = [];
  T.next = { ok: false, __status: 409, conflict: true,
    error: 'Maja Novak already has an appointment from 10:00 to 10:45. Please choose another time.' };
  form().querySelector('[data-submit]').click();
  await wait(150);
  const post = T.calls.find((c) => c.url === '/api/appointments');
  ok('save posts to /api/appointments', !!post, 'no request');
  ok('payload has the customer', post && post.body.customer_id === '4', post && post.body.customer_id);
  ok('payload has the service', post && post.body.service_id === '1', post && post.body.service_id);
  ok('payload has the employee', post && post.body.employee_id === '2', post && post.body.employee_id);
  ok('payload has the date', post && post.body.date === '2026-08-18', post && post.body.date);
  ok('payload has the start time', post && post.body.start === '10:30', post && post.body.start);
  ok('payload has the duration', post && post.body.duration_min === '45', post && post.body.duration_min);
  ok('payload has the price', post && post.body.price === '25.00', post && post.body.price);
  ok('CSRF header sent', post && post.csrf === 'test-token', post && post.csrf);

  const err = mc().querySelector('[data-form-error]');
  ok('conflict message shown in the form',
    err && !err.hidden && err.textContent.includes('already has an appointment from 10:00 to 10:45'),
    err && err.textContent);
  ok('modal stays open on conflict', root().hidden === false, 'closed');
  ok('save button re-enabled after failure', form().querySelector('[data-submit]').disabled === false,
    'still disabled');

  mc().querySelector('[data-clear-customer]').click();
  await wait(50);
  ok('Change restores the search input', !!mc().querySelector('[data-customer-input]'), 'missing');
  T.calls = [];
  form().querySelector('[data-submit]').click();
  await wait(80);
  ok('refuses to save without a customer',
    mc().querySelector('[data-form-error]').textContent.includes('Choose a customer'),
    mc().querySelector('[data-form-error]').textContent);
  ok('no request sent when invalid', !T.calls.some((c) => c.url === '/api/appointments'), 'sent anyway');

  /* ------------------------------------- part 4: empty results, escaping */

  inp = mc().querySelector('[data-customer-input]');
  inp.value = 'zzz';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(350);
  ok('shows "No customer found"', mc().innerHTML.includes('No customer found'), 'missing');

  inp.value = 'free';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(350);
  ok('eligible customer flagged in results', mc().innerHTML.includes('FREE NEXT'), 'missing');
  mc().querySelector('[data-pick-customer]').click();
  await wait(60);
  ok('eligible summary says NEXT HAIRCUT FREE', mc().innerHTML.includes('NEXT HAIRCUT FREE'), 'missing');
  ok('eligible summary is highlighted', !!mc().querySelector('.cust-chosen.is-free'), 'no class');

  mc().querySelector('[data-clear-customer]').click();
  await wait(40);
  inp = mc().querySelector('[data-customer-input]');
  inp.value = 'evil';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(350);
  ok('markup in a name is not executed', mc().querySelectorAll('script').length === 0, 'script injected');
  ok('markup shown as escaped text', mc().innerHTML.includes('&lt;script&gt;'), 'not escaped');

  /* ---------------------------- part 5: quick customer keeps the form */

  fld('date').value = '2026-09-15';
  fld('start').value = '14:15';
  form().querySelector('[data-service]').value = '3';
  form().querySelector('[data-service]').dispatchEvent(new Event('change', { bubbles: true }));
  await wait(40);
  fld('notes').value = 'Wants a fringe';
  mc().querySelector('[data-create-customer]').click();
  await wait(60);
  let qc = mc().querySelector('[data-quick-customer]');
  ok('quick customer form opens', !!qc, 'missing');
  ok('typed text becomes the first name', qc.querySelector('[data-first]').value === 'evil',
    qc.querySelector('[data-first]').value);

  qc.querySelector('[data-first]').value = '';
  qc.querySelector('[data-submit]').click();
  await wait(80);
  ok('quick customer needs a first name',
    mc().querySelector('[data-form-error]').textContent.includes('first name'),
    mc().querySelector('[data-form-error]').textContent);

  qc = mc().querySelector('[data-quick-customer]');
  qc.querySelector('[data-first]').value = 'Nina';
  qc.querySelector('[data-last]').value = 'Zupan';
  qc.querySelector('[data-phone]').value = '051 999 888';
  T.calls = [];
  qc.querySelector('[data-submit]').click();
  await wait(200);
  const made = T.calls.find((c) => c.url === '/api/customers');
  ok('quick create posts to /api/customers', !!made, 'no call');
  ok('quick create sends the fields',
    made && made.body.first_name === 'Nina' && made.body.phone === '051 999 888',
    JSON.stringify(made && made.body));
  ok('returns to the appointment form', !!form(), 'not back');
  ok('new customer auto-selected', form().querySelector('[data-customer-id]').value === '12',
    form().querySelector('[data-customer-id]').value);
  ok('date survived the detour', fld('date').value === '2026-09-15', fld('date').value);
  ok('start survived the detour', fld('start').value === '14:15', fld('start').value);
  ok('service survived the detour', form().querySelector('[data-service]').value === '3',
    form().querySelector('[data-service]').value);
  ok('notes survived the detour', fld('notes').value === 'Wants a fringe', fld('notes').value);

  /* ------------------------------------------------ part 6: modal, panel */

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(60);
  ok('Escape closes the modal', root().hidden === true, 'still open');
  ok('modal content cleared on close', mc().innerHTML === '', 'left behind');
  ok('page scrolling restored', document.body.style.overflow === '', document.body.style.overflow);

  document.getElementById('newBtn').click();
  await wait(50);
  document.querySelector('.modal-backdrop').click();
  await wait(50);
  ok('backdrop click closes the modal', root().hidden === true, 'still open');

  T.calls = [];
  document.getElementById('openBtn').click();
  await wait(200);
  ok('clicking an appointment fetches its panel',
    T.calls.some((c) => c.url === '/api/appointments/77/panel'), JSON.stringify(T.calls));
  ok('panel HTML injected', mc().innerHTML.includes('Ana Novak'), 'missing');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(50);

  /* ------------------------------------------------- part 7: counters */

  T.calls = [];
  const card = document.getElementById('visits');
  document.getElementById('visitUp').click();
  await wait(250);
  const vc = T.calls.find((c) => c.url.includes('/visits'));
  ok('counter posts a delta', vc && vc.body.delta === 1, JSON.stringify(vc && vc.body));
  ok('counter targets the right customer', vc && vc.url === '/api/customers/5/visits', vc && vc.url);
  ok('displayed count updates', card.querySelector('[data-visit-value]').textContent === '4',
    card.querySelector('[data-visit-value]').textContent);
  ok('progress text updates', card.querySelector('[data-visit-badge]').textContent === '4 / 9',
    card.querySelector('[data-visit-badge]').textContent);
  ok('hint updates', card.querySelector('[data-visit-hint]').textContent === '5 paid haircuts until free',
    card.querySelector('[data-visit-hint]').textContent);
  ok('progress bar updates', card.querySelector('[data-visit-bar]').style.width === '44%',
    card.querySelector('[data-visit-bar]').style.width);
  ok('a toast confirms the change', document.querySelectorAll('#toasts .toast').length >= 1, 'none');
  ok('counter button re-enabled', document.getElementById('visitUp').disabled === false, 'disabled');

  T.calls = [];
  document.getElementById('stockDown').click();
  await wait(250);
  const sc = T.calls.find((c) => c.url.includes('/quantity'));
  ok('stock posts a delta', sc && sc.body.delta === -1, JSON.stringify(sc && sc.body));
  ok('stock targets the right product', sc && sc.url === '/api/products/9/quantity', sc && sc.url);
  ok('displayed stock updates 12 -> 11',
    document.querySelector('[data-stock-value="9"]').textContent === '11',
    document.querySelector('[data-stock-value="9"]').textContent);

  document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
  T.next = { ok: false, error: 'Stock could not be changed.' };
  document.getElementById('stockDown').click();
  await wait(250);
  const toastText = Array.from(document.querySelectorAll('#toasts .toast'))
    .map((t) => t.className + '|' + t.textContent);
  ok('failure raises an error toast', toastText.some((t) => t.includes('is-error')),
    JSON.stringify(toastText));
  ok('failure message shown to the user',
    toastText.some((t) => t.includes('Stock could not be changed.')), JSON.stringify(toastText));
  ok('stock unchanged after a failure',
    document.querySelector('[data-stock-value="9"]').textContent === '11',
    document.querySelector('[data-stock-value="9"]').textContent);

  /* ------------------------------- part 8: drag-and-drop and edit form */

  // Append rather than rebuild: app.js caches #modal-root and #modal-content at
  // load time, so replacing document.body would orphan those references. (The
  // real pages never replace their body, so this only matters to the harness.)
  document.getElementById('newBtn').remove();
  document.getElementById('openBtn').remove();
  root().insertAdjacentHTML('beforebegin', `
    <div class="cal-col" data-date="2026-08-18">
      <button class="cal-slot" id="sameSlot" data-new-appointment data-date="2026-08-18" data-start="10:00"></button>
      <div class="cal-appts">
        <button class="appt" data-appointment="77" draggable="true"
                data-appt-date="2026-08-18" data-appt-start="600"
                data-appt-employee="2" data-appt-customer="Ana Novak">appt</button>
      </div>
    </div>
    <div class="cal-col" data-date="2026-08-19">
      <button class="cal-slot" id="target" data-new-appointment data-date="2026-08-19" data-start="11:30"></button>
    </div>
    <button id="editBtn" data-appt-edit="77">edit</button>`);

  const appt = document.querySelector('.appt');
  const target = document.getElementById('target');
  T.calls = [];
  appt.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  ok('drag marks the appointment', appt.classList.contains('is-dragging'), 'no class');
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  await wait(80);
  ok('drop asks to confirm first', root().hidden === false, 'no dialog');
  ok('confirmation names the customer', mc().innerHTML.includes('Ana Novak'), 'missing');
  ok('confirmation shows the old time', mc().innerHTML.includes('18.08.2026 10:00'), 'missing');
  ok('confirmation shows the new time', mc().innerHTML.includes('19.08.2026 11:30'), 'missing');
  ok('nothing saved before confirming', T.calls.length === 0, JSON.stringify(T.calls));

  T.next = { ok: false, __status: 409,
    error: 'Maja Novak already has an appointment from 11:30 to 12:15. Please choose another time.' };
  mc().querySelector('[data-confirm-move]').click();
  await wait(150);
  const mv = T.calls.find((c) => c.url.includes('/reschedule'));
  ok('confirm posts the reschedule', !!mv, JSON.stringify(T.calls));
  ok('reschedule targets the appointment', mv && mv.url === '/api/appointments/77/reschedule', mv && mv.url);
  ok('reschedule sends the new date', mv && mv.body.date === '2026-08-19', JSON.stringify(mv && mv.body));
  ok('reschedule sends the new start', mv && mv.body.start === '11:30', JSON.stringify(mv && mv.body));
  ok('conflict shown in the move dialog',
    mc().querySelector('[data-form-error]').textContent.includes('already has an appointment'),
    mc().querySelector('[data-form-error]').textContent);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(40);
  T.calls = [];
  appt.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  const same = document.getElementById('sameSlot');
  same.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  same.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  await wait(80);
  ok('dropping on the original time does nothing',
    root().hidden === true && T.calls.length === 0, 'modal ' + root().hidden);
  appt.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));

  document.getElementById('editBtn').click();
  await wait(150);
  const sel = mc().querySelector('[data-employee]');
  ok('edit form opens', !!form(), 'missing');
  ok('deactivated employee still listed', !!sel && !!sel.querySelector('option[value="99"]'),
    sel && sel.innerHTML);
  ok('deactivated employee stays selected', sel && sel.value === '99', sel && sel.value);
  ok('deactivated employee is labelled inactive', sel && sel.innerHTML.includes('inactive'),
    sel && sel.innerHTML);
  ok('edit prefills the service', mc().querySelector('[data-service]').value === '1',
    mc().querySelector('[data-service]').value);
  ok('edit prefills the price', mc().querySelector('input[data-price]').value === '25.00',
    mc().querySelector('input[data-price]').value);
  ok('edit prefills the customer', mc().querySelector('[data-customer-id]').value === '4',
    mc().querySelector('[data-customer-id]').value);

  /* ------------------------------------------------------------ report */

  const failed = R.filter((r) => r.result === 'FAIL');
  console.table(R);
  console.log(`${R.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) console.warn('Failures:', failed);
  console.log('Reload the page to restore it.');
  return { passed: R.length - failed.length, failed: failed.length };
})();
