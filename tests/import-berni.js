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

// name, minutes, euros (0 = price on request), category, description for the
// price list. The description leaves the duration out, because the website
// prints the minutes beside it.
const CUT = 'Umivanje, striženje, utrjevalec in sušenje las, po želji tudi likanje.';
const DYE = 'Barvanje, umivanje, striženje, utrjevalec in sušenje.';
const BLOW = 'Umivanje in sušenje las z utrjevalcem.';
const FOILS = 'Izdelava pramenov, umivanje, striženje, utrjevalec in sušenje las.';
const MASSAGE = 'Umivanje las z masažo lasišča Byuti Flow, sušenje in oblikovanje.';

const SERVICES = [
  ["MOŠKO MODERNO striženje, umivanje in sušenje", 45, 24.0, 'Striženje las',
    'Umivanje las, moderno striženje, utrjevalec in sušenje las.'],
  ["Žensko striženje in fen frizura – kratki lasje (do nosu)", 60, 35.5, 'Striženje las', CUT],
  ["Žensko striženje in fen frizura – srednje dolgi lasje (do brade)", 90, 45.0, 'Striženje las', CUT],
  ["Žensko striženje in fen frizura – dolgi lasje", 110, 52.0, 'Striženje las', CUT],
  ["Moško komplet striženje z masažo lasišča Byuti Flow", 60, 37.0, 'Striženje las',
    'Moderno striženje, umivanje las z masažo lasišča Byuti Flow, sušenje in oblikovanje z utrjevalcem.'],
  ["MOŠKO MODERNO, FADE STRIŽENJE", 30, 15.0, 'Striženje las',
    'Moderno striženje z oblikovanjem frizure in utrjevalcem.'],

  ["Komplet barvanje, striženje in fen frizura – kratki lasje (do nosu)", 120, 62.0, 'Barvanje las', DYE],
  ["Komplet barvanje, striženje in fen frizura – srednje dolgi lasje (do ramen)", 150, 75.0, 'Barvanje las',
    'Barvanje celotne dolžine srednje dolgih las, umivanje, striženje, utrjevalec in sušenje.'],
  ["Komplet barvanje, striženje in fen frizura – dolgi lasje", 180, 0, 'Barvanje las',
    'Barvanje celotne dolžine dolgih las, umivanje, striženje, utrjevalec in sušenje.'],
  ["MOŠKO komplet BARVANJE ali prameni", 90, 48.0, 'Barvanje las',
    'Izdelava pramenov ali barvanje las, umivanje las z masažo lasišča, moderno striženje, utrjevalec in sušenje las.'],

  ["Komplet fen ali vodna frizura – kratki lasje (do nosu)", 45, 20.5, 'Fen frizure', BLOW],
  ["Komplet fen ali vodna frizura – srednje dolgi lasje (do brade)", 75, 28.0, 'Fen frizure', BLOW],
  ["Komplet fen ali vodna frizura – dolgi lasje", 90, 34.0, 'Fen frizure', BLOW],

  ["Svečana frizura – kratki lasje (do nosu)", 60, 0, 'Svečane pričeske',
    'Oblikovanje svečane pričeske za posebne priložnosti.'],
  ["Svečana frizura – srednje dolgi lasje (do brade)", 90, 0, 'Svečane pričeske',
    'Oblikovanje svečane pričeske za posebne priložnosti.'],
  ["Komplet trajna, striženje, fen frizura – dolgi lasje", 120, 0, 'Svečane pričeske',
    'Trajna, umivanje, striženje, utrjevalec in sušenje las.'],

  ["Komplet prameni, striženje, fen – kratki lasje (do nosu)", 135, 0, 'Prameni', FOILS],
  ["Komplet prameni narastek, striženje in fen frizura – srednje dolgi lasje (do brade)", 170, 0, 'Prameni',
    'Prameni na narastku, umivanje, striženje, utrjevalec in sušenje las.'],
  ["Komplet prameni ali bayalage, striženje in fen frizura – dolgi lasje", 200, 0, 'Prameni',
    'Prameni ali bayalage, umivanje, striženje, utrjevalec in sušenje las.'],

  ["Barvanje in oblikovanje obrvi", 15, 5.0, 'Oblikovanje obrvi',
    'Barvanje in oblikovanje obrvi po obliki obraza.'],

  ["MOŠKA masaža lasišča Byuti Flow (30 min)", 30, 22.0, 'Masaža lasišča Byuti Flow', MASSAGE],
  ["MOŠKA masaža lasišča Byuti Flow (45 min)", 45, 32.0, 'Masaža lasišča Byuti Flow', MASSAGE],
  ["ŽENSKA masaža lasišča Byuti Flow – kratki lasje", 75, 50.0, 'Masaža lasišča Byuti Flow', MASSAGE],
  ["ŽENSKA masaža lasišča Byuti Flow – srednje dolgi lasje", 90, 60.0, 'Masaža lasišča Byuti Flow', MASSAGE],
];

