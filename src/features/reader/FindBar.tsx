import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { FindStatus } from './usePdfSearch';

interface FindBarProps {
  query: string;
  onQuery: (value: string) => void;
  active: number;
  count: number;
  /** The page the current result is on, or null when there is none. */
  page: number | null;
  status: FindStatus;
  /** The current query has not finished looking through the index yet. */
  searching: boolean;
  scanned: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

/**
 * The in-paper find bar.
 *
 * It takes its own row under the toolbar rather than floating over the page: a floating bar
 * would sit on the words it is meant to help read, and it would change the reading column's
 * width as it appeared and disappeared if it were placed inside the column.
 *
 * The keyboard contract is deliberately local. Enter and Escape are handled on the input and
 * stopped there, so the reader's other shortcuts — the annotation toolbar, the side panel, the
 * page-jump field — never receive a key meant for the search.
 */
export function FindBar({
  query,
  onQuery,
  active,
  count,
  page,
  status,
  searching,
  scanned,
  total,
  onNext,
  onPrev,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const hasQuery = query.trim() !== '';
  const statusText = !hasQuery
    ? ''
    : status === 'indexing'
      ? `正在索引 ${String(scanned)}/${String(total)}`
      : count === 0
        ? searching
          ? '正在搜索…'
          : '无结果'
        : `${String(active + 1)} / ${String(count)}${page === null ? '' : ` · 第 ${String(page)} 页`}`;

  return (
    <div className="find-bar" role="search" aria-label="论文内查找">
      <Search size={14} aria-hidden="true" />
      <label className="find-field">
        <span className="sr-only">查找论文内容</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="在整篇论文里查找…"
          onChange={(event) => {
            onQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) onPrev();
              else onNext();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
      </label>
      <span className="find-status" role="status" aria-live="polite">
        {statusText}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="上一个结果"
        disabled={count === 0}
        onClick={onPrev}
      >
        <ChevronUp size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="下一个结果"
        disabled={count === 0}
        onClick={onNext}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn" aria-label="关闭查找" onClick={onClose}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
