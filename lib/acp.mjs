// lib/acp.mjs — a client for the Agent Client Protocol (agentclientprotocol.com):
// JSON-RPC 2.0, one message per line, over an agent process's stdio.
//
// Harness-neutral: nothing here knows opencode. One connection carries many
// sessions; `session/update` notifications are re-emitted as 'update', and
// requests the agent makes of the client go to handlers registered with
// onRequest(). The deck advertises no fs or terminal capability, so an agent
// asking for anything without a handler gets -32601.
//
//   const conn = new AcpConnection({ bin: 'opencode', args: ['acp'], cwd });
//   await conn.initialize();
//   const { sessionId } = await conn.request('session/new', { cwd, mcpServers: [] });
//   conn.on('update', ({ sessionId, update }) => …);
//   conn.onRequest('session/request_permission', async (params) => ({ outcome: … }));
//   await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
//   await conn.close();
//
// Emits 'update' {sessionId, update}, 'notification' {method, params} for
// other notifications, and 'exit' {code, signal, stderr} once the process ends.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const PROTOCOL_VERSION = 1;
const CLOSE_SESSION_MS = 3_000;   // per session/close at shutdown
const EOF_GRACE_MS = 1_500;       // after stdin ends, before SIGTERM
const TERM_GRACE_MS = 4_500;      // after SIGTERM, before SIGKILL

/** A JSON-RPC error reply. `code` and `data` are the agent's. */
export class AcpError extends Error {
  constructor(method, { code, message, data } = {}) {
    super(message || `${method} failed`);
    this.method = method; this.code = code; this.data = data;
  }
}

export class AcpConnection extends EventEmitter {
  constructor({ bin, args = [], env = process.env, cwd, clientInfo = { name: 'agent-deck', version: '0' } }) {
    super();
    this.bin = bin;
    this.clientInfo = clientInfo;
    this.nextId = 1;
    this.pending = new Map();     // our request id -> { method, params, resolve, reject }
    this.handlers = new Map();    // agent -> client method -> handler(params, { id })
    this.sessions = new Set();    // open sessions, closed at shutdown
    this.prompting = new Set();   // sessions with a session/prompt in flight
    this.agent = null;            // initialize result: agentCapabilities, agentInfo, authMethods
    this.stderr = '';
    this.exitInfo = null;
    this.out = '';
    this.exited = new Promise((r) => { this._onExited = r; });

    try { this.child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { this.child = null; this._exit(-1, null, `cannot start ${bin}: ${e.message}`); return; }
    this.child.stdout.on('data', (d) => this._onStdout(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.stdin.on('error', () => { /* EPIPE after exit; 'close' reports it */ });
    this.child.on('error', (e) => {
      const msg = e.code === 'ENOENT' ? `${bin} not found on PATH` : e.message;
      if (!this.child.pid) this._exit(-1, null, msg);   // never started; 'close' may not follow
      else this.stderr += msg;
    });
    this.child.on('close', (code, signal) => this._exit(code, signal));
  }

  get alive() { return !this.exitInfo; }

  /** Negotiate the protocol. Resolves the agent's initialize result. */
  async initialize({ fs = false, terminal = false } = {}) {
    this.agent = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: fs, writeTextFile: fs }, terminal },
      clientInfo: this.clientInfo,
    });
    if (this.agent?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`${this.bin} speaks ACP version ${this.agent?.protocolVersion}, the deck speaks ${PROTOCOL_VERSION}`);
    }
    return this.agent;
  }

  /** Call a method. Resolves its result; rejects with AcpError, or Error if the process is gone. */
  request(method, params) {
    if (!this.alive) return Promise.reject(this._goneError());
    const id = this.nextId++;
    const sessionId = params?.sessionId;
    if (method === 'session/prompt') this.prompting.add(sessionId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params });
    }).then((result) => {
      if (method === 'session/new' && result?.sessionId) this.sessions.add(result.sessionId);
      if ((method === 'session/load' || method === 'session/resume') && sessionId) this.sessions.add(sessionId);
      if (method === 'session/close') this.sessions.delete(sessionId);
      return result;
    }).finally(() => { if (method === 'session/prompt') this.prompting.delete(sessionId); });
  }

  /** Send a notification (no reply), e.g. session/cancel. */
  notify(method, params) {
    if (this.alive) this._write({ jsonrpc: '2.0', method, params });
  }

  /** Answer the agent's `method` requests with `handler(params)`; its return (or throw) is the reply. */
  onRequest(method, handler) { this.handlers.set(method, handler); return this; }

  /**
   * Shut down without stranding a session: cancel prompts in flight, close
   * each open session (when the agent supports it), end stdin, then signal.
   * Resolves the exit info.
   */
  async close() {
    if (!this.alive) return this.exitInfo;
    for (const sessionId of this.prompting) this.notify('session/cancel', { sessionId });
    if (this.agent?.agentCapabilities?.sessionCapabilities?.close) {
      await Promise.allSettled([...this.sessions].map((sessionId) => withTimeout(this.request('session/close', { sessionId }), CLOSE_SESSION_MS)));
    }
    try { this.child.stdin.end(); } catch { /* closed */ }
    if (await withTimeout(this.exited, EOF_GRACE_MS).catch(() => null)) return this.exitInfo;
    try { this.child.kill('SIGTERM'); } catch { /* gone */ }
    if (await withTimeout(this.exited, TERM_GRACE_MS).catch(() => null)) return this.exitInfo;
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    return this.exited;
  }

  // ------------------------------------------------------------ internals

  _write(obj) {
    if (!this.child?.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  _onStdout(chunk) {
    this.out += chunk;
    let i;
    while ((i = this.out.indexOf('\n')) >= 0) {
      const line = this.out.slice(0, i).trim();
      this.out = this.out.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    // Agent -> client request ids may be 0, so test for presence, not truthiness.
    const hasId = msg.id !== undefined && msg.id !== null;
    if (msg.method && hasId) return this._onRequest(msg);
    if (msg.method) {
      if (msg.method === 'session/update') this.emit('update', msg.params || {});
      else this.emit('notification', { method: msg.method, params: msg.params });
      return;
    }
    const p = hasId && this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new AcpError(p.method, msg.error));
    else p.resolve(msg.result ?? null);
  }

  async _onRequest({ id, method, params }) {
    const handler = this.handlers.get(method);
    if (!handler) return this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    try {
      const result = await handler(params, { id });
      this._write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      this._write({ jsonrpc: '2.0', id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message || String(e) } });
    }
  }

  _goneError() {
    const { code, signal } = this.exitInfo;
    const tail = this.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return new Error(`${this.bin} exited ${signal || code}${tail ? `: ${tail}` : ''}`);
  }

  _exit(code, signal, why) {
    if (this.exitInfo) return;
    if (why) this.stderr += why;
    this.exitInfo = { code, signal, stderr: this.stderr };
    const err = this._goneError();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.sessions.clear(); this.prompting.clear();
    this._onExited(this.exitInfo);
    this.emit('exit', this.exitInfo);
  }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timed out')), ms); })])
    .finally(() => clearTimeout(t));
}