/* --------------------------------------------------------------- settings */

settings.setMany({
  salon_name: 'Frizerstvo Berni',
  hero_heading: 'Frizerski salon v Slovenj Gradcu, z vami že od leta 2008.',
  legal_name: 'Bernarda Hrovat s.p.',
  slogan:
    'Frizerske storitve za ženske, moške in otroke: striženje, barvanje, ' +
    'fen frizure, prameni in oblikovanje obrvi.',
  about: ABOUT,
  address: 'Iršičeva ulica 15',
  city: '2380 Slovenj Gradec',
  // Written the way the salon writes it. The tel: link strips the spaces, and
  // a local number dials correctly from a Slovenian phone.
  phone: '031 331 636',
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

  /* ------------------------------------------------------- website copy */
  // Everything below is editable in Nastavitve; this only fills it in to
  // start with. Pictures are left empty on purpose — the salon has no photo
  // library, so the website falls back to the emblem and to marks in the
  // salon's colour until real photographs are added.
  highlight_1_title: 'Naročanje prek spleta',
  highlight_1_text:
    'Izberete želene storitve in se naročite. Ob vsaki storitvi sta izpisana trajanje in cena.',
  highlight_2_title: 'Z vami od leta 2008',
  highlight_2_text:
    'Skozi leta pridobljene izkušnje nenehno nadgrajujemo s konstantnim izobraževanjem.',
  highlight_3_title: 'Brezplačno parkirišče',
  highlight_3_text:
    'Salon je v neposredni bližini dvorane Vinka Cajnka in ima zagotovljeno brezplačno parkirišče.',
  highlight_4_title: 'Za občutljiva lasišča',
  highlight_4_text:
    'Barve ECHOES so popolnoma brez amonijaka, lasna kozmetika pa brez sulfatov in parabenov.',

  service_card_1_title: 'Striženje las',
  service_card_1_text:
    'Striženje za ženske, moške in otroke. Vsako striženje vključuje umivanje las, utrjevalec in sušenje.',
  service_card_1_points: [
    'Moško moderno striženje in fade striženje',
    'Žensko striženje in fen frizura po dolžini las',
    'Moško komplet striženje z masažo lasišča Byuti Flow',
  ].join('\n'),

  service_card_2_title: 'Barvanje las',
  service_card_2_text:
    'Komplet barvanje z umivanjem, striženjem, utrjevalcem in sušenjem. Za občutljiva lasišča uporabljamo barve brez amonijaka.',
  service_card_2_points: [
    'Barvanje celotne dolžine, s striženjem in fen frizuro',
    'Moško komplet barvanje ali prameni',
    'Barve ECHOES brez amonijaka, za moške LISAP MAN',
  ].join('\n'),

  service_card_3_title: 'Fen frizure',
  service_card_3_text:
    'Komplet fen ali vodna frizura: umivanje in sušenje las z utrjevalcem. Traja od 45 minut pri kratkih do 90 minut pri dolgih laseh.',
  service_card_3_points: [
    'Kratki lasje do nosu, 45 minut',
    'Srednje dolgi lasje do brade, 75 minut',
    'Dolgi lasje, 90 minut',
  ].join('\n'),
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
for (const [name, minutes, euros, category, details] of SERVICES) {
  order += 1;
  services.create({
    name,
    description: category,
    details: details || '',
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
