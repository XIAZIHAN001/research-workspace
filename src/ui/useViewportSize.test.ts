import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useViewportSize } from './useViewportSize';

/**
 * The snapshot contract is the whole hook: `useSyncExternalStore` compares snapshots by
 * identity around every render, and a getter that returns a fresh object each time reads as a
 * store that never stops changing. React ends that loop by throwing, and the throw takes the
 * component's error boundary with it — which is exactly how the reader died every time a
 * selection opened the annotation toolbar. These tests pin the contract down.
 */
describe('useViewportSize', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, writable: true });
  });

  it('renders without looping and reports the window size', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
    const { result } = renderHook(() => useViewportSize());
    expect(result.current).toEqual({ width: 1200, height: 800 });
  });

  it('returns the same object while the size is unchanged', () => {
    const first = renderHook(() => useViewportSize());
    const second = renderHook(() => useViewportSize());
    // Two subscribers, same numbers, same value — identity is what the store hook checks.
    expect(first.result.current).toBe(second.result.current);
    const before = first.result.current;
    first.rerender();
    expect(first.result.current).toBe(before);
  });

  it('updates when the window resizes', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, writable: true });
    const { result } = renderHook(() => useViewportSize());
    expect(result.current).toEqual({ width: 1000, height: 700 });
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 900, writable: true });
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ width: 900, height: 700 });
  });
});
