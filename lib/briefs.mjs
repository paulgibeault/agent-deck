// lib/briefs.mjs — the generated Brief: a model-written summary of a session
// to date, refreshed incrementally on a cadence that depends on whether
// anyone is looking at the session and whether its agent is working.
//
//   shown, working        every 45s (15s after a turn end, error or subagent finish)
//   shown, not working    once per new activity
//   not shown, working    every 2m (30s after a trigger); live sessions only
//   not shown, otherwise  paused until opened
//
// The shown cadence is a reading pace: each brief stays up long enough to be
// read. A refresh is skipped when nothing the model would see has changed
// (sideband records such as queue or snapshot entries bump the record count
// without adding events). Each refresh sends the previous brief plus only the
// events since it, and the last few briefs are kept so the UI can step back.
// Emits 'brief' (publicBrief) whenever a brief starts, lands or fails.
import { EventEmitter } from 'node:events';
import { digest } from './digest.mjs';
import { extractJson } from './narrator.mjs';

const SHOWN_WORKING_MS = 45_000;
const SHOWN_TRIGGER_MS = 15_000;
const BACKGROUND_MS = 120_000;
const BACKGROUND_TRIGGER_MS = 30_000;
const RETRY_MS = 60_000;
const HISTORY = 6;
// Events whose digest decides whether a refresh would tell the model anything new.
const FINGERPRINT_EVENTS = 40;

const SYSTEM = `You keep a live brief of a Claude Code agent session for the person supervising it.
Reply with ONLY one JSON object, no prose, no code fence:
{"summary": "2-3 sentences: what the session has accomplished to date and what it is doing now",
 "progress": {"unit": "plural noun for the countable work items, e.g. issues, tests, files", "segments": [{"label": "merged", "count": 5, "tone": "done"}]} or null,
 "done": ["up to 4 short accomplishments, most important first"],
 "now": "one sentence on the current activity",
 "next": "one sentence on what comes next, or null if unclear",
 "watch": {"text": "one sentence on a risk, failure or open question the supervisor should know", "seq": 123} or null}
Rules:
- Use only what the transcript shows. Never invent numbers, files or outcomes.
- Be concrete: name issues, PRs, files, commands, test counts.
- progress only when the work really has countable units; tones are done, active (being finished now), working (in progress), todo, failed. Counts must add up to the total.
- watch.seq is the #number of the event that shows the risk, or null.
- Plain text inside strings, no markdown. Keep list items under 12 words.
- When a previous brief is given, update it: keep what is still true, change what moved on.`;

const TONES = new Set(['done', 'active', 'working', 'todo', 'failed']);

function normalize(j) {
  const str = (v, max = 600) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const out = {
    summary: str(j.summary, 1200),
    done: Array.isArray(j.done) ? j.done.map(x => str(x, 160)).filter(Boolean).slice(0, 5) : [],
    now: str(j.now),
    next: str(j.next),
    watch: null,
    progress: null,
  };
  if (j.watch && str(j.watch.text)) out.watch = { text: str(j.watch.text), seq: Number.isInteger(j.watch.seq) ? j.watch.seq : null };
  const segs = Array.isArray(j.progress?.segments) ? j.progress.segments
    .map(s => ({ label: str(s.label, 40), count: Math.max(0, Math.round(Number(s.count) || 0)), tone: TONES.has(s.tone) ? s.tone : 'working' }))
    .filter(s => s.label && s.count > 0).slice(0, 6) : [];
  if (segs.length) out.progress = { unit: str(j.progress.unit, 40) || 'items', total: segs.reduce((n, s) => n + s.count, 0), segments: segs };
  return out;
}

export class BriefService extends EventEmitter {
  constructor({ index, narrator, enabled = true }) {
    super();
    this.index = index;
    this.narrator = narrator;
    this.enabled = enabled;
    this.isHidden = () => false;
    this.views = new Map();      // clientId -> sessionId shown in that browser tab
    this.st = new Map();         // id -> { brief, history, records, fp, seq, updatedAt, pending, error, failedAt, costUsd, errors, doneAgents, turns }
  }

  start() {
    this.timer = setInterval(() => this.tick(), 3000);
    this.timer.unref?.();
    return this;
  }

  setView(clientId, id) {
    const before = this.views.get(clientId);
    if (id) this.views.set(clientId, id); else this.views.delete(clientId);
    if (id && id !== before) setTimeout(() => this.tick(), 50);
  }
  dropClient(clientId) { this.views.delete(clientId); }
  shown() { return new Set(this.views.values()); }

  _s(id) {
    if (!this.st.has(id)) this.st.set(id, { brief: null, history: [], records: -1, fp: null, seq: 0, updatedAt: 0, pending: false, error: null, failedAt: 0, costUsd: 0, errors: 0, doneAgents: 0, turns: 0 });
    return this.st.get(id);
  }

  publicBrief(id) {
    const s = this.st.get(id);
    const entry = this.index.loaded.get(id);
    if (!s) return { id, brief: null, history: [], pending: false, error: null, updatedAt: 0, enabled: this.enabled };
    return {
      id, brief: s.brief, history: s.history, pending: s.pending, error: s.error, updatedAt: s.updatedAt, costUsd: s.costUsd,
      stale: entry ? entry.state.meta.records !== s.records : false, enabled: this.enabled,
    };
  }

