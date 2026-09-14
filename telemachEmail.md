# E-pošta za Telemach — vklop SMS Kurir

**Naslovnik:** `kurir@telemach.si`
(naslov je naveden v dokumentaciji KurirWS, poglavje 2.5.1. Če ste v stiku že s
svojim poslovnim skrbnikom pri Telemachu, pošljite kopijo tudi njemu.)

**Priloga:** izpolnjen `Obrazec za vklop storitev SMS-MMS Kurir`

> **Pred pošiljanjem izpolnite vse oznake v oglatih oklepajih.**
> Najpomembnejši je **javni** statični IP naslov strežnika — ne lokalni
> `192.168.x.x`. Dobite ga z ukazom `curl -s ifconfig.me` na strežniku.
> Podrobnosti so v [domain.md](domain.md).

---

**Zadeva:** Vklop storitve SMS Kurir – API dostop (Frizerstvo Berni)

Spoštovani,

zanima nas vklop storitve SMS Kurir z dostopom prek API vmesnika (KurirWS).

Sporočila bi uporabljali izključno za obveščanje lastnih strank o njihovih
terminih: potrditev ob naročilu, opomnik pred terminom, obvestilo o prestavitvi
ali odpovedi ter enkratna koda za potrditev telefonske številke pri spletnem
naročanju. Gre za transakcijska sporočila lastnim strankam, ne za oglaševanje.

V prilogi pošiljamo izpolnjen predprodajni obrazec. Na kratko povzeto:

- predviden obseg: do približno 600 SMS sporočil mesečno, MMS ne potrebujemo;
- pošiljanje Telemachovim uporabnikom in uporabnikom ostalih slovenskih
  operaterjev, na tuje številke ne pošiljamo;
- način dostopa: API vmesnik (lastna aplikacija), spletnega portala ne
  potrebujemo;
- želeni prikazani pošiljatelj: **Berni**;
- dostava Delivery Reportov: DA, format JSON;
- zaračunavanje vsebin končnim uporabnikom: NE.

Prosimo vas za naslednje informacije in potrditve:

**1. Testni dostop.** Prosimo za testni appid in testni certifikat, da pred
prehodom v produkcijo preverimo delovanje povezave. Za testnega pošiljatelja
predlagamo **Berni-TEST**.

**2. Parameter `schedule`.** V dokumentaciji je navedeno, da appid vsebuje
omejitve glede parametra `schedule`. Prosimo za potrditev, da naš appid
dovoljuje `schedule="0"` (brez časovne omejitve). Opomnike pošiljamo tudi zgodaj
zjutraj, zato bi privzeti `schedule="1"` (08:00–21:00) pomenil, da opomnik za
termin ob 8:30 ne bi bil dostavljen pravočasno.

**3. Statični IP naslov.** Dostop do KurirWS bo potekal z naslova
**[JAVNI IP NASLOV STREŽNIKA]**. Prosimo za potrditev, da bo naslov uvrščen na
seznam dovoljenih, in za informacijo, kakšen je postopek, če bi se naslov v
prihodnje spremenil.

**4. Odjemalski certifikat.** Prosimo za navodila glede prevzema certifikata in
za podatek, v kakšni obliki ga izdate (PKCS#12 ali PEM). Certifikat pošljite na
elektronski naslov **[E-POŠTA ZA CERTIFIKAT]**.

**5. URL za povratnice (Kurir Notify).** Povratnice bomo sprejemali na naslovu
**[https://VAŠA-DOMENA/sms/dlr/VAŠ-SKRIVNI-KLJUČ]**, v formatu JSON. Prosimo za
potrditev, da je oblika ustrezna.

**6. Registracija pošiljatelja.** Prosimo za registracijo pošiljatelja **Berni**
(in **Berni-TEST** za testno okolje).

Zanima nas tudi cenik storitve ter kakšno dokumentacijo oziroma pogodbo
potrebujete z naše strani za vklop.

Za dodatna vprašanja smo dosegljivi na spodnjih kontaktih.

Lep pozdrav,

**[IME IN PRIIMEK]**
[Naziv podjetja / s.p.]
[Naslov]
Matična št.: [___] · Davčna št.: [___]
T: [telefon] · E: [e-pošta]

---

## Kaj potrebujete, preden to pošljete

| Podatek | Kje ga dobite |
|---|---|
| **Javni** statični IP strežnika | `curl -s ifconfig.me` na strežniku — glejte [domain.md](domain.md) |
| Domena z veljavnim HTTPS | registrar + `certbot`, [domain.md](domain.md) |
| Skrivni ključ za povratnice | `openssl rand -hex 24`, nato `SMS_DLR_SECRET` v `/etc/salon.env` |
| Matična in davčna številka | iz registracije dejavnosti |
| Kontaktne osebe (4 vloge na obrazcu) | pri enoosebnem s.p. je to povsod ista oseba |

## Kaj pričakujete nazaj

Pogodbo v podpis, **odjemalski certifikat**, **appid** (testni in produkcijski)
ter potrditev registriranega pošiljatelja. Ko to prispe, gre v `/etc/salon.env`
samo še:

```
SMS_DRIVER=telemach
TELEMACH_PFX=/opt/salon/secrets/telemach.p12
TELEMACH_PASSPHRASE=...
TELEMACH_SENDER=Berni
```

Aplikacija je za to že pripravljena — glejte SETUP.md, poglavje 7, *Option D*.
