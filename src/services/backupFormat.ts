/**
 * The portable backup container.
 *
 * A backup is one file with a small, versioned JSON header followed by the PDF bytes it
 * carries. The format is deliberately not ZIP:
 *
 * - no decompression means no decompression bomb, and no third-party archive parser between a
 *   user-picked file and this application;
 * - PDFs are already compressed, and the JSON header is small, so a ZIP would save little;
 * - the browser can assemble and slice a Blob without holding every PDF in the JavaScript heap:
 *   the bytes go from IndexedDB into the output Blob, and from the input Blob into one file at
 *   a time on the way back.
 *
 * Integrity is content-addressed. Every file is stored under its SHA-256 exactly as it is in
 * the blob store, and the header itself carries a digest of its canonicalised data section, so
 * a truncated, edited or misassembled backup is refused before any of it is written anywhere.
 *
 * What the format deliberately cannot carry: API keys, environment variables, service tokens
 * or any other credential. The header only ever contains the workspace records.
 */

import { inspectPdfBytes, PDF_MAX_BYTES, type PdfBytes } from '../domain/pdfFile';

export const BACKUP_FORMAT = 'rw-knowledge-backup';
export const BACKUP_FORMAT_VERSION = 1;

const MAGIC = new TextEncoder().encode('RWBACKUP');
const FRAME_BYTES = 16;

/** A data section larger than this is not a workspace this app could have produced. */
export const MAX_HEADER_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILES = 512;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_NAME = 240;
const SHA256 = /^[0-9a-f]{64}$/;

export interface BackupFileEntry {
  sha256: string;
  name: string;
  bytes: number;
  /** Offset inside the payload, which starts right after the header. */
  offset: number;
}

export interface BackupHeader {
  format: string;
  formatVersion: number;
  createdAt: string;
  app: { name: string; projectsSchema: number; knowledgeVersion: number };
  counts: Record<string, number>;
  data: unknown;
  files: BackupFileEntry[];
  /** Hashes the exporting device had already lost; their papers travel without bytes. */
  missingFiles: string[];
  integrity: { dataSha256: string };
}

export interface BackupFileInput {
  sha256: string;
  name: string;
  bytes: Blob | Uint8Array;
}

export type OpenBackup =
  | {
      ok: true;
      header: BackupHeader;
      headerBytes: Uint8Array;
      payloadOffset: number;
    }
  | {
      ok: false;
      kind: 'unsupported-version' | 'corrupt';
      problems: string[];
    };

export type InspectContainer =
  | {
      ok: true;
      header: BackupHeader;
      payloadOffset: number;
      fileHashes: Set<string>;
      fileBytes: Map<string, number>;
      warnings: string[];
    }
  | {
      ok: false;
      kind: 'unsupported-version' | 'corrupt';
      problems: string[];
    };

/** SHA-256 of bytes or text, lowercase hex. */
export async function sha256Hex(value: BufferSource | string): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A stable serialisation for the integrity digest: object keys are sorted, array order is kept.
 *
 * Without it the digest would depend on key insertion order, and a backup would fail to verify
 * after a round trip through any tool that happened to rebuild an object differently.
 */
