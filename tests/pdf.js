'use strict';
/**
 * PDF export tests.
 *
 * A PDF cannot be proof-read by a test, so these check the things that actually
 * break: a structurally valid file, Slovenian characters surviving the
 * encoding, the figures reaching the page, and long tables paginating instead of
 * running off the bottom.
 *
 *   node tests/pdf.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB = path.join(os.tmpdir(), `salon-pdf-test-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
process.env.SALON_DB = DB;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
}
function section(n) { console.log(`\n== ${n} ==`); }

const pdf = require(path.join(__dirname, '..', 'src', 'pdf'));
const products = require(path.join(__dirname, '..', 'src', 'repo', 'products'));
const moves = require(path.join(__dirname, '..', 'src', 'repo', 'product-moves'));
const settings = require(path.join(__dirname, '..', 'src', 'settings'));
const report = require(path.join(__dirname, '..', 'src', 'reports', 'products-pdf'));

/** Read the file back as bytes, the way a PDF viewer would. */
const asLatin1 = (buf) => buf.toString('latin1');

section('text encoding');
{
  ok('ASCII is untouched', pdf.encodeText('Sampon 12.90') === 'Sampon 12.90');

  // s-caron and z-caron exist in WinAnsi; c-caron does not and is remapped.
  const bytes = pdf.encodeText('Šžčč');
  ok('S-caron maps to WinAnsi 0x8A', bytes.charCodeAt(0) === 0x8a, bytes.charCodeAt(0));
  ok('z-caron maps to WinAnsi 0x9E', bytes.charCodeAt(1) === 0x9e, bytes.charCodeAt(1));
  ok('c-caron is remapped into a free slot', bytes.charCodeAt(2) === 0x8d, bytes.charCodeAt(2));
  ok('C-caron upper is remapped too', pdf.encodeText('Č').charCodeAt(0) === 0x8f);
  ok('the euro sign is encodable', pdf.encodeText('€').charCodeAt(0) === 0x80);

  ok('newlines become spaces rather than breaking the string',
    pdf.encodeText('a\nb') === 'a b', pdf.encodeText('a\nb'));
  ok('an unrepresentable character degrades to a question mark',
    pdf.encodeText('日') === '?', pdf.encodeText('日'));
  ok('every byte stays inside one octet',
    [...pdf.encodeText('Šampon — čokolada')].every((c) => c.charCodeAt(0) <= 0xff));
}

section('cell fitting');
{
  ok('a short cell is left alone', pdf.fitCourier('abc', 200, 8.5) === 'abc');
  const cut = pdf.fitCourier('a'.repeat(200), 60, 8.5);
  ok('a long cell is truncated', cut.length < 200, cut.length);
  ok('truncation is marked', cut.endsWith('…'), cut.slice(-3));
  ok('an empty cell is safe', pdf.fitCourier(null, 50, 8.5) === '');
}

