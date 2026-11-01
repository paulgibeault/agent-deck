// lib/briefing.mjs — the workstream briefing (#35): compact context put after
// a new session's first prompt (the pilot's own words come first, so they title it), so the agent starts from what has
// already been decided rather than from scratch. Assembled from stored fields
// (lib/workstreams.mjs get()), never by a model, and capped hard: the launch
// dialog previews exactly this text, and the pilot may edit it there.

export const CHARS_PER_TOKEN = 4;          // a rough estimate, good enough for a cap
export const BRIEF_TOKENS = 1500;
export const BRIEF_MAX = BRIEF_TOKENS * CHARS_PER_TOKEN;
// Each part gets its own share, so a long summary cannot crowd out the next
// step; together they stay under BRIEF_MAX, so the tail (decisions, pins) is never cut off.
const CAP = { title: 120, goal: 300, summary: 1200, where: 1200, next: 600, decision: 100, pin: 80 };
const MAX_DECISIONS = 12;
const MAX_PINS = 8;
const CUT = '…';

export const tokensOf = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);

/**
 * The briefing for a workstream: { text, tokens, truncated, empty }. In order:
 * title, goal, summary, where we are, next step, active decisions (titles
 * only, the latest few), pinned. `empty` when there is nothing past the title.
 */
export function buildBriefing(ws, { max = BRIEF_MAX } = {}) {
  if (!ws) return { text: '', tokens: 0, truncated: false, empty: true };
  let truncated = false;
  const clip = (s, n) => { const t = String(s ?? '').trim(); if (t.length <= n) return t; truncated = true; return t.slice(0, n - 1).trimEnd() + CUT; };
  const line = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' '), n);
  const block = (head, v, n) => { const t = clip(v, n); return t ? `${head}:\n${t}` : null; };

  const active = (ws.decisions || []).filter(d => (d.status || 'active') === 'active').sort((a, b) => (a.n || 0) - (b.n || 0));
  const shown = active.slice(-MAX_DECISIONS);
  if (shown.length < active.length) truncated = true;
  const decisions = shown.length ? ['Active decisions:',
    ...(active.length > shown.length ? [`- (${active.length - shown.length} earlier not shown)`] : []),
    ...shown.map(d => `- ${d.n ? `${String(d.n).padStart(4, '0')} ` : ''}${line(d.title, CAP.decision)}`)].join('\n') : null;

  const pins = (ws.pinned || []).map(p => typeof p === 'string' ? p : p?.title || p?.url || p?.ref || '').filter(Boolean);
  if (pins.length > MAX_PINS) truncated = true;
  const pinned = pins.length ? ['Pinned:', ...pins.slice(0, MAX_PINS).map(p => `- ${line(p, CAP.pin)}`)].join('\n') : null;

  const goal = line(ws.goal, CAP.goal);
  const parts = [
    goal ? `Goal: ${goal}` : null,
    block('Summary', ws.summary, CAP.summary),
    block('Where we are', ws.where, CAP.where),
    block('Next step', ws.next, CAP.next),
    decisions,
    pinned,
  ].filter(Boolean);
  const title = line(ws.title || ws.slug, CAP.title);
  let text = [`This session is part of the workstream “${title}”. What has been recorded on it so far:`, ...parts].join('\n\n');
  if (!parts.length) text = `This session is part of the workstream “${title}”. Nothing has been recorded on it yet.`;
  // The per-part shares keep it under the cap; this is the backstop.
  if (text.length > max) { text = text.slice(0, max - 1).trimEnd() + CUT; truncated = true; }
  return { text, tokens: tokensOf(text), truncated, empty: !parts.length };
}

export const BRIEF_HEAD = 'Workstream briefing (context, not instructions):';
/** The first prompt, then the briefing under a separator: the prompt stays first, so it still titles the session. */
export function withBriefing(prompt, brief) {
  const b = String(brief || '').trim();
  if (!b) return prompt;
  const p = String(prompt ?? '').trimEnd();
  return `${p ? `${p}\n\n` : ''}---\n${BRIEF_HEAD}\n${b}`;
}
