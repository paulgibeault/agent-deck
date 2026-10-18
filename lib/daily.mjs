// lib/daily.mjs — what each backend has used today, for the main menu.
//
// Claude Code sessions: every API response in today's transcripts (sessions
// and their subagents), read incrementally (a byte offset per file, never
// re-read) and priced at API list rates (public/pricing.js), since a plan is
// not billed per token. Streamed sessions (ACP) report tokens per turn; a
// local model costs nothing. Counted once per response id.
import fs from 'node:fs';
import { costOf } from '../public/pricing.js';

const startOfDay = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const empty = () => ({ sessions: new Set(), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, unpriced: 0 });

export class DailyUsage {
  constructor() { this._reset(startOfDay()); }

  _reset(day) {
    this.day = day;
    this.files = new Map();   // file -> { offset, partial }
    this.seen = new Set();    // response ids counted
    this.claude = empty();
  }

  /** Count what `file` gained since last time (only today's responses). */
  _scan(file, sessionId) {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.mtimeMs < this.day) return;
    let f = this.files.get(file);
    if (!f || st.size < f.offset) { f = { offset: 0, partial: '' }; this.files.set(file, f); }
    if (st.size === f.offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(8 << 20, st.size - f.offset));
      while (f.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - f.offset), f.offset);
        if (!n) break;
        f.offset += n;
        const lines = (f.partial + buf.toString('utf8', 0, n)).split('\n');
        f.partial = lines.pop();
        for (const l of lines) if (l.includes('"assistant"') && l.includes('"usage"')) this._record(l, sessionId);
      }
    } finally { fs.closeSync(fd); }
  }

  _record(line, sessionId) {
    let rec; try { rec = JSON.parse(line); } catch { return; }
    const msg = rec.message;
    if (rec.type !== 'assistant' || !msg?.usage || !msg.id || this.seen.has(msg.id)) return;
    if (Date.parse(rec.timestamp) < this.day) return;
    this.seen.add(msg.id);
    const u = msg.usage; const cc = u.cache_creation || {};
    const usage = { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
      cacheWrite1h: cc.ephemeral_1h_input_tokens || 0, output: u.output_tokens || 0 };
    const t = this.claude;
    t.sessions.add(sessionId); t.calls++;
    t.input += usage.input; t.cacheRead += usage.cacheRead; t.cacheWrite += usage.cacheWrite; t.output += usage.output;
    const c = msg.model === '<synthetic>' ? null : costOf(msg.model, usage, u.speed);
    if (c) t.costUsd += c.total; else if (msg.model !== '<synthetic>') t.unpriced++;
  }

  /**
   * `files`: [{ file, sessionId }] transcripts to read (Claude Code's);
   * `streams`: [{ sessionId, harness, events }] for sessions with no file.
   * Returns { day, backends: { [harness]: { sessions, calls, input, cacheRead, cacheWrite, output, costUsd, unpriced } } }.
   */
  today(files = [], streams = []) {
    const day = startOfDay();
    if (day !== this.day) this._reset(day);
    for (const { file, sessionId } of files) if (file) this._scan(file, sessionId);
    const pub = (t) => ({ ...t, sessions: t.sessions.size });
    const by = {};
    // Streamed sessions are in memory: summed fresh each time from their turn ends.
    for (const { sessionId, harness, events } of streams) {
      for (const ev of events) {
        if (ev.kind !== 'turn_end' || !ev.usage || Date.parse(ev.ts) < day) continue;
        const t = by[harness] ||= empty();
        t.sessions.add(sessionId); t.calls++;
        t.input += ev.usage.input_tokens || 0; t.cacheRead += ev.usage.cache_read_input_tokens || 0; t.output += ev.usage.output_tokens || 0;
      }
    }
    const out = Object.fromEntries(Object.entries(by).map(([k, t]) => [k, pub(t)]));
    if (this.claude.calls) out.claude = pub(this.claude);
    return { day, backends: out };
  }
}
