import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateAiSettings } from './aiService';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const settings = {
  budget: { requests: 50, tokensPerRequest: 8192, tokensPerSession: 200000 },
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  reasoningEffort: 'low',
};
const starting = {
  state: 'starting',
  mode: 'mock',
  baseUrl: null,
  token: null,
  provider: null,
  model: null,
  online: false,
  instanceId: null,
  credentialConfigured: false,
  error: null,
};
beforeEach(() => invoke.mockReset());
describe('AI settings persistence versus service activation', () => {
  it('returns the actual starting status without claiming the new settings are running', async () => {
    invoke.mockResolvedValueOnce(settings).mockResolvedValueOnce(starting);
    expect(await updateAiSettings({ model: 'deepseek-flash' })).toEqual({
      ok: true,
      settings,
      status: starting,
    });
  });
  it('preserves saved settings when the new service fails to start', async () => {
    const status = { ...starting, state: 'failed', error: 'Injected startup timeout' };
    invoke.mockResolvedValueOnce(settings).mockResolvedValueOnce(status);
    expect(await updateAiSettings({ model: 'deepseek-flash' })).toEqual({
      ok: true,
      settings,
      status,
    });
  });
  it('does not turn an unavailable status query into a failed disk save', async () => {
    invoke.mockResolvedValueOnce(settings).mockRejectedValueOnce('IPC unavailable');
    expect(await updateAiSettings({ model: 'deepseek-flash' })).toEqual({
      ok: true,
      settings,
      status: null,
    });
  });
  it('returns disk failure instead of a saved configuration', async () => {
    invoke.mockRejectedValueOnce('Disk full');
    expect(await updateAiSettings({ model: 'deepseek-flash' })).toEqual({
      ok: false,
      message: 'Disk full',
    });
  });
});
