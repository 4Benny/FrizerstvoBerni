# Salon appointment system

A hair salon website plus a private staff area for managing appointments,
customers, visit counters, services, employees, products and stock.

## Running it

```
npm install
npm start
```

- Public website: <http://localhost:3000>
- Staff login: <http://localhost:3000/login>

The first launch creates `data/salon.db` with an admin account and a small set of
example services, products and customers.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `SALON_DB` | Database file | `data/salon.db` |
| `SESSION_SECRET` | Session cookie signing key | dev-only placeholder |
| `ADMIN_PASSWORD` | First-run admin password | `admin123` |
| `SMS_DRIVER` | `log`, `http` or `twilio` | `log` |
| `SMS_HTTP_URL` etc. | Gateway configuration for the `http` driver — see SETUP.md | — |
| `SMS_COUNTRY_CODE` | Country code for local numbers, no plus | `386` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | Twilio credentials | — |

**[SETUP.md](SETUP.md) is the full guide** — uploading to a server, running it,
login details, SMS, backups, updating and troubleshooting.
`deploy/setup.sh` does a fresh Ubuntu server in one command.

**Before using this anywhere real:** set `SESSION_SECRET` to a random value and
change the admin password. The defaults exist only so the app runs out of the box.

Other commands: `npm run dev` (auto-restart on file changes), `npm test`.

## How it is put together

Node + Express with EJS templates. The database is SQLite through Node's
built-in `node:sqlite`, so there is no native module to compile — the only
dependencies are `express`, `express-session` and `ejs`.

```
server.js              app wiring, sessions, error handling
src/db.js              schema and connection
src/settings.js        salon settings with defaults
src/util.js            money, time, date, password and loyalty helpers
src/sms.js             pluggable SMS driver and message templates
src/middleware.js      auth, CSRF, flash messages, template locals
src/calendar-view.js   time grid, overlap lane layout, date ranges
src/repo/              data access, one module per table
src/routes/            public site, auth, calendar, and the JSON API
views/                 EJS templates
public/                stylesheets and one client-side script
tests/                 test suites
```

Pages are rendered on the server. The interactive parts — the appointment
modal, customer search, drag-and-drop, and the +/- counters — are handled by
`public/js/app.js` talking to the JSON API under `/api`.

## Behaviour worth knowing

- **Appointments snapshot their service.** The name, duration and price are
  copied when the appointment is created, so re-pricing a service later never
  rewrites bookings that already exist.
- **The visit counter is manual, always.** Completing, cancelling or no-showing
  an appointment never changes it. Only the +/-, Set count and Redeem controls do.
- **Conflicts are rejected per employee.** Two employees may share a time; one
  employee cannot. Touching edges (10:45 right after 10:00–10:45) are allowed.
- **Cancelled and no-show appointments release their slot.** Reopening one
  re-checks the time first, in case it was booked in the meantime.
- **Opening hours shape the calendar** but do not restrict it: a booking outside
  those hours still shows, because the grid widens to fit it.
- **Deactivating an employee** blocks login and removes them from new bookings
  while keeping every appointment already assigned to them.
- **SMS never blocks a save.** The appointment is stored first; a failed message
  is reported and can be retried. Numbers are converted to E.164 before
  sending, so `031 331 636` reaches the gateway as `+38631331636`.
- **Branding comes from settings.** `logo_url` and `emblem_url` point at files
  under `public/` (e.g. `/img/logo.png`). The logo replaces the salon name in the
  site header, the staff top bar and the login card; the emblem appears on the
  home page and as the favicon. Leave either empty to fall back to text.
- **Stylesheets and scripts are cached for an hour**, so their URLs carry a
  `?v=` token that changes when the server restarts. After editing CSS or JS you
  must restart (`npm run dev` does it automatically) or the browser will keep
  serving the old file.

## Tests

```
npm test          # both suites
npm run test:sms  # SMS only: number conversion and the HTTP gateway
npm run test:http # the HTTP suite only
```

`tests/sms.js` runs 36 checks: local-to-E.164 conversion, and the generic HTTP
driver against a fake gateway that captures exactly what a real provider would
receive — authentication headers, body format, escaping, timeouts, and the
failure paths.

The HTTP suite starts the app on a spare port against a throwaway database and runs
`tests/e2e.js` over HTTP — 275 checks covering the public site, login and roles,
the three calendar views, conflict rules, the visit counter and loyalty
threshold, settings validation, SMS outcomes, services, products, employees,
escaping and CSRF. The runner also fails the build if any route logs a stack
trace.

`tests/client-browser.js` covers `public/js/app.js`, which the HTTP suite cannot
reach. Start the app, open the public page, open the DevTools console and paste
the file in; it builds a synthetic staff DOM, stubs `fetch` and drives the real
event handlers through 96 checks. No login is needed because every request is
stubbed. Reload the page afterwards to restore it.
