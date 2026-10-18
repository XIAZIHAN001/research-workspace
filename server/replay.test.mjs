import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeKnowledgeRequest, verifyKnowledgeSuggestions } from './knowledge.mjs';

/**
 * Phase 8.2: the Phase 8.1 live replies, replayed without a network.
 *
 * What is stored is the *verified* response, not the raw HTTP body: the live runner did not keep
 * the model's prose envelope. The accepted concepts and relations are copied verbatim from that
 * response; the evidence keeps only passageId and quote (the page was filled in by the server).
 * For the run that had a rejected quotation, the stored rejection code is reproduced by an empty
 * quote, so the drop path stays visible without inventing new content.
 *
 * These tests assert the protocol's rules, not one model's wording: counts, verbatim evidence,
 * page numbers, the multi-evidence shape, and a stable result on repeat.
 */

const FIXTURES = resolve(process.cwd(), 'server/providers/fixtures/phase8.1');

async function loadFixture(name) {
  return JSON.parse(await readFile(resolve(FIXTURES, name), 'utf8'));
}

function normalizedRequest(fixture) {
  const result = normalizeKnowledgeRequest({
    ...fixture.request,
    paper: { ...fixture.request.paper, pdfSha256: 'a'.repeat(64) },
    existingConcepts: fixture.request.existingConcepts ?? [],
    existingRelations: fixture.request.existingRelations ?? [],
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function replayRaw(fixture) {
  const reply = structuredClone(fixture.reply);
  if (fixture.reproducedRejection !== null) {
    const { relationIndex, quote } = fixture.reproducedRejection;
    reply.relations[relationIndex].evidence.push({
      passageId: 'selection',
      quote,
    });
  }
  return JSON.stringify(reply);
}

function replay(fixture) {
  return verifyKnowledgeSuggestions(replayRaw(fixture), normalizedRequest(fixture));
}

describe('Phase 8.1 live replies, replayed offline', () => {
  it('replays the six-concept, ten-relation output with its evidence intact', async () => {
    const fixture = await loadFixture('11-boundary-existing.json');
    const result = replay(fixture);

    expect(result.rulesVersion).toBe('k2');
    expect(result.status).toBe('valid');
    expect(result.groundedInText).toBe(true);
    expect(result.concepts).toHaveLength(6);
    expect(result.relations).toHaveLength(10);
    expect(result.rejected).toBe(0);
    expect(result.diagnostics.matchedExisting).toBe(0);
    // Each relation keeps at least one checked quotation, and several carry two.
    expect(result.relations.every((relation) => relation.evidence.length >= 1)).toBe(true);
    expect(
      result.relations.filter((relation) => relation.evidence.length === 2).length,
    ).toBeGreaterThanOrEqual(3);
    // Long technical names survive unchanged.
    expect(Math.max(...result.concepts.map((concept) => concept.name.length))).toBeGreaterThan(20);
    // Pages come from the passage records, not from the model.
    for (const relation of result.relations) {
      for (const entry of relation.evidence) {
        const passage = fixture.request.passages.find((item) => item.id === entry.passageId);
        expect(entry.page).toBe(passage.page);
      }
    }
  });

  it('replays the long Chinese names and keeps the stored rejection path', async () => {
    const fixture = await loadFixture('05-main-ts-method.json');
    const result = replay(fixture);

    expect(result.concepts).toHaveLength(6);
    expect(result.relations).toHaveLength(8);
    expect(result.rejected).toBe(1);
    expect(result.rejectedDetails[0]?.code).toBe('quote-shape');
    expect(result.warnings.some((warning) => warning.includes('不是所给原文中的逐字术语'))).toBe(
      true,
    );
    expect(result.concepts.some((concept) => concept.name.includes('（'))).toBe(true);
  });

  it('replays a relation grounded by two quotations from the same passage', async () => {
    const fixture = await loadFixture('12-boundary-repeat.json');
    const result = replay(fixture);

    expect(result.concepts).toHaveLength(6);
    expect(result.relations).toHaveLength(7);
    expect(result.rejected).toBe(0);
    const multi = result.relations.filter((relation) => relation.evidence.length === 2);
    expect(multi).toHaveLength(1);
    expect(multi[0]?.evidence.every((entry) => entry.passageId === 'selection')).toBe(true);
    expect(multi[0]?.evidence.every((entry) => entry.page === 2)).toBe(true);
  });

  it('is deterministic: replaying the same fixture twice gives the same result', async () => {
    for (const name of [
      '11-boundary-existing.json',
      '05-main-ts-method.json',
      '12-boundary-repeat.json',
    ]) {
      const fixture = await loadFixture(name);
      expect(JSON.stringify(replay(fixture))).toBe(JSON.stringify(replay(fixture)));
    }
  });

  it('keeps the fixture free of credentials and request-bookkeeping fields', async () => {
    for (const name of [
      '11-boundary-existing.json',
      '05-main-ts-method.json',
      '12-boundary-repeat.json',
    ]) {
      const raw = await readFile(resolve(FIXTURES, name), 'utf8');
      expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(raw).not.toMatch(/authorization|apiKey|proxy|instanceId/i);
      const fixture = JSON.parse(raw);
      expect(fixture.attribution.license).toBe('CC BY 4.0');
      expect(fixture.attribution.licenseUrl).toContain('creativecommons.org');
      expect(fixture.request.paper.pdfSha256).toBeUndefined();
    }
  });
});
