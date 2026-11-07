import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, Suspense, startTransition, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { createPaper } from '../../domain/papers';
import { GlobalSearchDialog } from './GlobalSearchDialog';
import type { WorkspaceSearchSource } from './searchWorkspace';

function makeSource(id: string, title: string): WorkspaceSearchSource {
  const paper = createPaper({ title, authors: ['First Last'] }, () => id, 1);
  if (paper === null) throw new Error('fixture paper');
  return { papers: [paper], annotations: [], concepts: [], evidence: [] };
}

function searchInput(): HTMLElement {
  return screen.getByRole('textbox', { name: '搜索工作区' });
}

function changeQuery(value: string): void {
  fireEvent.change(searchInput(), { target: { value } });
}

it('keeps the source snapshot through clearing in StrictMode and rebuilds after reopening', () => {
  const source = makeSource('A', 'Alpha original');
  const props = {
    source,
    onClose: vi.fn(),
    onOpenPaper: vi.fn(),
    onOpenConcept: vi.fn(),
  };
  let reads = 0;
  let title = 'Alpha original';
  Object.defineProperty(source.papers[0]!, 'title', {
    get() {
      reads++;
      return title;
    },
  });
  const dialog = (open = true) => (
    <StrictMode>
      <GlobalSearchDialog {...props} open={open} />
    </StrictMode>
  );
  const { rerender } = render(dialog());
  expect(reads).toBe(0);

  changeQuery('alpha');
  expect(screen.getByRole('button', { name: /Alpha original/ })).toBeTruthy();
  const searchedReads = reads;
  expect(searchedReads).toBeGreaterThan(0);

  title = 'Beta changed';
  changeQuery('');
  changeQuery('alpha');
  expect(reads).toBe(searchedReads);
  expect(screen.getByRole('button', { name: /Alpha original/ })).toBeTruthy();

  rerender(dialog(false));
  rerender(dialog());
  expect(reads).toBe(searchedReads);
  expect(searchInput()).toHaveValue('');
  changeQuery('beta');
  expect(reads).toBeGreaterThan(searchedReads);
  expect(screen.getByRole('button', { name: /Beta changed/ })).toBeTruthy();
});

it('isolates an abandoned suspended source transition from committed and replacement sources', async () => {
  const first = makeSource('A', 'Alpha record');
  const suspended = makeSource('B', 'Beta record');
  const replacement = makeSource('C', 'Gamma record');
  const onOpenPaper = vi.fn();
  const props = { onClose: vi.fn(), onOpenPaper, onOpenConcept: vi.fn() };
  const never = new Promise<never>(() => {
    // Deliberately keep the speculative render suspended until it is superseded.
  });

  function Block({ blocked }: { blocked: boolean }) {
    if (blocked) throw never;
    return null;
  }

  function Harness() {
    const [source, setSource] = useState(first);
    const [blocked, setBlocked] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            startTransition(() => {
              setSource(suspended);
              setBlocked(true);
            });
          }}
        >
          Begin suspended update
        </button>
        <button
          type="button"
          onClick={() => {
            setSource(replacement);
            setBlocked(false);
          }}
        >
          Replace source
        </button>
        <Suspense fallback={<p>Suspended</p>}>
          <GlobalSearchDialog {...props} open source={source} />
          <Block blocked={blocked} />
        </Suspense>
      </>
    );
  }

  render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  changeQuery('alpha');
  expect(screen.getByRole('button', { name: /Alpha record/ })).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Begin suspended update' }));
  });
  expect(screen.queryByText('Suspended')).toBeNull();
  changeQuery('');
  changeQuery('alpha');
  expect(screen.getByRole('button', { name: /Alpha record/ })).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Replace source' }));
  });
  expect(screen.queryByRole('button', { name: /Alpha record/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Beta record/ })).toBeNull();
  changeQuery('gamma');
  expect(screen.getByRole('button', { name: /Gamma record/ })).toBeTruthy();
  fireEvent.keyDown(searchInput(), { key: 'Enter' });
  expect(onOpenPaper).toHaveBeenLastCalledWith('C', undefined);
});
