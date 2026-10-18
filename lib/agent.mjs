// lib/agent.mjs — deck-launched sessions: the harness-neutral half.
//
// The deck owns the prompt queue: nothing goes to the agent until the
// current turn ends, so queued prompts can be pruned and reordered.
// Permission prompts wait for the pilot; interrupt asks the agent to end the
// turn, with SIGINT as the fallback. The protocol itself lives in a driver
// (lib/harness/claude.mjs: `claude -p` stream-json; lib/harness/acp.mjs: any
// ACP agent, e.g. opencode), one per harness; a session remembers its harness.
//
// Deck-launched sessions write no ~/.claude/sessions registry file, so this
// module is also their liveness and busy/idle source (see registryEntries()).
//
// A session has no on/off switch the pilot manages: sending to one that is
// not running resumes it with that prompt, a process idle for IDLE_END_MS
// ends by itself, and prompts still queued when the backend stops are saved
// and come back held, waiting for the pilot's play.
//
// Emits 'change' (publicState) whenever anything the UI shows changes.
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeDriver, BIN, PERMISSION_MODES, messageContent } from './harness/claude.mjs';

export { PERMISSION_MODES, messageContent };
const READY_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
// How long an unfinished edit may hold a queued prompt back (a closed tab, say).
const EDIT_LEASE_MS = 120_000;
const KEEP_EXITED_MS = 10 * 60_000;
const IDLE_END_MS = 30 * 60_000;
const MODES_MAX = 500;
// Attachments ride along with a prompt as content blocks: images and PDFs as
// base64 sources, text files inlined. Limits follow the Messages API.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_B64 = 5 * 1024 * 1024;   // per image, as base64
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 20;

