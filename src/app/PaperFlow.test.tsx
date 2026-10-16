import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PdfBytes } from '../domain/pdfFile';
import { PdfStoreError, type PdfBlobStore } from '../services/pdfStore';
import { createProjectsStore, type ProjectsStore } from '../services/projectsStore';
import { SCHEMA_VERSION } from '../domain/migrate';
import { PROJECTS_STORAGE_KEY } from './config';
import { App } from './App';

const PDF_BYTES: PdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** In-memory stand-in for IndexedDB, keyed by content hash like the real one. */
type MemoryBlobs = PdfBlobStore & { files: Map<string, PdfBytes> };

function memoryBlobs(initial: Record<string, PdfBytes> = {}): MemoryBlobs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    durable: true,
    has: (sha256) => Promise.resolve(files.has(sha256)),
    get: (sha256) => Promise.resolve(files.get(sha256) ?? null),
    put: (sha256, bytes) => {
      files.set(sha256, bytes);
      return Promise.resolve();
    },
    remove: (sha256) => {
      files.delete(sha256);
      return Promise.resolve();
    },
    usage: () => Promise.resolve(null),
  };
}

const acceptAnyPdf = (): Promise<{ pageCount: number }> => Promise.resolve({ pageCount: 3 });

function pdfFile(name = 'attention.pdf', bytes: PdfBytes = PDF_BYTES): File {
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

const sha256Of = async (bytes: PdfBytes): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

function setup(options: { store?: ProjectsStore; blobs?: MemoryBlobs } = {}) {
  const user = userEvent.setup();
  const store = options.store ?? createProjectsStore();
  const blobs: MemoryBlobs = options.blobs ?? memoryBlobs();
  const utils = render(<App store={store} blobs={blobs} probe={acceptAnyPdf} />);
  return { user, store, blobs, ...utils };
}

const sidebar = () => screen.getByRole('complementary', { name: '项目导航' });
const projectRows = () => within(sidebar()).getByRole('region', { name: '项目' });

async function createProject(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
  const dialog = await screen.findByRole('dialog', { name: '新建项目' });
  await user.type(within(dialog).getByLabelText('核心论文标题'), title);
  await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
}

async function importFile(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  file: File,
  title?: string,
) {
  const dialog = await screen.findByRole('dialog', { name: /导入/ });
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('file input not found');
  await user.upload(input, file);
  if (title !== undefined) {
    const titleField = within(dialog).getByLabelText('标题');
    await user.clear(titleField);
    await user.type(titleField, title);
  }
  await user.click(within(dialog).getByRole('button', { name: '导入' }));
  return { dialog, container };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('importing a PDF into a project', () => {
  it('stores the file, registers the paper and links it to the project', async () => {
    const { user, store, blobs, container } = setup();
    await createProject(user, 'Attention');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Attention' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '导入新论文' }));
    await importFile(user, container, pdfFile('attention_is_all_you_need.pdf'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /导入/ })).not.toBeInTheDocument();
    });

    const state = store.getSnapshot().state;
    // Two papers: the project's core paper (created with the project) and the import.
    const papers = Object.values(state.papers);
    expect(papers).toHaveLength(2);
    const paper = papers.find((candidate) => candidate.pdf !== undefined);
    expect(paper?.title).toBe('attention is all you need');
    expect(paper?.pdf?.name).toBe('attention_is_all_you_need.pdf');
    expect(paper?.pdf?.bytes).toBe(PDF_BYTES.length);
    expect(paper?.pdf?.pageCount).toBe(3);

    // The bytes are in the blob store under their content hash, and the payload is v3.
    const sha256 = await sha256Of(PDF_BYTES);
    expect(paper?.pdf?.sha256).toBe(sha256);
    expect(blobs.files.has(sha256)).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(PROJECTS_STORAGE_KEY) ?? 'null');
    expect(stored.version).toBe(SCHEMA_VERSION);
    expect(stored.papers[paper?.id ?? '']?.pdf?.sha256).toBe(sha256);
  });

  it('opens the reader for the paper it just imported', async () => {
    const { user, container } = setup();
    await createProject(user, 'Attention');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Attention' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '导入新论文' }));
    await importFile(user, container, pdfFile());

    // The reader takes over the main area; whether the document parses in jsdom is not the
    // point here — the navigation is.
    expect(await screen.findByRole('button', { name: '返回' })).toBeInTheDocument();
    expect(container.querySelector('.reader')).not.toBeNull();
  });

  it('refuses a file that is not a PDF, without storing anything', async () => {
    const { user, blobs, container } = setup();
    await createProject(user, 'Attention');
    await user.click(screen.getByRole('button', { name: '导入新论文' }));

    await importFile(user, container, pdfFile('notes.pdf', new TextEncoder().encode('just notes')));

    const dialog = await screen.findByRole('dialog', { name: /导入/ });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('不是一个 PDF 文件');
    expect(blobs.files.size).toBe(0);
  });

  it('reports a storage failure instead of pretending the file was saved', async () => {
    const blobs = memoryBlobs();
    blobs.put = () =>
      Promise.reject(new PdfStoreError('quota', '浏览器存储空间不足，文件没有保存。'));
    const { user, container } = setup({ blobs });
    await createProject(user, 'Attention');
    await user.click(screen.getByRole('button', { name: '导入新论文' }));

    await importFile(user, container, pdfFile());

    const dialog = await screen.findByRole('dialog', { name: /导入/ });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('空间不足');
    expect(screen.queryByRole('button', { name: '返回' })).not.toBeInTheDocument();
  });
});

