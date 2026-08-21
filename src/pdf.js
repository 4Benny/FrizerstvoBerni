'use strict';

/**
 * A very small PDF writer, enough for tabular reports.
 *
 * Written by hand rather than pulled from npm on purpose: this app runs on a
 * salon's own server for years with `npm ci --omit=dev`, and its whole appeal is
 * having almost no moving parts. A report of numbers does not justify a
 * dependency tree with a font engine in it.
 *
 * Deliberate simplifications:
 *   - only the standard fonts Helvetica, Helvetica-Bold and Courier, so no font
 *     file has to be embedded;
 *   - table cells are set in Courier, which is monospaced, so column widths and
 *     truncation are exact arithmetic instead of a glyph-metrics table;
 *   - no compression. A year of one salon's stock history is a few pages.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 40;
const COURIER_WIDTH_RATIO = 0.6; // every Courier glyph is 600/1000 em
const CELL_PAD = 3; // gutter so neighbouring columns never touch

/**
 * Text is written with WinAnsiEncoding, which covers š, ž, Š, Ž and the euro
 * sign but not č or Č. Those two go in unused WinAnsi slots and are named
 * explicitly in the font's /Differences array.
 */
const CCARON = 0x8d;
const CCARON_UPPER = 0x8f;

const EXTRA_GLYPHS = [
  [CCARON, 'ccaron'],
  [CCARON_UPPER, 'Ccaron'],
];

/** Unicode code point -> WinAnsi byte, for the characters outside ASCII. */
const WINANSI = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85],
  ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a],
  ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c],
  ['ž', 0x9e], ['Ÿ', 0x9f],
  ['č', CCARON], ['Č', CCARON_UPPER],
]);

/**
 * Turn a JS string into a byte string the PDF can hold. Anything with no
 * representation becomes a question mark rather than corrupting the file.
 */
function encodeText(input) {
  let out = '';
  for (const char of String(input == null ? '' : input)) {
    const code = char.codePointAt(0);
    if (code === 10 || code === 13) { out += ' '; continue; }
    if (code >= 32 && code <= 126) { out += char; continue; }
    const mapped = WINANSI.get(char);
    if (mapped !== undefined) { out += String.fromCharCode(mapped); continue; }
    // Latin-1 maps one-to-one onto WinAnsi from 0xA0 up.
    if (code >= 0xa0 && code <= 0xff) { out += String.fromCharCode(code); continue; }
    out += '?';
  }
  return out;
}

