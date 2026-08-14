'use strict';

const express = require('express');
const employees = require('../repo/employees');
const util = require('../util');

const router = express.Router();

/** Only allow redirect targets inside the staff area. */
function safeNext(value) {
  const target = String(value || '');
  return /^\/(app|api)(\/|$)/.test(target) ? target : '/app/calendar';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('staff/login', {
    title: 'Prijava za zaposlene',
    error: null,
    login: '',
    next: req.query.next || '',
  });
});

router.post('/login', (req, res) => {
  const login = util.str(req.body.login, 120);
  const password = String(req.body.password || '');
  const next = req.body.next;

  const fail = (error) =>
    res.status(401).render('staff/login', {
      title: 'Prijava za zaposlene',
      error,
      login,
      next: next || '',
    });

  if (!login || !password) return fail('Vpišite uporabniško ime in geslo.');

  const employee = employees.byLogin(login);
  if (!employee || !util.verifyPassword(password, employee.password_hash)) {
    return fail('Napačno uporabniško ime ali geslo.');
  }
  if (!employee.active) {
    return fail('Ta račun je deaktiviran. Obrnite se na skrbnika.');
  }

  // Refresh the session id on login so a fixated id cannot be reused.
  req.session.regenerate((err) => {
    if (err) return fail('Prijava ni uspela. Poskusite znova.');
    req.session.employeeId = employee.id;
    req.session.save(() => res.redirect(safeNext(next)));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
