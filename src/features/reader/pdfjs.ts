import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfBytes } from '../../domain/pdfFile';

export type { PDFDocumentProxy, PDFPageProxy };

async function importPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

type PdfjsModule = Awaited<ReturnType<typeof importPdfjs>>;

let loading: Promise<PdfjsModule> | null = null;

/**
 * Loads pdf.js on first use and points it at the worker that ships with the package.
 *
 * Both the library and the worker are bundled by Vite and served from the app's own origin
 * (`?url` emits the worker file as an asset) — nothing is fetched from a CDN, so the reader
 * works offline and inside a packaged desktop build.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= importPdfjs();
  return loading;
}

/**
 * Where the optional pdf.js data files are served from. The vite config copies them out of
 * the installed package, so a PDF that uses a non-embedded standard font or a CJK encoding
 * still renders — locally, with nothing fetched from a CDN.
 */
const PDFJS_DATA_BASE = '/pdfjs';

function documentParams(bytes: PdfBytes) {
  return {
    data: bytes,
    cMapUrl: `${PDFJS_DATA_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_DATA_BASE}/standard_fonts/`,
  };
}

/**
 * Parses the bytes far enough to prove the file is readable, and reports its page count.
 *
 * pdf.js takes ownership of the buffer it is handed (it transfers it to the worker), so
 * callers must pass bytes they do not need afterwards.
 */
export async function probePdf(bytes: PdfBytes): Promise<{ pageCount: number }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  try {
    const document = await task.promise;
    return { pageCount: document.numPages };
  } finally {
    // Releases the worker-side document whether or not it parsed.
    await task.destroy();
  }
}

/** What a PDF's own metadata could tell us about the paper it is. */
export interface PdfMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
}

/**
 * The XMP half of a PDF's metadata, reduced to the fields a paper import cares about.
 *
 * A PDF carries two descriptions of itself: the information dictionary (a handful of
 * free-text strings) and an XMP packet (the richer, newer one). Producers pick either, or
 * both — arXiv fills the dictionary, many journal and Word pipelines fill XMP only — so a
 * reader that looks at one of them simply does not see the papers the other one describes.
 */
export interface PdfXmpFields {
  title?: string;
  creators?: string[];
  /** Date-like fields, most specific first. */
  dates?: string[];
  /** Fields a DOI is plausibly written in. */
  identifiers?: string[];
}

/** The slice of pdf.js's `Metadata` this module reads. Structural, so tests can fake it. */
interface XmpMetadataLike {
  get?: (name: string) => unknown;
}

/**
 * Pulls the paper-relevant fields out of pdf.js's XMP object.
 *
 * `dc:creator` arrives as a list of names, most other fields as one string; pdf.js answers
 * `null` for anything the packet does not have. Everything here is untrusted text, so the
 * filtering `parsePdfMetadata` applies to the dictionary applies to these values too.
 */
export function readXmpFields(metadata: XmpMetadataLike | null | undefined): PdfXmpFields {
  const out: PdfXmpFields = {};
  if (metadata === null || metadata === undefined || typeof metadata.get !== 'function') {
    return out;
  }
  const read = (name: string): unknown => {
    try {
      return metadata.get?.(name) ?? null;
    } catch {
      return null;
    }
  };

  const title = read('dc:title');
  if (typeof title === 'string' && title.trim() !== '') out.title = title.trim();

  const creators = read('dc:creator');
  if (Array.isArray(creators)) {
    const list = creators
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (list.length > 0) out.creators = list;
  } else if (typeof creators === 'string' && creators.trim() !== '') {
    out.creators = [creators.trim()];
  }

  const dates: string[] = [];
  for (const name of ['xmp:CreateDate', 'dc:date', 'xmp:ModifyDate']) {
    const value = read(name);
    if (typeof value === 'string' && value.trim() !== '') dates.push(value.trim());
  }
  if (dates.length > 0) out.dates = dates;

  const identifiers: string[] = [];
  for (const name of ['prism:doi', 'dc:identifier', 'dc:source']) {
    const value = read(name);
    if (typeof value === 'string' && value.trim() !== '') identifiers.push(value.trim());
  }
  if (identifiers.length > 0) out.identifiers = identifiers;

  return out;
}

