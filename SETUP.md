# Setup guide — Frizerstvo Berni

Everything needed to get this running, from nothing to a working salon system:
the database question, uploading to a server, running it, login details, SMS,
backups, updates and troubleshooting.

The application itself is in Slovene. This guide is in English because it is for
whoever installs it.

---

## Contents

1. [Do I need a database?](#1-do-i-need-a-database)
2. [What you need before starting](#2-what-you-need-before-starting)
3. [Running it on your own computer first](#3-running-it-on-your-own-computer-first)
4. [Putting it on a server — the fast way](#4-putting-it-on-a-server--the-fast-way)
5. [Putting it on a server — step by step](#5-putting-it-on-a-server--step-by-step)
6. [Login details](#6-login-details)
7. [Setting up SMS](#7-setting-up-sms)
8. [Filling in the salon's own details](#8-filling-in-the-salons-own-details)
9. [Backups and restoring](#9-backups-and-restoring)
10. [Updating](#10-updating)
11. [Troubleshooting](#11-troubleshooting)
12. [Before you go live](#12-before-you-go-live)

---

## 1. Do I need a database?

**No.** There is nothing to install, no PostgreSQL or MySQL, no database user or
password, and no extra service that can fail.

The entire database is a single file — `data/salon.db` — read and written by
Node itself through its built-in `node:sqlite` module (available from Node 22.5
onwards). It is created automatically the first time the app starts.

What that means in practice:

- **Backup** = copy one file (with `sqlite3 .backup`, see section 9)
- **Move to another server** = copy that one file across
- **Speed** — fine for a salon; thousands of appointments a year is nothing
- **The one rule** — never copy it with plain `cp` while the app is running. It
  uses WAL mode, so a plain copy can be inconsistent. Always use `.backup`.

The file is deliberately **not** in the git repository. `data/` is in
`.gitignore`, because it holds real customer data.

---

## 2. What you need before starting

**For a server install:**

- A small VPS. 1 vCPU and 1 GB RAM is plenty — the €4–5/month tier at Hetzner,
  DigitalOcean, Vultr or a Slovenian provider. Choose **Ubuntu 24.04**.
- SSH access to it (the provider gives you an IP address and either a root
  password or an SSH key).
- Optionally a domain or subdomain pointed at that IP, if you want `https://`
  rather than a bare IP address.

**For SMS** — one of:

- an Android phone with the salon SIM card (sends from your own number), or
- an account with an SMS provider.

Section 7 covers both. SMS is optional; everything else works without it.

> **About your domain.** `frizerstvo-berni.si` currently points at the pricepilot
> booking site. If you point it here, that site is replaced, including the online
> booking your customers may be using. Safer while you try this out: use a
> subdomain such as `salon.frizerstvo-berni.si`, or just the IP address.

---

## 3. Running it on your own computer first

Worth doing before touching a server — it takes two minutes and you see exactly
what you are installing.

```
cd C:\Users\robotska\desktop\app
npm install
npm start
```

Then open <http://localhost:3000>. Staff login is at
<http://localhost:3000/login> with **admin** / **admin123**.

Useful while developing:

```
npm run dev             # restarts automatically when you edit a file
npm test                # 321 checks
npm run accounts        # list the login accounts
```

To start over from scratch: stop the server, delete `data\salon.db*`, start again.

---

## 4. Putting it on a server — the fast way

Log in to the server over SSH, then:

```bash
curl -fsSL https://raw.githubusercontent.com/4Benny/FrizerstvoBerni/main/deploy/setup.sh -o setup.sh
less setup.sh          # read it before running it
sudo bash setup.sh
```

Because the repository is private, `curl` cannot fetch the script anonymously.
Either make the repository public, or upload the file yourself — see the
`scp` line in section 5, or simply paste the contents into `nano setup.sh`.

The script asks for your domain (blank is fine, it will use the IP) and whether
to get an HTTPS certificate, then:

- installs Node 24, nginx, git and sqlite3
- creates a locked-down `salon` system user
- clones the code into `/opt/salon/app` and installs dependencies
- generates a random `SESSION_SECRET` and a random admin password
- writes `/etc/salon.env` (mode 640, readable only by root and `salon`)
- installs a systemd service so it starts on boot and restarts on crash
- configures nginx as a reverse proxy and opens the firewall
- optionally obtains a Let's Encrypt certificate
- schedules a nightly database backup with 30-day retention

At the end it prints the address and **the admin password — write it down**.

Re-running the script later is safe: it updates the code and leaves an existing
database and password untouched.

---

## 5. Putting it on a server — step by step

Do this instead of section 4 if you would rather run each command yourself.

### 5.1 Connect

```bash
ssh root@YOUR_SERVER_IP
```

### 5.2 Install what is needed

```bash
apt-get update
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git nginx sqlite3
node -v          # must be 22.5 or newer
```

### 5.3 Create a user and folders

Running a web app as `root` is asking for trouble.

```bash
adduser --system --group --home /opt/salon salon
install -d -o salon -g salon /opt/salon/data
```

### 5.4 Upload the code

**Option A — clone from GitHub** (needs a token for a private repo; create one
at GitHub → Settings → Developer settings → Personal access tokens, scope `repo`):

```bash
sudo -u salon git clone https://YOUR_TOKEN@github.com/4Benny/FrizerstvoBerni.git /opt/salon/app
```

**Option B — upload from your PC.** Run this in PowerShell *on your computer*,
not on the server:

```powershell
scp -r C:\Users\robotska\desktop\app root@YOUR_SERVER_IP:/tmp/app
```

Then on the server:

```bash
rm -rf /tmp/app/node_modules /tmp/app/data /tmp/app/.git
mv /tmp/app /opt/salon/app
chown -R salon:salon /opt/salon/app
```

Do not upload `node_modules` (built per-platform — Windows binaries will not run
on Linux) or `data` (your local test database).

### 5.5 Install dependencies

```bash
cd /opt/salon/app
sudo -u salon npm ci --omit=dev
```

### 5.6 Settings and secrets

```bash
openssl rand -hex 32          # copy the output
```

```bash
nano /etc/salon.env
```

```
NODE_ENV=production
PORT=3000
SESSION_SECRET=paste-the-openssl-output-here
SALON_DB=/opt/salon/data/salon.db
ADMIN_PASSWORD=choose-a-strong-password

# SMS. Leave as log until a provider is chosen — see section 7.
SMS_DRIVER=log
#SMS_DLR_SECRET=long-random-value-for-delivery-receipts
```

```bash
chown root:salon /etc/salon.env
chmod 640 /etc/salon.env
```

`ADMIN_PASSWORD` only applies on the very first start, when the database is
created. Changing it later has no effect — use `npm run reset-password` instead.

### 5.7 Run it as a service

```bash
nano /etc/systemd/system/salon.service
```

```ini
[Unit]
Description=Frizerstvo Berni
After=network.target

[Service]
Type=simple
User=salon
Group=salon
WorkingDirectory=/opt/salon/app
EnvironmentFile=/etc/salon.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/salon/data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now salon
systemctl status salon
```

### 5.8 nginx in front

```bash
nano /etc/nginx/sites-available/salon
```

```nginx
server {
    listen 80;
    server_name salon.frizerstvo-berni.si;   # or _ for any host / IP only

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`X-Forwarded-Proto` is not optional: in production the session cookie is marked
`secure`, so the app must be told the connection is HTTPS or nobody can log in.

```bash
ln -sf /etc/nginx/sites-available/salon /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### 5.9 Firewall and HTTPS

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable

apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d salon.frizerstvo-berni.si
```

Port 3000 stays closed from outside; everything arrives through nginx.

---

## 6. Login details

### The first administrator

Created automatically on first start:

| | |
|---|---|
| Username | `admin` |
| Password | `admin123` *(default)* |

That default lives in the code and is meant for local testing only. It applies
when `ADMIN_PASSWORD` is not set. On a server, set `ADMIN_PASSWORD` in
`/etc/salon.env` before the first start, or let `deploy/setup.sh` generate a
random one and print it.

**Change it as soon as you log in:** Zaposleni → Uredi → Ponastavi geslo.

### The demo accounts

First start also creates two example employees so the calendar is not empty:

| Username | Password | Role |
|---|---|---|
| `maja` | same as the admin password | employee |
| `sara` | same as the admin password | employee |

They are demo data. Create real accounts for **Bernarda Hrovat** and **Tjaša**
under Zaposleni, then deactivate `maja` and `sara`. Deactivating blocks login
and keeps their appointments intact.

### Every employee logs in themselves

An admin creates each employee with their own username and password. Employees
see Koledar, Stranke, Storitve and Izdelki; Zaposleni and Nastavitve are
admin-only, and an employee can view services but not change them.

### If you lose the admin password

There is no password reset over the web — deliberately. Recover from the command
line on the server:

```bash
cd /opt/salon/app

# see which accounts exist
sudo -u salon SALON_DB=/opt/salon/data/salon.db npm run accounts

# set a password you choose
sudo -u salon SALON_DB=/opt/salon/data/salon.db \
  node scripts/reset-password.js admin 'novo-geslo'

# or let it generate and print a strong one
sudo -u salon SALON_DB=/opt/salon/data/salon.db \
  node scripts/reset-password.js admin
```

On Windows, from the app folder: `npm run reset-password -- admin novo-geslo`.

If the account was deactivated, this reactivates it.

---

## 7. Setting up SMS

Everything below is configuration. No code changes are needed to send SMS — pick
a provider, set the variables, tick the box.

### How sending works

Saving an appointment **never waits for the gateway**. The message goes into an
outbox in the database and a background worker delivers it a moment later. That
means a slow or broken provider cannot hold up the front desk, and a message
that fails is retried automatically instead of being lost.

One message moves through these states, all visible in **SMS dnevnik**:

| State | Meaning |
|---|---|
| `V vrsti` | queued, the worker will pick it up within seconds |
| `Oddano prehodu` | the gateway accepted it — **not** proof it arrived |
| `Dostavljeno` | a delivery receipt confirmed it reached the handset |
| `Ni dostavljeno` | the gateway reported it did not arrive |
| `Čaka na ponovni poskus` | an attempt failed; it will try again |
| `Neuspešno` | gave up after all attempts |

Retries back off at 1, 5, 15, 60 and 180 minutes, five attempts by default. A
gateway that is briefly unreachable therefore costs nothing.

**Two conditions must both be met before anything is sent:**

1. In Nastavitve, *Pošlji SMS ob naročilu, prestavitvi in odpovedi* is ticked.
2. `SMS_DRIVER` points at a real gateway. The default `log` only writes the
   message to the server log — **nothing reaches a phone.**

Phone numbers are converted automatically before sending, so `031 331 636`
reaches the gateway as `+38631331636`.

### Reminders before the appointment

Nastavitve also has *Pošlji opomnik pred terminom* with a lead time in hours
(24 by default). It is **off by default**, because switching it on adds a paid
message per appointment.

Rules the reminder follows:

- each appointment is reminded **at most once**, safe across restarts;
- an appointment booked *inside* the window gets no reminder, because the
  confirmation it just received already did that job;
- cancelled appointments are skipped.

Reminders compare the appointment time against the server clock, so **the server
timezone must be the salon's timezone**:

```bash
sudo timedatectl set-timezone Europe/Ljubljana
timedatectl                       # check: Time zone: Europe/Ljubljana
```

### The SMS log

**SMS dnevnik** in the top navigation (administrators only) shows every message,
filterable by state and by kind, with the gateway's own error text when
something failed and a **Pošlji znova** button that puts a failed message back
in the queue with a fresh set of attempts. Use this screen rather than the
command line for day-to-day checking.

### About the sender number

**031 331 636 is your own mobile number, and a commercial gateway cannot simply
claim it as the sender.** Providers only let you send from a number bought
through them, or from a text sender name. Slovenia allows text sender names
without pre-registration, so customers can see `Berni` instead of a number.

If messages must genuinely come from 031 331 636, use option A — but read the
warning about which mode to run it in.

### Option A — a phone with the salon SIM

Install an SMS-gateway app on an Android phone holding your SIM. Options:
[httpSMS](https://docs.httpsms.com/),
[textbee](https://github.com/textbee/textbee),
[SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway).

These apps run in one of two modes, and **the mode decides whether sending works
when the phone is away from the salon:**

- **Local mode** — the server calls the phone over the salon network
  (`http://192.168.1.50:8080/…`). The phone must be on salon Wi-Fi. If it leaves,
  sending silently stops.
- **Cloud mode** — the phone connects out to the provider's relay and the server
  calls the relay. The phone works anywhere it has mobile data.

Local mode:

```
SMS_DRIVER=http
SMS_HTTP_URL=http://192.168.1.50:8080/message
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"phoneNumbers":["{{to}}"],"message":"{{text}}"}
SMS_HTTP_USER=sms
SMS_HTTP_PASS=the-password-from-the-app
```

Cloud mode, with httpSMS:

```
SMS_DRIVER=http
SMS_HTTP_URL=https://api.httpsms.com/v1/messages/send
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"from":"+38631331636","to":"{{to}}","content":"{{text}}"}
SMS_HTTP_HEADERS={"x-api-key":"YOUR_KEY"}
SMS_HTTP_ID_PATH=data.id
```

Messages really come from your number, customers can reply to it, and there is
no per-message cost beyond your existing plan. Either way the phone has to stay
on and charged — that is this option's weak point.

### Option B — an A2P provider

The server calls the provider's API and they send. No phone is involved at all,
so sending keeps working whatever happens to your handset. Customers see the
sender name and cannot reply.

```
SMS_DRIVER=http
SMS_HTTP_URL=https://api.provider.si/sms/send
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"to":"{{to}}","text":"{{text}}","from":"{{from}}"}
SMS_HTTP_HEADERS={"Authorization":"Bearer YOUR_TOKEN"}
SMS_HTTP_ID_PATH=messageId
SMS_SENDER=Berni
```

Body shapes differ between providers — match `SMS_HTTP_BODY` to their
documentation. Three placeholders are available: `{{to}}`, `{{text}}`,
`{{from}}`. A separator inside the message is safe: a service name like
`Barvanje & striženje` is escaped correctly in both formats.

For a provider wanting form encoding, set `SMS_HTTP_FORMAT=form` and a body like
`to={{to}}&text={{text}}&sender={{from}}`.

### Option C — Twilio

```
SMS_DRIVER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+386XXXXXXXX
```

### Delivery receipts — knowing a message actually arrived

Without this, the best the app can say is *Oddano prehodu*: the gateway took the
message. To see *Dostavljeno*, let the provider report back.

Set a long random secret and give the provider the matching URL:

```bash
openssl rand -hex 24              # use the output below
```

```
SMS_DLR_SECRET=paste-the-random-output-here
```

The provider's callback URL is then:

```
https://your-domain/sms/dlr/paste-the-random-output-here
```

For Twilio, point `TWILIO_STATUS_CALLBACK` at that same URL and nothing else is
needed — its field names are the defaults. For anyone else, tell the app which
fields to read:

```
SMS_HTTP_ID_PATH=messageId                    # where the id is in the send response
SMS_DLR_ID_FIELD=messageId                    # where the id is in the receipt
SMS_DLR_STATUS_FIELD=status
SMS_DLR_DELIVERED=delivered,DELIVRD
SMS_DLR_FAILED=undelivered,failed,rejected,expired
```

Both `SMS_HTTP_ID_PATH` and `SMS_DLR_ID_FIELD` are needed: the first stores the
gateway's id when sending, the second finds it again in the receipt. Without the
secret set, the endpoint returns 404 and everything else still works — you just
never see *Dostavljeno*.

### Optional tuning

| Variable | Default | Meaning |
|---|---|---|
| `SMS_MAX_ATTEMPTS` | `5` | attempts before giving up |
| `SMS_TICK_MS` | `15000` | how often the outbox is checked |
| `SMS_BATCH` | `5` | messages sent per pass |
| `SMS_REMINDER_TICK_MS` | `300000` | how often reminders are scanned |
| `SMS_HTTP_TIMEOUT_MS` | `10000` | give up on a silent gateway |
| `SMS_COUNTRY_CODE` | `386` | country for local numbers |

### Applying and testing

```bash
sudo nano /etc/salon.env
sudo systemctl restart salon        # required after any change here
npm test                            # 397 checks, no provider needed
```

Then tick the box in Nastavitve and book one appointment for a customer whose
number is your own. Watch it move from *V vrsti* to *Oddano prehodu* in **SMS
dnevnik**.

If sending fails the appointment is still saved, the app retries on its own, and
the gateway's reason is shown in the log. The same data from the command line:

```bash
sudo -u salon sqlite3 /opt/salon/data/salon.db \
  "SELECT created_at, status, attempts, phone, error FROM sms_log ORDER BY id DESC LIMIT 5;"
```

---

## 8. Filling in the salon's own details

Everything the public website shows comes from **Nastavitve** — nothing needs
editing in code. Salon name, slogan, presentation text, logo, address, phone,
email, social links, opening hours, calendar hours, the loyalty rule and the SMS
switch.

**Opening hours** take three forms per weekday: *Odprto* with fixed times,
*Zaprto*, or *Po dogovoru* with your own wording, which appears on the website
in place of times. A "Po dogovoru" day is not shaded in the calendar, since it
has no fixed hours.

**Loyalty:** *Število plačanih striženj do brezplačnega*. At 9, a customer pays
for 9 haircuts and the 10th is free. The visit counter is always manual —
completing an appointment never changes it.

The salon's real content (24 services in 7 categories, presentation text,
opening hours, contact details) is already loaded. To reload it after a fresh
install:

```bash
sudo -u salon SALON_DB=/opt/salon/data/salon.db node tests/import-berni.js
```

That replaces the service list and rewrites those settings, so only run it
deliberately. Services referenced by existing appointments are retired rather
than deleted, keeping old bookings readable.

---

## 9. Backups and restoring

The database is one file, but **never copy it with `cp` while the app runs** —
WAL mode means a plain copy can be inconsistent.

```bash
sudo -u salon sqlite3 /opt/salon/data/salon.db \
  ".backup '/opt/salon/data/backup-$(date +%F).db'"
```

`deploy/setup.sh` installs this as `/usr/local/bin/salon-backup` and schedules
it daily at 02:00 with 30-day retention. Run it now:

```bash
sudo -u salon /usr/local/bin/salon-backup
ls -la /opt/salon/data/
```

**Copy backups off the server.** A backup on the machine that dies is not a
backup. From your PC:

```powershell
scp root@YOUR_SERVER_IP:/opt/salon/data/backup-*.db C:\Users\robotska\Backups\
```

**Restoring:**

```bash
sudo systemctl stop salon
sudo -u salon cp /opt/salon/data/backup-2026-08-17.db /opt/salon/data/salon.db
sudo rm -f /opt/salon/data/salon.db-wal /opt/salon/data/salon.db-shm
sudo systemctl start salon
```

---

## 10. Updating

Update in place — never re-clone. `data/` lives outside the repository, so a
fresh clone would not lose data, but it would throw away the configured remote
and access token for nothing.

```bash
cd /opt/salon/app
sudo -u salon cp /opt/salon/data/salon.db /opt/salon/data/salon-backup.db
sudo -u salon git pull
sudo -u salon npm ci --omit=dev
sudo -u salon SALON_DB=/opt/salon/data/salon.db npm test
sudo systemctl restart salon
```

The `npm test` line runs the upgrade test first, so a schema problem shows up
**before** the service restarts rather than after. It needs no SMS provider and
touches no real data.

The restart is **required** after any CSS or JavaScript change: asset URLs carry
a version token that only changes at startup, and browsers cache them for an
hour otherwise.

Your data is untouched by updates — `data/` is not in the repository. Schema
changes are applied automatically on the first start after an update.

Check the new code is really running:

```bash
journalctl -u salon -n 20 | grep SMS      # expect: [SMS] gonilnik: …
```

---

## 11. Troubleshooting

**Nothing loads at all**

```bash
sudo systemctl status salon
sudo journalctl -u salon -n 50 --no-pager
curl -I http://127.0.0.1:3000/
```

If `curl` works but the browser does not, the problem is nginx or the firewall,
not the app: `sudo nginx -t`, `sudo systemctl status nginx`, `sudo ufw status`.

**Cannot log in over HTTPS, but can over HTTP** — nginx is not passing
`X-Forwarded-Proto`. See section 5.8. The session cookie is `secure` in
production, so without that header the browser never keeps the session.

**"Seja je potekla. Osvežite stran."** — the page was open a long time and its
security token expired. Reload and try again.

**CSS or layout looks wrong after an update** — the service was not restarted;
the browser is still using cached files. `sudo systemctl restart salon`, then
reload with Ctrl+F5.

**SMS says queued but no message arrives** — `SMS_DRIVER` is still `log`. Check
with `grep SMS_DRIVER /etc/salon.env`. Open **SMS dnevnik**: if the message sits
at *Čaka na ponovni poskus*, the error column holds the gateway's own reason.

**Messages stay at "V vrsti" and never move** — the worker starts with the app,
so this means the service is not running the current code. `sudo systemctl
restart salon`, then check `journalctl -u salon -n 30` for the `[SMS] gonilnik:`
line printed at startup.

**Everything says "Oddano prehodu", never "Dostavljeno"** — delivery receipts
are not configured. That is only reporting: the messages are being sent. See
*Delivery receipts* in section 7 to enable it.

**Reminders never go out** — check all four: the box is ticked in Nastavitve,
`SMS_DRIVER` is not `log`, the appointment was booked before the reminder window
opened, and the server timezone is Europe/Ljubljana (`timedatectl`).

**Calendar starts at an odd hour** — an appointment exists outside opening
hours, and the grid deliberately widens so it is never hidden. Not a fault.

**Node too old** — `node -v` must be 22.5 or newer, or `node:sqlite` is missing.

**Check the whole thing still works**

```bash
cd /opt/salon/app && npm test        # 321 checks, uses a throwaway database
```

---

## 12. Before you go live

- [ ] `SESSION_SECRET` is a random value, not the development default
- [ ] the `admin` password has been changed from `admin123`
- [ ] real accounts exist for Bernarda and Tjaša; `maja` and `sara` deactivated
- [ ] `NODE_ENV=production` and the site is served over HTTPS
- [ ] `/etc/salon.env` is mode 640, not world-readable
- [ ] SMS confirmed with one real appointment to a number you control
- [ ] the server timezone is Europe/Ljubljana (`timedatectl`) — reminders
      depend on it
- [ ] you have decided whether reminders before the appointment are on, and
      accepted the extra message per appointment
- [ ] `SMS_DLR_SECRET` is set if you want to see *Dostavljeno* rather than
      only *Oddano prehodu*
- [ ] the logo and emblem show on the public site — an upgraded database
      keeps whatever was saved before, so set them once in Nastavitve if the
      salon name still shows as plain text
- [ ] a backup has run, and a copy exists somewhere other than this server
- [ ] the seven services priced at €0 either have real prices or genuinely are
      "po dogovoru"
- [ ] you have decided whether `frizerstvo-berni.si` should point here, or only
      a subdomain

---

## Quick reference

| Task | Command |
|---|---|
| Start / stop / restart | `sudo systemctl start\|stop\|restart salon` |
| Live log | `sudo journalctl -u salon -f` |
| Edit settings and secrets | `sudo nano /etc/salon.env` |
| List accounts | `npm run accounts` |
| Reset a password | `node scripts/reset-password.js admin 'new'` |
| Back up now | `sudo -u salon /usr/local/bin/salon-backup` |
| Run the tests | `npm test` |
| Database file | `/opt/salon/data/salon.db` |
