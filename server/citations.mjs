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
 *
 * The other half of this module is about *shape*. A model's reply can arrive complete, arrive
 * cut off, arrive as JSON that does not parse, or arrive in a shape nobody agreed to. What the
 * reader is shown depends on which of those happened, so the parser names the case instead of
 * collapsing them into a boolean: `valid` (the contract was followed), `recovered` (the answer
 * was extracted by a documented rule from output that did not follow it), `malformed` (nothing
 * usable could be extracted without guessing), `incomplete` (the provider says generation
 * stopped early), and `provider-error` for a call that never produced output at all.
 *
 * The recovery rules are deliberately narrow, and every one of them still runs each citation
 * through the same verbatim check. Recovery is of the *shape*; a citation still has to earn its
 * place.
 */

import { CITATION_SENTINEL } from './prompt.mjs';

const MAX_ANSWER_CHARS = 20_000;
const MAX_CITATIONS = 20;

/** Whitespace in a PDF text layer is unreliable; everything else must match exactly. */
export function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The status vocabulary, in one place so the service, the interface and the tests agree. */
export const OUTPUT_STATUS = {
  valid: 'valid',
  recovered: 'recovered',
  malformed: 'malformed',
  incomplete: 'incomplete',
  providerError: 'provider-error',
};

function parsedResult(status, text, value, recovery) {
  return { ok: true, status, text, value, recovery };
}

function unusable(recovery = null) {
  return { ok: false, status: OUTPUT_STATUS.malformed, text: '', value: null, recovery };
}

/**
 * Text that opens as a JSON object and is not an answer.
 *
 * This is the "never show the reader raw JSON" rule stated as code. The old contract put the
 * answer inside a JSON object, so a reply that failed to parse could still be *mostly* JSON —
 * and printing that in the panel looks like an answer to someone who asked a question in
 * Chinese. Anything that starts with `{` and parses as an object is treated as protocol, not as
 * prose, whether or not it uses the field names this service knows.
 */
function looksLikeProtocol(text) {
  const head = text.trimStart();
  if (!head.startsWith('{')) return false;
  if (isRecord(tryParse(head))) return true;
  return /"(answer|groundedInText|citations)"\s*:/.test(head.slice(0, 400));
}

/** The last line that is exactly the sentinel, and the text either side of it. */
function splitOnSentinel(text) {
  const at = text.lastIndexOf(CITATION_SENTINEL);
  if (at < 0) return null;
  const after = text.slice(at + CITATION_SENTINEL.length);
  return { answer: text.slice(0, at).trim(), block: after.trim() };
}

/**
 * Reads the citation block that follows the sentinel.
 *
 * Returns null when there is nothing recognisable there at all, `complete: false` when the
 * fields had to be read out individually, and `complete: true` when one `JSON.parse` did it.
 */
function parseCitationBlock(block) {
  const text = stripFence(block);
  if (text === '') return null;
  const first = text[0];

  // The block's own first character decides how to read it. Slicing for the outermost `{`
  // first would find a citation object inside a bare array and mistake it for the whole block.
  if (first === '{') {
    const whole = sliceObject(text);
    if (whole !== null) {
      const parsed = tryParse(whole);
      if (isRecord(parsed) && (parsed.citations === undefined || Array.isArray(parsed.citations))) {
        return {
          complete: true,
          value: { groundedInText: parsed.groundedInText, citations: parsed.citations ?? [] },
        };
      }
    }
  }

  // A bare array, which is what a model that drops `groundedInText` produces.
  if (first === '[') {
    const array = tryParse(sliceArray(text));
    if (Array.isArray(array)) return { complete: true, value: { citations: array } };
  }

  const salvaged = salvage(text);
  if (salvaged !== null) return { complete: false, value: salvaged };
  return null;
}

function stripFence(text) {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return (fenced === null ? text : fenced[1]).trim();
}

export function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The outermost `{…}`, ignoring braces inside strings. */
export function sliceObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = matchingDelimiter(text, start, '{', '}');
  return end < 0 ? null : text.slice(start, end + 1);
}

/** The outermost `[…]`, ignoring brackets inside strings. */
export function sliceArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  const end = matchingDelimiter(text, start, '[', ']');
  return end < 0 ? null : text.slice(start, end + 1);
}

