import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  configProblems,
  isLoopbackOrigin,
  isValidModelName,
  readConfig,
} from './config.mjs';

describe('readConfig', () => {
  it('defaults to the offline mock provider', () => {
    const config = readConfig({});
    expect(config.provider).toBe('mock');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.apiKey).toBe('');
  });

  it('only selects the online provider when asked by name', () => {
    expect(readConfig({ DEEPSEEK_API_KEY: 'sk-secret' }).provider).toBe('mock');
    expect(readConfig({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-secret' }).provider).toBe(
      'deepseek',
    );
  });

  it('cannot be talked into the online provider when it was started offline', () => {
    // `--offline` is a wall, not a default: a machine with a key exported into its shell must
    // still be able to start a service that is incapable of spending anything.
    const config = readConfig(
      { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-secret' },
      { forceOffline: true },
    );
    expect(config.provider).toBe('mock');
    expect(config.apiKey).toBe('');
    expect(configProblems(config)).toEqual([]);
  });

  it('never takes a binding address from the environment', () => {
    // The listen address is not a setting at all: it is a constant in the module.
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    const config = readConfig({ AI_HOST: '0.0.0.0' });
    expect(config).not.toHaveProperty('host');
  });

  it('keeps the published model names and rejects anything unusable', () => {
    expect(readConfig({}).model).toBe('deepseek-flash');
    expect(readConfig({ DEEPSEEK_MODEL: 'deepseek-v4-pro' }).model).toBe('deepseek-v4-pro');
    // A model name goes into a JSON body, so anything that is not a plain token is dropped.
    expect(readConfig({ DEEPSEEK_MODEL: 'deepseek-flash"}\n{"x":1' }).model).toBe('deepseek-flash');
    expect(isValidModelName('deepseek-flash')).toBe(true);
    expect(isValidModelName('')).toBe(false);
    expect(isValidModelName('a'.repeat(65))).toBe(false);
    expect(isValidModelName('model name')).toBe(false);
  });

  it('clamps the port and ignores nonsense timeouts', () => {
    expect(readConfig({ AI_PORT: '9999' }).port).toBe(9999);
    expect(readConfig({ AI_PORT: '-1' }).port).toBe(DEFAULT_PORT);
    expect(readConfig({ AI_PORT: 'abc' }).port).toBe(DEFAULT_PORT);
    // Port 0 (an ephemeral port) is only available to the desktop launcher, which needs it to
    // avoid ever depending on a fixed port someone else may already be using.
    expect(readConfig({ AI_PORT: '0' }).port).toBe(DEFAULT_PORT);
    expect(readConfig({ AI_PORT: '0' }, { allowEphemeralPort: true }).port).toBe(0);
    expect(readConfig({ AI_TIMEOUT_MS: '10' }).timeoutMs).toBe(120_000);
  });

  it('reads the desktop session credential and instance id', () => {
    const token = 'a'.repeat(64);
    const config = readConfig({
      AI_SESSION_TOKEN: ` ${token} `,
      AI_DESKTOP_INSTANCE: 'instance-1',
    });
    expect(config.sessionToken).toBe(token);
    expect(config.desktopInstance).toBe('instance-1');
    expect(configProblems(config)).toEqual([]);
  });

  it('refuses a desktop credential that is too short to be one', () => {
    const problems = configProblems(readConfig({ AI_SESSION_TOKEN: 'short' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AI_SESSION_TOKEN');
  });

  it('bounds the generation ceiling, which thinking mode spends from too', () => {
    // The default was raised from 4096 after a live formula question spent all of it reasoning
    // and returned no answer.
    expect(readConfig({}).answerTokens).toBe(8192);
    expect(readConfig({ AI_MAX_OUTPUT_TOKENS: '16384' }).answerTokens).toBe(16_384);
    // A typo must not be able to ask for a million tokens.
    expect(readConfig({ AI_MAX_OUTPUT_TOKENS: '1000000' }).answerTokens).toBe(8192);
    expect(readConfig({ AI_MAX_OUTPUT_TOKENS: '0' }).answerTokens).toBe(8192);
    expect(readConfig({ AI_MAX_OUTPUT_TOKENS: 'abc' }).answerTokens).toBe(8192);
  });

  it('strips trailing slashes from the base URL so paths join correctly', () => {
    expect(readConfig({ DEEPSEEK_BASE_URL: 'https://example.test/api/' }).baseUrl).toBe(
      'https://example.test/api',
    );
  });
});

describe('configProblems', () => {
  it('is silent for the default configuration', () => {
    expect(configProblems(readConfig({}))).toEqual([]);
  });

  it('refuses the online provider without a key', () => {
    const problems = configProblems(readConfig({ AI_PROVIDER: 'deepseek' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('DEEPSEEK_API_KEY');
  });

  it('refuses a non-https base URL for the online provider', () => {
    const problems = configProblems(
      readConfig({
        AI_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'k',
        DEEPSEEK_BASE_URL: 'http://x.test',
      }),
    );
    expect(problems.some((problem) => problem.includes('https'))).toBe(true);
  });

  it('accepts the custom Tauri scheme used by Linux and macOS webviews', () => {
    const problems = configProblems(readConfig({ AI_ALLOWED_ORIGINS: 'tauri://localhost' }));
    expect(problems).toEqual([]);
    expect(
      configProblems(
        readConfig({ AI_ALLOWED_ORIGINS: 'tauri://localhost,http://tauri.localhost' }),
      ),
    ).toEqual([]);
  });
});

describe('thinking mode', () => {
  it('is explicit rather than inherited from upstream defaults', () => {
    const config = readConfig({});
    // Upstream defaults to thinking enabled at effort `high`, and reasoning spends from the same
    // token budget as the answer, so the service decides this itself.
    expect(config.thinking).toBe('enabled');
    expect(config.reasoningEffort).toBe('low');
  });

  it('can be turned off, and then cannot contradict itself about the effort', () => {
    expect(readConfig({ DEEPSEEK_THINKING: 'disabled' }).thinking).toBe('disabled');
    expect(readConfig({ DEEPSEEK_THINKING: 'disabled' }).reasoningEffort).toBe('none');
    // Asking for no thinking and a high effort at the same time means two different things, so
    // the thinking switch wins and the effort is reported as what will actually be sent.
    const contradictory = readConfig({
      DEEPSEEK_THINKING: 'disabled',
      DEEPSEEK_REASONING_EFFORT: 'high',
    });
    expect(contradictory.reasoningEffort).toBe('none');
  });

  it('accepts only the documented effort levels', () => {
    expect(readConfig({ DEEPSEEK_REASONING_EFFORT: 'high' }).reasoningEffort).toBe('high');
    expect(readConfig({ DEEPSEEK_REASONING_EFFORT: 'max' }).reasoningEffort).toBe('max');
    expect(readConfig({ DEEPSEEK_REASONING_EFFORT: 'none' }).reasoningEffort).toBe('none');
    for (const nonsense of ['extreme', '', 'HIGH']) {
      expect(readConfig({ DEEPSEEK_REASONING_EFFORT: nonsense }).reasoningEffort).toBe('low');
    }
  });
});

describe('credential boundaries', () => {
  /**
   * The service is documented to read exactly one credential. This asserts the other direction:
   * that nothing else in the environment — least of all another tool's stored credentials —
   * reaches the configuration object at all.
   */
  it('reads no credential other than the one it documents', () => {
    const config = readConfig({
      DEEPSEEK_API_KEY: 'the-only-one-it-should-read',
      ANTHROPIC_API_KEY: 'sk-ant-must-not-be-read',
      OPENAI_API_KEY: 'sk-openai-must-not-be-read',
      CLAUDE_CODE_OAUTH_TOKEN: 'must-not-be-read',
      AWS_SECRET_ACCESS_KEY: 'must-not-be-read',
      GITHUB_TOKEN: 'must-not-be-read',
    });
    expect(config.apiKey).toBe('the-only-one-it-should-read');
    const serialized = JSON.stringify(config);
    for (const foreign of [
      'sk-ant-must-not-be-read',
      'sk-openai-must-not-be-read',
      'must-not-be-read',
    ]) {
      expect(serialized).not.toContain(foreign);
    }
  });

  it('keeps the key in exactly one field, and nowhere else', () => {
    const secret = 'sk-distinctive-value-9f2a';
    const config = readConfig({ DEEPSEEK_API_KEY: secret });
    // Counted rather than inspected, so a future field that happened to copy the key would
    // show up here instead of passing a hand-written list of field names.
    expect(JSON.stringify(config).split(secret)).toHaveLength(2);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts only loopback origins', () => {
    for (const origin of [
      'http://127.0.0.1:1420',
      'http://localhost:5173',
      'http://[::1]:8080',
      'https://localhost',
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1.evil.example',
      'http://notlocalhost',
      'null',
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
  });
});
