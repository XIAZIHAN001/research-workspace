import type { PdfBytes } from '../domain/pdfFile';

/**
 * SHA-256 of the given bytes, lowercase hex.
 *
 * WebCrypto is used rather than a bundled implementation: it is available in every browser
 * this app targets and in Node, and it does not block on a large file the way a JavaScript
 * digest would.
 *
 * The hash identifies *file content*. Two papers that happen to share a PDF are still two
 * papers: this value is never used to decide academic identity.
 */
export async function sha256Hex(
  bytes: PdfBytes,
  /* `null` means "this platform has no WebCrypto"; omitted means "use the platform's". */
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string> {
  if (subtle === null) {
    throw new Error('这个浏览器不支持内容哈希（crypto.subtle 不可用），无法校验文件。');
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True for a canonical lowercase hex SHA-256, so bad values never reach the blob store. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