/**
 * Reads the document information dictionary — the title/author/subject a PDF carries about
 * itself — so importing a paper can fill the form instead of asking for it all by hand.
 *
 * Everything here is optional and everything is filtered: the dictionary is a free-text field
 * that any writer can leave empty, fill with junk, or fill with a TeX key like
 * `backrefprefix`. Returning nothing is always correct; returning something wrong is not, so
 * each field is checked before it is offered.
 *
 * Like `probePdf`, this consumes the buffer it is given.
 */
export async function readPdfMetadata(bytes: PdfBytes, titleHint?: string): Promise<PdfMetadata> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  try {
    const document = await task.promise;
    // Both halves of the metadata: producers write the dictionary, the XMP packet, or both,
    // and a paper's author lives in whichever half its producer happened to fill.
    const { info, metadata } = await document.getMetadata();
    const parsed = parsePdfMetadata(info as Record<string, unknown>, readXmpFields(metadata));
    // Plenty of PDFs — arXiv's own template among them — carry only "Anonymous Author(s)" in
    // their metadata while naming the authors on the first page. The page is where the paper
    // actually says who wrote it, so it is read locally, with no model and no network.
    const named = (parsed.authors ?? []).filter((name) => !isPlaceholderAuthor(name));
    if (named.length === 0) {
      delete parsed.authors;
      try {
        const page = await document.getPage(1);
        const content = await page.getTextContent();
        const items: PageTextItem[] = content.items.flatMap((item) =>
          'str' in item ? [{ str: item.str, transform: item.transform as readonly number[] }] : [],
        );
        page.cleanup();
        // A file name is often the paper's title; it anchors the author block even when the
        // metadata has no title at all.
        const fromPage = authorsFromPageText(items, parsed.title ?? titleHint);
        if (fromPage.length > 0) parsed.authors = fromPage;
      } catch {
        // A page that will not extract text simply contributes nothing; the import continues.
      }
    } else {
      parsed.authors = named;
    }
    return parsed;
  } catch {
    // A PDF without an information dictionary, or one that will not parse, simply has none.
    return {};
  } finally {
    await task.destroy();
  }
}

/** Splits an author string on the separators the common producers actually use. */
function splitAuthors(value: string): string[] {
  return (
    value
      // Strip LaTeX's own author separator first: `\and{...}` is the macro, not a name.
      .replace(/\\and\b/gi, ';')
      .split(/\s*(?:;|，|、|\band\b|&)\s*/i)
      .map((name) => name.trim())
      // Strip the brace group LaTeX wraps each name in. Repeated, because a comma can end up
      // outside the braces: `{Y. Bengio},` → `Y. Bengio`, not `Y. Bengio},`.
      .map((name) => name.replace(/^[{}\s,]+/, '').replace(/[{}\s,]+$/, ''))
      // What is left starting with a control sequence is a macro, not a person.
      .filter((name) => name !== '' && !name.startsWith('\\'))
  );
}

/**
 * Names a producer writes when it has none: these are placeholders, not people.
 *
 * "Anonymous Author(s)" is what arXiv's template puts in the information dictionary unless the
 * authors opt in, and it is worse than an empty field: it fills the import form with a lie and
 * blocks the first-page fallback. Case and punctuation are ignored, so the variants all match.
 */
export function isPlaceholderAuthor(name: string): boolean {
  const normalized = name
    .toLowerCase()
    .replace(/\(s\)/g, 's')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
  if (normalized === '') return true;
  return /^(anonymous( authors?)?|unknown( authors?)?|authors?|n ?a|none|untitled|user|administrator)$/.test(
    normalized,
  );
}

/** One run of text as pdf.js reports it, with the transform that places it on the page. */
export interface PageTextItem {
  str: string;
  /** `[scaleX, skewY, skewX, scaleY, translateX, translateY]`; the last two are x and y. */
  transform: readonly number[];
}

interface PageLine {
  text: string;
  y: number;
  /** Largest glyph scale on the line; the title page is set larger than everything below it. */
  size: number;
}

/** Joins the runs of one line, removing the spaces extraction inserted inside CJK names. */
function joinRuns(runs: readonly { x: number; text: string }[]): string {
  const joined = [...runs]
    .sort((a, b) => a.x - b.x)
    .map((run) => run.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    // A space before punctuation is an artefact of the run boundary, never intentional.
    .replace(/\s+([,.;:!?)\]])/g, '$1')
    .trim();
  return joined.replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, '$1');
}

