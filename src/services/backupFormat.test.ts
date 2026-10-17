import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  canonicalJson,
  countData,
  createBackupBlob,
  inspectBackupContainer,
  openBackup,
  sha256Hex,
} from './backupFormat';

const encoder = new TextEncoder();

function pdfBytes(label: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${label}\n%%EOF`);
}

async function fileEntry(label: string) {
  const bytes = pdfBytes(label);
  return { sha256: await sha256Hex(bytes), name: `${label}.pdf`, bytes };
}

const DATA = {
  projects: {
    projects: [{ id: 'p1' }],
    papers: { a: { id: 'a' }, b: { id: 'b' } },
    annotations: [{ id: 'n1' }, { id: 'n2' }],
    selectedId: 'p1',
  },
  knowledge: {
    version: 1,
    concepts: [{ id: 'c1' }, { id: 'c2' }],
    evidence: [{ id: 'e1' }],
    relations: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
  },
  difficulties: { version: 1, pages: { k1: {} }, ignored: {} },
  preferences: { theme: 'dark' },
  recovery: {},
  missingFiles: [],
};

async function build(fileCount = 2) {
  const files = [];
  for (let index = 0; index < fileCount; index += 1)
    files.push(await fileEntry(`f${String(index)}`));
  return createBackupBlob({
    data: DATA,
    files,
    createdAt: '2026-10-17T00:00:00.000Z',
    app: { name: 'test', projectsSchema: 5, knowledgeVersion: 1 },
  });
}

async function rewrite(
  blob: Blob,
  mutate: (header: Record<string, unknown>) => void,
): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const headerLength = new DataView(bytes.buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(16, 16 + headerLength))) as Record<
    string,
    unknown
  >;
  mutate(header);
  const headerBytes = encoder.encode(JSON.stringify(header));
  const payload = bytes.slice(16 + headerLength);
  const frame = new Uint8Array(16);
  frame.set(encoder.encode('RWBACKUP'), 0);
  const view = new DataView(frame.buffer);
  view.setUint32(8, headerBytes.length, true);
  view.setUint32(12, payload.length, true);
  return new Blob([frame, headerBytes, payload]);
}

describe('backup container', () => {
  it('round trips the data section and the file table', async () => {
    const { blob, header } = await build();
    expect(header.files).toHaveLength(2);
    expect(header.files[1]?.offset).toBe(header.files[0]?.bytes);
    const opened = await openBackup(blob);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.header.data).toEqual(DATA);
    expect(opened.header.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(opened.header.files.map((entry) => entry.name)).toEqual(['f0.pdf', 'f1.pdf']);
  });

  it('counts what the workspace contains, for the preview', async () => {
    const counts = countData(DATA);
    expect(counts).toMatchObject({
      projects: 1,
      papers: 2,
      annotations: 2,
      concepts: 2,
      evidence: 1,
      relations: 3,
      difficultyPages: 1,
    });
  });

  it('canonicalises object keys so the digest survives reordering', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    expect(canonicalJson(null)).toBe('null');
  });

  it('reads a backup whose data was serialised in a different key order', async () => {
    const { blob } = await build(1);
    const reordered = await rewrite(blob, (header) => {
      const data = header.data as typeof DATA;
      header.data = {
        recovery: data.recovery,
        preferences: data.preferences,
        knowledge: data.knowledge,
        projects: data.projects,
        difficulties: data.difficulties,
        missingFiles: data.missingFiles,
      };
    });
    // Rebuilt without recomputing the digest: a real editor would have to recompute it, and
    // this proves the digest itself is order-independent, not that tampering is accepted.
    const opened = await openBackup(reordered);
    expect(opened.ok).toBe(true);
  });

  it('refuses a truncated file', async () => {
    const { blob } = await build();
    const opened = await openBackup(
      new Blob([new Uint8Array(await blob.arrayBuffer()).slice(0, -7)]),
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.kind).toBe('corrupt');
    expect(opened.problems[0]).toContain('不完整');
  });

  it('refuses a file that is not a backup', async () => {
    const opened = await openBackup(new Blob([encoder.encode('this is not a backup at all')]));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.problems[0]).toContain('不是本应用');
  });

  it('refuses a newer format version instead of guessing', async () => {
    const { blob } = await build(1);
    const newer = await rewrite(blob, (header) => {
      header.formatVersion = 2;
    });
    const opened = await openBackup(newer);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.kind).toBe('unsupported-version');
  });

  it('refuses data that was changed after the digest was written', async () => {
    const { blob } = await build(1);
    const changed = await rewrite(blob, (header) => {
      (header.data as { preferences: { theme: string } }).preferences.theme = 'light';
    });
    const opened = await openBackup(changed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.problems.join(' ')).toContain('完整性校验');
  });

  it('refuses a file table whose offsets do not add up', async () => {
    const { blob } = await build(2);
    const broken = await rewrite(blob, (header) => {
      (header.files as { offset: number }[])[1]!.offset = 1;
    });
    const opened = await openBackup(broken);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.problems.join(' ')).toContain('文件清单');
  });

  it('does not pack the same hash twice', async () => {
    const entry = await fileEntry('same');
    await expect(
      createBackupBlob({
        data: DATA,
        files: [entry, entry],
        createdAt: '2026-10-17T00:00:00.000Z',
        app: { name: 'test', projectsSchema: 5, knowledgeVersion: 1 },
      }),
    ).rejects.toThrow('两次');
  });

  it('verifies every carried file and remembers its size', async () => {
    const { blob } = await build(2);
    const inspected = await inspectBackupContainer(blob);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.fileHashes.size).toBe(2);
    for (const entry of inspected.header.files) {
      expect(inspected.fileBytes.get(entry.sha256)).toBe(entry.bytes);
    }
  });

  it('reports a payload whose bytes were altered', async () => {
    const { blob } = await build(1);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const headerLength = new DataView(bytes.buffer).getUint32(8, true);
    bytes[16 + headerLength + 3] = 0x21;
    const inspected = await inspectBackupContainer(new Blob([bytes]));
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.problems.join(' ')).toContain('哈希校验');
  });

  it('refuses a payload entry that is not a PDF', async () => {
    const bytes = encoder.encode('plain text, not a pdf');
    const sha256 = await sha256Hex(bytes);
    const { blob } = await createBackupBlob({
      data: DATA,
      files: [{ sha256, name: 'fake.pdf', bytes }],
      createdAt: '2026-10-17T00:00:00.000Z',
      app: { name: 'test', projectsSchema: 5, knowledgeVersion: 1 },
    });
    const inspected = await inspectBackupContainer(blob);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.problems.join(' ')).toContain('不是可读取的 PDF');
  });
});
