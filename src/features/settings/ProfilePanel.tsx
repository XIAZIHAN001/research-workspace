import { useEffect, useState } from 'react';
import { clearRecoveryCopies } from '../../services/recoveryCleanup';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { formatBytes } from '../../ui/format';
import { PROFILE_NAME_MAX } from './useProfileName';

interface ProfilePanelProps {
  name: string;
  /** Stores the typed name and returns what is actually shown (trimmed, or the default). */
  onName: (raw: string) => string;
  stats: { papers: number; notes: number; concepts: number };
}

const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Ctrl / Cmd + K', action: '全局检索' },
  { keys: 'Ctrl / Cmd + F', action: '在论文内查找' },
  { keys: 'Enter / Shift + Enter', action: '下一个 / 上一个查找结果' },
  { keys: 'Esc', action: '关闭查找或对话框' },
  { keys: 'Alt + ← / →', action: '回到上一个 / 下一个阅读位置' },
  { keys: '页码框 Enter', action: '跳到输入的页' },
  { keys: '分隔条 ← / →', action: '调整侧栏与面板宽度' },
];

/**
 * Settings › Profile: the reader's own name, the app's version, and what is on this machine.
 *
 * There is no account and no server: the name is a label for the sidebar, stored beside the
 * rest of the workspace. The data rows describe storage without offering to erase it — the one
 * cleanup action only removes recovery copies, never a paper, a PDF, a note or a concept.
 */
export function ProfilePanel({ name, onName, stats }: ProfilePanelProps) {
  const [draft, setDraft] = useState(name);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanNotice, setCleanNotice] = useState<string | null>(null);

  useEffect(() => {
    // A one-shot read on mount. The estimate is advisory: an unsupported browser simply shows
    // nothing instead of a made-up number.
    let cancelled = false;
    const storage = navigator.storage;
    if (storage === undefined || typeof storage.estimate !== 'function') return;
    void storage.estimate().then(
      (estimate) => {
        if (!cancelled) setUsage({ used: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
      },
      () => {
        if (!cancelled) setUsage(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const clean = (): void => {
    setCleanOpen(false);
    setCleanNotice(null);
    void clearRecoveryCopies().then(
      (result) => {
        const parts = [`清理了 ${String(result.keys)} 个恢复副本`];
        if (result.journal) parts.push('1 份恢复日志');
        setCleanNotice(
          result.keys === 0 && !result.journal
            ? '没有找到需要清理的恢复副本。论文、PDF、笔记和知识都没有改动。'
            : `${parts.join('，')}。论文、PDF、笔记和知识都没有改动。`,
        );
      },
      () => {
        setCleanNotice('清理没有完成。论文、PDF、笔记和知识都没有改动。');
      },
    );
  };

  return (
    <section className="settings-panel" aria-labelledby="profile-title">
      <header className="settings-panel-head">
        <h2 id="profile-title">个人</h2>
        <p className="settings-panel-hint">
          昵称和数据都只保存在这台设备上。应用没有账号系统，也没有把任何内容上传到服务器。
        </p>
      </header>

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">昵称</h3>
            <p className="settings-row-hint">显示在侧栏左下角。最多 {PROFILE_NAME_MAX} 个字。</p>
          </div>
          <label className="settings-field">
            <span className="sr-only">昵称</span>
            <input
              className="input"
              type="text"
              value={draft}
              maxLength={PROFILE_NAME_MAX}
              placeholder="本地工作区"
              onChange={(event) => {
                setDraft(event.target.value);
                onName(event.target.value);
              }}
              onBlur={() => {
                setDraft(onName(draft));
              }}
            />
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">关于</h3>
            <p className="settings-row-hint">
              Research Workspace · 本地优先的论文阅读与知识整理工具。
            </p>
          </div>
          <span className="settings-value">v{__APP_VERSION__}</span>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <h3 className="settings-row-title">本地数据</h3>
            <p className="settings-row-hint">
              论文 {stats.papers} 篇 · 笔记 {stats.notes} 条 · 概念 {stats.concepts} 个
              {usage === null
                ? ''
                : `；已用 ${formatBytes(usage.used)} / 配额 ${formatBytes(usage.quota)}`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setCleanOpen(true);
            }}
          >
            清理恢复副本
          </button>
        </div>
      </div>

      {cleanNotice !== null && (
        <p className="settings-note" role="status">
          {cleanNotice}
        </p>
      )}

      <div className="settings-section">
        <h3 className="settings-section-title">快捷键</h3>
        <dl className="shortcut-list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="shortcut-row">
              <dt>{shortcut.keys}</dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </div>

      <ConfirmDialog
        open={cleanOpen}
        title="清理恢复副本？"
        confirmLabel="清理"
        danger
        onConfirm={clean}
        onClose={() => {
          setCleanOpen(false);
        }}
      >
        <p>
          只会删除早期无法读取时留下的数据副本，以及一次未完成恢复的日志。论文、PDF、笔记、概念和关系都不会被删除。
        </p>
      </ConfirmDialog>
    </section>
  );
}
