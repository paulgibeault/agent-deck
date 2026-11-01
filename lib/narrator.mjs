// lib/narrator.mjs — the deck's one-shot model calls (Brief, Ask, and the
// request classes that come after them), routed per class.
//
// Each request class (a call's `purpose`) has a route: which transport
// (`claude` or `local`), which model, thinking on or off, and whether a local
// failure falls back to Claude. Routes start from the env (first-run defaults)
// and persist in deck state once the Models dialog changes them. The
// transports themselves live in llm.mjs; this file routes, queues per
// transport and keeps the accounting.
import { transportsFromEnv, TIMEOUT_MS } from './llm.mjs';

export { BIN, childEnv } from './llm.mjs';

export const TRANSPORTS = ['claude', 'local'];
export const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'];
// The local server may serve one request at a time; Claude takes a couple.
const LIMITS = { claude: 2, local: 1 };

const CLASSES = new Map();
/**
 * A request class: the Models dialog lists every registered one. `claudeModel`
 * is what it runs on when it goes to Claude without a Claude model of its own
 * (fallback, "Everything → Claude", or a row switched over).
 */
export function registerClass(id, { label, description = '', transport = 'local', model = null, claudeModel = 'sonnet', thinking = true, fallback = true } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`bad request class: ${id}`);
  CLASSES.set(id, { id, label: label || id, description, transport, model, claudeModel, thinking, fallback });
}
export const requestClasses = () => [...CLASSES.values()];
export const hasClass = (id) => CLASSES.has(id);
// After the local server gives no answer, classes that may fall back skip it
// for this long (or until a call or probe gets through), rather than each
// waiting out a timeout on the single local slot first.
const BREAKER_MS = 60_000;
const ROUTE_KEYS = ['transport', 'model', 'thinking', 'fallback'];

registerClass('brief', { label: 'Brief', description: 'The live summary of a session', transport: 'local', claudeModel: 'haiku', thinking: false });
registerClass('ask', { label: 'Ask', description: 'Questions about a session, its events and files', transport: 'local', claudeModel: 'sonnet' });
registerClass('wrapup', { label: 'Wrap-up', description: 'Extracting what a finished session decided and left open', transport: 'claude', model: 'sonnet' });
registerClass('curate', { label: 'Curate', description: 'Compacting a workstream and checking it for conflicts', transport: 'claude', model: 'sonnet' });
registerClass('title', { label: 'Title', description: 'Suggesting a session title', transport: 'local', claudeModel: 'haiku' });
registerClass('worktree', { label: 'Worktree', description: 'Picking a new worktree’s base branch when it is ambiguous', transport: 'local', claudeModel: 'haiku', thinking: false });

