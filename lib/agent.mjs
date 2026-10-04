// lib/agent.mjs — deck-launched sessions, driven over the documented
// stream-json interface (the Agent SDK wire format):
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --session-id <uuid> --permission-prompt-tool stdio …
//
// The deck owns the prompt queue: nothing is written to stdin until the
// current turn's `result` arrives, so queued prompts can be pruned and
// reordered. Permission prompts arrive as `control_request/can_use_tool` and
// wait for the pilot; interrupt is `control_request/interrupt`, with SIGINT
// as the fallback.
//
// Events still come from the transcript file (the deck's one source of truth
// for every session); stdout is read only for state: init, result, control.
// `-p` sessions write no ~/.claude/sessions registry file, so this module is
// also their liveness and busy/idle source (see registryEntries()).
//
// A session has no on/off switch the pilot manages: sending to one that is
// not running resumes it (`--resume`) with that prompt, a process idle for
// IDLE_END_MS ends by itself, and prompts still queued when the backend
// stops are saved and come back held, waiting for the pilot's play.
//
// Emits 'change' (publicState) whenever anything the UI shows changes.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from './narrator.mjs';

const BIN = process.env.DECK_AGENT_BIN
  ? (process.env.DECK_AGENT_BIN.includes('/') ? path.resolve(process.env.DECK_AGENT_BIN) : process.env.DECK_AGENT_BIN)
  : 'claude';
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
const READY_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
// How long an unfinished edit may hold a queued prompt back (a closed tab, say).
const EDIT_LEASE_MS = 120_000;
const KEEP_EXITED_MS = 10 * 60_000;
const IDLE_END_MS = 30 * 60_000;
const MODES_MAX = 500;
const MAX_INPUT_CHARS = 20_000;
// The CLI would hand AskUserQuestion to the host as a permission prompt and
// expect answers back in a shape the deck does not build; without it the
// agent asks in plain text and the pilot replies with a prompt.
const DISALLOWED = ['AskUserQuestion'];
// Attachments ride along with a prompt as content blocks: images and PDFs as
// base64 sources, text files inlined. Limits follow the Messages API.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_B64 = 5 * 1024 * 1024;   // per image, as base64
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 20;

function capInput(input) {
  const s = JSON.stringify(input ?? {});
  if (s.length <= MAX_INPUT_CHARS) return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + `\n…[${v.length} chars]` : v;
  return out;
}

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

