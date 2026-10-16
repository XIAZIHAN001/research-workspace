import { describe, expect, it } from 'vitest';
import type { PdfBytes } from '../domain/pdfFile';
import { sha256Hex } from './hash';

const encode = (text: string): PdfBytes => new TextEncoder().encode(text);

describe('sha256Hex', () => {
  it('matches known digests', async () => {
    // Published NIST vectors.
    expect(await sha256Hex(encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex(encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is stable and format-correct for the same bytes', async () => {
    const first = await sha256Hex(encode('%PDF-1.7 hello'));
    const second = await sha256Hex(encode('%PDF-1.7 hello'));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for one changed byte', async () => {
    const one = new Uint8Array([1, 2, 3]);
    const other = new Uint8Array([1, 2, 4]);
    expect(await sha256Hex(one)).not.toBe(await sha256Hex(other));
  });

  it('explains itself when the platform has no WebCrypto', async () => {
    await expect(sha256Hex(encode('abc'), null)).rejects.toThrow(/crypto\.subtle/);
  });
});
