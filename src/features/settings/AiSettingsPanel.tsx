import {
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { providerModeLabel } from '../ai/providerLabel';
import { fetchAiHealth } from '../../services/ai/client';
import type { AiHealth } from '../../services/ai/types';
import {
  AI_MODE_EVENT,
  deleteAiApiKey,
  getAiCredentialStatus,
  getAiSettings,
  getDesktopAiStatus,
  isDesktopApp,
  onDesktopAiStatus,
  setAiApiKey,
  setDesktopAiMode,
  updateAiSettings,
  type AiBudgetSettings,
  type AiCredentialStatus,
  type AiReasoningEffort,
  type AiSettings,
  type DesktopAiStatus,
} from '../../services/desktop/aiService';

type Note = { kind: 'success' | 'warning' | 'error'; text: string };

const DEFAULT_BUDGET: AiBudgetSettings = {
  requests: 50,
  tokensPerRequest: 8192,
  tokensPerSession: 200_000,
};

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_EFFORT: AiReasoningEffort = 'low';

const EFFORT_LABELS: Record<AiReasoningEffort, string> = {
  none: '关闭（最快，不思考）',
  low: '低（默认）',
  high: '高',
  max: '最高（最慢，消耗最多）',
};

const MODEL_OPTIONS: readonly ChoiceOption<string>[] = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

const EFFORT_OPTIONS: readonly ChoiceOption<AiReasoningEffort>[] = (
  Object.keys(EFFORT_LABELS) as AiReasoningEffort[]
).map((value) => ({ value, label: EFFORT_LABELS[value] }));

type ModelDraft = { model: string; reasoningEffort: AiReasoningEffort };

interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  disabled: boolean;
  onChange: (value: T) => void;
}

/**
 * A listbox styled like a field. The native `<select>` popup is painted by the webview, so its
 * corners and colours cannot follow the theme; this keeps the menu on the page, where both are
 * the same as every other field.
 */
