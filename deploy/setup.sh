#!/usr/bin/env bash
#
# Namestitev aplikacije Frizerski salon Berni na svež strežnik Ubuntu/Debian.
#
# Zagon na strežniku (kot uporabnik s pravico sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/4Benny/FrizerstvoBerni/main/deploy/setup.sh -o setup.sh
#   less setup.sh          # preberite, preden zaženete
#   sudo bash setup.sh
#
# Skript je varen za ponovni zagon: obstoječe baze in gesel ne povozi.
# Ničesar ne izbriše.

set -euo pipefail

REPO="${REPO:-https://github.com/4Benny/FrizerstvoBerni.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="/opt/salon/app"
DATA_DIR="/opt/salon/data"
ENV_FILE="/etc/salon.env"
SERVICE="/etc/systemd/system/salon.service"
NODE_MAJOR="24"
PORT="${PORT:-3000}"

say()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Zaženite kot root: sudo bash setup.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------- vprašanja --

DOMAIN="${DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  read -rp "Domena (na primer salon.frizerstvo-berni.si, prazno = samo IP): " DOMAIN
fi

WANT_TLS="n"
if [[ -n "$DOMAIN" ]]; then
  read -rp "Pridobim potrdilo Let's Encrypt za $DOMAIN? [d/n] " WANT_TLS
fi

# ------------------------------------------------------------------- paketi --

say "Nameščam Node.js ${NODE_MAJOR} in nginx"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
apt-get install -y -qq git nginx sqlite3 ca-certificates

info "node $(node -v), npm $(npm -v)"

# Brez tega ne gre: baza je vgrajena v Node od različice 22.5 naprej.
node -e 'require("node:sqlite")' 2>/dev/null \
  || { echo "Ta Node ne podpira node:sqlite. Potrebna je različica 22.5 ali novejša." >&2; exit 1; }

# ----------------------------------------------------------------- uporabnik --

say "Pripravljam sistemskega uporabnika in mape"
id -u salon >/dev/null 2>&1 || adduser --system --group --home /opt/salon salon
install -d -o salon -g salon /opt/salon "$DATA_DIR"

# ---------------------------------------------------------------------- koda --

if [[ -d "$APP_DIR/.git" ]]; then
  say "Posodabljam kodo"
  sudo -u salon git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u salon git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  say "Prenašam kodo"
  sudo -u salon git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

say "Nameščam odvisnosti"
cd "$APP_DIR"
sudo -u salon npm ci --omit=dev --silent

# ------------------------------------------------------------------ okolje ---

if [[ -f "$ENV_FILE" ]]; then
  say "Nastavitve $ENV_FILE že obstajajo — puščam nespremenjene"
  info "Za urejanje: sudo nano $ENV_FILE"
else
  say "Ustvarjam $ENV_FILE"
  SECRET="$(openssl rand -hex 32)"
  ADMIN_PW="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)"

  cat >"$ENV_FILE" <<EOF
# Nastavitve aplikacije. Po spremembi: sudo systemctl restart salon
NODE_ENV=production
PORT=${PORT}
SESSION_SECRET=${SECRET}
SALON_DB=${DATA_DIR}/salon.db

# Geslo skrbnika velja samo pri prvem zagonu, ko se baza ustvari.
ADMIN_PASSWORD=${ADMIN_PW}

# SMS: privzeto se sporočila samo zapišejo v dnevnik in na telefon ne gre nič.
# Za pravo pošiljanje glejte DEPLOY.md in nastavite spodnje vrstice.
SMS_DRIVER=log
#SMS_DRIVER=http
#SMS_HTTP_URL=http://192.168.1.50:8080/message
#SMS_HTTP_FORMAT=json
#SMS_HTTP_BODY={"phoneNumbers":["{{to}}"],"message":"{{text}}"}
#SMS_HTTP_USER=sms
#SMS_HTTP_PASS=
#SMS_SENDER=Berni
EOF

  chown root:salon "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  ADMIN_PW_SHOWN="$ADMIN_PW"
