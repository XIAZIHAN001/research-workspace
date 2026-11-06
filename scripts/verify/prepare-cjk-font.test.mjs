import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'vitest';
import * as helper from './prepare-cjk-font.mjs';

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Curl and fontconfig are external boundaries. The real helper still hashes, validates,
// installs and cleans files; the three-byte fixture never pretends to be a real font.
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rw-font-test-'));
  fixtures.push(root);
  const target = join(
    root,
    'data/fonts/research-workspace-ci/NotoSansCJKsc-Regular-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.otf',
  );
  const commands = [];
  const font = {
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/fixture/font.otf',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    size: 3,
  };
  const run = (command, args, settings) => {
    commands.push({ command, args, settings });
    if (options.fail === command)
      throw Object.assign(new Error('private proxy credentials must not be logged'), {
        code: 'ETIMEDOUT',
      });
    if (command === 'curl') {
      writeFileSync(args[args.indexOf('--output') + 1], options.bytes ?? 'abc');
      return '';
    }
    if (command === 'fc-scan') return options.scan ?? 'Noto Sans CJK SC\n20-7e 4e00-9fff\n';
    if (command === 'fc-cache') return '';
    if (command === 'fc-match')
      return options.match?.(target) ?? `Noto Sans CJK SC\n${target}\n20-7e 4e00-9fff\n`;
    throw new Error(`Unexpected command: ${command}`);
  };
  return {
    root,
    target,
    commands,
    prepare() {
      assert.equal(typeof helper.prepareCjkFont, 'function', 'font preparation helper is required');
      return helper.prepareCjkFont({
        font,
        env: { HOME: root, XDG_DATA_HOME: join(root, 'data'), TMPDIR: root },
        run,
      });
    },
  };
}

test('installs verified bytes in the user font directory with bounded HTTPS-only commands', () => {
  const f = fixture();
  const evidence = f.prepare();
  assert.equal(readFileSync(f.target, 'utf8'), 'abc');
  assert.equal(evidence.file, f.target);
  assert.equal(evidence.family, 'Noto Sans CJK SC');
  assert.equal(evidence.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(evidence.verifiedCharacters.includes('工'));
  assert.deepEqual(
    f.commands.map(({ command }) => command),
    ['curl', 'fc-scan', 'fc-cache', 'fc-match'],
  );
  const curl = f.commands[0];
  assert.equal(
    curl.args[0],
    '--disable',
    'ignore ambient curl configuration before all other options',
  );
  for (const flag of ['--fail', '--silent', '--show-error']) assert.ok(curl.args.includes(flag));
  for (const flag of ['--proto', '--proto-redir'])
    assert.equal(curl.args[curl.args.indexOf(flag) + 1], '=https');
  for (const flag of ['--connect-timeout', '--max-time', '--retry-max-time']) {
    assert.ok(curl.args.includes(flag));
    const seconds = Number(curl.args[curl.args.indexOf(flag) + 1]);
    assert.ok(seconds > 0 && seconds <= 150);
  }
  const retries = Number(curl.args[curl.args.indexOf('--retry') + 1]);
  assert.ok(retries >= 0 && retries <= 2);
  assert.ok(!curl.args.includes('--insecure'));
  assert.ok(
    f.commands.every(({ settings }) => settings.timeout > 0 && settings.timeout <= 180_000),
  );
  assert.ok(f.commands.every(({ settings }) => settings.killSignal === 'SIGKILL'));
  assert.deepEqual(readdirSync(f.root), ['data']);
});

test('rejects a same-length checksum mismatch before fontconfig or installation', () => {
  const f = fixture({ bytes: 'abd' });
  assert.throws(() => f.prepare(), /checksum/i);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(
    f.commands.map(({ command }) => command),
    ['curl'],
  );
  assert.deepEqual(readdirSync(f.root), []);
});

test('rejects truncated downloads before fontconfig or installation', () => {
  const f = fixture({ bytes: 'ab' });
  assert.throws(() => f.prepare(), /size/i);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(readdirSync(f.root), []);
});

test('a failed or timed out download fails closed and leaves no staged file', () => {
  const f = fixture({ fail: 'curl' });
  assert.throws(() => f.prepare(), /curl timed out/);
  assert.equal(existsSync(f.target), false);
  assert.deepEqual(readdirSync(f.root), []);
});

test('rejects a wrong font family even if its advertised charset covers Chinese', () => {
  const f = fixture({ scan: 'DejaVu Sans\n20-7e 4e00-9fff\n' });
  assert.throws(() => f.prepare(), /family/i);
  assert.equal(existsSync(f.target), false);
});

test('rejects an expected font name with no actual Chinese glyph coverage', () => {
  const f = fixture({ scan: 'Noto Sans CJK SC\n20-7e\n' });
  assert.throws(() => f.prepare(), /glyph/i);
  assert.equal(existsSync(f.target), false);
});

test('fails rather than accepting a fontconfig fallback or wrong file', () => {
  for (const match of [
    () => 'DejaVu Sans\n/tmp/fallback.ttf\n20-7e 4e00-9fff\n',
    () => 'Noto Sans CJK SC\n/tmp/another-font.otf\n20-7e 4e00-9fff\n',
    (target) => `Noto Sans CJK SC\n${target}\n20-7e\n`,
  ]) {
    const f = fixture({ match });
    assert.throws(() => f.prepare(), /family|file|glyph/i);
    assert.equal(existsSync(f.target), false);
    assert.deepEqual(readdirSync(f.root), ['data']);
  }
});

test('does not report success when cache refresh or font inspection fails', () => {
  for (const command of ['fc-scan', 'fc-cache', 'fc-match']) {
    const f = fixture({ fail: command });
    assert.throws(() => f.prepare(), new RegExp(`${command} timed out`));
    assert.equal(existsSync(f.target), false);
    assert.ok(readdirSync(f.root).every((entry) => entry === 'data'));
  }
});

test('reuses only identical verified bytes at a hash-qualified destination', () => {
  const f = fixture();
  mkdirSync(dirname(f.target), { recursive: true });
  writeFileSync(f.target, 'abc');
  assert.equal(f.prepare().file, f.target);
  assert.equal(readFileSync(f.target, 'utf8'), 'abc');
});

test('does not overwrite unexpected existing destination content', () => {
  const f = fixture();
  mkdirSync(dirname(f.target), { recursive: true });
  writeFileSync(f.target, 'unrelated existing font');
  assert.throws(() => f.prepare(), /existing|destination/i);
  assert.equal(readFileSync(f.target, 'utf8'), 'unrelated existing font');
  assert.ok(!f.commands.some(({ command }) => command === 'fc-cache'));
});

test.skipIf(process.platform === 'win32')(
  'rejects a symbolic-link destination even when it points to identical bytes',
  () => {
    const f = fixture();
    const unrelated = join(f.root, 'unrelated.otf');
    mkdirSync(dirname(f.target), { recursive: true });
    writeFileSync(unrelated, 'abc');
    symlinkSync(unrelated, f.target);
    assert.throws(() => f.prepare(), /destination|symbolic/i);
    assert.equal(readFileSync(unrelated, 'utf8'), 'abc');
    assert.ok(!f.commands.some(({ command }) => command === 'fc-cache'));
  },
);

test('failed fontconfig validation retains a pre-existing identical font', () => {
  const f = fixture({ fail: 'fc-cache' });
  mkdirSync(dirname(f.target), { recursive: true });
  writeFileSync(f.target, 'abc');
  assert.throws(() => f.prepare(), /fc-cache timed out/);
  assert.equal(readFileSync(f.target, 'utf8'), 'abc');
});
