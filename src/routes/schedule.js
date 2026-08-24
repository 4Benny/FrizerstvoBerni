'use strict';

const express = require('express');
const employees = require('../repo/employees');
const schedule = require('../schedule');
const { requireLogin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

/**
 * Working hours. Everyone edits their own; administrators may edit anybody's.
 * Nobody else can, because a schedule decides when customers may book that
 * person.
 */
function mayEdit(user, employeeId) {
  return user && (user.role === 'admin' || user.id === Number(employeeId));
}

function render(res, { employee, self, error = null, body = null, status = 200 }) {
  const current = schedule.listForEmployee(employee);
  // After a failed save, show what was typed rather than what is stored.
  const days = body
    ? current.days.map((day) => ({
        ...day,
        mode: body[`mode_${day.day}`] === 'open' ? 'open' : 'closed',
        open: body[`open_${day.day}`] || day.open,
        close: body[`close_${day.day}`] || day.close,
      }))
    : current.days;

  return res.status(status).render('staff/schedule-form', {
    title: self ? 'Moj urnik' : `Urnik — ${employee.first_name} ${employee.last_name}`.trim(),
    employee,
    self,
    days,
    inherited: current.inherited,
    action: self ? '/app/urnik' : `/app/urnik/${employee.id}`,
    error,
  });
}

/** The signed-in employee's own schedule. */
router.get('/', (req, res) => render(res, { employee: req.user, self: true }));

router.post('/', (req, res) => {
  if (req.body.action === 'reset') {
    employees.setWorkHours(req.user.id, '');
    setFlash(req, 'success', 'Urnik je izbrisan, velja delovni čas salona.');
    return res.redirect('/app/urnik');
  }
  const read = schedule.readForm(req.body);
  if (read.error) {
    return render(res, {
      employee: req.user, self: true, error: read.error, body: req.body, status: 400,
    });
  }
  employees.setWorkHours(req.user.id, read.json);
  setFlash(req, 'success', 'Urnik je shranjen.');
  return res.redirect('/app/urnik');
});

/** Somebody else's schedule — administrators only. */
router.get('/:id', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();
  if (!mayEdit(req.user, employee.id)) {
    return res.status(403).render('staff/forbidden', {
      title: 'Ni dovoljeno',
      message: 'Urnik lahko ureja zaposleni sam ali skrbnik.',
    });
  }
  return render(res, { employee, self: req.user.id === employee.id });
});

router.post('/:id', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();
  if (!mayEdit(req.user, employee.id)) {
    return res.status(403).render('staff/forbidden', {
      title: 'Ni dovoljeno',
      message: 'Urnik lahko ureja zaposleni sam ali skrbnik.',
    });
  }

  if (req.body.action === 'reset') {
    employees.setWorkHours(employee.id, '');
    setFlash(req, 'success', 'Urnik je izbrisan, velja delovni čas salona.');
    return res.redirect(`/app/urnik/${employee.id}`);
  }

  const read = schedule.readForm(req.body);
  if (read.error) {
    return render(res, {
      employee,
      self: req.user.id === employee.id,
      error: read.error,
      body: req.body,
      status: 400,
    });
  }
  employees.setWorkHours(employee.id, read.json);
  setFlash(req, 'success', 'Urnik je shranjen.');
  return res.redirect(`/app/urnik/${employee.id}`);
});

module.exports = router;
