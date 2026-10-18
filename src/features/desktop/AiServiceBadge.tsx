import { RefreshCw, ShieldAlert, ShieldCheck, ShieldEllipsis } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  getDesktopAiStatus,
  isDesktopApp,
  onDesktopAiStatus,
  restartDesktopAiService,
  type DesktopAiState,
  type DesktopAiStatus,
} from '../../services/desktop/aiService';

const LABEL: Record<DesktopAiState, string> = {
  starting: 'AI 服务启动中…',
  ready: 'AI 服务就绪',
  failed: 'AI 服务不可用',
  stopped: 'AI 服务未启动',
};

const ICON = {
  starting: ShieldEllipsis,
  ready: ShieldCheck,
  failed: ShieldAlert,
  stopped: ShieldAlert,
} as const;

/**
 * The desktop-only status of the bundled AI service.
 *
 * It is deliberately small and out of the way when everything works, and it states the failure
 * with the actual reason when it does not. "The window opened" is not evidence that the
 * sidecar is alive, so the status is driven by lifecycle events from Rust rather than by the
 * mere existence of the window.
 */
export function AiServiceBadge() {
  const [desktop] = useState(() => isDesktopApp());
  const [status, setStatus] = useState<DesktopAiStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const current = await getDesktopAiStatus();
      if (!active) return;
      if (current !== null) setStatus(current);
      const stop = await onDesktopAiStatus((next) => {
        if (active) setStatus(next);
      });
      if (active) unlisten = stop;
      else stop();
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [desktop]);

  const restart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartDesktopAiService();
      if (next !== null) setStatus(next);
    } finally {
      setRestarting(false);
    }
  }, []);

  if (!desktop || status === null) return null;

  const Icon = ICON[status.state];
  const label =
    status.state === 'ready'
      ? `AI 服务就绪 · ${status.provider === 'mock' ? '离线 Mock' : (status.provider ?? '本地')}`
      : LABEL[status.state];
  const showRestart = status.state === 'failed' || status.state === 'stopped';

  return (
    <div
      className="ai-service-badge glass"
      data-state={status.state}
      role="status"
      aria-live="polite"
      title={status.error ?? label}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="ai-service-badge__label">{label}</span>
      {status.state === 'failed' && status.error !== null && (
        <span className="ai-service-badge__detail">{status.error}</span>
      )}
      {showRestart && (
        <button
          type="button"
          className="btn btn-quiet ai-service-badge__restart"
          onClick={() => {
            void restart();
          }}
          disabled={restarting}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {restarting ? '重启中…' : '重启服务'}
        </button>
      )}
    </div>
  );
}
