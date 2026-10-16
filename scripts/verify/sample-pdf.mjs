/**
 * Builds a small but genuinely valid PDF, used by the reader verification script.
 *
 * It has three pages, each with real text in Helvetica — so the reader has something to
 * navigate, zoom into and select — and each page carries a unique marker string the script
 * asserts on. Nothing here is a mock of a PDF: the file is parsed and rendered by pdf.js the
 * same way a user's paper is.
 */
const PAGE_COUNT = 3;

/** ASCII only, so every string length below is also a byte length. */
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
  const pages = Array.from({ length: PAGE_COUNT }, (_, index) => index + 1);
  // Object numbering: 1 catalog, 2 pages, 3 font, then a page and a content stream each.
  const fontId = 3;
  const firstPageId = 4;
  const pageIds = pages.map((_, index) => firstPageId + index * 2);

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(PAGE_COUNT)} >>`;
  objects[fontId] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  for (const [index, pageNumber] of pages.entries()) {
    const pageId = pageIds[index] ?? 0;
    const contentId = pageId + 1;
    const stream = contentStream(pageNumber);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${String(fontId)} 0 R >> >> /Contents ${String(contentId)} 0 R >>`;
    objects[contentId] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  }

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
}

/** A file that only pretends to be a PDF, for the rejection check. */
export function buildBrokenPdf() {
  return Buffer.from('This is a text file. It is not a PDF at all.\n', 'utf8');
}
