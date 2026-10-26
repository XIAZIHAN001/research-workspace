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
  getAiProviders,
  getAiSettings,
  getDesktopAiStatus,
  isDesktopApp,
  listAiModels,
  onDesktopAiStatus,
  setAiApiKey,
  setDesktopAiMode,
  updateAiSettings,
  type AiBudgetSettings,
  type AiCredentialStatus,
  type AiProviderPreset,
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

const DEFAULT_PROVIDER = 'deepseek';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_EFFORT: AiReasoningEffort = 'low';

/**
 * The table is served by the shell. These two rows exist only so the form still renders if an
 * older shell answers without the command; the custom row is the one every future provider can
 * be reached through anyway.
 */
const FALLBACK_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: DEFAULT_PROVIDER,
    label: 'DeepSeek',
    baseUrl: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supportsThinking: true,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    models: [],
    supportsThinking: false,
  },
];

const EFFORT_LABELS: Record<AiReasoningEffort, string> = {
  none: '关闭（最快，不思考）',
  low: '低（默认）',
  high: '高',
  max: '最高（最慢，消耗最多）',
};

const EFFORT_OPTIONS: readonly ChoiceOption<AiReasoningEffort>[] = (
  Object.keys(EFFORT_LABELS) as AiReasoningEffort[]
).map((value) => ({ value, label: EFFORT_LABELS[value] }));

/** The editable copy of the model section: provider, endpoint and model travel together. */
type ModelDraft = {
  provider: string;
  baseUrl: string;
  model: string;
  reasoningEffort: AiReasoningEffort;
};

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
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort &&
    a.budget.requests === b.budget.requests &&
    a.budget.tokensPerRequest === b.budget.tokensPerRequest &&
    a.budget.tokensPerSession === b.budget.tokensPerSession
  );
}

