import { expect, it, vi } from 'vitest';
import { collectStartupPdfGarbage } from './pdfGarbageCollection';
import { workspaceAccess } from './workspaceAccess';

it('does not suspend or discard ordinary actions in an editable workspace', async () => {
  const collectGarbage = vi.fn(async () => ({ removed: 0, more: false }));
  await collectStartupPdfGarbage({ collectGarbage }, () => new Set());
  expect(collectGarbage).not.toHaveBeenCalled();
  expect(workspaceAccess.canWrite()).toBe(true);
});

it('runs only one bounded pass before editing starts, retaining failures for a later startup', async () => {
  const collectGarbage = vi.fn(async () => {
    throw new Error('temporary storage failure');
  });
  workspaceAccess.block();
  await collectStartupPdfGarbage({ collectGarbage }, () => new Set());
  expect(collectGarbage).toHaveBeenCalledOnce();
  expect(workspaceAccess.canWrite()).toBe(false);
});
