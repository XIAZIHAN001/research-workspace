/**
 * Checking what the model claimed against what it was actually given.
 *
 * A model asked to cite its sources will happily produce a plausible-looking quotation and a
 * page number for it. Neither can be trusted, and both are easy to check: the service knows
 * exactly which passages it sent and which page each came from. So the rule here is that a
 * citation survives only if its passage id was one of ours **and** its quotation is a verbatim
 * substring of that passage. Page numbers are never read from the model at all — they come from
 * the passage record the service built.
 *
 * Anything that fails is dropped and reported as a warning rather than repaired, because a
 * repaired citation would be exactly the fabricated provenance this is meant to prevent.
 */

const MAX_ANSWER_CHARS = 20_000;
const MAX_CITATIONS = 20;

/** Whitespace in a PDF text layer is unreliable; everything else must match exactly. */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pulls the answer object out of whatever the model produced.
 *
 * A provider may wrap JSON in a code fence; a model without JSON mode may preface it with a
 * sentence. Both are recoverable. Anything else is treated as a plain-text answer with no
 * citations — which is safe, because an unverified citation is worse than none.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== 'string') return { ok: false, text: '', sawJsonObject: false };
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidates = [];
  if (fenced !== null) candidates.push(fenced[1]);
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  // The difference between "answered in prose" and "answered with JSON that has no answer in it"
  // decides what the reader is shown: the first is worth reading, the second is not.
  let sawJsonObject = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isRecord(parsed)) continue;
      sawJsonObject = true;
      if (typeof parsed.answer === 'string')
        return { ok: true, text: parsed.answer, value: parsed };
    } catch {
      // try the next shape
    }
  }
  return { ok: false, text: trimmed, sawJsonObject };
}

/**
 * Validates one answer for the passages it was generated from.
 *
 * `passages` is the same normalised list that went into the prompt, so a passage id here is
 * proof that the model was shown that text — not merely that it exists somewhere.
 */
export function verifyAnswer(rawText, passages, { truncated = false } = {}) {
  const warnings = [];
  if (truncated) warnings.push('模型的回答被长度上限截断了，可能不完整。');

  const parsed = parseModelOutput(rawText);
  if (!parsed.ok) {
    // A model that answered in prose is still worth reading; a model that returned JSON with no
    // answer field has nothing to show, and showing the raw JSON instead would only look like an
    // answer. Both lose their citations, because nothing can be verified against a shape that
    // was never agreed.
    const reason = parsed.sawJsonObject
      ? '模型返回的是 JSON，但里面没有可用的 answer 文字字段，这次没有可显示的回答。'
      : '模型没有按约定返回 JSON，因此没有可校验的引用；下面的内容是原文照录。';
    return {
      answer: parsed.sawJsonObject ? '' : parsed.text.slice(0, MAX_ANSWER_CHARS),
      groundedInText: null,
      citations: [],
      warnings: [...warnings, reason],
    };
  }

  const answer = parsed.text.slice(0, MAX_ANSWER_CHARS);
  if (parsed.text.length > MAX_ANSWER_CHARS) warnings.push('回答过长，已截断。');
  if (parsed.text.trim() === '') warnings.push('模型返回了空的回答正文。');

  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const groundedInText =
    typeof parsed.value.groundedInText === 'boolean' ? parsed.value.groundedInText : null;

  const rawCitations = Array.isArray(parsed.value.citations) ? parsed.value.citations : [];
  const citations = [];
  const usedNumbers = new Set();
  let rejected = 0;

  for (const entry of rawCitations.slice(0, MAX_CITATIONS)) {
    if (!isRecord(entry)) {
      rejected += 1;
      continue;
    }
    const n = entry.n;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CITATIONS || usedNumbers.has(n)) {
      rejected += 1;
      continue;
    }
    if (typeof entry.passageId !== 'string') {
      rejected += 1;
      continue;
    }
    const passage = byId.get(entry.passageId);
    if (passage === undefined) {
      rejected += 1;
      continue;
    }
    if (typeof entry.quote !== 'string' || collapse(entry.quote) === '') {
      rejected += 1;
      continue;
    }
    const quote = collapse(entry.quote);
    if (!collapse(passage.text).includes(quote)) {
      // The model paraphrased, merged two sentences, or invented the quotation outright. All
      // three are unverifiable, and all three are refused the same way.
      rejected += 1;
      continue;
    }
    usedNumbers.add(n);
    citations.push({
      n,
      passageId: passage.id,
      page: passage.page,
      quote,
      selection: passage.selection,
    });
  }

  if (rejected > 0) {
    warnings.push(`有 ${String(rejected)} 条引用未通过校验（引文与提供的原文不符），已丢弃。`);
  }

  // A marker in the text with nothing behind it is a dangling pointer; say so rather than let
  // the reader click a number that leads nowhere.
  const markers = [...answer.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1]));
  const dangling = [...new Set(markers)].filter((n) => !usedNumbers.has(n));
  if (dangling.length > 0) {
    warnings.push(
      `回答里引用了没有通过校验的编号 ${dangling.map(String).join('、')}，这些标记已按普通文字显示。`,
    );
  }
  const unreferenced = citations.filter((citation) => !markers.includes(citation.n));
  if (unreferenced.length > 0) {
    warnings.push('有的引文没有在回答正文里被引用，已单独列出。');
  }

  return { answer, groundedInText, citations, warnings };
}
