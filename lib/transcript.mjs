// lib/transcript.mjs
//
// The ONLY module that knows Claude Code's on-disk transcript format
// (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl and the subagent
// transcripts next to it). Everything else in the deck consumes the
// normalized events and session metadata produced here.
//
// Verified against Claude Code 2.1.284 (macOS, 2026-09-30). Unknown record
// types degrade to `kind: 'raw'` events instead of throwing, so a CLI upgrade
// should dim the deck rather than break it.
//
// Normalized event shape (what the UI consumes):
//   { id, seq, sessionId, parentId?, ts, kind, text?, usage?, model?,
//     tool?: { name, display, summary, input, result?, meta?, durationMs?,
//              isError?, pending, agentId? },
//     error?, subtype?, op?, hidden? }
//   kind: 'text' | 'thinking' | 'tool' | 'prompt' | 'turn_end' | 'queue' |
//         'system' | 'raw'

import fs from 'node:fs';
import path from 'node:path';

// Record types that are pure bookkeeping for Claude Code itself and carry
// nothing a pilot wants to see as an event. They still feed metadata where
// useful (see SessionState.ingest).
const SILENT_TYPES = new Set([
  'attachment', 'atis-latch', 'bridge-session', 'file-history-snapshot',
  'file-history-delta', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
  'last-prompt', 'custom-title', 'ai-title', 'agent-name', 'mode', 'effort',
  'cost-state', 'pr-link', 'model',
]);

// How much tool result text travels inline with an event over SSE. The full
// text is always available through the per-event endpoint.
export const INLINE_RESULT_LIMIT = 16 * 1024;

export function parseLine(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Incremental reader for an append-only jsonl file. Keeps the byte offset
 * and the trailing partial line between calls; never re-reads the file.
 */
export class TranscriptTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
    this.lines = 0;
  }

  /** Returns the records appended since the last call. */
  readNew() {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    if (st.size < this.offset) { // truncated / rewritten: start over
      this.offset = 0; this.partial = ''; this.lines = 0;
    }
    if (st.size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    const out = [];
    try {
      const len = st.size - this.offset;
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      const text = this.partial + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      this.partial = parts.pop();
      for (const p of parts) {
        if (!p.trim()) continue;
        this.lines++;
        const rec = parseLine(p);
        if (rec) out.push(rec);
      }
    } finally { fs.closeSync(fd); }
    return out;
  }
}

// ---------------------------------------------------------------- helpers

