import type { PdfBlobStore } from './pdfStore';
import { workspaceAccess } from './workspaceAccess';

/** Best-effort, one-file startup pass. Never suspend a mounted editor for maintenance. */
export async function collectStartupPdfGarbage(
  blobs: Pick<PdfBlobStore, 'collectGarbage'>,
  references: () => ReadonlySet<string> | null,
): Promise<void> {
  if (workspaceAccess.canWrite()) return;
  try {
    await blobs.collectGarbage?.(references);
  } catch {
    // The durable queue remains intact and is retried on a future startup. Maintenance
    // failure must not block an otherwise recovered workspace or discard recovery evidence.
  }
}
