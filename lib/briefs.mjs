// lib/briefs.mjs — the generated Brief: a model-written summary of a session
// to date. It refreshes on events that change the story, not on a clock:
//
//   handoff     the agent stopped and it is your move (turn end, a question,
//               an ending); not a permission prompt, the status line has those
//   subagent    a subagent finished
//   milestone   a commit, push, PR or publish (shown sessions only)
//   drift       enough work piled up mid-turn (see public/activity.js for the
//               weights: edits and commands count, reads barely do)
//   heartbeat   a long turn with some new work, so a shown brief is never
//               more than 10 minutes behind
//
// Shown sessions use all five; live sessions in the background only handoff,
// subagent and a slower drift; anything else is paused until opened. A
// refresh is skipped when nothing the model would see has changed (sideband
// records such as queue or snapshot entries bump the record count without
// adding events). Each refresh sends the previous brief plus only the events
// since it, and the last few briefs are kept so the UI can step back.
// Emits 'brief' (publicBrief) whenever a brief starts, lands or fails.
import { EventEmitter } from 'node:events';
import { digest } from './digest.mjs';
import { extractJson } from './narrator.mjs';
import { activitySince, CADENCE as C } from '../public/activity.js';

const RETRY_MS = 60_000;
const HISTORY = 6;
// Events whose digest decides whether a refresh would tell the model anything new.
const FINGERPRINT_EVENTS = 40;

const SYSTEM = `You keep a live brief of a coding-agent session for the person supervising it.
Reply with ONLY one JSON object, no prose, no code fence:
{"summary": "1-2 sentences: the goal, and where the work stands now",
 "progress": {"unit": "plural noun for the countable work items, e.g. issues, tests, files", "segments": [{"label": "merged", "count": 5, "tone": "done"}]} or null,
 "done": ["up to 5 things completed, most important first"],
 "doing": ["up to 3 things in progress right now"],
 "planned": ["up to 4 things still to do, in order"],
 "notes": [{"kind": "failure|risk|question|decision", "text": "one sentence the supervisor should know", "seq": 123}]}
Rules:
- Use only what the transcript shows. Never invent numbers, files or outcomes.
- Be concrete: name issues, PRs, files, commands, test counts.
- progress only when the work really has countable units; tones are done, active (being finished now), working (in progress), todo, failed. Counts must add up to the total.
- notes: up to 3, most important first, only for what the supervisor may need to act on now: a failure not yet fixed, a risky or destructive action, a question left open for them, a decision taken that they should know about. Not for tool errors the agent already worked past. Usually empty.
- note seq is the #number of the event the note is about (the failure, the question, the decision), or null.
- Drop a note from the previous brief once the transcript shows it resolved.
- Plain text inside strings, no markdown. Keep list items under 12 words.
- done is only what is finished; doing is what is underway now (empty when the agent is idle); planned is only what the transcript says comes next, never guessed.
- When a previous brief is given, update it: keep what is still true, change what moved on.`;

const TONES = new Set(['done', 'active', 'working', 'todo', 'failed']);
// Note kinds, most urgent first: the order notes are shown in.
export const NOTE_KINDS = ['failure', 'risk', 'question', 'decision'];

/**
 * The model's reply in the brief's shape. Older replies still read: one
 * `next` sentence becomes the first planned item, one `watch` a risk note.
 * `seqs`, when given, is the set of event numbers that exist; a note pointing
 * anywhere else loses its link rather than jumping nowhere.
 */
