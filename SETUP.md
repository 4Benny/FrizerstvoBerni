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
SMS_DRIVER=log
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

The app sends an SMS the moment an appointment is saved, and again on
rescheduling and on cancellation when the box is ticked. **Two conditions must
both be met:**

1. In Nastavitve, *Pošlji SMS ob naročilu, prestavitvi in odpovedi* is ticked.
2. `SMS_DRIVER` points at a real gateway. The default `log` only writes the
   message to the server log — **nothing reaches a phone.**

Phone numbers are converted automatically before sending, so `031 331 636`
reaches the gateway as `+38631331636`.

### About the sender number

**031 331 636 is your own mobile number, and a commercial gateway cannot simply
claim it as the sender.** Providers only let you send from a number bought
through them, or from a text sender name. Slovenia allows text sender names
without pre-registration, so customers can see `Berni` instead of a number.

If you want messages to genuinely come from 031 331 636, use option A.

### Option A — a phone with the salon SIM

Install an SMS-gateway app on an Android phone holding your SIM and leave it in
the salon on Wi-Fi. Options:
[SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway),
[textbee](https://github.com/textbee/textbee),
[httpSMS](https://docs.httpsms.com/).

Messages really come from your number, customers can reply to it, and there is
no per-message cost beyond your existing plan. The phone has to stay on and
reachable from the server.

```
SMS_DRIVER=http
SMS_HTTP_URL=http://192.168.1.50:8080/message
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"phoneNumbers":["{{to}}"],"message":"{{text}}"}
SMS_HTTP_USER=sms
SMS_HTTP_PASS=the-password-from-the-app
```

Give the phone a fixed IP in your router so the address does not change. Note
that a server in a data centre cannot reach a phone on the salon's home
network — for this option the app usually runs on a computer in the salon, or
the phone uses a gateway app with a cloud relay.

### Option B — a Slovenian SMS provider

Telekom Slovenije, A1, Infobip and others. Most reliable, sender shows as
`Berni`, customers cannot reply, billed per message.

```
SMS_DRIVER=http
SMS_HTTP_URL=https://api.provider.si/sms/send
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"to":"{{to}}","text":"{{text}}","from":"{{from}}"}
SMS_HTTP_HEADERS={"Authorization":"Bearer YOUR_TOKEN"}
SMS_SENDER=Berni
```

Body shapes differ between providers — match `SMS_HTTP_BODY` to their
documentation using the placeholders `{{to}}`, `{{text}}` and `{{from}}`. Values
are escaped correctly even if a customer's name contains a quote. For providers
wanting form encoding, set `SMS_HTTP_FORMAT=form` and a body like
`recipient={{to}}&body={{text}}`.

### Option C — Twilio

```
SMS_DRIVER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+386XXXXXXXX
```

### Applying and testing

```bash
sudo nano /etc/salon.env
sudo systemctl restart salon        # required after any change here
npm run test:sms                    # 36 checks, no provider needed
```

Then tick the box in Nastavitve and book one appointment for a customer whose
number is your own.

If sending fails, the appointment is still saved — the app shows *„SMS ni bilo
mogoče poslati.“* with a **Poskusi znova** button. The reason is recorded:

```bash
sudo -u salon sqlite3 /opt/salon/data/salon.db \
  "SELECT created_at, status, phone, error FROM sms_log ORDER BY id DESC LIMIT 5;"
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

```bash
cd /opt/salon/app
sudo -u salon git pull
sudo -u salon npm ci --omit=dev
sudo systemctl restart salon
```

The restart is **required** after any CSS or JavaScript change: asset URLs carry
a version token that only changes at startup, and browsers cache them for an
hour otherwise.

Your data is untouched by updates — `data/` is not in the repository.

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

**SMS says sent but no message arrives** — `SMS_DRIVER` is still `log`. Check
with `grep SMS_DRIVER /etc/salon.env`.

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
