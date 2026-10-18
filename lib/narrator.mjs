// lib/narrator.mjs — the deck's one-shot model calls: Brief and Ask.
//
// The transport (claude -p, or an OpenAI-compatible endpoint) lives in
// llm.mjs; this file queues calls and keeps the accounting.
import { transportFromEnv, TIMEOUT_MS } from './llm.mjs';

export { BIN, childEnv } from './llm.mjs';
const MAX_CONCURRENT = 2;

export class Narrator {
  constructor({ briefModel, askModel, llm, timeoutMs = TIMEOUT_MS } = {}) {
    this.llm = llm || transportFromEnv();
    this.timeoutMs = timeoutMs;
    this.briefModel = briefModel || process.env.DECK_BRIEF_MODEL || this.llm.defaultModel || 'haiku';
    this.askModel = askModel || process.env.DECK_ASK_MODEL || this.llm.defaultModel || 'sonnet';
    this.active = 0;
    this.waiting = [];
    this.totalCostUsd = 0;
    this.calls = 0;
    this.lastError = null;     // { message, at, auth }
    this.lastDurationMs = null;
    this.byPurpose = {};       // purpose -> { calls, costUsd, ms }
    this.onRateLimit = null;   // (rate_limit_info) => void
  }

  /** True while a recent auth/CLI failure says scheduled calls are pointless. */
  blocked(now = Date.now()) {
    return !!(this.lastError?.fatal && now - this.lastError.at < 5 * 60_000);
  }

  async _slot() {
    if (this.active < MAX_CONCURRENT) { this.active++; return; }
    await new Promise(r => this.waiting.push(r));
    this.active++;
  }
  _release() { this.active--; this.waiting.shift()?.(); }

  /**
   * Run one prompt. Resolves { text, costUsd, durationMs } or rejects with an
   * Error whose `.fatal` is true for failures retrying will not fix soon.
   * `thinking: false` turns extended thinking off: for a structured summary it
   * only adds latency and cost (a Haiku brief spent ~5k thinking tokens and
   * ~40s on a ~300-token reply).
   */
  async run({ system, prompt, model, thinking = true, purpose = 'other' }) {
    await this._slot();
    const started = Date.now();
    try {
      const { text, costUsd } = await this.llm.call({ system, prompt, model, thinking, timeoutMs: this.timeoutMs, onRateLimit: this.onRateLimit });
      this.totalCostUsd += costUsd;
      this.calls++;
      this.lastError = null;
      const durationMs = Date.now() - started;
      this.lastDurationMs = durationMs;
      const p = this.byPurpose[purpose] ||= { calls: 0, costUsd: 0, ms: 0 };
      p.calls++; p.costUsd += costUsd; p.ms += durationMs;
      return { text, costUsd, durationMs };
    } catch (e) {
      this.lastError = { message: e.message, at: Date.now(), fatal: !!e.fatal };
      throw e;
    } finally {
      this._release();
    }
  }

  status() {
    return { llm: this.llm.name, llmLabel: this.llm.label, briefModel: this.briefModel, askModel: this.askModel, totalCostUsd: this.totalCostUsd, calls: this.calls, lastDurationMs: this.lastDurationMs, byPurpose: this.byPurpose,
      error: this.lastError ? { message: this.lastError.message, at: this.lastError.at, fatal: this.lastError.fatal } : null };
  }
}

/** First JSON object in a model reply (tolerates code fences and prose). */
export function extractJson(text) {
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
