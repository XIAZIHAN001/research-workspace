import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlossaryHover } from './GlossaryHover';

const entries = [
  { id: '1', paperId: 'p', term: 'KZG', definition: '多项式承诺方案', createdAt: 1, updatedAt: 1 },
  { id: '2', paperId: 'p', term: '无关术语', definition: 'x', createdAt: 1, updatedAt: 1 },
];

function spanWith(text: string): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  const span = document.createElement('span');
  span.textContent = text;
  layer.append(span);
  document.body.append(layer);
  return span;
}

describe('GlossaryHover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows the card after the settle delay, and hides when the pointer leaves the layer', () => {
    render(<GlossaryHover entries={entries} />);
    const span = spanWith('the KZG commitment scheme');
    fireEvent.mouseOver(span, { clientX: 40, clientY: 40 });
    // jsdom has no caret API: the span-level match stands, which is the documented fallback.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip').textContent).toContain('KZG');
    expect(screen.getByRole('tooltip').textContent).toContain('多项式承诺方案');

    // Moving to a span with no term hides the card (nothing to show there).
    const other = spanWith('plain words here');
    fireEvent.mouseOver(other, { clientX: 60, clientY: 60 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Leaving the layer entirely also hides it.
    const inside = spanWith('KZG again');
    fireEvent.mouseOver(inside, { clientX: 30, clientY: 30 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseOut(inside, { relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a span that mentions no term never opens a card', () => {
    render(<GlossaryHover entries={entries} />);
    const span = spanWith('nothing defined in here');
    fireEvent.mouseOver(span, { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders nothing without entries', () => {
    const { container } = render(<GlossaryHover entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
