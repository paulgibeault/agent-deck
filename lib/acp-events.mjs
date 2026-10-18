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
//   tool_call(_update)    → tool      keyed by toolCallId; pending until completed/failed
//   usage_update          → meta.context {used, size}, meta.cost
//   config_option_update  → meta.model / mode / effort
//   prompt response       → turn_end  (see turnEnd)
//   anything else         → raw
import fs from 'node:fs';
import path from 'node:path';
import { INLINE_RESULT_LIMIT } from './transcript.mjs';

const SILENT = new Set(['available_commands_update', 'current_mode_update']);
const DONE = new Set(['completed', 'failed']);

function oneLine(s, max = 110) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
const countLines = (s) => typeof s === 'string' && s.length ? s.split('\n').length : 0;

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

export class AcpEvents {
  constructor() {
    this.tools = new Map();   // toolCallId -> accumulated ACP fields
    this.msgs = new Map();    // event id -> accumulated text
    this.n = 0;
  }

  _id(prefix) { return `${prefix}${++this.n}`; }
  _ts() { return new Date().toISOString(); }

  /** The deck's own prompt, which ACP does not echo back. */
  prompt(text, attachments) {
    return { id: this._id('p'), ts: this._ts(), kind: 'prompt', text, attachments: attachments?.length ? attachments : undefined };
  }

  /** The prompt response: { stopReason, usage }. */
  turnEnd({ stopReason, usage } = {}) {
    return { id: this._id('e'), ts: this._ts(), kind: 'turn_end', text: stopReason || '', stopReason,
      usage: usage ? { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, cache_read_input_tokens: usage.cachedReadTokens || 0 } : undefined };
  }

  /** One session/update payload → { events, meta }. */
  update(u) {
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
    if (diffs.length) {
      const d = diffs[0];
      tool.diff = { file: realpath(d.path), add: countLines(d.newText), del: countLines(d.oldText), created: d.oldText == null || undefined };
    } else if (t.kind === 'edit' && typeof input.content === 'string' && paths[0]) {
      tool.diff = { file: paths[0], add: countLines(input.content), del: 0 };
    }
    return { id: u.toolCallId, ts: t.firstTs, kind: 'tool', tool };
  }

  _summary(t, input, paths) {
    if (typeof input.command === 'string') return oneLine(input.command, 120);
    if (paths.length) return paths.map(p => path.basename(p)).join(', ');
    const title = t.title && t.title !== t.name ? t.title : '';
    return oneLine(title || input.pattern || input.query || input.url || JSON.stringify(input), 110);
  }
}