fi

# ----------------------------------------------------------------- storitev --

say "Nastavljam storitev systemd"
cat >"$SERVICE" <<EOF
[Unit]
Description=Frizerski salon Berni
After=network.target

[Service]
Type=simple
User=salon
Group=salon
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet salon
systemctl restart salon

# ------------------------------------------------------------------- nginx ---

say "Nastavljam nginx"
SERVER_NAME="${DOMAIN:-_}"
cat >/etc/nginx/sites-available/salon <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        # Nujno: piškotek seje je v produkciji secure, zato mora aplikacija
        # vedeti, da povezava teče prek https.
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/salon /etc/nginx/sites-enabled/salon
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# --------------------------------------------------------------- požarni zid --

if command -v ufw >/dev/null 2>&1; then
  say "Odpiram vrata za splet in SSH"
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  info "Vrata ${PORT} ostanejo zaprta od zunaj — dostop gre samo prek nginxa."
fi

# ------------------------------------------------------------------ potrdilo --

if [[ -n "$DOMAIN" && "$WANT_TLS" =~ ^([dDyY])$ ]]; then
  say "Pridobivam potrdilo za $DOMAIN"
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect \
    -m "frizerstvo.berni@gmail.com" || warn "Certbot ni uspel — poskusite ročno: sudo certbot --nginx -d $DOMAIN"
fi

# ------------------------------------------------------- varnostne kopije ----

say "Nastavljam dnevno varnostno kopijo"
cat >/usr/local/bin/salon-backup <<EOF
#!/usr/bin/env bash
# Skladna kopija baze. Navadni cp ni varen, ker baza teče v načinu WAL.
set -euo pipefail
sqlite3 "${DATA_DIR}/salon.db" ".backup '${DATA_DIR}/backup-\$(date +%F).db'"
find "${DATA_DIR}" -name 'backup-*.db' -mtime +30 -delete
EOF
chmod 755 /usr/local/bin/salon-backup

cat >/etc/cron.d/salon-backup <<EOF
# Vsak dan ob 2:00 naredi kopijo baze in obdrži kopije 30 dni.
0 2 * * * salon /usr/local/bin/salon-backup
EOF

# --------------------------------------------------------------- zaključek ---

sleep 2
say "Preverjam"
if systemctl is-active --quiet salon; then
  info "storitev salon: teče"
else
  warn "storitev salon NE teče — dnevnik: sudo journalctl -u salon -n 50"
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || echo 000)"
info "odziv aplikacije: HTTP ${CODE}"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "Končano"
if [[ -n "$DOMAIN" ]]; then
  if [[ "$WANT_TLS" =~ ^([dDyY])$ ]]; then
    info "Spletna stran : https://${DOMAIN}"
    info "Prijava       : https://${DOMAIN}/login"
  else
    info "Spletna stran : http://${DOMAIN}"
    info "Prijava       : http://${DOMAIN}/login"
  fi
else
  info "Spletna stran : http://${IP}"
  info "Prijava       : http://${IP}/login"
fi

if [[ -n "${ADMIN_PW_SHOWN:-}" ]]; then
  echo
  info "Uporabniško ime: admin"
  info "Geslo          : ${ADMIN_PW_SHOWN}"
  warn "Geslo si zapišite zdaj in ga po prvi prijavi zamenjajte."
else
  info "Baza je že obstajala, zato se geslo skrbnika ni spremenilo."
fi

echo
info "Dnevnik            : sudo journalctl -u salon -f"
info "Ponovni zagon      : sudo systemctl restart salon"
info "Nastavitve in SMS  : sudo nano ${ENV_FILE}"
info "Baza (ena datoteka): ${DATA_DIR}/salon.db"
info "Kopija zdaj        : sudo -u salon /usr/local/bin/salon-backup"
