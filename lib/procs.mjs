// lib/procs.mjs — the processes behind the deck.
//
// One `ps` reads the whole host; attribute() ties processes back to what the
// deck knows: its own server, every live session's claude process, the Bash
// calls and background tasks those sessions run, the pilot's Shell runs and
// the deck's own `claude -p` calls. Everything descended from those is "the
// deck's" scope. Detail for one process (open files, sockets, environment) is
// read on demand. macOS and Linux; nothing here runs unless someone asks.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd, args, { timeout = 6000, maxBuffer = 64 << 20 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
    // lsof exits 1 when some files could not be read; what it did read still counts.
    if (err && !stdout) reject(err); else resolve(String(stdout));
  });
});

/** "[[dd-]hh:]mm:ss[.cc]" → seconds. Used for both elapsed and CPU time. */
export function parseClock(s) {
  if (!s || s === '-') return null;
  const [d, rest] = s.includes('-') ? s.split('-') : [0, s];
  const parts = rest.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Number(d) * 86400 + sec;
}

const PS_FIELDS = 'pid=,ppid=,pgid=,uid=,user=,state=,%cpu=,%mem=,rss=,vsz=,time=,etime=,args=';
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/;

/** Parse `ps -o PS_FIELDS` output (plus a pid → comm map) into process records. */
export function parsePs(text, comms = new Map(), now = Date.now()) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = +m[1];
    const etime = parseClock(m[12]);
    // ps writes control characters (a heredoc's newlines) as octal escapes.
    const args = (m[13] || '').replace(/\\(0[0-3][0-7])/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    const comm = comms.get(pid) || args.split(' ')[0] || '';
    out.set(pid, {
      pid, ppid: +m[2], pgid: +m[3], uid: +m[4], user: m[5], state: m[6], cpu: +m[7], mem: +m[8],
      rss: +m[9] * 1024, vsz: +m[10] * 1024, cputime: parseClock(m[11]),
      start: etime != null ? Math.round((now - etime * 1000) / 1000) * 1000 : null,
      name: path.basename(comm) || comm, comm, args,
    });
  }
  return out;
}
export function parseComms(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) out.set(+m[1], m[2].trim());
  }
  return out;
}

