// lib/ask.mjs — "Ask about this": answer a question about one item of a
// session (an event, its output, a turn, the brief, a list the UI shows)
// with a separate read-only model call. Nothing is sent to the session.
import { digest, turnOf, eventLine } from './digest.mjs';

const SYSTEM = `You answer questions from a person supervising a Claude Code agent session.
They point at one item (an event, a tool output, a file list, the session brief) and ask about it.
Answer from the provided context only. Be direct and brief: a few sentences or a short list, under 180 words unless asked for more.
Use Markdown sparingly (inline code for paths and commands). If the context does not contain the answer, say what is missing and where to look.`;

const PART_BUDGET = 30_000;
const TOTAL_BUDGET = 90_000;

function cap(s, n = PART_BUDGET) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}

function describeEvent(index, sessionId, eventId) {
  const d = index.detail(sessionId, eventId);
  if (!d) return null;
  const ev = d.event;
  const out = [eventLine(ev) || `#${ev.seq} ${ev.kind}`];
  if (ev.kind === 'tool') {
    out.push(`Tool: ${ev.tool.name}`);
    out.push(`Input:\n${cap(JSON.stringify(ev.tool.input, null, 2), 12_000)}`);
    const r = d.toolUseResult;
    if (ev.tool.name === 'Bash' && r && typeof r === 'object') {
      if (r.stdout) out.push(`stdout:\n${cap(r.stdout)}`);
      if (r.stderr) out.push(`stderr:\n${cap(r.stderr, 10_000)}`);
    } else if (d.resultText) out.push(`Result${ev.tool.isError ? ' (error)' : ''}:\n${cap(d.resultText)}`);
    if (ev.tool.pending) out.push('(still running)');
  } else if (ev.text) {
    out.push(cap(ev.text));
  }
  return out.join('\n');
}

/**
 * Resolve scope items into labelled context blocks.
 *   { kind: 'event', sessionId, eventId }
 *   { kind: 'turn', sessionId, eventId }
 *   { kind: 'brief', sessionId }
 *   { kind: 'session', sessionId }
 *   { kind: 'text', label, text }      (lists and buffers the UI renders)
 */
export function resolveScope(index, briefs, scope) {
  const blocks = [];
  for (const item of scope.slice(0, 8)) {
    try {
      if (item.kind === 'event') {
        const t = describeEvent(index, item.sessionId, item.eventId);
        if (t) blocks.push({ label: item.label || 'Event', text: t });
      } else if (item.kind === 'turn') {
        const e = index.load(item.sessionId);
        const ev = e?.state.events.find(x => x.id === item.eventId);
        if (ev) blocks.push({ label: item.label || 'The turn it belongs to', text: digest(turnOf(e.state.events, ev.seq), PART_BUDGET) });
      } else if (item.kind === 'brief') {
        const b = briefs.publicBrief(item.sessionId);
        const h = index.brief(item.sessionId);
        blocks.push({ label: item.label || 'Session brief', text: JSON.stringify({ generated: b.brief, live: h && { state: h.state, detail: h.detail, lastText: h.lastText, errors: h.errors, turns: h.turns, filesTouched: h.filesTouched, subagents: h.subagents } }, null, 2) });
      } else if (item.kind === 'session') {
        const e = index.load(item.sessionId);
        const s = index.summary(item.sessionId);
        if (e) blocks.push({ label: item.label || `Session "${s?.title || item.sessionId}"`, text: digest(e.state.events, PART_BUDGET) });
      } else if (item.kind === 'text' && item.text) {
        blocks.push({ label: String(item.label || 'Item').slice(0, 120), text: cap(item.text) });
      }
    } catch { /* an item that cannot be resolved is skipped */ }
  }
  return blocks;
}

export async function ask({ index, briefs, narrator, question, scope, sessionId }) {
  const blocks = resolveScope(index, briefs, scope || []);
  if (!blocks.length) throw new Error('nothing to ask about');
  const s = sessionId ? index.summary(sessionId) : null;
  let budget = TOTAL_BUDGET;
  const parts = [];
  if (s) parts.push(`Session: ${s.title} (${s.cwd || 'no cwd'})`);
  blocks.forEach((b, i) => {
    const text = b.text.length > budget ? b.text.slice(0, Math.max(0, budget)) + '\n…[cut]' : b.text;
    budget -= text.length;
    parts.push(`=== ${i === 0 ? 'THE ITEM' : 'CONTEXT'}: ${b.label} ===\n${text}`);
  });
  parts.push(`=== QUESTION ===\n${String(question).slice(0, 4000)}`);
  const r = await narrator.run({ system: SYSTEM, prompt: parts.join('\n\n'), model: narrator.askModel });
  return { answer: r.text.trim(), costUsd: r.costUsd, durationMs: r.durationMs, contextChars: TOTAL_BUDGET - budget };
}
