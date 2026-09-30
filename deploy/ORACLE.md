# Trenutna namestitev: Oracle Cloud (Always Free) + Cloudflare

Aplikacija teče na brezplačnem strežniku Oracle Cloud in je dosegljiva na
<https://salon.dormy.si>. Postavljena je bila 30. 9. 2026 s skripto
`deploy/setup.sh`, torej točno tako, kot opisuje [SETUP.md](../SETUP.md).

| Kaj | Vrednost |
| --- | --- |
| Ponudnik | Oracle Cloud Infrastructure, račun Free Tier (nikoli ne kliknite *Upgrade*) |
| Regija | Germany Central (Frankfurt), `eu-frankfurt-1` |
| Instanca | `salon`, oblika `VM.Standard.E2.1.Micro` (Always Free), Ubuntu 24.04 |
| Javni IP | `193.122.61.104` — **rezerviran**, se ne spremeni (to je IP za Telemach) |
| Domena | `salon.dormy.si` (Cloudflare, zona `dormy.si`, A zapis na zgornji IP) |
| HTTPS | Let's Encrypt prek certbota, samodejno podaljševanje |
| Prijava | `ssh -i ~/.ssh/salon_oracle ubuntu@193.122.61.104` (ključ na razvojnem računalniku) |
| Koda | `/opt/salon/app` (git, veja `main`) |
| Baza | `/opt/salon/data/salon.db`, dnevna kopija ob 2:00 (`salon-backup`) |
| Nastavitve | `/etc/salon.env` (SMS je še na `log`) |
| Telemach | certifikat gre v `/opt/salon/secrets/`, potem po [GOLIVE.md](../GOLIVE.md) |

## Požarni zid

Vrata 22, 80 in 443 so odprta na dveh mestih in obe morata ostati:

1. **Oracle → VCN → Default Security List** (ingress pravila 0.0.0.0/0 TCP 22, 80, 443);
2. **iptables na strežniku** (`/etc/iptables/rules.v4`, Oraclova slika privzeto
   zavrne vse razen 22).

## Posodobitev kode

```bash
ssh -i ~/.ssh/salon_oracle ubuntu@193.122.61.104
sudo -u salon git -C /opt/salon/app pull
cd /opt/salon/app && sudo -u salon npm ci --omit=dev
sudo systemctl restart salon
```

Ali preprosto ponovno zaženite `deploy/setup.sh` — je idempotenten in ničesar ne
izbriše.

## Kaj Oracle lahko naredi z brezplačnim strežnikom

Always Free instanco, ki je 7 dni zapored skoraj brez prometa, lahko Oracle
ustavi (ne izbriše). Salon ima dnevni promet, tako da se to ne bi smelo zgoditi;
če se, jo v konzoli samo znova zaženete (*Start*). Baza in nastavitve ostanejo.