describe('importing a file that is already in the library', () => {
  it('asks before reusing the paper and stores the bytes only once', async () => {
    const blobStore = memoryBlobs();
    const store = createProjectsStore();
    const { user, container } = setup({ store, blobs: blobStore });
    await createProject(user, 'Attention');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Attention' })).toBeInTheDocument();
    });

    // First import: the file belongs to this project's paper.
    await user.click(screen.getByRole('button', { name: '导入新论文' }));
    await importFile(user, container, pdfFile('attention.pdf'), 'Attention Is All You Need');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /导入/ })).not.toBeInTheDocument();
    });
    const firstPaperId = Object.keys(store.getSnapshot().state.papers)[0] ?? '';

    // Second import of the same bytes: it must ask, not decide.
    await user.click(screen.getByRole('button', { name: '返回' }));
    const projectPage = await screen.findByRole('button', { name: '导入新论文' });
    expect(projectPage).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导入新论文' }));
    await importFile(user, container, pdfFile('attention-again.pdf'), 'A different paper');

    const dialog = await screen.findByRole('dialog', { name: /导入/ });
    await user.click(await within(dialog).findByRole('button', { name: /仍然新建一篇论文/ }));

    await waitFor(() => {
      expect(Object.keys(store.getSnapshot().state.papers)).toHaveLength(3);
    });
    // Same content, one stored file, and two distinct papers holding it.
    expect(blobStore.files.size).toBe(1);
    const withFile = Object.values(store.getSnapshot().state.papers).filter(
      (paper) => paper.pdf !== undefined,
    );
    expect(withFile).toHaveLength(2);
    expect(withFile[0]?.pdf?.sha256).toBe(withFile[1]?.pdf?.sha256);
    expect(withFile[1]?.id).not.toBe(firstPaperId);
  });
});

