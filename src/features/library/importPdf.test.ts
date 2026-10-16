import { describe, expect, it, vi } from 'vitest';
import type { PaperPdf, PdfBytes } from '../../domain/pdfFile';
import type { Paper } from '../../domain/papers';
import { PdfStoreError, type PdfBlobStore } from '../../services/pdfStore';
import { preparePdfImport, type ImportDeps, type ProbePdf } from './importPdf';

const PDF_BYTES: PdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const HASH = 'f'.repeat(64);

interface Recorder {
  blobCalls: string[];
  stored: Map<string, PdfBytes>;
}

/** A blob store that records what it was asked to do, in order. */
function fakeBlobs(options: { present?: boolean; failWith?: PdfStoreError } = {}): {
  blobs: PdfBlobStore;
  log: Recorder;
} {
  const log: Recorder = { blobCalls: [], stored: new Map() };
  if (options.present === true) log.stored.set(HASH, PDF_BYTES);
  const blobs: PdfBlobStore = {
    durable: true,
    has: (sha256) => {
      log.blobCalls.push(`has:${sha256}`);
      return Promise.resolve(log.stored.has(sha256));
    },
    get: (sha256) => Promise.resolve(log.stored.get(sha256) ?? null),
    put: (sha256, bytes) => {
      log.blobCalls.push(`put:${sha256}`);
      if (options.failWith !== undefined) return Promise.reject(options.failWith);
      log.stored.set(sha256, bytes);
      return Promise.resolve();
    },
    remove: (sha256) => {
      log.blobCalls.push(`remove:${sha256}`);
      return Promise.resolve();
    },
    usage: () => Promise.resolve(null),
  };
  return { blobs, log };
}

function makeFile(bytes: PdfBytes = PDF_BYTES, name = 'Attention.pdf'): File {
  return new File([bytes], name, { type: 'application/pdf' });
}

const deps = (blobs: PdfBlobStore, overrides: Partial<ImportDeps> = {}): ImportDeps => ({
  blobs,
  readBytes: () => Promise.resolve(PDF_BYTES),
  hash: () => Promise.resolve(HASH),
  ...overrides,
});

const acceptingProbe: ProbePdf = () => Promise.resolve({ pageCount: 12 });

function paper(id: string, pdf?: PaperPdf): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    createdAt: 0,
    updatedAt: 0,
    ...(pdf ? { pdf } : {}),
  };
}

const readyPdf: PaperPdf = {
  sha256: HASH,
  name: 'Attention.pdf',
  bytes: PDF_BYTES.length,
  pageCount: 12,
  addedAt: 0,
};

describe('preparePdfImport', () => {
  it('stores the bytes first and returns what the paper should record', async () => {
    const { blobs, log } = fakeBlobs();
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: acceptingProbe,
      papers: {},
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.prepared.duplicateOf).toBeNull();
    expect(result.prepared.pdf).toMatchObject({
      sha256: HASH,
      name: 'Attention.pdf',
      bytes: PDF_BYTES.length,
      pageCount: 12,
    });
    // The blob is already in the store before the caller may write a reference to it.
    expect(log.stored.get(HASH)).toStrictEqual(PDF_BYTES);
    expect(log.blobCalls).toStrictEqual([`has:${HASH}`, `put:${HASH}`]);
  });

  it('does not store the bytes twice for a file it already has', async () => {
    const { blobs, log } = fakeBlobs({ present: true });
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: acceptingProbe,
      papers: {},
    });
    expect(result.status).toBe('ready');
    expect(log.blobCalls).toStrictEqual([`has:${HASH}`]);
  });

  it('reports the paper that already carries this file instead of merging anything', async () => {
    const { blobs } = fakeBlobs({ present: true });
    const owner = paper('existing', readyPdf);
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: acceptingProbe,
      papers: { existing: owner },
    });
    expect(result.status === 'ready' && result.prepared.duplicateOf).toBe(owner);
  });

  it('does not call a file a duplicate when it is being re-attached to its own paper', async () => {
    const { blobs } = fakeBlobs({ present: true });
    const owner = paper('existing', readyPdf);
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: acceptingProbe,
      papers: { existing: owner },
      attachedTo: 'existing',
    });
    expect(result.status === 'ready' && result.prepared.duplicateOf).toBeNull();
  });

  it.each([
    { label: 'an empty file', bytes: new Uint8Array(), reason: 'empty' },
    {
      label: 'a file that is not a PDF',
      bytes: new TextEncoder().encode('hello'),
      reason: 'not-pdf',
    },
  ])('rejects $label without touching storage', async ({ bytes, reason }) => {
    const { blobs, log } = fakeBlobs();
    const result = await preparePdfImport(
      deps(blobs, { readBytes: () => Promise.resolve(bytes) }),
      makeFile(bytes),
      { probe: acceptingProbe, papers: {} },
    );
    expect(result).toMatchObject({ status: 'failed', reason });
    expect(log.blobCalls).toStrictEqual([]);
  });

  it('rejects a file the parser cannot read, and stores nothing', async () => {
    const { blobs, log } = fakeBlobs();
    const failingProbe: ProbePdf = () => Promise.reject(new Error('Invalid PDF structure'));
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: failingProbe,
      papers: {},
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'unreadable-pdf' });
    expect(result.status === 'failed' && result.message).toContain('Invalid PDF structure');
    expect(log.blobCalls).toStrictEqual([]);
  });

  it('reports a file it cannot read at all', async () => {
    const { blobs } = fakeBlobs();
    const result = await preparePdfImport(
      deps(blobs, { readBytes: () => Promise.reject(new Error('nope')) }),
      makeFile(),
      { probe: acceptingProbe, papers: {} },
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'unreadable-file' });
  });

  it.each([
    { failure: 'unavailable' as const, reason: 'storage-unavailable' },
    { failure: 'quota' as const, reason: 'storage-quota' },
    { failure: 'unknown' as const, reason: 'storage-failed' },
  ])('reports a $failure blob store without reporting success', async ({ failure, reason }) => {
    const { blobs } = fakeBlobs({
      failWith: new PdfStoreError(failure, `failed: ${failure}`),
    });
    const result = await preparePdfImport(deps(blobs), makeFile(), {
      probe: acceptingProbe,
      papers: {},
    });
    expect(result).toMatchObject({ status: 'failed', reason });
    expect(result.status === 'failed' && result.message).toContain(failure);
  });

  it('hashes the real bytes it read, not the file metadata', async () => {
    const hash = vi.fn(() => Promise.resolve(HASH));
    const { blobs } = fakeBlobs();
    await preparePdfImport(deps(blobs, { hash }), makeFile(), {
      probe: acceptingProbe,
      papers: {},
    });
    expect(hash).toHaveBeenCalledWith(PDF_BYTES);
  });
});
