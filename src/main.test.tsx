import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  render: vi.fn<(node: ReactNode) => void>(),
  retain: vi.fn<(retain: boolean | undefined) => void>(),
  recover: vi.fn<(input: { onManualRecovery?: (detail: string) => void }) => Promise<string>>(),
}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: mocks.render }) }));
vi.mock('./services/backupService', () => ({
  recoverInterruptedRestore: mocks.recover,
  readPdfReferences: vi.fn(),
}));
vi.mock('./services/restoreJournal', () => ({ createIndexedDbJournal: () => ({}) }));
vi.mock('./services/pdfStore', () => ({ createPdfBlobStore: () => ({}) }));
vi.mock('./services/pdfGarbageCollection', () => ({ collectStartupPdfGarbage: vi.fn() }));
vi.mock('./services/workspaceAccess', () => ({ workspaceAccess: { bindLifecycle: vi.fn() } }));
vi.mock('./services/workspaceStartup', () => ({
  initializeWorkspace: async (
    _mount: unknown,
    deps: { recover: () => Promise<string>; retainLeaseOnBlock?: () => boolean },
  ) => {
    await deps.recover();
    mocks.retain(deps.retainLeaseOnBlock?.());
    return { status: 'blocked', detail: 'blocked fixture' };
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.render.mockClear();
  mocks.retain.mockClear();
  mocks.recover.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
});

it.each([false, true])(
  'shows retry only when startup can safely offer it (manual=%s)',
  async (manual) => {
    mocks.recover.mockImplementation(async ({ onManualRecovery }) => {
      if (manual) onManualRecovery?.('Do not reload: durable conflict invalidation failed.');
      return 'blocked';
    });
    await import('./main');
    await waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
    const html = renderToStaticMarkup(mocks.render.mock.calls[0]![0]);
    expect(html).toContain('工作区已暂停');
    expect(mocks.retain).toHaveBeenCalledWith(manual);
    if (manual) {
      expect(html).toContain('Do not reload: durable conflict invalidation failed.');
      expect(html).not.toContain('<button');
    } else {
      expect(html).toContain('重新检查');
    }
  },
);
