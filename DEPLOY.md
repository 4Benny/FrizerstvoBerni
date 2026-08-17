# Namestitev na strežnik in nastavitev SMS

Dva dela: kako spraviti pošiljanje SMS v delovanje, in kako aplikacijo postaviti
na strežnik, da teče sama.

---

## 1. SMS

Aplikacija pošlje SMS takoj, ko je termin shranjen. Za delovanje sta potrebna
dva pogoja:

1. V **Nastavitve** je vklopljeno *Pošlji SMS ob naročilu, prestavitvi in odpovedi*.
2. Nastavljen je pravi prehod (`SMS_DRIVER`). Privzeti `log` sporočila samo
   zapiše v dnevnik — na telefon ne gre nič.

Telefonske številke se pred pošiljanjem samodejno pretvorijo v mednarodno
obliko: `031 331 636` → `+38631331636`.

### Pomembno o številki pošiljatelja

Številka **031 331 636** je vaša mobilna številka. Komercialni prehod (Twilio in
podobni) je ne more kar navesti kot pošiljatelja — poslati sme le s številke,
ki jo pri njem kupite, ali z besedilnim imenom pošiljatelja. V Sloveniji so
besedilna imena pošiljatelja dinamična, torej jih ni treba vnaprej registrirati,
zato lahko namesto številke piše na primer `Berni`.

Če želite, da sporočila res prihajajo z **031 331 636**, potrebujete možnost A.

### Možnost A — telefon s SIM kartico salona (priporočeno za vašo zahtevo)

