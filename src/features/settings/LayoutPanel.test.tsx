import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LayoutPanel } from './LayoutPanel';

describe('LayoutPanel', () => {
  it('closes the confirmation after restoring the defaults', () => {
    render(
      <LayoutPanel
        preset="balanced"
        onChangePreset={vi.fn()}
        sidebarWidth={224}
        onSidebarWidth={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.getByText('恢复默认布局？')).toBeTruthy();

    const buttons = screen.getAllByRole('button', { name: '恢复默认' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    expect(screen.queryByText('恢复默认布局？')).toBeNull();
  });
});
