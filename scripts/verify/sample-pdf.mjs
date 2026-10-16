/**
 * Builders for the PDFs the verification scripts use.
 *
 * Everything here produces genuinely valid PDF files — real object tables, real xref offsets,
 * real content streams — so pdf.js parses and renders them exactly like a user's paper. The
 * layouts deliberately cover what a research paper looks like: two columns, multi-line
 * paragraphs, special characters, a non-embedded CJK font, a symbol font, images, tables,
 * repeated sentences and a scanned page with no text layer at all.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

/** The WinAnsi byte for every non-ASCII character the samples use. */
const WIN_ANSI = {
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '…': 0x85,
  '°': 0xb0,
  '±': 0xb1,
  '×': 0xd7,
  '÷': 0xf7,
  '§': 0xa7,
  '©': 0xa9,
  '®': 0xae,
  '™': 0x99,
  µ: 0xb5,
};

/**
 * A literal string in WinAnsiEncoding: ASCII stays as is (with the three special characters
 * escaped), anything else becomes an octal escape holding its WinAnsi byte. A character with
 * no WinAnsi byte throws, so a sample can never silently render the wrong glyph.
 */
function literal(value) {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\' || character === '(' || character === ')') {
      out += `\\${character}`;
    } else if (code >= 32 && code < 127) {
      out += character;
    } else {
      const byte = WIN_ANSI[character];
      if (byte === undefined) throw new Error(`no WinAnsi byte for ${JSON.stringify(character)}`);
      out += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return out;
}

/** A PDF under construction: objects are numbered in the order they are added. */
function createDocument() {
  const objects = [null];

  const document = {
    /** Adds an object and returns its id, so references can be patched later. */
    add(body) {
      objects.push(body);
      return objects.length - 1;
    },
    replace(id, body) {
      objects[id] = body;
      return id;
    },
    build() {
      let pdf = '%PDF-1.4\n';
      const offsets = [];
      for (let id = 1; id < objects.length; id += 1) {
        offsets[id] = pdf.length;
        pdf += `${String(id)} 0 obj\n${objects[id] ?? ''}\nendobj\n`;
      }
      const xrefStart = pdf.length;
      pdf += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
      for (let id = 1; id < objects.length; id += 1) {
        pdf += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
      }
      pdf += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
      return Buffer.from(pdf, 'latin1');
    },
  };
  return document;
}

function contentObject(stream) {
  return `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
}

/** One line of text at an absolute position. */
function line(font, size, x, y, value) {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${literal(value)}) Tj ET`;
}

const SANS = 'F1';
const SYMBOL = 'F2';
const CJK = 'F3';

/** Calls `register` with each font's name and dictionary, so pages can reference them by id. */
function addFonts(document, register) {
  const ids = {
    [SANS]: document.add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ),
    // The classic symbol font: its Latin letters are drawn as Greek glyphs.
    [SYMBOL]: document.add('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>'),
    // A CID font with no embedded programme, which is how most CJK PDFs are written.
    [CJK]: document.add(
      '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ' +
        '/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>] >>',
    ),
  };
  register(ids);
  return ids;
}

/** The resources a page needs to use the shared fonts, plus anything extra. */
function pageResources(fontIds, extra = '') {
  const fonts = Object.entries(fontIds)
    .map(([name, id]) => `/${name} ${String(id)} 0 R`)
    .join(' ');
  return `/Font << ${fonts} >> ${extra}`;
}

/** An 8×8 RGB image: an inline figure on the rich page, and a whole "scanned" page. */
function addImage(document) {
  const pixels = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      pixels.push((x * 31) % 256, (y * 31) % 256, (x + y) % 2 === 0 ? 200 : 80);
    }
  }
  const bytes = pixels.map((value) => String.fromCodePoint(value)).join('');
  return document.add(
    '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB ' +
      `/BitsPerComponent 8 /Length ${String(bytes.length)} >>\nstream\n${bytes}\nendstream`,
  );
}

/* ------------------------------------------------------------------ *
 * Phase 2's sample: three pages of plain text.
 * ------------------------------------------------------------------ */

const PAGE_COUNT = 3;

function contentStream(pageNumber) {
  return [
    'BT',
    '/F1 24 Tf',
    '72 760 Td',
    '(Sample Paper for the Reader) Tj',
    '0 -36 Td',
    '/F1 14 Tf',
    `(MARKER-PAGE-${String(pageNumber)}) Tj`,
    '0 -24 Td',
    '(This line exists so text can be selected and copied.) Tj',
    '0 -24 Td',
    `(Page ${String(pageNumber)} of ${String(PAGE_COUNT)}) Tj`,
    'ET',
  ].join('\n');
}

export function buildSamplePdf() {
  const contents = Array.from({ length: PAGE_COUNT }, (_, index) => contentStream(index + 1));
  return buildPages(contents);
}

/** A file that only pretends to be a PDF, for the rejection check. */
export function buildBrokenPdf() {
  return Buffer.from('This is a text file. It is not a PDF at all.\n', 'utf8');
}

/* ------------------------------------------------------------------ *
 * Phase 3 samples: layouts a real paper actually has.
 * ------------------------------------------------------------------ */