export function normalize(j, seqs = null) {
  const str = (v, max = 600) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const list = (v, n) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => str(x, 160)).filter(Boolean).slice(0, n);
  const planned = list(j.planned ?? j.next, 4);
  const out = {
    summary: str(j.summary, 1200),
    done: list(j.done, 5),
    doing: list(j.doing, 3),
    planned,
    notes: [],
    progress: null,
  };
  const raw = Array.isArray(j.notes) ? j.notes : j.watch ? [{ kind: 'risk', ...j.watch }] : [];
  out.notes = raw.filter(n => n && str(n.text)).slice(0, 3).map((n, i) => ({
    kind: NOTE_KINDS.includes(n.kind) ? n.kind : 'risk',
    text: str(n.text, 300),
    seq: Number.isInteger(n.seq) && (!seqs || seqs.has(n.seq)) ? n.seq : null,
    i,
  })).sort((a, b) => NOTE_KINDS.indexOf(a.kind) - NOTE_KINDS.indexOf(b.kind) || a.i - b.i).map(({ i, ...n }) => n);
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
    this.st = new Map();         // id -> { brief, history, records, fp, seq, phase, reason, count, updatedAt, pending, error, failedAt, costUsd, doneAgents, turns }
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
    if (!this.st.has(id)) this.st.set(id, { brief: null, history: [], records: -1, fp: null, seq: 0, phase: null, reason: null, count: 0, updatedAt: 0, pending: false, error: null, failedAt: 0, costUsd: 0, doneAgents: 0, turns: 0 });
    return this.st.get(id);
  }

  publicBrief(id) {
    const s = this.st.get(id);
    const entry = this.index.loaded.get(id);
    if (!s) return { id, brief: null, history: [], pending: false, error: null, updatedAt: 0, seq: 0, count: 0, enabled: this.enabled };
    return {
      id, brief: s.brief, history: s.history, pending: s.pending, error: s.error, updatedAt: s.updatedAt, costUsd: s.costUsd,
      seq: s.seq, reason: s.reason, count: s.count,
      stale: entry ? entry.state.meta.records !== s.records : false, enabled: this.enabled,
    };
  }

  all() {
    const out = {};
    for (const id of this.st.keys()) out[id] = this.publicBrief(id);
    return out;
  }

  /**
   * Why a session's brief should refresh now, or null. Reasons are the ones
   * listed at the top of this file, plus 'first' and 'idle' (new activity on
   * a shown session that is not working).
   */
  _due(id, entry, isShown, now) {
    const s = this.st.get(id);
    if (s?.pending) return null;
    if (s && entry.state.meta.records === s.records) return null;       // nothing new
    if (s?.brief && this._fingerprint(entry) === s.fp) {                 // new records, nothing visible
      s.records = entry.state.meta.records;
      return null;
    }
    if (this.narrator.blocked(now)) return null;
    if (s?.failedAt && now - s.failedAt < RETRY_MS) return null;
    const live = entry.kind === 'session' && this.index.registry.get(id)?.alive && !this.isHidden(id);
    if (!isShown && !live) return null;
    if (isShown && !s?.brief) return 'first';

    const m = entry.state.meta;
    const h = this.index.brief(id) || {};
    const since = now - (s?.updatedAt || 0);
    if (since < C.minGapMs) return null;
    // A permission prompt is a pause inside the turn, not a handoff.
    const settled = h.phase !== 'working' && h.state !== 'needs permission';
    const handoff = settled && (!s || s.phase === 'working' || m.turns > s.turns);
    if (handoff) return 'handoff';
    const act = activitySince(entry.state.events, s?.seq || 0);
    if (m.doneAgents.size > (s?.doneAgents || 0) && since >= C.triggerGapMs) return 'subagent';
    if (!isShown) return h.phase === 'working' && act.score >= C.driftScore && since >= C.backgroundDriftMs ? 'drift' : null;
    if (settled) return act.events ? 'idle' : null;
    if (act.milestones.length && since >= C.triggerGapMs) return 'milestone';
    if (act.score >= C.driftScore && since >= C.driftMs) return 'drift';
    if (act.score >= C.heartbeatScore && since >= C.heartbeatMs) return 'heartbeat';
    return null;
  }

  _fingerprint(entry) {
    return digest(entry.state.events.slice(-FINGERPRINT_EVENTS), Infinity);
  }

  tick() {
    if (!this.enabled) return;
    const now = Date.now();
    const shown = this.shown();
    for (const [id, entry] of this.index.loaded) {
      const why = this._due(id, entry, shown.has(id), now);
      if (why) this._run(id, why);
    }
  }

  /** Manual refresh from the UI; ignores cadence but not an in-flight call. */
  refresh(id) {
    const entry = this.index.load(id);
    if (!entry) return false;
    if (this.st.get(id)?.pending) return true;
    this._run(id, 'manual');
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
      const tailFrom = Math.max(0, st.events.length - 8);
      const tail = st.events.slice(tailFrom).filter(e => e.seq <= s.seq);
      if (tail.length) { lines.push('Most recent events already covered (for current status):'); lines.push(digest(tail, 2000)); lines.push(''); }
      lines.push(`Events since the previous brief (${fresh.length}):`);
      lines.push(digest(fresh, 30_000) || '(none; only results of running tools changed)');
    } else {
      lines.push('Transcript to date:');
      lines.push(digest(st.events, 45_000));
    }
    return lines.join('\n');
  }

  async _run(id, reason) {
    const entry = this.index.loaded.get(id) || this.index.load(id);
    if (!entry) return;
    const s = this._s(id);
    const m = entry.state.meta;
    const snapshot = { records: m.records, fp: this._fingerprint(entry), seq: entry.state.seq, phase: this.index.brief(id)?.phase || null, reason, doneAgents: m.doneAgents.size, turns: m.turns };
    const prompt = this._prompt(id, entry, s);
    s.pending = true; s.error = null;
    this.emit('brief', this.publicBrief(id));
    try {
      const r = await this.narrator.run({ system: SYSTEM, prompt, model: this.narrator.briefModel, thinking: false, purpose: 'brief' });
      const j = extractJson(r.text);
      if (!j?.summary) throw new Error('the model reply was not a brief');
      if (s.brief) s.history = [{ brief: s.brief, updatedAt: s.updatedAt }, ...s.history].slice(0, HISTORY);
      Object.assign(s, snapshot, { brief: normalize(j, new Set(entry.state.events.map(e => e.seq))), updatedAt: Date.now(), error: null, failedAt: 0, count: s.count + 1 });
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
