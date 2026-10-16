import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Prints what pdf.js can actually recover from a PDF file.
 *
 * Used to pick and describe the real papers kept in `.cache/papers/`: page count, whether a
 * page is laid out in columns, how many glyphs the text layer recovers, which fonts are
 * involved, and whether pages carry images. It reads the file exactly the way the reader does,
 * so what it reports is what selection and anchoring will have to work with.
 *
 * Usage: node scripts/verify/inspect-pdf.mjs <file.pdf>
 */

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node scripts/verify/inspect-pdf.mjs <file.pdf>');
  process.exit(2);
}

// pdf.js validates that a factory url ends in a forward slash, and `path.join` strips one, so
// the trailing slash is added by hand rather than joined.
const dist = join(process.cwd(), 'node_modules', 'pdfjs-dist');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const task = pdfjs.getDocument({
  data: new Uint8Array(readFileSync(file)),
  useWorkerFetch: false,
  isEvalSupported: false,
  standardFontDataUrl: `${dist}/standard_fonts/`,
  cMapUrl: `${dist}/cmaps/`,
  cMapPacked: true,
});
const doc = await task.promise;

const MATH = /[Ͱ-Ͽ∀-⋿∑√×±≤≥]/g;
const sample = Math.min(doc.numPages, 6);
const fonts = new Set();
let glyphs = 0;
let symbols = 0;
let images = 0;

console.log(`file: ${file}`);
console.log(`pages: ${doc.numPages}`);

for (let n = 1; n <= sample; n += 1) {
  const page = await doc.getPage(n);
  const view = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str ?? '').join('');
  glyphs += text.length;
  symbols += (text.match(MATH) ?? []).length;
  for (const item of content.items) {
    if (item.fontName !== undefined) fonts.add(item.fontName);
  }
  const ops = await page.getOperatorList();
  for (const op of ops.fnArray) {
    if (op === pdfjs.OPS.paintImageXObject || op === pdfjs.OPS.paintInlineImageXObject) images += 1;
  }
  if (n === 1) {
    const placed = content.items.filter((item) => (item.str ?? '').trim() !== '');
    let left = 0;
    for (const item of placed) if (item.transform[4] < view.width / 2) left += 1;
    const rows = new Set(placed.map((item) => Math.round(item.transform[5] / 4)));
    console.log(`page 1: ${Math.round(view.width)}x${Math.round(view.height)} pt`);
    console.log(`page 1: ${placed.length} text items, ${rows.size} text rows`);
    // Evidence of two columns, not proof: a single column leaves the right half nearly empty.
    console.log(`page 1: items left of centre ${left}, right of centre ${placed.length - left}`);
  }
  page.cleanup();
}

console.log(`sampled ${sample} pages: ${glyphs} glyphs, ${symbols} math symbols`);
console.log(`images across sampled pages: ${images}`);
console.log(`distinct font keys: ${fonts.size} (${[...fonts].slice(0, 12).join(', ')})`);

// The loading task owns the worker and the parsed document; the document proxy has no destroy.
await task.destroy();
