import { describe, expect, it } from 'vitest';
import { inspectPdfBytes, isPaperPdfUsable, PDF_REJECTION_MESSAGE, type PaperPdf } from './pdfFile';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const usablePdf: PaperPdf = {
  sha256: 'a'.repeat(64),
  name: 'paper.pdf',
  bytes: 1024,
  pageCount: 4,
  addedAt: 1,
};

describe('inspectPdfBytes', () => {
  it('accepts a file that starts with the PDF signature', () => {
    expect(inspectPdfBytes(encode('%PDF-1.7\n...'))).toStrictEqual({ ok: true });
  });

  it('accepts a header that sits behind a short run of junk', () => {
    const junk = new Uint8Array(64).fill(0x20);
    const bytes = new Uint8Array([...junk, ...encode('%PDF-1.4 ...')]);
    expect(inspectPdfBytes(bytes)).toStrictEqual({ ok: true });
  });

  it('rejects an empty file', () => {
    expect(inspectPdfBytes(new Uint8Array())).toStrictEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    { label: 'plain text', bytes: encode('just some notes, definitely not a paper') },
    { label: 'a ZIP archive', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]) },
    { label: 'a PDF header far past the search window', bytes: headerAt(2048) },
    { label: 'a truncated header', bytes: encode('%PD') },
  ])('rejects $label', ({ bytes }) => {
    expect(inspectPdfBytes(bytes)).toStrictEqual({ ok: false, reason: 'not-pdf' });
  });

  it('rejects a file over the limit', () => {
    const bytes = encode('%PDF-1.7');
    expect(inspectPdfBytes(bytes, 4)).toStrictEqual({ ok: false, reason: 'too-large' });
    expect(inspectPdfBytes(bytes, bytes.length)).toStrictEqual({ ok: true });
  });

  it('has a message for every rejection', () => {
    for (const reason of ['empty', 'too-large', 'not-pdf'] as const) {
      expect(PDF_REJECTION_MESSAGE[reason]).toBeTruthy();
    }
  });
});

function headerAt(offset: number): Uint8Array {
  const bytes = new Uint8Array(offset + 8);
  bytes.set(encode('%PDF-1.7'), offset);
  return bytes;
}

describe('isPaperPdfUsable', () => {
  it('accepts a record with a content hash', () => {
    expect(isPaperPdfUsable(usablePdf)).toBe(true);
  });

  it('rejects a missing binding or an unusable hash', () => {
    expect(isPaperPdfUsable(undefined)).toBe(false);
    expect(isPaperPdfUsable({ ...usablePdf, sha256: 'nope' })).toBe(false);
    expect(isPaperPdfUsable({ ...usablePdf, sha256: 'A'.repeat(64) })).toBe(false);
  });
});
