import {
  BookOpenCheck,
  Check,
  Copy,
  Loader2,
  SendHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { describeContext, PASSAGE_IDS } from '../../services/ai/context';
import { mathIn, segmentAnswer } from '../../services/ai/render';
import {
  AI_MODE_LABEL,
  type AiAnswer,
  type AiCitation,
  type AiHealth,
} from '../../services/ai/types';
import { providerDisplayLabel } from '../ai/providerLabel';
import { AiMath } from './AiMath';
import type { AiSession, AiTurn } from './useAiReading';

interface AiPanelProps {
  session: AiSession | null;
  busy: boolean;
  /** Null until the local service has been asked; the panel says so rather than guessing. */
  health: AiHealth | null;
  /** The page the reader is on now, used when there is no conversation yet. */
  currentPage: number;
  /** Starts a conversation about the page rather than about a selection. */
  onAskAboutPage: (question: string) => void;
  onFollowUp: (question: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  onClear: () => void;
  /** False for a whole-page conversation: a note has to be anchored to text. */
  canSaveNote: boolean;
  onSaveNote: (turn: AiTurn) => void;
  onJumpToCitation: (citation: AiCitation) => void;
  onClose: () => void;
}

const MAX_QUESTION = 1000;

/**
 * The openers offered before a conversation exists.
 *
 * They are questions, not modes: each one produces a normal answer with normal citation
 * checking, and each is answerable from the current page alone — which is all that is sent.
 */
const OPENERS: readonly { label: string; question: string }[] = [
  {
    label: '这一页讲了什么',
    question: '用几句话说明这一页在讲什么，以及它在整篇论文里的位置。',
  },
  {
    label: '核心方法是什么',
    question: '这一页提出的核心方法或结论是什么？关键步骤有哪些？',
  },
  {
    label: '哪里容易卡住',
    question: '这一页里哪些地方最容易让读者卡住？分别简要说明为什么。',
  },
];

/** Renders an answer as text, mathematics and verified citations. */
function AnswerBody({
  answer,
  citations,
  onJump,
}: {
  answer: string;
  citations: AiCitation[];
  onJump: (citation: AiCitation) => void;
}) {
  const paragraphs = segmentAnswer(answer, citations);
  return (
    <div className="ai-answer-body">
      {paragraphs.map((paragraph, index) => (
        // Paragraphs have no identity of their own; the index is the paragraph's position and
        // never changes for a given answer, which is the whole of what the key needs to be.
        <p key={index}>
          {paragraph.pieces.map((piece, position) => {
            if (piece.kind === 'math') {
              return <AiMath key={position} latex={piece.latex} display={piece.display} />;
            }
            if (piece.kind === 'text') return <span key={position}>{piece.text}</span>;
            return (
              <button
                key={position}
                type="button"
                className="ai-citation"
                title={`第 ${String(piece.citation.page)} 页：${piece.citation.quote}`}
                onClick={() => {
                  onJump(piece.citation);
                }}
              >
                [{piece.citation.n}] 第 {piece.citation.page} 页
              </button>
            );
          })}
        </p>
      ))}
    </div>
  );
}

/**
 * The answer body, or a plain statement that there is none.
 *
 * An empty answer can arrive several ways — the model thought until the budget ran out, or
 * returned JSON without an `answer` field — and in every one of them an empty box would look
 * like a panel that failed to load. This says what happened instead.
 */
function AnswerOrNothing({
  answer,
  citations,
  onJump,
}: {
  answer: string;
  citations: AiCitation[];
  onJump: (citation: AiCitation) => void;
}) {
  if (answer.trim() === '') {
    return <p className="ai-warn">这次没有得到可显示的回答正文。</p>;
  }
  return <AnswerBody answer={answer} citations={citations} onJump={onJump} />;
}

/**
 * Whatever can be shown of one answer, or a plain statement that nothing can.
 *
 * A reply the service could not read is not shown at all — not as JSON, not as its protocol
 * fields, not as escaped text. The reader gets a sentence saying so and a manual retry; the raw
 * output stays on the service, where it is a diagnostic rather than an answer.
 */
function AnswerSurface({
  answer,
  onJump,
  onRetry,
}: {
  answer: AiAnswer;
  onJump: (citation: AiCitation) => void;
  onRetry: () => void;
}) {
  if (answer.status === 'malformed') {
    return (
      <div className="ai-failure" role="alert">
        <p>
          模型这次返回的内容没法还原成回答：它不是一段可以直接读的文字，也没有可用的正文。原始输出没有显示出来。
        </p>
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  return <AnswerOrNothing answer={answer.answer} citations={answer.citations} onJump={onJump} />;
}

/**
 * The things worth saying about an answer that are not its text.
 *
 * Kept in one place so the translation layout and the ordinary one say the same things: a reply
 * that was cut off, a reply with no citable block, and — whenever there is mathematics in it —
 * the reminder that the formula is the model's own typesetting and not something extracted from
 * the PDF.
 */
function AnswerStatusNotes({ answer }: { answer: AiAnswer }) {
  const hasMath = mathIn(answer.answer).length > 0;
  return (
    <>
      {answer.status === 'incomplete' && (
        <p className="ai-warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          模型没有写完就停了，下面是已经生成的部分。它不完整，不要把它当成完整的回答。
        </p>
      )}
      {answer.status === 'recovered' && answer.diagnostics?.recovery === 'prose' && (
        <p className="ai-warn">
          <TriangleAlert size={13} aria-hidden="true" />
          这次模型没有给出引用块，所以没有可校验的引用；回答正文照常显示。
        </p>
      )}
      {hasMath && (
        <p className="ai-caveat">
          回答里的公式是模型自己排版的 LaTeX，不是从 PDF
          里提取出来的原文；它和引用一样，只是模型的说法。
        </p>
      )}
    </>
  );
}

/** How each recovery rule is named to a reader who opened the details. */
const RECOVERY_LABEL: Record<string, string> = {
  'escaped-envelope': '按转义结构还原',
  'field-salvage': '逐字段还原',
  'legacy-json': '旧格式 JSON',
  'sentinel-broken-block': '引用块无法解析',
  'sentinel-no-block': '没有引用块',
  prose: '没有引用块',
};

const STATUS_LABEL: Record<AiAnswer['status'], string> = {
  valid: '按约定返回',
  recovered: '已还原',
  malformed: '无法还原',
  incomplete: '被截断',
  'provider-error': '请求失败',
};

function finishReasonLabel(reason: string | null): string {
  if (reason === null) return '未提供';
  if (reason === 'stop') return '正常结束';
  if (reason === 'length') return '达到长度上限';
  if (reason === 'insufficient_system_resource') return '模型服务资源不足';
  if (reason === 'aborted') return '被中断';
  if (reason === 'content_filter') return '被内容策略拦截';
  return reason;
}

/**
 * The reply's own statistics, behind a disclosure the reader has to open.
 *
 * Numbers and enums only — no prompt, no paper text, no model output — so opening this cannot
 * leak anything the reader was not already looking at.
 */
function Diagnostics({ answer }: { answer: AiAnswer }) {
  const diagnostics = answer.diagnostics;
  // Tolerated rather than assumed: an older service process does not send this, and a stale
  // process is exactly the situation the details are meant to help diagnose.
  if (diagnostics === null || diagnostics === undefined) return null;
  return (
    <details className="ai-diagnostics">
      <summary>技术细节</summary>
      <dl>
        <dt>解析状态</dt>
        <dd>
          {STATUS_LABEL[answer.status] ?? answer.status}
          {/* A reply that followed the contract has no recovery rule to name, and `sentinel`
              is our word for it, not the reader's. */}
          {answer.status === 'valid' || diagnostics.recovery === null
            ? ''
            : `（${RECOVERY_LABEL[diagnostics.recovery] ?? diagnostics.recovery}）`}
        </dd>
        <dt>结束原因</dt>
        <dd>{finishReasonLabel(diagnostics.finishReason)}</dd>
        <dt>返回长度</dt>
        <dd>{diagnostics.rawChars} 字符</dd>
        <dt>引用</dt>
        <dd>
          {diagnostics.citationEntries} 条，通过 {diagnostics.citationsAccepted}，丢弃{' '}
          {diagnostics.citationsRejected}
        </dd>
      </dl>
    </details>
  );
}

export function AiPanel({
  session,
  busy,
  health,
  currentPage,
  onAskAboutPage,
  onFollowUp,
  onRetry,
  onCancel,
  onClear,
  canSaveNote,
  onSaveNote,
  onJumpToCitation,
  onClose,
}: AiPanelProps) {
  const [question, setQuestion] = useState('');
  const [showRange, setShowRange] = useState(false);
  const [showTranslation, setShowTranslation] = useState(true);
  const [saved, setSaved] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  // A new answer is the thing the reader is waiting for; keep it in view.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [session?.turns.length, busy]);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = question.trim();
    // With no conversation yet, the first question is about the page — the assistant is not
    // something the reader has to unlock by selecting text first.
    if (trimmed === '' || busy) return;
    setQuestion('');
    if (session === null) onAskAboutPage(trimmed);
    else onFollowUp(trimmed);
  };

  /** Openers for a reader who has just opened the panel and is not sure what to ask. */
  const QUICK = OPENERS;

  const providerNote =
    health === null
      ? '还没有连上本地 AI 服务（npm run ai:serve）。'
      : health.online
        ? `在线模式：会调用在线模型，可能产生费用。${health.reasoning === null ? '' : ` ${health.reasoning}`}`
        : '本地模拟：不会发起任何在线调用。';

  return (
    <aside className="ai-panel" aria-label="AI 精读助手">
      <div className="ai-head">
        <h2>
          <Sparkles size={15} aria-hidden="true" />
          AI 精读助手
        </h2>
        <div className="ai-head-actions">
          {session !== null && (
            <button type="button" className="btn btn-quiet" onClick={onClear}>
              清空对话
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="关闭 AI 面板" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <p className="ai-provider" data-online={health?.online === true}>
        {providerNote}
      </p>

      {session === null ? (
        <div className="ai-scroll">
          <div className="ai-empty">
            <p>可以直接问这一页的任何问题。在原文里选中一段再提问，回答就能精确回到那段文字。</p>
            <p className="ai-hint">
              现在只会带上第 {currentPage} 页的正文，不会发送整篇论文，也不会保存对话记录。
            </p>
          </div>
          <div className="ai-quick" role="group" aria-label="可以这样问">
            {QUICK.map((entry) => (
              <button
                key={entry.label}
                type="button"
                className="chip"
                onClick={() => {
                  onAskAboutPage(entry.question);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="ai-scroll">
          <section className="ai-source" aria-label="本次的原文范围">
            <button
              type="button"
              className="ai-range-toggle"
              aria-expanded={showRange}
              onClick={() => {
                setShowRange((value) => !value);
              }}
            >
              第 {session.source.page} 页
              {session.source.anchor === null
                ? '整页'
                : `，选中 ${String(session.source.anchor.quote.length)} 字`}{' '}
              —— 查看会发送的范围
            </button>
            {/* Said before anything is sent, not buried inside the disclosure: if the selection
                is a formula broken into single glyphs, the reader should know that the model is
                about to be handed the fragments. */}
            {session.source.fragmentation?.notice != null && (
              <p className="ai-warn ai-source-warn">
                <TriangleAlert size={13} aria-hidden="true" />
                {session.source.fragmentation.notice}
              </p>
            )}
            {showRange && (
              <div className="ai-range">
                {session.turns[0] !== undefined && (
                  <p className="ai-range-summary">{describeContext(session.turns[0].request)}</p>
                )}
                {session.turns[0]?.request.layoutNotice != null && (
                  <p className="ai-warn">
                    <TriangleAlert size={13} aria-hidden="true" />
                    {session.turns[0].request.layoutNotice}
                  </p>
                )}
                {session.turns[0]?.request.passages.map((passage) => (
                  <div key={passage.id} className="ai-range-part">
                    <span className="ai-range-label">
                      {passage.id === PASSAGE_IDS.selection
                        ? '选中的原文'
                        : passage.id === PASSAGE_IDS.page
                          ? '这一页的原文'
                          : passage.id === PASSAGE_IDS.before
                            ? '同页上文'
                            : '同页下文'}
                    </span>
                    <p>{passage.text}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {session.turns.map((turn, index) => (
            <section
              // A turn is identified by its position in this session, which never changes.
              key={index}
              className="ai-turn"
              data-turn={index}
            >
              <p className="ai-turn-mode">{AI_MODE_LABEL[turn.mode]}</p>

              {index > 0 && turn.question !== '' && <p className="ai-question">{turn.question}</p>}

              {turn.mode === 'translate' && turn.answer !== null && (
                <div className="ai-parallel">
                  <div className="ai-original">
                    <span className="ai-range-label">英文原文</span>
                    <p>{session.source.anchor?.quote ?? ''}</p>
                  </div>
                  <div className="ai-translation" data-hidden={!showTranslation}>
                    <div className="ai-translation-head">
                      <span className="ai-range-label">中文译文</span>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        aria-pressed={showTranslation}
                        onClick={() => {
                          setShowTranslation((value) => !value);
                        }}
                      >
                        {showTranslation ? '隐藏译文' : '显示译文'}
                      </button>
                    </div>
                    {showTranslation && (
                      <AnswerSurface
                        answer={turn.answer}
                        onJump={onJumpToCitation}
                        onRetry={onRetry}
                      />
                    )}
                  </div>
                </div>
              )}

              {turn.answer !== null && turn.mode !== 'translate' && (
                <AnswerSurface answer={turn.answer} onJump={onJumpToCitation} onRetry={onRetry} />
              )}

              {turn.answer !== null && <AnswerStatusNotes answer={turn.answer} />}

              {turn.answer !== null && (
                <>
                  {turn.answer.groundedInText === false && (
                    <p className="ai-warn" role="status">
                      <TriangleAlert size={13} aria-hidden="true" />
                      模型自己认为提供的原文不足以完整回答这个问题。这是它的自述，不是被核对过的事实，
                      请注意分辨哪些是补充内容。
                    </p>
                  )}
                  {turn.answer.warnings.map((warning) => (
                    <p className="ai-warn" key={warning}>
                      <TriangleAlert size={13} aria-hidden="true" />
                      {warning}
                    </p>
                  ))}
                  <Diagnostics answer={turn.answer} />
                  <p className="ai-foot">
                    出处：第 {session.source.page} 页 ·{' '}
                    {providerDisplayLabel(turn.answer.providerLabel)}
                    {turn.answer.usage?.completionTokens != null &&
                      ` · 输出 ${String(turn.answer.usage.completionTokens)} tokens`}
                    {turn.answer.usage?.reasoningTokens != null &&
                      `（其中推理 ${String(turn.answer.usage.reasoningTokens)}）`}
                  </p>
                  {/* Nothing to save or copy when there is no answer text to speak of. */}
                  {turn.answer.status !== 'malformed' && (
                    <div className="ai-turn-actions">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={!canSaveNote}
                        title={
                          canSaveNote
                            ? undefined
                            : '整页提问没有可锚定的原文；选中一段再提问即可保存为笔记'
                        }
                        onClick={() => {
                          onSaveNote(turn);
                          setSaved(index);
                        }}
                      >
                        {saved === index ? (
                          <Check size={14} aria-hidden="true" />
                        ) : (
                          <BookOpenCheck size={14} aria-hidden="true" />
                        )}
                        {saved === index ? '已保存为笔记' : '保存为笔记'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => {
                          void navigator.clipboard?.writeText(turn.answer?.answer ?? '');
                        }}
                      >
                        <Copy size={14} aria-hidden="true" />
                        复制
                      </button>
                    </div>
                  )}
                  {turn.answer.citations.length > 0 && (
                    <>
                      <ul className="ai-citations">
                        {turn.answer.citations.map((citation) => (
                          <li key={citation.n}>
                            <button
                              type="button"
                              onClick={() => {
                                onJumpToCitation(citation);
                              }}
                            >
                              [{citation.n}] 第 {citation.page} 页
                            </button>
                            <span>{citation.quote}</span>
                          </li>
                        ))}
                      </ul>
                      {/* Saying exactly what was checked, because "verified" is easy to over-read. */}
                      <p className="ai-caveat">
                        以上引用已核对：引文确实逐字来自本次发送给模型的原文。
                        引文是否支持这里的结论、以及结论本身是否正确，不在这道校验的范围内。
                      </p>
                    </>
                  )}
                </>
              )}

              {turn.failure !== null && (
                <div className="ai-failure" role="alert">
                  <p>{turn.failure.message}</p>
                  <button type="button" className="btn" onClick={onRetry}>
                    重试
                  </button>
                </div>
              )}
            </section>
          ))}

          {busy && (
            <p className="ai-busy" role="status">
              <Loader2 size={14} aria-hidden="true" className="spin" />
              正在请求模型…
              <button type="button" className="btn btn-quiet" onClick={onCancel}>
                取消
              </button>
            </p>
          )}
          <div ref={bottom} />
        </div>
      )}

      <form className="ai-ask" onSubmit={submit}>
        <label>
          <span className="sr-only">继续提问</span>
          <input
            type="text"
            value={question}
            maxLength={MAX_QUESTION}
            disabled={busy}
            placeholder={
              session === null
                ? '就这一页提个问题…'
                : session.source.anchor === null
                  ? '就这一页继续追问…'
                  : '就这段原文继续追问…'
            }
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || question.trim() === ''}>
          <SendHorizontal size={14} aria-hidden="true" />
          提问
        </button>
      </form>
    </aside>
  );
}