/** Escape a byte string for a PDF literal string. */
function escapeText(bytes) {
  return bytes.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Courier text width at a given size. */
function courierWidth(text, size) {
  return String(text).length * size * COURIER_WIDTH_RATIO;
}

/** Cut a cell to fit its column, marking the cut with an ellipsis. */
function fitCourier(text, width, size) {
  const max = Math.max(1, Math.floor(width / (size * COURIER_WIDTH_RATIO)));
  const value = String(text == null ? '' : text);
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + '…';
}

class Document {
  /**
   * @param {object} opts
   * @param {string} opts.title      shown at the top of the first page
   * @param {string} [opts.subtitle]
   * @param {string} [opts.footer]   left-hand footer on every page
   */
  constructor({ title, subtitle = '', footer = '' } = {}) {
    this.title = title || '';
    this.subtitle = subtitle;
    this.footer = footer;
    this.pages = [];
    this.ops = null;
    this.y = 0;
    this.newPage(true);
  }

  get contentWidth() {
    return PAGE.width - MARGIN * 2;
  }

  newPage(first = false) {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = PAGE.height - MARGIN;

    if (first && this.title) {
      this.text(this.title, { size: 16, font: 'F2' });
      if (this.subtitle) {
        this.y -= 2;
        this.text(this.subtitle, { size: 9.5, font: 'F1', gray: 0.35 });
      }
      this.y -= 10;
    }
  }

  /** Room left before the footer. */
  get remaining() {
    return this.y - (MARGIN + 24);
  }

  ensure(space) {
    if (this.remaining < space) this.newPage();
  }

  text(value, { size = 10, font = 'F1', x = MARGIN, gray = 0, align = 'left', width = 0 } = {}) {
    const bytes = encodeText(value);
    let left = x;
    if (align !== 'left' && width) {
      const w = font === 'F3' ? courierWidth(bytes, size) : bytes.length * size * 0.5;
      left = align === 'right' ? x + width - w : x + (width - w) / 2;
    }
    this.y -= size * 1.25;
    this.ops.push(
      'BT',
      `${gray} g`,
      `/${font} ${size} Tf`,
      `1 0 0 1 ${left.toFixed(2)} ${this.y.toFixed(2)} Tm`,
      `(${escapeText(bytes)}) Tj`,
      'ET'
    );
    return this;
  }

  heading(value) {
    this.ensure(40);
    this.y -= 6;
    this.text(value, { size: 12, font: 'F2' });
    this.y -= 2;
    return this;
  }

  paragraph(value, { size = 9, gray = 0.35 } = {}) {
    // Courier is not used here, so wrap on a rough average character width.
    const perLine = Math.floor(this.contentWidth / (size * 0.5));
    const words = String(value).split(/\s+/).filter(Boolean);
    let line = '';
    const flush = () => {
      if (!line) return;
      this.ensure(size * 2);
      this.text(line, { size, gray });
      line = '';
    };
    for (const word of words) {
      if (line && (line + ' ' + word).length > perLine) flush();
      line = line ? line + ' ' + word : word;
    }
    flush();
    return this;
  }

  spacer(space = 8) {
    this.y -= space;
    return this;
  }

  rule() {
    this.y -= 4;
    this.ops.push(
      '0.8 G',
      `${MARGIN} ${this.y.toFixed(2)} m ${(PAGE.width - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S`
    );
    return this;
  }

  /**
   * A table. `columns` is [{ header, width, align }] where width is a share of
   * the available width, not an absolute measurement — so the caller does not
   * have to know the page size. The header row repeats on every new page.
   */
  table({ columns, rows, size = 8.5, headerSize = 8.5 }) {
    const totalShare = columns.reduce((sum, c) => sum + (c.width || 1), 0);
    const widths = columns.map((c) => ((c.width || 1) / totalShare) * this.contentWidth);
    const lineHeight = size * 1.55;

    const drawHeader = () => {
      this.ensure(lineHeight * 3);
      let x = MARGIN;
      this.y -= headerSize * 1.3;
      columns.forEach((col, i) => {
        const bytes = encodeText(col.header || '');
        const w = courierWidth(bytes, headerSize);
        const left =
          col.align === 'right' ? x + widths[i] - w - CELL_PAD : x + CELL_PAD;
        this.ops.push(
          'BT',
          '0.3 g',
          `/F2 ${headerSize} Tf`,
          `1 0 0 1 ${left.toFixed(2)} ${this.y.toFixed(2)} Tm`,
          `(${escapeText(bytes)}) Tj`,
          'ET'
        );
        x += widths[i];
      });
      this.y -= 3;
      this.ops.push(
        '0.75 G',
        `${MARGIN} ${this.y.toFixed(2)} m ${(PAGE.width - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S`
      );
      this.y -= 2;
    };

    drawHeader();

    for (const row of rows) {
      if (this.remaining < lineHeight * 1.5) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN;
      this.y -= lineHeight;
      const bold = row.bold === true;
      row.cells.forEach((cell, i) => {
        const bytes = encodeText(fitCourier(cell, widths[i] - CELL_PAD * 2, size));
        const w = courierWidth(bytes, size);
        const left =
          columns[i].align === 'right' ? x + widths[i] - w - CELL_PAD : x + CELL_PAD;
        this.ops.push(
          'BT',
          `${bold ? 0 : 0.15} g`,
          `/${bold ? 'F4' : 'F3'} ${size} Tf`,
          `1 0 0 1 ${left.toFixed(2)} ${this.y.toFixed(2)} Tm`,
          `(${escapeText(bytes)}) Tj`,
          'ET'
        );
        x += widths[i];
      });
    }

    this.y -= 4;
    return this;
  }

  /** Serialise everything. Footers are written last, when the count is known. */
  toBuffer() {
    const total = this.pages.length;
    this.pages.forEach((ops, index) => {
      const label = `${this.footer ? this.footer + '  ·  ' : ''}Stran ${index + 1} / ${total}`;
      const bytes = encodeText(label);
      ops.push(
        'BT',
        '0.45 g',
        '/F1 8 Tf',
        `1 0 0 1 ${MARGIN} ${(MARGIN - 8).toFixed(2)} Tm`,
        `(${escapeText(bytes)}) Tj`,
        'ET'
      );
    });

    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length; // 1-based object number
    };

    // Reserve 1 for the catalogue and 2 for the page tree.
    add('placeholder-catalog');
    add('placeholder-pages');

    const fontIds = {};
    const diffs = EXTRA_GLYPHS.map(([code, name]) => `${code} /${name}`).join(' ');
    const encoding = `<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [ ${diffs} ] >>`;
    for (const [key, base] of [
      ['F1', 'Helvetica'],
      ['F2', 'Helvetica-Bold'],
      ['F3', 'Courier'],
      ['F4', 'Courier-Bold'],
    ]) {
      fontIds[key] = add(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding ${encoding} >>`
      );
    }

    const pageIds = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const streamId = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
      );
      pageIds.push(add('placeholder-page:' + streamId));
    }

    const fontDict = Object.entries(fontIds)
      .map(([key, id]) => `/${key} ${id} 0 R`)
      .join(' ');

    // Fill in the placeholders now that every id is known.
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[1] =
      `<< /Type /Pages /Count ${pageIds.length} /Kids [ ` +
      pageIds.map((id) => `${id} 0 R`).join(' ') +
      ' ] >>';
    for (const id of pageIds) {
      const streamId = Number(objects[id - 1].split(':')[1]);
      objects[id - 1] =
        '<< /Type /Page /Parent 2 0 R ' +
        `/MediaBox [ 0 0 ${PAGE.width.toFixed(2)} ${PAGE.height.toFixed(2)} ] ` +
        `/Resources << /Font << ${fontDict} >> >> ` +
        `/Contents ${streamId} 0 R >>`;
    }

    const chunks = [];
    let offset = 0;
    const push = (text) => {
      const buf = Buffer.from(text, 'latin1');
      chunks.push(buf);
      offset += buf.length;
    };

    push('%PDF-1.4\n');
    // A comment with high bytes marks the file as binary for transfer tools.
    push('%\xE2\xE3\xCF\xD3\n');

    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(offset);
      push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    });

    const xrefStart = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const at of offsets) {
      xref += String(at).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ` +
        `/Info << /Title (${escapeText(encodeText(this.title))}) ` +
        `/Producer (Frizerstvo Berni) >> >>\nstartxref\n${xrefStart}\n%%EOF\n`
    );

    return Buffer.concat(chunks);
  }
}

/** Filenames must survive a Content-Disposition header and a Windows disk. */
function safeFilename(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'izvoz';
}

module.exports = { Document, encodeText, safeFilename, fitCourier, PAGE, MARGIN };
