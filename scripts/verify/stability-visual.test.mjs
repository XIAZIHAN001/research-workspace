import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve('scripts/verify/stability.mjs'), 'utf8');
const expectedText = '工作区已暂停';
const platformFont = {
  familyName: 'Noto Sans CJK SC',
  postScriptName: 'NotoSansCJKsc-Bold',
  isCustomFont: false,
  glyphCount: 6,
};
const fontconfigOutput = [
  platformFont.familyName,
  platformFont.postScriptName,
  '/synthetic/NotoSansCJK-Bold.ttc',
  '2',
  '4f5c 505c 533a 5de5 5df2 6682',
].join('\n');

// The executable acceptance script has top-level browser startup. Evaluate only its actual
// isolated diagnostic function, never import/launch the browser or install fonts in unit tests.
function probeFixture(options = {}) {
  const match = source.match(
    /async function inspectChinesePlatformFonts\(page, timeoutMs = 5000\) \{[\s\S]*?\n\}\n(?=\nasync function visualEnvironmentProbe)/,
  );
  expect(match, 'the bounded real-element font diagnostic must exist').not.toBeNull();
  const execFileSync = vi.fn(() => {
    options.onCommand?.();
    return options.fontconfig ?? fontconfigOutput;
  });
  const probe = vm.runInNewContext(`(${match[0]})`, {
    execFileSync,
    setTimeout,
    clearTimeout,
    performance: options.clock ?? performance,
  });
  const session = {
    send: vi.fn(async (method) => {
      if (options.pending) return new Promise(() => {});
      if (options.cdpError) throw new Error(options.cdpError);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: options.nodeId ?? 2 };
      if (method === 'CSS.getPlatformFontsForNode') {
        options.beforeFonts?.();
        return { fonts: options.fonts ?? [platformFont] };
      }
      return {};
    }),
    detach: vi.fn(() => (options.detachPending ? new Promise(() => {}) : Promise.resolve())),
  };
  const page = {
    locator: vi.fn(() => ({
      evaluate: vi.fn(async () => ({
        text: options.text ?? expectedText,
        cssFontFamily: 'system-ui, sans-serif',
        viewport: { width: 1440, height: 950 },
      })),
    })),
    context: () => ({ newCDPSession: vi.fn(async () => session) }),
  };
  return { probe, page, session, execFileSync };
}

afterEach(() => vi.useRealTimers());

describe('Chinese visual environment diagnostic', () => {
  it('reports the actual local platform font and checks every sample glyph against its fontconfig face', async () => {
    const { probe, page, session, execFileSync } = probeFixture();
    const result = await probe(page);
    expect(result.status).toBe('passed');
    expect(result.text).toBe(expectedText);
    expect(result.fonts).toEqual([platformFont]);
    expect(result.coverage[0]).toMatchObject({
      postScriptName: platformFont.postScriptName,
      file: '/synthetic/NotoSansCJK-Bold.ttc',
      missing: [],
    });
    expect(session.send).toHaveBeenCalledWith('CSS.getPlatformFontsForNode', { nodeId: 2 });
    expect(execFileSync).toHaveBeenCalledWith(
      'fc-match',
      expect.arrayContaining(['Noto Sans CJK SC:postscriptname=NotoSansCJKsc-Bold']),
      expect.objectContaining({ timeout: 2000 }),
    );
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it.each([
    ['no rendered glyphs', []],
    ['Latin fallback/tofu', [{ ...platformFont, familyName: 'DejaVu Sans' }]],
    ['missing rendered glyph', [{ ...platformFont, glyphCount: 5 }]],
    ['invalid glyph count', [{ ...platformFont, glyphCount: 6.5 }]],
    ['downloaded font', [{ ...platformFont, isCustomFont: true }]],
  ])('fails clearly for %s instead of accepting a font-name claim', async (_, fonts) => {
    const { probe, page } = probeFixture({ fonts });
    const result = await probe(page);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Visual environment gap/);
    expect(result.fonts).toEqual(fonts);
  });

  it.each([
    ['wrong actual element text', { text: 'Different heading' }],
    ['missing DOM node', { nodeId: 0 }],
    ['unsupported CDP method', { cdpError: 'synthetic unsupported CSS method' }],
    [
      'fontconfig substituted a different face',
      { fontconfig: fontconfigOutput.replace('NotoSansCJKsc-Bold', 'Other-Font') },
    ],
    ['font face missing a Chinese glyph', { fontconfig: fontconfigOutput.replace('5de5 ', '') }],
  ])('preserves diagnostic failure for %s', async (_, options) => {
    const { probe, page } = probeFixture(options);
    const result = await probe(page);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Visual environment gap/);
  });

  it('bounds a pending CDP command and retains partial evidence', async () => {
    vi.useFakeTimers();
    const { probe, page, session } = probeFixture({ pending: true });
    const operation = probe(page, 50);
    await vi.advanceTimersByTimeAsync(50);
    const result = await operation;
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Visual environment gap.*timed out/);
    expect(result.text).toBe(expectedText);
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it('does not hang on diagnostic-session detach', async () => {
    const { probe, page } = probeFixture({ detachPending: true });
    expect((await probe(page)).status).toBe('passed');
  });

  it('fails when synchronous font inspection crosses the deadline before the timer can run', async () => {
    let now = 0;
    const { probe, page } = probeFixture({
      clock: { now: () => now },
      onCommand: () => {
        now = 80;
      },
    });
    const result = await probe(page, 20);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Visual environment gap.*timed out/);
  });

  it('caps the synchronous subprocess timeout to the budget left after CDP work', async () => {
    let now = 0;
    const { probe, page, execFileSync } = probeFixture({
      clock: { now: () => now },
      beforeFonts: () => {
        now = 4000;
      },
      onCommand: () => {
        now = 4500;
      },
    });
    expect((await probe(page, 5000)).status).toBe('passed');
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(execFileSync.mock.calls[0][2].timeout).toBe(1000);
  });
});

describe('persistent crash acceptance invariant', () => {
  it('keeps success, exact workspace read and SIGKILL adjacent with no font or viewport work between them', () => {
    const crash = source.slice(source.indexOf('async function crashPersistence()'));
    const start = crash.indexOf("await dialog.locator('.backup-message.is-success').waitFor();");
    const end = crash.indexOf('await killPersistent(instance);', start);
    expect(crash.slice(start, end).trim()).toBe(
      "await dialog.locator('.backup-message.is-success').waitFor();\n      const before = await workspaceState(page);",
    );
    expect(crash).toContain('assert.deepEqual(await workspaceState(page), before);');
  });

  it('sets both persistent pages to desktop size before navigating or restoring', () => {
    const crash = source.slice(
      source.indexOf('async function crashPersistence()'),
      source.indexOf('\nfunction trackChromium'),
    );
    expect(
      crash.match(/await page\.setViewportSize\(\{ width: 1440, height: 950 \}\);/g),
    ).toHaveLength(2);
    expect(crash).toContain(
      'await page.setViewportSize({ width: 1440, height: 950 });\n      await page.goto(origin);',
    );
    expect(crash).toContain(
      'await page.setViewportSize({ width: 1440, height: 950 });\n      await page.goto(`${origin}/__fixture`);',
    );
  });
});
