// lib/acp-events.mjs — ACP `session/update` payloads → the deck's normalized
// events (the shape in lib/transcript.mjs). The ONLY module that knows ACP's
// update shapes, the way transcript.mjs is the only one that knows Claude's.
//
// Every event has a stable id, so a streamed message or a tool call that
// changes is emitted again in full and SessionState.push() replaces it:
//
//   agent_message_chunk   → text      merged by messageId
//   agent_thought_chunk   → thinking  merged by messageId
//   user_message_chunk    → prompt    (session/load replays them; live, the deck writes its own)
//   tool_call(_update)    → tool      keyed by toolCallId; pending until completed/failed;
//                                     tool.diff keeps oldText/newText of an edit
//   usage_update          → meta.context {used, size}, meta.cost
//   config_option_update  → meta.model / mode / effort
//   session_info_update   → system api_error while opencode retries a failed
//     with opencode/retry   model call: one event per turn, updated in place
//                           (a null retry, sent as each attempt starts, says nothing)
//   prompt response       → turn_end  (see turnEnd)
//   anything else         → raw
import fs from 'node:fs';
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

export class AcpEvents {
  /** `epoch` sets this mapper's ids apart from an earlier one's for the same session (each reopen gets a new mapper). */
  constructor(epoch = '') {
    this.epoch = epoch;
    this.tools = new Map();   // toolCallId -> accumulated ACP fields
    this.msgs = new Map();    // event id -> accumulated text
    this.n = 0;
    this.retryEv = null;      // this turn's retry event
  }

  _id(prefix) { return `${prefix}${this.epoch}${++this.n}`; }
  _ts() { return new Date().toISOString(); }

  /** The deck's own prompt, which ACP does not echo back. */
  prompt(text, attachments) {
    this.retryEv = null;
    // The files themselves are not kept, so the page shows them by name and size only.
    return { id: this._id('p'), ts: this._ts(), kind: 'prompt', text, attachments: attachments?.length ? attachments.map(a => ({ ...a, kept: false })) : undefined };
  }

  /** The prompt response: { stopReason, usage }. */
  turnEnd({ stopReason, usage } = {}) {
    this.retryEv = null;
    return { id: this._id('e'), ts: this._ts(), kind: 'turn_end', text: stopReason || '', stopReason,
      usage: usage ? { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, cache_read_input_tokens: usage.cachedReadTokens || 0 } : undefined };
  }

  /** One session/update payload → { events, meta }. */
  update(u) {
    const ts = this._ts();
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': return { events: [...this._recovered(), this._chunk('t', 'text', u, ts)] };
      case 'agent_thought_chunk': return { events: [...this._recovered(), this._chunk('k', 'thinking', u, ts)] };
      case 'user_message_chunk': this.retryEv = null; return { events: [this._chunk('u', 'prompt', u, ts)] };
      case 'tool_call': case 'tool_call_update': return { events: [...this._recovered(), this._tool(u, ts)] };
      case 'usage_update':
        return { events: [], meta: { context: { used: u.used ?? null, size: u.size ?? null }, cost: u.cost?.amount != null ? { totalCostUSD: u.cost.amount, currency: u.cost.currency } : undefined } };
      case 'config_option_update': return { events: [], meta: configValues(u.configOptions) };
      case 'session_info_update':
        if (u._meta && 'opencode/retry' in u._meta) return { events: this._retry(u._meta['opencode/retry'], ts) };
        // falls through
      default:
        if (SILENT.has(u?.sessionUpdate)) return { events: [] };
        return { events: [{ id: this._id('r'), ts, kind: 'raw', subtype: u?.sessionUpdate || 'update', text: oneLine(JSON.stringify(u), 300) }] };
    }
  }

  /** opencode retrying a model call that failed: shaped like a Claude transcript's api_error. */
  _retry(r, ts) {
    if (!r) return [];
    const e = r.error || {};
    const next = Date.parse(r.nextRetryAt);
    this.retryEv = { id: this.retryEv?.id || this._id('x'), ts, kind: 'system', subtype: 'api_error', error: true,
      text: oneLine([e.status, e.message || e.type || 'model call failed'].filter(Boolean).join(' '), 300),
      status: e.status ?? null, retry: r.attempt ?? null, retryInMs: Number.isFinite(next) ? Math.max(0, next - Date.parse(ts)) : null };
    return [this.retryEv];
  }

  /**
   * The model answered after retrying: the retry event once more, no longer an
   * error, and done with, so a later failure in the same turn gets a row of its own.
   */
  _recovered() {
    const ev = this.retryEv;
    if (!ev) return [];
    this.retryEv = null;
    return ev.gaveUp ? [] : [{ ...ev, error: false, retryInMs: null, recovered: true }];
  }

  /** The retry event again, once the deck has stopped the retries: no next try, and why. */
  gaveUp(note) {
    const ev = this.retryEv;
    if (!ev) return null;
    this.retryEv = { ...ev, retryInMs: null, gaveUp: true, text: note ? `${ev.text} · ${note}` : ev.text };
    return this.retryEv;
  }

  _chunk(prefix, kind, u, ts) {
    const id = `${prefix}:${u.messageId || `${this.epoch}${this.n}`}`;
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