/** A user message's content: plain text, or blocks when files are attached. */
export function messageContent(text, attachments = []) {
  if (!attachments.length) return text;
  const blocks = attachments.map((a) => a.kind === 'image' ? { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
    : a.kind === 'pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name }
    : { type: 'text', text: `Attached file ${a.name}:\n\n${Buffer.from(a.data, 'base64').toString('utf8')}` });
  if (text?.trim()) blocks.push({ type: 'text', text });
  return blocks;
}
const publicAttachments = (list) => list?.length ? list.map(({ name, mediaType, size }) => ({ name, mediaType, size })) : undefined;
const publicItem = ({ attachments, ...x }) => ({ ...x, attachments: publicAttachments(attachments) });

export class AgentManager extends EventEmitter {
  /**
   * `store`: a JSON file for queued prompts and permission modes, so both
   * outlive the backend. `wakeable(id)` says where a session can be resumed:
   * { cwd } or { error } (a subagent, or a session running outside the deck).
   */
  constructor({ bin = BIN, store = null, wakeable = null, idleMs = IDLE_END_MS } = {}) {
    super();
    this.bin = bin;
    this.agents = new Map();   // sessionId -> agent record
    this.store = store;
    this.wakeable = wakeable;
    this.idleMs = idleMs;
    this.modes = new Map();    // sessionId -> permission mode it last ran with
    this._load();
  }

  // ------------------------------------------------------------ persistence

  _load() {
    if (!this.store) return;
    let d;
    try { d = JSON.parse(fs.readFileSync(this.store, 'utf8')); } catch { return; }
    for (const [id, m] of Object.entries(d.modes || {})) if (PERMISSION_MODES.includes(m)) this.modes.set(id, m);
    // Prompts queued when the backend stopped: held until the pilot presses play.
    for (const [id, q] of Object.entries(d.queues || {})) {
      if (!Array.isArray(q.items) || !q.items.length) continue;
      this.agents.set(id, this._record({ id, cwd: q.cwd || null, permissionMode: this.modes.get(id) || 'default', queue: q.items, held: true, status: 'stopped' }));
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
      try {
        fs.mkdirSync(path.dirname(this.store), { recursive: true });
        const tmp = this.store + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ queues, modes }), { mode: 0o600 });
        fs.renameSync(tmp, this.store);
      } catch { /* the queue still lives in memory */ }
    }
  }

  _record(x) {
    return {
      id: x.id, cwd: x.cwd, child: null, pid: null, model: x.model || null, permissionMode: x.permissionMode || 'default', name: x.name || null, resumed: !!x.resumed,
      status: x.status || 'starting', statusAt: Date.now(), startedAt: Date.now(),
      queue: x.queue || [], held: !!x.held, permissions: new Map(),
      interrupting: null, lastResult: null, totalCostUsd: 0, turns: 0,
      exit: null, stderr: '', out: '',
    };
  }

  /**
   * Start a session (or resume an ended one) with a first prompt. Resolves
   * with the public state once the CLI reports `init`; rejects with the CLI's
   * own error if it exits first.
   */
  async launch({ cwd, prompt, attachments, model, permissionMode = 'default', name, resume } = {}) {
    const files = normalizeAttachments(attachments);
    if (!prompt?.trim() && !files.length) throw new Error('a first prompt is required');
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
    if (resume && this.agents.get(resume)?.child) throw new Error('that session is already running in the deck');

    const id = resume || randomUUID();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode, '--disallowedTools', ...DISALLOWED];
    args.push(...(resume ? ['--resume', resume] : ['--session-id', id]));
    if (model) args.push('--model', model);
    if (name) args.push('--name', name);

    let child;
    try { child = spawn(this.bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { throw new Error(`cannot start ${this.bin}: ${e.message}`); }

    const a = this._record({ id, cwd, model, permissionMode, name, resumed: resume });
    a.child = child; a.pid = child.pid;
    this.agents.set(id, a);
    this.modes.delete(id); this.modes.set(id, permissionMode);

    const ready = new Promise((resolve, reject) => { a._ready = { resolve, reject }; });
    a._readyTimer = setTimeout(() => this._settleReady(a, new Error('the CLI did not start within 30s')), READY_TIMEOUT_MS);

    child.stdout.on('data', (d) => this._onStdout(a, d));
    child.stderr.on('data', (d) => { a.stderr = (a.stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* EPIPE after exit; 'close' reports it */ });
    child.on('error', (e) => {
      a.stderr += e.code === 'ENOENT' ? `${this.bin} not found on PATH (set DECK_AGENT_BIN)` : e.message;
      if (!child.pid) this._onExit(a, -1, null);   // never started; 'close' may not follow
    });
    child.on('close', (code, signal) => this._onExit(a, code, signal));

    this._write(a, this._userMessage(prompt, files));
    a.status = 'busy'; a.turns++;
    this._changed(a);
    return ready;
  }

  _settleReady(a, err) {
    if (!a._ready) return;
    clearTimeout(a._readyTimer);
    const r = a._ready; a._ready = null;
    if (err) { r.reject(err); if (a.child) this.stop(a.id); } else r.resolve(this.publicState(a.id));
  }

  _userMessage(text, attachments) {
    return { type: 'user', message: { role: 'user', content: messageContent(text, attachments) }, parent_tool_use_id: null, session_id: '' };
  }

  _write(a, obj) {
    if (!a.child?.stdin.writable) return false;
    a.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  _onStdout(a, chunk) {
    a.out += chunk;
    let i;
    while ((i = a.out.indexOf('\n')) >= 0) {
      const line = a.out.slice(0, i).trim();
      a.out = a.out.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._onMessage(a, msg);
    }
  }

  _onMessage(a, msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          // A resume may be given a fresh id; follow whatever the CLI reports.
          if (msg.session_id && msg.session_id !== a.id) {
            if (this.agents.get(a.id) === a) this.agents.delete(a.id);
            a.id = msg.session_id;
            this.agents.set(a.id, a);
          }
          if (msg.model) a.model = msg.model;
          if (msg.permissionMode) a.permissionMode = msg.permissionMode;
          this._settleReady(a, null);
          this._changed(a);
        }
        break;
      case 'rate_limit_event':
        if (msg.rate_limit_info) this.emit('ratelimit', msg.rate_limit_info);
        break;
      case 'result': {
        a.lastResult = { subtype: msg.subtype || null, isError: !!msg.is_error, durationMs: msg.duration_ms ?? null,
          costUsd: msg.total_cost_usd ?? null, stopReason: msg.stop_reason ?? null, at: Date.now(),
          error: msg.is_error ? String(msg.result || msg.subtype || 'turn failed').slice(0, 500) : null };
        // total_cost_usd is cumulative for the process.
        if (typeof msg.total_cost_usd === 'number') a.totalCostUsd = msg.total_cost_usd;
        a.permissions.clear();
        if (a.interrupting) { clearTimeout(a.interrupting); a.interrupting = null; }
        this._setStatus(a, 'idle');
        this._settleReady(a, null);
        this._pump(a);
        break;
      }
      case 'control_request': {
        const r = msg.request || {};
        if (r.subtype === 'can_use_tool') {
          a.permissions.set(msg.request_id, {
            requestId: msg.request_id, toolName: r.tool_name, displayName: r.display_name || r.tool_name,
            input: capInput(r.input), rawInput: r.input ?? {}, description: r.description || null, toolUseId: r.tool_use_id || null,
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            blockedPath: r.blocked_path || null, reason: r.decision_reason || null, at: Date.now(),
          });
          this._changed(a);
        } else {
          // Anything else the CLI asks a host (hooks, SDK MCP servers) the deck does not provide.
          this._write(a, { type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `agent-deck does not handle ${r.subtype}` } });
        }
        break;
      }
      case 'control_cancel_request':
        if (a.permissions.delete(msg.request_id)) this._changed(a);
        break;
      default: break;
    }
  }

  _onExit(a, code, signal) {
    if (a.status === 'exited') return;
    a.child = null;
    if (a.interrupting) { clearTimeout(a.interrupting); a.interrupting = null; }
    a.permissions.clear();
    a.exit = { code, signal, at: Date.now(), stderr: a.stderr.trim().slice(-1500) || null };
    a.status = 'exited'; a.statusAt = Date.now();
    const why = a.exit.stderr || `exited with ${signal || `code ${code}`}`;
    this._settleReady(a, new Error(why));
    this._changed(a);
    // Prompts still queued wait, held, for the pilot's play. Otherwise keep
    // the record a while so the UI can say how it ended, then drop it.
    clearTimeout(a.idleTimer);
    if (a.queue.length) { a.held = true; this._changed(a); return; }
    setTimeout(() => { if (this.agents.get(a.id) === a && !a.child && !a.queue.length) { this.agents.delete(a.id); this.emit('change', { id: a.id, gone: true }); } }, KEEP_EXITED_MS).unref?.();
  }

  _setStatus(a, status) {
    if (a.status === status) return;
    a.status = status; a.statusAt = Date.now();
    this._changed(a);
  }

  _changed(a) {
    // An idle process with nothing to do ends after a while; the next prompt resumes it.
    clearTimeout(a.idleTimer);
    if (a.child && a.status === 'idle' && !a.queue.length && !a.permissions.size && this.idleMs) {
      a.idleTimer = setTimeout(() => { if (a.child && a.status === 'idle' && !a.queue.length && !a.permissions.size) { a.endedIdle = true; this.stop(a.id); } }, this.idleMs);
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
    if (prev?.child) throw new Error('that session is already running in the deck');
    const w = this.wakeable?.(id) || (prev?.cwd ? { cwd: prev.cwd } : { error: 'unknown session' });
    if (w.error) throw Object.assign(new Error(w.error), { code: 409 });
    const waiting = prev?.queue || [];
    const held = !!prev?.held;
    const started = this.launch({ cwd: w.cwd, resume: id, prompt: first.text, attachments: first.attachments, model: model || undefined, permissionMode: this.modes.get(id) || prev?.permissionMode || 'default' });
    const a = this.agents.get(id);
    if (a !== prev && waiting.length) { a.queue = waiting; a.held = held; this._changed(a); }
    await started;
    return publicItem(first);
  }

  /** Send the head of the queue if the session is idle. */
  _pump(a) {
    if (a.status !== 'idle' || a.held || !a.queue.length || !a.child) return;
    if (a.editing && a.queue[0].id === a.editing) return;   // the pilot is rewording it
    const item = a.queue.shift();
    if (!this._write(a, this._userMessage(item.text, item.attachments))) { a.queue.unshift(item); return; }
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
    if (!a.child) throw Object.assign(new Error('the session has ended; resume it first'), { code: 409 });
    return a;
  }

  // ------------------------------------------------------------ pilot actions

  /** Queue a prompt. It goes out at once if the session is idle; sending releases a held queue. */
  send(id, text, attachments, opts = {}) {
    const a = this.agents.get(id);
    if (!a?.child) return this._wake(id, this._item(text, attachments), opts);
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
    if (!a.child) { a.queue = []; return this._wake(id, merged, opts); }
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
    if (op === 'resume' && !a.child) {
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
    this._write(a, { type: 'control_request', request_id: `deck-int-${randomBytes(4).toString('hex')}`, request: { subtype: 'interrupt' } });
    clearTimeout(a.interrupting);
    a.interrupting = setTimeout(() => {
      a.interrupting = null;
      if (a.child && a.status !== 'idle') { try { a.child.kill('SIGINT'); } catch { /* gone */ } }
    }, INTERRUPT_GRACE_MS);
    this._changed(a);
    return true;
  }

  /** Answer a pending permission prompt. decision: allow | always | deny. */
  answer(id, requestId, decision, message) {
    const a = this._live(id);
    const p = a.permissions.get(requestId);
    if (!p) throw Object.assign(new Error('that permission prompt is no longer pending'), { code: 409 });
    let response;
    if (decision === 'deny') response = { behavior: 'deny', message: message?.trim() || 'The pilot denied this in agent-deck.' };
    else {
      response = { behavior: 'allow', updatedInput: p.rawInput };
      if (decision === 'always' && p.suggestions.length) response.updatedPermissions = p.suggestions;
    }
    this._write(a, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    a.permissions.delete(requestId);
    this._changed(a);
  }

  /** End the process: close stdin, then escalate. */
  stop(id) {
    const a = this._get(id);
    const child = a.child;
    if (!child) return false;
    a.queue = [];
    try { child.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { if (a.child === child) { try { child.kill('SIGTERM'); } catch { /* gone */ } } }, 1500).unref?.();
    setTimeout(() => { if (a.child === child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, 6000).unref?.();
    return true;
  }

  stopAll() { for (const a of this.agents.values()) if (a.child) { try { a.child.kill('SIGTERM'); } catch { /* gone */ } } }

  // ------------------------------------------------------------ queries

  has(id) { return this.agents.has(id); }
  running(id) { return !!this.agents.get(id)?.child; }

  publicState(id) {
    const a = this.agents.get(id);
    if (!a) return null;
    return {
      id: a.id, launched: true, pid: a.pid, cwd: a.cwd, model: a.model, permissionMode: a.permissionMode, resumed: a.resumed,
      status: a.status, statusAt: a.statusAt, startedAt: a.startedAt, alive: !!a.child,
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
      if (!a.child) continue;
      out.push({
        sessionId: a.id, pid: a.pid, cwd: a.cwd, startedAt: a.startedAt, kind: 'deck', entrypoint: 'agent-deck',
        name: a.name || undefined, status: a.status === 'idle' ? 'idle' : 'busy', statusUpdatedAt: a.statusAt,
        waiting: a.permissions.size ? 'permission' : null,
      });
    }
    return out;
  }
}
