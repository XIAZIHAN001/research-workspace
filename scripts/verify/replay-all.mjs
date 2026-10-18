/**
 * Phase 8.2: replay all twelve Phase 8.1 live responses through the current verifier.
 *
 * Zero network calls, zero model calls. The stored file contains the service's verified response,
 * not the raw HTTP body; this script reconstructs the model-shaped reply (names, quotations,
 * support, explanation) and runs it through `verifyKnowledgeSuggestions` against the original
 * request. Differences are expected where Phase 8.2 deliberately tightened a rule — a short
 * context is now capped — and are reported rather than hidden.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeKnowledgeRequest, verifyKnowledgeSuggestions } from '../../server/knowledge.mjs';

const DIR = resolve(process.cwd(), '.cache/verify/phase8.1-live/live/responses');
const OUT = resolve(process.cwd(), '.cache/verify/phase8.2-replay-all.json');

function modelReply(response) {
  return {
    groundedInText: response.groundedInText,
    concepts: response.concepts.map((concept) => ({
      name: concept.name,
      aliases: concept.aliases,
      summary: concept.summary,
      support: concept.support,
      evidence: concept.evidence.map(({ passageId, quote }) => ({ passageId, quote })),
    })),
    relations: response.relations.map((relation) => ({
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      direction: relation.direction,
      support: relation.support,
      explanation: relation.explanation,
      evidence: relation.evidence.map(({ passageId, quote }) => ({ passageId, quote })),
    })),
  };
}

function checkInvariants(name, stored, request, result) {
  const problems = [];
  const passageById = new Map(request.passages.map((passage) => [passage.id, passage]));
  for (const concept of result.concepts) {
    if (concept.evidence.length > 3) problems.push(`${name}: concept evidence > 3`);
    for (const entry of concept.evidence) {
      const passage = passageById.get(entry.passageId);
      if (passage === undefined) problems.push(`${name}: evidence points at a passage not sent`);
      else if (entry.page !== passage.page) problems.push(`${name}: evidence page mismatch`);
    }
  }
  const edges = new Set();
  for (const relation of result.relations) {
    const key = `${relation.from}|${relation.to}|${relation.kind}`;
    if (edges.has(key)) problems.push(`${name}: duplicate relation ${key}`);
    edges.add(key);
    for (const entry of relation.evidence) {
      const passage = passageById.get(entry.passageId);
      if (passage === undefined) problems.push(`${name}: relation evidence not in a sent passage`);
      else if (entry.page !== passage.page)
        problems.push(`${name}: relation evidence page mismatch`);
    }
  }
  if (result.diagnostics.smallContext) {
    if (result.concepts.length > 3) problems.push(`${name}: small context kept > 3 concepts`);
    if (result.relations.length > 3) problems.push(`${name}: small context kept > 3 relations`);
  }
  if (!result.diagnostics.smallContext && stored.rejected === 0 && result.rejected !== 0) {
    problems.push(`${name}: reconstructed reply produced unexpected rejections`);
  }
  return problems;
}

const files = (await readdir(DIR)).filter((file) => /^\d+-.*\.json$/.test(file)).sort();

const rows = [];
const problems = [];
for (const file of files) {
  const stored = JSON.parse(await readFile(resolve(DIR, file), 'utf8'));
  const request = normalizeKnowledgeRequest({
    ...stored.request,
    paper: { ...stored.request.paper, pdfSha256: 'a'.repeat(64) },
    existingConcepts: stored.request.existingConcepts ?? [],
    existingRelations: stored.request.existingRelations ?? [],
  });
  if (!request.ok) {
    problems.push(`${file}: request no longer normalises: ${request.message}`);
    continue;
  }
  const result = verifyKnowledgeSuggestions(
    JSON.stringify(modelReply(stored.response)),
    request.value,
  );
  const row = {
    file,
    scenario: stored.scenario,
    contextChars: request.value.passages.reduce((sum, passage) => sum + passage.text.length, 0),
    storedConcepts: stored.response.concepts.length,
    storedRelations: stored.response.relations.length,
    replayedConcepts: result.concepts.length,
    replayedRelations: result.relations.length,
    smallContext: result.diagnostics.smallContext,
    nameNotVerbatim: result.diagnostics.nameNotVerbatim,
    rejected: result.rejected,
    evidence: result.diagnostics.evidenceKept,
    status: result.status,
  };
  rows.push(row);
  problems.push(...checkInvariants(file, stored.response, request.value, result));
}

const summary = {
  generatedAt: new Date().toISOString(),
  files: files.length,
  smallContext: rows.filter((row) => row.smallContext).length,
  problems,
  rows,
};
await writeFile(OUT, `${JSON.stringify(summary, null, 2)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.file.padEnd(28)} context ${String(row.contextChars).padStart(5)}  ` +
      `concepts ${String(row.storedConcepts)}→${String(row.replayedConcepts)}  ` +
      `relations ${String(row.storedRelations)}→${String(row.replayedRelations)}  ` +
      `evidence ${String(row.evidence)}  ${row.smallContext ? 'small-context cap' : ''}\n`,
  );
}
process.stdout.write(
  `\n${String(files.length)} stored responses replayed; ${String(problems.length)} invariant problem(s).\n`,
);
process.stdout.write(`report: ${OUT}\n`);
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`PROBLEM ${problem}\n`);
  process.exitCode = 1;
}
