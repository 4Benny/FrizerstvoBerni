'use strict';

const express = require('express');
const appointments = require('../repo/appointments');
const employees = require('../repo/employees');
const services = require('../repo/services');
const settings = require('../settings');
const view = require('../calendar-view');
const { requireLogin } = require('../middleware');
const util = require('../util');

const router = express.Router();

router.use(requireLogin);

router.get('/', (req, res) => res.redirect('/app/calendar'));

const VIEWS = ['day', 'week', 'month'];

router.get('/calendar', (req, res) => {
  const today = util.todayIso();
  const mode = VIEWS.includes(req.query.view) ? req.query.view : 'day';
  const date = util.isIsoDate(req.query.date) ? req.query.date : today;
  const employeeId = Number(req.query.employee) || null;

  const staff = employees.bookable();
  const selectedEmployee = employeeId ? employees.get(employeeId) : null;
  const range = view.range(mode, date);

  const rows = appointments.listRange({
    from: range.from,
    to: range.to,
    employeeId: selectedEmployee ? selectedEmployee.id : null,
  });
  const byDate = view.groupByDate(rows);

  // Shared context for the "new appointment" and details modals.
  const base = {
    title: 'Koledar',
    mode,
    date,
    today,
    range,
    heading: view.heading(mode, date),
    employees: staff,
    employeeId: selectedEmployee ? selectedEmployee.id : null,
    services: services.active(),
    paidBeforeFree: settings.getInt('paid_before_free'),
    slotMin: view.SLOT_MIN,
    defaultEmployeeId:
      (selectedEmployee && selectedEmployee.id) ||
      (staff.some((e) => e.id === req.user.id) ? req.user.id : (staff[0] && staff[0].id) || null),
  };

  const openingWeek = settings.openingHours();

  if (mode === 'month') {
    const days = [];
    for (let iso = range.from; iso <= range.to; iso = util.addDays(iso, 1)) {
      const day = view.describeDay(iso, today, openingWeek);
      const items = byDate[iso] || [];
      days.push({
        ...day,
        inMonth: iso >= range.monthFrom && iso <= range.monthTo,
        appointments: items,
        preview: items.slice(0, view.MONTH_PREVIEW),
        overflow: Math.max(0, items.length - view.MONTH_PREVIEW),
      });
    }
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    return res.render('staff/calendar-month', { ...base, weeks });
  }

  const window = view.timeWindow(rows);
  const dayList = [];
  for (let iso = range.from; iso <= range.to; iso = util.addDays(iso, 1)) {
    dayList.push({
      ...view.describeDay(iso, today, openingWeek),
      appointments: view.layoutDay(byDate[iso] || []),
    });
  }

  const template = mode === 'week' ? 'staff/calendar-week' : 'staff/calendar-day';
  res.render(template, { ...base, window, days: dayList });
});

module.exports = router;
