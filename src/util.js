'use strict';

const crypto = require('crypto');

/* ------------------------------------------------------------------ money */

function formatMoney(cents) {
  const n = Number(cents) || 0;
  return '€' + (n / 100).toFixed(2);
}

/** Accepts "25", "25.5", "25,50", "€25.50" -> cents. Returns null if unusable. */
function parseMoney(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[^\d.,-]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/* ------------------------------------------------------------------- time */

/** "10:30" -> 630. Returns null when malformed. */
function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 630 -> "10:30". Minutes past 24:00 wrap for display safety. */
function formatTime(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ------------------------------------------------------------------- date */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(value) {
  const m = ISO_DATE.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (
    d.getFullYear() === Number(m[1]) &&
    d.getMonth() === Number(m[2]) - 1 &&
    d.getDate() === Number(m[3])
  );
}

function todayIso() {
  return toIso(new Date());
}

function toIso(date) {
  return (
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  );
}

/** Local-time Date at midnight for an ISO date string. */
function fromIso(iso) {
  const m = ISO_DATE.exec(String(iso || ''));
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "2026-08-13" -> "13.08.2026" */
function formatDate(iso) {
  const m = ISO_DATE.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

function addDays(iso, days) {
  const d = fromIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

/** JS day number, 0 = Sunday. */
function dayOfWeek(iso) {
  return fromIso(iso).getDay();
}

// Indexed by JS day number, 0 = Sunday.
const DAY_SHORT = ['NED', 'PON', 'TOR', 'SRE', 'ČET', 'PET', 'SOB'];
const DAY_LONG = [
  'Nedelja',
  'Ponedeljek',
  'Torek',
  'Sreda',
  'Četrtek',
  'Petek',
  'Sobota',
];
const MONTH_LONG = [
  'januar',
  'februar',
  'marec',
  'april',
  'maj',
  'junij',
  'julij',
  'avgust',
  'september',
  'oktober',
  'november',
  'december',
];

/** Monday of the week containing `iso`. */
function weekStart(iso) {
  const d = fromIso(iso);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return toIso(d);
}

function monthStart(iso) {
  const d = fromIso(iso);
  return toIso(new Date(d.getFullYear(), d.getMonth(), 1));
}

function monthEnd(iso) {
  const d = fromIso(iso);
  return toIso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function nowStamp() {
  return new Date().toISOString();
}

/* --------------------------------------------------------------- passwords */

/** scrypt with a random salt; stored as "scrypt$<salt>$<hash>". */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(plain), parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ----------------------------------------------------------------- loyalty */

/**
 * Loyalty state for a visit count. `required` is the number of PAID haircuts
 * needed before one free haircut, so count === required means the next one
 * is free.
 */
function loyalty(visitCount, required) {
  const count = Math.max(0, Number(visitCount) || 0);
  const target = Math.max(1, Number(required) || 1);
  const eligible = count >= target;
  const remaining = Math.max(0, target - count);
  return {
    count,
    required: target,
    eligible,
    remaining,
    label: eligible ? 'NASLEDNJE STRIŽENJE BREZPLAČNO' : `${count} / ${target}`,
    progress: `${count} / ${target}`,
    hint: eligible ? 'Naslednje striženje je brezplačno' : `${remaining} ${plural(remaining)} do brezplačnega`,
    percent: Math.min(100, Math.round((count / target) * 100)),
  };
}

/** Slovene has four number forms; pick the right one for "plačano striženje". */
function plural(n) {
  const count = Math.abs(Number(n) || 0);
  if (count === 1) return 'plačano striženje';
  if (count === 2) return 'plačani striženji';
  if (count === 3 || count === 4) return 'plačana striženja';
  return 'plačanih striženj';
}

/* -------------------------------------------------------------- misc bits */

function fullName(person) {
  if (!person) return '';
  return `${person.first_name || ''} ${person.last_name || ''}`.trim();
}

function str(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/**
 * Truthy-to-1 for checkbox posts and numeric flags alike. An unchecked
 * checkbox is simply absent from the body, which lands here as undefined.
 */
function boolInt(value) {
  if (value === true || value === 1) return 1;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return text === '1' || text === 'on' || text === 'true' || text === 'yes' ? 1 : 0;
}

module.exports = {
  formatMoney,
  parseMoney,
  parseTime,
  formatTime,
  isIsoDate,
  todayIso,
  toIso,
  fromIso,
  formatDate,
  addDays,
  dayOfWeek,
  weekStart,
  monthStart,
  monthEnd,
  nowStamp,
  hashPassword,
  verifyPassword,
  loyalty,
  fullName,
  str,
  boolInt,
  DAY_SHORT,
  DAY_LONG,
  MONTH_LONG,
};
