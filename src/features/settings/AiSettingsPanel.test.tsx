import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsPanel } from './AiSettingsPanel';

const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supportsThinking: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    supportsThinking: false,
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

const { savedSettings, updateAiSettings, getAiSettings, getAiCredentialStatus, listAiModels } =
  vi.hoisted(() => ({
    savedSettings: {
      budget: { requests: 50, tokensPerRequest: 8192, tokensPerSession: 200_000 },
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    },
    updateAiSettings: vi.fn(),
    getAiSettings: vi.fn(),
    getAiCredentialStatus: vi.fn(),
    listAiModels: vi.fn(),
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
  getAiProviders: async () => PROVIDERS,
  getAiCredentialStatus,
  getAiSettings,
  updateAiSettings,
  setAiApiKey: vi.fn(),
  deleteAiApiKey: vi.fn(),
  setDesktopAiMode: vi.fn(),
  listAiModels,
}));

vi.mock('../../services/ai/client', () => ({
  fetchAiHealth: async () => null,
}));

beforeEach(() => {
  updateAiSettings.mockReset();
  getAiSettings.mockReset();
  getAiCredentialStatus.mockReset();
  listAiModels.mockReset();
  getAiSettings.mockResolvedValue(savedSettings);
  getAiCredentialStatus.mockResolvedValue({ configured: false, error: null });
  listAiModels.mockResolvedValue({ ok: true, models: ['gpt-4o-mini', 'gpt-4o'] });
  updateAiSettings.mockImplementation(
    async (patch: {
      provider?: string;
      baseUrl?: string;
      model?: string;
      reasoningEffort?: string;
    }) => ({
      ok: true,
      settings: {
        ...savedSettings,
        provider: patch.provider ?? savedSettings.provider,
        baseUrl: patch.baseUrl ?? savedSettings.baseUrl,
        model: patch.model ?? savedSettings.model,
        reasoningEffort: patch.reasoningEffort ?? savedSettings.reasoningEffort,
      },
    }),
  );
});

describe('AiSettingsPanel model controls', () => {
  it('saves the provider, endpoint, model and thinking effort together', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const model = await screen.findByLabelText('模型名称');
    await waitFor(() => {
      expect(model).toHaveValue('deepseek-flash');
    });

    await user.clear(model);
    await user.type(model, 'deepseek-v4-pro');

    const effort = screen.getByRole('combobox', { name: '思考强度' });
    await user.click(effort);
    await user.click(screen.getByRole('option', { name: '高' }));
    await user.click(screen.getByRole('button', { name: '保存并重启服务' }));

    await waitFor(() => {
      expect(updateAiSettings).toHaveBeenCalledWith({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      });
    });
    expect(await screen.findByText(/供应商与模型设置已保存/)).toBeInTheDocument();
  });

  it('switching provider adopts its endpoint and default model, and hides the thinking choice', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const provider = await screen.findByRole('combobox', { name: '供应商' });
    await waitFor(() => {
      expect(provider).toHaveTextContent('DeepSeek');
    });
    expect(screen.getByRole('combobox', { name: '思考强度' })).toBeInTheDocument();

    await user.click(provider);
    await user.click(screen.getByRole('option', { name: 'OpenAI' }));

    expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByLabelText('模型名称')).toHaveValue('gpt-4o-mini');
    expect(screen.queryByRole('combobox', { name: '思考强度' })).not.toBeInTheDocument();
  });

  it('fills the model from the catalogue the provider returns', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const model = await screen.findByLabelText('模型名称');
    await waitFor(() => {
      expect(model).toHaveValue('deepseek-flash');
    });

    await user.click(screen.getByRole('button', { name: '获取可用模型' }));
    await waitFor(() => {
      expect(listAiModels).toHaveBeenCalledWith({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
      });
    });

    await user.click(await screen.findByRole('button', { name: 'gpt-4o' }));
    expect(model).toHaveValue('gpt-4o');
  });

  it('requires a key before listing models from a changed endpoint', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('模型名称')).toHaveValue('deepseek-flash');
    });
    const base = screen.getByLabelText('API 地址');
    await user.clear(base);
    await user.type(base, 'https://evil.example/v1');
    await user.click(screen.getByRole('button', { name: '获取可用模型' }));

    expect(listAiModels).not.toHaveBeenCalled();
    expect(screen.getByText(/更换 API 地址后/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('输入 API Key'), 'sk-new-key-123');
    await user.click(screen.getByRole('button', { name: '获取可用模型' }));
    await waitFor(() => {
      expect(listAiModels).toHaveBeenCalledWith({
        provider: 'deepseek',
        baseUrl: 'https://evil.example/v1',
        apiKey: 'sk-new-key-123',
      });
    });
  });

  it('keeps an unsaved choice when the next poll returns the same saved settings', async () => {
    const user = userEvent.setup();
    render(<AiSettingsPanel />);

    const model = await screen.findByLabelText('模型名称');
    await waitFor(() => {
      expect(getAiSettings).toHaveBeenCalled();
    });
    await user.clear(model);
    await user.type(model, 'my-gateway/model-1');

    // The panel polls every three seconds; a no-change response must not overwrite the draft.
    await waitFor(
      () => {
        expect(getAiSettings.mock.calls.length).toBeGreaterThan(1);
      },
      { timeout: 5000 },
    );
    expect(model).toHaveValue('my-gateway/model-1');
  });
});
