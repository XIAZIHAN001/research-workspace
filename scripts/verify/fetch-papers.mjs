/**
 * Fetches the real papers the verification runs measure.
 *
 * They are downloaded once into `.cache/papers/`, which is ignored by Git, so no third party's
 * paper is ever committed to this repository. Each one is checked against its licence before it
 * is kept: only Creative Commons papers are downloaded, and the licence that arXiv reports for
 * the version is re-read afterwards and printed, so the claim in the report can be checked.
 *
 * Usage: node scripts/verify/fetch-papers.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const DIR = new URL('.cache/papers/', ROOT);

/** arXiv ids known to be offered under a Creative Commons licence. */
const IDS = ['2610.22294', '2610.22350'];

/** Licences we are willing to store a copy of. */
const ACCEPTED = /creativecommons\.org\/licenses\/(by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)\//;

const AGENT = 'research-workspace/0.0.1 (local reading app; compatibility check)';

async function licenceOf(id) {
  const response = await fetch(`https://arxiv.org/abs/${id}`, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) return null;
  const html = await response.text();
  return ACCEPTED.exec(html)?.[0] ?? null;
}

await mkdir(fileURLToPath(DIR), { recursive: true });

for (const id of IDS) {
  const licence = await licenceOf(id);
  if (licence === null) {
    process.stdout.write(
      `SKIP  ${id}: arXiv does not offer this under a Creative Commons licence\n`,
    );
    continue;
  }
  const response = await fetch(`https://arxiv.org/pdf/${id}`, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) {
    process.stdout.write(`FAIL  ${id}: HTTP ${String(response.status)}\n`);
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    process.stdout.write(`FAIL  ${id}: the response is not a PDF\n`);
    continue;
  }
  await writeFile(fileURLToPath(new URL(`${id}.pdf`, DIR)), bytes);
  process.stdout.write(
    `OK    ${id}: ${String(Math.round(bytes.length / 1024))} KB, ${licence.replace('creativecommons.org/licenses/', 'CC ')}\n`,
  );
}

process.stdout.write('\nKept in .cache/papers/ — ignored by Git, never committed.\n');
