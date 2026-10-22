import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecoveryCopies } from '../../services/recoveryCleanup';
import { ProfilePanel } from './ProfilePanel';

vi.mock('../../services/recoveryCleanup', () => ({
  clearRecoveryCopies: vi.fn(),
}));

const mockedClear = vi.mocked(clearRecoveryCopies);

beforeEach(() => {
  mockedClear.mockReset();
  mockedClear.mockResolvedValue({ keys: 0, journal: false });
});

function setup(onName = vi.fn((raw: string) => raw.trim() || '本地工作区')) {
  render(
    <ProfilePanel name="本地工作区" onName={onName} stats={{ papers: 3, notes: 7, concepts: 2 }} />,
  );
  return { input: screen.getByRole('textbox', { name: '昵称' }), onName };
}

describe('ProfilePanel', () => {
  it('saves the nickname as it is typed and trims it on blur', async () => {
    const user = userEvent.setup();
    const { input, onName } = setup();

    await user.clear(input);
    await user.type(input, 'Ada  ');
    expect(onName).toHaveBeenCalled();
    await user.tab();
    expect(input).toHaveValue('Ada');
  });

  it('shows the app version and the local data counts', () => {
    setup();
    expect(screen.getByText(`v${__APP_VERSION__}`)).toBeInTheDocument();
    expect(screen.getByText(/论文 3 篇 · 笔记 7 条 · 概念 2 个/)).toBeInTheDocument();
  });

  it('confirms before cleaning and reports what was removed', async () => {
    const user = userEvent.setup();
    mockedClear.mockResolvedValue({ keys: 2, journal: true });
    setup();

    await user.click(screen.getByRole('button', { name: '清理恢复副本' }));
    expect(screen.getByText(/论文、PDF、笔记、概念和关系都不会被删除/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清理' }));
    expect(mockedClear).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/清理了 2 个恢复副本，1 份恢复日志/)).toBeInTheDocument();
    expect(screen.getByText(/论文、PDF、笔记和知识都没有改动/)).toBeInTheDocument();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: '清理恢复副本' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(mockedClear).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists the shortcuts that really exist', () => {
    setup();
    expect(screen.getByText('Ctrl / Cmd + F')).toBeInTheDocument();
    expect(screen.getByText('在论文内查找')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
  });
});
