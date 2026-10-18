// lib/harness/acp.mjs — the ACP driver: deck sessions run by any Agent Client
// Protocol agent (opencode first), over one `<bin> acp` process for all of
// them. The connection starts with the first session and closes, gracefully,
// when the last one stops.
//
// Same session handle as lib/harness/claude.mjs (start() → session emitting
// init, result, permission, permission-cancel, exit), plus 'events'
// {events, meta}: ACP sessions have no transcript file, so their normalized
// events (lib/acp-events.mjs) travel with the handle.
//
// Modes: 'default' asks in the deck for every edit and command (opencode's
// global config sets them to "ask"), 'auto' answers allow on the deck's
// behalf, 'plan' switches the agent to its read-only plan mode.
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { AcpConnection } from '../acp.mjs';
import { AcpEvents, configValues } from '../acp-events.mjs';

const MODE_LABELS = { default: 'Ask me in the deck', auto: 'Allow everything', plan: 'Plan only, no changes' };
const DECISION_KIND = { allow: 'allow_once', always: 'allow_always', deny: 'reject_once' };

export class AcpDriver {
  constructor({ bin = 'opencode', args = ['acp'], label = bin, env = process.env, clientInfo } = {}) {
    this.bin = bin; this.args = args; this.label = label; this.env = env; this.clientInfo = clientInfo;
    this.caps = { modes: Object.keys(MODE_LABELS), modeLabels: MODE_LABELS, models: false, resume: true, events: 'stream' };
    this.conn = null;
    this.ready = null;          // initialize() of the current connection
    this.closing = null;        // conn.close() once the last session went
    this.sessions = new Set();  // live handles on this connection
  }

  _connect() {
    if (this.conn?.alive) return this.conn;
    const conn = new AcpConnection({ bin: this.bin, args: this.args, env: this.env, cwd: os.homedir(), clientInfo: this.clientInfo });
    this.conn = conn;
    this.ready = conn.initialize();
    this.ready.catch(() => { /* each session reports it */ });
    conn.onRequest('session/request_permission', (params) => {
      const s = [...this.sessions].find(x => x.sessionId === params?.sessionId);
      return s ? s._permission(params) : { outcome: { outcome: 'cancelled' } };
    });
    conn.on('update', ({ sessionId, update }) => { for (const s of this.sessions) if (s.sessionId === sessionId) s._update(update); });
    conn.on('exit', (info) => {
      if (this.conn === conn) this.conn = null;
      for (const s of [...this.sessions]) if (s.conn === conn) s._exit(info.code ?? 1, info.signal, info.stderr);
    });
    return conn;
  }

  /** Start (or, with `resume`, reopen) one session. Resolves through the handle's 'init'. */
  start({ cwd, model, permissionMode = 'default', resume }) {
    const conn = this._connect();
    const s = new AcpSession(this, conn, { cwd, model, permissionMode, resume });
    this.sessions.add(s);
    return s;
  }

  _gone(s) {
    this.sessions.delete(s);
    if (!this.sessions.size && this.conn === s.conn) { this.conn = null; this.closing = s.conn.close().catch(() => {}); }
  }

  /** Close every session and the connection; resolves when the agent has exited. */
  async close() {
    await Promise.allSettled([...this.sessions].map(s => s.stop()));
    if (this.conn) await this.conn.close();
    await this.closing;
  }
}

class AcpSession extends EventEmitter {
  constructor(driver, conn, { cwd, model, permissionMode, resume }) {
    super();
    this.driver = driver; this.conn = conn;
    this.pid = conn.child?.pid ?? null;
    this.cwd = cwd; this.permissionMode = permissionMode;
    this.sessionId = resume || null;
    this.map = new AcpEvents();
    this.pending = new Map();   // requestId -> { params, resolve }
    this.exited = false;
    this.prompting = false;
    this.n = 0;
    this.ready = this._open({ model, resume });
    this.ready.catch((e) => this._exit(1, null, e.message));
  }

  async _open({ model, resume }) {
    await this.driver.ready;
    const params = { cwd: this.cwd, mcpServers: [] };
    const r = resume
      ? await this.conn.request('session/resume', { sessionId: resume, ...params })
      : await this.conn.request('session/new', params);
    if (!resume) this.sessionId = r.sessionId;
    let options = r?.configOptions || [];
    const set = async (configId, value) => { options = (await this.conn.request('session/set_config_option', { sessionId: this.sessionId, configId, value }))?.configOptions || options; };
    const wantMode = this.permissionMode === 'plan' ? 'plan' : 'build';
    const modeOpt = options.find(o => o.category === 'mode' || o.id === 'mode');
    if (modeOpt && modeOpt.currentValue !== wantMode && modeOpt.options?.some(o => o.value === wantMode)) await set(modeOpt.id, wantMode);
    const modelOpt = options.find(o => o.category === 'model');
    if (model && modelOpt?.options?.some(o => o.value === model)) await set(modelOpt.id, model);
    const values = configValues(options);
    // init first: it gives the deck the session's real id, which the events then travel under.
    this.emit('init', { sessionId: this.sessionId, model: values.model || null, permissionMode: this.permissionMode });
    this.emit('events', { events: [], meta: values });
  }

