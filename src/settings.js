'use strict';

const { db } = require('./db');

// Every setting the application understands, with its default. The public
// website and the calendar read these instead of hard-coding salon details.
const DEFAULTS = {
  salon_name: 'Frizerstvo Berni',
  // The big line at the top of the website. Empty falls back to the salon name,
  // which is what a salon without its own sentence wants.
  hero_heading: '',
  slogan: 'Frizerske storitve',
  // The registered business, for the copyright line. Empty falls back to the
  // salon name.
  legal_name: '',
  address: '',
  city: '',
  phone: '',
  email: '',
  about: '',
  instagram: '',
  facebook: '',
  other_link: '',
  other_link_label: '',
  map_url: '',
  // Paths under /public. Empty falls back to the salon name as text. Both
  // files ship with the app: the script wordmark and the round emblem.
  logo_url: '/img/logo.png',
  emblem_url: '/img/emblem.jpg',
  // Large picture beside the heading on the website. Empty falls back to the
  // emblem, so the page never has an empty frame.
  hero_image_url: '',

  /* --------------------------------------------------------- website copy */
  // The four short selling points under the heading, and the three service
  // cards below them. Nothing in the database can say what a salon is proud of
  // or how it describes a group of services, so the salon writes these itself
  // in Nastavitve. A card with an empty title is left off the page entirely,
  // which is why these all start blank.
  highlight_1_title: '',
  highlight_1_text: '',
  highlight_2_title: '',
  highlight_2_text: '',
  highlight_3_title: '',
  highlight_3_text: '',
  highlight_4_title: '',
  highlight_4_text: '',
  // Each card: a heading, a paragraph, one bullet per line, and a picture.
  // With every title empty the website falls back to cards generated from the
  // service categories, so the section still works untouched.
  service_card_1_title: '',
  service_card_1_text: '',
  service_card_1_points: '',
  service_card_1_image: '',
  service_card_2_title: '',
  service_card_2_text: '',
  service_card_2_points: '',
  service_card_2_image: '',
  service_card_3_title: '',
  service_card_3_text: '',
  service_card_3_points: '',
  service_card_3_image: '',
  // Each weekday has a mode: 'open' (fixed times), 'closed', or 'text' (free
  // wording such as "Po dogovoru" shown in place of the times).
  opening_hours: JSON.stringify({
    1: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    2: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    3: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    4: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    5: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    6: { mode: 'open', open: '08:00', close: '13:00', text: '' },
    0: { mode: 'closed', open: '', close: '', text: '' },
  }),
  calendar_start: '07:00',
  calendar_end: '20:00',
  paid_before_free: '9',
  sms_enabled: '0',
  // Send without š, č and ž. One such letter forces the whole message into
  // Unicode, where the limit drops from 160 characters to 70 — so a normal
  // confirmation is billed as two messages instead of one. On by default
  // because that is a doubled bill for a cosmetic difference.
  sms_plain_text: '1',
  // Customers booking themselves on the website. Off by default: it needs SMS
  // working first, because the phone number is verified by a code.
  public_booking_enabled: '0',
  // Reminder before the appointment. Off by default on purpose: switching it on
  // starts billing one more message per appointment, so the salon decides when.
  sms_reminder_enabled: '0',
  sms_reminder_hours_before: '24',
};

const DAY_KEYS = ['1', '2', '3', '4', '5', '6', '0'];
const DAY_NAMES = {
  1: 'Ponedeljek',
  2: 'Torek',
  3: 'Sreda',
  4: 'Četrtek',
  5: 'Petek',
  6: 'Sobota',
  0: 'Nedelja',
};

function all() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function getInt(key) {
  const n = parseInt(get(key), 10);
  return Number.isFinite(n) ? n : parseInt(DEFAULTS[key], 10);
}

function set(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value == null ? '' : value));
}

function setMany(obj) {
  for (const [key, value] of Object.entries(obj)) set(key, value);
}

/**
 * Opening hours as a parsed object keyed by JS day number (0 = Sunday).
 *
 * Each entry is normalised to { mode, open, close, text, closed, label }.
 * `closed` stays available because the calendar only cares whether the salon
 * has fixed hours that day; a 'text' day has none, so it is not shaded.
 * Older records that used only { closed, open, close } still load correctly.
 */
function openingHours() {
  let parsed;
  try {
    parsed = JSON.parse(get('opening_hours'));
  } catch {
    parsed = JSON.parse(DEFAULTS.opening_hours);
  }

  const out = {};
  for (const key of DAY_KEYS) {
    const day = (parsed && parsed[key]) || {};
    const text = String(day.text || '').trim();

    let mode = day.mode;
    if (!mode) {
      // Migrate the older shape.
      if (text) mode = 'text';
      else if (day.closed || !day.open || !day.close) mode = 'closed';
      else mode = 'open';
    }
    if (mode === 'open' && (!day.open || !day.close)) mode = 'closed';
    if (mode === 'text' && !text) mode = 'closed';

    const open = mode === 'open' ? day.open : '';
    const close = mode === 'open' ? day.close : '';

    out[key] = {
      mode,
      open,
      close,
      text: mode === 'text' ? text : '',
      closed: mode === 'closed',
      hasFixedHours: mode === 'open',
      label:
        mode === 'open' ? `${open} – ${close}` : mode === 'text' ? text : 'Zaprto',
    };
  }
  return out;
}

/** Ordered Mon..Sun list for display. */
function openingHoursList() {
  const hours = openingHours();
  return DAY_KEYS.map((key) => ({
    day: Number(key),
    name: DAY_NAMES[key],
    ...hours[key],
  }));
}

module.exports = {
  DEFAULTS,
  DAY_KEYS,
  DAY_NAMES,
  all,
  get,
  getInt,
  set,
  setMany,
  openingHours,
  openingHoursList,
};