/**
 * Settings › AI service: the one place a key is entered, the provider and model are chosen, and
 * the cost rules live.
 *
 * The provider list comes from the shell, so the screen and the sidecar agree on ids, endpoints
 * and default models. The model field is free text on purpose — a gateway can serve names this
 * build has never heard of — with "获取可用模型" filling it from the provider's own catalogue.
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
  const [providers, setProviders] = useState<readonly AiProviderPreset[]>(FALLBACK_PROVIDERS);
  /** The key state of the provider currently being edited. */
  const [credential, setCredential] = useState<AiCredentialStatus | null>(null);
  /** The key state of the provider the running service is configured with. */
  const [activeCredential, setActiveCredential] = useState<AiCredentialStatus | null>(null);
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [budget, setBudget] = useState<AiBudgetSettings>(DEFAULT_BUDGET);
  const [draft, setDraft] = useState<AiBudgetSettings>(DEFAULT_BUDGET);
  const [modelDraft, setModelDraft] = useState<ModelDraft>({
    provider: DEFAULT_PROVIDER,
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_EFFORT,
  });
  /** What the provider's `/models` endpoint returned, if it has been asked this session. */
  const [fetchedModels, setFetchedModels] = useState<readonly string[]>([]);
  const [modelNote, setModelNote] = useState<Note | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [confirmOnline, setConfirmOnline] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const alive = useRef(true);
  /** Prefix for the two plain field ids below; the listbox has its own. */
  const fieldId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const settingsRef = useRef<AiSettings | null>(null);
  /** Which provider the key section is showing, readable from the polling callback. */
  const draftProviderRef = useRef(DEFAULT_PROVIDER);
  useEffect(() => {
    draftProviderRef.current = modelDraft.provider;
  }, [modelDraft.provider]);

  useEffect(() => {
    if (!desktop) return;
    void getAiProviders().then((list) => {
      if (!alive.current) return;
      if (list.length > 0) setProviders(list);
    });
  }, [desktop]);

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
    setModelDraft({
      provider: next.provider,
      baseUrl: next.baseUrl,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
    });
    setFetchedModels([]);
  }, []);

  const refresh = useCallback(async () => {
    // Read the saved settings first: the two credential lookups below depend on which provider
    // is active, and that answer comes with them.
    const nextSettings = await getAiSettings();
    if (!alive.current) return;
    if (nextSettings !== null) applySettings(nextSettings);

    const draftProvider = draftProviderRef.current;
    const activeProvider = nextSettings?.provider ?? draftProvider;
    const [nextService, nextCredential, nextActiveCredential, nextHealth] = await Promise.all([
      getDesktopAiStatus(),
      getAiCredentialStatus(draftProvider),
      activeProvider === draftProvider
        ? Promise.resolve(null)
        : getAiCredentialStatus(activeProvider),
      fetchAiHealth(),
    ]);
    if (!alive.current) return;
    setService(nextService);
    setCredential(nextCredential);
    setActiveCredential(nextActiveCredential ?? nextCredential);
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
    const provider = modelDraft.provider;
    const result = await setAiApiKey(provider, candidate, modelDraft.baseUrl);
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
  }, [keyInput, modelDraft.baseUrl, modelDraft.provider, refresh]);

  const removeKey = useCallback(async () => {
    setBusy('delete');
    setNote(null);
    const result = await deleteAiApiKey(modelDraft.provider);
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
      text: '已删除这个供应商的系统凭据；如果它正是在用的供应商，在线服务也已停止。',
    });
    void refresh();
  }, [modelDraft.provider, refresh]);

  const switchMode = useCallback(
    async (mode: 'mock' | 'online') => {
      if (mode === 'online' && activeCredential?.configured !== true) {
        setNote({ kind: 'warning', text: '当前供应商还没有配置 API Key，不能进入在线模式。' });
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
    [activeCredential, refresh],
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
    setModelNote(null);
    const result = await updateAiSettings({
      provider: modelDraft.provider,
      baseUrl: modelDraft.baseUrl.trim(),
      model: modelDraft.model.trim(),
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
      text: '供应商与模型设置已保存。AI 服务已重启；下一次提问就会使用新的设置。',
    });
    void refresh();
  }, [applySettings, modelDraft, refresh]);

  const chooseProvider = useCallback(
    (id: string) => {
      const preset = providers.find((candidate) => candidate.id === id);
      if (preset === undefined) return;
      const saved = settingsRef.current;
      setModelNote(null);
      setKeyInput('');
      setShowKey(false);
      setConfirmDelete(false);
      setModelDraft((current) => {
        // Going back to the provider that is already saved should show what is actually in use,
        // including an endpoint the reader had edited by hand.
        if (saved !== null && saved.provider === id) {
          return {
            provider: id,
            baseUrl: saved.baseUrl,
            model: saved.model,
            reasoningEffort: saved.reasoningEffort,
          };
        }
        return {
          provider: id,
          baseUrl: preset.baseUrl,
          model: preset.defaultModel,
          reasoningEffort: current.reasoningEffort,
        };
      });
      setFetchedModels([]);
      // The key section belongs to the provider being edited, so ask about that one right away
      // instead of waiting for the next poll.
      void getAiCredentialStatus(id).then((status) => {
        if (alive.current) setCredential(status);
      });
    },
    [providers],
  );

  const requestModels = useCallback(async () => {
    const baseUrl = modelDraft.baseUrl.trim();
    if (baseUrl === '') {
      setModelNote({ kind: 'warning', text: '请先填写 API 地址，再获取模型列表。' });
      return;
    }
    const saved = settingsRef.current;
    const preset = providers.find((candidate) => candidate.id === modelDraft.provider);
    const savedBase =
      saved !== null && saved.provider === modelDraft.provider
        ? saved.baseUrl.trim()
        : (preset?.baseUrl ?? '').trim();
    const candidateKey = keyInput.trim();
    // A stored key is bound to the endpoint it was saved for. Asking a different endpoint with
    // it would be exactly the credential-forwarding path this guard exists to close.
    if (baseUrl !== savedBase && candidateKey === '') {
      setModelNote({
        kind: 'warning',
        text: '更换 API 地址后，获取模型列表需要先在上面输入这个地址的 API Key；保存 Key 时会把地址一并绑定。',
      });
      return;
    }
    setBusy('models');
    setModelNote(null);
    const result = await listAiModels({
      provider: modelDraft.provider,
      baseUrl,
      apiKey: candidateKey,
    });
    if (!alive.current) return;
    setBusy(null);
    if (!result.ok) {
      setModelNote({ kind: 'error', text: result.message });
      return;
    }
    setFetchedModels(result.models);
    setModelNote({
      kind: 'success',
      text: `查询到 ${String(result.models.length)} 个可用模型，点选即可填入。`,
    });
  }, [keyInput, modelDraft.baseUrl, modelDraft.provider, providers]);

  /** Undoes unsaved edits in the model section, including a provider switch. */
  const resetModel = useCallback(() => {
    const saved = settingsRef.current;
    setModelNote(null);
    setFetchedModels([]);
    setKeyInput('');
    setConfirmDelete(false);
    setModelDraft({
      provider: saved?.provider ?? DEFAULT_PROVIDER,
      baseUrl: saved?.baseUrl ?? DEFAULT_BASE_URL,
      model: saved?.model ?? DEFAULT_MODEL,
      reasoningEffort: saved?.reasoningEffort ?? DEFAULT_EFFORT,
    });
    void getAiCredentialStatus(saved?.provider ?? DEFAULT_PROVIDER).then((status) => {
      if (alive.current) setCredential(status);
    });
  }, []);

  const mode = service?.mode ?? 'mock';
  const online = service?.online === true;
  const pending = service?.state === 'starting';
  const usage = health?.usage;
  const pricing = health?.pricing;
  const credentialReady = credential?.configured === true;
  const activeCredentialReady = activeCredential?.configured === true;

  const currentProvider = providers.find((preset) => preset.id === modelDraft.provider);
  const currentProviderLabel = currentProvider?.label ?? modelDraft.provider;
  const supportsThinking = currentProvider?.supportsThinking === true;
  const activeProvider = providers.find((preset) => preset.id === settings?.provider);
  const activeProviderLabel = activeProvider?.label ?? settings?.provider ?? '在线模型';
  const providerOptions: readonly ChoiceOption<string>[] = providers.map((preset) => ({
    value: preset.id,
    label: preset.label,
  }));
  // The preset's suggestions come first; whatever the account actually has is appended to them.
  const suggestedModels = Array.from(
    new Set([...(currentProvider?.models ?? []), ...fetchedModels]),
  );

  const statusText = pending
    ? 'AI 服务正在按新模式重启…'
    : service?.state === 'failed'
      ? `服务不可用：${service.error ?? '未知原因'}`
      : online
        ? `当前：${providerModeLabel(true)} · ${activeProviderLabel} ${settings?.model ?? ''}`.trim()
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
                disabled={!activeCredentialReady || busy !== null || pending}
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
              <KeyRound size={15} aria-hidden="true" /> API Key · {currentProviderLabel}
            </h3>
            <p className="ai-settings__credential" data-configured={credentialReady}>
              {credential?.error !== null && credential?.error !== undefined ? (
                <>
                  <ShieldOff size={14} aria-hidden="true" /> {credential.error}
                </>
              ) : credentialReady ? (
                <>
                  <ShieldCheck size={14} aria-hidden="true" /> {currentProviderLabel} 已配置：
                  保存在 Windows 凭据管理器，应用无法读回明文。
                </>
              ) : (
                <>
                  <ShieldOff size={14} aria-hidden="true" /> {currentProviderLabel} 还没有配置 API
                  Key。
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
              供应商与模型
            </h3>
            <p className="ai-settings__hint">
              供应商决定调用哪家服务；API 地址和模型名称都可以手动填写。也可以先保存密钥，
              再用「获取可用模型」读取这个账号实际可用的模型列表。Key 会绑定保存时的 API
              地址（协议与主机）：更换地址后需要重新保存 Key，旧 Key
              不会自动发往新地址。离线模拟不会调用 模型，但这里的设置会保留，切换到在线模式后生效。
            </p>
            <div className="ai-settings__budget">
              <Choice
                label="供应商"
                value={modelDraft.provider}
                options={providerOptions}
                disabled={busy !== null}
                onChange={chooseProvider}
              />
              {supportsThinking && (
                <Choice
                  label="思考强度"
                  value={modelDraft.reasoningEffort}
                  options={EFFORT_OPTIONS}
                  disabled={busy !== null}
                  onChange={(reasoningEffort) => {
                    setModelDraft({ ...modelDraft, reasoningEffort });
                  }}
                />
              )}
            </div>
            <div className="ai-settings__field">
              <label htmlFor={`${fieldId}-base-url`}>API 地址</label>
              <div className="ai-settings__row">
                <input
                  id={`${fieldId}-base-url`}
                  type="url"
                  value={modelDraft.baseUrl}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => {
                    setModelDraft({ ...modelDraft, baseUrl: event.target.value });
                    setFetchedModels([]);
                    setModelNote(null);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={
                    busy !== null || currentProvider === undefined || currentProvider.baseUrl === ''
                  }
                  onClick={() => {
                    setModelDraft({ ...modelDraft, baseUrl: currentProvider?.baseUrl ?? '' });
                    setFetchedModels([]);
                    setModelNote(null);
                  }}
                >
                  恢复默认
                </button>
              </div>
            </div>
            <div className="ai-settings__field">
              <label htmlFor={`${fieldId}-model`}>模型名称</label>
              <div className="ai-settings__row">
                <input
                  id={`${fieldId}-model`}
                  type="text"
                  value={modelDraft.model}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="例如 deepseek-flash 或 gpt-4o-mini"
                  onChange={(event) => {
                    setModelDraft({ ...modelDraft, model: event.target.value });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy !== null}
                  onClick={() => {
                    void requestModels();
                  }}
                >
                  {busy === 'models' ? <Loader2 size={14} className="spin" /> : null}
                  获取可用模型
                </button>
              </div>
            </div>
            {suggestedModels.length > 0 && (
              <div className="ai-model-picker" role="group" aria-label="可选模型">
                {suggestedModels.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="ai-model-chip"
                    data-active={id === modelDraft.model}
                    disabled={busy !== null}
                    onClick={() => {
                      setModelDraft({ ...modelDraft, model: id });
                    }}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
            {modelNote !== null && (
              <p className="ai-settings__note" data-kind={modelNote.kind} role="status">
                {modelNote.text}
              </p>
            )}
            <p className="ai-settings__state" data-online={online}>
              {health === null
                ? 'AI 服务当前不可用，读不到生效值。'
                : health.online
                  ? `当前生效：${health.provider} · ${health.model} · ${health.reasoning ?? '未知'}`
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
                onClick={resetModel}
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