export function canonicalJson(value: unknown): string {
  // This must be hash-equivalent to taking the same data through JSON.stringify and parsing it
  // back. Two cases where a naive walk differs: an object property whose value is `undefined`
  // is omitted by JSON, and an array hole becomes `null`.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalJson(value[index]));
    return `[${items.join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      ([, entry]) =>
        entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol',
    )
    .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function cleanName(name: string): string {
  // The name is display metadata only; control characters would make a log or a dialog lie.
  let clean = '';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) clean += character;
  }
  return clean.slice(0, MAX_FILE_NAME);
}

function blobOf(bytes: Blob | Uint8Array): Blob {
  return bytes instanceof Blob ? bytes : new Blob([bytes.slice().buffer as ArrayBuffer]);
}

/**
 * Assembles a backup. Read-only with respect to everything it is given: the chunks arrive as
 * Blobs, and the resulting file references them rather than copying their bytes into one
 * contiguous buffer.
 */
export async function createBackupBlob(input: {
  data: unknown;
  files: readonly BackupFileInput[];
  missingFiles?: readonly string[];
  createdAt: string;
  app: { name: string; projectsSchema: number; knowledgeVersion: number };
}): Promise<{ blob: Blob; header: BackupHeader }> {
  if (input.files.length > MAX_BACKUP_FILES) {
    throw new Error(`备份里的文件超过 ${String(MAX_BACKUP_FILES)} 个，无法打包。`);
  }
  const seen = new Set<string>();
  const files: BackupFileEntry[] = [];
  const parts: Blob[] = [];
  let offset = 0;
  for (const file of input.files) {
    if (!SHA256.test(file.sha256)) throw new Error('文件哈希格式不正确，无法打包。');
    if (seen.has(file.sha256)) throw new Error('同一个文件在备份里出现了两次。');
    seen.add(file.sha256);
    const blob = blobOf(file.bytes);
    if (blob.size === 0 || blob.size > PDF_MAX_BYTES) {
      throw new Error('文件大小超出允许范围，无法打包。');
    }
    // The container is a Blob that references these parts; it does not need the caller to keep
    // a second Uint8Array alive. `buildBackup` passes Blobs for exactly this reason.
    files.push({
      sha256: file.sha256,
      name: cleanName(file.name),
      bytes: blob.size,
      offset,
    });
    parts.push(blob);
    offset += blob.size;
  }
  if (offset > MAX_TOTAL_BYTES) throw new Error('备份文件总量过大，无法打包。');

  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt,
    app: input.app,
    counts: {},
    data: input.data,
    files,
    missingFiles: [...(input.missingFiles ?? [])],
    integrity: { dataSha256: await sha256Hex(canonicalJson(input.data)) },
  };
  header.counts = countData(input.data);

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) throw new Error('备份的元数据过大，无法打包。');

  const frame = new Uint8Array(FRAME_BYTES);
  frame.set(MAGIC, 0);
  const view = new DataView(frame.buffer);
  writeUint32(view, 8, headerBytes.length);
  writeUint32(view, 12, offset);

  return {
    blob: new Blob([frame, headerBytes, ...parts], { type: 'application/octet-stream' }),
    header,
  };
}

/** Counts shown in the preview and stored in the header, so a reader can compare. */
export function countData(data: unknown): Record<string, number> {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const projects = record(record(data).projects);
  const knowledge = record(record(data).knowledge);
  const papers = record(projects.papers);
  const difficulties = record(record(record(data).difficulties).pages);
  const reviewCards = record(record(record(data).review).cards);
  return {
    projects: list(projects.projects).length,
    papers: Object.keys(papers).length,
    annotations: list(projects.annotations).length,
    bookmarks: list(projects.bookmarks).length,
    glossary: list(projects.glossary).length,
    reviewCards: Object.keys(reviewCards).length,
    concepts: list(knowledge.concepts).length,
    evidence: list(knowledge.evidence).length,
    relations: list(knowledge.relations).length,
    rejections: list(knowledge.rejections).length,
    difficultyPages: Object.keys(difficulties).length,
  };
}

function headerProblems(header: unknown): string[] {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return ['备份的头部不是一个对象。'];
  }
  const value = header as Record<string, unknown>;
  if (value.format !== BACKUP_FORMAT) return ['这不是本应用的备份文件。'];
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) {
    return ['备份的格式版本无法识别。'];
  }
  if (!Array.isArray(value.files)) return ['备份缺少文件清单。'];
  if (!Array.isArray(value.missingFiles)) return ['备份缺少缺失文件清单。'];
  return [];
}

/**
 * Reads and validates the container: framing, version, header shape, file table and the data
 * digest. It does not read the PDF payload — `inspectBackupContainer` does that with a limit
 * of one file in memory at a time.
 */
export async function openBackup(file: Blob): Promise<OpenBackup> {
  if (file.size < FRAME_BYTES) {
    return { ok: false, kind: 'corrupt', problems: ['这不是一个完整的备份文件。'] };
  }
  const frame = new Uint8Array(await file.slice(0, FRAME_BYTES).arrayBuffer());
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (frame[index] !== MAGIC[index]) {
      return { ok: false, kind: 'corrupt', problems: ['这不是本应用的备份文件。'] };
    }
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLength = view.getUint32(8, true);
  const payloadLength = view.getUint32(12, true);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    return { ok: false, kind: 'corrupt', problems: ['备份头部的长度不合理，文件可能已损坏。'] };
  }
  if (payloadLength > MAX_TOTAL_BYTES) {
    return { ok: false, kind: 'corrupt', problems: ['备份声明的内容过大，已拒绝读取。'] };
  }
  const expected = FRAME_BYTES + headerLength + payloadLength;
  if (file.size !== expected) {
    return {
      ok: false,
      kind: 'corrupt',
      problems: ['备份文件不完整，或末尾有多余内容；它可能被截断或改动过。'],
    };
  }

  const headerBytes = new Uint8Array(
    await file.slice(FRAME_BYTES, FRAME_BYTES + headerLength).arrayBuffer(),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    return { ok: false, kind: 'corrupt', problems: ['备份的头部无法解析。'] };
  }
  const shape = headerProblems(parsed);
  if (shape.length > 0) return { ok: false, kind: 'corrupt', problems: shape };

  const header = parsed as BackupHeader & { data: unknown };
  if (header.formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      kind: 'unsupported-version',
      problems: [
        `这个备份由更新版本的应用写入（格式 v${String(header.formatVersion)}，当前应用读取 v${String(BACKUP_FORMAT_VERSION)}）。`,
      ],
    };
  }
  if (header.formatVersion < 1) {
    return { ok: false, kind: 'corrupt', problems: ['备份的格式版本无效。'] };
  }

  const files = header.files;
  if (files.length > MAX_BACKUP_FILES) {
    return { ok: false, kind: 'corrupt', problems: ['备份里的文件数量超出上限。'] };
  }
  const hashes = new Set<string>();
  let offset = 0;
  for (const entry of files) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256) ||
      typeof entry.name !== 'string' ||
      entry.name.length > MAX_FILE_NAME ||
      typeof entry.bytes !== 'number' ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > PDF_MAX_BYTES ||
      entry.offset !== offset
    ) {
      return { ok: false, kind: 'corrupt', problems: ['备份的文件清单不一致，已拒绝读取。'] };
    }
    if (hashes.has(entry.sha256)) {
      return { ok: false, kind: 'corrupt', problems: ['备份的文件清单里有重复的文件。'] };
    }
    hashes.add(entry.sha256);
    offset += entry.bytes;
  }
  if (offset !== payloadLength) {
    return { ok: false, kind: 'corrupt', problems: ['备份的文件清单与内容长度不一致。'] };
  }
  if (
    typeof header.integrity !== 'object' ||
    header.integrity === null ||
    typeof header.integrity.dataSha256 !== 'string'
  ) {
    return { ok: false, kind: 'corrupt', problems: ['备份缺少完整性校验信息。'] };
  }
  const digest = await sha256Hex(canonicalJson(header.data));
  if (digest !== header.integrity.dataSha256) {
    return {
      ok: false,
      kind: 'corrupt',
      problems: ['备份的数据没有通过完整性校验，可能已损坏或被改动。'],
    };
  }

  return { ok: true, header, headerBytes, payloadOffset: FRAME_BYTES + headerLength };
}

/**
 * Reads every carried file, checks its content hash and checks that it still looks like a PDF.
 *
 * One file is read at a time. The next slice is only taken after the previous digest has been
 * computed, so peak memory is one PDF, not the whole backup.
 */
export async function inspectBackupContainer(
  file: Blob,
  onProgress?: (done: number, total: number) => void,
): Promise<InspectContainer> {
  const opened = await openBackup(file);
  if (!opened.ok) return opened;

  const { header } = opened;
  const problems: string[] = [];
  const warnings: string[] = [];
  const fileHashes = new Set<string>();
  const fileBytes = new Map<string, number>();
  for (const [index, entry] of header.files.entries()) {
    onProgress?.(index, header.files.length);
    const start = opened.payloadOffset + entry.offset;
    const bytes = new Uint8Array(await file.slice(start, start + entry.bytes).arrayBuffer());
    if (bytes.length !== entry.bytes) {
      problems.push(`备份里的第 ${String(index + 1)} 个文件不完整。`);
      continue;
    }
    const digest = await sha256Hex(bytes);
    if (digest !== entry.sha256) {
      problems.push(`备份里的第 ${String(index + 1)} 个文件没有通过哈希校验，内容可能已损坏。`);
      continue;
    }
    const pdf = inspectPdfBytes(bytes);
    if (!pdf.ok) {
      problems.push(`备份里的第 ${String(index + 1)} 个文件不是可读取的 PDF。`);
      continue;
    }
    fileHashes.add(entry.sha256);
    fileBytes.set(entry.sha256, entry.bytes);
  }
  onProgress?.(header.files.length, header.files.length);

  if (problems.length > 0) return { ok: false, kind: 'corrupt', problems };

  const declaredMissing = [...new Set(header.missingFiles)];
  for (const hash of declaredMissing) {
    if (!SHA256.test(hash)) warnings.push('备份记录了一个格式不正确的缺失文件哈希，已忽略。');
  }
  return { ok: true, header, payloadOffset: opened.payloadOffset, fileHashes, fileBytes, warnings };
}

/** Yields one carried file's bytes. The caller is expected to use them and drop the reference. */
export async function readBackupFile(
  file: Blob,
  header: BackupHeader,
  payloadOffset: number,
  sha256: string,
): Promise<PdfBytes | null> {
  const entry = header.files.find((candidate) => candidate.sha256 === sha256);
  if (entry === undefined) return null;
  const start = payloadOffset + entry.offset;
  const bytes = new Uint8Array(await file.slice(start, start + entry.bytes).arrayBuffer());
  return bytes;
}

/** `research-workspace-2026-10-17-1530.rwbackup` */
export function backupFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `research-workspace-${stamp}.rwbackup`;
}

/** Starts the browser download. The element is removed immediately; the URL is revoked later. */
export function downloadBackup(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}
