'use strict';

const crypto = require('crypto');
const employees = require('./repo/employees');
const settings = require('./settings');
const util = require('./util');

/** Loads the signed-in employee onto req.user and res.locals. */
function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session && req.session.employeeId) {
    const user = employees.get(req.session.employeeId);
    // A deactivated or deleted employee must lose access immediately.
    if (user && user.active) {
      req.user = user;
      res.locals.user = {
        ...user,
        name: util.fullName(user),
        isAdmin: user.role === 'admin',
      };
    } else {
      req.session.employeeId = null;
    }
  }
  next();
}

/**
 * Stylesheets and scripts are served with a long cache lifetime, so their URLs
 * carry this token. It changes when the server restarts, which is what makes a
 * deployed change show up immediately instead of an hour later.
 */
const ASSET_VERSION = Date.now().toString(36);

/** Common template values for every rendered page. */
function templateLocals(req, res, next) {
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.settings = settings.all();
  res.locals.util = util;
  res.locals.path = req.path;
  res.locals.csrfToken = csrfToken(req);
  res.locals.flash = takeFlash(req);
  res.locals.query = req.query || {};
  next();
}

/**
 * Whether to answer with JSON instead of a rendered page. originalUrl is used
 * rather than req.path because inside a mounted router req.path is relative to
 * the mount point and would not show the /api prefix.
 */
function wantsJson(req) {
  return (
    req.xhr ||
    (req.originalUrl || '').split('?')[0].startsWith('/api/') ||
    (req.get('accept') || '').includes('application/json')
  );
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) {
    return res.status(401).json({ ok: false, error: 'Niste prijavljeni.' });
  }
  const target = encodeURIComponent(req.originalUrl || '/app');
  return res.redirect(`/login?next=${target}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (wantsJson(req)) {
    return res.status(403).json({ ok: false, error: 'Potreben je skrbniški dostop.' });
  }
  return res.status(403).render('staff/forbidden', {
    title: 'Dostop ni dovoljen',
    message: 'Ta razdelek je na voljo samo skrbnikom.',
  });
}

/* -------------------------------------------------------------------- csrf */

function csrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function checkCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session && req.session.csrf;
  const supplied =
    (req.body && req.body._csrf) || req.get('x-csrf-token') || req.get('X-CSRF-Token');
  if (expected && supplied && expected === supplied) return next();
  if (wantsJson(req)) {
    return res
      .status(403)
      .json({ ok: false, error: 'Seja je potekla. Osvežite stran.' });
  }
  return res.status(403).render('staff/forbidden', {
    title: 'Seja je potekla',
    message: 'Seja je potekla. Osvežite stran in poskusite znova.',
  });
}

/* ------------------------------------------------------------------- flash */

/** One-shot feedback message carried across a redirect. */
function setFlash(req, type, message) {
  if (!req.session) return;
  req.session.flash = { type, message };
}

function takeFlash(req) {
  if (!req.session || !req.session.flash) return null;
  const flash = req.session.flash;
  delete req.session.flash;
  return flash;
}

module.exports = {
  ASSET_VERSION,
  loadUser,
  templateLocals,
  requireLogin,
  requireAdmin,
  checkCsrf,
  csrfToken,
  setFlash,
  takeFlash,
  wantsJson,
};
