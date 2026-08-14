/* Staff area interactions: appointment modals, counters, drag-and-drop. */
(function () {
  'use strict';

  var DATA = (function () {
    var el = document.getElementById('salon-data');
    if (!el) return { services: [], employees: [], paidBeforeFree: 9 };
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      return { services: [], employees: [], paidBeforeFree: 9 };
    }
  })();

  /* ------------------------------------------------------------- utilities */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function parseTime(value) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function formatTime(minutes) {
    var total = Math.max(0, Math.round(Number(minutes) || 0));
    return pad(Math.floor(total / 60) % 24) + ':' + pad(total % 60);
  }

  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
  }

  function money(cents) {
    return '€' + ((Number(cents) || 0) / 100).toFixed(2);
  }

  /** Slovene plural forms for "plačano striženje". */
  function plural(n) {
    var count = Math.abs(Number(n) || 0);
    if (count === 1) return 'plačano striženje';
    if (count === 2) return 'plačani striženji';
    if (count === 3 || count === 4) return 'plačana striženja';
    return 'plačanih striženj';
  }

  function loyaltyOf(count) {
    var required = Number(DATA.paidBeforeFree) || 9;
    var value = Math.max(0, Number(count) || 0);
    var remaining = Math.max(0, required - value);
    return {
      count: value,
      required: required,
      eligible: value >= required,
      progress: value + ' / ' + required,
      hint:
        value >= required
          ? 'Naslednje striženje je brezplačno'
          : remaining + ' ' + plural(remaining) + ' do brezplačnega',
      percent: Math.min(100, Math.round((value / required) * 100)),
    };
  }

  /* ---------------------------------------------------------------- toasts */

  function toast(message, kind) {
    var host = document.getElementById('toasts');
    if (!host || !message) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () {
        el.remove();
      }, 300);
    }, kind === 'error' ? 6000 : 3200);
  }

  // Messages that need to survive the reload after a calendar change.
  function toastAfterReload(message, kind) {
    try {
      sessionStorage.setItem('salon.toast', JSON.stringify({ message: message, kind: kind }));
    } catch (err) {
      /* private mode — the message is simply skipped */
    }
  }

  (function showPendingToast() {
    try {
      var raw = sessionStorage.getItem('salon.toast');
      if (!raw) return;
      sessionStorage.removeItem('salon.toast');
      var data = JSON.parse(raw);
      if (data && data.message) toast(data.message, data.kind);
    } catch (err) {
      /* ignore */
    }
  })();

  function reload() {
    window.location.reload();
  }

  /* ------------------------------------------------------------------ fetch */

  function api(url, body, method) {
    return fetch(url, {
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN || '',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return { ok: false, error: 'Nepričakovan odziv strežnika.' };
          })
          .then(function (data) {
            data.status = res.status;
            return data;
          });
      })
      .catch(function () {
        return { ok: false, error: 'Ni povezave s strežnikom.' };
      });
  }

  function get(url) {
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json();
      })
      .catch(function () {
        return { ok: false, error: 'Ni povezave s strežnikom.' };
      });
  }

  /* ------------------------------------------------------------------ modal */

  var modalRoot = document.getElementById('modal-root');
  var modalContent = document.getElementById('modal-content');
  var lastFocus = null;

  function openModal(html) {
    if (!modalRoot) return;
    lastFocus = document.activeElement;
    modalContent.innerHTML = html;
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    var focusTarget = modalContent.querySelector('[data-autofocus]') ||
      modalContent.querySelector('input, select, textarea, button');
    if (focusTarget) focusTarget.focus();
  }

  function closeModal() {
    if (!modalRoot || modalRoot.hidden) return;
    modalRoot.hidden = true;
    modalContent.innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-modal-close]')) {
      e.preventDefault();
      closeModal();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalRoot && !modalRoot.hidden) closeModal();
  });

  function showError(message) {
    var box = modalContent.querySelector('[data-form-error]');
    if (!box) {
      toast(message, 'error');
      return;
    }
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
  }

  function clearError() {
    var box = modalContent.querySelector('[data-form-error]');
    if (box) {
      box.hidden = true;
      box.textContent = '';
    }
  }

  function busy(button, on) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.dataset.label || button.textContent;
      button.disabled = true;
      button.textContent = button.dataset.busyText || 'Shranjujem…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /* --------------------------------------------------- appointment form HTML */

  function serviceOptions(selectedId) {
    var out = '<option value="">Izberite storitev</option>';
    DATA.services.forEach(function (s) {
      out +=
        '<option value="' + s.id + '"' +
        (Number(selectedId) === s.id ? ' selected' : '') +
        // Deliberately not data-duration / data-price: those names belong to the
        // form's own inputs, and an <option> carrying them would be matched first
        // by form.querySelector.
        ' data-svc-duration="' + s.duration_min + '" data-svc-price="' + s.price + '">' +
        esc(s.name) + ' · ' + s.duration_min + ' min · ' + money(s.price_cents) +
        '</option>';
    });
    return out;
  }

  /**
   * `extra` keeps the appointment's own employee selectable even when they have
   * since been deactivated — otherwise the browser would silently fall back to
   * the first option and reassign the appointment on save.
   */
  function employeeOptions(selectedId, extra) {
    var list = DATA.employees.slice();
    if (extra && extra.id && !list.some(function (e) { return e.id === Number(extra.id); })) {
      list.push({ id: Number(extra.id), name: (extra.name || 'Zaposleni') + ' (neaktiven)' });
    }
    var out = '';
    list.forEach(function (e) {
      out +=
        '<option value="' + e.id + '"' +
        (Number(selectedId) === e.id ? ' selected' : '') + '>' +
        esc(e.name) + '</option>';
    });
    return out;
  }

  function chosenCustomerHtml(customer) {
    if (!customer) return '';
    var state = customer.loyalty || loyaltyOf(customer.visit_count);
    return (
      '<div class="cust-chosen' + (state.eligible ? ' is-free' : '') + '">' +
      '<div>' +
      '<span class="c-name">' + esc(customer.name || '') + '</span><br>' +
      '<span class="c-meta">' + esc(customer.phone || 'Ni telefonske številke') + '</span><br>' +
      (state.eligible
        ? '<span class="badge badge-free">NEXT HAIRCUT FREE</span>'
        : '<span class="c-meta">Obiski: ' + esc(state.progress) + ' · ' + esc(state.hint) + '</span>') +
      '</div>' +
      '<button type="button" class="btn btn-quiet btn-sm" data-clear-customer>Zamenjaj</button>' +
      '</div>'
    );
  }

  function appointmentFormHtml(state) {
    var editing = state.mode === 'edit';
    return (
      '<div class="modal-head">' +
      '<h2 id="modal-title">' + (editing ? 'Uredi termin' : 'Nov termin') + '</h2>' +
      '<button type="button" class="modal-x" data-modal-close aria-label="Zapri">×</button>' +
      '</div>' +
      '<form class="modal-body apptform" data-appt-form novalidate>' +
      '<p class="form-error" data-form-error hidden></p>' +

      '<div class="field cust-search" data-customer-field>' +
      '<label for="af-customer">Stranka *</label>' +
      '<div data-customer-slot>' +
      (state.customer
        ? chosenCustomerHtml(state.customer)
        : '<input id="af-customer" type="search" data-customer-input ' +
          (state.customer ? '' : 'data-autofocus ') +
          'placeholder="Iskanje po imenu ali telefonu…" autocomplete="off">' +
          '<ul class="cust-results" data-customer-results></ul>') +
      '</div>' +
      '</div>' +

      '<div class="field">' +
      '<label for="af-service">Storitev *</label>' +
      '<select id="af-service" data-service>' + serviceOptions(state.serviceId) + '</select>' +
      (editing && state.serviceMissing
        ? '<p class="hint">Original service: <strong>' + esc(state.serviceName) +
          '</strong> (no longer in the service list — leave empty to keep it).</p>'
        : '') +
      '</div>' +

      '<div class="field">' +
      '<label for="af-employee">Zaposleni *</label>' +
      '<select id="af-employee" data-employee>' +
      employeeOptions(state.employeeId, state.employeeFallback) + '</select>' +
      '</div>' +

      '<div class="form-row">' +
      '<div class="field">' +
      '<label for="af-date">Datum *</label>' +
      '<input id="af-date" type="date" data-date value="' + esc(state.date) + '">' +
      '</div>' +
      '<div class="field">' +
      '<label for="af-start">Začetek *</label>' +
      '<input id="af-start" type="time" step="300" data-start value="' + esc(state.start) + '">' +
      '</div>' +
      '</div>' +

      '<div class="form-row">' +
      '<div class="field">' +
      '<label for="af-duration">Trajanje (min) *</label>' +
      '<input id="af-duration" type="number" min="5" max="720" step="5" inputmode="numeric" ' +
      'data-duration value="' + esc(state.duration) + '">' +
      '</div>' +
      '<div class="field">' +
      '<label for="af-price">Cena (€) *</label>' +
      '<input id="af-price" type="text" inputmode="decimal" data-price value="' + esc(state.price) + '">' +
      '</div>' +
      '</div>' +

      '<div class="readout">' +
      '<div><span class="k">Začetek</span><span class="v" data-out-start>—</span></div>' +
      '<div><span class="k">Konec</span><span class="v" data-out-end>—</span></div>' +
      '<div><span class="k">Trajanje</span><span class="v" data-out-duration>—</span></div>' +
      '<div><span class="k">Cena</span><span class="v" data-out-price>—</span></div>' +
      '</div>' +

      '<div class="field" style="margin-top:.8rem">' +
      '<label for="af-notes">Opombe</label>' +
      '<textarea id="af-notes" rows="2" data-notes placeholder="neobvezno">' +
      esc(state.notes || '') + '</textarea>' +
      '</div>' +

      '<div class="form-actions">' +
      '<button type="button" class="btn btn-quiet" data-modal-close>Prekliči</button>' +
      '<button type="submit" class="btn btn-primary" data-submit ' +
      'data-busy-text="Shranjujem…">' +
      (editing ? 'Shrani termin' : 'Shrani termin') +
      '</button>' +
      '</div>' +

      '<input type="hidden" data-mode value="' + esc(state.mode) + '">' +
      '<input type="hidden" data-appt-id value="' + esc(state.id || '') + '">' +
      '<input type="hidden" data-customer-id value="' + esc(state.customer ? state.customer.id : '') + '">' +
      '</form>'
    );
  }

  /* ------------------------------------------------- appointment form logic */

  var formState = null;

  function currentForm() {
    return modalContent ? modalContent.querySelector('[data-appt-form]') : null;
  }

  /**
   * Look up one of the form's own inputs. Restricting the match to input and
   * textarea keeps a <select>'s options from being picked up by accident.
   */
  function field(form, name) {
    return form.querySelector('input[data-' + name + '], textarea[data-' + name + ']');
  }

  function updateReadout() {
    var form = currentForm();
    if (!form) return;
    var start = parseTime(field(form, 'start').value);
    var duration = Number(field(form, 'duration').value);
    var priceRaw = field(form, 'price').value;

    form.querySelector('[data-out-start]').textContent = start === null ? '—' : formatTime(start);
    form.querySelector('[data-out-end]').textContent =
      start === null || !duration ? '—' : formatTime(start + duration);
    form.querySelector('[data-out-duration]').textContent = duration ? duration + ' min' : '—';

    var price = parseFloat(String(priceRaw).replace(',', '.'));
    form.querySelector('[data-out-price]').textContent =
      isFinite(price) && price >= 0 ? '€' + price.toFixed(2) : '—';
  }

  /** Copy the visible field values back into formState before leaving the form. */
  function snapshotForm() {
    var form = currentForm();
    if (!form || !formState) return;
    formState.serviceId = form.querySelector('[data-service]').value;
    formState.employeeId = form.querySelector('[data-employee]').value;
    formState.date = field(form, 'date').value;
    formState.start = field(form, 'start').value;
    formState.duration = field(form, 'duration').value;
    formState.price = field(form, 'price').value;
    formState.notes = field(form, 'notes').value;
  }

  function openAppointmentForm(state) {
    formState = state;
    openModal(appointmentFormHtml(state));
    updateReadout();
    var input = modalContent.querySelector('[data-customer-input]');
    if (input) input.focus();
  }

  /** Fill duration and price from the chosen service, keeping manual overrides. */
  function onServiceChange(form) {
    var select = form.querySelector('[data-service]');
    var option = select.options[select.selectedIndex];
    if (!option || !option.value) return;
    field(form, 'duration').value = option.dataset.svcDuration || '';
    field(form, 'price').value = option.dataset.svcPrice || '';
    updateReadout();
  }

  function selectCustomer(customer) {
    var form = currentForm();
    if (!form) return;
    form.querySelector('[data-customer-id]').value = customer.id;
    var slot = form.querySelector('[data-customer-slot]');
    slot.innerHTML = chosenCustomerHtml(customer);
    if (formState) formState.customer = customer;
    var service = form.querySelector('[data-service]');
    if (service && !service.value) service.focus();
  }

  function clearCustomer() {
    var form = currentForm();
    if (!form) return;
    form.querySelector('[data-customer-id]').value = '';
    if (formState) formState.customer = null;
    var slot = form.querySelector('[data-customer-slot]');
    slot.innerHTML =
      '<input id="af-customer" type="search" data-customer-input ' +
      'placeholder="Iskanje po imenu ali telefonu…" autocomplete="off">' +
      '<ul class="cust-results" data-customer-results></ul>';
    slot.querySelector('[data-customer-input]').focus();
  }

  function renderResults(list, query) {
    var form = currentForm();
    if (!form) return;
    var box = form.querySelector('[data-customer-results]');
    if (!box) return;

    if (!query) {
      box.innerHTML = '';
      return;
    }

    if (!list.length) {
      box.innerHTML =
        '<li class="cust-none">Stranke ni mogoče najti' +
        '<div style="margin-top:.5rem">' +
        '<button type="button" class="btn btn-sm" data-create-customer>+ Ustvari novo stranko</button>' +
        '</div></li>';
      return;
    }

    var html = '';
    list.forEach(function (c) {
      var state = c.loyalty || loyaltyOf(c.visit_count);
      html +=
        '<li><button type="button" class="cust-result" data-pick-customer=\'' +
        esc(JSON.stringify(c)) + '\'>' +
        '<span class="r-name">' + esc(c.name) + '</span>' +
        '<span class="r-meta">' + esc(c.phone || 'Ni telefona') + ' · Obiski: ' +
        (state.eligible ? 'BREZPLAČNO' : esc(state.progress)) + '</span>' +
        '</button></li>';
    });
    html +=
      '<li class="cust-none" style="border:0;margin:0">' +
      '<button type="button" class="btn btn-sm" data-create-customer>+ Ustvari novo stranko</button>' +
      '</li>';
    box.innerHTML = html;
  }

  var searchTimer = null;

  function scheduleSearch(value) {
    clearTimeout(searchTimer);
    var query = String(value || '').trim();
    if (query.length < 1) {
      renderResults([], '');
      return;
    }
    searchTimer = setTimeout(function () {
      get('/api/customers/search?q=' + encodeURIComponent(query)).then(function (data) {
        if (!data || !data.ok) return;
        renderResults(data.customers || [], query);
      });
    }, 140);
  }

  /* --------------------------------------------- quick new-customer creation */

  function openQuickCustomer(prefill) {
    var pending = formState;
    openModal(
      '<div class="modal-head">' +
      '<h2 id="modal-title">Nova stranka</h2>' +
      '<button type="button" class="modal-x" data-modal-close aria-label="Zapri">×</button>' +
      '</div>' +
      '<form class="modal-body" data-quick-customer novalidate>' +
      '<p class="form-error" data-form-error hidden></p>' +
      '<div class="form-row">' +
      '<div class="field"><label for="qc-first">Ime *</label>' +
      '<input id="qc-first" data-autofocus data-first value="' + esc(prefill || '') + '"></div>' +
      '<div class="field"><label for="qc-last">Priimek</label>' +
      '<input id="qc-last" data-last></div>' +
      '</div>' +
      '<div class="form-row">' +
      '<div class="field"><label for="qc-phone">Telefon</label>' +
      '<input id="qc-phone" type="tel" data-phone placeholder="031 123 456"></div>' +
      '<div class="field"><label for="qc-email">E-pošta</label>' +
      '<input id="qc-email" type="email" data-email></div>' +
      '</div>' +
      '<div class="field"><label for="qc-notes">Opombe</label>' +
      '<textarea id="qc-notes" rows="2" data-notes></textarea></div>' +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-quiet" data-back-to-appointment>Nazaj</button>' +
      '<button type="submit" class="btn btn-primary" data-submit data-busy-text="Ustvarjam…">Ustvari</button>' +
      '</div>' +
      '</form>'
    );
    formState = pending;
  }

  /* -------------------------------------------------------- save appointment */

  function collectAppointment(form) {
    return {
      customer_id: form.querySelector('[data-customer-id]').value,
      service_id: form.querySelector('[data-service]').value,
      employee_id: form.querySelector('[data-employee]').value,
      date: field(form, 'date').value,
      start: field(form, 'start').value,
      duration_min: field(form, 'duration').value,
      price: field(form, 'price').value,
      notes: field(form, 'notes').value,
    };
  }

  function saveAppointment(form) {
    clearError();
    var payload = collectAppointment(form);
    if (!payload.customer_id) return showError('Izberite stranko za ta termin.');
    if (!payload.service_id && form.querySelector('[data-mode]').value !== 'edit') {
      return showError('Izberite storitev.');
    }
    if (!payload.date) return showError('Izberite datum.');
    if (parseTime(payload.start) === null) return showError('Izberite začetni čas.');

    var id = form.querySelector('[data-appt-id]').value;
    var url = id ? '/api/appointments/' + id : '/api/appointments';
    var button = form.querySelector('[data-submit]');
    busy(button, true);

    api(url, payload).then(function (data) {
      if (!data.ok) {
        busy(button, false);
        return showError(data.error || 'Termina ni bilo mogoče shraniti.');
      }
      var message = data.message || 'Termin je shranjen.';
      if (data.sms) {
        if (data.sms.status === 'failed') message += ' SMS ni bilo mogoče poslati.';
        else if (data.sms.status === 'sent') message += ' SMS je poslan.';
        else if (data.sms.status === 'no_phone') message += ' Stranka nima telefonske številke, SMS ni bil poslan.';
      }
      toastAfterReload(message, data.sms && data.sms.status === 'failed' ? 'warn' : null);
      reload();
    });
  }

  /* --------------------------------------------------------- details actions */

  function openAppointment(id) {
    get('/api/appointments/' + id + '/panel').then(function (data) {
      if (!data || !data.ok) {
        toast((data && data.error) || 'Termina ni bilo mogoče odpreti.', 'error');
        return;
      }
      openModal(data.html);
    });
  }

  function openEdit(id) {
    get('/api/appointments/' + id).then(function (data) {
      if (!data || !data.ok) {
        toast('Termina ni bilo mogoče odpreti.', 'error');
        return;
      }
      var a = data.appointment;
      var known = DATA.services.some(function (s) {
        return s.id === a.service_id;
      });
      openAppointmentForm({
        mode: 'edit',
        id: a.id,
        customer: {
          id: a.customer_id,
          name: a.customer_name,
          phone: a.customer_phone,
          visit_count: a.customer_visits,
        },
        serviceId: known ? a.service_id : '',
        serviceName: a.service_name,
        serviceMissing: !known,
        employeeId: a.employee_id,
        employeeFallback: { id: a.employee_id, name: a.employee_name },
        date: a.date,
        start: a.start_time,
        duration: a.duration_min,
        price: (a.price_cents / 100).toFixed(2),
        notes: a.notes,
      });
    });
  }

  function openReschedule(id) {
    get('/api/appointments/' + id).then(function (data) {
      if (!data || !data.ok) return toast('Termina ni bilo mogoče odpreti.', 'error');
      var a = data.appointment;
      openModal(
        '<div class="modal-head">' +
        '<h2 id="modal-title">Prestavi termin</h2>' +
        '<button type="button" class="modal-x" data-modal-close aria-label="Zapri">×</button>' +
        '</div>' +
        '<form class="modal-body" data-reschedule-form data-id="' + a.id + '" novalidate>' +
        '<p class="form-error" data-form-error hidden></p>' +
        '<p class="confirm-text"><strong>' + esc(a.customer_name) + '</strong> · ' +
        esc(a.service_name) + ' · ' + a.duration_min + ' min</p>' +
        '<div class="confirm-lines"><div><span class="k">Trenutno</span>' +
        '<span>' + esc(a.date_display) + ' ' + esc(a.start_time) + '</span></div></div>' +
        '<div class="form-row">' +
        '<div class="field"><label for="rs-date">Datum</label>' +
        '<input id="rs-date" type="date" data-autofocus data-date value="' + esc(a.date) + '"></div>' +
        '<div class="field"><label for="rs-time">Čas</label>' +
        '<input id="rs-time" type="time" step="300" data-start value="' + esc(a.start_time) + '"></div>' +
        '</div>' +
        '<div class="field"><label for="rs-emp">Zaposleni</label>' +
        '<select id="rs-emp" data-employee>' +
        employeeOptions(a.employee_id, { id: a.employee_id, name: a.employee_name }) +
        '</select></div>' +
        '<div class="form-actions">' +
        '<button type="button" class="btn btn-quiet" data-modal-close>Prekliči</button>' +
        '<button type="submit" class="btn btn-primary" data-submit data-busy-text="Shranjujem…">Shrani</button>' +
        '</div>' +
        '</form>'
      );
    });
  }

  function openCancel(id) {
    get('/api/appointments/' + id).then(function (data) {
      if (!data || !data.ok) return toast('Termina ni bilo mogoče odpreti.', 'error');
      var a = data.appointment;
      openModal(
        '<div class="modal-head">' +
        '<h2 id="modal-title">Odpovej termin</h2>' +
        '<button type="button" class="modal-x" data-modal-close aria-label="Zapri">×</button>' +
        '</div>' +
        '<form class="modal-body" data-cancel-form data-id="' + a.id + '" novalidate>' +
        '<p class="form-error" data-form-error hidden></p>' +
        '<p class="confirm-text">Odpovem termin za <strong>' +
        esc(a.customer_name) + '</strong>?</p>' +
        '<div class="confirm-lines">' +
        '<div><span class="k">Datum</span><span>' + esc(a.date_display) + '</span></div>' +
        '<div><span class="k">Čas</span><span>' + esc(a.start_time) + '</span></div>' +
        '</div>' +
        '<div class="field"><label for="cx-reason">Razlog</label>' +
        '<input id="cx-reason" data-autofocus data-reason placeholder="neobvezno"></div>' +
        (DATA.smsEnabled
          ? '<label class="check"><input type="checkbox" data-send-sms checked> ' +
            'Pošlji SMS o odpovedi</label>'
          : '<p class="hint">SMS obvestila so v nastavitvah izklopljena.</p>') +
        '<div class="form-actions">' +
        '<button type="button" class="btn btn-quiet" data-modal-close>Nazaj</button>' +
        '<button type="submit" class="btn btn-danger" data-submit data-busy-text="Odpovedujem…">' +
        'Odpovej termin</button>' +
        '</div>' +
        '</form>'
      );
    });
  }

  function setStatus(id, status, extra) {
    var body = { status: status };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return api('/api/appointments/' + id + '/status', body);
  }

  /* ---------------------------------------------------- drag-and-drop moving */

  var dragging = null;

  document.addEventListener('dragstart', function (e) {
    var appt = e.target.closest('.appt');
    if (!appt) return;
    dragging = {
      id: appt.dataset.appointment,
      date: appt.dataset.apptDate,
      start: Number(appt.dataset.apptStart),
      customer: appt.dataset.apptCustomer,
      employee: appt.dataset.apptEmployee,
    };
    appt.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragging.id);
    }
  });

  document.addEventListener('dragend', function (e) {
    var appt = e.target.closest('.appt');
    if (appt) appt.classList.remove('is-dragging');
    dragging = null;
  });

  document.addEventListener('dragover', function (e) {
    if (!dragging) return;
    var slot = e.target.closest('.cal-slot');
    if (!slot) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  document.addEventListener('drop', function (e) {
    if (!dragging) return;
    var slot = e.target.closest('.cal-slot');
    if (!slot) return;
    e.preventDefault();

    var move = dragging;
    var newDate = slot.dataset.date;
    var newStart = slot.dataset.start;
    dragging = null;

    if (newDate === move.date && parseTime(newStart) === move.start) return;

    openModal(
      '<div class="modal-head">' +
      '<h2 id="modal-title">Prestavi termin</h2>' +
      '<button type="button" class="modal-x" data-modal-close aria-label="Zapri">×</button>' +
      '</div>' +
      '<div class="modal-body">' +
      '<p class="form-error" data-form-error hidden></p>' +
      '<p class="confirm-text">Prestavim termin za <strong>' + esc(move.customer) + '</strong>?</p>' +
      '<div class="confirm-lines">' +
      '<div><span class="k">Star čas</span><span>' + esc(formatDate(move.date)) + ' ' +
      esc(formatTime(move.start)) + '</span></div>' +
      '<div><span class="k">Nov čas</span><span>' + esc(formatDate(newDate)) + ' ' +
      esc(newStart) + '</span></div>' +
      '</div>' +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-quiet" data-modal-close>Prekliči</button>' +
      '<button type="button" class="btn btn-primary" data-autofocus data-confirm-move ' +
      'data-id="' + esc(move.id) + '" data-date="' + esc(newDate) + '" ' +
      'data-start="' + esc(newStart) + '" data-busy-text="Prestavljam…">Potrdi</button>' +
      '</div>' +
      '</div>'
    );
  });

  /* ------------------------------------------------------------ click router */

  document.addEventListener('click', function (e) {
    var el;

    /* open the new-appointment form from a calendar slot, toolbar or customer */
    el = e.target.closest('[data-new-appointment]');
    if (el) {
      e.preventDefault();
      var customer = null;
      if (el.dataset.customerId) {
        customer = {
          id: Number(el.dataset.customerId),
          name: el.dataset.customerName || '',
          phone: el.dataset.customerPhone || '',
          visit_count: Number(el.dataset.customerVisits || 0),
        };
        // Fetch the authoritative loyalty state before showing the summary.
        get('/api/customers/' + customer.id).then(function (data) {
          if (data && data.ok) {
            var form = currentForm();
            if (form && String(form.querySelector('[data-customer-id]').value) ===
                String(data.customer.id)) {
              selectCustomer(data.customer);
            }
          }
        });
      }
      openAppointmentForm({
        mode: 'create',
        customer: customer,
        serviceId: '',
        employeeId: el.dataset.employee || DATA.defaultEmployeeId || '',
        date: el.dataset.date || DATA.today,
        start: el.dataset.start || '',
        duration: '',
        price: '',
        notes: '',
      });
      return;
    }

    /* open an existing appointment */
    el = e.target.closest('[data-appointment]');
    if (el) {
      e.preventDefault();
      openAppointment(el.dataset.appointment);
      return;
    }

    /* clicking anywhere in a month cell opens that date in Day view */
    el = e.target.closest('[data-open-day]');
    if (el && !e.target.closest('a, button')) {
      window.location.href = el.dataset.openDay;
      return;
    }

    el = e.target.closest('[data-appt-edit]');
    if (el) return openEdit(el.dataset.apptEdit);

    el = e.target.closest('[data-appt-reschedule]');
    if (el) return openReschedule(el.dataset.apptReschedule);

    el = e.target.closest('[data-appt-cancel]');
    if (el) return openCancel(el.dataset.apptCancel);

    el = e.target.closest('[data-appt-status]');
    if (el) {
      var statusBtn = el;
      busy(statusBtn, true);
      setStatus(statusBtn.dataset.id, statusBtn.dataset.apptStatus).then(function (data) {
        if (!data.ok) {
          busy(statusBtn, false);
          return toast(data.error || 'Termina ni bilo mogoče posodobiti.', 'error');
        }
        toastAfterReload(data.message);
        reload();
      });
      return;
    }

    el = e.target.closest('[data-retry-sms]');
    if (el) {
      var smsBtn = el;
      busy(smsBtn, true);
      api('/api/appointments/' + smsBtn.dataset.retrySms + '/sms', {
        kind: smsBtn.dataset.kind,
      }).then(function (data) {
        busy(smsBtn, false);
        toast(data.ok ? 'SMS je poslan.' : data.error || 'SMS ni bilo mogoče poslati.',
          data.ok ? null : 'error');
      });
      return;
    }

    el = e.target.closest('[data-confirm-move]');
    if (el) {
      var moveBtn = el;
      busy(moveBtn, true);
      api('/api/appointments/' + moveBtn.dataset.id + '/reschedule', {
        date: moveBtn.dataset.date,
        start: moveBtn.dataset.start,
      }).then(function (data) {
        if (!data.ok) {
          busy(moveBtn, false);
          return showError(data.error || 'Termina ni bilo mogoče prestaviti.');
        }
        var msg = data.message || 'Termin je prestavljen.';
        if (data.sms && data.sms.status === 'failed') msg += ' SMS ni bilo mogoče poslati.';
        if (data.sms && data.sms.status === 'sent') msg += ' SMS je poslan.';
        toastAfterReload(msg);
        reload();
      });
      return;
    }

    /* appointment form helpers */
    el = e.target.closest('[data-pick-customer]');
    if (el) {
      try {
        selectCustomer(JSON.parse(el.dataset.pickCustomer));
      } catch (err) {
        toast('Te stranke ni bilo mogoče izbrati.', 'error');
      }
      return;
    }

    el = e.target.closest('[data-clear-customer]');
    if (el) return clearCustomer();

    el = e.target.closest('[data-create-customer]');
    if (el) {
      var input = modalContent.querySelector('[data-customer-input]');
      var typed = input ? input.value : '';
      // Keep whatever has already been filled in, so coming back from the
      // customer form does not throw away the chosen date, time and service.
      snapshotForm();
      return openQuickCustomer(typed.replace(/[\d+()]/g, '').trim());
    }

    el = e.target.closest('[data-back-to-appointment]');
    if (el) {
      return openAppointmentForm(formState || { mode: 'create', date: DATA.today });
    }

    /* visit counter */
    el = e.target.closest('[data-visit-delta]');
    if (el) {
      var vBtn = el;
      var card = vBtn.closest('[data-customer]');
      var delta = Number(vBtn.dataset.visitDelta);
      // Increasing is instant; decreasing asks first, as a decrease is a correction.
      if (delta < 0 && !window.confirm('Zmanjšam število obiskov za 1?')) return;
      vBtn.disabled = true;
      api('/api/customers/' + card.dataset.customer + '/visits', { delta: delta })
        .then(function (data) {
          vBtn.disabled = false;
          if (!data.ok) return toast(data.error || 'Števila obiskov ni bilo mogoče spremeniti.', 'error');
          applyVisitState(card, data.customer.loyalty);
          toast(data.message);
        });
      return;
    }

    /* product stock */
    el = e.target.closest('[data-stock-delta]');
    if (el) {
      var sBtn = el;
      var id = sBtn.dataset.id;
      sBtn.disabled = true;
      api('/api/products/' + id + '/quantity', { delta: Number(sBtn.dataset.stockDelta) })
        .then(function (data) {
          sBtn.disabled = false;
          if (!data.ok) return toast(data.error || 'Zaloge ni bilo mogoče spremeniti.', 'error');
          document.querySelectorAll('[data-stock-value="' + id + '"]').forEach(function (out) {
            out.textContent = data.product.quantity;
          });
          var field = document.getElementById('set-qty');
          if (field) field.value = data.product.quantity;
          toast(data.message);
        });
      return;
    }
  });

  function applyVisitState(card, state) {
    if (!card) return;
    card.querySelectorAll('[data-visit-value]').forEach(function (out) {
      out.textContent = state.count;
    });
    var badge = card.querySelector('[data-visit-badge]');
    if (badge) {
      if (state.eligible) {
        badge.className = 'badge badge-free badge-big';
        badge.textContent = 'NASLEDNJE STRIŽENJE BREZPLAČNO';
      } else {
        badge.className = 'visit-count';
        badge.textContent = state.progress;
      }
    }
    var bar = card.querySelector('[data-visit-bar]');
    if (bar) bar.style.width = state.percent + '%';
    var hint = card.querySelector('[data-visit-hint]');
    if (hint) hint.textContent = state.hint;
    var setField = card.querySelector('#set-count');
    if (setField) setField.value = state.count;

    // The redeem button only exists once the customer is eligible, so a state
    // change flips the page over to the correct controls.
    var hasRedeem = !!card.querySelector('.redeem-form');
    if (state.eligible !== hasRedeem) reload();
  }

  /* -------------------------------------------------------------- form submit */

  document.addEventListener('submit', function (e) {
    var form = e.target;

    if (form.matches('[data-appt-form]')) {
      e.preventDefault();
      return saveAppointment(form);
    }

    if (form.matches('[data-quick-customer]')) {
      e.preventDefault();
      clearError();
      var first = form.querySelector('[data-first]').value.trim();
      if (!first) return showError('Vpišite vsaj ime.');
      var qcButton = form.querySelector('[data-submit]');
      busy(qcButton, true);
      api('/api/customers', {
        first_name: first,
        last_name: form.querySelector('[data-last]').value,
        phone: form.querySelector('[data-phone]').value,
        email: form.querySelector('[data-email]').value,
        notes: form.querySelector('[data-notes]').value,
      }).then(function (data) {
        busy(qcButton, false);
        if (!data.ok) return showError(data.error || 'Stranke ni bilo mogoče ustvariti.');
        toast(data.message || 'Stranka je ustvarjena.');
        // Return to the appointment with the new customer already selected.
        var state = formState || { mode: 'create', date: DATA.today };
        state.customer = data.customer;
        openAppointmentForm(state);
        selectCustomer(data.customer);
      });
      return;
    }

    if (form.matches('[data-reschedule-form]')) {
      e.preventDefault();
      clearError();
      var rsButton = form.querySelector('[data-submit]');
      busy(rsButton, true);
      api('/api/appointments/' + form.dataset.id + '/reschedule', {
        date: form.querySelector('[data-date]').value,
        start: form.querySelector('[data-start]').value,
        employee_id: form.querySelector('[data-employee]').value,
      }).then(function (data) {
        if (!data.ok) {
          busy(rsButton, false);
          return showError(data.error || 'Termina ni bilo mogoče prestaviti.');
        }
        var msg = data.message;
        if (data.sms && data.sms.status === 'failed') msg += ' SMS ni bilo mogoče poslati.';
        if (data.sms && data.sms.status === 'sent') msg += ' SMS je poslan.';
        if (data.sms && data.sms.status === 'no_phone') {
          msg += ' Stranka nima telefonske številke, SMS ni bil poslan.';
        }
        toastAfterReload(msg);
        reload();
      });
      return;
    }

    if (form.matches('[data-cancel-form]')) {
      e.preventDefault();
      clearError();
      var cxButton = form.querySelector('[data-submit]');
      var smsBox = form.querySelector('[data-send-sms]');
      busy(cxButton, true);
      setStatus(form.dataset.id, 'cancelled', {
        reason: form.querySelector('[data-reason]').value,
        send_sms: smsBox ? smsBox.checked : false,
      }).then(function (data) {
        if (!data.ok) {
          busy(cxButton, false);
          return showError(data.error || 'Termina ni bilo mogoče odpovedati.');
        }
        var msg = data.message;
        if (data.sms && data.sms.status === 'failed') msg += ' SMS ni bilo mogoče poslati.';
        if (data.sms && data.sms.status === 'sent') msg += ' SMS je poslan.';
        if (data.sms && data.sms.status === 'no_phone') {
          msg += ' Stranka nima telefonske številke, SMS ni bil poslan.';
        }
        toastAfterReload(msg);
        reload();
      });
      return;
    }

    /* Server-rendered forms: confirm where asked, then block double submits. */
    var confirmText = form.dataset.confirm;
    if (confirmText && !window.confirm(confirmText)) {
      e.preventDefault();
      return;
    }
    var submit = form.querySelector('[data-busy-text], button[type="submit"]');
    if (submit && !submit.disabled) {
      // Let the browser send the form first, then lock the button.
      setTimeout(function () {
        submit.disabled = true;
        if (submit.dataset.busyText) submit.textContent = submit.dataset.busyText;
      }, 0);
    }
  });

  /* ------------------------------------------------------------ form events */

  document.addEventListener('input', function (e) {
    if (targetMatches(e, '[data-customer-input]')) return scheduleSearch(e.target.value);
    if (targetMatches(e, 'input[data-start], input[data-duration], input[data-price]')) {
      updateReadout();
    }
  });

  document.addEventListener('change', function (e) {
    if (targetMatches(e, '[data-service]')) onServiceChange(e.target.closest('form'));

    // Opening-hours editor: show the time pair or the free-text box.
    if (targetMatches(e, '[data-hours-mode]')) {
      var row = e.target.closest('[data-hours-day]');
      if (!row) return;
      var mode = e.target.value;
      row.querySelector('[data-hours-times]').hidden = mode !== 'open';
      row.querySelector('[data-hours-text]').hidden = mode !== 'text';
      if (mode === 'text') row.querySelector('[data-hours-text]').focus();
    }
  });

  /** Keydown can be dispatched at the document, which has no .matches. */
  function targetMatches(e, selector) {
    return !!(e.target && e.target.matches && e.target.matches(selector));
  }

  // Enter in the customer search picks the first result instead of submitting.
  document.addEventListener('keydown', function (e) {
    if (!targetMatches(e, '[data-customer-input]')) return;
    var form = currentForm();
    if (!form) return;
    var results = form.querySelectorAll('[data-pick-customer]');

    if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length) results[0].click();
      return;
    }
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      results[0].focus();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!targetMatches(e, '.cust-result')) return;
    var items = Array.prototype.slice.call(
      modalContent.querySelectorAll('.cust-result')
    );
    var index = items.indexOf(e.target);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (items[index + 1] || items[0]).focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) {
        var input = modalContent.querySelector('[data-customer-input]');
        if (input) input.focus();
      } else {
        items[index - 1].focus();
      }
    }
  });
})();