/** Index of the delimiter that closes the one at `start`, or -1 when it never closes. */
function matchingDelimiter(text, start, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Pulls the answer object out of whatever the model produced.
 *
 * The order matters. The agreed contract is tried first; then the shapes that older prompts
 * asked for and that saved responses are written in; then two documented recoveries for broken
 * JSON; and only then is the reply treated as plain prose. Anything that cannot be read without
 * guessing is reported as `malformed` and its text is never shown.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== 'string') return unusable();
  const trimmed = raw.trim();
  if (trimmed === '') return unusable();

  // 1. The agreed contract: plain text, a sentinel line, then a small JSON block.
  const split = splitOnSentinel(trimmed);
  if (split !== null && !looksLikeProtocol(split.answer)) {
    if (split.answer === '') {
      // A delimiter with nothing in front of it. There is no answer body here to show, and the
      // block after it is metadata — printing it would put protocol in front of the reader.
      return unusable('sentinel-no-answer');
    }
    const block = parseCitationBlock(split.block);
    if (block !== null) {
      return parsedResult(
        block.complete ? OUTPUT_STATUS.valid : OUTPUT_STATUS.recovered,
        split.answer,
        block.value,
        'sentinel',
      );
    }
    if (split.block === '') {
      // No citation block at all, but a perfectly good answer. Worth showing, without citations.
      return parsedResult(
        OUTPUT_STATUS.recovered,
        split.answer,
        { groundedInText: undefined, citations: [] },
        'sentinel-no-block',
      );
    }
    // A sentinel with something unreadable after it: the answer survives, the citations do not.
    return parsedResult(
      OUTPUT_STATUS.recovered,
      split.answer,
      { groundedInText: undefined, citations: [] },
      'sentinel-broken-block',
    );
  }

  // 2. The contract this service used to ask for, still produced by models trained on it and
  //    present in every saved response.
  const envelope = readEnvelope(trimmed);
  if (envelope !== null) {
    return parsedResult(OUTPUT_STATUS.valid, envelope.answer, envelope.value, 'legacy-json');
  }

  // 3. Field-level salvage: the envelope is broken, the fields inside it are not.
  const salvaged = salvage(trimmed);
  if (salvaged !== null && !looksLikeProtocol(salvaged.answer)) {
    return parsedResult(OUTPUT_STATUS.recovered, salvaged.answer, salvaged, 'field-salvage');
  }

  // 4. The measured failure: the model escaped the rest of its own protocol into `answer`.
  const escaped = recoverEscapedEnvelope(trimmed);
  if (escaped !== null && !looksLikeProtocol(escaped.answer)) {
    return parsedResult(OUTPUT_STATUS.recovered, escaped.answer, escaped, 'escaped-envelope');
  }

  // 5. Plain prose. The reader still gets an answer; no citation can be checked because none
  //    was offered in a form that could be.
  if (!looksLikeProtocol(trimmed)) {
    return parsedResult(
      OUTPUT_STATUS.recovered,
      trimmed,
      { groundedInText: undefined, citations: [] },
      'prose',
    );
  }

  return unusable('protocol-text');
}

/** A complete JSON envelope with a string `answer`, however the provider wrapped it. */
function readEnvelope(text) {
  const candidates = [];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced !== null) candidates.push(fenced[1]);
  candidates.push(text);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (!isRecord(parsed)) continue;
    if (typeof parsed.answer !== 'string') continue;
    return {
      answer: parsed.answer,
      value: { groundedInText: parsed.groundedInText, citations: parsed.citations ?? [] },
    };
  }
  return null;
}

/**
 * Reads `answer`, `groundedInText` and `citations` out of JSON that does not parse.
 *
 * Deliberately narrow: it only understands the shape this service's own prompt used to ask for,
 * it takes each citation object through `JSON.parse` on its own (so a broken one is dropped
 * rather than half-read), and it returns null rather than guessing when the answer itself is
 * missing.
 */
function salvage(text) {
  const answer = readStringField(text, 'answer');
  if (answer === null || answer.trim() === '') return null;

  const citations = [];
  const start = text.indexOf('"citations"');
  if (start >= 0) {
    const bracket = text.indexOf('[', start);
    if (bracket >= 0) {
      for (let index = bracket; index < text.length; index += 1) {
        if (text[index] !== '{') continue;
        const end = matchingDelimiter(text, index, '{', '}');
        if (end < 0) break;
        const parsed = tryParse(text.slice(index, end + 1));
        if (parsed !== undefined) citations.push(parsed);
        index = end;
      }
    }
  }

  const grounded = /"groundedInText"\s*:\s*(true|false)/.exec(text);
  return {
    answer,
    groundedInText: grounded === null ? undefined : grounded[1] === 'true',
    citations,
  };
}

/**
 * The live failure this rule exists for.
 *
 * A real DeepSeek reply began `{"answer": "…` and then wrote the rest of its own protocol as
 * *escaped text inside the answer*: `…区域。\", \"groundedInText\": true, \"citations\": [{…}]}"}`.
 * Nothing in it is ambiguous — every `\"` in the envelope is a structural quote that the model
 * over-escaped — so un-escaping them recovers exactly one object.
 *
 * Two guards keep this from becoming guesswork:
 *
 *   - the answer body is everything before the **first** `\"`, so by construction the un-escaping
 *     never touches a quote that legitimately belongs to the answer;
 *   - the un-escaped text must then parse as a JSON object with a non-empty string `answer` and
 *     an array `citations`. An answer that itself contained a real escaped quote fails that
 *     parse and is left alone.
 */
