/**
 * What the browser and the local AI service say to each other.
 *
 * The browser sends structure: which paper, which page, which passages, which question. It does
 * not send a system message, a model name, an endpoint or a credential — those live in the
 * service, which is the only thing that holds the key.
 */

/** The kinds of help the reader can ask for at a selection. */
export type AiMode = 'explain' | 'walkthrough' | 'formula' | 'translate' | 'ask';

export const AI_MODE_LABEL: Record<AiMode, string> = {
  explain: '解释这段话',
  walkthrough: '逐步讲解原理',
  formula: '解释数学公式',
  translate: '翻译为中文',
  ask: '自由提问',
};

/** One block of原文 the model is allowed to rely on. Exactly one is the reader's selection. */
export interface AiPassage {
  id: string;
  page: number;
  text: string;
  selection: boolean;
}

export interface AiHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiPaperRef {
  id: string;
  title: string;
  page: number;
  pdfSha256: string;
}

export interface AiAskRequest {
  mode: AiMode;
  question: string;
  paper: AiPaperRef;
  passages: AiPassage[];
  history?: AiHistoryTurn[];
  /** What the reader's own layout check found, stated as a measurement rather than a guess. */
  layoutNotice?: string | null;
  /**
   * What the primary passage is.
   *
   * `selection` means the reader selected text; `page` means they are asking about the page as
   * a whole. The distinction changes only how the material is described to the model — the
   * citation rules are identical either way.
   */
  scope?: 'selection' | 'page';
}

/** A citation that survived the service's check: the page came from our own record. */
export interface AiCitation {
  n: number;
  passageId: string;
  page: number;
  quote: string;
  selection: boolean;
}

/**
 * How the model's output came back.
 *
 * The service decides this, not the interface, because only the service sees the raw reply.
 * `provider-error` is never attached to an answer — it is the status of a call that produced no
 * output at all — but it belongs to the same vocabulary so there is one list to reason about.
 */
export type AiOutputStatus = 'valid' | 'recovered' | 'malformed' | 'incomplete' | 'provider-error';

/**
 * Numbers and enums about one reply: lengths, counts, the provider's own stop reason.
 *
 * Nothing here is paper text, prompt text or a credential, which is what makes it safe to show
 * behind a disclosure the reader has to open.
 */
export interface AiDiagnostics {
  rawChars: number;
  /** Which parsing rule produced the answer, or null when the contract was followed. */
  recovery: string | null;
  citationEntries: number;
  citationsAccepted: number;
  citationsRejected: number;
  finishReason: string | null;
  truncated: boolean;
}

export interface AiAnswer {
  provider: string;
  providerLabel: string;
  model: string;
  /** True when the answer came from a paid service, so the interface can say so. */
  online: boolean;
  mode: AiMode;
  /** How the reply was read; the panel's wording depends on it. */
  status: AiOutputStatus;
  answer: string;
  /** The model's own claim about whether the text it was given sufficed. Null when unknown. */
  groundedInText: boolean | null;
  citations: AiCitation[];
  warnings: string[];
  diagnostics: AiDiagnostics | null;
  usage: AiUsage | null;
}

/**
 * What the call cost, as the provider reported it.
 *
 * `reasoningTokens` is a subset of `completionTokens`, not an addition to it: in thinking mode
 * the reasoning comes out of the same generation budget as the answer.
 */
export interface AiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens?: number | null;
  cachedPromptTokens?: number | null;
}

export type AiFailureKind =
  | 'offline'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'rate-limit'
  /** The account is out of credit: waiting will not help. */
  | 'insufficient-balance'
  /** The service itself rejected the parameters we built — a defect on our side, not the reader's. */
  | 'invalid-request'
  /** Generation stopped early (usually the token budget, which thinking spends from too). */
  | 'incomplete'
  | 'auth'
  | 'upstream'
  | 'bad-request'
  /** The session's own spending cap was reached before the call was made. */
  | 'budget-exceeded'
  | 'unknown';

export interface AiFailure {
  kind: AiFailureKind;
  message: string;
}

export interface AiBudget {
  /** Attempts allowed in this service session, including failed ones. */
  requests: number;
  /** Generation ceiling per call, reasoning included. */
  tokensPerRequest: number;
  /** Upper-bound prompt-plus-completion tokens for the whole session. */
  tokensPerSession: number;
}

/**
 * What this service process has spent so far.
 *
 * `exactTokens` is false when a provider omitted usage and the upper bound was recorded
 * instead. `estimatedCostCny` is an estimate from the price table, not a bill; `costKnown` is
 * false when the model has no price row at all, in which case the estimate is unreliable.
 */
export interface AiUsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
  costKnown: boolean;
  unknownCostRequests: number;
  exactTokens: boolean;
}

export interface AiPricing {
  model: string;
  known: boolean;
  currency: string;
  asOf: string;
  source: string;
  basis?: string;
  usdCny?: number;
  perMillionUsd?: {
    inputCacheHit: number;
    inputCacheMiss: number;
    output: number;
  };
  note: string;
}

export interface AiHealth {
  ok: boolean;
  provider: string;
  label: string;
  model: string;
  /** Identifies this service process; changes on every restart. */
  instanceId?: string;
  /** What the provider will spend per call, in its own terms; null for the offline provider. */
  reasoning: string | null;
  online: boolean;
  budget?: AiBudget;
  usage?: AiUsageTotals;
  pricing?: AiPricing;
  limits: {
    passages: number;
    passageChars: number;
    totalContextChars: number;
    questionChars: number;
    requestsPerMinute: number;
    /** The generation ceiling in force, reasoning included. */
    answerTokens: number;
  };
}
