// lib/harness/claude.mjs — the Claude Code driver: one `claude -p` process
// per session, over the documented stream-json interface (the Agent SDK wire
// format):
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --session-id <uuid> --permission-prompt-tool stdio …
//
// Permission prompts arrive as `control_request/can_use_tool`; interrupt is
// `control_request/interrupt`; `stop_task` stops one subagent or background
// command. Events still come from the transcript file; stdout is read only
// for state: init, result, control, and the task_* lines that say which
// subagents are running. The queue, wake and idle rules live in
// lib/agent.mjs, which knows none of this.
//
// Two things the transcript never holds come from stdout alone (lib/live.mjs
// turns them into what the UI shows):
//   --include-partial-messages   the reply as it is written (stream_event
//                                deltas), plus `status` (requesting,
//                                compacting) and thinking-token estimates
//   --include-hook-events        each hook run: started, then its output and
//                                exit code
//
// start() returns a session that emits:
//   'init' {sessionId, model, permissionMode}   the CLI is up (a resume may get a new id)
//   'result' {subtype, isError, durationMs, costUsd, stopReason, error}   a turn ended
//   'permission' {requestId, toolName, …}   'permission-cancel' requestId
//   'task' {id, type, status, activity, parentTaskId, at}   a subagent or background task changed
//   'ratelimit' rate_limit_info              'exit' {code, signal, stderr}
//   'live' {msgId, blocks: [{type, name, text, tokens}], at} | null   the message being written; null once it is done
//   'status' {status, compactResult}         requesting | compacting | null (back to work)
//   'thinking' {tokens}                      the CLI's running estimate for the current thinking block
//   'hook' {id, name, event, phase, outcome, exitCode, stdout, stderr, at}   a hook run started (phase 'started') or ended ('response')
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { childEnv } from '../llm.mjs';

export const BIN = process.env.DECK_AGENT_BIN
  ? (process.env.DECK_AGENT_BIN.includes('/') ? path.resolve(process.env.DECK_AGENT_BIN) : process.env.DECK_AGENT_BIN)
  : 'claude';
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
const MODE_LABELS = { default: 'Ask me in the deck', acceptEdits: 'Accept edits, ask for the rest', auto: 'Auto (classifier decides)', plan: 'Plan only, no changes' };
const MAX_INPUT_CHARS = 20_000;
// The CLI would hand AskUserQuestion to the host as a permission prompt and
// expect answers back in a shape the deck does not build; without it the
// agent asks in plain text and the pilot replies with a prompt.
const DISALLOWED = ['AskUserQuestion'];
// The status each task_* line implies (null: it does not say).
const TASK_STATUS = { task_started: 'running', task_progress: 'running', task_updated: null, task_notification: null };
// How much of a hook's output travels with its event.
const HOOK_OUTPUT_CHARS = 4000;
const clip = (s, n = HOOK_OUTPUT_CHARS) => typeof s === 'string' ? (s.length > n ? s.slice(0, n) + `\n…[${s.length} chars]` : s) : null;