function recoverEscapedEnvelope(text) {
  const firstEscapedQuote = text.indexOf('\\"');
  if (firstEscapedQuote < 0) return null;
  if (!text.trimStart().startsWith('{')) return null;
  const unescaped =
    text.slice(0, firstEscapedQuote) + text.slice(firstEscapedQuote).replaceAll('\\"', '"');
  const parsed = tryParse(unescaped);
  if (!isRecord(parsed)) return null;
  if (typeof parsed.answer !== 'string' || parsed.answer.trim() === '') return null;
  if (!Array.isArray(parsed.citations)) return null;
  return {
    answer: parsed.answer,
    groundedInText: parsed.groundedInText,
    citations: parsed.citations,
  };
}

/** The value of a top-level string field, read with escape awareness. null when absent. */
function readStringField(text, name) {
  const key = `"${name}"`;
  const at = text.indexOf(key);
  if (at < 0) return null;
  const colon = text.indexOf(':', at);
  if (colon < 0) return null;
  // The value has to actually be a string. Without this the scan would happily read the first
  // quoted thing it found after the key — which, for `{"answer": {"text": …}}`, is the nested
  // field's own name, turning a malformed answer into a confident-looking wrong one.
  let cursor = colon + 1;
  while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
  if (text[cursor] !== '"') return null;
  const open = cursor;
  let out = '';
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      out += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      try {
        return JSON.parse(`"${out}"`);
      } catch {
        // An escape the JSON grammar does not know: keep the text as it stands.
        return out;
      }
    }
    out += ch;
  }
  return null;
}

/**
 * Validates one answer for the passages it was generated from.
 *
 * `passages` is the same normalised list that went into the prompt, so a passage id here is
 * proof that the model was shown that text — not merely that it exists somewhere.
 *
 * `truncated` comes from the provider's own stop reason. It decides the status when the output
 * also failed to parse, because "the reply is cut off" and "the reply is malformed" lead a
 * reader to different conclusions and the first explains the second.
 */
export function verifyAnswer(rawText, passages, { truncated = false } = {}) {
  const warnings = [];
  if (truncated) warnings.push('模型的回答被长度上限截断了，可能不完整。');

  const parsed = parseModelOutput(rawText);
  const diagnostics = {
    rawChars: typeof rawText === 'string' ? rawText.length : 0,
    recovery: parsed.recovery ?? null,
    citationEntries: 0,
    citationsAccepted: 0,
    citationsRejected: 0,
  };

  if (!parsed.ok) {
    // A reply that is nothing but unreadable protocol has no answer to show. Saying so plainly
    // is the only honest option; printing the JSON back would look like an answer.
    return {
      status: truncated ? OUTPUT_STATUS.incomplete : OUTPUT_STATUS.malformed,
      answer: '',
      groundedInText: null,
      citations: [],
      warnings,
      diagnostics,
    };
  }

  const answer = parsed.text.slice(0, MAX_ANSWER_CHARS);
  if (parsed.text.length > MAX_ANSWER_CHARS) warnings.push('回答过长，已截断。');
  if (parsed.text.trim() === '') warnings.push('模型返回了空的回答正文。');
  if (parsed.recovery === 'field-salvage') {
    warnings.push(
      '模型这次返回的 JSON 不完整，回答正文与引用是从中逐字段恢复的；每条引用仍逐字校验过，但没有通过一次完整的 JSON 解析。',
    );
  }
  if (parsed.recovery === 'escaped-envelope') {
    warnings.push(
      '模型把后续内容当成转义文本写进了回答里，这次回答是按这条结构还原出来的；正文里没有残留的转义字符，每条引用仍逐字校验过。',
    );
  }
  if (parsed.recovery === 'sentinel-broken-block') {
    warnings.push(
      '模型给出了引用块，但它的内容无法解析，因此这次没有可校验的引用；回答正文不受影响。',
    );
  }

  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const groundedInText =
    typeof parsed.value.groundedInText === 'boolean' ? parsed.value.groundedInText : null;

  const rawCitations = Array.isArray(parsed.value.citations) ? parsed.value.citations : [];
  diagnostics.citationEntries = rawCitations.length;
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

  diagnostics.citationsAccepted = citations.length;
  diagnostics.citationsRejected = rejected;

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

  // An answer that was cut off mid-thought is not the same as a complete one, and it is the
  // provider that knows which happened.
  const status = truncated ? OUTPUT_STATUS.incomplete : parsed.status;

  return { status, answer, groundedInText, citations, warnings, diagnostics };
}
