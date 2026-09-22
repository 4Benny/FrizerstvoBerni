'use strict';

const express = require('express');
const settings = require('../settings');
const sms = require('../sms');
const util = require('../util');
const { requireLogin, requireAdmin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin, requireAdmin);

// Every free-text setting the form posts, with the length it is cut to. The
// generous ones are the paragraphs; everything else is a single line.
const TEXT_FIELDS = {
  salon_name: 300,
  hero_heading: 300,
  legal_name: 300,
  slogan: 300,
  address: 300,
  city: 300,
  phone: 300,
  email: 300,
  about: 4000,
  instagram: 300,
  facebook: 300,
  other_link: 300,
  other_link_label: 300,
  map_url: 300,
  logo_url: 300,
  emblem_url: 300,
  hero_image_url: 300,
};

// The website copy the salon writes itself: four selling points and three
// service cards. Added here so the list above stays readable.
for (const n of [1, 2, 3, 4]) {
  TEXT_FIELDS[`highlight_${n}_title`] = 120;
  TEXT_FIELDS[`highlight_${n}_text`] = 400;
}
for (const n of [1, 2, 3]) {
  TEXT_FIELDS[`service_card_${n}_title`] = 120;
  TEXT_FIELDS[`service_card_${n}_text`] = 600;
  TEXT_FIELDS[`service_card_${n}_points`] = 600;
  TEXT_FIELDS[`service_card_${n}_image`] = 300;
}

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
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    updates[field] = util.str(body[field], max);
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

  // A week is the sensible ceiling: a reminder further out is not a reminder.
  // A form that omits the field keeps whatever is already stored, so this stays
  // optional for anything posting a subset of the settings.
  const rawReminderHours =
    body.sms_reminder_hours_before === undefined || body.sms_reminder_hours_before === ''
      ? settings.get('sms_reminder_hours_before')
      : body.sms_reminder_hours_before;
  const reminderHours = Math.round(Number(rawReminderHours));
  if (!Number.isFinite(reminderHours) || reminderHours < 1 || reminderHours > 168) {
    return rerender('Opomnik mora biti med 1 in 168 urami pred terminom.');
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
    sms_plain_text: util.boolInt(body.sms_plain_text),
    public_booking_enabled: util.boolInt(body.public_booking_enabled),
    sms_reminder_enabled: util.boolInt(body.sms_reminder_enabled),
    sms_reminder_hours_before: reminderHours,
    opening_hours: JSON.stringify(hours),
  });

  setFlash(req, 'success', 'Nastavitve so shranjene.');
  res.redirect('/app/settings');
});

module.exports = router;