  all() {
    const out = {};
    for (const id of this.st.keys()) out[id] = this.publicBrief(id);
    return out;
  }

  /** Something the pilot should hear about soon: a turn end, a new error, a finished subagent. */
  _triggered(entry, s) {
    const m = entry.state.meta;
    return m.errors > s.errors || m.doneAgents.size > s.doneAgents || (!m.inTurn && m.turns > s.turns) || m.turns > s.turns + 1;
  }

  _due(id, entry, isShown, now) {
    const s = this.st.get(id);
    if (s?.pending) return false;
    if (s && entry.state.meta.records === s.records) return false;      // nothing new
    if (s?.brief && this._fingerprint(entry) === s.fp) {                 // new records, nothing visible
      s.records = entry.state.meta.records;
      return false;
    }
    if (this.narrator.blocked(now)) return false;
    if (s?.failedAt && now - s.failedAt < RETRY_MS) return false;
    const phase = this.index.brief(id)?.phase;
    const since = now - (s?.updatedAt || 0);
    const trig = s ? this._triggered(entry, s) : true;
    if (isShown) {
      if (!s?.brief) return true;
      if (phase === 'working') return since >= (trig ? SHOWN_TRIGGER_MS : SHOWN_WORKING_MS);
      return true;
    }
    if (entry.kind !== 'session' || !this.index.registry.get(id)?.alive || this.isHidden(id)) return false;
    if (phase !== 'working') return false;
    return since >= (trig ? BACKGROUND_TRIGGER_MS : BACKGROUND_MS);
  }

  _fingerprint(entry) {
    return digest(entry.state.events.slice(-FINGERPRINT_EVENTS), Infinity);
  }

  tick() {
    if (!this.enabled) return;
    const now = Date.now();
    const shown = this.shown();
    for (const [id, entry] of this.index.loaded) {
      if (this._due(id, entry, shown.has(id), now)) this._run(id);
    }
  }

  /** Manual refresh from the UI; ignores cadence but not an in-flight call. */
  refresh(id) {
    const entry = this.index.load(id);
    if (!entry) return false;
    if (this.st.get(id)?.pending) return true;
    this._run(id);
    return true;
  }

  _prompt(id, entry, s) {
    const st = entry.state;
    const sum = this.index.summary(id) || {};
    const h = this.index.brief(id) || {};
    const lines = [];
    lines.push(`Session: ${sum.title || id}`);
    if (sum.cwd) lines.push(`Directory: ${sum.cwd}${h.branch ? ` (branch ${h.branch})` : ''}${h.pr ? `, PR #${h.pr.number}` : ''}`);
    lines.push(`State now: ${h.state || 'unknown'}${h.detail ? ' — ' + h.detail : ''}`);
    const subs = sum.subagents || [];
    if (subs.length) {
      lines.push(`Subagents (${subs.length}): ` + subs.slice(0, 15).map(a => `"${a.title}" ${a.status}`).join('; '));
    }
    lines.push('');
    if (s.brief) {
      lines.push('Previous brief (update it):');
      lines.push(JSON.stringify(s.brief));
      lines.push('');
      const fresh = st.events.filter(e => e.seq > s.seq);
      // Tools that were still running last time report their results as
      // updates, not new events, so re-show the recent tail as well.
      const tailFrom = Math.max(0, st.events.length - 12);
      const tail = st.events.slice(tailFrom).filter(e => e.seq <= s.seq);
      if (tail.length) { lines.push('Most recent events already covered (for current status):'); lines.push(digest(tail, 4000)); lines.push(''); }
      lines.push(`Events since the previous brief (${fresh.length}):`);
      lines.push(digest(fresh, 30_000) || '(none; only results of running tools changed)');
    } else {
      lines.push('Transcript to date:');
      lines.push(digest(st.events, 45_000));
    }
    return lines.join('\n');
  }

  async _run(id) {
    const entry = this.index.loaded.get(id) || this.index.load(id);
    if (!entry) return;
    const s = this._s(id);
    const m = entry.state.meta;
    const snapshot = { records: m.records, fp: this._fingerprint(entry), seq: entry.state.seq, errors: m.errors, doneAgents: m.doneAgents.size, turns: m.turns };
    const prompt = this._prompt(id, entry, s);
    s.pending = true; s.error = null;
    this.emit('brief', this.publicBrief(id));
    try {
      const r = await this.narrator.run({ system: SYSTEM, prompt, model: this.narrator.briefModel, thinking: false, purpose: 'brief' });
      const j = extractJson(r.text);
      if (!j?.summary) throw new Error('the model reply was not a brief');
      if (s.brief) s.history = [{ brief: s.brief, updatedAt: s.updatedAt }, ...s.history].slice(0, HISTORY);
      Object.assign(s, snapshot, { brief: normalize(j), updatedAt: Date.now(), error: null, failedAt: 0 });
      s.costUsd += r.costUsd;
    } catch (e) {
      s.error = e.message; s.failedAt = Date.now();
    } finally {
      s.pending = false;
      this.emit('brief', this.publicBrief(id));
    }
  }

  forget(id) { this.st.delete(id); }
}
