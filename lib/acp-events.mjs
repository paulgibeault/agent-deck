// lib/acp-events.mjs — ACP `session/update` payloads → the deck's normalized
// events (the shape in lib/transcript.mjs). The ONLY module that knows ACP's
// update shapes, the way transcript.mjs is the only one that knows Claude's.
//
// Every event has a stable id, so a streamed message or a tool call that
// changes is emitted again in full and SessionState.push() replaces it:
//
//   agent_message_chunk   → text      merged by messageId
//   agent_thought_chunk   → thinking  merged by messageId
//   user_message_chunk    → prompt    (replays; the deck writes its own prompts)
//   tool_call(_update)    → tool      keyed by toolCallId; pending until completed/failed;
//                                     tool.diff keeps oldText/newText of an edit
//   usage_update          → meta.context {used, size}, meta.cost
//   config_option_update  → meta.model / mode / effort
//   prompt response       → turn_end  (see turnEnd)
//   anything else         → raw
//
// Ids the mapper makes up (prompts, turn ends) carry a per-instance tag, so a
// session resumed in a new agent process cannot overwrite its earlier ones.
//
// Replay (session/load, for history): the updates carry no timestamps and no
// prompt responses. With `replay`, each user message starts a new turn (the
// previous one gets a turn_end), finish() ends the last, and times come from
// the message ids where the agent's ids encode one (opencode's do), else the
// `until` time the agent listed for the session.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { INLINE_RESULT_LIMIT } from './transcript.mjs';
import { diffCounts } from '../public/diff.js';

const SILENT = new Set(['available_commands_update', 'current_mode_update']);
const DONE = new Set(['completed', 'failed']);
// How much before/after text of one edit an event carries (the Changes tab and details render it).
const DIFF_TEXT_LIMIT = 256 * 1024;

function oneLine(s, max = 110) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
const countLines = (s) => typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n').length : 0;

