'use strict';

const express = require('express');
const sms = require('../sms');
const settings = require('../settings');
const { requireLogin, requireAdmin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin, requireAdmin);

const PAGE_SIZE = 100;

const STATUS_FILTERS = [
  { value: '', label: 'Vse' },
  { value: 'pending', label: 'V obdelavi' },
  { value: 'problem', label: 'Težave' },
  { value: 'accepted', label: 'Oddano prehodu' },
  { value: 'delivered', label: 'Dostavljeno' },
  { value: 'dead', label: 'Neuspešno' },
];

const KIND_FILTERS = [
  { value: '', label: 'Vse vrste' },
  { value: 'booked', label: 'Naročilo' },
  { value: 'rescheduled', label: 'Prestavitev' },
  { value: 'cancelled', label: 'Odpoved' },
  { value: 'reminder', label: 'Opomnik' },
];

router.get('/', (req, res) => {
  const status = String(req.query.status || '');
  const kind = String(req.query.kind || '');
  const page = Math.max(1, Number(req.query.page) || 1);

  const rows = sms.list({
    status,
    kind,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  // One row past the page tells us whether a next page exists, without a
  // second COUNT query over a table that only ever grows.
  const hasNext = rows.length > PAGE_SIZE;

  res.render('staff/sms-log', {
    title: 'SMS dnevnik',
    rows: rows.slice(0, PAGE_SIZE),
    counts: sms.counts(),
    statusFilters: STATUS_FILTERS,
    kindFilters: KIND_FILTERS,
    status,
    kind,
    page,
    hasNext,
    smsDriver: sms.DRIVER,
    smsEnabled: settings.get('sms_enabled') === '1',
    reminderEnabled: settings.get('sms_reminder_enabled') === '1',
    maxAttempts: sms.MAX_ATTEMPTS,
    historyMonths: sms.HISTORY_MONTHS,
  });
});

/** Put one failed message back in the queue. */
router.post('/:id/requeue', (req, res) => {
  const result = sms.requeue(req.params.id);
  setFlash(
    req,
    result.ok ? 'success' : 'error',
    result.ok ? 'Sporočilo je nazaj v vrsti za pošiljanje.' : result.error
  );
  const query = new URLSearchParams();
  if (req.body.status) query.set('status', String(req.body.status));
  if (req.body.kind) query.set('kind', String(req.body.kind));
  const suffix = query.toString();
  res.redirect('/app/sms' + (suffix ? `?${suffix}` : ''));
});

module.exports = router;