// Claude Code runs each Bash call as `zsh -c 'source <snapshot> … && eval '<cmd>' < /dev/null && pwd -P >| …'`.
const WRAPPER = /\/shell-snapshots\/snapshot-[^\s]+.*?\beval '((?:[^']|'"'"')*)'/s;
/** The command a Claude Code Bash wrapper runs, or null. */
export function bashCommand(args) {
  const m = WRAPPER.exec(args || '');
  return m ? m[1].replace(/'"'"'/g, "'") : null;
}
const RUNS_CLAUDE = /(?:^|\/)claude(?:\s|$)/;
const norm = (s) => String(s || '').trim();

/**
 * Tie processes to the deck. `procs`: pid → record. `known`:
 *   { deck: pid, sessions: [{ pid, sessionId, title, deck }], shell: [{ pid, runId, cmd }],
 *     work: (sessionId) => ({ tasks: [{ id, command, title, running }], calls: [{ id, command, title }] }),
 *     subagents: (sessionId) => [{ id, title, agentType }] }
 * Returns { tags: pid → tag, scope: Set(pid), virtual: [node] }.
 */
export function attribute(procs, known) {
  const kids = new Map();
  for (const p of procs.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const tags = new Map();
  const roots = [];
  const sessionOf = new Map();   // session pid -> session
  if (procs.has(known.deck)) { tags.set(known.deck, { kind: 'deck', label: 'agent-deck server' }); roots.push(known.deck); }
  for (const s of known.sessions || []) {
    if (!procs.has(s.pid)) continue;
    tags.set(s.pid, { kind: 'session', sessionId: s.sessionId, label: s.title || s.sessionId, deck: !!s.deck });
    sessionOf.set(s.pid, s);
    roots.push(s.pid);
  }
  for (const r of known.shell || []) {
    if (!procs.has(r.pid)) continue;
    tags.set(r.pid, { kind: 'shell', runId: r.runId, label: r.cmd });
    roots.push(r.pid);
  }
  const owner = (pid) => {   // the nearest session process above pid
    for (let p = procs.get(pid)?.ppid, n = 0; p && n < 64; p = procs.get(p)?.ppid, n++) if (sessionOf.has(p)) return sessionOf.get(p);
    return null;
  };
  const underWrapper = (pid) => {
    for (let p = procs.get(pid)?.ppid, n = 0; p && n < 64; p = procs.get(p)?.ppid, n++) if (tags.get(p)?.command != null) return true;
    return false;
  };
  const workCache = new Map();
  const workOf = (id) => { if (!workCache.has(id)) workCache.set(id, known.work?.(id) || { tasks: [], calls: [] }); return workCache.get(id); };
  const matchWork = (id, cmd, liveOnly) => {
    const w = workOf(id);
    const t = w.tasks.filter(x => !liveOnly || x.running).find(x => norm(x.command) === cmd);
    if (t) return { kind: 'task', sessionId: id, taskId: t.id, label: t.title || cmd };
    const c = liveOnly ? w.calls.find(x => norm(x.command) === cmd) : null;
    if (c) return { kind: 'tool', sessionId: id, toolUseId: c.id, label: c.title || cmd };
    return null;
  };
  // Shallow first, so a wrapper's own subshells (same args) are seen as inside it.
  const byDepth = [...procs.values()].map(p => ({ p, cmd: bashCommand(p.args) })).filter(x => x.cmd != null);
  const depth = (pid) => { let n = 0; for (let p = procs.get(pid)?.ppid; p && n < 64; p = procs.get(p)?.ppid) n++; return n; };
  byDepth.sort((a, b) => depth(a.p.pid) - depth(b.p.pid));
  for (const { p, cmd: raw } of byDepth) {
    if (underWrapper(p.pid)) continue;
    const cmd = norm(raw);
    const s = owner(p.pid);
    let tag = s ? matchWork(s.sessionId, cmd, true) : null;
    if (!tag && !s) {
      // Outlived its session (adopted by init): find the task it was, in any session we know.
      for (const x of known.sessions || []) if ((tag = matchWork(x.sessionId, cmd, false))) break;
      for (const id of known.allSessions?.() || []) { if (tag) break; tag = matchWork(id, cmd, false); }
    }
    tags.set(p.pid, { ...(tag || { kind: 'bash', sessionId: s?.sessionId || null, label: cmd }), command: cmd, detached: !s });
    if (!s) roots.push(p.pid);
  }
  for (const p of procs.values()) {
    if (tags.has(p.pid)) continue;
    if (p.ppid === known.deck && RUNS_CLAUDE.test(p.args)) tags.set(p.pid, { kind: 'model', label: 'the deck’s own claude call' });
    else if (sessionOf.has(p.ppid) && /\bmcp\b|mcp-server|-mcp\b/i.test(p.args)) tags.set(p.pid, { kind: 'mcp', label: `MCP server · ${p.name}` });
  }
  const scope = new Set();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    if (scope.has(pid)) continue;
    scope.add(pid);
    for (const c of kids.get(pid) || []) stack.push(c);
  }
  const virtual = [];
  for (const s of sessionOf.values()) {
    for (const a of known.subagents?.(s.sessionId) || []) {
      virtual.push({ id: `agent:${a.id}`, ppid: s.pid, virtual: true, name: a.agentType || 'subagent', tag: { kind: 'subagent', sessionId: a.id, parentId: s.sessionId, label: a.title } });
    }
  }
  return { tags, scope, virtual, kids };
}

// lsof -F: one field per line, keyed by its first character.
export function parseLsof(text, cap = 600) {
  const files = [];
  let cur = null, total = 0;
  for (const line of text.split('\n')) {
    const k = line[0], v = line.slice(1);
    if (k === 'f') { total++; cur = files.length < cap ? { fd: v } : null; if (cur) files.push(cur); }
    else if (!cur) continue;
    else if (k === 'a') cur.access = v;
    else if (k === 't') cur.type = v;
    else if (k === 'n') cur.name = v;
    else if (k === 'P') cur.proto = v;
    else if (k === 'T' && v.startsWith('ST=')) cur.tcpState = v.slice(3);
  }
  return { files, total };
}

/** `ps -E` appends the environment to the arguments; peel it off. */
export function parseEnvTail(full, args) {
  const tail = full.startsWith(args) ? full.slice(args.length) : full;
  const out = [];
  for (const part of tail.trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)) {
    const i = part.indexOf('=');
    if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part.slice(0, i))) out.push([part.slice(0, i), part.slice(i + 1)]);
  }
  return out;
}

