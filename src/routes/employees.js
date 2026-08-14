'use strict';

const express = require('express');
const employees = require('../repo/employees');
const util = require('../util');
const { requireLogin, requireAdmin, setFlash } = require('../middleware');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', (req, res) => {
  res.render('staff/employees-list', {
    title: 'Zaposleni',
    employees: employees.list(),
  });
});

router.get('/new', (req, res) => {
  res.render('staff/employee-form', {
    title: 'Dodaj zaposlenega',
    employee: null,
    error: null,
    values: {
      first_name: '',
      last_name: '',
      username: '',
      email: '',
      role: 'employee',
      active: 1,
      color: employees.nextColor(),
    },
  });
});

function readForm(body) {
  return {
    first_name: util.str(body.first_name, 80),
    last_name: util.str(body.last_name, 80),
    username: util.str(body.username, 80),
    email: util.str(body.email, 120),
    role: body.role === 'admin' ? 'admin' : 'employee',
    active: util.boolInt(body.active),
    color: util.str(body.color, 20) || '#4f6df5',
  };
}

router.post('/new', (req, res) => {
  const values = readForm(req.body);
  const password = String(req.body.password || '');

  const render = (error) =>
    res.status(400).render('staff/employee-form', {
      title: 'Dodaj zaposlenega',
      employee: null,
      error,
      values,
    });

  if (!values.first_name) return render('Vpišite ime.');
  if (!/^[a-zA-Z0-9._-]{3,}$/.test(values.username)) {
    return render('Uporabniško ime naj ima vsaj 3 znake (črke, številke, . _ -).');
  }
  if (password.length < 6) return render('Geslo mora imeti vsaj 6 znakov.');
  if (employees.byUsername(values.username)) return render('To uporabniško ime je že zasedeno.');

  employees.create({ ...values, password });
  setFlash(req, 'success', 'Zaposleni je shranjen.');
  res.redirect('/app/employees');
});

router.get('/:id/edit', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();
  res.render('staff/employee-form', {
    title: `Uredi ${util.fullName(employee)}`,
    employee,
    error: null,
    values: employee,
  });
});

router.post('/:id/edit', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();

  const values = readForm(req.body);
  const render = (error) =>
    res.status(400).render('staff/employee-form', {
      title: `Uredi ${util.fullName(employee)}`,
      employee,
      error,
      values: { ...values, id: employee.id },
    });

  if (!values.first_name) return render('Vpišite ime.');
  if (!/^[a-zA-Z0-9._-]{3,}$/.test(values.username)) {
    return render('Uporabniško ime naj ima vsaj 3 znake (črke, številke, . _ -).');
  }
  const clash = employees.byUsername(values.username);
  if (clash && clash.id !== employee.id) return render('To uporabniško ime je že zasedeno.');

  // Never let the salon lock itself out of the administrator sections.
  const losingAdmin =
    employee.role === 'admin' && (values.role !== 'admin' || !values.active);
  if (losingAdmin && employees.countActiveAdmins(employee.id) === 0) {
    return render('To je edini aktivni skrbnik. Najprej določite drugega.');
  }

  employees.update(employee.id, values);
  setFlash(req, 'success', 'Zaposleni je shranjen.');
  res.redirect('/app/employees');
});

router.post('/:id/password', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();

  const password = String(req.body.password || '');
  if (password.length < 6) {
    setFlash(req, 'error', 'Geslo mora imeti vsaj 6 znakov.');
    return res.redirect(`/app/employees/${employee.id}/edit`);
  }
  employees.setPassword(employee.id, password);
  setFlash(req, 'success', `Geslo za ${util.fullName(employee)} je ponastavljeno.`);
  res.redirect('/app/employees');
});

/**
 * Deactivating blocks login but keeps the employee's existing appointments,
 * so nothing in the calendar history is lost.
 */
router.post('/:id/active', (req, res, next) => {
  const employee = employees.get(req.params.id);
  if (!employee) return next();

  if (employee.active && employee.role === 'admin' && employees.countActiveAdmins(employee.id) === 0) {
    setFlash(req, 'error', 'To je edini aktivni skrbnik in ga ni mogoče deaktivirati.');
    return res.redirect('/app/employees');
  }
  if (employee.active && employee.id === req.user.id) {
    setFlash(req, 'error', 'Svojega računa ne morete deaktivirati.');
    return res.redirect('/app/employees');
  }

  employees.update(employee.id, { ...employee, active: employee.active ? 0 : 1 });
  setFlash(
    req,
    'success',
    employee.active
      ? `${util.fullName(employee)} je deaktiviran.`
      : `${util.fullName(employee)} je aktiviran.`
  );
  res.redirect('/app/employees');
});

module.exports = router;