export function displayToolName(name) {
  if (!name) return '?';
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[1]}.${m[2]}`;
  return name;
}

function base(p) { return typeof p === 'string' ? path.basename(p) : ''; }
function oneLine(s, max = 110) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function countLines(s) { return typeof s === 'string' && s.length ? s.split('\n').length : 0; }
function shortJson(obj, max = 90) {
  try { return oneLine(JSON.stringify(obj) ?? '', max); } catch { return ''; }
}

/** A one-line, tool-specific description of a tool call for the Events row. */
export function toolSummary(name, input = {}) {
  switch (name) {
    case 'Bash': return oneLine(input.command, 120);
    case 'Read': {
      const range = input.offset != null || input.limit != null
        ? ` :${input.offset ?? 1}${input.limit != null ? `+${input.limit}` : ''}` : '';
      return base(input.file_path) + range;
    }
    case 'Write': return `${base(input.file_path)} (${countLines(input.content)} lines)`;
    case 'Edit': return `${base(input.file_path)} +${countLines(input.new_string)} −${countLines(input.old_string)}`;
    case 'MultiEdit': return `${base(input.file_path)} ×${(input.edits || []).length}`;
    case 'NotebookEdit': return base(input.notebook_path);
    case 'Glob': return `${input.pattern ?? ''}${input.path ? ` in ${base(input.path)}` : ''}`;
    case 'Grep': return `/${input.pattern ?? ''}/${input.path ? ` in ${base(input.path) || input.path}` : ''}`;
    case 'Agent': return `"${input.description ?? oneLine(input.prompt, 60)}"${input.subagent_type ? ` · ${input.subagent_type}` : ''}`;
    case 'ToolSearch': return oneLine(input.query, 90);
    case 'WebFetch': return oneLine(input.url, 100);
    case 'WebSearch': return oneLine(input.query, 100);
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    case 'Skill': return `${input.skill ?? ''}${input.args ? ' ' + oneLine(input.args, 60) : ''}`;
    case 'AskUserQuestion': return oneLine((input.questions || []).map(q => q.question).join(' | '), 100);
    case 'SendUserFile': return (input.files || []).map(base).join(', ');
    default: return shortJson(input);
  }
}

/** Paths a tool call touches, for the Files tab. */
export function toolPaths(name, input = {}) {
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return input.file_path ? [{ path: input.file_path, op: name.toLowerCase() === 'read' ? 'read' : 'write' }] : [];
    case 'NotebookEdit':
      return input.notebook_path ? [{ path: input.notebook_path, op: 'write' }] : [];
    default: return [];
  }
}

// Strip bulky duplicates out of toolUseResult so it can travel with the
// event; the raw record is still reachable through the per-event endpoint.
const BULKY_KEYS = new Set(['content', 'stdout', 'stderr', 'oldString', 'newString',
  'originalFile', 'result', 'prompt', 'file', 'data', 'rendered', 'text']);
function slimMeta(v, depth = 0) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return depth > 2 ? `[${v.length} items]` : v.slice(0, 20).map(x => slimMeta(x, depth + 1));
  const o = {};
  for (const [k, val] of Object.entries(v)) {
    if (BULKY_KEYS.has(k)) {
      if (k === 'file' && val && typeof val === 'object') {
        o.file = { filePath: val.filePath, numLines: val.numLines, startLine: val.startLine, totalLines: val.totalLines };
      } else if (typeof val === 'string') {
        o[k] = `[${val.length} chars]`;
      }
      continue;
    }
    o[k] = typeof val === 'string' && val.length > 400 ? val.slice(0, 400) + '…' : slimMeta(val, depth + 1);
  }
  return o;
}

/**
 * Convert a tool_result content (string | block[]) into something small
 * enough to stream: text truncated, images replaced by descriptors.
 */
export function slimResultContent(content) {
  if (typeof content === 'string') {
    return content.length > INLINE_RESULT_LIMIT
      ? { text: content.slice(0, INLINE_RESULT_LIMIT), truncated: true, length: content.length }
      : { text: content, truncated: false, length: content.length };
  }
  if (Array.isArray(content)) {
    let text = ''; const images = []; let truncated = false; let length = 0;
    content.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      if (b.type === 'text' && typeof b.text === 'string') {
        length += b.text.length;
        if (text.length < INLINE_RESULT_LIMIT) {
          const room = INLINE_RESULT_LIMIT - text.length;
          if (b.text.length > room) { text += b.text.slice(0, room); truncated = true; }
          else text += (text ? '\n' : '') + b.text;
        } else truncated = true;
      } else if (b.type === 'image') {
        images.push({ index: i, mediaType: b.source?.media_type, bytes: b.source?.data?.length ?? 0 });
      } else if (b.type === 'tool_reference') {
        text += (text ? '\n' : '') + `→ ${b.tool_name}`;
      } else {
        text += (text ? '\n' : '') + shortJson(b, 300);
      }
    });
    return { text, truncated, length, images: images.length ? images : undefined };
  }
  if (content == null) return { text: '', truncated: false, length: 0 };
  return { text: shortJson(content, INLINE_RESULT_LIMIT), truncated: false, length: 0 };
}

function fullResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
  if (content == null) return '';
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

const AGENT_MSG_RE = /<agent-message from="([a-z0-9]+)"/;
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>/;

/**
 * Accumulates one transcript (main session or subagent) into normalized
 * events plus session metadata. Feed it raw records through ingest().
 */
export class SessionState {
  constructor(sessionId, { keepRaw = true } = {}) {
    this.sessionId = sessionId;
    this.keepRaw = keepRaw;
    this.events = [];
    this.raw = new Map();            // event id -> raw record(s) [use, result]
    this.byToolUseId = new Map();    // tool_use id -> event
    this.seq = 0;
    this.seenMessageIds = new Set();
    this.files = new Map();          // path -> { reads, writes, lastTs, lastOp }
    this.meta = {
      sessionId,
      title: null, aiTitle: null, agentName: null, lastPrompt: null,
      cwd: null, gitBranch: null, version: null, model: null, effort: null,
      mode: null, pr: null, cost: null,
      firstTs: null, lastTs: null, lastAssistantTs: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0, messages: 0 },
      turnUsage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0, messages: 0 },
      turns: 0, inTurn: false, lastTurnStart: null, lastTurnEnd: null,
      queue: [],                   // read-only mirror of queue-operation records
      lastText: null,              // last assistant text (full)
      subagents: new Map(),        // agentId -> { toolUseId, description, done, async }
      doneAgents: new Set(),
      errors: 0,
      records: 0,
      unknownTypes: {},
    };
  }

  _push(ev, rawRec) {
    ev.seq = ++this.seq;
    ev.sessionId = this.sessionId;
    this.events.push(ev);
    if (this.keepRaw && rawRec) this.raw.set(ev.id, [rawRec]);
    if (ev.ts) {
      if (!this.meta.firstTs) this.meta.firstTs = ev.ts;
      this.meta.lastTs = ev.ts;
    }
    return ev;
  }

  _usage(u) {
    if (!u) return;
    const add = (tgt) => {
      tgt.input += u.input_tokens || 0;
      tgt.output += u.output_tokens || 0;
      tgt.cacheRead += u.cache_read_input_tokens || 0;
      tgt.cacheCreate += u.cache_creation_input_tokens || 0;
      tgt.thinking += u.output_tokens_details?.thinking_tokens || 0;
      tgt.messages += 1;
    };
    add(this.meta.usage);
    add(this.meta.turnUsage);
  }

  _touch(p, op, ts) {
    const f = this.files.get(p) || { path: p, reads: 0, writes: 0, lastTs: null, lastOp: null, firstTs: ts };
    if (op === 'read') f.reads++; else f.writes++;
    f.lastTs = ts; f.lastOp = op;
    this.files.set(p, f);
  }

  _startTurn(ts) {
    this.meta.inTurn = true;
    this.meta.turns++;
    this.meta.lastTurnStart = ts;
    this.meta.turnUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0, messages: 0 };
  }

  /**
   * Ingest one raw record. Returns { appended: Event[], updated: Event[],
   * metaChanged: boolean }.
   */
  ingest(rec) {
    const appended = []; const updated = []; let metaChanged = false;
    const m = this.meta;
    m.records++;
    if (!rec || typeof rec !== 'object') return { appended, updated, metaChanged };
    const ts = rec.timestamp || null;
    if (rec.cwd && !m.cwd) { m.cwd = rec.cwd; metaChanged = true; }
    if (rec.gitBranch && rec.gitBranch !== m.gitBranch) { m.gitBranch = rec.gitBranch; metaChanged = true; }
    if (rec.version && !m.version) m.version = rec.version;

    switch (rec.type) {
      case 'user': {
        const content = rec.message?.content;
        const id = rec.uuid || `u${this.seq + 1}`;
        if (Array.isArray(content) && content.some(b => b?.type === 'tool_result')) {
          for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            const ev = this.byToolUseId.get(b.tool_use_id);
            const slim = slimResultContent(b.content);
            const meta = rec.toolUseResult != null && typeof rec.toolUseResult === 'object' && !Array.isArray(rec.toolUseResult)
              ? slimMeta(rec.toolUseResult) : undefined;
            if (ev) {
              ev.tool.pending = false;
              ev.tool.isError = !!b.is_error || (typeof rec.toolUseResult === 'string' && /^error/i.test(rec.toolUseResult));
              ev.tool.result = slim;
              ev.tool.meta = meta;
              ev.tool.resultTs = ts;
              if (ts && ev.ts) ev.tool.durationMs = Math.max(0, Date.parse(ts) - Date.parse(ev.ts));
              if (ev.tool.isError) m.errors++;
              // Tool-specific enrichment once the result is known.
              if (ev.tool.name === 'Edit' && Array.isArray(rec.toolUseResult?.structuredPatch)) {
                let add = 0, del = 0;
                for (const h of rec.toolUseResult.structuredPatch) for (const l of h.lines || []) {
                  if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
                }
                ev.tool.summary = `${base(ev.tool.input.file_path)} +${add} −${del}`;
              }
              if (ev.tool.name === 'Agent') {
                const r = rec.toolUseResult;
                const agentId = r?.agentId;
                if (agentId) {
                  ev.tool.agentId = agentId;
                  const sub = m.subagents.get(agentId) || { agentId };
                  sub.toolUseId = ev.id; sub.description = ev.tool.input.description;
                  sub.async = !!r.isAsync; sub.done = !r.isAsync;
                  m.subagents.set(agentId, sub);
                  if (!r.isAsync) m.doneAgents.add(agentId);
                  metaChanged = true;
                } else if (r && typeof r === 'object') {
                  // sync agent completion carries no agentId; match via toolUseId later
                  for (const sub of m.subagents.values()) if (sub.toolUseId === ev.id) { sub.done = true; m.doneAgents.add(sub.agentId); }
                }
              }
              if (this.keepRaw) (this.raw.get(ev.id) || []).push(rec);
              updated.push(ev);
            } else {
              // Orphan result (tool_use was in a compacted-away part): show it standalone.
              const ev = this._push({
                id, ts, kind: 'tool',
                tool: { name: '?', display: 'result', summary: `result for ${b.tool_use_id}`, input: {}, result: slim, meta, pending: false, isError: !!b.is_error },
              }, rec);
              appended.push(ev);
            }
          }
          // The first result of a turn's worth of tools counts as "assistant still working".
          m.lastTs = ts || m.lastTs;
        } else {
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map(b => b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n')
            : '';
          if (rec.isMeta || rec.isCompactSummary) {
            const am = AGENT_MSG_RE.exec(text);
            if (am) { m.doneAgents.add(am[1]); const s = m.subagents.get(am[1]); if (s) s.done = true; metaChanged = true; }
            const tn = TASK_NOTIFICATION_RE.exec(text);
            if (tn) { for (const s of m.subagents.values()) if (s.toolUseId === tn[1]) { s.done = true; m.doneAgents.add(s.agentId); } }
            const ev = this._push({ id, ts, kind: 'system', subtype: rec.isCompactSummary ? 'compact_summary' : 'meta', text }, rec);
            appended.push(ev);
          } else {
            this._startTurn(ts);
            m.lastPrompt = text;
            metaChanged = true;
            const ev = this._push({ id, ts, kind: 'prompt', text, origin: rec.origin?.kind || rec.promptSource || null }, rec);
            appended.push(ev);
          }
        }
        break;
      }

      case 'assistant': {
        const msg = rec.message || {};
        if (msg.id && !this.seenMessageIds.has(msg.id)) {
          this.seenMessageIds.add(msg.id);
          this._usage(msg.usage);
          metaChanged = true;
        }
        if (msg.model && msg.model !== m.model) { m.model = msg.model; metaChanged = true; }
        if (rec.effort && rec.effort !== m.effort) { m.effort = rec.effort; metaChanged = true; }
        if (!m.inTurn) this._startTurn(ts); // assistant output without a visible prompt (resume, sdk)
        m.lastAssistantTs = ts;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        blocks.forEach((b, i) => {
          const id = (rec.uuid || `a${this.seq + 1}`) + (blocks.length > 1 ? `:${i}` : '');
          const common = { id, ts, model: msg.model, usage: i === 0 ? msg.usage : undefined, stopReason: msg.stop_reason || undefined };
          if (b.type === 'text') {
            if (!b.text) return;
            m.lastText = b.text;
            appended.push(this._push({ ...common, kind: 'text', text: b.text }, rec));
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            appended.push(this._push({ ...common, kind: 'thinking', text: b.thinking || '', redacted: b.type === 'redacted_thinking', omitted: b.type === 'thinking' && !b.thinking }, rec));
          } else if (b.type === 'tool_use') {
            const tool = {
              name: b.name, display: displayToolName(b.name), summary: toolSummary(b.name, b.input),
              input: b.input ?? {}, pending: true,
            };
            const ev = this._push({ ...common, id: b.id || id, kind: 'tool', tool }, rec);
            this.byToolUseId.set(b.id, ev);
            for (const p of toolPaths(b.name, b.input)) this._touch(p.path, p.op, ts);
            if (b.name === 'Agent') {
              // Provisional entry; agentId arrives with the result (or the meta file).
              m.subagents.set(`pending:${b.id}`, { agentId: null, toolUseId: b.id, description: b.input?.description, done: false, async: false });
            }
            appended.push(ev);
          } else {
            appended.push(this._push({ ...common, kind: 'raw', text: shortJson(b, 400), subtype: b.type }, rec));
          }
        });
        break;
      }

      case 'system': {
        const id = rec.uuid || `s${this.seq + 1}`;
        if (rec.subtype === 'stop_hook_summary') {
          m.inTurn = false; m.lastTurnEnd = ts; metaChanged = true;
          const hooks = rec.hookCount ? `${rec.hookCount} hook${rec.hookCount === 1 ? '' : 's'}` : '';
          appended.push(this._push({ id, ts, kind: 'turn_end', text: [hooks, rec.stopReason].filter(Boolean).join(' · '), prevented: !!rec.preventedContinuation }, rec));
        } else if (rec.subtype === 'api_error') {
          m.errors++;
          appended.push(this._push({ id, ts, kind: 'system', subtype: 'api_error', error: true,
            text: rec.error?.formatted || rec.error?.message || 'API error', retry: rec.retryAttempt, retryInMs: rec.retryInMs }, rec));
        } else {
          appended.push(this._push({ id, ts, kind: 'system', subtype: rec.subtype || 'system', text: rec.content || rec.message || shortJson(rec, 300) }, rec));
        }
        break;
      }

      case 'queue-operation': {
        const op = rec.operation;
        if (op === 'enqueue') m.queue.push({ ts, content: rec.content ?? '' });
        else if (op === 'dequeue') m.queue.shift();
        else if (op === 'remove') {
          const i = rec.content != null ? m.queue.findIndex(q => q.content === rec.content) : -1;
          if (i >= 0) m.queue.splice(i, 1); else m.queue.shift();
        }
        metaChanged = true;
        appended.push(this._push({ id: `q${this.seq + 1}`, ts, kind: 'queue', op, text: oneLine(rec.content, 200) || '', queueDepth: m.queue.length }, rec));
        break;
      }

      // ---- sideband metadata (no event) ----
      case 'custom-title': m.title = rec.customTitle || m.title; metaChanged = true; break;
      case 'ai-title': m.aiTitle = rec.aiTitle || m.aiTitle; metaChanged = true; break;
      case 'agent-name': m.agentName = rec.agentName || m.agentName; metaChanged = true; break;
      case 'last-prompt': if (rec.lastPrompt) { m.lastPrompt = rec.lastPrompt; metaChanged = true; } break;
      case 'mode': m.mode = rec.mode; metaChanged = true; break;
      case 'pr-link': m.pr = { number: rec.prNumber, url: rec.prUrl, repo: rec.prRepository, ts }; metaChanged = true; break;
      case 'cost-state':
        m.cost = { totalCostUSD: rec.totalCostUSD, linesAdded: rec.totalLinesAdded, linesRemoved: rec.totalLinesRemoved,
          durationMs: rec.totalDuration, apiMs: rec.totalAPIDuration, models: Object.keys(rec.modelUsage || {}) };
        metaChanged = true; break;
      case 'file-history-delta':
        // trackingPath is project-relative; tool inputs are absolute.
        if (rec.trackingPath) {
          const base = rec.backup?.realParentDir || m.cwd;
          const p = path.isAbsolute(rec.trackingPath) || !base ? rec.trackingPath : path.join(base, rec.trackingPath);
          this._touch(p, 'write', rec.timestamp || ts);
        }
        break;
      case 'frame-link':
        appended.push(this._push({ id: `f${this.seq + 1}`, ts, kind: 'system', subtype: 'artifact', text: `${rec.title || 'artifact'} → ${rec.frameUrl || rec.path || ''}` }, rec));
        break;
      default:
        if (SILENT_TYPES.has(rec.type)) break;
        m.unknownTypes[rec.type] = (m.unknownTypes[rec.type] || 0) + 1;
        appended.push(this._push({ id: rec.uuid || `r${this.seq + 1}`, ts, kind: 'raw', subtype: rec.type, text: shortJson(rec, 300) }, rec));
    }
    return { appended, updated, metaChanged };
  }

  /** Full (untruncated) result text + raw records for one event. */
  detail(eventId) {
    const ev = this.events.find(e => e.id === eventId);
    if (!ev) return null;
    const raw = this.raw.get(eventId) || [];
    const out = { event: ev, raw };
    if (ev.kind === 'tool') {
      const resRec = raw[1] || raw.find(r => r?.type === 'user');
      if (resRec) {
        const block = (resRec.message?.content || []).find(b => b?.type === 'tool_result' && b.tool_use_id === ev.id);
        out.resultText = fullResultText(block?.content);
        out.toolUseResult = resRec.toolUseResult;
      }
    }
    return out;
  }

  /** Decoded image block n of the tool result for an event. */
  image(eventId, index) {
    const raw = this.raw.get(eventId) || [];
    for (const r of raw) {
      for (const b of r?.message?.content || []) {
        if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue;
        const img = b.content[index];
        if (img?.type === 'image' && img.source?.data) return { mediaType: img.source.media_type, data: Buffer.from(img.source.data, 'base64') };
      }
    }
    return null;
  }

  /** Title precedence: custom > ai > agent-name > last prompt. */
  get title() {
    const m = this.meta;
    return m.title || m.aiTitle || m.agentName || (m.lastPrompt ? oneLine(m.lastPrompt, 60) : null);
  }

  filesList() {
    return [...this.files.values()].sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  }

  /** Public, serializable metadata (no Maps/Sets). */
  publicMeta() {
    const m = this.meta;
    return {
      ...m,
      title: this.title,
      subagents: [...m.subagents.values()].filter(s => s.agentId),
      doneAgents: [...m.doneAgents],
      lastText: m.lastText ? m.lastText.slice(0, 2000) : null,
      lastPrompt: m.lastPrompt ? m.lastPrompt.slice(0, 2000) : null,
      filesTouched: this.files.size,
      eventCount: this.events.length,
    };
  }
}

// ----------------------------------------------------- cheap file probes

/**
 * Read the first record of a transcript to learn cwd / sessionId without
 * parsing the whole file.
 */
export function probeHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    let sessionId = null, startTs = null;
    for (const line of text.split('\n')) {
      const rec = parseLine(line);
      if (!rec) continue;
      sessionId ||= rec.sessionId || null;
      startTs ||= rec.timestamp || null;
      if (rec.cwd) return { cwd: rec.cwd, sessionId: rec.sessionId || sessionId, version: rec.version || null, gitBranch: rec.gitBranch || null, startTs, entrypoint: rec.entrypoint || null };
    }
    return { cwd: null, sessionId, startTs };
  } catch { /* ignore */ } finally { if (fd != null) fs.closeSync(fd); }
  return { cwd: null, sessionId: null };
}

/**
 * Scan the tail of a transcript for the labels the session list needs
 * (titles, last prompt, pr link) without a full parse.
 */
export function probeTail(file, bytes = 256 * 1024) {
  const out = { title: null, aiTitle: null, agentName: null, lastPrompt: null, pr: null, gitBranch: null, model: null, lastTs: null };
  let fd;
  try {
    const st = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.allocUnsafe(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (start > 0) lines.shift(); // drop the partial first line
    for (const line of lines) {
      const rec = parseLine(line);
      if (!rec) continue;
      if (rec.timestamp) out.lastTs = rec.timestamp;
      if (rec.gitBranch) out.gitBranch = rec.gitBranch;
      switch (rec.type) {
        case 'custom-title': out.title = rec.customTitle || out.title; break;
        case 'ai-title': out.aiTitle = rec.aiTitle || out.aiTitle; break;
        case 'agent-name': out.agentName = rec.agentName || out.agentName; break;
        case 'last-prompt': out.lastPrompt = rec.lastPrompt || out.lastPrompt; break;
        case 'pr-link': out.pr = { number: rec.prNumber, url: rec.prUrl, repo: rec.prRepository }; break;
        case 'assistant': if (rec.message?.model) out.model = rec.message.model; break;
        case 'user': if (typeof rec.message?.content === 'string' && !rec.isMeta) out.lastPrompt = rec.message.content; break;
      }
    }
  } catch { /* ignore */ } finally { if (fd != null) fs.closeSync(fd); }
  return out;
}

/** Read a subagent's .meta.json; tolerant of missing/partial files. */
export function readAgentMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Claude Code's cwd → project-directory slug. */
export function cwdSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}