Na telefon z vašo SIM kartico namestite aplikacijo, ki ponuja SMS prehod prek
HTTP, na primer [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway),
[textbee](https://github.com/textbee/textbee) ali [httpSMS](https://docs.httpsms.com/).
Telefon ostane v salonu na Wi-Fi omrežju.

Prednosti: sporočila res prihajajo z vaše številke, stranke lahko odgovorijo,
dodatnih stroškov ni — porabijo se SMS iz vašega paketa. Slabost: telefon mora
biti prižgan in povezan.

```bash
SMS_DRIVER=http
SMS_HTTP_URL=http://192.168.1.50:8080/message      # naslov telefona v omrežju
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"phoneNumbers":["{{to}}"],"message":"{{text}}"}
SMS_HTTP_USER=sms
SMS_HTTP_PASS=vase-geslo-iz-aplikacije
```

Telefonu dodelite stalen IP naslov (v usmerjevalniku), da se naslov ne spremeni.

### Možnost B — slovenski A2P prehod z imenom pošiljatelja

Pri ponudniku (Telekom Slovenije, A1, Infobip in podobni) dobite dostop do
API-ja. Pošiljatelj bo `Berni` namesto številke; stranke ne morejo odgovoriti.
Najbolj zanesljivo, plača se na sporočilo.

```bash
SMS_DRIVER=http
SMS_HTTP_URL=https://api.ponudnika.si/sms/send
SMS_HTTP_FORMAT=json
SMS_HTTP_BODY={"to":"{{to}}","text":"{{text}}","from":"{{from}}"}
SMS_HTTP_HEADERS={"Authorization":"Bearer VAS_ZETON"}
SMS_SENDER=Berni
```

Oblika telesa se med ponudniki razlikuje — prilagodite `SMS_HTTP_BODY` njihovi
dokumentaciji. Uporabite `{{to}}`, `{{text}}` in `{{from}}`; vrednosti se
pravilno ubežijo, tudi če ime stranke vsebuje narekovaj. Za ponudnike, ki
zahtevajo `application/x-www-form-urlencoded`, nastavite `SMS_HTTP_FORMAT=form`
in telo kot `recipient={{to}}&body={{text}}`.

### Možnost C — Twilio

```bash
SMS_DRIVER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+386XXXXXXXX        # številka, kupljena pri Twiliu
```

### Preverjanje

```bash
npm run test:sms      # 36 preverjanj: pretvorba številk in prehod HTTP
```

Po nastavitvi ustvarite en termin na stranko z vašo lastno številko. Če
sporočilo ne uspe, aplikacija termin vseeno shrani, pokaže
*„SMS ni bilo mogoče poslati.“* in ponudi gumb **Poskusi znova**. Vzrok
je zapisan v tabeli `sms_log` v stolpcu `error`.

---

## 2. Namestitev na strežnik

Predpostavka: Ubuntu 24.04 na navadnem VPS. Deluje tudi na Windows strežniku —
glejte opombo na koncu.

### Kaj potrebujete

- Node.js 22.5 ali novejši (24 je priporočen)
- domeno, usmerjeno na strežnik, če želite `https`
- nič drugega — baza je datoteka, ločen strežnik za bazo ni potreben

### Koraki

```bash
# 1. Node.js
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx

# 2. Uporabnik brez pravic in koda
sudo adduser --system --group --home /opt/salon salon
sudo -u salon git clone https://github.com/4Benny/FrizerstvoBerni.git /opt/salon/app
cd /opt/salon/app
sudo -u salon npm ci --omit=dev
```

### Skrivnosti

```bash
# Ustvarite naključni ključ za seje
openssl rand -hex 32
```

Zapišite `/etc/salon.env` (brez narekovajev, ena vrstica na nastavitev):

```
NODE_ENV=production
PORT=3000
SESSION_SECRET=<izpis ukaza openssl>
ADMIN_PASSWORD=<geslo za prvi zagon>
SALON_DB=/opt/salon/data/salon.db
SMS_DRIVER=http
SMS_HTTP_URL=...
SMS_HTTP_BODY=...
```

```bash
sudo chown root:salon /etc/salon.env
sudo chmod 640 /etc/salon.env          # gesla naj ne bodo berljiva vsem
sudo install -d -o salon -g salon /opt/salon/data
```

`ADMIN_PASSWORD` velja samo pri prvem zagonu, ko se baza šele ustvari.

### Storitev systemd

`/etc/systemd/system/salon.service`:

```ini
[Unit]
Description=Frizerski salon Berni
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

# Utrjevanje
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/salon/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now salon
sudo systemctl status salon
sudo journalctl -u salon -f        # dnevnik, tudi zapisi [SMS -> …]
```

### nginx in potrdilo

`/etc/nginx/sites-available/salon`:

```nginx
server {
    server_name frizerstvo-berni.si www.frizerstvo-berni.si;

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

```bash
sudo ln -s /etc/nginx/sites-available/salon /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d frizerstvo-berni.si -d www.frizerstvo-berni.si
```

`X-Forwarded-Proto` je pomemben: v produkciji je piškotek seje `secure`, zato
mora aplikacija vedeti, da povezava teče prek `https`.

Požarni zid:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Vrata 3000 naj ostanejo zaprta od zunaj — dostop gre samo prek nginxa.

### Varnostne kopije

Celotna baza je ena datoteka, a med delovanjem uporablja WAL, zato je ne
kopirajte z `cp`. Uporabite `.backup`, ki naredi skladno kopijo:

```bash
sudo apt-get install -y sqlite3
sudo -u salon sqlite3 /opt/salon/data/salon.db \
  ".backup '/opt/salon/data/backup-$(date +%F).db'"
```

V `crontab -u salon -e` za dnevno kopijo ob 2:00 in hrambo 30 dni:

```
0 2 * * * sqlite3 /opt/salon/data/salon.db ".backup '/opt/salon/data/backup-$(date +\%F).db'" && find /opt/salon/data -name 'backup-*.db' -mtime +30 -delete
```

Kopije nato odnesite še na drug računalnik — kopija na istem strežniku ne
pomaga, če strežnik odpove.

### Posodobitev

```bash
cd /opt/salon/app
sudo -u salon git pull
sudo -u salon npm ci --omit=dev
sudo systemctl restart salon
```

Ponovni zagon je obvezen tudi po spremembi CSS ali JavaScripta: naslovi datotek
nosijo oznako različice, ki se osveži ob zagonu. Baza se ob posodobitvi ne
spremeni — `data/` ni v repozitoriju.

### Windows strežnik

Namestite Node.js, klonirajte repozitorij, `npm ci --omit=dev`, nato aplikacijo
registrirajte kot storitev z [NSSM](https://nssm.cc/): program `node`,
argument `server.js`, delovna mapa mapa aplikacije, okoljske spremenljivke pa
vnesite v zavihku *Environment*. Pred aplikacijo postavite IIS ali nginx za
Windows na enak način kot zgoraj.

---

## Pred prvim pravim zagonom

- [ ] `SESSION_SECRET` je naključen, ne privzeta vrednost
- [ ] geslo računa `admin` je zamenjano
- [ ] za vsakega zaposlenega obstaja svoj račun; demo računa `maja` in `sara`
      sta deaktivirana
- [ ] `NODE_ENV=production`, dostop teče prek `https`
- [ ] SMS prehod preverjen z enim pravim terminom
- [ ] varnostna kopija se izdeluje in se prenaša tudi drugam
