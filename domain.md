# Making the salon app reachable from anywhere

This guide covers the layer underneath [SETUP.md](SETUP.md): getting a domain,
pointing it at the server, and making sure the outside world — customers and
Telemach — can actually reach it. SETUP.md §5.8 and §5.9 then handle nginx and
the HTTPS certificate.

## Contents

1. [Two separate problems](#1-two-separate-problems)
2. [Which IP address is which](#2-which-ip-address-is-which)
3. [Choosing where to run it](#3-choosing-where-to-run-it)
4. [Buying a domain](#4-buying-a-domain)
5. [DNS records](#5-dns-records)
6. [If the server is at the salon: port forwarding](#6-if-the-server-is-at-the-salon-port-forwarding)
7. [Wiring it to the app](#7-wiring-it-to-the-app)
8. [Checking it from outside](#8-checking-it-from-outside)
9. [What Telemach needs, specifically](#9-what-telemach-needs-specifically)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Two separate problems

They look like one problem and they are not. Solving the first does nothing for
the second, which is where most of the confusion here comes from.

**Problem A — people reaching your site.** A customer types
`frizerstvo-berni.si` and must arrive at your server. This is *inbound*: a
domain name, a DNS record, an open port, a certificate.

**Problem B — Telemach recognising your server.** When the app sends an SMS it
*calls out* to Telemach, and Telemach checks the address that call arrives
from against a list fixed in your contract. This is *outbound*, and a domain
name is irrelevant to it. Only the IP matters.

A dynamic-DNS service solves A completely and B not at all. So does a
Cloudflare tunnel. If your public IP changes, SMS sending stops the day it
changes, no matter how well the website works.

---

## 2. Which IP address is which

**Local (LAN) IP** — `192.168.1.50`, `10.0.0.7`, `172.16.x.x`. Assigned by your
router, meaningful only inside the salon. A "static local IP" means your router
always hands the same one to that machine. Useful — it keeps port forwarding
from breaking — but invisible to the outside world.

**Public IP** — what the rest of the internet sees. Every device in the salon
shares it. This is the one Telemach whitelists.

Check them from the server:

```bash
hostname -I          # local: 192.168.x.x
curl -s ifconfig.me  # public: what Telemach would see
```

Run the second one twice a few days apart, and after unplugging the router for
a minute. If the answer changes, your public IP is **dynamic**.

Two things make a home connection unusable for Telemach:

- **Dynamic IP** — most residential and many business lines. It changes on
  reconnect, after an outage, or whenever the ISP feels like it.
- **CGNAT** — your line has no public IP of its own at all; you share one with
  other subscribers. The giveaway: `curl ifconfig.me` returns something that
  does not match the WAN address shown in your router, or the router's WAN
  address itself starts `100.64.`–`100.127.`. Incoming connections are
  impossible and no port forwarding will fix it.

---

## 3. Choosing where to run it

### Option 1 — a VPS (recommended)

A small virtual server from any provider. €4–8 a month buys more than this app
needs.

- A **static public IPv4 is included by definition** — Telemach's requirement is
  met without asking anyone for anything.
- Reachable from anywhere, no port forwarding, no CGNAT, no router involved.
- Stays up when the salon loses power or internet — which is when a customer
  is most likely to be trying to book.
- Backups and snapshots are a click.

Anything with 1 vCPU, 1 GB RAM and 20 GB disk running Ubuntu 22.04 or 24.04 is
plenty. SETUP.md §5 is written for exactly this.

### Option 2 — a machine at the salon, with a static public IP

Workable, but the static public IP is almost always a **paid business add-on**
from the ISP — ask them for "statični javni IP naslov". Without it, skip to
Option 3 and accept that Telemach is off the table.

You also take on: port forwarding, keeping the machine patched and powered,
and the fact that a salon power cut takes the booking site down.

### Option 3 — a machine at the salon, dynamic IP

Fine for the **website only**. Use dynamic DNS (below) so the domain follows
the changing address.

**Telemach will not work on this.** When the IP changes, KurirWS refuses the
connection, every message retries five times over about four hours and then
dies, and SMS dnevnik fills with failures. Nothing warns you in advance. If you
want SMS, use Option 1 or 2.

---

## 4. Buying a domain

`.si` domains are managed by Register.si and sold through accredited
registrars (Domenca, Neoserv, Megabajt and others); €10–15 a year is typical.
Any `.com`/`.eu` registrar works too — the app does not care.

Buy the domain you will actually put on the shop window and on business cards.
Changing it later means re-notifying Telemach about the receipt URL.

Turn on **auto-renew**. An expired domain takes the booking site and the SMS
receipt callback down together.

---

## 5. DNS records

In the registrar's DNS panel, create:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | your server's public IPv4 | 3600 |
| A | `www` | the same IPv4 | 3600 |

`@` means the bare domain. If the panel offers CNAME for `www`, pointing it at
the bare domain is equally fine.

Set TTL to **300** for the first day so mistakes are cheap, then raise it to
3600 once it works.

Delete any parking or redirect records the registrar added, and any stale `A`
record from a previous host — two A records means half your visitors go to the
wrong place, intermittently, which is miserable to debug.

Propagation is usually minutes, occasionally a few hours. Check with:

```bash
dig +short frizerstvo-berni.si
nslookup frizerstvo-berni.si 8.8.8.8
```

### Dynamic DNS, only if you chose Option 3

A DDNS provider (DuckDNS, No-IP, or your router's built-in client) keeps a
hostname pointed at a changing IP. Either use their hostname directly, or point
a `CNAME` from `www` at it. Set TTL to 300 — a long TTL means the stale address
is cached long after the IP moved.

Again: this fixes the website, not Telemach.

---

## 6. If the server is at the salon: port forwarding

In the router, forward to the server's **static local IP**:

| External port | Internal port | Why |
|---|---|---|
| 80 | 80 | HTTP, and Let's Encrypt's domain check |
| 443 | 443 | HTTPS |

**Do not forward port 3000.** The app listens there, but everything from
outside must arrive through nginx — that is what terminates HTTPS and sets the
headers the login session depends on. SETUP.md §5.9 closes 3000 with `ufw`.

**Never forward 22 (SSH) or the database.** If you need remote SSH, use a VPN
or a non-standard port with key-only login.

Reserve the server's local IP in the router's DHCP settings (often "DHCP
reservation" or "static lease") so a reboot cannot move it and silently break
the forward.

---

## 7. Wiring it to the app

Put the real domain in the nginx config from SETUP.md §5.8:

```nginx
server_name frizerstvo-berni.si www.frizerstvo-berni.si;
```

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d frizerstvo-berni.si -d www.frizerstvo-berni.si
```

Certbot needs the domain to already resolve to this server and port 80 to be
reachable — do DNS first, certificate second. Renewal is automatic; confirm it
with `certbot renew --dry-run`.

Then set the public address in `/etc/salon.env` so the app builds correct links
in its pages and messages:

```
BASE_URL=https://frizerstvo-berni.si
```

```bash
systemctl restart salon
```

---

## 8. Checking it from outside

The salon's own Wi-Fi is the one place that can lie to you — some routers
resolve your domain internally and make a broken setup look fine. Test on
mobile data with Wi-Fi off:

- `https://frizerstvo-berni.si` loads the public site
- the padlock is clean, with no certificate warning
- `http://` redirects to `https://`
- `https://www.frizerstvo-berni.si` works too
- `/narocanje` loads and a test booking goes through
- `/app` shows the login page

From the server, confirm the receipt endpoint answers — it must be reachable
from the public internet or Telemach can never report a delivery:

```bash
curl -i https://frizerstvo-berni.si/sms/dlr/wrong-secret
```

`403` is the correct answer: the route exists and rejected a bad secret. `404`
means `SMS_DLR_SECRET` is not set. A timeout means DNS, the firewall or the
port forward is wrong.

---

## 9. What Telemach needs, specifically

**The public IPv4 address**, from `curl -s ifconfig.me` on the server — not the
`192.168.x.x` one, and not the domain. It goes in section 3 of the form
(*Statični IP naslov(i) od koder se bo dostopalo do KurirWS*).

**The receipt URL**, `https://frizerstvo-berni.si/sms/dlr/<SMS_DLR_SECRET>`,
in section 3 and again in section 5. Generate the secret before you fill the
form, so the URL you send is the one that will really work:

```bash
openssl rand -hex 24
```

Use the same value for `SMS_DLR_SECRET` in `/etc/salon.env`. Treat the URL as a
credential — anyone holding it can post fake delivery receipts. The damage is
limited to wrong statuses in SMS dnevnik, but there is no reason to publish it.

The certificate must be **publicly trusted** (Let's Encrypt is). Telemach's
server will not post receipts to a self-signed certificate.

**If the public IP ever changes, tell Telemach before it does.** Sending stops
the moment it moves and only the SMS log will tell you why. This is the whole
argument for a VPS: its address does not change on its own.

---

## 10. Troubleshooting

**The domain does not resolve.** `dig +short yourdomain.si` returns nothing.
DNS has not propagated, or the A record is missing. Check the registrar panel;
wait; confirm you edited DNS at the registrar actually serving the domain (if
you changed nameservers, records live at whoever they point to now).

**It resolves but nothing loads.** Right address, blocked path. Check
`systemctl status nginx`, then `ufw status`, then the router's port forward.
From the server itself `curl -I http://127.0.0.1:3000` should answer — if it
does, the app is fine and the problem is in front of it.

**Certbot fails.** Almost always port 80 unreachable from outside, or DNS not
yet pointing here. Fix those, retry. Let's Encrypt rate-limits repeated
failures, so do not loop on it.

**The site works, SMS fails with a connection or access error.** The public IP
has moved, or was never the one Telemach whitelisted. Compare
`curl -s ifconfig.me` against what you put on the form.

**It works on salon Wi-Fi but not on mobile data.** Your router is answering
DNS internally and hiding a broken public path. Trust the mobile-data test.

**Login works over HTTP but not HTTPS, or not at all.** The session cookie is
`secure` in production; nginx must send `X-Forwarded-Proto` — see SETUP.md §5.8.
