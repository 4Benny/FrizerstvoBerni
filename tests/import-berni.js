'use strict';
/**
 * One-off import of the salon's own content, taken from frizerstvo-berni.si:
 * services with their categories, the presentation text, opening hours and
 * contact details. Safe to re-run — it replaces the service list rather than
 * appending to it.
 *
 *   node tests/import-berni.js
 */

const path = require('path');
const { db } = require(path.join(__dirname, '..', 'src', 'db'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const services = require(path.join(__dirname, '..', 'src', 'repo', 'services'));

const ABOUT = [
  'Z vami že od leta 2008.',
  'V našem salonu svojim strankam zagotavljamo predanost, inovativnost in natančnost. Skozi leta pridobljene izkušnje nenehno nadgrajujemo s konstantnim izobraževanjem. Skupaj z vami vedno znova odkrivamo skrivnosti lepote las v dobrem počutju in užitku čudovite frizure. V našem salonu vam nudimo vrhunske frizerske storitve za ženske, moške in otroke, kreativno barvanje, profesionalno oblikovanje obrvi ter parafinsko kopel za nego rok.',
  'Pri nas poskrbimo za vsak tip las.',
  'Za popolno nego in nevsiljivo utrjevanje las poskrbimo s profesionalno lasno kozmetiko SUBRINA PROFESSIONAL, ki vsebuje veliko naravnih ekstraktov zelišč. Produkti ne vsebujejo sulfatov in parabenov ter so zato izjemno nežni do las in lasišča.',
  'Za občutljiva lasišča nudimo barve ECHOES, ki so popolnoma brez amonijaka ter blago učinkujejo na kožo brez dražilnih učinkov. Barve so brez vonja, 100 % prekrijejo sive lase. Vsebujejo organsko kakavovo maslo, karitejevo maslo, mangovo maslo, kukui olje in kokosovo olje. Ne vsebujejo parabenov, silikonov, parfuma, etanola in ostalih alergenih snovi. Lasje so po uporabi barve ECHOES sijoči, neizsušeni in zaščiteni pred poškodbami sonca. Moškim priporočamo barvo LISAP MAN, ki pokrije sive lase že v nekaj minutah. Rezultat je naraven videz las, barva pa postopoma izgine po petih tednih, tako da ni nezaželenega narastka.',
  'Za lepotni ritual priporočamo ECHOES šampon in balzam, ki poudari sijaj barv ter nežno in učinkovito očisti lase in lasišče. Edinstvena mešanica petih vrst naravnega masla in olja prodre globoko v lase, jih od znotraj nahrani in zmanjša razcepljene konice. Priporočamo tudi ORIFLUIDO, ki vsebuje olje ojstrice, laneno olje in arganovo olje — negovalna kolekcija globinsko vlaži in krepi lase ter jim povrne sijaj. Stranke razvajamo tudi s PARAFINSKO NEGO ROK, ki odlično poskrbi za suho in razpokano kožo ter je pravo olajšanje za morebitne bolečine in revmo.',
  'Tukaj smo za vas.',
  'Frizerstvo Berni se nahaja na Iršičevi ulici 15 v neposredni bližini dvorane Vinka Cajnka in ima zagotovljeno brezplačno parkirišče. V salonu je na razpolago Wi-Fi dostopna točka za brezplačni brezžični internet.',
].join('\n\n');

// name, minutes, euros (0 = price on request), category
const SERVICES = [
  ["MOŠKO MODERNO striženje, umivanje in sušenje", 45, 24.0, 'STRIŽENJE LAS'],
  ["Žensko striženje in fen frizura – kratki lasje (do nosu)", 60, 35.5, 'STRIŽENJE LAS'],
  ["Žensko striženje in fen frizura – srednje dolgi lasje (do brade)", 90, 45.0, 'STRIŽENJE LAS'],
  ["Žensko striženje in fen frizura – dolgi lasje", 110, 52.0, 'STRIŽENJE LAS'],
  ["Moško komplet striženje z masažo lasišča Byuti Flow", 60, 37.0, 'STRIŽENJE LAS'],
  ["MOŠKO MODERNO, FADE STRIŽENJE", 30, 15.0, 'STRIŽENJE LAS'],

  ["Komplet barvanje, striženje in fen frizura – kratki lasje (do nosu)", 120, 62.0, 'BARVANJE LAS'],
  ["Komplet barvanje, striženje in fen frizura – srednje dolgi lasje (do ramen)", 150, 75.0, 'BARVANJE LAS'],
  ["Komplet barvanje, striženje in fen frizura – dolgi lasje", 180, 0, 'BARVANJE LAS'],
  ["MOŠKO komplet BARVANJE ali prameni", 90, 48.0, 'BARVANJE LAS'],

  ["Komplet fen ali vodna frizura – kratki lasje (do nosu)", 45, 20.5, 'FEN FRIZURE'],
  ["Komplet fen ali vodna frizura – srednje dolgi lasje (do brade)", 75, 28.0, 'FEN FRIZURE'],
  ["Komplet fen ali vodna frizura – dolgi lasje", 90, 34.0, 'FEN FRIZURE'],

  ["Svečana frizura – kratki lasje (do nosu)", 60, 0, 'SVEČANA PRIČESKA'],
  ["Svečana frizura – srednje dolgi lasje (do brade)", 90, 0, 'SVEČANA PRIČESKA'],
  ["Komplet trajna, striženje, fen frizura – dolgi lasje", 120, 0, 'SVEČANA PRIČESKA'],

  ["Komplet prameni, striženje, fen – kratki lasje (do nosu)", 135, 0, 'PRAMENI'],
  ["Komplet prameni narastek, striženje in fen frizura – srednje dolgi lasje (do brade)", 170, 0, 'PRAMENI'],
  ["Komplet prameni ali bayalage, striženje in fen frizura – dolgi lasje", 200, 0, 'PRAMENI'],

  ["Barvanje in oblikovanje obrvi", 15, 5.0, 'OBLIKOVANJE OBRVI'],

  ["MOŠKA masaža lasišča Byuti Flow (30 min)", 30, 22.0, 'MASAŽA LASIŠČA BYUTI FLOW'],
  ["MOŠKA masaža lasišča Byuti Flow (45 min)", 45, 32.0, 'MASAŽA LASIŠČA BYUTI FLOW'],
  ["ŽENSKA masaža lasišča Byuti Flow – kratki lasje", 75, 50.0, 'MASAŽA LASIŠČA BYUTI FLOW'],
  ["ŽENSKA masaža lasišča Byuti Flow – srednje dolgi lasje", 90, 60.0, 'MASAŽA LASIŠČA BYUTI FLOW'],
];

/* --------------------------------------------------------------- settings */

settings.setMany({
  salon_name: 'Frizerstvo Berni',
  slogan: 'Frizerske storitve za ženske, moške in otroke',
  about: ABOUT,
  address: 'Iršičeva ulica 15',
  city: '2380 Slovenj Gradec',
  phone: '+386 31 331 636',
  email: 'frizerstvo.berni@gmail.com',
  logo_url: '/img/logo.png',
  emblem_url: '/img/emblem.jpg',
  // Ponedeljek, sreda, petek 8–14 · torek, četrtek 8–18 · sobota 8–12 · nedelja zaprto
  opening_hours: JSON.stringify({
    1: { mode: 'open', open: '08:00', close: '14:00', text: '' },
    2: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    3: { mode: 'open', open: '08:00', close: '14:00', text: '' },
    4: { mode: 'open', open: '08:00', close: '18:00', text: '' },
    5: { mode: 'open', open: '08:00', close: '14:00', text: '' },
    6: { mode: 'open', open: '08:00', close: '12:00', text: '' },
    0: { mode: 'closed', open: '', close: '', text: '' },
  }),
  calendar_start: '07:00',
  calendar_end: '19:00',
});

/* --------------------------------------------------------------- services */

// Keep any service that an appointment already refers to, so history stays
// readable; simply retire it instead of deleting the row.
const referenced = new Set(
  db.prepare('SELECT DISTINCT service_id FROM appointments WHERE service_id IS NOT NULL')
    .all()
    .map((r) => r.service_id)
);

let retired = 0;
let removed = 0;
for (const existing of services.list()) {
  if (referenced.has(existing.id)) {
    services.update(existing.id, { ...existing, active: 0 });
    retired++;
  } else {
    db.prepare('DELETE FROM services WHERE id = ?').run(existing.id);
    removed++;
  }
}

let order = 0;
for (const [name, minutes, euros, category] of SERVICES) {
  order += 1;
  services.create({
    name,
    description: category,
    duration_min: minutes,
    price_cents: Math.round(euros * 100),
    active: 1,
    sort_order: order,
  });
}

const active = services.active();
console.log(`services: ${removed} removed, ${retired} retired, ${active.length} imported`);
console.log(`categories: ${[...new Set(active.map((s) => s.description))].length}`);
console.log(`price on request: ${active.filter((s) => s.price_cents === 0).length}`);

const s = settings.all();
console.log(`\nsalon      : ${s.salon_name}`);
console.log(`address    : ${s.address}, ${s.city}`);
console.log(`phone      : ${s.phone}`);
console.log(`email      : ${s.email}`);
console.log(`about      : ${s.about.length} characters`);
console.log('hours      :');
for (const day of settings.openingHoursList()) {
  console.log(`  ${day.name.padEnd(12)} ${day.label}`);
}
