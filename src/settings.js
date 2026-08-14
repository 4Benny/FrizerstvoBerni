'use strict';

const { db } = require('./db');

// Every setting the application understands, with its default. The public
// website and the calendar read these instead of hard-coding salon details.
const DEFAULTS = {
  salon_name: 'Studio Hair',
  slogan: 'Professional hairdressing services',
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
  // Paths under /public, e.g. /img/logo.png. Empty falls back to the salon name.
  logo_url: '',
  emblem_url: '',
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