describe('the library', () => {
  it('lists papers and adds one to a project', async () => {
    const store = createProjectsStore();
    const { user } = setup({ store });
    await createProject(user, 'Attention');

    await user.click(within(sidebar()).getByRole('button', { name: '论文库' }));

    const library = await screen.findByRole('region', { name: '论文库' });
    expect(within(library).getByRole('heading', { name: 'Attention' })).toBeInTheDocument();
    expect(within(library).getByText(/用于：/)).toBeInTheDocument();

    // A second project, so the picker has somewhere to add the paper.
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    await user.type(within(dialog).getByLabelText('核心论文标题'), 'BERT');
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
    await user.click(within(sidebar()).getByRole('button', { name: '论文库' }));

    await waitFor(() => {
      expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
    });
    const row = screen.getAllByRole('article')[0];
    if (row === undefined) throw new Error('no paper row');
    await user.selectOptions(
      within(row).getByLabelText('选择要加入的项目'),
      within(row).getByRole('option', { name: 'BERT' }),
    );
    await user.click(within(row).getByRole('button', { name: '加入' }));

    await waitFor(() => {
      const bert = store.getSnapshot().state.projects.find((project) => project.name === 'BERT');
      expect(bert?.relatedPaperIds).toHaveLength(1);
    });
  });

  it('finds a paper by its author', async () => {
    const store = createProjectsStore();
    const { user } = setup({ store });
    const paper = {
      id: 'p1',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani'],
      createdAt: 1,
      updatedAt: 1,
    };
    store.dispatch({ type: 'registerPaper', paper });

    await user.click(within(sidebar()).getByRole('button', { name: '论文库' }));
    const search = await screen.findByRole('searchbox');
    await user.type(search, 'vaswani');
    expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'nothing matches this');
    expect(screen.queryByText('Attention Is All You Need')).not.toBeInTheDocument();
  });
});

describe('opening a paper whose file is gone', () => {
  it('explains what happened instead of crashing', async () => {
    const store = createProjectsStore();
    const emptyBlobs = memoryBlobs();
    const { user } = setup({ store, blobs: emptyBlobs });
    await createProject(user, 'Attention');
    const paper = Object.values(store.getSnapshot().state.papers)[0];
    if (paper === undefined) throw new Error('no paper');

    // A binding that points at a file the blob store no longer has.
    store.dispatch({
      type: 'updatePaper',
      paperId: paper.id,
      edit: {
        pdf: { sha256: 'a'.repeat(64), name: 'gone.pdf', bytes: 10, pageCount: 2, addedAt: 1 },
      },
      now: 5,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '阅读' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '阅读' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('没有找到这个 PDF');
    expect(screen.getByRole('button', { name: '导入 PDF 文件' })).toBeInTheDocument();
    // The rest of the app is still there.
    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Attention' })).toBeInTheDocument();
  });

  it('offers to import a file for a paper that never had one', async () => {
    const store = createProjectsStore();
    const { user } = setup({ store });
    await createProject(user, 'Attention');

    expect(screen.getByText('没有本地 PDF')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '阅读' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入 PDF' })).toBeInTheDocument();
  });
});

describe('paper metadata editing', () => {
  it('saves an edited title and refuses an identifier another paper owns', async () => {
    const store = createProjectsStore();
    const { user } = setup({ store });
    store.dispatch({
      type: 'registerPaper',
      paper: {
        id: 'other',
        title: 'BERT',
        authors: [],
        doi: '10.1000/bert',
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await createProject(user, 'Attention');

    await user.click(screen.getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑论文信息' });
    const titleField = within(dialog).getByLabelText('标题');
    await user.clear(titleField);
    await user.type(titleField, 'Attention Is All You Need');
    await user.type(within(dialog).getByLabelText('DOI（留空表示清除）'), '10.1000/bert');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('BERT');
    await waitFor(() => {
      const paper = Object.values(store.getSnapshot().state.papers).find(
        (candidate) => candidate.id !== 'other',
      );
      expect(paper?.title).toBe('Attention');
    });

    // Clearing the DOI field and saving again works.
    await user.clear(within(dialog).getByLabelText('DOI（留空表示清除）'));
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑论文信息' })).not.toBeInTheDocument();
    });
    const edited = Object.values(store.getSnapshot().state.papers).find(
      (candidate) => candidate.id !== 'other',
    );
    expect(edited?.title).toBe('Attention Is All You Need');
    expect(edited?.doi).toBeUndefined();
  });
});

describe('sidebar navigation', () => {
  it('marks the library as the current page and returns home', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '论文库' }));
    expect(within(sidebar()).getByRole('button', { name: '论文库' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(sidebar()).getByRole('button', { name: '首页' }));
    expect(within(sidebar()).getByRole('button', { name: '首页' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(projectRows()).toBeInTheDocument();
  });
});
