import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsPanel } from './AiSettingsPanel';

const { savedSettings, updateAiSettings, getAiSettings } = vi.hoisted(() => ({
  savedSettings: {
    budget: { requests: 50, tokensPerRequest: 8192, tokensPerSession: 200_000 },
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  },
  updateAiSettings: vi.fn(),
  getAiSettings: vi.fn(),
}));

vi.mock('../../services/desktop/aiService', () => ({
  AI_MODE_EVENT: 'rw-ai-mode-changed',
  isDesktopApp: () => true,
  getDesktopAiStatus: async () => ({
    state: 'ready',
    mode: 'mock',
    baseUrl: null,
    token: null,
    provider: 'mock',
    model: 'mock-1',
    online: false,
    instanceId: 'instance-1',
    credentialConfigured: false,
    error: null,
  }),
  onDesktopAiStatus: async () => () => {},
  getAiCredentialStatus: async () => ({ configured: false, error: null }),
  getAiSettings,
  updateAiSettings,
  setAiApiKey: vi.fn(),
  deleteAiApiKey: vi.fn(),
  setDesktopAiMode: vi.fn(),
}));

vi.mock('../../services/ai/client', () => ({
  fetchAiHealth: async () => null,
}));

beforeEach(() => {
  updateAiSettings.mockReset();
  getAiSettings.mockReset();
  getAiSettings.mockResolvedValue(savedSettings);
  updateAiSettings.mockImplementation(
    async (patch: { model?: string; reasoningEffort?: string }) => ({
      ok: true,
      settings: {
        ...savedSettings,
        model: patch.model ?? savedSettings.model,
        reasoningEffort: patch.reasoningEffort ?? savedSettings.reasoningEffort,
      },
    }),
  );
});

describe('AiSettingsPanel model controls', () => {
  it('saves the model and the thinking effort together', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const model = await screen.findByRole('combobox', { name: '模型' });
    await waitFor(() => {
      expect(model).toHaveTextContent('DeepSeek Flash');
    });
    // The model's name is the whole label: no speed note after it.
    expect(model).not.toHaveTextContent('快速');

    await user.click(model);
    await user.click(screen.getByRole('option', { name: 'DeepSeek V4 Pro' }));
    expect(model).toHaveTextContent('DeepSeek V4 Pro');

    const effort = screen.getByRole('combobox', { name: '思考强度' });
    await user.click(effort);
    await user.click(screen.getByRole('option', { name: '高' }));
    await user.click(screen.getByRole('button', { name: '保存并重启服务' }));

    await waitFor(() => {
      expect(updateAiSettings).toHaveBeenCalledWith({
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      });
    });
    expect(await screen.findByText(/模型设置已保存/)).toBeInTheDocument();
  });

  it('keeps an unsaved choice when the next poll returns the same saved settings', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const model = await screen.findByRole('combobox', { name: '模型' });
    await waitFor(() => {
      expect(getAiSettings).toHaveBeenCalled();
    });
    await user.click(model);
    await user.click(screen.getByRole('option', { name: 'DeepSeek V4 Pro' }));

    // The panel polls every three seconds; a no-change response must not overwrite the draft.
    await waitFor(
      () => {
        expect(getAiSettings.mock.calls.length).toBeGreaterThan(1);
      },
      { timeout: 5000 },
    );
    expect(model).toHaveTextContent('DeepSeek V4 Pro');
  });
});