section('filenames');
{
  ok('diacritics are stripped',
    pdf.safeFilename('Šampon čokolada') === 'Sampon-cokolada', pdf.safeFilename('Šampon čokolada'));
  ok('path separators cannot escape',
    !/[\\/]/.test(pdf.safeFilename('../../etc/passwd')), pdf.safeFilename('../../etc/passwd'));
  ok('quotes cannot break the header',
    !/["\r\n]/.test(pdf.safeFilename('a"b\r\nc')), pdf.safeFilename('a"b\r\nc'));
  ok('an empty name still yields something', pdf.safeFilename('///') === 'izvoz',
    pdf.safeFilename('///'));
}

section('a document is structurally valid');
{
  const doc = new pdf.Document({ title: 'Naslov', subtitle: 'Podnaslov', footer: 'Noga' });
  doc.heading('Razdelek');
  doc.table({
    columns: [{ header: 'A', width: 1 }, { header: 'B', width: 1, align: 'right' }],
    rows: [{ cells: ['ena', '1'] }, { cells: ['dva', '2'], bold: true }],
  });
  doc.paragraph('Nekaj besedila.');
  const out = doc.toBuffer();
  const text = asLatin1(out);

  ok('starts with a PDF header', text.startsWith('%PDF-1.4'), text.slice(0, 8));
  ok('ends with the EOF marker', text.trimEnd().endsWith('%%EOF'));
  ok('has a catalogue', text.includes('/Type /Catalog'));
  ok('has a page tree', text.includes('/Type /Pages'));
  ok('has at least one page', text.includes('/Type /Page\n') || text.includes('/Type /Page '));
  ok('declares the fonts it uses', text.includes('/Helvetica') && text.includes('/Courier'));
  ok('names the remapped glyphs', text.includes('/ccaron') && text.includes('/Ccaron'));
  ok('has a cross-reference table', text.includes('\nxref\n'));
  ok('has a trailer with a root', /trailer[\s\S]*\/Root 1 0 R/.test(text));

  // The xref offsets must actually point at their objects, or viewers refuse it.
  const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
  ok('startxref points at the xref table', text.slice(startxref, startxref + 4) === 'xref',
    text.slice(startxref, startxref + 10));
  const xrefBody = text.slice(startxref).split('trailer')[0];
  const offsets = [...xrefBody.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  ok('every object offset was recorded', offsets.length >= 7, offsets.length);
  ok('every offset lands on an object header',
    offsets.every((at, i) => text.slice(at).startsWith(`${i + 1} 0 obj`)),
    offsets.map((at) => text.slice(at, at + 10)));

  ok('parentheses in text are escaped',
    asLatin1(new pdf.Document({ title: 'a(b)c' }).toBuffer()).includes('a\\(b\\)c'));
  ok('backslashes in text are escaped',
    asLatin1(new pdf.Document({ title: 'a\\b' }).toBuffer()).includes('a\\\\b'));
}

section('long tables paginate');
{
  const doc = new pdf.Document({ title: 'Dolga tabela' });
  doc.table({
    columns: [{ header: 'Vrstica', width: 1 }, { header: 'Vrednost', width: 1, align: 'right' }],
    rows: Array.from({ length: 400 }, (_, i) => ({ cells: [`vrstica ${i}`, String(i)] })),
  });
  const text = asLatin1(doc.toBuffer());
  const pageCount = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]);
  ok('400 rows span several pages', pageCount > 5, pageCount);
  ok('the page count matches the number of page objects',
    (text.match(/\/Type \/Page\b(?! )/g) || text.match(/\/Type \/Page /g) || []).length >= pageCount,
    pageCount);
  ok('the header repeats on later pages',
    (text.match(/\(Vrstica\)/g) || []).length >= pageCount,
    (text.match(/\(Vrstica\)/g) || []).length);
  ok('the footer numbers every page',
    (text.match(/Stran \d+ \/ \d+/g) || []).length === pageCount,
    (text.match(/Stran \d+ \/ \d+/g) || []).length);
  ok('the last row is present', text.includes('(vrstica 399)'));
}

section('the product reports');
{
  settings.set('salon_name', 'Frizerstvo Berni');

  const p = products.create({
    name: 'Šampon — čokolada & žajbelj',
    description: '',
    quantity: 0,
    price_cents: 1490,
    cost_cents: 620,
    active: 1,
  });
  const plain = products.create({
    name: 'Balzam', description: '', quantity: 5, price_cents: 1190, cost_cents: 0, active: 1,
  });

  const at = (y, m) => new Date(y, m - 1, 12, 9, 30, 0);
  moves.record({ product_id: p.id, kind: 'in', quantity: 24, unit_price_cents: 620, now: at(2026, 7) });
  moves.record({ product_id: p.id, kind: 'out', quantity: 9, unit_price_cents: 1290, now: at(2026, 7) });
  moves.record({ product_id: p.id, kind: 'adjust', quantity: -1, note: 'lom pri prevozu', now: at(2026, 7) });
  moves.record({ product_id: p.id, kind: 'in', quantity: 12, unit_price_cents: 710, now: at(2026, 8) });
  moves.record({ product_id: p.id, kind: 'out', quantity: 5, unit_price_cents: 1490, now: at(2026, 8) });
  moves.record({ product_id: plain.id, kind: 'out', quantity: 2, unit_price_cents: 1190, now: at(2026, 8) });

  const month = report.monthReport('2026-08');
  const monthText = asLatin1(month.buffer);
  ok('a month export is produced', month.buffer.length > 1000, month.buffer.length);
  ok('the filename carries the month', month.filename.includes('2026-08'), month.filename);
  ok('the filename is safe for a header', !/["\r\n\\/]/.test(month.filename), month.filename);
  ok('the month is named in words', monthText.includes('avgust 2026'));
  ok('the product name is on the page',
    monthText.includes(pdf.encodeText('Šampon — čokolada & žajbelj').slice(0, 20)));
  ok("August's revenue is on the page", monthText.includes('74.50'), 'expected 5 x 14.90');
  ok('a total row is included', monthText.includes('(SKUPAJ)'));
  ok("July's figures are not in the August export", !monthText.includes('julij'));

  const all = report.allMonthsReport();
  const allText = asLatin1(all.buffer);
  ok('an all-months export is produced', all.buffer.length > 1000, all.buffer.length);
  ok('it names every kept month',
    allText.includes('avgust 2026') && allText.includes('julij 2026'));
  ok('it states the retention window', /hrani 12 mesecev/.test(allText));
  ok('it reassures that stock is unaffected', /Zaloga izdelkov/.test(allText));
  ok('the filename says it is all months', all.filename.includes('vsi-meseci'), all.filename);

  const one = report.productReport(p.id);
  const oneText = asLatin1(one.buffer);
  ok('a per-product export is produced', one.buffer.length > 1000, one.buffer.length);
  ok('it shows the selling price', oneText.includes('14.90'));
  ok('it shows the cost price', oneText.includes('6.20'));
  ok('it shows the margin per unit', oneText.includes('8.70'), 'expected 14.90 - 6.20');
  ok('it lists both months', oneText.includes('(2026-08)') && oneText.includes('(2026-07)'));
  ok('it keeps each month\'s own sale price',
    oneText.includes('12.90') && oneText.includes('14.90'));
  ok('it includes the movement notes', oneText.includes('lom pri prevozu'));
  ok('it labels the movement kinds',
    oneText.includes('(Dobava)') && oneText.includes('(Prodaja)') && oneText.includes('(Popravek)'));

  const noCost = report.productReport(plain.id);
  ok('a product with no cost still exports', noCost.buffer.length > 800);
  ok('a missing product exports nothing', report.productReport(99999) === null);

  // An empty month must not produce a broken file.
  const empty = report.monthReport('1999-01');
  ok('an empty month still yields a valid PDF',
    asLatin1(empty.buffer).startsWith('%PDF') &&
    asLatin1(empty.buffer).trimEnd().endsWith('%%EOF'));
  ok('an empty month says so', /ni zabele/.test(asLatin1(empty.buffer)));
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
console.log('');
process.exitCode = fail ? 1 : 0;

process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + s); } catch { /* already gone */ }
  }
});
