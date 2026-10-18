/**
 * A zero-cost provider that replays the Phase 8.1 live responses.
 *
 * It is not part of the app's provider list: only the verification script constructs it, and
 * `server/index.mjs` receives it through the same injection point the tests use. It answers
 * knowledge requests only — an ask or difficulty request is refused rather than answered with
 * something that was never a model reply. `online: false` tells the interface and the plan that
 * nothing leaves the machine and nothing is billed.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProviderError } from '../../server/errors.mjs';

const FIXTURE_DIR = resolve(process.cwd(), 'server/providers/fixtures/phase8.1');
const FILES = ['11-boundary-existing.json', '05-main-ts-method.json', '12-boundary-repeat.json'];

export async function loadReplayFixtures() {
  const fixtures = [];
  for (const file of FILES) {
    const fixture = JSON.parse(await readFile(resolve(FIXTURE_DIR, file), 'utf8'));
    fixtures.push({ ...fixture, file });
  }
  return fixtures;
}

function rawReply(fixture, passages) {
  const reply = structuredClone(fixture.reply);
  const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ');
  const keep = (entry) => {
    // The live request used ids like `selection` / `ctx-1`; the app's retrieval plan names its
    // segments `s1`, `s2`, … A stored quotation still names the text it came from, so the id is
    // resolved by finding the passage that actually contains it. If this run's plan did not send
    // that text, the quotation is left out rather than pointed at a made-up id: an id that was
    // never sent would only add noise to the rejection list.
    const quote = normalize(entry.quote);
    const found = passages.find((passage) => normalize(passage.text).includes(quote));
    if (process.env.REPLAY_DEBUG === '1') {
      console.error(
        `[replay] ${found === undefined ? 'MISS' : `hit ${found.id}`} ${quote.slice(0, 50)}`,
      );
    }
    if (found === undefined) return false;
    entry.passageId = found.id;
    return true;
  };
  for (const concept of reply.concepts) {
    concept.evidence = concept.evidence.filter(keep);
  }
  for (const relation of reply.relations) {
    relation.evidence = relation.evidence.filter(keep);
  }
  if (fixture.reproducedRejection !== null) {
    const { relationIndex, quote } = fixture.reproducedRejection;
    const selection = passages.find((entry) => entry.selection) ?? passages[0];
    if (selection !== undefined) {
      reply.relations[relationIndex].evidence.push({ passageId: selection.id, quote });
    }
  }
  return JSON.stringify(reply);
}

export function createReplayProvider(fixtures) {
  return {
    name: 'replay',
    model: 'deepseek-flash@phase8.1',
    label: 'Phase 8.1 真实响应回放（离线，无费用）',
    reasoning: null,
    online: false,

    async complete({ meta }) {
      if (meta.task !== 'knowledge') {
        throw new ProviderError('invalid-request', '回放提供方只回答知识分析请求。');
      }
      const passages = Array.isArray(meta.passages) ? meta.passages : [];
      if (process.env.REPLAY_DEBUG === '1') {
        console.error(
          `[replay] passages ${passages
            .map((entry) => `${entry.id}:p${String(entry.page)}:${String(entry.text.length)}`)
            .join(', ')}`,
        );
      }
      const selection = String(passages.find((entry) => entry.selection)?.text ?? '');
      const focus = String(meta.focus ?? '');
      const fixture = fixtures.find(
        (entry) =>
          focus !== '' && selection.includes(focus) && selection.includes(entry.request.focus),
      );
      if (fixture === undefined) {
        throw new ProviderError(
          'invalid-request',
          '这次选区不匹配任何已保存的真实回放夹具；脚本没有调用任何模型。',
        );
      }
      return {
        text: rawReply(fixture, passages),
        usage: null,
        truncated: false,
        finishReason: 'stop',
      };
    },
  };
}
