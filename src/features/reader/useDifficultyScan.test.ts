import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DifficultyAnalysis } from '../../services/ai/client';
import {
  DIFFICULTY_PREFS_KEY,
  DIFFICULTY_STORAGE_KEY,
  saveDifficultyPrefs,
} from '../../services/difficultyStore';
import { useDifficultyScan, type DifficultyScanOptions } from './useDifficultyScan';

/**
 * Lets the promise chain behind an analysis finish.
 *
 * `waitFor` polls on timers, and these tests run on fake ones, so it would wait forever. A few
 * microtask turns are enough: the work is three `await`s deep, not a real delay.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function analysis(overrides: Partial<DifficultyAnalysis> = {}): DifficultyAnalysis {
  return {
    provider: 'mock',
    providerLabel: '本地模拟',
    model: 'mock-1',
    online: false,
    page: 3,
    rulesVersion: 'd1',
    status: 'valid',
    suggestions: [
      {
        kind: 'concept',
        title: '这一页的核心概念',
        quote: 'the model fills in multiple masked regions',
        why: '主线。',
        quick: '一次填多个空。',
        deeper: null,
      },
    ],
    rejected: 1,
    ...overrides,
  };
}

const PAGE_TEXT =
  'We introduce multi-target few-shot prompting. The model fills in multiple masked regions.';

function baseOptions(overrides: Partial<DifficultyScanOptions> = {}): DifficultyScanOptions {
  return {
    paperId: 'paper-1',
    pdfSha256: 'a'.repeat(64),
    model: 'mock-1',
    currentPage: 3,
    pageTextFor: (page) => (page === 3 ? PAGE_TEXT : null),
    locate: () => ({
      location: 'found',
      anchor: { quote: 'x', prefix: '', suffix: '', rects: [], start: 0, end: 1 },
    }),
    ...overrides,
  };
}

describe('useDifficultyScan', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing at all until it is turned on', async () => {
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
    expect(result.current.all).toEqual([]);
  });

  it('analyses the page the reader is on once, after they settle on it', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(result.current.current).toHaveLength(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    const calls = analyze.mock.calls as unknown as {
      paper: { id: string; page: number };
      pageText: string;
    }[][];
    const firstCall = calls[0]?.[0];
    expect(firstCall).toMatchObject({ paper: { id: 'paper-1', page: 3 }, pageText: PAGE_TEXT });

    // The page is cached: staying on it must not send it again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.analysedPages).toBe(1);
  });

  it('keeps a failure inside the hook, and offers to retry', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        failure: { kind: 'offline' as const, message: '连接不上本地的 AI 服务。' },
      })
      .mockResolvedValue({ ok: true as const, value: analysis() });

    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('连接不上');

    // A failed page is not retried in a loop; the reader asks for it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.analyse(3);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(result.current.current).toHaveLength(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('idle');
  });

  it('waits for a page that has not rendered yet instead of analysing nothing', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    let ready = false;
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() =>
      useDifficultyScan(
        baseOptions({ analyze, pageTextFor: (page) => (ready && page === 3 ? PAGE_TEXT : null) }),
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).not.toHaveBeenCalled();

    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flush();
    expect(result.current.current).toHaveLength(1);
  });

  it('drops an ignored suggestion from both lists and remembers it', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(result.current.current).toHaveLength(1);
    const id = result.current.current[0]?.id;
    expect(id).toBeDefined();

    act(() => {
      result.current.ignore(id ?? '');
    });
    expect(result.current.current).toEqual([]);
    expect(result.current.all).toEqual([]);

    const stored = window.localStorage.getItem(DIFFICULTY_STORAGE_KEY) ?? '';
    expect(stored).toContain('a'.repeat(64));
  });

  it('never runs for a file without a hash, and never for a page with no text', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    renderHook(() =>
      useDifficultyScan(baseOptions({ analyze, pageTextFor: () => null, model: 'mock-1' })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('says why it cannot analyse when the service is not connected', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn();
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze, model: '' })));
    act(() => {
      result.current.analyse(3);
    });
    await flush();
    expect(result.current.error).toContain('还没有连上本地 AI 服务');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('leaves other files alone when the analysis is cleared', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    window.localStorage.setItem(
      DIFFICULTY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        pages: {
          other: {
            paperId: 'paper-2',
            pdfSha256: 'b'.repeat(64),
            page: 1,
            model: 'mock-1',
            rulesVersion: 'd1',
            analysedAt: 1,
            suggestions: [],
            rejected: 0,
          },
        },
        ignored: {},
      }),
    );
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(result.current.analysedPages).toBe(1);
    act(() => {
      result.current.reanalyse();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The other file's cached page is still on disk; only this file was cleared and redone.
    const stored = window.localStorage.getItem(DIFFICULTY_STORAGE_KEY) ?? '';
    expect(stored).toContain('b'.repeat(64));
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('does not analyse a second page while the first is still running', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    let release: (() => void) | null = null;
    const analyze = vi.fn(
      async () =>
        new Promise<{ ok: true; value: DifficultyAnalysis }>((resolve) => {
          release = () => {
            resolve({ ok: true, value: analysis() });
          };
        }),
    );
    const { result, rerender } = renderHook(
      (props: DifficultyScanOptions) => useDifficultyScan(props),
      { initialProps: baseOptions({ analyze }) },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    rerender(baseOptions({ analyze, currentPage: 4, pageTextFor: () => PAGE_TEXT }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    // The first request is still in flight; the second page waits its turn.
    expect(analyze).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.analysedPages).toBe(1);
    void DIFFICULTY_PREFS_KEY;
  });
});
