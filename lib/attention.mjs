// lib/attention.mjs — "Needs you": the moments a live session wants the pilot.
//
// Every live session has a signal (lib/brief.mjs): input, error, working,
// done or ended. Input and error mean the session needs you. This watches the
// signals across sessions and turns each change into an entry:
//
//   { id, title, project, signal, from, need, needsYou, priority, say, at }
//
// `say` is one short sentence meant to be spoken; `priority` (high, normal,
// low) lets a narrator decide what to read aloud and what to let pass. The UI
// shows the current needs; the same entries are what narration will consume.
import { EventEmitter } from 'node:events';

const LOG_MAX = 100;
// A change is announced once it has held this long. The deck learns that a
// turn ended a moment before the transcript shows the question that ended
// it, so without this a session would "finish" and then "ask" in one breath.
const SETTLE_MS = 1000;
export const NEEDS_YOU = new Set(['input', 'error']);

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** One sentence for the ear: who, then what. */
export function sayFor(title, signal, need, from) {
  const who = clip(title || 'A session', 60);
  if (signal === 'input' && need?.kind === 'permission') return `${who} needs your permission: ${clip(need.text, 120)}.`;
  if (signal === 'input') return `${who} is asking: ${clip(need?.text, 160)}`;
  if (signal === 'error') return `${who} hit an error: ${clip(need?.text, 140)}.`;
  if (signal === 'done') return from === 'working' ? `${who} finished.` : `${who} is done.`;
  if (signal === 'working') return NEEDS_YOU.has(from) ? `${who} is working again.` : `${who} started working.`;
  if (signal === 'ended') return `${who} ended.`;
  return null;
}

const PRIORITY = { input: 'high', error: 'high', done: 'normal', working: 'low', ended: 'low' };

export class Attention extends EventEmitter {
  constructor() {
    super();
    this.cur = new Map();   // id -> { signal, key, entry }
    this.pending = new Map();   // id -> { key, at }: a change waiting to settle
    this.log = [];
  }

  /**
   * Feed the live sessions (snapshot summaries carrying `glance`). The first
   * sighting of a session records its state without announcing it, so a
   * restart does not read out everything at once.
   */
  observe(sessions, now = Date.now()) {
    const seen = new Set();
    for (const s of sessions) {
      const g = s.glance;
      if (!g?.signal) continue;
      seen.add(s.id);
      const key = `${g.signal}|${g.need?.kind || ''}|${g.need?.text || ''}`;
      const prev = this.cur.get(s.id);
      if (prev?.key === key) { this.pending.delete(s.id); continue; }
      if (prev) {
        const p = this.pending.get(s.id);
        if (!p || p.key !== key) { this.pending.set(s.id, { key, at: now }); continue; }
        if (now - p.at < SETTLE_MS) continue;
        this.pending.delete(s.id);
      }
      const entry = {
        id: s.id, title: s.title, project: s.project || null, signal: g.signal, from: prev?.signal || null,
        need: g.need || null, needsYou: NEEDS_YOU.has(g.signal), priority: PRIORITY[g.signal] || 'low',
        say: sayFor(s.title, g.signal, g.need, prev?.signal), at: now, initial: !prev,
      };
      this.cur.set(s.id, { signal: g.signal, key, entry });
      if (!prev) continue;
      this.log.push(entry);
      if (this.log.length > LOG_MAX) this.log.shift();
      this.emit('attention', entry);
    }
    for (const id of this.cur.keys()) if (!seen.has(id)) { this.cur.delete(id); this.pending.delete(id); }
  }

  /** Sessions that need you now, longest-waiting first. */
  needs() {
    return [...this.cur.values()].map(x => x.entry).filter(e => e.needsYou)
      .sort((a, b) => (Date.parse(a.need?.since || '') || a.at) - (Date.parse(b.need?.since || '') || b.at));
  }

  view() { return { needs: this.needs(), log: this.log.slice(-30) }; }
}
