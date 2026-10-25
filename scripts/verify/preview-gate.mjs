import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Shared guard for every gate that serves `vite preview`.
 *
 * A preview gate is only evidence when it serves the sources it claims to. A stale dist once
 * let a design change pass a check it had actually inverted (PR #2 review): the gate ran
 * against a build older than the code and verified yesterday's interface. From now on every
 * preview gate refuses to start when dist is older than the newest source file, with a message
 * that says what to do about it.
 *
 * Usage: `assertFreshBuild(import.meta.url)` immediately before `startPreview()`.
 */
export function assertFreshBuild(gateUrl) {
  const root = fileURLToPath(new URL('../..', gateUrl));
  const distIndex = join(root, 'dist', 'index.html');
  const distMtime = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
  const newest = (dir) => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }
    return latest;
  };
  const srcNewest = newest(join(root, 'src'));
  if (distMtime < srcNewest) {
    throw new Error(
      'dist/ 比最新源码旧：本门禁服务生产构建，请先 npm run build 再跑（否则验证的是旧界面）。',
    );
  }
}