/** Text of ACP content blocks ({type:'content', content:{type:'text'}} or bare text blocks). */
function contentText(list) {
  return (list || []).map(c => c?.type === 'content' ? c.content : c).filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

/** Values of the config options a session reports: { model, mode, effort }. */
export function configValues(options) {
  const out = {};
  for (const o of options || []) {
    const key = o.category === 'thought_level' ? 'effort' : o.category || o.id;
    if (['model', 'mode', 'effort'].includes(key)) out[key] = o.currentValue ?? null;
  }
  return out;
}

/**
 * When an opencode message was created, from its id (msg_ + 12 hex digits:
 * milliseconds × 4096 + a counter, kept to 48 bits), taken as the time
 * nearest `near` with those low bits. Null for any other id.
 */
export function opencodeIdTime(messageId, near = Date.now()) {
  const m = /^msg_([0-9a-f]{12})/.exec(String(messageId || ''));
  if (!m) return null;
  const P = 2 ** 36;
  const low = Math.floor(parseInt(m[1], 16) / 4096);
  let t = near - (((near % P) + P) % P) + low;
  if (t > near + P / 2) t -= P; else if (t < near - P / 2) t += P;
  return t;
}

export class AcpEvents {
  constructor({ replay = false, until = null } = {}) {
    this.tools = new Map();   // toolCallId -> accumulated ACP fields
    this.msgs = new Map();    // event id -> accumulated text
    this.n = 0;
    this.tag = randomBytes(3).toString('hex');
    this.replay = replay;
    this.until = until ?? Date.now();
    this.clock = null;        // replay: the time of the newest message seen
    this.turnOpen = false;    // replay: events since the last user message
    this.lastUser = null;
  }

  _id(prefix) { return `${prefix}${this.tag}.${++this.n}`; }
  _ts() { return new Date(this.replay ? this.clock ?? this.until : Date.now()).toISOString(); }

  /** Replay: the turn_end that closes the last turn, if one is open. */
  finish() {
    if (!this.replay || !this.turnOpen) return [];
    this.turnOpen = false;
    return [{ id: this._id('e'), ts: this._ts(), kind: 'turn_end', text: '', stopReason: 'end_turn' }];
  }

  /** The deck's own prompt, which ACP does not echo back. */
  prompt(text, attachments) {
    // The files themselves are not kept, so the page shows them by name and size only.
    return { id: this._id('p'), ts: this._ts(), kind: 'prompt', text, attachments: attachments?.length ? attachments.map(a => ({ ...a, kept: false })) : undefined };
  }

  /** The prompt response: { stopReason, usage }. */
  turnEnd({ stopReason, usage } = {}) {
    return { id: this._id('e'), ts: this._ts(), kind: 'turn_end', text: stopReason || '', stopReason,
      usage: usage ? { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, cache_read_input_tokens: usage.cachedReadTokens || 0 } : undefined };
  }

  /** One session/update payload → { events, meta }. */
  update(u) { return this.replay ? this._replay(u) : this._map(u); }

  _map(u) {
    const ts = this._ts();
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': return { events: [this._chunk('t', 'text', u, ts)] };
      case 'agent_thought_chunk': return { events: [this._chunk('k', 'thinking', u, ts)] };
      case 'user_message_chunk': return { events: [this._chunk('u', 'prompt', u, ts)] };
      case 'tool_call': case 'tool_call_update': return { events: [this._tool(u, ts)] };
      case 'usage_update':
        return { events: [], meta: { context: { used: u.used ?? null, size: u.size ?? null }, cost: u.cost?.amount != null ? { totalCostUSD: u.cost.amount, currency: u.cost.currency } : undefined } };
      case 'config_option_update': return { events: [], meta: configValues(u.configOptions) };
      default:
        if (SILENT.has(u?.sessionUpdate)) return { events: [] };
        return { events: [{ id: this._id('r'), ts, kind: 'raw', subtype: u?.sessionUpdate || 'update', text: oneLine(JSON.stringify(u), 300) }] };
    }
  }

  _replay(u) {
    const t = opencodeIdTime(u?.messageId, this.until);
    if (t != null && t <= this.until + 60_000) this.clock = Math.max(this.clock ?? 0, t);
    const pre = [];
    if (u?.sessionUpdate === 'user_message_chunk' && u.messageId !== this.lastUser) {
      pre.push(...this.finish());
      this.lastUser = u.messageId;
    }
    const r = this._map(u);
    if (r.events.some(e => e.kind !== 'prompt')) this.turnOpen = true;
    return { ...r, events: [...pre, ...r.events] };
  }

  _chunk(prefix, kind, u, ts) {
    const id = `${prefix}:${u.messageId || this.n}`;
    const text = (this.msgs.get(id) || '') + (u.content?.type === 'text' ? u.content.text : '');
    this.msgs.set(id, text);
    return { id, ts, kind, text };
  }

  _tool(u, ts) {
    const t = this.tools.get(u.toolCallId) || { firstTs: ts };
    // An update only carries what changed; an empty rawInput or locations means "not known yet".
    for (const [k, v] of Object.entries(u)) {
      if (v == null || k === 'sessionUpdate') continue;
      if ((k === 'rawInput' && !Object.keys(v).length) || (k === 'locations' && !v.length)) continue;
      t[k] = v;
    }
    this.tools.set(u.toolCallId, t);
    const input = t.rawInput || {};
    const name = t.name || t.kind || 'tool';
    const paths = (t.locations || []).map(l => l.path && realpath(l.path)).filter(Boolean);
    const diffs = (t.content || []).filter(c => c?.type === 'diff');
    const pending = !DONE.has(t.status);
    const tool = { name, display: name, kind: t.kind || 'other', summary: this._summary(t, input, paths), input, pending, paths,
      command: typeof input.command === 'string' ? input.command : undefined };
    if (!pending) {
      const text = contentText(t.content) || (t.rawOutput?.error ? String(t.rawOutput.error) : '');
      tool.result = { text: text.slice(0, INLINE_RESULT_LIMIT), truncated: text.length > INLINE_RESULT_LIMIT, length: text.length };
      tool.isError = t.status === 'failed';
      tool.durationMs = Math.max(0, Date.parse(ts) - Date.parse(t.firstTs));
    }
    // The texts travel with the event (there is no transcript to fetch them from later), within reason.
    const texts = (oldText, newText) => (oldText?.length || 0) + (newText?.length || 0) <= DIFF_TEXT_LIMIT ? { oldText: oldText ?? null, newText: newText ?? '' } : { textOmitted: true };
    if (diffs.length) {
      const d = diffs[0];
      // ACP sends whole files, so count the lines that changed, not the lines in them.
      const counts = d.oldText == null ? { add: countLines(d.newText), del: 0 } : diffCounts(d.oldText.replace(/\n$/, ''), (d.newText ?? '').replace(/\n$/, ''));
      tool.diff = { file: realpath(d.path), ...counts, created: d.oldText == null || undefined, ...texts(d.oldText, d.newText) };
    } else if (t.kind === 'edit' && typeof input.content === 'string' && paths[0]) {
      tool.diff = { file: paths[0], add: countLines(input.content), del: 0, ...texts(null, input.content) };
    }
    return { id: u.toolCallId, ts: t.firstTs, kind: 'tool', tool };
  }

  _summary(t, input, paths) {
    if (typeof input.command === 'string') return oneLine(input.command, 120);
    if (paths.length) return paths.map(p => path.basename(p)).join(', ');
    const title = t.title && t.title !== t.name ? t.title : '';
    // Before its input arrives a call has only a name; say nothing rather than "{}".
    return oneLine(title || input.pattern || input.query || input.url || (Object.keys(input).length ? JSON.stringify(input) : ''), 110);
  }
}
