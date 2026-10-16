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
import { segmentAnswer } from '../../services/ai/render';
import { AI_MODE_LABEL, type AiCitation, type AiHealth } from '../../services/ai/types';
import type { AiSession, AiTurn } from './useAiReading';

interface AiPanelProps {
  session: AiSession | null;
  busy: boolean;
  /** Null until the local service has been asked; the panel says so rather than guessing. */
  health: AiHealth | null;
  onFollowUp: (question: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  onClear: () => void;
  onSaveNote: (turn: AiTurn) => void;
  onJumpToCitation: (citation: AiCitation) => void;
  onClose: () => void;
}

const MAX_QUESTION = 1000;

/** Renders an answer as text with the verified citations turned into buttons. */
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
          {paragraph.pieces.map((piece, position) =>
            piece.kind === 'text' ? (
              <span key={position}>{piece.text}</span>
            ) : (
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
            ),
          )}
        </p>
      ))}
    </div>
  );
}

export function AiPanel({
  session,
  busy,
  health,
  onFollowUp,
  onRetry,
  onCancel,
  onClear,
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
    if (trimmed === '' || busy) return;
    setQuestion('');
    onFollowUp(trimmed);
  };

  const providerNote =
    health === null
      ? '还没有连上本地 AI 服务（npm run ai:serve）。'
      : health.online
        ? `回答来自 ${health.label}：会调用在线模型，可能产生费用。`
        : `回答来自 ${health.label}：不会发起任何在线调用。`;

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
        <div className="ai-empty">
          <p>选中论文里的一段原文，用浮动工具条上的「AI」按钮提问。</p>
          <p className="ai-hint">
            只能围绕选中的原文和这一页的上下文作答；不会发送整篇论文，也不会保存对话记录。
          </p>
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
              第 {session.source.anchor.page} 页，选中 {session.source.anchor.quote.length} 字 ——
              查看会发送的范围
            </button>
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
                    <p>{session.source.anchor.quote}</p>
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
                      <AnswerBody
                        answer={turn.answer.answer}
                        citations={turn.answer.citations}
                        onJump={onJumpToCitation}
                      />
                    )}
                  </div>
                </div>
              )}

              {turn.answer !== null && turn.mode !== 'translate' && (
                <AnswerBody
                  answer={turn.answer.answer}
                  citations={turn.answer.citations}
                  onJump={onJumpToCitation}
                />
              )}

              {turn.answer !== null && (
                <>
                  {turn.answer.groundedInText === false && (
                    <p className="ai-warn" role="status">
                      <TriangleAlert size={13} aria-hidden="true" />
                      模型认为提供的原文不足以完整回答这个问题，请注意分辨哪些是补充内容。
                    </p>
                  )}
                  {turn.answer.warnings.map((warning) => (
                    <p className="ai-warn" key={warning}>
                      <TriangleAlert size={13} aria-hidden="true" />
                      {warning}
                    </p>
                  ))}
                  <p className="ai-foot">
                    出处：第 {session.source.anchor.page} 页 · {turn.answer.providerLabel}
                    {turn.answer.usage?.completionTokens != null &&
                      ` · 输出 ${String(turn.answer.usage.completionTokens)} tokens`}
                  </p>
                  <div className="ai-turn-actions">
                    <button
                      type="button"
                      className="btn btn-quiet"
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
                  {turn.answer.citations.length > 0 && (
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
            disabled={session === null || busy}
            placeholder={session === null ? '先选中一段原文' : '就这段原文继续追问…'}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={session === null || busy || question.trim() === ''}
        >
          <SendHorizontal size={14} aria-hidden="true" />
          提问
        </button>
      </form>
    </aside>
  );
}
