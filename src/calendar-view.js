'use strict';

const settings = require('./settings');
const util = require('./util');

const SLOT_MIN = 15; // 15-minute visual interval, per the specification
const MONTH_PREVIEW = 3; // appointments shown per month cell before "+N more"

/**
 * Lay out one day's appointments into side-by-side lanes so overlapping
 * bookings (different employees at the same time) stay readable.
 *
 * Appointments are grouped into clusters of mutually overlapping items; each
 * cluster is sized independently so a single 3-way overlap does not squash the
 * whole day.
 */
function layoutDay(appointments) {
  const sorted = [...appointments].sort(
    (a, b) => a.start_min - b.start_min || a.end_min - b.end_min || a.id - b.id
  );

  const out = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    // Greedy lane assignment: reuse the first lane that is already free.
    const laneEnds = [];
    for (const appt of cluster) {
      let lane = laneEnds.findIndex((end) => end <= appt.start_min);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(appt.end_min);
      } else {
        laneEnds[lane] = appt.end_min;
      }
      appt._lane = lane;
    }
    for (const appt of cluster) {
      out.push({ ...appt, lane: appt._lane, lanes: laneEnds.length });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const appt of sorted) {
    if (cluster.length && appt.start_min >= clusterEnd) flush();
    cluster.push(appt);
    clusterEnd = Math.max(clusterEnd, appt.end_min);
  }
  flush();

  return out;
}

/**
 * The vertical time window for the grid: the configured salon hours, widened
 * when necessary so an appointment booked outside them is never hidden.
 */
function timeWindow(appointments) {
  let start = util.parseTime(settings.get('calendar_start'));
  let end = util.parseTime(settings.get('calendar_end'));
  if (start === null) start = 7 * 60;
  if (end === null || end <= start) end = Math.min(24 * 60, start + 12 * 60);

  for (const appt of appointments) {
    if (appt.start_min < start) start = Math.floor(appt.start_min / 60) * 60;
    if (appt.end_min > end) end = Math.min(24 * 60, Math.ceil(appt.end_min / 60) * 60);
  }
  // Snap to whole slots so rows line up with the time labels.
  start = Math.floor(start / SLOT_MIN) * SLOT_MIN;
  end = Math.ceil(end / SLOT_MIN) * SLOT_MIN;
  if (end <= start) end = start + SLOT_MIN * 4;

  const slots = [];
  for (let m = start; m < end; m += SLOT_MIN) {
    slots.push({ min: m, label: util.formatTime(m), isHour: m % 60 === 0 });
  }
  return { startMin: start, endMin: end, slotMin: SLOT_MIN, slots };
}

/**
 * Per-day metadata: name, opening hours, whether the salon is closed.
 * `week` is the parsed opening-hours map; pass it in so rendering a month does
 * not re-read and re-parse the setting for every cell.
 */
function describeDay(iso, todayIso, week) {
  const dow = util.dayOfWeek(iso);
  const openingWeek = week || settings.openingHours();
  const hours = openingWeek[String(dow)] || { mode: 'closed', closed: true, label: 'Zaprto' };

  // Only a day with fixed hours can shade the times outside them. A day set to
  // free text ("Po dogovoru") has no fixed hours, so nothing is shaded.
  const fixed = hours.mode === 'open';
  const openMin = fixed ? util.parseTime(hours.open) : null;
  const closeMin = fixed ? util.parseTime(hours.close) : null;

  return {
    iso,
    dow,
    dayNumber: util.fromIso(iso).getDate(),
    dayShort: util.DAY_SHORT[dow],
    dayLong: util.DAY_LONG[dow],
    display: util.formatDate(iso),
    isToday: iso === todayIso,
    closed: hours.mode === 'closed',
    hasFixedHours: fixed && openMin !== null && closeMin !== null,
    openMin,
    closeMin,
    openLabel: hours.label || 'Zaprto',
  };
}

/** Dates covered by a view, and the dates the prev/next buttons jump to. */
function range(view, dateIso) {
  if (view === 'week') {
    const from = util.weekStart(dateIso);
    return {
      from,
      to: util.addDays(from, 6),
      prev: util.addDays(dateIso, -7),
      next: util.addDays(dateIso, 7),
    };
  }
  if (view === 'month') {
    const first = util.monthStart(dateIso);
    const last = util.monthEnd(dateIso);
    return {
      from: util.weekStart(first),
      to: util.addDays(util.weekStart(last), 6),
      prev: util.monthStart(util.addDays(first, -1)),
      next: util.addDays(last, 1),
      monthFrom: first,
      monthTo: last,
    };
  }
  return {
    from: dateIso,
    to: dateIso,
    prev: util.addDays(dateIso, -1),
    next: util.addDays(dateIso, 1),
  };
}

function heading(view, dateIso) {
  const d = util.fromIso(dateIso);
  if (view === 'week') {
    const from = util.weekStart(dateIso);
    const to = util.addDays(from, 6);
    return `${util.formatDate(from)} – ${util.formatDate(to)}`;
  }
  if (view === 'month') {
    return `${util.MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;
  }
  return `${util.DAY_LONG[d.getDay()]} ${util.formatDate(dateIso)}`;
}

/** Group appointments by ISO date. */
function groupByDate(appointments) {
  const out = {};
  for (const appt of appointments) {
    (out[appt.date] = out[appt.date] || []).push(appt);
  }
  return out;
}

module.exports = {
  SLOT_MIN,
  MONTH_PREVIEW,
  layoutDay,
  timeWindow,
  describeDay,
  range,
  heading,
  groupByDate,
};