function Choice<T extends string>({ label, value, options, disabled, onChange }: ChoiceProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Opening always starts from the selected row, never from whichever row was left active.
    setActive(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setActive(selectedIndex);
        setOpen(true);
      } else {
        setActive((current) =>
          event.key === 'ArrowDown' ? Math.min(last, current + 1) : Math.max(0, current - 1),
        );
      }
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return;
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : last);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active);
      else toggle();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  }

  return (
    <div className="ai-settings__field ai-choice" ref={root}>
      <span id={`${id}-label`}>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="ai-choice__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-option-${String(active)}` : undefined}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul
          className="ai-choice__menu"
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={`${id}-label`}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-option-${String(index)}`}
              role="option"
              aria-selected={option.value === value}
              className="ai-choice__option"
              data-active={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                choose(index);
              }}
              onMouseEnter={() => {
                setActive(index);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatCny(value: number): string {
  if (value > 0 && value < 0.0001) return '< ¥0.0001';
  return `¥${value.toFixed(4)}`;
}

function sameSettings(a: AiSettings, b: AiSettings): boolean {
  return (
    a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort &&
    a.budget.requests === b.budget.requests &&
    a.budget.tokensPerRequest === b.budget.tokensPerRequest &&
    a.budget.tokensPerSession === b.budget.tokensPerSession
  );
}

/**
 * Settings › AI service: the one place a key is entered, and the place the cost rules live.
 *
 * The interface never names the upstream vendor. The mode and every explanation say only
 * "online model" or "offline simulation", so the same screen is accurate whether the desktop
 * shell is pointed at the offline provider or at the configured online endpoint.
 *
 * Two boundaries are visible in the markup rather than only in the documentation:
 * - the key input is write-only. There is no "show saved key" control because there is no call
 *   that could return one; the section reports only whether the credential store holds a value.
 * - mode changes require an explicit confirmation that names the provider *class* and the fact
 *   that a call can cost money. Switching to simulation needs no confirmation.
 */
export function AiSettingsPanel() {
  const [desktop] = useState(() => isDesktopApp());
  const [service, setService] = useState<DesktopAiStatus | null>(null);
  const [credential, setCredential] = useState<AiCredentialStatus | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [budget, setBudget] = useState<AiBudgetSettings>(DEFAULT_BUDGET);
  const [draft, setDraft] = useState<AiBudgetSettings>(DEFAULT_BUDGET);
  const [modelDraft, setModelDraft] = useState<ModelDraft>({
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_EFFORT,
  });
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [confirmOnline, setConfirmOnline] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const settingsRef = useRef<AiSettings | null>(null);

  /**
   * Adopts settings from the shell, but only when they actually changed.
   *
   * `refresh` polls every three seconds. Copying the polled values into the drafts
   * unconditionally would erase a half-typed budget or a model choice that had not been saved
   * yet.
   */
  const applySettings = useCallback((next: AiSettings) => {
    const prev = settingsRef.current;
    if (prev !== null && sameSettings(prev, next)) return;
    settingsRef.current = next;
    setSettings(next);
    setBudget(next.budget);
    setDraft(next.budget);
    setModelDraft({ model: next.model, reasoningEffort: next.reasoningEffort });
  }, []);

  const refresh = useCallback(async () => {
    const [nextService, nextCredential, nextSettings, nextHealth] = await Promise.all([
      getDesktopAiStatus(),
      getAiCredentialStatus(),
      getAiSettings(),
      fetchAiHealth(),
    ]);
    if (!alive.current) return;
    setService(nextService);
    setCredential(nextCredential);
    if (nextSettings !== null) applySettings(nextSettings);
    setHealth(nextHealth);
  }, [applySettings]);

  useEffect(() => {
    if (!desktop) return;
    // One frame later: the first load reads from IPC, and starting it outside the effect body
    // keeps this effect a subscription rather than a source of cascading renders.
    const kickoff = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    let unlisten: (() => void) | null = null;
    void onDesktopAiStatus((status) => {
      if (alive.current) setService(status);
    }).then((stop) => {
      if (alive.current) unlisten = stop;
      else stop();
    });
    const onMode = (): void => {
      void refresh();
    };
    window.addEventListener(AI_MODE_EVENT, onMode);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
      unlisten?.();
      window.removeEventListener(AI_MODE_EVENT, onMode);
    };
  }, [desktop, refresh]);

  const saveKey = useCallback(async () => {
    const candidate = keyInput.trim();
    if (candidate === '') {
      setNote({ kind: 'warning', text: '请先输入 API Key。' });
      return;
    }
    setBusy('key');
    setNote(null);
    const result = await setAiApiKey(candidate);
    // Drop the page's copy whether or not the write succeeded.
    setKeyInput('');
    setShowKey(false);
    if (!alive.current) return;
    setBusy(null);
    if (result === null || result.error !== null) {
      setNote({
        kind: 'error',
        text: result?.error ?? 'API Key 没有保存成功。',
      });
      return;
    }
    setCredential(result);
    setNote({
      kind: 'success',
      text: 'API Key 已保存到系统凭据存储。应用不会把它写进浏览器存储、备份或日志。',
    });
    void refresh();
  }, [keyInput, refresh]);

  const removeKey = useCallback(async () => {
    setBusy('delete');
    setNote(null);
    const result = await deleteAiApiKey();
    if (!alive.current) return;
    setBusy(null);
    setConfirmDelete(false);
    if (!result.ok) {
      setNote({ kind: 'error', text: result.message });
      return;
    }
    setService(result.status);
    setNote({
      kind: 'success',
      text: '已删除系统凭据并停止在线服务；此前的密钥不会再被使用。',
    });
    void refresh();
  }, [refresh]);

  const switchMode = useCallback(
    async (mode: 'mock' | 'online') => {
      if (mode === 'online' && credential?.configured !== true) {
        setNote({ kind: 'warning', text: '还没有配置 API Key，不能进入在线模式。' });
        return;
      }
      if (mode === 'online') {
        setConfirmOnline(true);
        return;
      }
      setBusy('mode');
      setNote(null);
      const result = await setDesktopAiMode('mock');
      if (!alive.current) return;
      setBusy(null);
      if (!result.ok) {
        setNote({ kind: 'error', text: result.message });
        return;
      }
      setService(result.status);
      setNote({ kind: 'success', text: '已切换到离线模拟。不会发起在线调用。' });
      void refresh();
    },
    [credential, refresh],
  );

  const confirmSwitchOnline = useCallback(async () => {
    setConfirmOnline(false);
    setBusy('mode');
    setNote(null);
    const result = await setDesktopAiMode('online');
    if (!alive.current) return;
    setBusy(null);
    if (!result.ok) {
      setNote({ kind: 'error', text: result.message });
      return;
    }
    setService(result.status);
    setNote({
      kind: 'warning',
      text: '已切换到在线模型。只有你明确发起提问、难点分析或知识分析时才会调用模型。',
    });
    void refresh();
  }, [refresh]);

  const saveBudget = useCallback(async () => {
    setBusy('budget');
    setNote(null);
    const result = await updateAiSettings({ budget: draft });
    if (!alive.current) return;
    setBusy(null);
    if (!result.ok) {
      setNote({ kind: 'error', text: result.message });
      return;
    }
    applySettings(result.settings);
    setNote({
      kind: 'success',
      text: '预算已保存。AI 服务已重启，本次会话的用量统计从头开始。',
    });
    void refresh();
  }, [applySettings, draft, refresh]);

  const saveModel = useCallback(async () => {
    setBusy('model');
    setNote(null);
    const result = await updateAiSettings({
      model: modelDraft.model,
      reasoningEffort: modelDraft.reasoningEffort,
    });
    if (!alive.current) return;
    setBusy(null);
    if (!result.ok) {
      setNote({ kind: 'error', text: result.message });
      return;
    }
    applySettings(result.settings);
    setNote({
      kind: 'success',
      text: '模型设置已保存。AI 服务已重启；下一次提问就会使用新的模型和思考强度。',
    });
    void refresh();
  }, [applySettings, modelDraft, refresh]);

  const mode = service?.mode ?? 'mock';
  const online = service?.online === true;
  const pending = service?.state === 'starting';
  const usage = health?.usage;
  const pricing = health?.pricing;
  const credentialReady = credential?.configured === true;

  const statusText = pending
    ? 'AI 服务正在按新模式重启…'
    : service?.state === 'failed'
      ? `服务不可用：${service.error ?? '未知原因'}`
      : online
        ? `当前：${providerModeLabel(true)}`
        : `当前：${providerModeLabel(false)}`;

  return (
    <section className="settings-panel ai-settings" aria-labelledby="ai-settings-title">
      <header className="settings-panel-head">
        <h2 id="ai-settings-title">AI 服务</h2>
        <p className="settings-panel-hint">
          应用只在明确提问、难点分析或知识分析时调用模型服务；每次启动都从离线模拟开始。
        </p>
      </header>

      {!desktop ? (
        <p className="ai-settings__notice">
          这些设置只在桌面应用中可用。浏览器版不会保存 API Key，也不能切换到在线模型。
        </p>
      ) : (
        <>
          <section className="settings-section" aria-labelledby="ai-mode-title">
            <h3 id="ai-mode-title" className="settings-section-title">
              运行模式
            </h3>
            <div className="settings-choices" role="group" aria-label="运行模式">
              <button
                type="button"
                className="settings-choice"
                data-active={mode === 'mock'}
                aria-pressed={mode === 'mock'}
                disabled={busy !== null || pending}
                onClick={() => {
                  void switchMode('mock');
                }}
              >
                <WifiOff size={18} aria-hidden="true" />
                <span className="settings-choice__body">
                  <span className="settings-choice__title">离线模拟</span>
                  <span className="settings-choice__text">
                    不访问网络，不产生费用，适合演示与验收。
                  </span>
                </span>
                {mode === 'mock' && <Check size={15} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="settings-choice"
                data-active={mode === 'online'}
                aria-pressed={mode === 'online'}
                disabled={!credentialReady || busy !== null || pending}
                onClick={() => {
                  void switchMode('online');
                }}
              >
                <Wifi size={18} aria-hidden="true" />
                <span className="settings-choice__body">
                  <span className="settings-choice__title">在线模型</span>
                  <span className="settings-choice__text">
                    使用已配置的在线 API；回答可能产生费用。
                  </span>
                </span>
                {mode === 'online' && <Check size={15} aria-hidden="true" />}
              </button>
            </div>
            {confirmOnline && (
              <div
                className="ai-settings__confirm"
                role="alertdialog"
                aria-label="确认切换在线模式"
              >
                <p>
                  在线模式下，你在提问、难点分析或知识分析中明确选择的论文文本会发送到你配置的
                  在线模型服务，并按服务方的价格计费。离线模拟与在线回答会分别标注，不会混淆。
                </p>
                <div className="ai-settings__actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      void confirmSwitchOnline();
                    }}
                  >
                    确认切换（可能产生费用）
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setConfirmOnline(false);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <p className="ai-settings__state" data-online={online}>
              {statusText}
            </p>
          </section>

          <section className="settings-section" aria-labelledby="ai-key-title">
            <h3 id="ai-key-title" className="settings-section-title">
              <KeyRound size={15} aria-hidden="true" /> API Key
            </h3>
            <p className="ai-settings__credential" data-configured={credentialReady}>
              {credential?.error !== null && credential?.error !== undefined ? (
                <>
                  <ShieldOff size={14} aria-hidden="true" /> {credential.error}
                </>
              ) : credentialReady ? (
                <>
                  <ShieldCheck size={14} aria-hidden="true" /> 已配置：保存在 Windows
                  凭据管理器，应用无法读回明文。
                </>
              ) : (
                <>
                  <ShieldOff size={14} aria-hidden="true" /> 未配置 API Key。
                </>
              )}
            </p>
            <form
              className="ai-settings__key-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveKey();
              }}
            >
              <label className="ai-settings__field">
                <span>{credentialReady ? '替换 API Key' : '输入 API Key'}</span>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={keyInput}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-…"
                  onChange={(event) => {
                    setKeyInput(event.target.value);
                  }}
                  data-autofocus={!credentialReady || undefined}
                />
              </label>
              <div className="ai-settings__actions">
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                  {busy === 'key' ? <Loader2 size={14} className="spin" /> : null}
                  {credentialReady ? '保存替换' : '保存到系统凭据'}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    setShowKey((value) => !value);
                  }}
                >
                  {showKey ? '隐藏输入' : '显示输入'}
                </button>
                {credentialReady &&
                  (confirmDelete ? (
                    <button
                      type="button"
                      className="btn btn-quiet ai-settings__danger"
                      disabled={busy !== null}
                      onClick={() => {
                        void removeKey();
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      确认删除
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirmDelete(true);
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      删除已保存的 Key
                    </button>
                  ))}
                {confirmDelete && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setConfirmDelete(false);
                    }}
                  >
                    取消删除
                  </button>
                )}
              </div>
            </form>
            <p className="ai-settings__hint">
              Key 只通过一次受控 IPC 交给 Rust，写入系统凭据存储；不会进入 LocalStorage、
              IndexedDB、普通 JSON 配置、备份文件、URL、命令行参数或日志。删除后会立即停止在线服务。
            </p>
          </section>

          <section className="settings-section" aria-labelledby="ai-model-title">
            <h3 id="ai-model-title" className="settings-section-title">
              模型与思考强度
            </h3>
            <p className="ai-settings__hint">
              更强的模型和更高的思考强度更慢，也可能更贵；关闭思考最快。离线模拟不会调用模型，
              但这里的设置会保留，切换到在线模式后生效。
            </p>
            <div className="ai-settings__budget">
              <Choice
                label="模型"
                value={modelDraft.model}
                options={MODEL_OPTIONS}
                disabled={busy !== null}
                onChange={(model) => {
                  setModelDraft({ ...modelDraft, model });
                }}
              />
              <Choice
                label="思考强度"
                value={modelDraft.reasoningEffort}
                options={EFFORT_OPTIONS}
                disabled={busy !== null}
                onChange={(reasoningEffort) => {
                  setModelDraft({ ...modelDraft, reasoningEffort });
                }}
              />
            </div>
            <p className="ai-settings__state" data-online={online}>
              {health === null
                ? 'AI 服务当前不可用，读不到生效值。'
                : health.online
                  ? `当前生效：${health.model} · ${health.reasoning ?? '未知'}`
                  : '离线模拟不使用模型；保存的设置会在切换到在线模式后生效。'}
            </p>
            <div className="ai-settings__actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || pending}
                onClick={() => {
                  void saveModel();
                }}
              >
                {busy === 'model' ? <Loader2 size={14} className="spin" /> : null}
                保存并重启服务
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy !== null}
                onClick={() => {
                  setModelDraft({
                    model: settings?.model ?? DEFAULT_MODEL,
                    reasoningEffort: settings?.reasoningEffort ?? DEFAULT_EFFORT,
                  });
                }}
              >
                还原为当前设置
              </button>
            </div>
          </section>
        </>
      )}

      <section className="settings-section" aria-labelledby="ai-cost-title">
        <h3 id="ai-cost-title" className="settings-section-title">
          费用与用量
        </h3>
        {health === null ? (
          <p className="ai-settings__hint">AI 服务当前不可用，暂时读不到用量。</p>
        ) : (
          <>
            <dl className="ai-settings__stats">
              <div>
                <dt>运行模式</dt>
                <dd>{online ? providerModeLabel(true) : providerModeLabel(false)}</dd>
              </div>
              <div>
                <dt>本次会话请求</dt>
                <dd>
                  {usage?.requests ?? 0} / {health.budget?.requests ?? budget.requests}
                </dd>
              </div>
              <div>
                <dt>输入 tokens</dt>
                <dd>{usage?.promptTokens ?? 0}</dd>
              </div>
              <div>
                <dt>输出 tokens</dt>
                <dd>{usage?.completionTokens ?? 0}</dd>
              </div>
              <div>
                <dt>会话 token 预算</dt>
                <dd>
                  {usage?.totalTokens ?? 0} /{' '}
                  {health.budget?.tokensPerSession ?? budget.tokensPerSession}
                </dd>
              </div>
              <div>
                <dt>费用估算</dt>
                <dd data-warning={pricing?.known === false}>
                  {pricing?.known === false
                    ? '不可靠：没有该模型的价格配置'
                    : formatCny(usage?.estimatedCostCny ?? 0)}
                </dd>
              </div>
            </dl>
            <p className="ai-settings__hint">
              token 用量来自模型服务的返回值；如果模型服务没有返回用量，统计会改用保守上界
              {usage?.exactTokens === false ? '（本次已发生）' : ''}。费用是根据价格表做的估算，
              不是账单，实际金额以服务方结算为准。
            </p>
            {pricing !== undefined && (
              <p className="ai-settings__pricing" data-known={pricing.known}>
                {pricing.known ? `估算价格读取于 ${pricing.asOf}。${pricing.note}` : pricing.note}
              </p>
            )}
          </>
        )}
      </section>

      <section className="settings-section" aria-labelledby="ai-budget-title">
        <h3 id="ai-budget-title" className="settings-section-title">
          会话预算限制
        </h3>
        <p className="ai-settings__hint">
          达到限制后，AI 服务会拒绝新的模型请求，不会自动重试或改用其他模型。重启 AI
          服务会开始新的会话并清零统计。
        </p>
        <div className="ai-settings__budget">
          <label className="ai-settings__field">
            <span>会话请求上限（次）</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={draft.requests}
              disabled={!desktop}
              onChange={(event) => {
                setDraft({ ...draft, requests: Number(event.target.value) });
              }}
            />
          </label>
          <label className="ai-settings__field">
            <span>单次生成上限（tokens）</span>
            <input
              type="number"
              min={256}
              max={32000}
              step={256}
              value={draft.tokensPerRequest}
              disabled={!desktop}
              onChange={(event) => {
                setDraft({ ...draft, tokensPerRequest: Number(event.target.value) });
              }}
            />
          </label>
          <label className="ai-settings__field">
            <span>会话 token 上限</span>
            <input
              type="number"
              min={256}
              max={10000000}
              step={1000}
              value={draft.tokensPerSession}
              disabled={!desktop}
              onChange={(event) => {
                setDraft({ ...draft, tokensPerSession: Number(event.target.value) });
              }}
            />
          </label>
        </div>
        <div className="ai-settings__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!desktop || busy !== null}
            onClick={() => {
              void saveBudget();
            }}
          >
            {busy === 'budget' ? <Loader2 size={14} className="spin" /> : null}
            保存预算并重启服务
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!desktop}
            onClick={() => {
              setDraft(budget);
            }}
          >
            还原为当前设置
          </button>
        </div>
      </section>

      {note !== null && (
        <p className="ai-settings__note" data-kind={note.kind} role="status">
          {note.text}
        </p>
      )}
    </section>
  );
}
