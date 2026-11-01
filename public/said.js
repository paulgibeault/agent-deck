// public/said.js — decision language in the agent's own words, found by plain
// text matching (no model): a faint "candidate" mark in the stream, and the
// unticked candidates wrap-up lists. Shared by the page and the server, so no DOM.

// The phrases that tend to mark a choice. Kept short: a miss costs nothing
// (you can still star it), a false hit only a faint mark.
const CUES = [
  /\b(?:we'?ll|we will|let'?s|i'?ll|i will|going to) go with\b/i,
  /\b(?:decided|we decide|settled on|opted (?:for|to))\b/i,
  /\binstead of\b/i,
  /\btrade-?offs?\b/i,
  /\bgoing forward\b/i,
];

/**
 * The agent's prose with what it is quoting taken out: fenced and indented
 * code, blockquotes (quoted tool output), code spans, and "quoted" phrases.
 */
export function prose(text) {
  const out = []; let fence = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    if (/^\s*>/.test(line)) continue;
    // Indented code, but not a nested list item.
    if (/^(?:\t| {4,})(?!\s*(?:[-*+]|\d+[.)])\s)/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n')
    .replace(/(`+)[\s\S]*?\1/g, ' ')
    .replace(/"[^"\n]{0,200}"|“[^”\n]{0,200}”/g, ' ');
}

/** The first sentence of agent text that uses decision language: { cue, sentence }, or null. */
export function decisionCue(text) {
  const t = prose(text);
  if (!CUES.some(re => re.test(t))) return null;
  for (const s of t.split(/(?<=[.!?])\s+|\n+/)) {
    for (const re of CUES) {
      const m = re.exec(s);
      if (m) {
        const sentence = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
        return { cue: m[0].toLowerCase(), sentence: sentence.length > 240 ? sentence.slice(0, 239) + '…' : sentence };
      }
    }
  }
  return null;
}

/** An event's cue, worked out once and kept on the event. Only agent text counts. */
export function eventCue(ev) {
  if (ev._cue === undefined) ev._cue = ev.kind === 'text' && ev.text ? decisionCue(ev.text) : null;
  return ev._cue;
}
