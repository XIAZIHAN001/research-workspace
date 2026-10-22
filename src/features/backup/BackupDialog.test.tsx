import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeState } from '../../domain/knowledge';
import type { Paper } from '../../domain/papers';
import type { ProjectsState } from '../../domain/projectsState';
import { createBackupBlob } from '../../services/backupFormat';
import type { PdfBlobStore } from '../../services/pdfStore';
import { BackupDialog } from './BackupDialog';

const EMPTY_KNOWLEDGE: KnowledgeState = {
  version: 2,
  concepts: [],
  evidence: [],
  relations: [],
  rejections: [],
};

const PAPER: Paper = { id: 'paper-1', title: '论文', authors: [], createdAt: 1, updatedAt: 1 };

function stateWithProject(name: string): ProjectsState {
  return {
    projects: [
      {
        id: 'project-1',
        name,
        corePaperId: 'paper-1',
        relatedPaperIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    papers: { 'paper-1': PAPER },
    annotations: [],
    bookmarks: [],
    selectedId: 'project-1',
  };
}

const blobs: PdfBlobStore = {
  durable: true,
  has: () => Promise.resolve(false),
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  usage: () => Promise.resolve(null),
};

async function backupFile(projectName: string): Promise<File> {
  const { blob } = await createBackupBlob({
    data: {
      projects: {
        version: 5,
        projects: stateWithProject(projectName).projects,
        papers: stateWithProject(projectName).papers,
        annotations: [],
        selectedId: 'project-1',
      },
      knowledge: EMPTY_KNOWLEDGE,
      difficulties: { version: 1, pages: {}, ignored: {} },
      preferences: {},
      recovery: {},
      missingFiles: [],
    },
    files: [],
    createdAt: '2026-10-17T00:00:00.000Z',
    app: { name: 'test', projectsSchema: 5, knowledgeVersion: 1 },
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new File([bytes], 'workspace.rwbackup', { type: 'application/octet-stream' });
}

function setup(projectName: string) {
  return render(
    <BackupDialog
      open
      onClose={vi.fn()}
      projects={stateWithProject(projectName)}
      knowledge={EMPTY_KNOWLEDGE}
      blobs={blobs}
      onReload={vi.fn()}
    />,
  );
}

async function choose(file: File): Promise<void> {
  const input = screen.getByLabelText('选择备份文件');
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/本次会新增/, undefined, { timeout: 5000 });
}

describe('BackupDialog', () => {
  it('shows what a backup would add before offering to restore it', async () => {
    setup('本机的项目');
    await choose(await backupFile('本机的项目'));
    expect(screen.getByText(/本次会新增 0 个项目/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '校验并完成恢复' })).toBeEnabled();
  });

  it('requires an explicit choice when the same id has different content', async () => {
    setup('本机的项目');
    await choose(await backupFile('备份里的项目'));
    expect(screen.getByText(/请选择保留哪一边/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '校验并完成恢复' });
    expect(button).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /保留本机版本/ }));
    expect(button).toBeEnabled();

    await userEvent.click(screen.getByRole('radio', { name: /使用备份里的版本/ }));
    expect(button).toBeEnabled();
  });

  it('says plainly that a damaged file cannot be restored', async () => {
    setup('本机的项目');
    const file = await backupFile('本机的项目');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const damaged = new File([bytes.slice(0, bytes.length - 20)], 'damaged.rwbackup');
    const input = screen.getByLabelText('选择备份文件');
    fireEvent.change(input, { target: { files: [damaged] } });
    await waitFor(() => {
      expect(screen.getByText(/不能恢复/)).toBeInTheDocument();
    });
  });
});
