// lib/live.mjs — what a deck-launched Claude session shows before its
// transcript does, and what the transcript never shows at all.
//
//   the live strip   the reply being written (lib/harness/claude.mjs 'live'),
//                    what the CLI is doing (requesting, compacting) and the
//                    thinking-token estimate. Transient: sent as `live` over
//                    SSE, throttled, only the tail of each block.
//   hook runs        one `system/hook` event per run, pushed into the
//                    session's events (SessionIndex.pushSide) and kept in a
//                    side file per session, since no transcript holds them.
//
// Sessions run elsewhere (a terminal) have neither: the deck sees only their
// transcript.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// The tail of each streaming block the UI gets: a glance, not the reply; the
// whole text arrives from the transcript a moment after the block ends.
export const TAIL_CHARS = 600;
export const THROTTLE_MS = 150;

const SAFE_ID = /^[\w-]{1,128}$/;
const iso = (ms) => new Date(ms).toISOString();

/** One hook run as a normalized event (lib/transcript.mjs shape). */
export function hookEvent(h, startedAt = null) {
  const done = h.phase === 'response';
  const failed = done && (h.outcome && h.outcome !== 'success' || (h.exitCode != null && h.exitCode !== 0));
  const head = `${h.name}${done ? (failed ? ` · ${h.outcome && h.outcome !== 'success' ? h.outcome : `exit ${h.exitCode}`}` : '') : ' · running'}`;
  const out = [h.stdout, h.stderr].map(s => (s || '').trim()).filter(Boolean).join('\n');
  return {
    id: `hook-${h.id}`, ts: iso(startedAt ?? h.at), kind: 'system', subtype: 'hook',
    text: out ? `${head}\n${out}` : head,
    hook: { name: h.name, event: h.event, outcome: h.outcome, exitCode: h.exitCode, stdout: h.stdout, stderr: h.stderr,
      durationMs: done && startedAt != null ? h.at - startedAt : null, pending: !done },
    ...(failed ? { error: true } : {}),
  };
}

/** A session's live state as the UI gets it. */
export function liveView(s, tail = TAIL_CHARS) {
  const blocks = (s.msg?.blocks || []).filter(Boolean).map(b => ({
    type: b.type, name: b.name || null, tokens: b.tokens ?? null, chars: b.text.length,
    text: b.text.length > tail ? '…' + b.text.slice(-tail) : b.text,
  }));
  return { id: s.id, status: s.status || null, thinking: s.thinking ?? null, blocks, at: s.at };
}

export class Live extends EventEmitter {
  /**
   * agents: lib/agent.mjs (its 'proc' events); index: lib/sessions.mjs;
   * dir: where side files go (one jsonl per session), null for none.
   */
  constructor({ agents, index, dir = null, throttleMs = THROTTLE_MS } = {}) {
    super();
    this.index = index;
    this.dir = dir;
    this.throttleMs = throttleMs;
    this.sessions = new Map();   // session id -> { id, msg, status, thinking, at, timer, hooks: Map(hook id -> started at) }
    // Only the Claude driver emits live/status/hook; for the rest this is an idle entry until exit.
    agents?.on('proc', ({ id, proc }) => this.attach(id, proc));
    if (index) index.sideEvents = (id) => this.read(id);
  }

  /** Follow one session's process. */
  attach(id, proc) {
    if (!proc?.on) return;
    const s = { id, msg: null, status: null, thinking: null, at: Date.now(), timer: null, hooks: new Map() };
    this.sessions.set(id, s);
    proc.on('init', ({ sessionId } = {}) => {
      // A resume may come back under a new id.
      if (!sessionId || sessionId === s.id) return;
      this.sessions.delete(s.id); this._send(s, true, true);
      s.id = sessionId; this.sessions.set(sessionId, s);
    });
    proc.on('live', (msg) => {
      // The CLI says when it starts requesting, never when the reply begins.
      if (msg && s.status === 'requesting') s.status = null;
      s.msg = msg; if (!msg) s.thinking = null;
      this._send(s, !msg);
    });
    proc.on('result', () => { if (s.status || s.msg) { s.status = null; s.msg = null; s.thinking = null; this._send(s, true); } });
    proc.on('status', ({ status }) => { s.status = status; this._send(s, true); });
    proc.on('thinking', ({ tokens }) => { s.thinking = tokens; this._send(s); });
    proc.on('hook', (h) => this._hook(s, h));
    proc.on('exit', () => {
      clearTimeout(s.timer);
      if (this.sessions.get(s.id) === s) this.sessions.delete(s.id);
      this.emit('update', { id: s.id, gone: true });
    });
  }

  /** Every session with something live, for a client that just connected. */
  snapshot() { return [...this.sessions.values()].filter(s => s.msg || s.status).map(s => liveView(s)); }

  /** Throttled 'update'; `now` skips the wait (a block ended, the status moved). */
  _send(s, now = false, gone = false) {
    if (gone) { clearTimeout(s.timer); s.timer = null; this.emit('update', { id: s.id, gone: true }); return; }
    s.at = Date.now();
    if (now) { clearTimeout(s.timer); s.timer = null; this.emit('update', liveView(s)); return; }
    if (s.timer) return;
    s.timer = setTimeout(() => { s.timer = null; if (this.sessions.get(s.id) === s) this.emit('update', liveView(s)); }, this.throttleMs);
    s.timer.unref?.();
  }

  _hook(s, h) {
    if (!h?.id) return;
    let started = s.hooks.get(h.id);
    if (h.phase === 'started') { started = h.at; s.hooks.set(h.id, started); }
    else s.hooks.delete(h.id);
    const ev = hookEvent(h, started);
    if (h.phase === 'response') this._append(s.id, ev);
    this.index?.pushSide?.(s.id, [ev]);
  }

  // ------------------------------------------------------------ side files

  _file(id) { return this.dir && SAFE_ID.test(id) ? path.join(this.dir, `${id}.jsonl`) : null; }

  _append(id, ev) {
    const f = this._file(id);
    if (!f) return;
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(f, JSON.stringify(ev) + '\n'); }
    catch { /* the row still shows; it just will not survive a restart */ }
  }

  /** A session's kept events, oldest first; [] when it has none. */
  read(id) {
    const f = this._file(id);
    if (!f) return [];
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const ev = JSON.parse(line); if (ev?.id && ev.kind) out.push(ev); } catch { /* a torn last line */ }
    }
    return out;
  }
}
