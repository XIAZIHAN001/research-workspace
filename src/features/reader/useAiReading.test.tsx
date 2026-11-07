import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AskOutcome } from '../../services/ai/client';
import type { AiAnswer, AiAskRequest } from '../../services/ai/types';
import { useAiReading, type AiSource } from './useAiReading';

const SOURCE: AiSource = {
  paperId: 'paper-1',
  title: 'A paper',
  pdfSha256: 'a'.repeat(64),
  page: 3,
  anchor: null,
  pageText: 'The model fills in multiple masked regions.',
  layoutNotice: null,
  fragmentation: null,
  documentPages: [],
};

const ANSWER: AiAnswer = {
  provider: 'mock',
  providerLabel: '本地模拟',
  model: 'mock-1',
  online: false,
  mode: 'explain',
  status: 'valid',
  answer: 'second answer',
  groundedInText: true,
  citations: [],
  warnings: [],
  diagnostics: null,
  usage: null,
};

type Pending = { request: AiAskRequest; resolve: (outcome: AskOutcome) => void };

function controlledClient() {
  const pending: Pending[] = [];
  const ask = vi.fn(
    (request: AiAskRequest) =>
      new Promise<AskOutcome>((resolve) => {
        pending.push({ request, resolve });
      }),
  );
  return { ask, pending };
}

const CANCELLED: AskOutcome = {
  ok: false,
  failure: { kind: 'cancelled', message: '已取消这次提问。' },
};

describe('useAiReading request ownership', () => {
  it('a cancelled request cannot delete the next request or clear its busy state', async () => {
    const { ask, pending } = controlledClient();
    const { result } = renderHook(() => useAiReading({ ask }));

    act(() => {
      result.current.ask(SOURCE, 'explain', 'first');
    });
    expect(result.current.session?.turns).toHaveLength(1);
    expect(result.current.busy).toBe(true);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.session?.turns).toHaveLength(0);
    expect(result.current.busy).toBe(false);

    act(() => {
      result.current.ask(SOURCE, 'explain', 'second');
    });
    expect(result.current.session?.turns).toHaveLength(1);

    // The first request settles only now, after the second has already started.
    await act(async () => {
      pending[0]?.resolve(CANCELLED);
      await Promise.resolve();
    });
    expect(result.current.session?.turns).toHaveLength(1);
    expect(result.current.busy).toBe(true);

    await act(async () => {
      pending[1]?.resolve({ ok: true, answer: ANSWER });
      await Promise.resolve();
    });
    expect(result.current.session?.turns).toHaveLength(1);
    expect(result.current.session?.turns[0]?.question).toBe('second');
    expect(result.current.session?.turns[0]?.answer).toEqual(ANSWER);
    expect(result.current.busy).toBe(false);
  });

  it('replacing a request directly also keeps only the newest answer', async () => {
    const { ask, pending } = controlledClient();
    const { result } = renderHook(() => useAiReading({ ask }));

    act(() => {
      result.current.ask(SOURCE, 'explain', 'first');
    });
    act(() => {
      result.current.ask(SOURCE, 'explain', 'second');
    });

    await act(async () => {
      pending[0]?.resolve(CANCELLED);
      await Promise.resolve();
    });
    await act(async () => {
      pending[1]?.resolve({ ok: true, answer: ANSWER });
      await Promise.resolve();
    });

    expect(result.current.session?.turns).toHaveLength(1);
    expect(result.current.session?.turns[0]?.question).toBe('second');
    expect(result.current.busy).toBe(false);
  });
});
