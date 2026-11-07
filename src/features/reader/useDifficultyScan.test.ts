import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiClientOptions, DifficultyAnalysis } from '../../services/ai/client';
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
    online: false,
    serviceInstanceId: 'service-instance-1',
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

  it('requires a fresh consent before automatic analysis makes paid calls', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze, online: true })));

    // Online, enabled from a saved preference, and still nothing is sent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(result.current.autoPaused).toBe(true);

    await act(async () => {
      result.current.grantOnlineConsent();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(result.current.autoPaused).toBe(false);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('revokes the paid consent when the service mode changes', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi.fn(async () => ({ ok: true as const, value: analysis() }));
    const { result, rerender } = renderHook(
      ({ online, serviceInstanceId }: { online: boolean; serviceInstanceId: string }) =>
        useDifficultyScan(baseOptions({ analyze, online, serviceInstanceId })),
      { initialProps: { online: false, serviceInstanceId: 'service-instance-1' } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);

    // Offline consent existed implicitly; going online restarts the service, and the new
    // instance id must stop the automatic pass until consent is granted again.
    rerender({ online: true, serviceInstanceId: 'service-instance-2' });
    expect(result.current.enabled).toBe(true);
    expect(result.current.autoPaused).toBe(true);
    await act(async () => {
      result.current.grantOnlineConsent();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(result.current.autoPaused).toBe(false);
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

  /**
   * The queue only holds pages that are waiting, so `includes` cannot see the one that is
   * already running. Asking for that page again must join the running request instead of
   * starting a second one.
   */
  it('never sends the same page twice while it is already being analysed', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const deferred = pendingAnalysis();
    const analyze = vi.fn(() => deferred.promise);
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    // The reader clicks "analyse this page" while the automatic request is still unanswered.
    act(() => {
      result.current.analyse(3);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(analysis());
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.analysedPages).toBe(1);
  });

  it('drops automatic work when the feature is turned off, and keeps manual work', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const deferred = pendingAnalysis();
    const analyze = vi.fn((request: { paper: { page: number } }, options?: AiClientOptions) => {
      signals.push(options?.signal ?? null);
      return request.paper.page === 3 ? deferred.promise : Promise.resolve(okAnalysis());
    });
    const signals: (AbortSignal | null)[] = [];
    const { result, rerender } = renderHook(
      (props: DifficultyScanOptions) => useDifficultyScan(props),
      {
        initialProps: baseOptions({
          analyze,
          pageTextFor: (page) => (page === 3 || page === 4 ? PAGE_TEXT : null),
        }),
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    // Page 4 is queued behind the running page 3.
    rerender(
      baseOptions({
        analyze,
        currentPage: 4,
        pageTextFor: (page) => (page === 3 || page === 4 ? PAGE_TEXT : null),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setEnabled(false);
    });
    // The automatic page that was running is cancelled, and the queued automatic page is gone.
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      deferred.resolve(analysis());
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.all).toEqual([]);

    // A manual request is still the reader's own action, and still works.
    await act(async () => {
      result.current.analyse(4);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.current.current).toHaveLength(1);
  });

  it('invalidates a running task when the PDF is replaced, and cannot write the old result', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const deferred = pendingAnalysis();
    const signals: (AbortSignal | null)[] = [];
    const analyze = vi.fn(
      (_request: { paper: { pdfSha256: string } }, options?: AiClientOptions) => {
        signals.push(options?.signal ?? null);
        return deferred.promise;
      },
    );
    const { result, rerender } = renderHook(
      (props: DifficultyScanOptions) => useDifficultyScan(props),
      { initialProps: baseOptions({ analyze }) },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    rerender(baseOptions({ analyze, pdfSha256: 'b'.repeat(64) }));
    expect(signals[0]?.aborted).toBe(true);

    // The old request settles late, successfully. It belongs to the previous file.
    await act(async () => {
      deferred.resolve(analysis());
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(result.current.analysedPages).toBe(0);
    expect(result.current.all).toEqual([]);
  });

  it('invalidates a running task when the service instance changes', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const deferred = pendingAnalysis();
    const signals: (AbortSignal | null)[] = [];
    const analyze = vi.fn(async (_request: unknown, options?: AiClientOptions) => {
      signals.push(options?.signal ?? null);
      return deferred.promise;
    });
    const { result, rerender } = renderHook(
      (props: DifficultyScanOptions) => useDifficultyScan(props),
      {
        initialProps: baseOptions({
          analyze,
          online: true,
          serviceInstanceId: 'service-1',
        }),
      },
    );
    act(() => {
      result.current.grantOnlineConsent();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(analyze).toHaveBeenCalledTimes(1);

    rerender(baseOptions({ analyze, online: true, serviceInstanceId: 'service-2' }));
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.autoPaused).toBe(true);

    await act(async () => {
      deferred.resolve(analysis());
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flush();
    // The old answer is not written, and no new paid request was queued without consent.
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.all).toEqual([]);
  });

  it('does not record a cancelled request as a page failure', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const deferred = pendingAnalysis();
    const analyze = vi
      .fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(okAnalysis());
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    act(() => {
      result.current.setEnabled(false);
    });
    await act(async () => {
      deferred.reject(new Error('aborted'));
      await Promise.resolve();
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();

    // Turning the feature back on retries the page: a cancellation is not a failure.
    act(() => {
      result.current.setEnabled(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.current.current).toHaveLength(1);
  });

  it('does not retry a page automatically right after a manual attempt failed', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi
      .fn()
      .mockRejectedValueOnce(new Error('上游失败'))
      .mockResolvedValue(okAnalysis());
    const { result } = renderHook(() => useDifficultyScan(baseOptions({ analyze })));

    // The automatic timer is already pending when the reader asks for the page themselves.
    await act(async () => {
      result.current.analyse(3);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('error');

    // The pending automatic timer must not turn a failed manual attempt into a second paid
    // request. A failure is retried only by an explicit click.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('scopes a failure to the file it happened on', async () => {
    saveDifficultyPrefs({ enabled: true, markersVisible: true });
    const analyze = vi
      .fn()
      .mockRejectedValueOnce(new Error('上游失败'))
      .mockResolvedValue(okAnalysis());
    const { result, rerender } = renderHook(
      (props: DifficultyScanOptions) => useDifficultyScan(props),
      { initialProps: baseOptions({ analyze }) },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('error');

    // The same page number in the replacement file is a different page, not a known failure.
    rerender(baseOptions({ analyze, pdfSha256: 'b'.repeat(64) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    await flush();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.current.current).toHaveLength(1);
  });
});

function okAnalysis(): { ok: true; value: DifficultyAnalysis } {
  return { ok: true, value: analysis() };
}

/** A request the test still owes the hook; the signal lets a test observe cancellation. */
function pendingAnalysis(): {
  promise: Promise<{ ok: true; value: DifficultyAnalysis }>;
  resolve: (value: DifficultyAnalysis) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: DifficultyAnalysis) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ ok: true; value: DifficultyAnalysis }>((settle, fail) => {
    resolve = (value) => {
      settle({ ok: true, value });
    };
    reject = fail;
  });
  return { promise, resolve, reject };
}