/**
 * Groups the page's text runs into visual lines, top to bottom.
 *
 * Runs whose baselines are within a couple of points of each other belong to the same line; a
 * name split into several runs — a superscript here, a link there — has to be read back as one
 * string before anything can be said about it.
 */
function pageLines(items: readonly PageTextItem[]): PageLine[] {
  const rows: { y: number; size: number; runs: { x: number; text: string }[] }[] = [];
  for (const item of items) {
    if (item.str.trim() === '') continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const size = Math.abs(item.transform[0] ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5);
    if (row === undefined) rows.push({ y, size, runs: [{ x, text: item.str }] });
    else {
      row.runs.push({ x, text: item.str });
      if (Number.isFinite(size)) row.size = Math.max(row.size, size);
    }
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => ({ text: joinRuns(row.runs), y: row.y, size: row.size }))
    .filter((line) => line.text !== '');
}

/** Where the author block ends and the paper proper begins. */
const SECTION_STOP =
  /^(abstract\b|summary\b|keywords?\b|index terms\b|(?:1|i)[\s.]*introduction\b|introduction\b|摘\s*要|关键词)/i;

/** Things that only ever occur in affiliations, notes and identifiers — never in a name. */
const NON_NAME =
  /(@|\d|https?:|www\.|\.(?:edu|com|org|cn)\b|arxiv|doi|copyright|©|correspondence|equal contribution|preprint)/i;

const INSTITUTION =
  /(universit|university|department|dept\.|institute|institut|laborator|school|college|faculty|academy|research|center|centre|corporation|corp\.|company|inc\.|ltd\.|llc\b|google|microsoft|deepmind|openai|anthropic|amazon|nvidia|bytedance|alibaba|tencent|baidu|大学|学院|研究院|研究所|实验室|公司)/i;

const NOT_A_NAME_LINE = /^(anonymous|authors?|editors?|preview|preprint|accepted|published)\b/i;

/** Strips what producers hang off a name: affiliation marks, superscripts, parentheticals. */
function cleanName(fragment: string): string {
  return (
    fragment
      // "Jane Doe (MIT)" — the affiliation in brackets is not part of the name.
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[*∗†‡§¶#]/g, '')
      // Superscript affiliation numbers, before and after the name.
      .replace(/^[\d\s]+|[\d\s]+$/g, '')
      .replace(/^(?:and|&|和|与)\s+/i, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;·、，]+|[\s,;·、，]+$/g, ' ')
      .trim()
  );
}

/** Lowercase particles that legitimately sit inside a printed name. */
const NAME_PARTICLES = new Set([
  'de',
  'del',
  'della',
  'der',
  'den',
  'di',
  'da',
  'das',
  'dos',
  'du',
  'la',
  'le',
  'los',
  'las',
  'van',
  'von',
  'ten',
  'ter',
  'bin',
  'binti',
  'al',
  'el',
  'af',
  'av',
  'zu',
  'zur',
  'y',
  'e',
]);