  /** Send a prompt. Prompts sent before the session is open wait for it. */
  send(text, attachments) {
    if (this.exited) return false;
    this.ready.then(() => this._prompt(text, attachments), () => {});
    return true;
  }

  async _prompt(text, attachments = []) {
    if (this.exited) return;
    const blocks = [];
    for (const a of attachments) {
      if (a.kind === 'image') blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
      else if (a.kind === 'pdf') blocks.push({ type: 'resource', resource: { uri: `attachment:///${encodeURIComponent(a.name)}`, mimeType: a.mediaType, blob: a.data } });
      else blocks.push({ type: 'text', text: `Attached file ${a.name}:\n\n${Buffer.from(a.data, 'base64').toString('utf8')}` });
    }
    if (text?.trim()) blocks.push({ type: 'text', text });
    // Described the way lib/transcript.mjs promptParts() describes them; the files themselves are not kept.
    this.emit('events', { events: [this.map.prompt(text, attachments.map((a, index) => ({ kind: a.kind, index, name: a.name, mediaType: a.mediaType, bytes: a.data.length })))] });
    const started = Date.now();
    this.prompting = true;
    let r, error = null;
    try { r = await this.conn.request('session/prompt', { sessionId: this.sessionId, prompt: blocks }); }
    catch (e) { error = e; }
    finally { this.prompting = false; }
    if (this.exited) return;
    this._cancelPermissions();
    if (!error) this.emit('events', { events: [this.map.turnEnd(r)] });
    this.emit('result', { subtype: error ? 'error' : r?.stopReason === 'end_turn' ? 'success' : r?.stopReason || null, isError: !!error,
      durationMs: Date.now() - started, costUsd: null, stopReason: r?.stopReason ?? null, at: Date.now(),
      error: error ? String(error.message).slice(0, 500) : null });
  }

  /** Ask the agent to end the turn; pending permission prompts are cancelled with it. */
  interrupt() {
    if (this.exited || !this.sessionId) return;
    this._cancelPermissions();
    this.conn.notify('session/cancel', { sessionId: this.sessionId });
  }

  _permission(params) {
    const tc = params.toolCall || {};
    const pick = (kind) => ({ outcome: { outcome: 'selected', optionId: (params.options || []).find(o => o.kind === kind)?.optionId } });
    if (this.permissionMode === 'auto') return pick('allow_once');
    const requestId = `acp-${++this.n}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, { params, resolve, pick });
      const diff = (tc.content || []).find(c => c?.type === 'diff');
      this.emit('permission', {
        requestId, toolName: tc.name || tc.kind || 'tool', displayName: tc.title || tc.name || tc.kind, kind: tc.kind || null,
        input: tc.rawInput ?? {}, rawInput: tc.rawInput ?? {}, description: null, toolUseId: tc.toolCallId || null,
        suggestions: [], blockedPath: null, reason: null, at: Date.now(),
        diff: diff ? { path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText ?? '' } : undefined,
      });
    });
  }

  /** Answer a 'permission' this session emitted. decision: allow | always | deny. */
  answer(p, decision) {
    const w = this.pending.get(p.requestId);
    if (!w) return;
    this.pending.delete(p.requestId);
    w.resolve(w.pick(DECISION_KIND[decision] || 'reject_once'));
  }

  _cancelPermissions() {
    for (const [requestId, w] of this.pending) { w.resolve({ outcome: { outcome: 'cancelled' } }); this.emit('permission-cancel', requestId); }
    this.pending.clear();
  }

  _update(u) {
    const { events, meta } = this.map.update(u);
    if (events.length || meta) this.emit('events', { events, meta });
  }

  /** The process is shared, so a signal means: interrupt (SIGINT) or stop this session. */
  signal(sig) { if (sig === 'SIGINT') this.interrupt(); else this.stop(); }

  /** Close the session (the agent keeps it on disk for a later resume). */
  stop() { return (this.stopping ||= this._stop()); }

  async _stop() {
    if (this.exited) return;
    this._cancelPermissions();
    if (this.prompting) this.conn.notify('session/cancel', { sessionId: this.sessionId });
    if (this.sessionId && this.conn.agent?.agentCapabilities?.sessionCapabilities?.close) {
      await this.conn.request('session/close', { sessionId: this.sessionId }).catch(() => {});
    }
    this._exit(0, null, '');
  }

  _exit(code, signal, stderr) {
    if (this.exited) return;
    this.exited = true;
    this._cancelPermissions();
    this.driver._gone(this);
    this.emit('exit', { code, signal, stderr: stderr || '' });
  }
}
