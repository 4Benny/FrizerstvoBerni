'use strict';

const settings = require('./settings');
const util = require('./util');

/**
 * Each employee's own working week.
 *
 * Stored on the employee as JSON keyed by JS weekday (0 = Sunday), the same
 * shape the salon's opening hours use, so the editor markup is shared.
 *
 * An employee with nothing set falls back to the salon's opening hours. That
 * keeps every existing employee working exactly as before the feature existed,
 * and means a salon that does not care about per-person hours never has to
 * fill anything in.
 *
 * A working day is deliberately NOT clipped to the salon's opening hours. The
 * example that drove this — someone working Sunday 10:00–13:00 while the salon
 * shows Sunday as closed — has to be expressible.
 */

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

/** Parse whatever is stored, tolerating an empty column or broken JSON. */
function parse(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Normalise one day into { mode, open, close, openMin, closeMin, working }.
 * Only 'open' and 'closed' are meaningful here — the salon's "po dogovoru"
 * makes no sense for a bookable window, so it is treated as not working.
 */
function normaliseDay(day) {
  const mode = day && day.mode === 'open' ? 'open' : 'closed';
  const openMin = mode === 'open' ? util.parseTime(day.open) : null;
  const closeMin = mode === 'open' ? util.parseTime(day.close) : null;
  const usable = openMin !== null && closeMin !== null && closeMin > openMin;

  return {
    mode: usable ? 'open' : 'closed',
    open: usable ? day.open : '',
    close: usable ? day.close : '',
    openMin: usable ? openMin : null,
    closeMin: usable ? closeMin : null,
    working: usable,
    label: usable ? `${day.open} – ${day.close}` : 'Ne dela',
  };
}

/** The salon's own hours, used when an employee has set none. */
function salonFallback() {
  const hours = settings.openingHours();
  const out = {};
  for (const key of DAY_KEYS) {
    const day = hours[key];
    out[key] = normaliseDay(
      day && day.hasFixedHours ? { mode: 'open', open: day.open, close: day.close } : {}
    );
  }
  return out;
}

/**
 * The employee's week, keyed by weekday number as a string.
 * `inherited` says the figures came from the salon rather than the person.
 */
function forEmployee(employee) {
  const own = parse(employee && employee.work_hours);
  if (!own) return { inherited: true, days: salonFallback() };

  const days = {};
  for (const key of DAY_KEYS) days[key] = normaliseDay(own[key]);
  return { inherited: false, days };
}

/** Ordered Mon..Sun list for display and for the editor. */
function listForEmployee(employee) {
  const { inherited, days } = forEmployee(employee);
  return {
    inherited,
    days: DAY_KEYS.map((key) => ({
      day: Number(key),
      name: DAY_NAMES[key],
      ...days[key],
    })),
  };
}

/**
 * The employee's working window on one date, or null when they are not working.
 * Returns minutes from midnight.
 */
function windowFor(employee, isoDate) {
  if (!util.isIsoDate(isoDate)) return null;
  const weekday = util.dayOfWeek(isoDate);
  const day = forEmployee(employee).days[String(weekday)];
  if (!day || !day.working) return null;
  return { startMin: day.openMin, endMin: day.closeMin };
}

/** True when the employee works at all on that date. */
function worksOn(employee, isoDate) {
  return windowFor(employee, isoDate) !== null;
}

/**
 * Read a posted schedule form into storable JSON.
 * Fields are mode_<day>, open_<day>, close_<day> — the same names the salon
 * hours editor posts, so the markup is shared.
 *
 * Returns { error } or { json }.
 */
function readForm(body) {
  const week = {};
  for (const key of DAY_KEYS) {
    const mode = body[`mode_${key}`] === 'open' ? 'open' : 'closed';
    if (mode !== 'open') {
      week[key] = { mode: 'closed', open: '', close: '' };
      continue;
    }
    const open = util.parseTime(body[`open_${key}`]);
    const close = util.parseTime(body[`close_${key}`]);
    if (open === null || close === null) {
      return { error: `${DAY_NAMES[key]}: vpišite začetek in konec v obliki HH:MM.` };
    }
    if (close <= open) {
      return { error: `${DAY_NAMES[key]}: konec mora biti po začetku.` };
    }
    week[key] = {
      mode: 'open',
      open: util.formatTime(open),
      close: util.formatTime(close),
    };
  }
  return { json: JSON.stringify(week) };
}

module.exports = {
  DAY_KEYS,
  DAY_NAMES,
  forEmployee,
  listForEmployee,
  windowFor,
  worksOn,
  readForm,
  salonFallback,
};