/** Builds a document from a list of page content streams, wiring the catalog and page tree. */
function buildPages(contents, extras = []) {
  const document = createDocument();
  const catalogId = document.add('placeholder');
  const pagesId = document.add('placeholder');
  document.replace(catalogId, `<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`);

  let fonts = {};
  addFonts(document, (ids) => {
    fonts = ids;
  });
  const extraResources = extras.map((entry) => entry(document)).join(' ');

  const kids = contents.map((stream) => {
    const contentId = document.add(contentObject(stream));
    return document.add(
      `<< /Type /Page /Parent ${String(pagesId)} 0 R ` +
        `/MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
        `/Resources << ${pageResources(fonts, extraResources)} >> /Contents ${String(contentId)} 0 R >>`,
    );
  });

  document.replace(
    pagesId,
    `<< /Type /Pages /Kids [${kids.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(contents.length)} >>`,
  );
  return document.build();
}

/**
 * Two columns of multi-line text with distinctive markers, in the usual content-stream order
 * (all of the left column, then all of the right one).
 */
export function buildTwoColumnPdf() {
  return buildPages([
    [
      line(SANS, 16, 56, 780, 'A Two Column Layout'),
      line(SANS, 10, 56, 740, 'LEFT-HEADING'),
      line(SANS, 10, 56, 724, 'The left column starts here and'),
      line(SANS, 10, 56, 710, 'continues on the next line so a'),
      line(SANS, 10, 56, 696, 'selection can span several lines'),
      line(SANS, 10, 56, 682, 'of the same column without'),
      line(SANS, 10, 56, 668, 'touching the other column at all.'),
      line(SANS, 10, 310, 740, 'RIGHT-HEADING'),
      line(SANS, 10, 310, 724, 'The right column carries its own'),
      line(SANS, 10, 310, 710, 'sentences, and they must not be'),
      line(SANS, 10, 310, 696, 'interleaved with the left column'),
      line(SANS, 10, 310, 682, 'when text is extracted in order.'),
    ].join('\n'),
  ]);
}

/**
 * The awkward page: special characters, a Greek run in the symbol font, a Chinese line in a
 * non-embedded CID font, the same sentence twice, a table drawn with rules and a raster image.
 */
export function buildRichTextPdf() {
  const content = [
    line(SANS, 16, 56, 800, 'Characters, Scripts and Figures'),
    line(SANS, 11, 56, 766, 'Units: -10 °C, ± 0.5, 3 × 4 ÷ 2, § 12'),
    line(SANS, 11, 56, 748, 'Dashes: en–dash, em—dash, ellipsis… and “quotes”'),
    line(SANS, 11, 56, 730, 'Symbols: © ® ™ µm and 15 %'),
    // Symbol font: these Latin letters are Greek glyphs (alpha beta gamma delta).
    `BT /${SYMBOL} 12 Tf 56 706 Td (abgd) Tj ET`,
    // Chinese through a non-embedded CID font: UTF-16BE code points in a hex string.
    `BT /${CJK} 12 Tf 56 682 Td <4E2D6587 6D4B8BD5> Tj ET`,
    line(SANS, 11, 56, 656, 'REPEATED-SENTENCE-ALPHA on this page.'),
    line(SANS, 11, 56, 500, 'REPEATED-SENTENCE-ALPHA on this page.'),
    // A three-row, two-column table drawn with rules.
    '0.8 w',
    '56 620 m 300 620 l S',
    '56 600 m 300 600 l S',
    '56 580 m 300 580 l S',
    '178 620 m 178 560 l S',
    '56 560 m 300 560 l S',
    line(SANS, 9, 62, 606, 'Method'),
    line(SANS, 9, 184, 606, 'Accuracy'),
    line(SANS, 9, 62, 586, 'Baseline'),
    line(SANS, 9, 184, 586, '81.3 %'),
    line(SANS, 9, 62, 566, 'Ours'),
    line(SANS, 9, 184, 566, '84.7 %'),
    'q 64 0 0 64 480 760 cm /Im1 Do Q',
  ].join('\n');

  return buildPages(
    [content],
    [(document) => `/XObject << /Im1 ${String(addImage(document))} 0 R >>`],
  );
}

/** A page that is mostly a raster image, with a caption: what a scan looks like. */
export function buildScannedPdf() {
  const content = [
    'q 480 0 0 480 56 300 cm /Im1 Do Q',
    line(SANS, 9, 56, 260, '(This page is a photograph of a page.)'),
  ].join('\n');
  return buildPages(
    [content],
    [(document) => `/XObject << /Im1 ${String(addImage(document))} 0 R >>`],
  );
}

/** A pixel-only page with no text operators at all. */
export function buildTextlessPdf() {
  return buildPages(
    ['q 480 0 0 480 56 300 cm /Im1 Do Q'],
    [(document) => `/XObject << /Im1 ${String(addImage(document))} 0 R >>`],
  );
}

/** A document long enough to exercise the render window: 24 pages by default. */
export function buildLongPdf(pageCount = 24) {
  const contents = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const body = [
      line(SANS, 18, 56, 780, `Long Document, page ${String(pageNumber)} of ${String(pageCount)}`),
      line(SANS, 11, 56, 740, `LONGPAGE-${String(pageNumber)} opens this page.`),
    ];
    for (let row = 0; row < 20; row += 1) {
      body.push(
        line(
          SANS,
          10,
          56,
          710 - row * 16,
          `Line ${String(row + 1)} of page ${String(pageNumber)}: filler text for the reader.`,
        ),
      );
    }
    return body.join('\n');
  });
  return buildPages(contents);
}
