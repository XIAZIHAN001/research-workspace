/**
 * Everything the welcome line may depend on. Plain data on purpose: a real model-backed
 * provider can turn the same object into a prompt without touching any UI code.
 */
export interface WelcomeContext {
  /** Local hour, 0-23. */
  hour: number;
  projectCount: number;
  current: { name: string; idleDays: number; relatedCount: number } | null;
}

export interface WelcomeProvider {
  greet(context: WelcomeContext, signal?: AbortSignal): Promise<string>;
}

export function salutation(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** Longest project name quoted in the template line; a longer one ends in an ellipsis. */
export const WELCOME_NAME_LIMIT = 28;

/** Keeps a paper title from taking over the welcome line, so the closing question stays visible. */
export function shortenName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= WELCOME_NAME_LIMIT) return name;
  let head = chars.slice(0, WELCOME_NAME_LIMIT);
  // Cut at a word boundary when one is close, so "Transformers" never becomes "Transfo…".
  const lastSpace = head.lastIndexOf(' ');
  if (chars[WELCOME_NAME_LIMIT] !== ' ' && lastSpace >= WELCOME_NAME_LIMIT / 2) {
    head = head.slice(0, lastSpace);
  }
  return `${head.join('').trimEnd()}…`;
}

/** Deterministic stand-in text. It only states facts present in the context. */
export function composeWelcome(context: WelcomeContext): string {
  const hello = salutation(context.hour);
  if (context.projectCount === 0) {
    return `${hello}。新建第一个项目，从一篇想读懂的论文开始。`;
  }
  const { current } = context;
  if (current === null) return `${hello}。选一个项目，接着往下读。`;
  const name = shortenName(current.name);
  if (current.idleDays === 0) return `${hello}。《${name}》今天刚动过，趁热再往前推进一点。`;
  return `${hello}。《${name}》已有 ${current.idleDays} 天没有改动，今天推进一点？`;
}

/** An opening longer than this is a sentence, not a greeting, and stays in one block. */
const GREETING_LIMIT = 12;
const SENTENCE_END = '。！？!?';

export interface WelcomeParts {
  /** The short opening, set large. */
  lead: string;
  /** The punctuation between lead and body. Hidden on screen, kept so the text still reads whole. */
  stop: string;
  body: string;
}

/**
 * Splits "早上好。新建第一个项目……" into a large greeting and a quieter line. The provider still
 * returns one plain string; text that does not open with a short greeting is left whole.
 */
export function splitWelcome(text: string): WelcomeParts {
  const whole: WelcomeParts = { lead: text, stop: '', body: '' };
  const chars = Array.from(text);
  const end = chars.findIndex((char) => SENTENCE_END.includes(char));
  if (end < 1 || end > GREETING_LIMIT) return whole;
  const body = chars
    .slice(end + 1)
    .join('')
    .trim();
  if (body === '') return whole;
  return { lead: chars.slice(0, end).join(''), stop: chars[end] ?? '', body };
}

export const mockWelcomeProvider: WelcomeProvider = {
  greet: (context) => Promise.resolve(composeWelcome(context)),
};
