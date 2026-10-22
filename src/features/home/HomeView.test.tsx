import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Paper } from '../../domain/papers';
import type { Project } from '../../domain/project';
import { HomeView } from './HomeView';

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0);

function project(id: string, name: string, updatedAt: number): Project {
  return {
    id,
    name,
    corePaperId: `paper-${id}`,
    relatedPaperIds: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const PDF = { sha256: 'a'.repeat(64), name: 'a.pdf', bytes: 1, pageCount: 10, addedAt: 1 };

function paper(id: string, title: string, reading?: { page: number; updatedAt: number }): Paper {
  return {
    id,
    title,
    authors: [],
    ...(reading === undefined ? {} : { reading }),
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  };
}

function renderHome(
  options: {
    projects?: Project[];
    papers?: Paper[];
    selected?: Project | null;
    welcome?: string;
  } = {},
) {
  const handlers = {
    onCreate: vi.fn(),
    onOpenSelected: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenReader: vi.fn(),
    onImport: vi.fn(),
    onLibrary: vi.fn(),
  };
  render(
    <HomeView
      welcome={{ text: options.welcome ?? '早上好。选一个项目，接着往下读。', status: 'ready' }}
      selected={options.selected ?? null}
      projects={options.projects ?? []}
      papers={options.papers ?? []}
      now={NOW}
      {...handlers}
    />,
  );
  return { user: userEvent.setup(), ...handlers };
}

describe('HomeView', () => {
  it('shows the greeting as the page heading without the avatar', () => {
    renderHome();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('早上好');
    expect(document.querySelector('.avatar-block')).toBeNull();
  });

  it('shows real empty states without inventing projects or papers', () => {
    renderHome();
    expect(screen.getByText(/项目列表还是空的/)).toBeInTheDocument();
    expect(screen.getByText(/还没有论文/)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('lists only papers that have a saved reading position, newest first', async () => {
    const older = paper('p1', 'Older Paper', { page: 3, updatedAt: NOW - 86_400_000 });
    const newer = paper('p2', 'Newer Paper', { page: 12, updatedAt: NOW - 60_000 });
    const unread = paper('p3', 'Unread Paper');
    const { user, onOpenReader } = renderHome({ papers: [older, newer, unread] });

    const titles = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((text) => text.includes('Paper'));
    expect(titles[0]).toContain('Newer Paper');
    expect(titles[1]).toContain('Older Paper');
    expect(screen.queryByText('Unread Paper')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Newer Paper/ }));
    expect(onOpenReader).toHaveBeenCalledWith('p2');
  });

  it('lists real projects and opens the chosen one', async () => {
    const alpha = project('a', 'Alpha', NOW - 5000);
    const beta = project('b', 'Beta', NOW - 1000);
    const { user, onOpenProject, onOpenSelected } = renderHome({
      projects: [alpha, beta],
      selected: alpha,
    });

    const list = screen.getByRole('region', { name: '最近项目' });
    const rows = within(list).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Beta');
    expect(rows[1]).toHaveTextContent('Alpha');

    await user.click(within(list).getByRole('button', { name: /Alpha/ }));
    expect(onOpenProject).toHaveBeenCalledWith('a');

    await user.click(screen.getByRole('button', { name: /打开《Alpha》/ }));
    expect(onOpenSelected).toHaveBeenCalled();
  });

  it('queues unread papers that have a file, newest first', async () => {
    const older = { ...paper('p1', 'Older Unread'), pdf: PDF, createdAt: NOW - 2000 };
    const newer = { ...paper('p2', 'Newer Unread'), pdf: PDF, createdAt: NOW - 1000 };
    const noFile = paper('p3', 'No File');
    const done = { ...paper('p4', 'Finished'), pdf: PDF, status: 'done' as const };
    const { user, onOpenReader } = renderHome({ papers: [older, newer, noFile, done] });

    const queue = screen.getByRole('region', { name: '阅读队列' });
    const rows = within(queue).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Newer Unread');
    expect(rows[1]).toHaveTextContent('Older Unread');
    expect(within(queue).queryByText('No File')).toBeNull();
    expect(within(queue).queryByText('Finished')).toBeNull();

    await user.click(within(queue).getByRole('button', { name: /Older Unread/ }));
    expect(onOpenReader).toHaveBeenCalledWith('p1');
  });

  it('counts papers by reading status', () => {
    const reading = { ...paper('p1', 'Reading'), pdf: PDF, status: 'reading' as const };
    const done = { ...paper('p2', 'Done'), status: 'done' as const };
    const unread = { ...paper('p3', 'Unread'), pdf: PDF };
    renderHome({ papers: [reading, done, unread] });
    const queue = screen.getByRole('region', { name: '阅读队列' });
    expect(within(queue).getByText('1 在读 · 1 未读 · 1 读完')).toBeInTheDocument();
  });

  it('does not queue an unread paper that already has a reading position', () => {
    const started = {
      ...paper('p1', 'Started But Unread', { page: 3, updatedAt: NOW }),
      pdf: PDF,
      status: 'unread' as const,
    };
    renderHome({ papers: [started] });
    const queue = screen.getByRole('region', { name: '阅读队列' });
    expect(within(queue).queryByRole('button', { name: /Started But Unread/ })).toBeNull();
    expect(within(queue).getByText('队列里没有待读的论文。')).toBeInTheDocument();
  });
});
