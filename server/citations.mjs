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

  // The model writes its answer as JSON *containing LaTeX*, and a stray backslash or a missing
  // brace is enough to make the envelope invalid while the answer inside it is perfectly good.
  // (Measured against the live API: a 3971-character answer whose every citation was correct,
  // rejected whole because the JSON did not close.) So the fields are salvaged individually —
  // and the caller still verifies every citation word for word, which is what keeps this honest.
  const salvaged = salvage(trimmed);
  if (salvaged !== null)
    return { ok: true, text: salvaged.answer, value: salvaged, salvaged: true };

  return {
    ok: false,
    text: trimmed,
    // Something that opens as an object is an attempt at the contract, even when it is too
    // broken to parse; showing it raw would put JSON in front of a reader who asked a question.
    sawJsonObject: sawJsonObject || trimmed.startsWith('{'),
  };
}

/**
 * Reads `answer`, `groundedInText` and `citations` out of JSON that does not parse.
 *
 * Deliberately narrow: it only understands the shape this service's own prompt asks for, it
 * takes each citation object through `JSON.parse` on its own (so a broken one is dropped rather
 * than half-read), and it returns null rather than guessing when the answer itself is missing.
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
        // Match the closing brace of this object, honouring strings and escapes.
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let end = index; end < text.length; end += 1) {
          const ch = text[end];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              try {
                citations.push(JSON.parse(text.slice(index, end + 1)));
              } catch {
                // A citation whose own object is broken is dropped, not repaired.
              }
              index = end;
              break;
            }
          }
        }
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
  if (parsed.salvaged === true) {
    warnings.push(
      '模型这次返回的 JSON 不完整，回答正文与引用是从中逐字段恢复的；每条引用仍逐字校验过，但没有通过一次完整的 JSON 解析。',
    );
  }

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
