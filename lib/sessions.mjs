// lib/sessions.mjs
//
// Session registry, buckets (active / recent / closed), subagent trees,
// on-demand transcript loading and live tailing. Emits:
//   'sessions'  ()                       the tree changed; call snapshot()
//   'events'    ({ sessionId, appended, updated })
//   'session'   ({ id, meta, brief })     metadata / brief changed
//
// Only lib/transcript.mjs knows the record shapes; this module only knows
// where the files live.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { SessionState, TranscriptTail, probeHead, probeTail, readAgentMeta } from './transcript.mjs';
import { computeBrief } from './brief.mjs';

const DAY = 86_400_000;

export function defaultClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function mtimeOf(file) {
  try { const st = fs.statSync(file); return { mtime: st.mtimeMs, size: st.size }; } catch { return { mtime: 0, size: 0 }; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export class SessionIndex extends EventEmitter {
  constructor({ claudeDir = defaultClaudeDir(), recentDays = 3, maxLoaded = 8, pollMs = 2000 } = {}) {
    super();
    this.claudeDir = claudeDir;
    this.projectsDir = path.join(claudeDir, 'projects');
    this.sessionsDir = path.join(claudeDir, 'sessions');
    this.recentDays = recentDays;
    this.maxLoaded = maxLoaded;
    this.pollMs = pollMs;

    this.registry = new Map();   // sessionId -> registry entry (+alive)
    this.files = new Map();      // sessionId -> { id, file, dir, projectDir, mtime, size, cwd, probe }
    this.agents = new Map();     // agentId -> { id, parentId, file, metaFile, meta, mtime, size }
    this.loaded = new Map();     // id -> { id, kind, parentId?, state, tail, file }
    this.pinned = new Set();     // ids that stay loaded (active sessions + their agents)
    this.lru = [];               // most recently used loaded ids (non-pinned)
    this.watchers = [];
    this.timers = new Map();
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    this.scanProjects();
    this.refreshRegistry();
    this.loadActive();
    this._watch();
    this.poll = setInterval(() => this.tick(), this.pollMs);
    this.poll.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.poll);
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }

  _watch() {
    const opts = { persistent: false, recursive: true };
    const on = (dir, fn) => {
      try {
        const w = fs.watch(dir, opts, (ev, filename) => this._debounce(`${dir}:${filename}`, () => fn(ev, filename || '')));
        w.on('error', () => { /* a vanished dir; the poll catches up */ });
        this.watchers.push(w);
      } catch { /* dir may not exist yet */ }
    };
    on(this.sessionsDir, () => this.refreshRegistry());
    on(this.projectsDir, (ev, filename) => this._onProjectChange(filename));
  }

  _debounce(key, fn, ms = 40) {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn(); }, ms));
  }

  _onProjectChange(filename) {
    const parts = filename.split(path.sep);
    // <slug>/<sessionId>.jsonl
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      const id = parts[1].slice(0, -6);
      if (!this.files.has(id)) { this.scanProjects(); this.emit('sessions'); return; }
      this._bumpFile(id);
      if (this.loaded.has(id)) this.tailOne(id);
      return;
    }
    // <slug>/<sessionId>/subagents/agent-<id>.(jsonl|meta.json)
    if (parts.length === 4 && parts[2] === 'subagents') {
      const sessionId = parts[1];
      const m = /^agent-([a-z0-9]+)\.(jsonl|meta\.json)$/.exec(parts[3]);
      if (!m) return;
      const agentId = m[1];
      if (!this.agents.has(agentId)) { this.scanAgents(sessionId); this.emit('sessions'); return; }
      const a = this.agents.get(agentId);
      if (m[2] === 'meta.json') { a.meta = readAgentMeta(a.metaFile); this.emit('sessions'); return; }
      Object.assign(a, mtimeOf(a.file));
      if (this.loaded.has(agentId)) this.tailOne(agentId); else this._debounce('tree', () => this.emit('sessions'), 500);
      return;
    }
    if (parts.length === 3 && parts[2] === 'custom-title.json') {
      const s = this.files.get(parts[1]);
      if (s) { s.probe.title = readJson(path.join(s.dir, 'custom-title.json'))?.customTitle || s.probe.title; this.emit('sessions'); }
    }
  }

  _bumpFile(id) {
    const s = this.files.get(id);
    if (!s) return;
    const before = s.mtime;
    Object.assign(s, mtimeOf(s.file));
    if (!this.loaded.has(id) && s.mtime !== before) this._debounce('tree', () => this.emit('sessions'), 500);
  }

  tick() {
    const changedRegistry = this.refreshRegistry(true);
    for (const id of this.loaded.keys()) this.tailOne(id);
    if (changedRegistry) this.loadActive();
    // Re-evaluate briefs of active sessions (idle timers, subagent heartbeats).
    for (const id of this.registry.keys()) if (this.loaded.has(id)) this._emitSession(id);
  }

  // ------------------------------------------------------------- scanning

  scanProjects() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return; }
    for (const slug of dirs) {
      const projectDir = path.join(this.projectsDir, slug);
      let entries = [];
      try { entries = fs.readdirSync(projectDir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -6);
        const file = path.join(projectDir, name);
        const existing = this.files.get(id);
        const { mtime, size } = mtimeOf(file);
        if (existing) { existing.mtime = mtime; existing.size = size; continue; }
        const dir = path.join(projectDir, id);
        const head = probeHead(file);
        const tail = probeTail(file);
        const customTitle = readJson(path.join(dir, 'custom-title.json'))?.customTitle;
        if (customTitle) tail.title = customTitle;
        this.files.set(id, { id, file, dir, projectDir, slug, mtime, size, cwd: head.cwd, probe: tail });
        this.scanAgents(id);
      }
    }
  }

  scanAgents(sessionId) {
    const s = this.files.get(sessionId);
    if (!s) return;
    const subDir = path.join(s.dir, 'subagents');
    let entries = [];
    try { entries = fs.readdirSync(subDir); } catch { return; }
    for (const name of entries) {
      const m = /^agent-([a-z0-9]+)\.jsonl$/.exec(name);
      if (!m) continue;
      const agentId = m[1];
      const file = path.join(subDir, name);
      const metaFile = path.join(subDir, `agent-${agentId}.meta.json`);
      const a = this.agents.get(agentId) || { id: agentId, parentId: sessionId, file, metaFile, meta: readAgentMeta(metaFile) };
      Object.assign(a, mtimeOf(file));
      if (!Object.keys(a.meta).length) a.meta = readAgentMeta(metaFile);
      this.agents.set(agentId, a);
    }
  }

  /** Re-read ~/.claude/sessions/*.json. Returns true if liveness changed. */
  refreshRegistry(quiet = false) {
    let entries = [];
    try { entries = fs.readdirSync(this.sessionsDir).filter(n => n.endsWith('.json')); } catch { /* none */ }
    const seen = new Set();
    let changed = false;
    for (const name of entries) {
      const reg = readJson(path.join(this.sessionsDir, name));
      if (!reg?.sessionId) continue;
      const alive = pidAlive(reg.pid);
      const prev = this.registry.get(reg.sessionId);
      seen.add(reg.sessionId);
      if (!prev || prev.alive !== alive || prev.status !== reg.status || prev.name !== reg.name || prev.statusUpdatedAt !== reg.statusUpdatedAt) changed = true;
      this.registry.set(reg.sessionId, { ...reg, alive });
      if (!this.files.has(reg.sessionId)) this.scanProjects();
    }
    for (const id of [...this.registry.keys()]) {
      if (!seen.has(id)) { this.registry.delete(id); changed = true; }
    }
    if (changed) this.emit('sessions');
    return changed;
  }

  // -------------------------------------------------------------- loading

  loadActive() {
    for (const [id, reg] of this.registry) {
      if (!reg.alive) continue;
      if (!this.loaded.has(id)) this.load(id);
      this.pinned.add(id);
      for (const a of this.agents.values()) if (a.parentId === id) { if (!this.loaded.has(a.id)) this.load(a.id); this.pinned.add(a.id); }
    }
    for (const id of [...this.pinned]) {
      const reg = this.registry.get(id) || this.registry.get(this.agents.get(id)?.parentId);
      if (!reg?.alive) this.pinned.delete(id);
    }
  }

  /** Load (parse fully) a session or subagent by id. Idempotent. */
  load(id) {
    if (this.loaded.has(id)) { this._touchLru(id); return this.loaded.get(id); }
    let file, kind, parentId = null;
    if (this.files.has(id)) { file = this.files.get(id).file; kind = 'session'; }
    else if (this.agents.has(id)) { const a = this.agents.get(id); file = a.file; kind = 'agent'; parentId = a.parentId; }
    else return null;
    const state = new SessionState(id);
    const tail = new TranscriptTail(file);
    const entry = { id, kind, parentId, state, tail, file };
    for (const rec of tail.readNew()) state.ingest(rec);
    this._linkAgents(entry, state.events);
    this.loaded.set(id, entry);
    this._touchLru(id);
    this._evict();
    return entry;
  }

  _touchLru(id) {
    if (this.pinned.has(id)) return;
    this.lru = this.lru.filter(x => x !== id);
    this.lru.push(id);
  }

  _evict() {
    while (this.lru.length > this.maxLoaded) {
      const id = this.lru.shift();
      if (!this.pinned.has(id)) this.loaded.delete(id);
    }
  }

  /** Pull new records for one loaded transcript and broadcast them. */
  tailOne(id) {
    const entry = this.loaded.get(id);
    if (!entry) return;
    const recs = entry.tail.readNew();
    if (!recs.length) return;
    const appended = []; const updated = []; let metaChanged = false;
    for (const rec of recs) {
      const r = entry.state.ingest(rec);
      appended.push(...r.appended); updated.push(...r.updated);
      metaChanged ||= r.metaChanged;
    }
    const f = this.files.get(id) || this.agents.get(id);
    if (f) Object.assign(f, mtimeOf(f.file));
    if (entry.kind === 'session') { this.scanAgents(id); this._linkAgents(entry, [...appended, ...updated]); }
    if (appended.length || updated.length) this.emit('events', { sessionId: id, appended: appended.map(stripForWire), updated: updated.map(stripForWire) });
    if (metaChanged || appended.length) this._emitSession(id);
    // A subagent heartbeat changes its parent's brief too.
    if (entry.kind === 'agent' && this.loaded.has(entry.parentId)) this._emitSession(entry.parentId);
  }

  /**
   * Attach agentIds to Agent tool events using the subagent meta files
   * (toolUseId → agentId). Sync agents never report their id in the tool
   * result, so this is the only link for them. Also marks finished ones.
   */
  _linkAgents(entry, events) {
    if (entry.kind !== 'session') return;
    let byToolUse = null;
    for (const ev of events) {
      if (ev.kind !== 'tool' || ev.tool.name !== 'Agent') continue;
      if (!byToolUse) {
        byToolUse = new Map();
        for (const a of this.agents.values()) if (a.parentId === entry.id && a.meta?.toolUseId) byToolUse.set(a.meta.toolUseId, a.id);
      }
      const agentId = ev.tool.agentId || byToolUse.get(ev.id);
      if (!agentId) continue;
      ev.tool.agentId = agentId;
      const m = entry.state.meta;
      m.subagents.delete(`pending:${ev.id}`);
      const sub = m.subagents.get(agentId) || { agentId, toolUseId: ev.id, description: ev.tool.input?.description, async: false, done: false };
      m.subagents.set(agentId, sub);
      if (!ev.tool.pending && !ev.tool.meta?.isAsync) { sub.done = true; m.doneAgents.add(agentId); }
    }
  }

  _emitSession(id) {
    const entry = this.loaded.get(id);
    if (!entry) return;
    this.emit('session', { id, meta: entry.state.publicMeta(), brief: this.brief(id), summary: this.summary(id) });
  }

  // -------------------------------------------------------------- queries

  /** Status for a subagent: running | done | stale | ended. */
  agentStatus(a) {
    const parentReg = this.registry.get(a.parentId);
    const parentLoaded = this.loaded.get(a.parentId);
    if (parentLoaded?.state.meta.doneAgents.has(a.id)) return 'done';
    const loaded = this.loaded.get(a.id);
    if (loaded && loaded.state.events.length) {
      // Subagent transcripts have no turn-end record; the final assistant
      // message carries stop_reason end_turn instead.
      const last = loaded.state.events.at(-1);
      if (last.kind === 'text' && last.stopReason === 'end_turn') return 'done';
    }
    if (!parentReg?.alive) return 'ended';
    const age = Date.now() - a.mtime;
    if (age < 120_000) return 'running';
    return 'stale';
  }

  agentSummary(a) {
    const meta = a.meta || {};
    const loaded = this.loaded.get(a.id);
    return {
      id: a.id, kind: 'agent', parentId: a.parentId,
      title: meta.description || (loaded?.state.title) || a.id,
      agentType: meta.agentType || null,
      cwd: meta.worktreePath || loaded?.state.meta.cwd || this.files.get(a.parentId)?.cwd || null,
      worktreeBranch: meta.worktreeBranch || null,
      spawnDepth: meta.spawnDepth ?? 1,
      requestShape: meta.requestShape || null,
      toolUseId: meta.toolUseId || null,
      status: this.agentStatus(a),
      mtime: a.mtime, size: a.size,
      loaded: !!loaded,
      gitBranch: loaded?.state.meta.gitBranch || meta.worktreeBranch || null,
      model: loaded?.state.meta.model || null,
      usage: loaded?.state.meta.usage || null,
      eventCount: loaded?.state.events.length ?? null,
    };
  }

  bucketOf(id) {
    const reg = this.registry.get(id);
    if (reg?.alive) return 'active';
    const f = this.files.get(id);
    if (f && Date.now() - f.mtime < this.recentDays * DAY) return 'recent';
    return 'closed';
  }

  summary(id) {
    const f = this.files.get(id);
    if (!f) { const a = this.agents.get(id); return a ? this.agentSummary(a) : null; }
    const reg = this.registry.get(id);
    const loaded = this.loaded.get(id);
    const m = loaded?.state.meta;
    const p = f.probe || {};
    const cwd = reg?.cwd || m?.cwd || f.cwd;
    const subagents = [...this.agents.values()].filter(a => a.parentId === id).map(a => this.agentSummary(a))
      .sort((a, b) => b.mtime - a.mtime);
    return {
      id, kind: 'session', bucket: this.bucketOf(id),
      title: reg?.name || loaded?.state.title || p.title || p.aiTitle || p.agentName || (p.lastPrompt ? p.lastPrompt.replace(/\s+/g, ' ').slice(0, 60) : null) || id.slice(0, 8),
      cwd, project: cwd ? path.basename(cwd) : f.slug,
      pid: reg?.pid ?? null, alive: !!reg?.alive,
      status: reg?.alive ? reg.status || null : null, statusUpdatedAt: reg?.statusUpdatedAt ?? null,
      startedAt: reg?.startedAt ?? null, entrypoint: reg?.entrypoint || null, sessionKind: reg?.kind || null,
      mtime: f.mtime, size: f.size,
      gitBranch: m?.gitBranch || p.gitBranch || null,
      pr: m?.pr || p.pr || null,
      model: m?.model || p.model || null,
      loaded: !!loaded,
      eventCount: loaded?.state.events.length ?? null,
      subagents,
      running: subagents.filter(s => s.status === 'running').length,
    };
  }

  snapshot() {
    const out = { active: [], recent: [], closed: [] };
    for (const id of this.files.keys()) {
      const s = this.summary(id);
      out[s.bucket].push(s);
    }
    out.active.sort((a, b) => (b.statusUpdatedAt || b.mtime) - (a.statusUpdatedAt || a.mtime));
    out.recent.sort((a, b) => b.mtime - a.mtime);
    out.closed.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  brief(id) {
    const entry = this.loaded.get(id);
    if (!entry) return null;
    const summary = this.summary(id);
    return computeBrief(entry.state, summary, this.registry.get(id) || null);
  }

  /** Normalized events for a session from sequence number `from` (exclusive). */
  events(id, from = 0, limit = 5000) {
    const entry = this.load(id);
    if (!entry) return null;
    const evs = entry.state.events;
    const start = from > 0 ? evs.findIndex(e => e.seq > from) : 0;
    const slice = start < 0 ? [] : evs.slice(start, start + limit);
    return { events: slice.map(stripForWire), total: evs.length, lastSeq: entry.state.seq, more: start >= 0 && start + limit < evs.length };
  }

  detail(id, eventId) { return this.load(id)?.state.detail(eventId) ?? null; }
  image(id, eventId, index) { return this.load(id)?.state.image(eventId, index) ?? null; }
  filesOf(id) { return this.load(id)?.state.filesList() ?? null; }
  metaOf(id) { return this.load(id)?.state.publicMeta() ?? null; }
  cwdOf(id) { return this.summary(id)?.cwd ?? null; }
}

/** Keep wire events small: inputs are capped, results already slimmed. */
function stripForWire(ev) {
  if (ev.kind !== 'tool') return ev;
  const input = ev.tool.input;
  let cap = input;
  const big = ['content', 'old_string', 'new_string', 'prompt', 'command'];
  for (const k of big) {
    if (typeof input?.[k] === 'string' && input[k].length > 20_000) {
      if (cap === input) cap = { ...input };
      cap[k] = input[k].slice(0, 20_000) + `\n…[${input[k].length} chars]`;
      cap._truncated = true;
    }
  }
  return cap === input ? ev : { ...ev, tool: { ...ev.tool, input: cap } };
}