/** Check and normalize [{ name, mediaType, data (base64) }]; throws on anything the model cannot take. */
export function normalizeAttachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('attachments must be a list');
  if (list.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per prompt`);
  return list.map((x) => {
    const name = String(x?.name || 'attachment').slice(0, 200);
    const mediaType = String(x?.mediaType || '').toLowerCase();
    if (typeof x?.data !== 'string' || !x.data) throw new Error(`${name}: no data`);
    const size = Buffer.byteLength(x.data, 'base64');
    const kind = IMAGE_TYPES.includes(mediaType) ? 'image' : mediaType === 'application/pdf' ? 'pdf' : mediaType.startsWith('text/') ? 'text' : null;
    if (!kind) throw new Error(`${name}: ${mediaType || 'this file type'} cannot be attached (images, PDFs and text files can)`);
    const [n, max] = kind === 'image' ? [x.data.length, MAX_IMAGE_B64] : [size, kind === 'pdf' ? MAX_DOC_BYTES : MAX_TEXT_BYTES];
    if (n > max) throw new Error(`${name}: too large (${Math.round(size / 1024)} KB; limit ${max / 1024 / 1024} MB)`);
    return { name, mediaType, kind, size, data: x.data };
  });
}

const oneLine = (s, max = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const publicAttachments = (list) => list?.length ? list.map(({ name, mediaType, size }) => ({ name, mediaType, size })) : undefined;
const publicItem = ({ attachments, ...x }) => ({ ...x, attachments: publicAttachments(attachments) });

export class AgentManager extends EventEmitter {
  /**
   * `store`: a JSON file for queued prompts and permission modes, so both
   * outlive the backend. `wakeable(id)` says where a session can be resumed:
   * { cwd } or { error } (a subagent, or a session running outside the deck).
   * `drivers`: harness name -> driver; the default harness starts new sessions.
   */
  constructor({ bin = BIN, driver = null, drivers = null, defaultHarness = null, store = null, wakeable = null, idleMs = IDLE_END_MS } = {}) {
    super();
    this.drivers = drivers || { claude: driver || new ClaudeDriver({ bin }) };
    this.defaultHarness = defaultHarness && this.drivers[defaultHarness] ? defaultHarness : Object.keys(this.drivers)[0];
    this.agents = new Map();   // sessionId -> agent record
    this.store = store;
    this.wakeable = wakeable;
    this.idleMs = idleMs;
    this.modes = new Map();    // sessionId -> permission mode it last ran with
    this.harnesses = new Map(); // sessionId -> harness it ran under (when not claude)
    this._load();
  }

  // ------------------------------------------------------------ persistence

  _load() {
    if (!this.store) return;
    let d;
    try { d = JSON.parse(fs.readFileSync(this.store, 'utf8')); } catch { return; }
    for (const [id, h] of Object.entries(d.harnesses || {})) if (this.drivers[h]) this.harnesses.set(id, h);
    for (const [id, m] of Object.entries(d.modes || {})) if (this._driverOf(id)?.caps.modes.includes(m)) this.modes.set(id, m);
    // Prompts queued when the backend stopped: held until the pilot presses play.
    for (const [id, q] of Object.entries(d.queues || {})) {
      if (!Array.isArray(q.items) || !q.items.length) continue;
      this.agents.set(id, this._record({ id, cwd: q.cwd || null, harness: this._harnessOf(id), permissionMode: this.modes.get(id) || 'default', queue: q.items, held: true, status: 'stopped' }));
    }
  }

  _save() {
    if (!this.store || this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), 200);
    this._saveTimer.unref?.();
  }
  /** Write the queues and modes now (also on shutdown). */
  flush() {
    clearTimeout(this._saveTimer); this._saveTimer = null;
    if (!this.store) return;
    {
      const queues = {};
      for (const a of this.agents.values()) if (a.queue.length) queues[a.id] = { cwd: a.cwd, items: a.queue };
      const modes = Object.fromEntries([...this.modes].slice(-MODES_MAX));
      const harnesses = Object.fromEntries([...this.harnesses].slice(-MODES_MAX));
      try {
        fs.mkdirSync(path.dirname(this.store), { recursive: true });
        const tmp = this.store + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ queues, modes, harnesses }), { mode: 0o600 });
        fs.renameSync(tmp, this.store);
      } catch { /* the queue still lives in memory */ }
    }
  }

  /** The harness a session ran under: a recorded one, else claude (any session found on disk). */
  _harnessOf(id) {
    return this.harnesses.get(id) || (this.drivers.claude ? 'claude' : this.defaultHarness);
  }
  _driverOf(id) { return this.drivers[this._harnessOf(id)]; }

  _record(x) {
    return {
      id: x.id, cwd: x.cwd, harness: x.harness || 'claude', proc: null, pid: null, model: x.model || null, permissionMode: x.permissionMode || 'default', name: x.name || null, resumed: !!x.resumed,
      status: x.status || 'starting', statusAt: Date.now(), startedAt: Date.now(),
      queue: x.queue || [], held: !!x.held, permissions: new Map(),
      interrupting: null, lastResult: null, totalCostUsd: 0, turns: 0,
      exit: null,
    };
  }

  /**
   * Start a session (or resume an ended one) with a first prompt. Resolves
   * with the public state once the agent reports it is up; rejects with the
   * agent's own error if it exits first.
   */
  async launch({ cwd, prompt, attachments, model, permissionMode = 'default', name, resume, harness } = {}) {
    const files = normalizeAttachments(attachments);
    if (!prompt?.trim() && !files.length) throw new Error('a first prompt is required');
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
    const hname = harness || (resume ? this._harnessOf(resume) : this.defaultHarness);
    const driver = this.drivers[hname];
    if (!driver) throw new Error(`unknown harness: ${hname}`);
    if (!driver.caps.modes.includes(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
    if (resume && this.agents.get(resume)?.proc) throw new Error('that session is already running in the deck');

    const id = resume || randomUUID();
    const proc = driver.start({ id, cwd, model, permissionMode, name, resume });

    // A streamed session gets no title from its agent; its first prompt names it.
    const title = name || (driver.caps.events === 'stream' ? oneLine(prompt) || null : null);
    const a = this._record({ id, cwd, harness: hname, model, permissionMode, name: title, resumed: resume });
    a.proc = proc; a.pid = proc.pid;
    this.agents.set(id, a);
    this.modes.delete(id); this.modes.set(id, permissionMode);

    const ready = new Promise((resolve, reject) => { a._ready = { resolve, reject }; });
    a._readyTimer = setTimeout(() => this._settleReady(a, new Error('the CLI did not start within 30s')), READY_TIMEOUT_MS);

    proc.on('init', (x) => this._onInit(a, x));
    proc.on('ratelimit', (info) => this.emit('ratelimit', info));
    proc.on('result', (r) => this._onResult(a, r));
    proc.on('permission', (p) => { a.permissions.set(p.requestId, p); this._changed(a); });
    proc.on('permission-cancel', (requestId) => { if (a.permissions.delete(requestId)) this._changed(a); });
    proc.on('exit', ({ code, signal, stderr }) => this._onExit(a, code, signal, stderr));
    // Harnesses with no transcript file stream their events instead (lib/harness/acp.mjs).
    proc.on('events', ({ events, meta }) => this.emit('stream', { id: a.id, cwd: a.cwd, title: a.name, harness: a.harness, events, meta }));

    proc.send(prompt, files);
    a.status = 'busy'; a.turns++;
    this._changed(a);
    return ready;
  }

  _settleReady(a, err) {
    if (!a._ready) return;
    clearTimeout(a._readyTimer);
    const r = a._ready; a._ready = null;
    if (err) { r.reject(err); if (a.proc) this.stop(a.id); } else r.resolve(this.publicState(a.id));
  }

  _onInit(a, { sessionId, model, permissionMode }) {
    // A resume may be given a fresh id; follow whatever the agent reports.
    if (sessionId && sessionId !== a.id) {
      if (this.agents.get(a.id) === a) this.agents.delete(a.id);
      this.modes.delete(a.id); this.modes.set(sessionId, a.permissionMode);
      a.id = sessionId;
      this.agents.set(a.id, a);
    }
    if (a.harness !== 'claude') this.harnesses.set(a.id, a.harness);
    if (model) a.model = model;
    if (permissionMode) a.permissionMode = permissionMode;
    a.initialized = true;
    this._settleReady(a, null);
    this._changed(a);
  }

  _onResult(a, r) {
    a.lastResult = r;
    if (typeof r.costUsd === 'number') a.totalCostUsd = r.costUsd;
    a.permissions.clear();
    if (a.interrupting) { clearTimeout(a.interrupting); a.interrupting = null; }
    this._setStatus(a, 'idle');
    this._settleReady(a, null);
    this._pump(a);
  }

  _onExit(a, code, signal, stderr = '') {
    if (a.status === 'exited') return;
    a.proc = null;
    if (a.interrupting) { clearTimeout(a.interrupting); a.interrupting = null; }
    a.permissions.clear();
    a.exit = { code, signal, at: Date.now(), stderr: stderr.trim().slice(-1500) || null };
    a.status = 'exited'; a.statusAt = Date.now();
    const why = a.exit.stderr || `exited with ${signal || `code ${code}`}`;
    this._settleReady(a, new Error(why));
    this._changed(a);
    // Prompts still queued wait, held, for the pilot's play. Otherwise keep
    // the record a while so the UI can say how it ended, then drop it.
    clearTimeout(a.idleTimer);
    if (a.queue.length) { a.held = true; this._changed(a); return; }
    setTimeout(() => { if (this.agents.get(a.id) === a && !a.proc && !a.queue.length) { this.agents.delete(a.id); this.emit('change', { id: a.id, gone: true }); } }, KEEP_EXITED_MS).unref?.();
  }

  _setStatus(a, status) {
    if (a.status === status) return;
    a.status = status; a.statusAt = Date.now();
    this._changed(a);
  }

  _changed(a) {
    // An idle process with nothing to do ends after a while; the next prompt resumes it.
    clearTimeout(a.idleTimer);
    if (a.proc && a.status === 'idle' && !a.queue.length && !a.permissions.size && this.idleMs) {
      a.idleTimer = setTimeout(() => { if (a.proc && a.status === 'idle' && !a.queue.length && !a.permissions.size) { a.endedIdle = true; this.stop(a.id); } }, this.idleMs);
      a.idleTimer.unref?.();
    }
    this._save();
    this.emit('change', this.publicState(a.id));
  }

  /**
   * Start a session that is not running, by resuming it with `first` (a
   * queue item). Whatever was queued for it stays queued behind, held as it
   * was. Uses the model the pilot picked for new sessions and the
   * permission mode the session last ran with.
   */
  async _wake(id, first, { model } = {}) {
    const prev = this.agents.get(id);
    if (prev?.proc) throw new Error('that session is already running in the deck');
    const w = this.wakeable?.(id) || (prev?.cwd ? { cwd: prev.cwd } : { error: 'unknown session' });
    if (w.error) throw Object.assign(new Error(w.error), { code: 409 });
    const waiting = prev?.queue || [];
    const held = !!prev?.held;
    const stream = this._driverOf(id)?.caps.events === 'stream';
    const started = this.launch({ cwd: w.cwd, resume: id, prompt: first.text, attachments: first.attachments, model: model || undefined, permissionMode: this.modes.get(id) || prev?.permissionMode || 'default',
      name: stream ? prev?.name || undefined : undefined });
    const a = this.agents.get(id);
    if (a !== prev && waiting.length) { a.queue = waiting; a.held = held; this._changed(a); }
    await started;
    return publicItem(first);
  }

  /** Send the head of the queue if the session is idle. */
  _pump(a) {
    if (a.status !== 'idle' || a.held || !a.queue.length || !a.proc) return;
    if (a.editing && a.queue[0].id === a.editing) return;   // the pilot is rewording it
    const item = a.queue.shift();
    if (!a.proc.send(item.text, item.attachments)) { a.queue.unshift(item); return; }
    a.turns++;
    a.status = 'busy'; a.statusAt = Date.now();
    this._changed(a);
  }

  _get(id) {
    const a = this.agents.get(id);
    if (!a) throw Object.assign(new Error('not a deck-launched session'), { code: 404 });
    return a;
  }
  _live(id) {
    const a = this._get(id);
    if (!a.proc) throw Object.assign(new Error('the session has ended; resume it first'), { code: 409 });
    return a;
  }

  // ------------------------------------------------------------ pilot actions

  /** Queue a prompt. It goes out at once if the session is idle; sending releases a held queue. */
  send(id, text, attachments, opts = {}) {
    const a = this.agents.get(id);
    if (!a?.proc) return this._wake(id, this._item(text, attachments), opts);
    const item = this._item(text, attachments);
    a.queue.push(item);
    if (a.queue.length === 1) a.held = false;
    this._changed(a);
    this._pump(a);
    return publicItem(item);
  }

  /**
   * Send now: everything queued, plus this prompt if there is one, goes out
   * as one message, in queue order. A running turn is interrupted first so it
   * goes out as soon as that turn stops; an idle or held session sends at once.
   */
  sendNow(id, text, attachments, opts = {}) {
    const a = this.agents.get(id) || { queue: [] };
    const typed = text?.trim() || attachments?.length ? this._item(text, attachments) : null;
    const items = [...a.queue, ...(typed ? [typed] : [])];
    if (!items.length) throw new Error('nothing to send');
    const merged = items.length === 1 ? items[0] : {
      id: randomBytes(4).toString('hex'), at: Date.now(),
      text: items.map(x => x.text.trim()).filter(Boolean).join('\n\n'),
      attachments: items.flatMap(x => x.attachments),
    };
    if (!a.proc) { a.queue = []; return this._wake(id, merged, opts); }
    a.queue = [merged];
    a.editing = null;
    if (a.status !== 'idle') this.interrupt(id);
    a.held = false;
    this._changed(a);
    this._pump(a);
    return publicItem(merged);
  }

  _item(text, attachments) {
    const files = normalizeAttachments(attachments);
    if (!text?.trim() && !files.length) throw new Error('empty prompt');
    return { id: randomBytes(4).toString('hex'), text: text || '', at: Date.now(), attachments: files };
  }

  /**
   * remove | top | up | down | edit an item; resume releases a held queue.
   * `editing` marks an item the pilot is rewording (itemId null clears it), so
   * it is not sent mid-edit; the mark lapses on its own if the edit is abandoned.
   */
  queueOp(id, { op, itemId, text, model }) {
    const a = this._get(id);
    if (op === 'resume' && !a.proc) {
      // Play on a session that is not running: start it with the first queued prompt.
      if (!a.queue.length) return;
      const [first, ...rest] = a.queue;
      a.queue = rest; a.held = false;
      return this._wake(id, first, { model }).catch((e) => {
        const cur = this.agents.get(id) || a;   // a failed start leaves its own record
        cur.queue.unshift(first); cur.held = true; this._changed(cur);
        throw e;
      });
    }
    if (op === 'resume') { a.held = false; this._changed(a); this._pump(a); return; }
    if (op === 'editing') {
      clearTimeout(a.editTimer);
      a.editing = itemId && a.queue.some(x => x.id === itemId) ? itemId : null;
      if (a.editing) a.editTimer = setTimeout(() => { a.editing = null; this._changed(a); this._pump(a); }, EDIT_LEASE_MS);
      this._changed(a);
      this._pump(a);
      return;
    }
    const i = a.queue.findIndex(x => x.id === itemId);
    if (i < 0) throw Object.assign(new Error('no such queued prompt (already sent?)'), { code: 409 });
    const [item] = a.queue.splice(i, 1);
    if (op === 'top') a.queue.unshift(item);
    else if (op === 'up') a.queue.splice(Math.max(0, i - 1), 0, item);
    else if (op === 'down') a.queue.splice(Math.min(a.queue.length, i + 1), 0, item);
    else if (op === 'edit') { if (text?.trim() || item.attachments.length) item.text = text || ''; a.queue.splice(i, 0, item); }
    else if (op !== 'remove') { a.queue.splice(i, 0, item); throw new Error(`unknown queue op: ${op}`); }
    if (op === 'top') a.held = false;
    if (op === 'edit' || op === 'remove') { if (a.editing === item.id) { a.editing = null; clearTimeout(a.editTimer); } }
    this._changed(a);
    if (op === 'top' || op === 'edit' || op === 'remove') this._pump(a);
  }

  /**
   * Stop the current turn and hold the queue, so the pilot can redirect
   * before the next prompt goes out. SIGINT if the CLI does not finish the
   * turn within a few seconds.
   */
  interrupt(id) {
    const a = this._live(id);
    if (a.status === 'idle') return false;
    a.held = a.queue.length > 0;
    a.proc.interrupt();
    clearTimeout(a.interrupting);
    a.interrupting = setTimeout(() => {
      a.interrupting = null;
      if (a.proc && a.status !== 'idle') a.proc.signal('SIGINT');
    }, INTERRUPT_GRACE_MS);
    this._changed(a);
    return true;
  }

  /** Answer a pending permission prompt. decision: allow | always | deny. */
  answer(id, requestId, decision, message) {
    const a = this._live(id);
    const p = a.permissions.get(requestId);
    if (!p) throw Object.assign(new Error('that permission prompt is no longer pending'), { code: 409 });
    a.proc.answer(p, decision, message);
    a.permissions.delete(requestId);
    this._changed(a);
  }

  /** End the process: close stdin, then escalate. */
  stop(id) {
    const a = this._get(id);
    if (!a.proc) return false;
    a.queue = [];
    a.proc.stop();
    return true;
  }

  stopAll() { for (const a of this.agents.values()) a.proc?.signal('SIGTERM'); }

  /** stopAll, then wait (up to `ms`) for drivers that shut down gracefully (ACP closes its sessions). */
  async shutdown(ms = 4000) {
    this.stopAll();
    const closing = Promise.allSettled(Object.values(this.drivers).map(d => d.close?.()));
    await Promise.race([closing, new Promise(r => setTimeout(r, ms).unref?.())]);
  }

  /** The harnesses the launch dialog offers: name, label, modes, default. */
  harnessList() {
    return Object.entries(this.drivers).map(([name, d]) => ({ name, label: d.label || name, modes: d.caps.modes, modeLabels: d.caps.modeLabels || null,
      models: d.caps.models !== false, default: name === this.defaultHarness }));
  }

  // ------------------------------------------------------------ queries

  has(id) { return this.agents.has(id); }
  running(id) { return !!this.agents.get(id)?.proc; }

  publicState(id) {
    const a = this.agents.get(id);
    if (!a) return null;
    return {
      id: a.id, launched: true, harness: a.harness, pid: a.pid, cwd: a.cwd, model: a.model, permissionMode: a.permissionMode, resumed: a.resumed,
      status: a.status, statusAt: a.statusAt, startedAt: a.startedAt, alive: !!a.proc,
      queue: a.queue.map(publicItem), held: a.held, editing: a.editing || null, interrupting: !!a.interrupting,
      permissions: [...a.permissions.values()].map(({ rawInput, ...p }) => p),
      lastResult: a.lastResult, totalCostUsd: a.totalCostUsd, turns: a.turns, exit: a.exit, endedIdle: !!a.endedIdle,
    };
  }

  /**
   * Synthetic ~/.claude/sessions entries for running deck sessions, so the
   * session index treats them like any other live session.
   */
  registryEntries() {
    const out = [];
    for (const a of this.agents.values()) {
      if (!a.proc) continue;
      const stream = this.drivers[a.harness]?.caps.events === 'stream';
      // A streamed session is listed once the agent has given it its id.
      if (stream && !a.initialized) continue;
      out.push({
        sessionId: a.id, pid: a.pid, cwd: a.cwd, startedAt: a.startedAt, kind: 'deck', entrypoint: 'agent-deck', harness: a.harness,
        stream: stream || undefined,
        name: a.name || undefined, status: a.status === 'idle' ? 'idle' : 'busy', statusUpdatedAt: a.statusAt,
        waiting: a.permissions.size ? 'permission' : null,
      });
    }
    return out;
  }
}
