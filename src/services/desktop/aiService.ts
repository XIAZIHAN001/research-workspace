/**
 * The desktop shell's side of the AI service contract.
 *
 * In a browser the page and the service share an origin through the Vite proxy, so there is
 * nothing here to do. In the desktop build the service is a child of the Tauri process on an
 * ephemeral loopback port, and the page must ask the Rust side for that port and for the
 * per-launch bearer token. Both arrive over Tauri IPC, never over HTTP, which is why an
 * unrelated local page cannot obtain them even if it finds the port.
 *
 * The API key is different again: it goes *to* Rust once, is stored in the system credential
 * store, and is never returned. These wrappers expose a boolean and a mode, not a secret.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type DesktopAiState = 'starting' | 'ready' | 'failed' | 'stopped';
export type DesktopAiMode = 'mock' | 'online';

export interface DesktopAiStatus {
  state: DesktopAiState;
  mode: DesktopAiMode;
  baseUrl: string | null;
  token: string | null;
  provider: string | null;
  model: string | null;
  online: boolean;
  instanceId: string | null;
  credentialConfigured: boolean;
  error: string | null;
}

export interface AiCredentialStatus {
  configured: boolean;
  error: string | null;
}

export interface AiBudgetSettings {
  requests: number;
  tokensPerRequest: number;
  tokensPerSession: number;
}

/** The documented thinking levels. `none` disables thinking entirely. */
export type AiReasoningEffort = 'none' | 'low' | 'high' | 'max';

/** How a model call is made: which model, how hard it thinks, and what it may spend. */
export interface AiSettings {
  budget: AiBudgetSettings;
  model: string;
  reasoningEffort: AiReasoningEffort;
}

/** A save changes only the section it belongs to; the shell merges it with the rest. */
export interface AiSettingsPatch {
  budget?: AiBudgetSettings;
  model?: string;
  reasoningEffort?: AiReasoningEffort;
}

export const AI_STATUS_EVENT = 'ai-service-status';
/** Fired in-page after a mode or key change, so panels holding health can refresh it. */
export const AI_MODE_EVENT = 'rw-ai-mode-changed';

/** True only inside the Tauri webview; false in a normal browser and in jsdom tests. */
export function isDesktopApp(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export async function getDesktopAiStatus(): Promise<DesktopAiStatus | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<DesktopAiStatus>('ai_service_info');
  } catch {
    return null;
  }
}

export async function restartDesktopAiService(): Promise<DesktopAiStatus | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<DesktopAiStatus>('restart_ai_service');
  } catch {
    return null;
  }
}

/** Whether a key is stored. The value itself has no IPC path back to the page. */
export async function getAiCredentialStatus(): Promise<AiCredentialStatus | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<AiCredentialStatus>('ai_credentials_status');
  } catch (error) {
    return {
      configured: false,
      error: typeof error === 'string' ? error : '无法读取系统凭据存储状态。',
    };
  }
}

/**
 * Sends a key to Rust once. The caller must drop its own copy afterwards; this module never
 * keeps it, and Rust never returns it.
 */
export async function setAiApiKey(key: string): Promise<AiCredentialStatus | null> {
  if (!isDesktopApp()) return null;
  try {
    await invoke('set_ai_api_key', { key });
    return await invoke<AiCredentialStatus>('ai_credentials_status');
  } catch (error) {
    return {
      configured: false,
      error: typeof error === 'string' ? error : 'API Key 没有保存成功。',
    };
  }
}

export async function deleteAiApiKey(): Promise<CredentialMutation> {
  if (!isDesktopApp()) return { ok: false, message: '只有桌面版可以管理系统凭据。' };
  try {
    const status = await invoke<DesktopAiStatus>('delete_ai_api_key');
    notifyAiModeChanged();
    return { ok: true, status };
  } catch (error) {
    return { ok: false, message: typeof error === 'string' ? error : '删除 API Key 失败。' };
  }
}

export type CredentialMutation =
  { ok: true; status: DesktopAiStatus } | { ok: false; message: string };

export async function setDesktopAiMode(mode: DesktopAiMode): Promise<CredentialMutation> {
  if (!isDesktopApp()) return { ok: false, message: '只有桌面版可以切换 AI 模式。' };
  try {
    const status = await invoke<DesktopAiStatus>('set_ai_mode', { mode });
    notifyAiModeChanged();
    return { ok: true, status };
  } catch (error) {
    return { ok: false, message: typeof error === 'string' ? error : '切换 AI 模式失败。' };
  }
}

export async function getAiSettings(): Promise<AiSettings | null> {
  if (!isDesktopApp()) return null;
  try {
    return await invoke<AiSettings>('get_ai_settings');
  } catch {
    return null;
  }
}

export async function updateAiSettings(
  patch: AiSettingsPatch,
): Promise<{ ok: true; settings: AiSettings } | { ok: false; message: string }> {
  if (!isDesktopApp()) return { ok: false, message: '只有桌面版可以修改 AI 设置。' };
  try {
    const settings = await invoke<AiSettings>('update_ai_settings', { patch });
    notifyAiModeChanged();
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, message: typeof error === 'string' ? error : 'AI 设置没有保存成功。' };
  }
}

/** Tells open panels that the service they were talking to has changed. */
export function notifyAiModeChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AI_MODE_EVENT));
}

export async function onDesktopAiStatus(
  handler: (status: DesktopAiStatus) => void,
): Promise<UnlistenFn> {
  if (!isDesktopApp()) return () => {};
  return listen<DesktopAiStatus>(AI_STATUS_EVENT, (event) => {
    handler(event.payload);
  });
}
