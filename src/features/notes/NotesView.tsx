import { CircleCheck, Download, NotebookPen, Search, Sparkles, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { downloadTextFile } from '../../services/download';
import { Dialog } from '../../ui/Dialog';
import type { AiClient } from '../reader/useAiReading';
import { ANNOTATION_KINDS, ANNOTATION_KIND_LABEL, type Annotation } from '../../domain/annotation';
import type { Paper } from '../../domain/papers';
import {
  filterNotes,
  groupNotes,
  openQuestionCount,
  type NotesKindFilter,
  type NotesOverviewGroup,
  type QuestionStatusFilter,
} from './notesOverview';

interface NotesViewProps {
  annotations: readonly Annotation[];
  papers: Readonly<Record<string, Paper>>;
  /** Opens the paper at the note's page and marks its quote. */
  onOpenPaper: (paperId: string, focus: { page: number; quote: string }) => void;
  /** Marks a question answered, or opens it again. Omitted in read-only hosts. */
  onResolveQuestion?: (id: string, resolvedAt: number | null) => void;
  /** The assistant's transport; offered where the host has one. Enables AI 整理成稿. */
  ai?: Pick<AiClient, 'ask'>;
}

const KIND_FILTERS: readonly NotesKindFilter[] = ['all', ...ANNOTATION_KINDS];
const QUESTION_STATUS: readonly (QuestionStatusFilter | null)[] = [null, 'open', 'resolved'];
const QUESTION_STATUS_LABEL: Record<'all' | QuestionStatusFilter, string> = {
  all: '全部疑问',
  open: '未解决',
  resolved: '已解决',
};

/** Matches the service's draft-mode passage ceiling (server/config.mjs LIMITS.draftPassages). */
const DRAFT_NOTE_LIMIT = 64;

/**
 * Applies the ceiling with the written-note-first policy. Notes the reader actually wrote are
 * carried before pure highlights, and the kept set is re-sorted by page so the draft still
 * reads in the paper's own order. A reader with 70 highlights and 5 real notes loses nothing.
 */
function carryNotes(items: readonly Annotation[]): Annotation[] {
  const withBody = items.filter((annotation) => annotation.note.trim() !== '');
  const quoteOnly = items.filter((annotation) => annotation.note.trim() === '');
  return [
    ...withBody.slice(0, DRAFT_NOTE_LIMIT),
    ...quoteOnly.slice(
      0,
      Math.max(0, DRAFT_NOTE_LIMIT - Math.min(withBody.length, DRAFT_NOTE_LIMIT)),
    ),
  ]
    .slice(0, DRAFT_NOTE_LIMIT)
    .sort((one, other) => one.page - other.page || one.createdAt - other.createdAt);
}

/**
 * Every note in the workspace, grouped by paper.
 *
 * The reader's notes are already beside each paper; this page answers the other question —
 * "what have I written down, anywhere?" — without making them open papers one by one.
 */
export function NotesView({
  annotations,
  papers,
  onOpenPaper,
  onResolveQuestion,
  ai,
}: NotesViewProps) {
  /* The draft flow: per-paper confirm, one call, a dialog with the result. */
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<{
    paperTitle: string;
    text: string;
    providerLabel: string;
    model: string;
  } | null>(null);

  /**
   * Sends one paper's notes as passages and asks for a coherent draft back.
   *
   * Each note's quotation travels as a passage, so the citation contract holds exactly as it
   * does over paper text: a claim the draft makes is checked against a quotation the reader
   * really marked, not against the model's memory. The note's own file hash is what the notes
   * were anchored on, so it names the file without the registry having to.
   */
  const runDraft = async (group: NotesOverviewGroup): Promise<void> => {
    if (ai === undefined || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      /* The service's draft ceiling, applied by the same policy the disclosure describes. */
      const carried = carryNotes(group.items);
      const passages = carried.map((annotation, index) => ({
        id: `n${String(index + 1)}`,
        page: annotation.page,
        text: annotation.quote,
        selection: index === 0,
      }));
      const draftNotes = carried
        .map((annotation, index) => ({
          passageId: `n${String(index + 1)}`,
          note: annotation.note,
        }))
        .filter((entry) => entry.note.trim() !== '');
      const result = await ai.ask({
        mode: 'draft',
        question: `请把这 ${String(carried.length)} 条笔记整理成一篇连贯的精读笔记草稿。`,
        paper: {
          id: group.paperId,
          title: group.title,
          page: group.items[0]?.page ?? 1,
          pdfSha256: group.items[0]?.pdfSha256 ?? '0'.repeat(64),
        },
        passages,
        draftNotes,
      });
      if (!result.ok) {
        setDraftError(`整理失败：${result.failure.message}`);
        return;
      }
      setDraftResult({
        paperTitle: group.title,
        text: result.answer.answer,
        providerLabel: result.answer.providerLabel,
        model: result.answer.model,
      });
      setDraftFor(null);
    } finally {
      setDraftBusy(false);
    }
  };

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<NotesKindFilter>('all');
  const [paperId, setPaperId] = useState('');
  const [questionStatus, setQuestionStatus] = useState<QuestionStatusFilter | null>(null);

  const shown = useMemo(
    () =>
      filterNotes(annotations, {
        query,
        kind,
        paperId: paperId === '' ? null : paperId,
        questionStatus,
      }),
    [annotations, query, kind, paperId, questionStatus],
  );
  const groups = useMemo(() => groupNotes(shown, papers), [shown, papers]);
  const openQuestions = useMemo(() => openQuestionCount(annotations), [annotations]);
  const hasQuestions = annotations.some((annotation) => annotation.kind === 'question');
  const papersWithNotes = useMemo(() => {
    const ids = new Set(annotations.map((annotation) => annotation.paperId));
    return [...ids]
      .map((id) => ({ id, title: papers[id]?.title ?? '未知论文' }))
      .sort((one, other) => one.title.localeCompare(other.title, 'zh-Hans-CN'));
  }, [annotations, papers]);
  const filtered = query !== '' || kind !== 'all' || paperId !== '' || questionStatus !== null;

  return (
    <section className="notes-page" aria-labelledby="notes-page-title">
      <header className="library-head">
        <h1 id="notes-page-title" className="library-title">
          全部笔记
        </h1>
        <span className="library-count">
          {shown.length === annotations.length
            ? `${String(annotations.length)} 条`
            : `${String(shown.length)} / ${String(annotations.length)} 条`}
          {openQuestions > 0 && ` · ${String(openQuestions)} 个未解决疑问`}
        </span>
      </header>

      <label className="library-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">搜索笔记</span>
        <input
          className="input"
          type="search"
          value={query}
          placeholder="按高亮文字或笔记内容搜索"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </label>

      <div className="library-controls">
        <div className="library-chips" role="group" aria-label="笔记类型">
          {KIND_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
              }}
            >
              {option === 'all' ? '全部' : ANNOTATION_KIND_LABEL[option]}
            </button>
          ))}
        </div>
        {hasQuestions && (
          <div className="library-chips" role="group" aria-label="疑问状态">
            {QUESTION_STATUS.map((option) => (
              <button
                key={option ?? 'all'}
                type="button"
                className="chip"
                aria-pressed={questionStatus === option}
                onClick={() => {
                  setQuestionStatus(option);
                }}
              >
                {QUESTION_STATUS_LABEL[option ?? 'all']}
                {option === 'open' && openQuestions > 0 ? ` ${String(openQuestions)}` : ''}
              </button>
            ))}
          </div>
        )}
        {papersWithNotes.length > 1 && (
          <div className="library-selects">
            <label className="library-select">
              <span className="sr-only">按论文筛选</span>
              <select
                className="input"
                value={paperId}
                onChange={(event) => {
                  setPaperId(event.target.value);
                }}
              >
                <option value="">全部论文</option>
                {papersWithNotes.map((paper) => (
                  <option key={paper.id} value={paper.id}>
                    {paper.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="library-empty">
          {annotations.length === 0
            ? '还没有笔记。阅读时选中文字，就能留下高亮和笔记。'
            : filtered
              ? '没有符合筛选条件的笔记。'
              : '没有笔记。'}
        </p>
      ) : (
        <div className="notes-groups">
          {groups.map((group) => {
            const carried = carryNotes(group.items);
            return (
              <NotesGroup
                key={group.paperId}
                group={group}
                query={query}
                onOpenPaper={onOpenPaper}
                onResolveQuestion={onResolveQuestion}
                carriedCount={carried.length}
                draftEnabled={
                  ai !== undefined &&
                  group.items.length >= 2 &&
                  carried.some((annotation) => annotation.note.trim() !== '')
                }
                draftActive={draftFor === group.paperId}
                draftBusy={draftBusy}
                draftError={draftError}
                onStartDraft={() => {
                  setDraftFor(group.paperId);
                  setDraftError(null);
                }}
                onRunDraft={() => {
                  void runDraft(group);
                }}
                onCancelDraft={() => {
                  setDraftFor(null);
                  setDraftError(null);
                }}
              />
            );
          })}
        </div>
      )}

      {/*
       * The draft is a suggestion, not a record: shown in full for review and kept only if
       * the reader downloads it. Nothing is written back into the workspace. The native
       * dialog gives the review focus, Escape to close, and inerts the page behind it.
       */}
      <Dialog
        open={draftResult !== null}
        title="笔记草稿"
        onClose={() => {
          setDraftResult(null);
        }}
      >
        {draftResult !== null && (
          <div className="notes-draft-result">
            <p className="notes-draft-meta">
              《{draftResult.paperTitle}》· {draftResult.providerLabel} · {draftResult.model}
            </p>
            <DraftText text={draftResult.text} />
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setDraftResult(null);
                }}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const safe =
                    draftResult.paperTitle.replace(/[\\/:*?"<>|]/g, ' ').trim() || '论文';
                  downloadTextFile(
                    `${safe.slice(0, 60)}-笔记草稿.md`,
                    `# 《${draftResult.paperTitle}》精读笔记草稿\n\n${draftResult.text}\n`,
                    'text/markdown;charset=utf-8',
                  );
                }}
              >
                <Download size={14} aria-hidden="true" />
                下载 .md
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}

interface NotesGroupProps {
  group: NotesOverviewGroup;
  query: string;
  onOpenPaper: (paperId: string, focus: { page: number; quote: string }) => void;
  onResolveQuestion?: (id: string, resolvedAt: number | null) => void;
  draftEnabled: boolean;
  carriedCount: number;
  draftActive: boolean;
  draftBusy: boolean;
  draftError: string | null;
  onStartDraft: () => void;
  onRunDraft: () => void;
  onCancelDraft: () => void;
}

/** The card's clickable body. A question card wraps this in an article to host the resolve action. */
function NoteCardBody({ annotation, query }: { annotation: Annotation; query: string }) {
  return (
    <>
      <span className="note-card-meta">
        <span className="note-kind" data-kind={annotation.kind}>
          {ANNOTATION_KIND_LABEL[annotation.kind]}
        </span>
        {annotation.kind === 'question' && annotation.resolvedAt !== undefined && (
          <span className="note-kind note-kind--resolved">已解决</span>
        )}
        {annotation.origin === 'assistant' && <span className="note-origin">AI 辅助</span>}
        <span className="note-page">第 {annotation.page} 页</span>
      </span>
      <Highlighted text={annotation.quote} query={query} className="note-card-quote" />
      {annotation.note !== '' && (
        <Highlighted text={annotation.note} query={query} className="note-card-body" />
      )}
      <span className="sr-only">打开论文原文</span>
    </>
  );
}

function NotesGroup({
  group,
  query,
  onOpenPaper,
  onResolveQuestion,
  draftEnabled,
  carriedCount,
  draftActive,
  draftBusy,
  draftError,
  onStartDraft,
  onRunDraft,
  onCancelDraft,
}: NotesGroupProps) {
  return (
    <section className="notes-group-page" aria-labelledby={`notes-group-${group.paperId}`}>
      <header className="notes-group-head">
        <NotebookPen size={14} aria-hidden="true" />
        <h2 id={`notes-group-${group.paperId}`} className="notes-group-title">
          {group.title}
        </h2>
        <span className="notes-group-count">{group.items.length} 条</span>
      </header>
      {draftEnabled && (
        <div className="notes-draft">
          {draftActive ? (
            <>
              <p className="hint" role="status">
                将发送 {String(carriedCount)}{' '}
                条笔记的原文引用与对应的笔记内容；尚未写过正文的笔记只发引用。
                {group.items.length > DRAFT_NOTE_LIMIT &&
                  ` 笔记超过 ${String(DRAFT_NOTE_LIMIT)} 条：写过正文的优先携带，其余按页序填充。`}
                {draftBusy ? '正在整理…' : '若 AI 服务为在线模式，将产生费用；本地模拟则免费。'}
              </p>
              <div className="notes-draft-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={draftBusy}
                  onClick={onRunDraft}
                >
                  {draftBusy ? '整理中…' : '开始整理'}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={draftBusy}
                  onClick={onCancelDraft}
                >
                  取消
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={onStartDraft}>
              <Sparkles size={13} aria-hidden="true" />
              AI 整理成稿
            </button>
          )}
          {draftError !== null && (
            <p className="hint hint-error" role="alert">
              {draftError}
            </p>
          )}
        </div>
      )}
      <ul className="notes-page-list">
        {group.items.map((annotation) => {
          const open = (): void => {
            onOpenPaper(group.paperId, { page: annotation.page, quote: annotation.quote });
          };
          /*
           * A question carries a resolve action, so it cannot be one big button the way other
           * notes are — a button cannot hold a button. The card becomes an article whose main
           * region opens the paper, with the lifecycle action beside it.
           */
          if (annotation.kind === 'question' && onResolveQuestion !== undefined) {
            const resolved = annotation.resolvedAt !== undefined;
            return (
              <li key={annotation.id}>
                <article className="note-card note-card--question" data-resolved={resolved}>
                  <button type="button" className="note-card-main" onClick={open}>
                    <NoteCardBody annotation={annotation} query={query} />
                  </button>
                  <button
                    type="button"
                    className="note-card-resolve"
                    aria-pressed={resolved}
                    onClick={() => {
                      onResolveQuestion(annotation.id, resolved ? null : Date.now());
                    }}
                  >
                    {resolved ? (
                      <>
                        <Undo2 size={13} aria-hidden="true" />
                        重新打开
                      </>
                    ) : (
                      <>
                        <CircleCheck size={13} aria-hidden="true" />
                        标记已解决
                      </>
                    )}
                  </button>
                </article>
              </li>
            );
          }
          return (
            <li key={annotation.id}>
              <button type="button" className="note-card" onClick={open}>
                <NoteCardBody annotation={annotation} query={query} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Markdown-lite for a draft the reader is reviewing: headings, list dashes and paragraphs.
 *
 * The model's answer is Markdown, and a review window that flattens it to one grey lump hides
 * the structure the reader is supposed to judge. This renders just the shapes the draft
 * contract produces — nothing clever, no HTML, citations stay as [n] text.
 */
function DraftText({ text }: { text: string }) {
  return (
    <div className="notes-draft-text">
      {text.split('\n').map((line, index) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading !== null) {
          return (
            <p key={String(index)} className={`notes-draft-h${String(heading[1]?.length)}`}>
              {heading[2]}
            </p>
          );
        }
        const item = /^\s*[-*]\s+(.*)$/.exec(line);
        if (item !== null) {
          return (
            <p key={String(index)} className="notes-draft-li">
              {item[1]}
            </p>
          );
        }
        if (line.trim() === '') return null;
        return (
          <p key={String(index)} className="notes-draft-p">
            {line}
          </p>
        );
      })}
    </div>
  );
}

interface HighlightedProps {
  text: string;
  query: string;
  className: string;
}

/**
 * The text with the search term marked, so a long note shows why it matched.
 *
 * Matching is plain case-insensitive substring search, the same rule as the filter, so the
 * marked span can never disagree with the result being shown.
 */
function Highlighted({ text, query, className }: HighlightedProps) {
  const needle = query.trim().toLowerCase();
  if (needle === '') return <span className={className}>{text}</span>;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </span>
  );
}
