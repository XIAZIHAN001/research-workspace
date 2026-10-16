import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_STORAGE_KEY } from '../../app/config';
import { AVATAR_NOTICE_MS, useAvatar } from './useAvatar';

// Only the timeout is faked: leave microtasks and Date alone, so React and FileReader behave.
const useTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

afterEach(() => {
  vi.useRealTimers();
});

const gif = () => new File(['x'], 'a.gif', { type: 'image/gif' });
const png = () => new File(['abc'], 'me.png', { type: 'image/png' });

const upload = async (avatar: ReturnType<typeof useAvatar>, file: File) => {
  await act(async () => {
    await avatar.upload(file);
  });
};

const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe('useAvatar problems', () => {
  it('starts with no problem', () => {
    const { result } = renderHook(() => useAvatar());
    expect(result.current.problem).toBeNull();
  });

  it('reports an unsupported type and keeps the bundled figure', async () => {
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, gif());

    expect(result.current.problem).toBe('type');
    expect(result.current.isCustom).toBe(false);
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('fades the problem on its own', async () => {
    useTimers();
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, gif());
    expect(result.current.problem).toBe('type');

    await wait(AVATAR_NOTICE_MS - 1);
    expect(result.current.problem).toBe('type');

    await wait(1);
    expect(result.current.problem).toBeNull();
  });

  // The notice carries an id, so the same problem twice is two notices and the second one
  // gets its own full time rather than inheriting the first one's nearly finished clock.
  it('gives a repeated problem its own full time', async () => {
    useTimers();
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, gif());
    await wait(AVATAR_NOTICE_MS - 500);

    await upload(result.current, gif());
    await wait(1_000);

    expect(result.current.problem).toBe('type');
  });

  it('clears the problem on demand', async () => {
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, gif());
    expect(result.current.problem).toBe('type');

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.problem).toBeNull();
  });

  it('clears a problem once a usable image is accepted', async () => {
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, gif());
    expect(result.current.problem).toBe('type');

    await upload(result.current, png());

    expect(result.current.problem).toBeNull();
    expect(result.current.isCustom).toBe(true);
    expect(result.current.src).toBe('data:image/png;base64,YWJj');
  });

  it('clears the problem and the figure on reset', async () => {
    const { result } = renderHook(() => useAvatar());
    await upload(result.current, png());
    await upload(result.current, gif());
    expect(result.current.problem).toBe('type');

    act(() => {
      result.current.reset();
    });

    expect(result.current.problem).toBeNull();
    expect(result.current.isCustom).toBe(false);
    expect(result.current.src).toBe('/avatar/default.svg');
  });
});
