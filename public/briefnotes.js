// public/briefnotes.js — a brief's notes, shared by the session view
// (app.js) and Home (home.js): their kinds, which ones you have dismissed,
// and what was in a brief when you last looked. Dismissals and "last
// looked" live in this browser's localStorage. No DOM.

export const NOTE_KINDS = ['failure', 'risk', 'question', 'decision'];
export const NOTE_KIND = {
  failure: { icon: 'i-x', label: 'Failure', plural: 'failures' },
  risk: { icon: 'i-alert', label: 'Risk', plural: 'risks' },
  question: { icon: 'i-q', label: 'Open question', plural: 'open questions' },
  decision: { icon: 'i-flag', label: 'Decision', plural: 'decisions' },
};

/** A brief's notes, most urgent first, at most two (briefs written before the cap may hold three). A brief from before notes has one `watch`. */
export function notesOf(b) { return (b?.notes || (b?.watch ? [{ kind: 'risk', ...b.watch }] : [])).slice(0, 2); }

/**
 * What identifies a note across refreshes. The model rewords notes, so one
 * linked to an event is that event; an unlinked one is its words.
 */
export function noteKey(n) { return n.seq ? `${n.kind}#${n.seq}` : `${n.kind}:${String(n.text || '').toLowerCase().replace(/\s+/g, ' ').trim()}`; }

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const DISMISSED = 'deck.notes.dismissed';
const SEEN = 'deck.brief.seen';
// Keep the stores small: only the most recently touched sessions.
const KEEP = 200;
function trim(o) {
  const ids = Object.keys(o);
  if (ids.length <= KEEP) return o;
  return Object.fromEntries(ids.sort((a, b) => (o[b].t || 0) - (o[a].t || 0)).slice(0, KEEP).map(id => [id, o[id]]));
}

export function isDismissed(id, n) { return !!store.get(DISMISSED)[id]?.keys?.includes(noteKey(n)); }
export function dismissNote(id, n, on = true) {
  const all = store.get(DISMISSED);
  const keys = new Set(all[id]?.keys || []);
  if (on) keys.add(noteKey(n)); else keys.delete(noteKey(n));
  all[id] = { keys: [...keys].slice(-50), t: Date.now() };
  store.set(DISMISSED, trim(all));
}
/** The notes still worth showing: not dismissed here. */
export function liveNotes(id, b) { return notesOf(b).filter(n => !isDismissed(id, n)); }

/** "2 open questions · 1 failure": live notes counted by kind, most urgent first. */
export function noteCounts(notes) {
  const by = new Map();
  for (const n of notes) by.set(n.kind, (by.get(n.kind) || 0) + 1);
  return NOTE_KINDS.filter(k => by.has(k)).map(k => ({ kind: k, count: by.get(k), ...NOTE_KIND[k] }));
}

/**
 * What you saw of a session's brief when you last looked: list items keyed
 * "label\u0000item". New-since-you-looked is everything not in it. Null when
 * you have never looked, so a first visit marks nothing.
 */
export function seenItems(id) { const s = store.get(SEEN)[id]; return s ? new Set(s.items) : null; }
export function markSeen(id, items) {
  const all = store.get(SEEN);
  all[id] = { items: [...items].slice(0, 60), t: Date.now() };
  store.set(SEEN, trim(all));
}
export const itemKey = (label, x) => `${label}\u0000${x}`;
