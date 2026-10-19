/**
 * A read-only inventory of the data Phase 9 and 10 left in the installed application.
 *
 * This does not delete, rename or rewrite anything. It exists so that a cleanup decision can
 * be made from facts: which projects look like acceptance fixtures, which papers and
 * annotations they share with other projects, and whether removing a project would leave
 * concepts or relations behind.
 *
 * The classification is heuristic and printed as such. A project is only *suspected* to be a
 * test fixture; nothing here treats that as permission to remove it.
 */

/* global window */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = join(ROOT, 'docs', 'phase11-cleanup-inventory.json');

function findExe() {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.RW_DESKTOP_EXE,
    join(local, 'Research Workspace', 'research-workspace.exe'),
    'D:\\Research Workspace\\research-workspace.exe',
    join(ROOT, 'src-tauri', 'target', 'release', 'research-workspace.exe'),
  ]
    .filter((value) => value !== undefined && value !== '')
    .find((candidate) => existsSync(candidate));
}

async function freePort() {
  const { createServer } = await import('node:http');
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function connect(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
      const context = browser.contexts()[0];
      if (context !== undefined) {
        const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 8000 }));
        await page.locator('.app').waitFor({ timeout: 20_000 });
        return { browser, page };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error('could not connect to the app over CDP');
}

function closeApp(child) {
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${String(child.pid)} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() | Out-Null }`,
      ],
      { windowsHide: true },
    );
  } catch {
    // Already gone.
  }
}

const TEST_NAME = /(验收|测试|Phase\s*\d|真实精读|演示)/i;

async function main() {
  const exe = findExe();
  if (exe === null) throw new Error('找不到已安装的桌面应用；请先安装或设置 RW_DESKTOP_EXE。');
  const port = await freePort();
  const child = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(port)}`,
    },
    stdio: 'ignore',
  });
  let browser = null;
  try {
    const connected = await connect(port);
    browser = connected.browser;
    const page = connected.page;
    const inventory = await page.evaluate((patternSource) => {
      const fixturePattern = new RegExp(patternSource, 'i');
      const parse = (key) => {
        try {
          return JSON.parse(window.localStorage.getItem(key) ?? 'null');
        } catch {
          return null;
        }
      };
      const projectsState = parse('rw.projects');
      const knowledge = parse('rw.knowledge');
      const projects = Array.isArray(projectsState?.projects) ? projectsState.projects : [];
      const papers = projectsState?.papers ?? {};
      const annotations = Array.isArray(projectsState?.annotations)
        ? projectsState.annotations
        : [];
      const concepts = Array.isArray(knowledge?.concepts) ? knowledge.concepts : [];
      const evidence = Array.isArray(knowledge?.evidence) ? knowledge.evidence : [];
      const relations = Array.isArray(knowledge?.relations) ? knowledge.relations : [];

      const paperUsage = new Map();
      for (const project of projects) {
        const paperIds = [project.corePaperId, ...(project.relatedPaperIds ?? [])];
        for (const paperId of paperIds) {
          paperUsage.set(paperId, (paperUsage.get(paperId) ?? 0) + 1);
        }
      }
      const annotationCountByHash = new Map();
      for (const annotation of annotations) {
        annotationCountByHash.set(
          annotation.pdfSha256,
          (annotationCountByHash.get(annotation.pdfSha256) ?? 0) + 1,
        );
      }
      const conceptIdsByPaper = new Map();
      for (const item of evidence) {
        const list = conceptIdsByPaper.get(item.paperId) ?? new Set();
        list.add(item.conceptId);
        conceptIdsByPaper.set(item.paperId, list);
      }

      return {
        schema: projectsState?.version ?? null,
        knowledgeVersion: knowledge?.version ?? null,
        projects: projects.map((project) => {
          const paperIds = [project.corePaperId, ...(project.relatedPaperIds ?? [])];
          return {
            id: project.id,
            name: project.name,
            updatedAt: project.updatedAt ?? null,
            paperIds,
            papers: paperIds.map((paperId) => ({
              id: paperId,
              title: papers[paperId]?.title ?? '(未知论文)',
              pdfSha256: papers[paperId]?.pdf?.sha256 ?? null,
              sharedWithProjects: paperUsage.get(paperId) ?? 0,
              annotations: annotationCountByHash.get(papers[paperId]?.pdf?.sha256 ?? '') ?? 0,
              concepts: [...(conceptIdsByPaper.get(paperId) ?? [])].length,
            })),
            suspectedTestFixture: fixturePattern.test(project.name),
          };
        }),
        totals: {
          projects: projects.length,
          papers: Object.keys(papers).length,
          annotations: annotations.length,
          concepts: concepts.length,
          relations: relations.length,
        },
      };
    }, TEST_NAME.source);

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

    const suspected = inventory.projects.filter((project) => project.suspectedTestFixture);
    process.stdout.write(`只读清单：${OUTPUT}\n`);
    process.stdout.write(
      `项目 ${String(inventory.totals.projects)}、论文 ${String(inventory.totals.papers)}、笔记 ${String(inventory.totals.annotations)}、概念 ${String(inventory.totals.concepts)}、关系 ${String(inventory.totals.relations)}\n`,
    );
    process.stdout.write(`疑似验收数据 ${String(suspected.length)} 个项目（仅供确认，未删除）：\n`);
    for (const project of suspected) {
      const shared = project.papers.filter((paper) => paper.sharedWithProjects > 1);
      const leftovers = project.papers.filter(
        (paper) => paper.annotations > 0 || paper.concepts > 0,
      );
      process.stdout.write(
        `- ${project.name}：论文 ${String(project.papers.length)}；` +
          `共享论文 ${String(shared.length)}；带批注或概念 ${String(leftovers.length)}\n`,
      );
    }
    process.stdout.write('没有删除、清空或重建任何数据。\n');
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    closeApp(child);
    await Promise.race([once(child, 'exit'), sleep(8000)]);
  }
}

await main();
