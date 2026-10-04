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
    case 'Monitor': return `watch: ${input.description ?? oneLine(input.command, 100)}`;
    case 'TaskStop': return `stop ${input.task_id ?? ''}`.trim();
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

// The deck inlines attached text files as a text block with this header (lib/agent.mjs).
const ATTACHED_FILE_RE = /^Attached file (.+?):\n\n/;

/**
 * A prompt's text and what came with it. Images and PDFs are described by
 * index (the image route serves them); inlined text files by name only.
 */
export function promptParts(content) {
  if (typeof content === 'string') return { text: content, attachments: undefined };
  if (!Array.isArray(content)) return { text: '', attachments: undefined };
  const parts = []; const attachments = [];
  content.forEach((b, index) => {
    if (b?.type === 'image') attachments.push({ kind: 'image', index, mediaType: b.source?.media_type || null, bytes: b.source?.data?.length ?? 0 });
    else if (b?.type === 'document') attachments.push({ kind: 'pdf', index, name: b.title || 'document.pdf', bytes: b.source?.data?.length ?? 0 });
    else if (b?.type === 'text') {
      const f = ATTACHED_FILE_RE.exec(b.text || '');
      if (f) attachments.push({ kind: 'text', index, name: f[1], bytes: b.text.length - f[0].length });
      else parts.push(b.text);
    }
  });
  if (!parts.length && attachments.some(x => x.kind === 'image')) parts.push('[image]');
  return { text: parts.filter(Boolean).join('\n'), attachments: attachments.length ? attachments : undefined };
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

// ---- background tasks
// A background task starts as a Bash call run in the background (or moved
// there after the 2-minute limit: `backgroundTaskId`), a Monitor (`taskId`)
// or a background Agent. Its output goes to a file whose path the tool result
// names. Claude Code then reports on it with <task-notification> blocks: a
// Monitor's events, and a final <status> with a summary carrying the exit
// code. These blocks arrive up to three ways (queue-operation, a queued
// command attachment, the delivered user message); each is counted once.
const OUTPUT_FILE_RE = /Output is being written to: (\S+?\.output)\b/;
const NOTE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;
const noteTag = (s, n) => { const m = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(s); return m ? m[1].trim() : null; };
const isNote = (s) => typeof s === 'string' && s.trimStart().startsWith('<task-notification>');

/** The fields of a <task-notification> block, or null. */
export function parseTaskNotification(text) {
  const m = NOTE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const b = m[1];
  const n = { taskId: noteTag(b, 'task-id'), toolUseId: noteTag(b, 'tool-use-id'), outputFile: noteTag(b, 'output-file'),
    status: noteTag(b, 'status'), summary: noteTag(b, 'summary'), event: noteTag(b, 'event') };
  const x = /exit code (-?\d+)/i.exec(n.summary || '');
  n.exitCode = x ? Number(x[1]) : null;
  return n.taskId || n.toolUseId ? n : null;
}

/**
 * Accumulates one transcript (main session or subagent) into normalized
 * events plus session metadata. Feed it raw records through ingest().
 */
/**
 * What one API response says about how it was produced: model, effort, why
 * it stopped, the token breakdown, cache diagnostics. Only fields the
 * transcript actually carries; the page prices it (public/pricing.js).
 */
export function inferenceOf(rec, prevModel) {
  const msg = rec.message || {};
  const u = msg.usage || {};
  const cc = u.cache_creation || {};
  const out = {
    model: msg.model || null,
    effort: rec.perTurnEffort || rec.effort || null,
    stopReason: msg.stop_reason || null,
    usage: {
      input: u.input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheWrite1h: cc.ephemeral_1h_input_tokens || 0,
      output: u.output_tokens || 0,
      thinking: u.output_tokens_details?.thinking_tokens || 0,
    },
    msgId: msg.id || null,
    requestId: rec.requestId || null,
  };
  if (prevModel && msg.model && msg.model !== prevModel && msg.model !== '<synthetic>') out.switchedFrom = prevModel;
  if (rec.effort && rec.perTurnEffort && rec.perTurnEffort !== rec.effort) out.sessionEffort = rec.effort;
  if (rec.advisorModel && rec.advisorModel !== msg.model) out.advisorModel = rec.advisorModel;
  if (rec.thinkingDurationMs != null) out.thinkingMs = rec.thinkingDurationMs;
  if (msg.stop_details) out.stopDetails = { category: msg.stop_details.category || null, explanation: msg.stop_details.explanation || null };
  if (u.speed && u.speed !== 'standard') out.speed = u.speed;
  if (u.service_tier && u.service_tier !== 'standard') out.tier = u.service_tier;
  if (u.inference_geo && u.inference_geo !== 'not_available') out.geo = u.inference_geo;
  const miss = msg.diagnostics?.cache_miss_reason;
  if (miss) out.cacheMiss = { reason: miss.type, tokens: miss.cache_missed_input_tokens ?? null };
  const dropped = (msg.input_transformations || []).filter(t => t?.type === 'thinking_dropped');
  if (dropped.length) out.thinkingDropped = { count: dropped.length, reason: dropped[0].reason || null };
  const st = u.server_tool_use || {};
  if (st.web_search_requests || st.web_fetch_requests) out.web = { searches: st.web_search_requests || 0, fetches: st.web_fetch_requests || 0 };
  const fb = (u.iterations || []).filter(x => x?.type === 'fallback_message');
  if (fb.length) out.fallbacks = fb.length;
  if (rec.isApiErrorMessage || msg.model === '<synthetic>') out.synthetic = true;
  if (rec.version) out.cli = rec.version;
  if (rec.entrypoint) out.entrypoint = rec.entrypoint;
  return out;
}

export class SessionState {
  constructor(sessionId, { keepRaw = true } = {}) {
    this.sessionId = sessionId;
    this.keepRaw = keepRaw;
    this.events = [];
    this.raw = new Map();            // event id -> raw record(s) [use, result]
    this.byToolUseId = new Map();    // tool_use id -> event
    this.seq = 0;
    this.seenMessageIds = new Set();
    this.seenNotes = new Set();      // task notifications already counted
    this.lastModel = null;         // model of the previous API response, to spot switches
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
      tasks: new Map(),            // background task id -> task (see _task)
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

  /** Find or start a background task record; `init` fills what is not known yet. */
  _task(id, init = {}) {
    let t = this.meta.tasks.get(id);
    if (!t) {
      t = { id, kind: init.kind || 'command', toolUseId: null, agentId: null, description: null, command: null, outputFile: null,
        startedTs: null, timedOutAfterMs: null, status: 'running', endedTs: null, exitCode: null, summary: null,
        events: [], lastEventTs: null, stopRequestedTs: null, expiresTs: null };
      this.meta.tasks.set(id, t);
    }
    for (const [k, v] of Object.entries(init)) if (v != null && t[k] == null) t[k] = v;
    return t;
  }

  /** Count one task notification (once, whichever way it arrives); a new one becomes an event. */
  _note(n, ts, appended, rec) {
    const key = [n.taskId, n.toolUseId, n.status, n.event, n.summary].join('|');
    if (this.seenNotes.has(key)) return;
    this.seenNotes.add(key);
    const m = this.meta;
    const call = n.toolUseId ? this.byToolUseId.get(n.toolUseId) : null;
    if (call?.tool.name === 'Agent' || [...m.subagents.values()].some(s => s.toolUseId === n.toolUseId)) {
      for (const s of m.subagents.values()) if (s.toolUseId === n.toolUseId) { s.done = true; m.doneAgents.add(s.agentId); }
    }
    const id = (call?.tool.name === 'Agent' && call.tool.agentId) || n.taskId || n.toolUseId;
    const t = this._task(id, { kind: call?.tool.name === 'Agent' ? 'agent' : call?.tool.name === 'Monitor' || n.event ? 'monitor' : 'command',
      toolUseId: n.toolUseId, outputFile: n.outputFile, description: call?.tool.input?.description || null, command: call?.tool.input?.command || null, startedTs: call?.ts || ts });
    if (n.event) { t.events.push({ ts, text: n.event }); if (t.events.length > 200) t.events.shift(); t.lastEventTs = ts; }
    if (n.status && n.status !== 'running') {
      t.status = n.status; t.endedTs = ts; t.summary = n.summary || t.summary;
      if (n.exitCode != null) t.exitCode = n.exitCode;
    }
    appended.push(this._push({ id: `tn${this.seq + 1}`, ts, kind: 'system', subtype: 'task', taskId: t.id, taskKind: t.kind,
      status: n.status || null, event: n.event || null, text: n.event || n.summary || `background task ${n.status || 'update'}` }, rec));
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
              const r0 = rec.toolUseResult && typeof rec.toolUseResult === 'object' ? rec.toolUseResult : null;
              if ((ev.tool.name === 'Bash' && r0?.backgroundTaskId) || (ev.tool.name === 'Monitor' && r0?.taskId)) {
                const tk = this._task(r0.backgroundTaskId || r0.taskId, { kind: ev.tool.name === 'Monitor' ? 'monitor' : 'command', toolUseId: ev.id,
                  description: ev.tool.input.description || null, command: ev.tool.input.command || null,
                  outputFile: OUTPUT_FILE_RE.exec(fullResultText(b.content))?.[1] || null,
                  startedTs: r0.timedOutAfterMs ? ev.ts : ts, timedOutAfterMs: r0.timedOutAfterMs || null,
                  expiresTs: r0.timeoutMs && ts ? new Date(Date.parse(ts) + Number(r0.timeoutMs)).toISOString() : null });
                ev.tool.taskId = tk.id;
                metaChanged = true;
              }
              if (ev.tool.name === 'TaskStop' && !ev.tool.isError) {
                const tk = m.tasks.get(ev.tool.input.task_id);
                if (tk && tk.status === 'running') { tk.status = 'stopped'; tk.endedTs = ts; metaChanged = true; }
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
                  if (r.isAsync) { const tk = this._task(agentId, { kind: 'agent', agentId, toolUseId: ev.id, description: ev.tool.input.description || null, startedTs: ev.ts, outputFile: r.outputFile || null }); ev.tool.taskId = tk.id; }
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
          const { text, attachments } = promptParts(content);
          const note = rec.origin?.kind === 'task-notification' || isNote(text) ? parseTaskNotification(text) : null;
          if (note) {
            // Claude Code reporting on a background task: it starts a turn, but nobody typed it.
            this._startTurn(ts);
            this._note(note, ts, appended, rec);
            metaChanged = true;
          } else if (rec.isMeta || rec.isCompactSummary) {
            const am = AGENT_MSG_RE.exec(text);
            if (am) { m.doneAgents.add(am[1]); const s = m.subagents.get(am[1]); if (s) s.done = true; metaChanged = true; }
            const tn = parseTaskNotification(text);
            if (tn) this._note(tn, ts, appended, rec);
            const ev = this._push({ id, ts, kind: 'system', subtype: rec.isCompactSummary ? 'compact_summary' : 'meta', text }, rec);
            appended.push(ev);
          } else {
            this._startTurn(ts);
            m.lastPrompt = text;
            metaChanged = true;
            const ev = this._push({ id, ts, kind: 'prompt', text, origin: rec.origin?.kind || rec.promptSource || null, attachments }, rec);
            appended.push(ev);
          }
        }
        break;
      }

      case 'assistant': {
        const msg = rec.message || {};
        // One API response is written as one record per content block; the
        // first carries the inference details, the rest point back to it.
        let inference = null;
        if (msg.id && !this.seenMessageIds.has(msg.id)) {
          this.seenMessageIds.add(msg.id);
          this._usage(msg.usage);
          inference = inferenceOf(rec, this.lastModel);
          if (msg.model && msg.model !== '<synthetic>') this.lastModel = msg.model;
          metaChanged = true;
        }
        if (msg.model && msg.model !== '<synthetic>' && msg.model !== m.model) { m.model = msg.model; metaChanged = true; }
        if (rec.effort && rec.effort !== m.effort) { m.effort = rec.effort; metaChanged = true; }
        if (!m.inTurn) this._startTurn(ts); // assistant output without a visible prompt (resume, sdk)
        m.lastAssistantTs = ts;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        blocks.forEach((b, i) => {
          const id = (rec.uuid || `a${this.seq + 1}`) + (blocks.length > 1 ? `:${i}` : '');
          const first = inference && i === 0;
          const common = { id, ts, model: msg.model, msgId: msg.id, usage: first ? msg.usage : undefined, inference: first ? inference : undefined, stopReason: msg.stop_reason || undefined };
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
            if (b.name === 'TaskStop' && m.tasks.has(b.input?.task_id)) { m.tasks.get(b.input.task_id).stopRequestedTs = ts; metaChanged = true; }
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
        const note = isNote(rec.content) ? parseTaskNotification(rec.content) : null;
        if (note && op === 'enqueue') this._note(note, ts, appended, rec);
        if (op === 'enqueue') m.queue.push({ ts, content: rec.content ?? '', note: !!note });
        else if (op === 'dequeue') m.queue.shift();
        else if (op === 'remove') {
          const i = rec.content != null ? m.queue.findIndex(q => q.content === rec.content) : -1;
          if (i >= 0) m.queue.splice(i, 1); else m.queue.shift();
        }
        metaChanged = true;
        if (!note) appended.push(this._push({ id: `q${this.seq + 1}`, ts, kind: 'queue', op, text: oneLine(rec.content, 200) || '', queueDepth: m.queue.filter(q => !q.note).length }, rec));
        break;
      }

      // ---- sideband metadata (no event) ----
      case 'custom-title': m.title = rec.customTitle || m.title; metaChanged = true; break;
      case 'ai-title': m.aiTitle = rec.aiTitle || m.aiTitle; metaChanged = true; break;
      case 'agent-name': m.agentName = rec.agentName || m.agentName; metaChanged = true; break;
      case 'last-prompt': if (rec.lastPrompt && !isNote(rec.lastPrompt)) { m.lastPrompt = rec.lastPrompt; metaChanged = true; } break;
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
      case 'attachment': {
        const a = rec.attachment;
        const note = a?.type === 'queued_command' && isNote(a.prompt) ? parseTaskNotification(a.prompt) : null;
        if (note) { this._note(note, ts, appended, rec); metaChanged = true; }
        break;
      }
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

  /** Decoded image block n of a prompt, or of the tool result for an event. */
  image(eventId, index) {
    const raw = this.raw.get(eventId) || [];
    for (const r of raw) {
      const top = Array.isArray(r?.message?.content) ? r.message.content[index] : null;
      if (top?.type === 'image' && top.source?.data) return { mediaType: top.source.media_type, data: Buffer.from(top.source.data, 'base64') };
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
      queue: m.queue.filter(q => !q.note),
      tasks: [...m.tasks.values()].map(x => ({ ...x, events: x.events.slice(-50), eventCount: x.events.length })),
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
        case 'last-prompt': if (!isNote(rec.lastPrompt)) out.lastPrompt = rec.lastPrompt || out.lastPrompt; break;
        case 'pr-link': out.pr = { number: rec.prNumber, url: rec.prUrl, repo: rec.prRepository }; break;
        case 'assistant': if (rec.message?.model) out.model = rec.message.model; break;
        case 'user': if (typeof rec.message?.content === 'string' && !rec.isMeta && !isNote(rec.message.content)) out.lastPrompt = rec.message.content; break;
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
