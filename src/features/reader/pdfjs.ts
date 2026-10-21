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
export async function readPdfMetadata(bytes: PdfBytes): Promise<PdfMetadata> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument(documentParams(bytes));
  try {
    const document = await task.promise;
    // Both halves of the metadata: producers write the dictionary, the XMP packet, or both,
    // and a paper's author lives in whichever half its producer happened to fill.
    const { info, metadata } = await document.getMetadata();
    return parsePdfMetadata(info as Record<string, unknown>, readXmpFields(metadata));
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
