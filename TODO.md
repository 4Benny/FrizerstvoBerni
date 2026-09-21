# TODO — SMS Kurir, from nothing to sending

Four stages. Do them in order. Details live in
[domain.md](domain.md), [telemachEmail.md](telemachEmail.md),
[SETUP.md](SETUP.md) §7 and [GOLIVE.md](GOLIVE.md).

---

## 1. Before the email

Nothing here involves Telemach. All of it has to be true before the form
makes sense.

- [ ] **Decide where the server runs.** A VPS (€4–8/month) — it has a static
      public IP, which Telemach requires. A salon line with a changing IP
      will not work.
- [ ] **Buy the domain**, turn on auto-renew.
- [ ] **Install the app on the server** — SETUP.md §5, or `deploy/setup.sh`.
- [ ] **Point the domain at it**, add HTTPS:
      ```bash
      certbot --nginx -d your-domain.si -d www.your-domain.si
      ```
- [ ] **Set the timezone:**
      ```bash
      sudo timedatectl set-timezone Europe/Ljubljana
      ```
- [ ] **Write down the public IP** — this exact number goes on the form:
      ```bash
      curl -s ifconfig.me
      ```
- [ ] **Make the receipt secret** and put it in `/etc/salon.env` as
      `SMS_DLR_SECRET=`:
      ```bash
      openssl rand -hex 24
      ```
- [ ] **Restart, then check the receipt URL answers 403:**
      ```bash
      sudo systemctl restart salon
      curl -i https://your-domain.si/sms/dlr/wrong-secret
      ```
      403 = correct. 404 = the secret is not set. Timeout = DNS or firewall.
- [ ] **Test the site on mobile data, Wi-Fi off.** Salon Wi-Fi can hide a
      broken setup.
- [ ] **Fill in the salon details** under Nastavitve.
- [ ] **Have ready:** matična št., davčna št., your phone, your e-mail,
      working hours, and 1–2 mobile numbers for their delivery tests.

---

## 2. The form

Open `Obrazec za vklop storitev SMS-MMS Kurir 4-2025 FILL.pdf`
(in `C:\Users\robotska\desktop\sms`) and fill it exactly like this.

**1. Količina**
- Max SMS (mesečno): **600**
- Max MMS (mesečno): **0**
- Telemachovim uporabnikom: **DA**
- Ostalim slovenskim operaterjem: **DA**
- Na tuje številke: **NE**

**2. Prikazana številka**
- **Berni**

**3. Tehnične informacije**
- Statični IP: **your public IP** (from stage 1)
- Spletni vmesnik: **NE**
- API vmesnik: **DA**
- Delivery Reporti: **DA**
- Format DR: **JSON**
- URL za DR: **https://your-domain.si/sms/dlr/YOUR-SECRET**
- Zaračunavanje vsebin: **NE** → leave the two commercial-content lines blank

**4. Kontakti** — the same person in all four roles:
reklamacije · koordinacija pogodbe · tehnična vprašanja · potrjevanje obračuna.
Then delovni čas, telefon, e-mail.

**5. Testni dostop**
- Potrebujete testni dostop: **DA**
- Statični IP za testiranje: *leave blank* (same as above)
- E-naslov za certifikat: **your e-mail**
- MSISDN za testiranje: **your mobile number**
- Testni pošiljatelj: **Berni-TEST**
- URL za povratnice: **the same URL as in section 3**

---

## 3. The email

- [ ] Open [telemachEmail.md](telemachEmail.md) and replace every `[BRACKET]`:
      public IP, receipt URL, e-mail for the certificate, name, company,
      address, matična št., davčna št., phone.
- [ ] Send to **kurir@telemach.si**, attach the filled form.
      Copy your Telemach business contact if you have one.
- [ ] It asks them for: price list, contract, **test appid**, confirmation
      that **`schedule="0"`** is allowed, certificate format and **expiry
      date**, and what to do if the IP changes. Do not drop these.

Expect back: contract, client certificate + passphrase, production appid,
test appid, sender `Berni` registered.

---

## 4. Switch-on day

Full version in [GOLIVE.md](GOLIVE.md). Short version:

- [ ] **Install the certificate:**
      ```bash
      sudo mkdir -p /opt/salon/secrets
      sudo chown root:salon /opt/salon/secrets && sudo chmod 750 /opt/salon/secrets
      # copy the file in, then:
      sudo chown root:salon /opt/salon/secrets/telemach.p12
      sudo chmod 640 /opt/salon/secrets/telemach.p12
      ```
- [ ] **Configure:** paste `deploy/telemach.env.example` into `/etc/salon.env`,
      fill in the values, set `TELEMACH_APPID=<test-appid>` for now.
      ```bash
      sudo systemctl restart salon
      ```
- [ ] **Preflight:**
      ```bash
      npm run sms-check
      ```
      Fix every `[FAIL]`.
- [ ] **Test send** (test appid — nothing reaches a phone):
      ```bash
      sudo -u salon SALON_DB=/opt/salon/data/salon.db \
        node /opt/salon/app/scripts/sms-check.js --send 031331636
      ```
      You want `the gateway accepted it`.
- [ ] **Go production:** comment out `TELEMACH_APPID`, restart, send once more
      to your own phone and **wait for it to arrive**.
- [ ] **Watch SMS dnevnik**: the row must reach *Dostavljeno*, not stop at
      *Oddano prehodu*.
- [ ] **Turn it on** in Nastavitve: tick *Pošlji SMS ob naročilu, prestavitvi
      in odpovedi*, leave *Pošiljaj brez šumnikov* ticked, decide on the
      reminder (it doubles the monthly count).
- [ ] Book one real appointment with your own number and watch it go out.

**To stop sending at any time:** untick the box in Nastavitve. Nothing else
breaks.

---

## Nothing to code

The Telemach driver, the receipt endpoint, the outbox with retries, the SMS
log and the preflight are already written and tested. This whole list is
configuration.
