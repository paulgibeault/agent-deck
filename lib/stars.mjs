// lib/stars.mjs — stars and tags the pilot puts on a session's events and
// files while it runs, so wrap-up (#36) starts from their judgement. Kept in the
// deck state's own namespace: ns('stars') → sessionId → key → star, where key
// is an event id or a file's absolute path and a star is
// { tag, comment, at, excerpt, kind, ts? }. The excerpt is the item's text when
// starred, so a star outlives transcript compaction or a rewind.
import { decisionCue } from '../public/said.js';

export const TAGS = ['star', 'decision', 'note', 'question', 'vault'];
// Excerpts are clipped: every star rewrites state.json, so they stay small.
const EXCERPT_MAX = 2000;
const COMMENT_MAX = 300;
const KEY_MAX = 1024;

const oneLine = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

// What other features do when an item gets a tag, e.g. the Vault (#31) copying
// a file tagged 'vault'. tag → Set of fn({ sessionId, key, star }).
const handlers = new Map();
/** Run `fn` whenever an item is newly given `tag`. Returns a remover. */
export function onTag(tag, fn) {
  if (!handlers.has(tag)) handlers.set(tag, new Set());
  handlers.get(tag).add(fn);
  return () => handlers.get(tag)?.delete(fn);
}
function fire(tag, payload) {
  for (const fn of handlers.get(tag) || []) {
    try { Promise.resolve(fn(payload)).catch(e => console.error(`agent-deck: stars ${tag} handler: ${e.message}`)); }
    catch (e) { console.error(`agent-deck: stars ${tag} handler: ${e.message}`); }
  }
}

export class Stars {
  /** `space` is a DeckState namespace (deck.ns('stars')). */
  constructor(space) { this.space = space; }

  /** A session's stars: { key: star }. */
  list(sessionId) { return this.space.get(sessionId, {}); }
  get(sessionId, key) { return this.list(sessionId)[key] || null; }
  /** Sessions that have any stars. */
  sessions() { return this.space.keys(); }

  /**
   * Star or re-tag an item. `excerpt` is only needed the first time: a re-tag
   * keeps the one saved. Throws (with .code 400) on bad input.
   */
  put(sessionId, key, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('the body must be a JSON object');
    let { tag = 'star', comment = '', excerpt, kind, ts } = body;
    if (typeof ts !== 'string') ts = undefined;
    if (!sessionId || typeof sessionId !== 'string') throw bad('sessionId required');
    if (!key || typeof key !== 'string' || key.length > KEY_MAX) throw bad('a key (event id or file path) is required');
    if (!TAGS.includes(tag)) throw bad(`tag must be one of ${TAGS.join(', ')}`);
    const all = this.list(sessionId);
    const was = all[key];
    kind = kind || was?.kind || (key.startsWith('/') ? 'file' : 'event');
    if (kind !== 'event' && kind !== 'file') throw bad('kind must be event or file');
    if (tag === 'vault' && kind !== 'file') throw bad('only files can be saved to the Vault');
    const star = { tag, comment: oneLine(comment, COMMENT_MAX), at: new Date().toISOString(), excerpt: excerpt != null ? clip(excerpt) : was?.excerpt || '', kind };
    if (ts || was?.ts) star.ts = ts || was.ts;
    if (!star.comment) delete star.comment;
    all[key] = star;
    this.space.set(sessionId, all);
    if (was?.tag !== tag) fire(tag, { sessionId, key, star });
    return star;
  }

  /**
   * Drop the stars of sessions `known(id)` no longer knows (deleted ones).
   * Returns the ids dropped.
   */
  prune(known) {
    const gone = this.sessions().filter(id => !known(id));
    for (const id of gone) this.space.set(id, undefined);
    return gone;
  }

  /** Unstar. True when there was a star. */
  remove(sessionId, key) {
    const all = this.list(sessionId);
    if (!all[key]) return false;
    delete all[key];
    this.space.set(sessionId, Object.keys(all).length ? all : undefined);
    return true;
  }
}

function clip(s) { s = String(s); return s.length > EXCERPT_MAX ? s.slice(0, EXCERPT_MAX - 1) + '…' : s; }
function bad(msg) { return Object.assign(new Error(msg), { code: 400 }); }

// One store per deck state, shared by the route module and whoever reads stars (wrap-up).
const stores = new WeakMap();
export function starsFor(deck) {
  if (!stores.has(deck)) stores.set(deck, new Stars(deck.ns('stars')));
  return stores.get(deck);
}

/**
 * Decision-language candidates in a session's events, for wrap-up to list
 * unticked: agent text only, code and quoted output ignored (public/said.js).
 * [{ eventId, ts, cue, sentence }], oldest first.
 */
export function candidates(events) {
  const out = [];
  for (const ev of events || []) {
    if (ev.kind !== 'text' || !ev.text) continue;
    const c = decisionCue(ev.text);
    if (c) out.push({ eventId: ev.id, ts: ev.ts || null, ...c });
  }
  return out;
}
