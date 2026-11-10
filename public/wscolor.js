// public/wscolor.js — a workstream's identity color: a hue from its slug, the
// same everywhere it shows (Home cards, the session header chip, rail rows), so
// a session reads as belonging to its workstream at a glance. No DOM: callers
// set `--ws-h` from wsStyle() and the stylesheet does the rest.

/**
 * Hues that stay apart at a glance (oklch degrees). Pure greens are left out:
 * green on Home means "new since you looked".
 */
export const HUES = [250, 25, 195, 295, 70, 340, 105, 220];
const hash = (slug) => {
  let x = 2166136261;
  for (const ch of String(slug || '')) { x ^= ch.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; }
  return x % HUES.length;
};
/**
 * slug → hue for the known workstreams (all statuses, so the list is the same
 * wherever it is read). In slug order each takes its hashed hue, or the next
 * one free; past HUES.length they share again. A new workstream moves another
 * only when it lands on a hue that one had taken by moving.
 */
let assigned = new Map();
export function assignHues(list) {
  const ws = [...(list || [])].filter(w => w?.slug).sort((a, b) => a.slug.localeCompare(b.slug));
  const out = new Map(); let taken = new Set();
  for (const w of ws) {
    if (taken.size === HUES.length) taken = new Set();
    let i = hash(w.slug);
    while (taken.has(i)) i = (i + 1) % HUES.length;
    taken.add(i); out.set(w.slug, HUES[i]);
  }
  assigned = out;
  return out;
}
/** A slug's hue: its assigned one, or before the list is known, its hashed one. */
export const wsHue = (slug) => assigned.get(slug) ?? HUES[hash(slug)];
/** An inline style giving an element its workstream's hue, or null without one. */
export const wsStyle = (slug) => slug ? `--ws-h:${wsHue(slug)}` : null;
