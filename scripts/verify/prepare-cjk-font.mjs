import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Official Noto Sans CJK 2.004, pinned to the Sans2.004 tag's immutable commit.
// Upstream Git blob dc15562470b4f842321894787a0d066879ccff8b, 16,437,364 bytes.
// Source/license: https://github.com/notofonts/noto-cjk/tree/523d033d6cb47f4a80c58a35753646f5c3608a78
// This is a CI prerequisite only; no font binary is bundled with the application.
const FONT = Object.freeze({
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
  sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  size: 16_437_364,
});
const FAMILY = 'Noto Sans CJK SC';
const CHARACTERS = '工作区已暂停恢复备份新建项目中文验收';

function verifyCoverage(family, charset) {
  if (family !== FAMILY) throw new Error('CJK font family does not match the required local face');
  if (!charset?.trim()) throw new Error('CJK font glyph coverage is absent');
  const ranges = charset
    .trim()
    .split(/\s+/)
    .map((range) => {
      if (!/^[a-f\d]+(?:-[a-f\d]+)?$/i.test(range)) throw new Error('Invalid CJK font glyph range');
      return range.split('-').map((part) => Number.parseInt(part, 16));
    });
  const missing = Array.from(CHARACTERS).filter((character) => {
    const code = character.codePointAt(0);
    return !ranges.some(([start, end = start]) => code >= start && code <= end);
  });
  if (missing.length)
    throw new Error(`CJK font lacks required Chinese glyphs: ${missing.join('')}`);
}

export function prepareCjkFont({ font = FONT, env = process.env, run = execFileSync } = {}) {
  const directory = resolve(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'),
    'fonts/research-workspace-ci',
  );
  const file = join(directory, `NotoSansCJKsc-Regular-${font.sha256}.otf`);
  const staging = mkdtempSync(join(env.RUNNER_TEMP || env.TMPDIR || tmpdir(), 'rw-cjk-font-'));
  const download = join(staging, 'font.otf');
  let installedIdentity;
  const command = (name, args, timeout = 15_000) => {
    try {
      return run(name, args, {
        encoding: 'utf8',
        env,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Do not log child stderr, environment or proxy/auth details. The command and
      // timeout/exit status suffice to identify this prerequisite's failing stage.
      if (error.code === 'ETIMEDOUT')
        throw new Error(`${name} timed out after ${timeout} ms`, { cause: error });
      throw new Error(
        `${name} failed (${error.code === 'ENOENT' ? 'required tool missing' : `exit ${error.status ?? 'unknown'}`})`,
        { cause: error },
      );
    }
  };
  try {
    command(
      'curl',
      [
        '--disable',
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '10',
        '--max-time',
        '60',
        '--retry',
        '2',
        '--retry-delay',
        '2',
        '--retry-max-time',
        '150',
        '--max-filesize',
        String(font.size),
        '--output',
        download,
        font.url,
      ],
      180_000,
    );
    if (statSync(download).size !== font.size) throw new Error('CJK font download size mismatch');
    const sha256 = createHash('sha256').update(readFileSync(download)).digest('hex');
    if (sha256 !== font.sha256) throw new Error('CJK font download checksum mismatch');
    // Never parse or install network bytes until both size and SHA256 match the pin.
    const [scannedFamily, scannedCharset] = command('fc-scan', [
      '-f',
      '%{family}\n%{charset}\n',
      download,
    ]).split('\n');
    verifyCoverage(scannedFamily, scannedCharset);
    const existingDirectory = lstatSync(directory, { throwIfNoEntry: false });
    if (existingDirectory && !existingDirectory.isDirectory())
      throw new Error('CJK font destination directory is not a regular directory');
    mkdirSync(directory, { recursive: true });
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing) {
      if (
        !existing.isFile() ||
        existing.size !== font.size ||
        createHash('sha256').update(readFileSync(file)).digest('hex') !== font.sha256
      )
        throw new Error(
          'CJK font destination already exists with unexpected content or a symbolic link',
        );
    } else {
      // Exclusive copy also refuses a destination created between the check and copy.
      copyFileSync(download, file, constants.COPYFILE_EXCL);
      installedIdentity = lstatSync(file);
    }
    command('fc-cache', ['-f', directory]);
    const [family, matchedFile, charset] = command('fc-match', [
      '-f',
      '%{family}\n%{file}\n%{charset}\n',
      `${FAMILY}:lang=zh-cn`,
    ]).split('\n');
    verifyCoverage(family, charset);
    if (matchedFile !== file)
      throw new Error('Fontconfig matched a different file from the verified CJK font');
    return {
      family,
      file,
      sha256,
      size: font.size,
      source: font.url,
      verifiedCharacters: CHARACTERS,
    };
  } catch (error) {
    // Roll back only an unchanged file created by this invocation. Never remove a
    // pre-existing identical font, a replacement inode or a substituted symbolic link.
    const current = installedIdentity && lstatSync(file, { throwIfNoEntry: false });
    if (
      current?.isFile() &&
      current.dev === installedIdentity.dev &&
      current.ino === installedIdentity.ino &&
      current.size === font.size &&
      createHash('sha256').update(readFileSync(file)).digest('hex') === font.sha256
    )
      rmSync(file);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(prepareCjkFont(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`CJK font preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
