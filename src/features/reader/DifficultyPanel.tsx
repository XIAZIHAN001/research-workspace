import { Lightbulb, Loader2, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import {
  DIFFICULTY_KIND_LABEL,
  LOCATION_LABEL,
  type DifficultySuggestion,
} from '../../domain/difficulty';
import type { DifficultyScan } from './useDifficultyScan';

interface DifficultyPanelProps {
  scan: DifficultyScan;
  /** True when the service is a paid one, so the enablement text can say so before anything runs. */
  online: boolean;
  currentPage: number;
  onShow: (suggestion: DifficultySuggestion) => void;
  onClose: () => void;
}

/**
 * The difficulty suggestions, and the controls that decide whether they exist.
 *
 * The enablement screen is deliberately not a switch. Turning this on sends a page of the
 * reader's paper to a model, possibly a paid one, so the first time it happens the reader is
 * shown what will be sent, what it will cost and how much of the paper is covered — and then
 * presses a button that says so.
 */
export function DifficultyPanel({
  scan,
  online,
  currentPage,
  onShow,
  onClose,
}: DifficultyPanelProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <aside className="difficulty-panel" aria-label="智能难点">
      <div className="notes-head">
        <span className="notes-title">
          <Lightbulb size={14} aria-hidden="true" /> 智能难点
        </span>
        <button type="button" className="icon-btn" aria-label="关闭难点面板" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {!scan.enabled ? (
        <div className="difficulty-intro">
          <p>
            打开后，阅读器会把当前这一页的正文交给模型，找出值得停下来理解的位置：核心概念、定义、
            定理、关键公式、算法步骤、设计选择、前置知识。
          </p>
          <ul className="difficulty-facts">
            <li>发送范围：一次只有当前这一页，不会扫描整篇论文。</li>
            <li>
              费用：
              {online
                ? '会调用在线模型，每一次分析都可能产生费用。'
                : '当前是本地模拟，不产生任何费用。'}
            </li>
            <li>缓存：分析过的页面会被记住，翻回来不会重复发送。</li>
            <li>影响：建议可以随时关闭或忽略，不会写入你的笔记。</li>
          </ul>
          {confirming ? (
            <div className="difficulty-confirm">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  scan.setEnabled(true);
                  // The reader just confirmed an online analysis of the current page. Granting
                  // the session consent here is what lets later pages continue automatically;
                  // without it, only this page would be analysed and the rest would silently
                  // stop with no obvious cause.
                  if (online) scan.grantOnlineConsent();
                  setConfirming(false);
                }}
              >
                {online ? '开始分析（会调用在线模型）' : '开始分析'}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirming(true)}>
              启用智能难点标注
            </button>
          )}
        </div>
      ) : (
        <div className="difficulty-body">
          <div className="difficulty-bar">
            <label className="difficulty-toggle">
              <input
                type="checkbox"
                checked={scan.markersVisible}
                onChange={(event) => {
                  scan.setMarkersVisible(event.target.checked);
                }}
              />
              在页面上显示标记
            </label>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                scan.reanalyse();
              }}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {online ? '重新分析（会调用在线模型）' : '重新分析'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                scan.setEnabled(false);
              }}
            >
              关闭
            </button>
          </div>

          <p className="difficulty-status" role="status">
            {scan.status === 'running' && (
              <>
                <Loader2 size={13} aria-hidden="true" className="spin" />
                正在分析第 {currentPage} 页…
              </>
            )}
            {scan.status === 'error' && (
              <>
                <TriangleAlert size={13} aria-hidden="true" />
                {scan.error ?? '这一页分析失败。'} 阅读与批注不受影响，可以重试。
              </>
            )}
            {scan.status === 'idle' &&
              (scan.autoPaused
                ? '在线模式下自动分析已暂停：翻页不会自动产生费用，直到你重新确认。'
                : scan.analysedPages === 0
                  ? `已开启。翻到想读的页面就会自动分析（第 ${currentPage} 页稍后开始）。`
                  : `已分析 ${scan.analysedPages} 页；本页有 ${scan.current.length} 条建议。`)}
          </p>

          {scan.autoPaused && (
            <div className="difficulty-confirm difficulty-paused" role="alert">
              <p>
                在线模式下，自动分析会在你停留的每一页发起一次付费请求。切换到在线模式后，
                之前的离线授权不算数，需要在这里重新确认。
              </p>
              <div className="difficulty-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    scan.grantOnlineConsent();
                  }}
                >
                  确认开启在线自动分析（会持续产生费用）
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    scan.analyse(currentPage);
                  }}
                >
                  只分析当前页
                </button>
              </div>
            </div>
          )}

          {scan.status === 'error' && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                scan.analyse(currentPage);
              }}
            >
              重试这一页
            </button>
          )}

          {scan.current.length === 0 && scan.status !== 'running' ? (
            <p className="difficulty-empty">这一页暂时没有难点建议。</p>
          ) : (
            <ul className="difficulty-list">
              {scan.current.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    className="difficulty-item"
                    data-located={suggestion.location === 'found'}
                    onClick={() => {
                      onShow(suggestion);
                    }}
                  >
                    <span className="difficulty-kind">
                      {DIFFICULTY_KIND_LABEL[suggestion.kind]}
                    </span>
                    <span className="difficulty-title">{suggestion.title}</span>
                    <span className="difficulty-quick">{suggestion.quick}</span>
                    {suggestion.location !== 'found' && (
                      <span className="difficulty-unlocated">
                        {LOCATION_LABEL[suggestion.location]}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="ai-caveat difficulty-caveat">
            这些是 AI 给出的理解建议，不是论文原文，也没有经过引用校验——它们的引文只保证
            「逐字出现在这一页」。
          </p>
        </div>
      )}
    </aside>
  );
}