const isTransport = (t) => TRANSPORTS.includes(t);
/** Only what a route may hold, from untrusted input (a request, state.json). */
function cleanPatch(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (isTransport(p.transport)) out.transport = p.transport;
  if (p.model === null || (typeof p.model === 'string' && p.model.length <= 200 && !/\s/.test(p.model))) out.model = p.model || null;
  for (const k of ['thinking', 'fallback']) if (typeof p[k] === 'boolean') out[k] = p[k];
  return out;
}
const isFatalRecent = (err, now) => !!(err?.fatal && now - err.at < 5 * 60_000);
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export class Narrator {
  /**
   * `transports`: { claude, local } (default: both, from the env).
   * `llm`: one transport for every class, as before routing (tests): there is
   * nothing to fall back to then. `state`: a deck.ns('models') store, or attach
   * one later with useState().
   */
  constructor({ briefModel, askModel, llm, transports, limits, state, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
    if (llm) this.transports = { [llm.name === 'claude' ? 'claude' : 'local']: llm };
    else this.transports = transports || transportsFromEnv(env);
    // DECK_LLM picks the first-run backend for every class; unset, each class's own default.
    const only = llm ? (llm.name === 'claude' ? 'claude' : 'local') : env.DECK_LLM ? (env.DECK_LLM.toLowerCase() === 'claude' ? 'claude' : 'local') : null;
    if (env.DECK_LLM && !['claude', 'openai'].includes(env.DECK_LLM.toLowerCase())) throw new Error(`DECK_LLM must be claude or openai, not ${env.DECK_LLM}`);
    this.envDefaults = { only, models: { brief: briefModel || env.DECK_BRIEF_MODEL || null, ask: askModel || env.DECK_ASK_MODEL || null } };
    this.limits = { ...LIMITS, ...(Number(env.DECK_LLM_CONCURRENCY) ? { local: Number(env.DECK_LLM_CONCURRENCY) } : {}), ...limits };
    this.pool = Object.fromEntries(TRANSPORTS.map(t => [t, { active: 0, waiting: [] }]));
    this.timeoutMs = timeoutMs;
    this.saved = {};           // class -> only what the user changed, over the defaults
    this.localDownUntil = 0;   // the breaker: skip local for fallback classes until then
    this.localDownWhy = null;
    this.allClaude = false;
    this.state = null;
    this.totalCostUsd = 0;
    this.calls = 0;
    this.lastError = null;     // { message, at, fatal }
    this.lastDurationMs = null;
    this.byPurpose = {};       // purpose -> { calls, costUsd, ms } since start
    this.today = { day: dayOf(Date.now()), byPurpose: {} };   // purpose -> { calls, costUsd, ms, fallbacks, errors, via }
    // From real calls (and the dialog's reachability probe), never from a timer.
    this.health = Object.fromEntries(TRANSPORTS.map(t => [t, { at: null, ms: null, ok: null, error: null, probe: null }]));
    this.onRateLimit = null;   // (rate_limit_info) => void
    if (state) this.useState(state);
  }

  /** Load and keep persisting routes in `ns` (deck.ns('models')). */
  useState(ns) {
    this.state = ns;
    const s = ns.get('settings', {}) || {};
    this.saved = {};
    for (const [cls, p] of Object.entries(s.routes && typeof s.routes === 'object' ? s.routes : {})) {
      const c = cleanPatch(p);
      if (Object.keys(c).length) this.saved[cls] = c;
    }
    this.allClaude = !!s.allClaude && !!this.transports.claude;
    return this;
  }
  _persist() {
    const routes = Object.keys(this.saved).length ? this.saved : undefined;
    this.state?.set('settings', routes || this.allClaude ? { routes, allClaude: this.allClaude || undefined } : undefined);
  }

  _def(cls) { return CLASSES.get(cls) || { id: cls, label: cls, claudeModel: 'sonnet', thinking: true, fallback: true, transport: null, model: null }; }

  /** A class's route before "Everything → Claude": its defaults, then what the user set. */
  routeOf(cls) {
    const d = this._def(cls);
    let transport = this.envDefaults.only || d.transport || 'local';
    if (!this.transports[transport]) transport = Object.keys(this.transports)[0];
    const envModel = this.envDefaults.models[cls] || null;
    const base = { transport, model: envModel || (transport === d.transport ? d.model : null), thinking: d.thinking, fallback: d.fallback };
    const r = { ...base, ...this.saved[cls] };
    if (!isTransport(r.transport) || !this.transports[r.transport]) r.transport = transport;
    return r;
  }

  /**
   * What a call of this class runs on now: transport, a concrete model,
   * thinking and fallback. `caller` (model, thinking) only counts for a class
   * nobody registered.
   */
  effective(cls, caller = {}) {
    const d = this._def(cls), known = CLASSES.has(cls);
    const r = this.routeOf(cls);
    if (!known) { if (caller.model) r.model = caller.model; if (caller.thinking != null) r.thinking = caller.thinking; }
    let forced = false;
    if (this.allClaude && r.transport !== 'claude' && this.transports.claude) { r.transport = 'claude'; r.model = null; r.fallback = false; forced = true; }
    const model = r.model || (r.transport === 'claude' ? d.claudeModel : this.transports.local?.defaultModel) || null;
    return { transport: r.transport, model, thinking: !!r.thinking, fallback: !!r.fallback && r.transport !== 'claude' && !!this.transports.claude, forced };
  }

  // What briefs.mjs and ask.mjs pass along; the route decides in run() anyway.
  get briefModel() { return this.effective('brief').model; }
  get askModel() { return this.effective('ask').model; }
  /** The transport Brief runs on (the startup line and status() name it). */
  get llm() { return this.transports[this.effective('brief').transport]; }
  get active() { return Object.values(this.pool).reduce((n, p) => n + p.active, 0); }

  /** Change one class's route; applies to the next call (in-flight ones finish where they are). */
  setRoute(cls, patch = {}) {
    if (!CLASSES.has(cls)) throw new Error(`unknown request class: ${cls}`);
    // Only the user's changes are kept, so env-derived defaults stay defaults.
    const cur = this.routeOf(cls), next = { ...this.saved[cls] };
    if (patch.transport !== undefined) {
      if (!isTransport(patch.transport) || !this.transports[patch.transport]) throw new Error(`unknown backend: ${patch.transport}`);
      // A model name means nothing on the other backend: start from its default.
      if (patch.transport !== cur.transport) next.model = null;
      next.transport = patch.transport;
    }
    if (patch.model !== undefined) {
      const m = patch.model == null ? '' : String(patch.model).trim();
      if (m.length > 200 || /\s/.test(m)) throw new Error('bad model name');
      next.model = m || null;
    }
    for (const k of ['thinking', 'fallback']) if (patch[k] !== undefined) next[k] = !!patch[k];
    this.saved[cls] = next;
    this._persist();
    return this.routeOf(cls);
  }

  /** "Everything → Claude": every class on Claude; off restores the rows as they were. */
  setAllClaude(on) {
    if (on && !this.transports.claude) throw new Error('no Claude backend');
    this.allClaude = !!on;
    this._persist();
  }

  /** True while a recent auth/CLI failure says scheduled calls of this class are pointless. */
  blocked(now = Date.now(), purpose = 'brief') {
    const r = this.effective(purpose);
    if (!isFatalRecent(this.health[r.transport]?.error, now)) return false;
    return !(r.fallback && !isFatalRecent(this.health.claude.error, now));
  }

  async _slot(t) {
    const p = this.pool[t];
    if (p.active < (this.limits[t] || 1)) { p.active++; return; }
    await new Promise(r => p.waiting.push(r));
    p.active++;
  }
  _release(t) { const p = this.pool[t]; p.active--; p.waiting.shift()?.(); }

  _usage(purpose) {
    const day = dayOf(Date.now());
    if (this.today.day !== day) this.today = { day, byPurpose: {} };
    return this.today.byPurpose[purpose] ||= { calls: 0, costUsd: 0, ms: 0, fallbacks: 0, errors: 0, via: {} };
  }

  /** One call on one transport, with its slot, accounting and health. */
  async _call(t, { system, prompt, model, thinking, purpose }) {
    await this._slot(t);
    const started = Date.now();
    const h = this.health[t];
    try {
      const { text, costUsd } = await this.transports[t].call({ system, prompt, model, thinking, timeoutMs: this.timeoutMs, onRateLimit: this.onRateLimit });
      const durationMs = Date.now() - started;
      this.totalCostUsd += costUsd;
      this.calls++;
      this.lastError = null;
      this.lastDurationMs = durationMs;
      Object.assign(h, { at: Date.now(), ms: durationMs, ok: true, error: null });
      if (t === 'local') this.localDownUntil = 0;
      const p = this.byPurpose[purpose] ||= { calls: 0, costUsd: 0, ms: 0 };
      p.calls++; p.costUsd += costUsd; p.ms += durationMs;
      const u = this._usage(purpose);
      u.calls++; u.costUsd += costUsd; u.ms += durationMs; u.via[t] = (u.via[t] || 0) + 1;
      return { text, costUsd, durationMs, transport: t, model };
    } catch (e) {
      this.lastError = { message: e.message, at: Date.now(), fatal: !!e.fatal };
      Object.assign(h, { at: Date.now(), ms: null, ok: false, error: { ...this.lastError } });
      if (t === 'local' && (e.unreachable || e.timeout)) { this.localDownUntil = Date.now() + BREAKER_MS; this.localDownWhy = e.message; }
      throw e;
    } finally {
      this._release(t);
    }
  }

  /**
   * Run one prompt on its class's route. Resolves { text, costUsd, durationMs,
   * transport, model, fellBack } or rejects with an Error whose `.fatal` is
   * true for failures retrying will not fix soon. A local call that fails
   * fatally or gets no answer at all is retried on Claude when the route
   * allows; a bad answer never is. `thinking: false` turns extended thinking
   * off: for a structured summary it only adds latency and cost.
   */
  async run({ system, prompt, model, thinking, purpose = 'other' }) {
    // `test:<class>` runs on that class's route but keeps out of its stats.
    const cls = purpose.startsWith('test:') ? purpose.slice(5) : purpose;
    // Resolved once: a route changed mid-call does not move this call.
    const r = this.effective(cls, { model, thinking });
    const viaClaude = (cause) => this._call('claude', { system, prompt, model: this._def(cls).claudeModel, thinking: r.thinking, purpose })
      .then(out => { this._usage(purpose).fallbacks++; return { ...out, fellBack: true, fallbackReason: cause.message }; }, (e2) => {
        // The local cause leads: it is what to fix (and what the heal button looks for).
        const err = Object.assign(new Error(`${cause.message} (and the Claude fallback failed: ${e2.message})`),
          { fatal: !!cause.fatal, unreachable: cause.unreachable, timeout: cause.timeout, cause: e2 });
        this.lastError = { message: err.message, at: Date.now(), fatal: err.fatal };
        throw err;
      });
    try {
      if (r.transport === 'local' && r.fallback && Date.now() < this.localDownUntil) {
        return await viaClaude(new Error(`local model skipped for now: ${this.localDownWhy}`));
      }
      try {
        return { ...await this._call(r.transport, { system, prompt, model: r.model, thinking: r.thinking, purpose }), fellBack: false };
      } catch (e) {
        // A dead or silent backend falls back; an HTTP answer (400, 500) never does.
        if (!(r.fallback && (e.fatal || e.unreachable || e.timeout))) throw e;
        return await viaClaude(e);
      }
    } catch (e) {
      this._usage(purpose).errors++;
      throw e;
    }
  }

  /** The dialog's reachability check: GET /v1/models on the local server (not a model call). */
  async probe() {
    const t = this.transports.local;
    if (!t?.probe) return null;
    const p = await t.probe();
    this.health.local.probe = { ...p, at: Date.now() };
    if (p.ok) this.localDownUntil = 0;
    return p;
  }

  /** Everything the Models dialog shows. */
  view() {
    return {
      allClaude: this.allClaude,
      transports: TRANSPORTS.filter(t => this.transports[t]).map(t => ({
        id: t, label: this.transports[t].label, defaultModel: t === 'local' ? this.transports[t].defaultModel : null, limit: this.limits[t],
        models: t === 'claude' ? CLAUDE_MODELS : this.health.local.probe?.models || [], health: this.health[t], active: this.pool[t].active,
        skipUntil: t === 'local' && this.localDownUntil > Date.now() ? this.localDownUntil : null,
      })),
      classes: requestClasses().map(d => ({ id: d.id, label: d.label, description: d.description, claudeModel: d.claudeModel,
        route: this.routeOf(d.id), effective: this.effective(d.id), usage: this._usage(d.id) })),
    };
  }

  status() {
    return { llm: this.llm?.name, llmLabel: this.llm?.label, briefModel: this.briefModel, askModel: this.askModel, allClaude: this.allClaude, totalCostUsd: this.totalCostUsd, calls: this.calls, lastDurationMs: this.lastDurationMs, byPurpose: this.byPurpose,
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
