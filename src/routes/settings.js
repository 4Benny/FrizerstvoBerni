'use strict';

const express = require('express');
const settings = require('../settings');
const sms = require('../sms');
const util = require('../util');
const { requireLogin, requireAdmin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin, requireAdmin);

const TEXT_FIELDS = [
  'salon_name',
  'slogan',
  'address',
  'city',
  'phone',
  'email',
  'about',
  'instagram',
  'facebook',
  'other_link',
  'other_link_label',
  'map_url',
  'logo_url',
  'emblem_url',
];

router.get('/', (req, res) => {
  res.render('staff/settings', {
    title: 'Nastavitve',
    values: settings.all(),
    hours: settings.openingHoursList(),
    error: null,
    smsDriver: sms.DRIVER,
  });
});

router.post('/', (req, res) => {
  const body = req.body;
  const updates = {};
  for (const field of TEXT_FIELDS) {
    updates[field] = util.str(body[field], field === 'about' ? 4000 : 300);
  }

  const start = util.parseTime(body.calendar_start);
  const end = util.parseTime(body.calendar_end);
  const paidBeforeFree = Number(body.paid_before_free);

  const rerender = (error) =>
    res.status(400).render('staff/settings', {
      title: 'Nastavitve',
      values: { ...settings.all(), ...updates },
      hours: settings.openingHoursList(),
      error,
      smsDriver: sms.DRIVER,
    });

  if (!updates.salon_name) return rerender('Vpišite ime salona.');
  if (start === null || end === null) return rerender('Vpišite ure koledarja v obliki HH:MM.');
  if (end <= start) return rerender('Konec koledarja mora biti po začetku.');
  if (!Number.isFinite(paidBeforeFree) || paidBeforeFree < 1) {
    return rerender('Število plačanih striženj do brezplačnega mora biti 1 ali več.');
  }

  // Opening hours arrive as day-indexed fields: mode_1, open_1, close_1, text_1 …
  const hours = {};
  for (const key of settings.DAY_KEYS) {
    const mode = ['open', 'closed', 'text'].includes(body[`mode_${key}`])
      ? body[`mode_${key}`]
      : 'closed';
    const open = util.str(body[`open_${key}`], 5);
    const close = util.str(body[`close_${key}`], 5);
    const text = util.str(body[`text_${key}`], 60);
    const dayName = settings.DAY_NAMES[key];

    if (mode === 'open') {
      const openMin = util.parseTime(open);
      const closeMin = util.parseTime(close);
      if (openMin === null || closeMin === null) {
        return rerender(`${dayName}: vpišite delovni čas v obliki HH:MM.`);
      }
      if (closeMin <= openMin) {
        return rerender(`${dayName}: čas zaprtja mora biti po času odprtja.`);
      }
    }
    if (mode === 'text' && !text) {
      return rerender(`${dayName}: vpišite besedilo, na primer "Po dogovoru".`);
    }

    hours[key] =
      mode === 'open'
        ? { mode: 'open', open, close, text: '' }
        : mode === 'text'
          ? { mode: 'text', open: '', close: '', text }
          : { mode: 'closed', open: '', close: '', text: '' };
  }

  settings.setMany({
    ...updates,
    calendar_start: util.formatTime(start),
    calendar_end: util.formatTime(end),
    paid_before_free: Math.round(paidBeforeFree),
    sms_enabled: util.boolInt(body.sms_enabled),
    opening_hours: JSON.stringify(hours),
  });

  setFlash(req, 'success', 'Nastavitve so shranjene.');
  res.redirect('/app/settings');
});

module.exports = router;