/** Whether a cleaned fragment has the shape of a person's name rather than a sentence. */
function looksLikeName(name: string): boolean {
  if (name.length < 2 || name.length > 80) return false;
  if (NON_NAME.test(name) || INSTITUTION.test(name) || NOT_A_NAME_LINE.test(name)) return false;
  if (isPlaceholderAuthor(name)) return false;
  const tokens = name.split(/\s+/);
  // A name is one to five words; a sentence with more is an affiliation or a footnote.
  if (tokens.length > 5) return false;
  if (!tokens.every((token) => /^[\p{Letter}][\p{Letter}\p{Mark}.'’-]*$/u.test(token)))
    return false;
  // Body text below the author block is written in sentence case: a word starting lowercase is
  // prose. Name words start capitalised (or are particles, or use a script that has no case).
  const startsLowercase = (token: string): boolean => /^\p{Lowercase_Letter}/u.test(token);
  const first = tokens[0];
  if (first === undefined || startsLowercase(first)) return false;
  for (const token of tokens.slice(1)) {
    if (startsLowercase(token) && !NAME_PARTICLES.has(token.toLowerCase())) return false;
  }
  return name.replace(/[^\p{Letter}]/gu, '').length >= 2;
}

/** Splits one line into candidate names on every separator author blocks use. */
function splitAuthorLine(line: string): string[] {
  return line
    .replace(/\s+(?:and|&)\s+/gi, ',')
    .split(/\s*[,;，、·]\s*/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== '');
}

/**
 * A title reduced to the words it is made of.
 *
 * Metadata titles and the printed title rarely agree on punctuation — "Zero-Knowledge" against
 * "Zero Knowledge", a colon where the page has a line break — so matching compares words only.
 */
function comparableTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The line set in the largest type, when it clearly stands out from the rest of the page.
 *
 * Without a title in the metadata the author block still needs an anchor. On a title page the
 * title is set larger than the authors and the abstract; when every line is the same size this
 * says nothing and returns -1, leaving the caller's top-down fallback untouched.
 */
function largestLine(lines: readonly PageLine[]): number {
  const head = lines.slice(0, 16);
  const sizes = head
    .map((line) => line.size)
    .filter((size) => size > 0)
    .sort((a, b) => a - b);
  if (sizes.length < 3) return -1;
  const max = sizes[sizes.length - 1];
  const median = sizes[Math.floor(sizes.length / 2)];
  if (max === undefined || median === undefined || max < median * 1.15) return -1;
  return head.findIndex((line) => line.size >= max * 0.99);
}

/**
 * Reads the authors off the first page, where the paper names them itself.
 *
 * A PDF's information dictionary is optional and often wrong; the title page is not. This works
 * on the extracted text only — no rendering, no OCR, no model, no network — by finding the title,
 * scanning the lines between it and the abstract, and keeping only fragments shaped like names.
 * It is deliberately conservative: returning nothing is correct, returning a department is not.
 *
 * Exported for its own tests, which is the only way to pin down that judgement without shipping
 * a corpus of PDFs.
 */
export function authorsFromPageText(items: readonly PageTextItem[], title?: string): string[] {
  const lines = pageLines(items);
  if (lines.length === 0) return [];

  const wanted = comparableTitle(title ?? '');
  const head = Array.from(wanted).slice(0, 16).join('');
  const found =
    head === '' ? -1 : lines.findIndex((line) => comparableTitle(line.text).includes(head));
  // Without a usable title, the largest type on the page is the title; failing that, start from
  // the top and let the filters below decide.
  const bySize = found < 0 ? largestLine(lines) : -1;
  const first = found >= 0 ? found : Math.max(0, bySize);

  // A long title wraps, and its second line sits exactly where authors would be. Walk to the
  // line that carries the title's tail so the continuation is not mistaken for a name.
  let titleEnd = first;
  if (found >= 0) {
    const tail = Array.from(wanted).slice(-16).join('');
    for (let index = first; index < Math.min(lines.length, first + 5); index += 1) {
      const line = lines[index];
      if (line !== undefined && tail !== '' && comparableTitle(line.text).includes(tail)) {
        titleEnd = index;
        break;
      }
    }
  } else if (bySize >= 0) {
    const titleSize = lines[first]?.size ?? 0;
    for (let index = first + 1; index < Math.min(lines.length, first + 5); index += 1) {
      const line = lines[index];
      if (line === undefined || titleSize <= 0 || line.size < titleSize * 0.9) break;
      if (SECTION_STOP.test(line.text)) break;
      titleEnd = index;
    }
  }

  const stop = lines.findIndex((line, index) => index > titleEnd && SECTION_STOP.test(line.text));
  const end = stop < 0 ? Math.min(lines.length, titleEnd + 13) : stop;

  const names: string[] = [];
  for (let index = titleEnd + 1; index < end; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    for (const fragment of splitAuthorLine(line.text)) {
      const name = cleanName(fragment);
      if (!looksLikeName(name) || names.includes(name)) continue;
      names.push(name);
    }
  }
  return names.slice(0, 40);
}

/** The first plausible four-digit year in a string, or nothing. */
function findYear(value: string): number | undefined {
  // 1500–2099: covers every plausible publication year and excludes a stray digit run.
  // An arXiv-style identifier (2401.12345) is not a year, so a bare run needs a word boundary
  // on both sides that a hyphen or dot does not provide.
  const match = /(?<![\d.-])(1[5-9]\d{2}|20\d{2})(?![\d.-])/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : undefined;
}

/**
 * The year at the head of a date stamp — `D:20170612` from a dictionary, `2017-06-12` from
 * XMP. A date is allowed to carry hyphens after the year, which `findYear` rightly refuses.
 */
function yearOfStamp(value: string): number | undefined {
  const match = /^(?:D:)?(\d{4})/.exec(value.trim());
  if (match === null) return undefined;
  const year = Number(match[1]);
  return year >= 1500 && year <= 2099 ? year : undefined;
}

/** A DOI, tolerating the `doi:` prefix and the URL forms that wrap it. */
function findDoi(value: string): string | undefined {
  const match = /10\.\d{4,9}\/[^\s"'<>]+/.exec(value);
  if (match === null) return undefined;
  // Trailing punctuation is sentence punctuation, not part of the identifier.
  return match[0].replace(/[.,;:)\]]+$/, '');
}

/**
 * Reads the fields out of pdf.js's metadata object.
 *
 * Exported for its own tests: every branch here is a judgement about untrusted free text, and
 * those judgements are worth pinning down without going through a real PDF.
 *
 * The information dictionary comes first and wins wherever it has anything; the XMP fields
 * fill in what it left empty, because a producer fills one half or the other and the reader
 * should not have to know which.
 */
export function parsePdfMetadata(
  raw: Record<string, unknown>,
  xmp: PdfXmpFields = {},
): PdfMetadata {
  const out: PdfMetadata = {};

  const title = typeof raw.Title === 'string' ? raw.Title.trim() : '';
  // A wrapped TeX title carries line breaks and a brace group; flatten it to one line.
  if (title !== '' && !title.startsWith('{')) out.title = title.replace(/\s+/g, ' ');

  const authors = typeof raw.Author === 'string' ? raw.Author.trim() : '';
  if (authors !== '') {
    const list = splitAuthors(authors);
    if (list.length > 0) out.authors = list;
  }

  // CreationDate is `D:YYYYMMDDHHmmSS`, which is the only reliably dated field here.
  const created = typeof raw.CreationDate === 'string' ? raw.CreationDate : '';
  if (created !== '') {
    const year = yearOfStamp(created);
    if (year !== undefined) out.year = year;
  }

  // The subject is where most LaTeX/Word templates put the DOI and sometimes the year.
  const subject = typeof raw.Subject === 'string' ? raw.Subject : '';
  const keywords = typeof raw.Keywords === 'string' ? raw.Keywords : '';
  const haystack = `${subject} ${keywords}`;
  if (haystack.trim() !== '') {
    const doi = findDoi(haystack);
    if (doi !== undefined) out.doi = doi;
    if (out.year === undefined) {
      const year = findYear(haystack);
      if (year !== undefined) out.year = year;
    }
  }

  if (out.title === undefined && xmp.title !== undefined && !xmp.title.startsWith('{')) {
    out.title = xmp.title.replace(/\s+/g, ' ');
  }
  if (out.authors === undefined && xmp.creators !== undefined) {
    // An XMP entry is usually one name, but a producer that wrote "A and B" as a single
    // entry gets split by the same rules as the dictionary's Author field.
    const list = xmp.creators.flatMap(splitAuthors);
    if (list.length > 0) out.authors = list;
  }
  if (out.year === undefined) {
    for (const date of xmp.dates ?? []) {
      const year = yearOfStamp(date);
      if (year !== undefined) {
        out.year = year;
        break;
      }
    }
  }
  if (out.doi === undefined) {
    for (const identifier of xmp.identifiers ?? []) {
      const doi = findDoi(identifier);
      if (doi !== undefined) {
        out.doi = doi;
        break;
      }
    }
  }

  return out;
}

export interface OpenedDocument {
  doc: PDFDocumentProxy;
  /**
   * Releases the document and everything the worker holds for it. `PDFDocumentProxy` has no
   * destroy of its own in pdf.js 6 — the loading task is what owns the resources.
   */
  close: () => Promise<void>;
}

/** Opens a document for reading. The caller must `close()` it when the reader closes. */
export async function openPdfDocument(bytes: PdfBytes): Promise<OpenedDocument> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  const doc = await task.promise;
  return {
    doc,
    close: async () => {
      await task.destroy();
    },
  };
}

/** True for the error pdf.js raises when a render is cancelled on purpose. */
export function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}
