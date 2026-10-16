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
    expect(readConfig({ AI_TIMEOUT_MS: '10' }).timeoutMs).toBe(60_000);
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
