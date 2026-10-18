/**
 * The desktop shell's side of the AI service contract.
 *
 * In a browser the page and the service share an origin through the Vite proxy, so there is
 * nothing here to do. In the desktop build the service is a child of the Tauri process on an
 * ephemeral loopback port, and the page must ask the Rust side for that port and for the
 * per-launch bearer token. Both arrive over Tauri IPC, never over HTTP, which is why an
 * unrelated local page cannot obtain them even if it finds the port.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type DesktopAiState = 'starting' | 'ready' | 'failed' | 'stopped';

export interface DesktopAiStatus {
  state: DesktopAiState;
  baseUrl: string | null;
  token: string | null;
  provider: string | null;
  instanceId: string | null;
  error: string | null;
}

export const AI_STATUS_EVENT = 'ai-service-status';

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

export async function onDesktopAiStatus(
  handler: (status: DesktopAiStatus) => void,
): Promise<UnlistenFn> {
  if (!isDesktopApp()) return () => {};
  return listen<DesktopAiStatus>(AI_STATUS_EVENT, (event) => {
    handler(event.payload);
  });
}