export const SIGNALS = ['TERM', 'INT', 'HUP', 'KILL', 'STOP', 'CONT'];

export class ProcessMonitor {
  /** `known()` returns the attribution context (see attribute()). */
  constructor({ known, self = process.pid } = {}) {
    this.known = known;
    this.self = self;
    this.last = null;        // { at, procs }
    this.inflight = null;
  }

  get supported() { return process.platform === 'darwin' || process.platform === 'linux'; }

  /** A host-wide sample, shared by callers within `maxAgeMs`. */
  async sample(maxAgeMs = 900) {
    if (!this.supported) throw Object.assign(new Error('the process view needs macOS or Linux'), { code: 501 });
    if (this.last && Date.now() - this.last.at < maxAgeMs) return this.last;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const [text, comms] = await Promise.all([run('ps', ['-A', '-ww', '-o', PS_FIELDS]), run('ps', ['-A', '-o', 'pid=,comm='])]);
      const at = Date.now();
      const procs = parsePs(text, parseComms(comms), at);
      // CPU from the change in CPU time since the last sample, where there is one.
      const before = this.last;
      if (before && at - before.at < 30_000) {
        for (const p of procs.values()) {
          const q = before.procs.get(p.pid);
          if (q && q.start === p.start && p.cputime != null && q.cputime != null) p.cpu = Math.max(0, Math.round(((p.cputime - q.cputime) * 1000 / (at - before.at)) * 1000) / 10);
        }
      }
      this.last = { at, procs };
      return this.last;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async attributed() {
    const s = await this.sample();
    return { ...s, ...attribute(s.procs, { deck: this.self, ...this.known() }) };
  }

  /** The list: every process, or just the deck's. */
  async list(scopeName = 'agents') {
    const a = await this.attributed();
    const nodes = [];
    for (const p of a.procs.values()) {
      const inScope = a.scope.has(p.pid);
      if (scopeName !== 'all' && !inScope) continue;
      if (p.ppid === this.self && (p.name === 'ps' || p.name === 'lsof')) continue;   // this sampler itself
      nodes.push({ ...p, args: p.args.length > 600 ? p.args.slice(0, 600) + '…' : p.args, tag: a.tags.get(p.pid) || null, scope: inScope, kids: a.kids.get(p.pid)?.length || 0 });
    }
    return { at: a.at, self: this.self, platform: process.platform, scope: scopeName, total: a.procs.size, nodes, virtual: a.virtual };
  }

  /** Session pid plus the pids of its running background tasks and Bash calls. */
  async forSession(sessionId) {
    const a = await this.attributed();
    const out = { pid: null, tasks: {}, calls: {} };
    for (const [pid, t] of a.tags) {
      if (t.sessionId !== sessionId) continue;
      const p = a.procs.get(pid);
      const ref = { pid, start: p?.start ?? null };
      if (t.kind === 'session') out.pid = pid;
      else if (t.kind === 'task') out.tasks[t.taskId] = ref;
      else if (t.kind === 'tool') out.calls[t.toolUseId] = ref;
    }
    return out;
  }

  /** Everything known about one process. */
  async detail(pid) {
    const a = await this.attributed();
    const p = a.procs.get(pid);
    if (!p) return null;
    const ancestors = [];
    for (let q = a.procs.get(p.ppid), n = 0; q && n < 64; q = a.procs.get(q.ppid), n++) {
      ancestors.unshift({ pid: q.pid, name: q.name, tag: a.tags.get(q.pid) || null });
      if (q.pid <= 1) break;
    }
    const children = (a.kids.get(pid) || []).map(c => a.procs.get(c)).filter(Boolean)
      .map(c => ({ pid: c.pid, name: c.name, args: c.args.slice(0, 300), cpu: c.cpu, rss: c.rss, state: c.state, tag: a.tags.get(c.pid) || null }));
    const descendants = this.descendants(a, pid).length;
    const [files, env] = await Promise.all([this.files(pid), this.env(p)]);
    const cwd = files.files?.find(f => f.fd === 'cwd')?.name || this.linuxCwd(pid);
    return {
      ...p, tag: a.tags.get(pid) || null, scope: a.scope.has(pid), at: a.at, self: this.self,
      group: [...a.procs.values()].filter(q => q.pgid === p.pgid).length,
      ancestors, children, descendants, cwd, files: files.files || [], filesTotal: files.total || 0, filesError: files.error || null, env,
      virtual: a.virtual.filter(v => v.ppid === pid),
    };
  }

  descendants(a, pid) {
    const out = [];
    const walk = (x) => { for (const c of a.kids.get(x) || []) { walk(c); out.push(c); } };
    walk(pid);
    return out;   // deepest first
  }

  linuxCwd(pid) { try { return process.platform === 'linux' ? fs.readlinkSync(`/proc/${pid}/cwd`) : null; } catch { return null; } }

  async files(pid) {
    try { return parseLsof(await run('lsof', ['-n', '-P', '-w', '-p', String(pid), '-F', 'fatnPT'])); }
    catch (e) { return { error: e.code === 'ENOENT' ? 'lsof is not installed' : 'could not read open files (it may belong to another user)' }; }
  }

  async env(p) {
    try {
      if (process.platform === 'linux') {
        return { vars: fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8').split('\0').filter(Boolean).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }) };
      }
      const full = (await run('ps', ['-E', '-ww', '-o', 'command=', '-p', String(p.pid)])).replace(/\n$/, '');
      const vars = parseEnvTail(full, p.args.replace(/[\x00-\x1f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`));
      return vars.length ? { vars } : { vars: [], note: p.uid === process.getuid?.() ? 'no environment visible' : 'the environment of another user’s process is not readable' };
    } catch { return { vars: [], note: 'could not read the environment' }; }
  }

  /**
   * Send `signal` to pid (and, with `tree`, every descendant first). `start`
   * guards against pid reuse: the process must have started when the caller
   * saw it start. The deck's server and pid 1 are refused.
   */
  async signal(pid, { signal = 'TERM', tree = false, start = null } = {}) {
    if (!SIGNALS.includes(signal)) throw Object.assign(new Error(`unsupported signal ${signal}`), { code: 400 });
    if (!Number.isInteger(pid) || pid <= 1) throw Object.assign(new Error('refusing to signal that process'), { code: 400 });
    this.last = null;
    const a = await this.attributed();
    const p = a.procs.get(pid);
    if (!p) throw Object.assign(new Error('that process is gone'), { code: 404 });
    if (start != null && p.start != null && Math.abs(p.start - start) > 3000) throw Object.assign(new Error('that pid now belongs to a different process'), { code: 409 });
    // Never the deck itself, nor anything above it (that would take the deck down too).
    const guard = new Set([this.self]);
    for (let q = a.procs.get(this.self), n = 0; q && n < 64; q = a.procs.get(q.ppid), n++) guard.add(q.pid);
    if (guard.has(pid)) throw Object.assign(new Error('that would stop the deck itself'), { code: 400 });
    const targets = [...(tree ? this.descendants(a, pid) : []), pid].filter(x => !guard.has(x));
    const sent = [], failed = [];
    for (const t of targets) {
      try { process.kill(t, `SIG${signal}`); sent.push(t); }
      catch (e) { if (e.code !== 'ESRCH') failed.push({ pid: t, error: e.code === 'EPERM' ? 'not permitted' : e.message }); }
    }
    this.last = null;
    return { sent, failed };
  }
}
