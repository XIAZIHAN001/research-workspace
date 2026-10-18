import { describe, expect, it } from 'vitest';
import { createReplayProvider, loadReplayFixtures } from './replay-provider.mjs';

/**
 * The replay provider is the only "model" the browser replay uses. These tests keep it honest:
 * it answers only knowledge requests, matches a fixture only when the reader's selection is
 * really the stored one, and never points a quotation at a passage id this run did not send.
 */

const fixtures = await loadReplayFixtures();
const provider = createReplayProvider(fixtures);

function call(fixture, overrides = {}) {
  return provider.complete({
    meta: {
      task: 'knowledge',
      focus: fixture.request.focus,
      passages: fixture.request.passages,
      existingConcepts: fixture.request.existingConcepts ?? [],
      ...overrides,
    },
  });
}

describe('the Phase 8.1 replay provider', () => {
  it('is offline and knows which paper/model the reply came from', () => {
    expect(provider.online).toBe(false);
    expect(provider.label).toContain('离线');
    expect(provider.model).toContain('phase8.1');
  });

  it('replays the stored reply for the matching selection', async () => {
    const fixture = fixtures.find((entry) => entry.file.startsWith('11-'));
    if (fixture === undefined) throw new Error('missing fixture');
    const outcome = await call(fixture);
    const reply = JSON.parse(outcome.text);
    expect(reply.concepts).toHaveLength(6);
    expect(reply.relations).toHaveLength(10);
    const sent = new Set(fixture.request.passages.map((passage) => passage.id));
    for (const record of [...reply.concepts, ...reply.relations]) {
      for (const evidence of record.evidence) {
        expect(sent.has(evidence.passageId)).toBe(true);
      }
    }
    expect(outcome.truncated).toBe(false);
    expect(outcome.finishReason).toBe('stop');
  });

  it('keeps the stored rejection reproduction in the 05 fixture', async () => {
    const fixture = fixtures.find((entry) => entry.file.startsWith('05-'));
    if (fixture === undefined) throw new Error('missing fixture');
    const reply = JSON.parse((await call(fixture)).text);
    expect(reply.relations[0].evidence.some((entry) => entry.quote === '')).toBe(true);
  });

  it('refuses a selection that is not the stored one instead of guessing', async () => {
    const fixture = fixtures[0];
    if (fixture === undefined) throw new Error('missing fixture');
    await expect(call(fixture, { focus: 'a different question entirely' })).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });

  it('refuses tasks other than knowledge analysis', async () => {
    const fixture = fixtures[0];
    if (fixture === undefined) throw new Error('missing fixture');
    await expect(call(fixture, { task: 'difficulty' })).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });
});
