import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowBar } from './WindowBar';

/**
 * The bar replaces the native title bar, so these are the three things it must get right:
 * the buttons exist, they call the window API, and the middle one tells the truth about
 * whether the window is currently maximised.
 */
const mocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.close,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
  }),
}));

let maximized = false;
let notifyResized: (() => void) | null = null;

beforeEach(() => {
  maximized = false;
  notifyResized = null;
  mocks.minimize.mockClear();
  mocks.toggleMaximize.mockClear();
  mocks.close.mockClear();
  mocks.isMaximized.mockReset();
  mocks.isMaximized.mockImplementation(() => Promise.resolve(maximized));
  mocks.onResized.mockReset();
  mocks.onResized.mockImplementation((handler: () => void) => {
    notifyResized = handler;
    return Promise.resolve(() => {
      notifyResized = null;
    });
  });
});

describe('WindowBar', () => {
  it('offers the three window controls and a drag region', () => {
    const { container } = render(<WindowBar />);
    expect(screen.getByRole('button', { name: '最小化' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
    // Without this attribute the window could no longer be moved by its top edge.
    expect(container.querySelector('.window-bar')).toHaveAttribute('data-tauri-drag-region');
  });

  it('drives the window API from each control', async () => {
    const user = userEvent.setup();
    render(<WindowBar />);
    await user.click(screen.getByRole('button', { name: '最小化' }));
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '最大化' }));
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('reports the window as restored again once it is unmaximised', async () => {
    render(<WindowBar />);
    expect(await screen.findByRole('button', { name: '最大化' })).toBeInTheDocument();
    expect(mocks.onResized).toHaveBeenCalledTimes(1);

    // Maximising by double click or a snap gesture never touches this component's own button,
    // so the icon has to follow the window rather than the click.
    maximized = true;
    notifyResized?.();
    expect(await screen.findByRole('button', { name: '向下还原' })).toBeInTheDocument();

    maximized = false;
    notifyResized?.();
    expect(await screen.findByRole('button', { name: '最大化' })).toBeInTheDocument();
  });
});
