/**
 * Assembles the runtime the desktop shell ships but does not commit.
 *
 * The sidecar is two things: a Node runtime (`process.execPath`, so the version that built and
 * tested the service is the version that runs on the target machine) and the service sources.
 * Both are copied into `src-tauri/sidecar/`, which is generated and ignored by Git.
 *
 * On a cross-build the runtime must match the target, not the build host. Run this script on
 * Windows before a Windows bundle — including when the Rust compilation happens in WSL — so the
 * bundled `rw-node.exe` is the Windows executable. The manifest records exactly which runtime
 * was shipped, which is what the Phase 10 report cites.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverSource = join(root, 'server');
const sidecarDir = join(root, 'src-tauri', 'sidecar');
const runtimeTarget = join(sidecarDir, 'rw-node.exe');

/** Tests and test-only helpers are not part of the shipped service. */
function shouldCopy(source) {
  const name = basename(source);
  if (name.endsWith('.test.mjs')) return false;
  if (name === 'README.md' || name === 'testing.mjs') return false;
  return true;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  await rm(sidecarDir, { recursive: true, force: true });
  await mkdir(sidecarDir, { recursive: true });

  await copyFile(process.execPath, runtimeTarget);
  // Linux bundle resources need the executable bit; copyFile does not guarantee it.
  if (process.platform !== 'win32') await chmod(runtimeTarget, 0o755);
  await cp(serverSource, join(sidecarDir, 'server'), {
    recursive: true,
    filter: shouldCopy,
  });

  const runtimeInfo = await stat(runtimeTarget);
  const manifest = {
    generatedAt: new Date().toISOString(),
    runtime: {
      source: process.execPath,
      target: relative(root, runtimeTarget),
      bytes: runtimeInfo.size,
      sha256: await sha256(runtimeTarget),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    server: {
      source: relative(root, serverSource),
      files: ['desktop.mjs', 'index.mjs', 'config.mjs', 'guards.mjs', 'log.mjs', 'providers'],
    },
  };
  await writeFile(
    join(sidecarDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  process.stdout.write(
    `[desktop] sidecar prepared: ${manifest.runtime.target} (${(runtimeInfo.size / 1024 / 1024).toFixed(1)} MB, ${process.version}, ${process.platform}/${process.arch})\n`,
  );
}

await main();