function capInput(input) {
  const s = JSON.stringify(input ?? {});
  if (s.length <= MAX_INPUT_CHARS) return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + `\n…[${v.length} chars]` : v;
  return out;
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

export class ClaudeDriver {
  constructor({ bin = BIN, label = 'Claude Code' } = {}) {
    this.bin = bin;
    this.label = label;
    this.type = 'claude';
    this.actor = 'Claude';
    this.resumeCommand = `${bin === BIN ? 'claude' : bin} --resume {id}`;
    this.caps = { modes: PERMISSION_MODES, modeLabels: MODE_LABELS, resume: true, events: 'transcript', subagents: true };
  }

  /** Spawn the CLI for one session. Throws if it cannot be spawned at all. */
  start({ id, cwd, model, permissionMode, name, resume }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', permissionMode, '--disallowedTools', ...DISALLOWED,
      '--include-partial-messages', '--include-hook-events'];
    args.push(...(resume ? ['--resume', resume] : ['--session-id', id]));
    if (model) args.push('--model', model);
    if (name) args.push('--name', name);
    let child;
    try { child = spawn(this.bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { throw new Error(`cannot start ${this.bin}: ${e.message}`); }
    return new ClaudeSession(child, this.bin);
  }
}

class ClaudeSession extends EventEmitter {
  constructor(child, bin) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.stderr = '';
    this.out = '';
    this.exited = false;
    this.pending = new Map();   // request_id -> { resolve, reject, timer }: control requests the deck sent
    this.live = null;           // the main thread's message being streamed: { msgId, blocks, at }
    child.stdout.on('data', (d) => this._onStdout(d));
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* EPIPE after exit; 'close' reports it */ });
    child.on('error', (e) => {
      this.stderr += e.code === 'ENOENT' ? `${bin} not found on PATH (set DECK_AGENT_BIN)` : e.message;
      if (!child.pid) this._exit(-1, null);   // never started; 'close' may not follow
    });
    child.on('close', (code, signal) => this._exit(code, signal));
  }

  /** Send a prompt. False if the process can no longer take input. */
  send(text, attachments) {
    return this._write({ type: 'user', message: { role: 'user', content: messageContent(text, attachments) }, parent_tool_use_id: null, session_id: '' });
  }

  /** Ask the CLI to end the current turn. */
  interrupt() {
    this._write({ type: 'control_request', request_id: `deck-int-${randomBytes(4).toString('hex')}`, request: { subtype: 'interrupt' } });
  }

  /** Answer a 'permission' this session emitted. decision: allow | always | deny. */
  answer(p, decision, message) {
    let response;
    if (decision === 'deny') response = { behavior: 'deny', message: message?.trim() || 'The pilot denied this in agent-deck.' };
    else {
      response = { behavior: 'allow', updatedInput: p.rawInput };
      if (decision === 'always' && p.suggestions.length) response.updatedPermissions = p.suggestions;
    }
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response } });
  }

  /** Stop one subagent or background task by its task id (a subagent's is its agent id). */
  stopTask(taskId) { return this._request({ subtype: 'stop_task', task_id: String(taskId) }); }

  /** Send a control request; resolves with its response, rejects with the CLI's error. */
  _request(request, ms = 15_000) {
    const id = `deck-${randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${request.subtype}: no answer from the CLI`)); }, ms);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this._write({ type: 'control_request', request_id: id, request })) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new Error('the session can no longer take input'));
      }
    });
  }

  signal(sig) { try { this.child.kill(sig); } catch { /* gone */ } }

  /** End the process: close stdin, then escalate. */
  stop() {
    try { this.child.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { if (!this.exited) this.signal('SIGTERM'); }, 1500).unref?.();
    setTimeout(() => { if (!this.exited) this.signal('SIGKILL'); }, 6000).unref?.();
  }

  _write(obj) {
    if (this.exited || !this.child.stdin.writable) return false;
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
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.emit('init', { sessionId: msg.session_id || null, model: msg.model || null, permissionMode: msg.permissionMode || null });
        else if (TASK_STATUS[msg.subtype] !== undefined && msg.task_id) this._task(msg);
        else if (msg.subtype === 'status') this.emit('status', { status: msg.status || null, compactResult: msg.compact_result || null, at: Date.now() });
        else if (msg.subtype === 'thinking_tokens') this.emit('thinking', { tokens: msg.estimated_tokens ?? null });
        else if (msg.subtype === 'hook_started' || msg.subtype === 'hook_response') this._hook(msg);
        break;
      case 'stream_event':
        // Subagents' partial messages are not streamed; their transcripts are read instead.
        if (!msg.parent_tool_use_id) this._stream(msg.event || {});
        break;
      case 'control_response': {
        const r = msg.response || {};
        const p = this.pending.get(r.request_id);
        if (!p) break;
        clearTimeout(p.timer); this.pending.delete(r.request_id);
        if (r.subtype === 'error') p.reject(new Error(String(r.error || 'the CLI refused'))); else p.resolve(r.response || {});
        break;
      }
      case 'rate_limit_event':
        if (msg.rate_limit_info) this.emit('ratelimit', msg.rate_limit_info);
        break;
      case 'result':
        if (this.live) { this.live = null; this.emit('live', null); }
        // total_cost_usd is cumulative for the process.
        this.emit('result', { subtype: msg.subtype || null, isError: !!msg.is_error, durationMs: msg.duration_ms ?? null,
          costUsd: msg.total_cost_usd ?? null, stopReason: msg.stop_reason ?? null, at: Date.now(),
          error: msg.is_error ? String(msg.result || msg.subtype || 'turn failed').slice(0, 500) : null });
        break;
      case 'control_request': {
        const r = msg.request || {};
        if (r.subtype === 'can_use_tool') {
          this.emit('permission', {
            requestId: msg.request_id, toolName: r.tool_name, displayName: r.display_name || r.tool_name,
            input: capInput(r.input), rawInput: r.input ?? {}, description: r.description || null, toolUseId: r.tool_use_id || null,
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            blockedPath: r.blocked_path || null, reason: r.decision_reason || null, at: Date.now(),
          });
        } else {
          // Anything else the CLI asks a host (hooks, SDK MCP servers) the deck does not provide.
          this._write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `agent-deck does not handle ${r.subtype}` } });
        }
        break;
      }
      case 'control_cancel_request':
        this.emit('permission-cancel', msg.request_id);
        break;
      default: break;
    }
  }

  /** One stream_event: the main thread's message as it is written. */
  _stream(e) {
    switch (e.type) {
      case 'message_start':
        this.live = { msgId: e.message?.id || null, model: e.message?.model || null, blocks: [], at: Date.now() };
        break;
      case 'content_block_start': {
        if (!this.live) return;
        const b = e.content_block || {};
        this.live.blocks[e.index] = { type: b.type || 'text', name: b.name || null, text: b.type === 'text' ? b.text || '' : '', tokens: null };
        break;
      }
      case 'content_block_delta': {
        const b = this.live?.blocks[e.index];
        const d = e.delta || {};
        if (!b) return;
        if (d.type === 'text_delta') b.text += d.text || '';
        else if (d.type === 'thinking_delta') { b.text += d.thinking || ''; if (d.estimated_tokens != null) b.tokens = d.estimated_tokens; }
        else if (d.type === 'input_json_delta') b.text += d.partial_json || '';
        else return;   // signatures and the like
        break;
      }
      case 'message_stop':
        if (!this.live) return;
        this.live = null;
        this.emit('live', null);
        return;
      default: return;
    }
    if (this.live) { this.live.at = Date.now(); this.emit('live', this.live); }
  }

  /** hook_started / hook_response, as one 'hook' shape. */
  _hook(msg) {
    const done = msg.subtype === 'hook_response';
    this.emit('hook', {
      id: msg.hook_id || msg.uuid || null, name: msg.hook_name || msg.hook_event || 'hook', event: msg.hook_event || null,
      phase: done ? 'response' : 'started', outcome: done ? msg.outcome || null : null, exitCode: done ? msg.exit_code ?? null : null,
      stdout: done ? clip(msg.stdout ?? msg.output) : null, stderr: done ? clip(msg.stderr) : null, at: Date.now(),
    });
  }

  /** task_started / task_progress / task_updated / task_notification, as one 'task' shape. */
  _task(msg) {
    const status = msg.subtype === 'task_updated' ? msg.patch?.status || null
      : msg.subtype === 'task_notification' ? msg.status || null : TASK_STATUS[msg.subtype];
    this.emit('task', {
      id: msg.task_id, type: msg.task_type || null, status: status === 'killed' ? 'stopped' : status,
      // task_progress names what it is doing now; task_started, what it was asked to do.
      activity: msg.subtype === 'task_progress' ? msg.description || null : null,
      description: msg.subtype === 'task_started' ? msg.description || null : null,
      parentTaskId: msg.parent_task_id || null, at: Date.now(),
    });
  }

  _exit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the session ended')); }
    this.pending.clear();
    this.emit('exit', { code, signal, stderr: this.stderr });
  }
}
