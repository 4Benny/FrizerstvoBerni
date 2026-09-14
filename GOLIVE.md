# Go-live: the day Telemach approves

Everything in the app is already built and tested. This is the ordered list of
what to do when the certificate arrives, start to finish, about an hour of work
if the server is already running.

Related: [SETUP.md](SETUP.md) §7 for the SMS detail, [domain.md](domain.md) for
the domain and the public IP, [telemachEmail.md](telemachEmail.md) for what you
sent them.

---

## Before the reply arrives

These do not depend on Telemach. Doing them first means the go-live day is only
the certificate.

- [ ] **Server running** with the app on it — SETUP.md §5.
- [ ] **Domain resolving**, HTTPS certificate valid, site reachable on mobile
      data with Wi-Fi off — domain.md §8.
- [ ] **Timezone set** — reminders compare against the server clock:
      ```bash
      sudo timedatectl set-timezone Europe/Ljubljana
      ```
- [ ] **`SMS_DLR_SECRET` generated** and already in `/etc/salon.env` — it had to
      be, because the receipt URL went on the form.
- [ ] **Receipt endpoint answering** from outside:
      ```bash
      curl -i https://your-domain/sms/dlr/wrong-secret     # expect 403
      ```
- [ ] **Salon details filled in** under Nastavitve — the salon name appears at
      the start of every message.
- [ ] **Backups running** — SETUP.md §10.

Confirm the state of the app itself at any point:

```bash
npm run sms-check
```

It will report the `log` driver and that sending is switched off. That is
correct until the day below.

---

## What Telemach sends you

| What | Where it goes |
|---|---|
| Client certificate (`.p12`, or `.crt` + `.key`) | `/opt/salon/secrets/` |
| Certificate passphrase | `TELEMACH_PASSPHRASE` |
| Production `appid` | usually `kurir`, the default |
| Test `appid` | `TELEMACH_APPID` while testing |
| Confirmation the sender `Berni` is registered | nothing to configure |

If any is missing, ask before starting — particularly the test appid, which is
what lets you prove the connection works without sending real messages.

---

## Step 1 — install the certificate

```bash
sudo mkdir -p /opt/salon/secrets
sudo chown root:salon /opt/salon/secrets
sudo chmod 750 /opt/salon/secrets

# copy the file Telemach sent into place, then:
sudo chown root:salon /opt/salon/secrets/telemach.p12
sudo chmod 640 /opt/salon/secrets/telemach.p12
```

The permissions matter. A certificate only root can read is the classic
go-live failure: everything looks right, and every message dies hours later
with a permission error nobody is watching for.

Check it is really the certificate you think it is:

```bash
openssl pkcs12 -info -in /opt/salon/secrets/telemach.p12 -noout
```

## Step 2 — configuration

```bash
sudo nano /etc/salon.env
```

Paste the block from [`deploy/telemach.env.example`](deploy/telemach.env.example)
and fill in the four `<...>` values. **Start on the test appid:**

```
TELEMACH_APPID=<the-test-appid-from-telemach>
```

```bash
sudo systemctl restart salon
```

A restart is required — the driver is read once at startup.

## Step 3 — preflight

```bash
sudo -u salon SALON_DB=/opt/salon/data/salon.db \
  node /opt/salon/app/scripts/sms-check.js
```

It checks the certificate is readable by the service user, the sender is a
length Telemach accepts, the schedule will not hold messages back, the
receipt URL, the timezone, and whether anything is stuck in the outbox. Fix
every `[FAIL]` before going further; warnings are judgement calls.

Sending is still switched off in Nastavitve at this point, and that is fine —
the next step goes around it deliberately.

## Step 4 — one test message

Still on the **test** appid, so nothing reaches a handset:

```bash
sudo -u salon SALON_DB=/opt/salon/data/salon.db \
  node /opt/salon/app/scripts/sms-check.js --send 031331636
```

What you want to see is `the gateway accepted it` with a message id. That
proves the certificate, the IP whitelist, the sender registration and the
endpoint are all correct — which is everything that can go wrong at the
Telemach end.

If it fails, the reason comes straight from Telemach:

| Reason | Means |
|---|---|
| `ACCESS_ERROR` | the IP is not whitelisted, or the certificate is wrong |
| `PARAMETER_ERROR` | usually the sender is not registered, or the appid is wrong |
| connection refused / timeout | firewall outbound, or the wrong endpoint |
| `cannot be read` from the preflight | file permissions — step 1 |

Check the public IP really is the one on the form:

```bash
curl -s ifconfig.me
```

## Step 5 — switch to production

Remove or comment out the test appid so it falls back to `kurir`:

```bash
sudo nano /etc/salon.env       # comment out TELEMACH_APPID
sudo systemctl restart salon
```

Send one more test, to your own phone, and **wait for it to arrive**:

```bash
sudo -u salon SALON_DB=/opt/salon/data/salon.db \
  node /opt/salon/app/scripts/sms-check.js --send <your-own-number>
```

Check the handset. Then open **SMS dnevnik** and watch the row move from
*Oddano prehodu* to *Dostavljeno* — that second change is the proof that Kurir
Notify is reaching your server. It usually takes seconds.

If it stays on *Oddano prehodu* the message still arrived; only the receipt
path is broken. Check `SMS_DLR_SECRET` matches the URL Telemach has, that the
URL is publicly reachable, and that you asked for JSON rather than XML.

## Step 6 — turn it on for real

In **Nastavitve**:

- [ ] tick **Pošlji SMS ob naročilu, prestavitvi in odpovedi**
- [ ] leave **Pošiljaj brez šumnikov** ticked — one `š` doubles the bill
- [ ] decide on **Pošlji opomnik pred terminom**; 24 hours is the default, and
      it roughly doubles the monthly volume

Then book a real appointment for a customer whose number is your own, and watch
it go out.

## Step 7 — the first week

- [ ] Day 1: open SMS dnevnik and confirm messages are reaching *Dostavljeno*,
      not stopping at *Oddano prehodu*.
- [ ] Day 2: if reminders are on, confirm one actually went out the morning of
      an appointment, at the right hour.
- [ ] Day 7: check the failed and undelivered filters. A few undelivered
      messages are normal — wrong numbers, phones off for days. A pattern is
      not.
- [ ] Compare Telemach's first invoice against the message count in the log.

---

## Rolling back

If anything goes wrong, sending can be stopped in seconds without touching the
server: untick **Pošlji SMS ob naročilu, prestavitvi in odpovedi** in
Nastavitve. Appointments keep saving normally; nothing is queued.

To go back to sending nothing at all while keeping the appointment side
running, set `SMS_DRIVER=log` and restart. Messages are then written to the
server log and recorded in SMS dnevnik, exactly as before Telemach.

---

## Things that will bite later

**The public IP changes.** Sending stops the same day and only SMS dnevnik
says why. Tell Telemach *before* a planned change; if it happens unplanned,
send them the new address and expect a short outage.

**The certificate expires.** Ask Telemach for the expiry date when they issue
it and put a reminder in the calendar a month before. Check it any time with:

```bash
openssl pkcs12 -in /opt/salon/secrets/telemach.p12 -nodes 2>/dev/null \
  | openssl x509 -noout -enddate
```

**The domain expires.** Takes the booking site and the receipt callback down
together. Auto-renew.

**Volume grows past what you declared.** 600 a month was the estimate on the
form. If the salon gets busier, tell Telemach before hitting the ceiling.
