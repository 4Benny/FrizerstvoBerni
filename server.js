'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const SqliteStore = require('./src/session-store');
const middleware = require('./src/middleware');
const bootstrap = require('./src/bootstrap');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Create the default admin and demo salon data on first run.
bootstrap.ensureSeed();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

app.use(
  session({
    name: 'salon.sid',
    secret: process.env.SESSION_SECRET || 'salon-dev-secret-change-me',
    store: new SqliteStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(middleware.loadUser);
app.use(middleware.templateLocals);
app.use(middleware.checkCsrf);

app.use('/', require('./src/routes/public'));
app.use('/', require('./src/routes/auth'));
app.use('/app', require('./src/routes/calendar'));
app.use('/app/customers', require('./src/routes/customers'));
app.use('/app/services', require('./src/routes/services'));
app.use('/app/products', require('./src/routes/products'));
app.use('/app/employees', require('./src/routes/employees'));
app.use('/app/settings', require('./src/routes/settings'));
app.use('/api', require('./src/routes/api'));

app.use((req, res) => {
  if (middleware.wantsJson(req)) {
    return res.status(404).json({ ok: false, error: 'Ni najdeno.' });
  }
  res.status(404).render('staff/forbidden', {
    title: 'Stran ne obstaja',
    message: 'Te strani ni.',
  });
});

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
app.use((err, req, res, next) => {
  console.error(err);
  if (middleware.wantsJson(req)) {
    return res.status(500).json({ ok: false, error: 'Prišlo je do napake.' });
  }
  res.status(500).render('staff/forbidden', {
    title: 'Napaka',
    message: 'Prišlo je do napake. Poskusite znova.',
  });
});

app.listen(PORT, () => {
  console.log(`Salon app running on http://localhost:${PORT}`);
  console.log(`  Public website : http://localhost:${PORT}/`);
  console.log(`  Staff login    : http://localhost:${PORT}/login`);
});
