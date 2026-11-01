// public/homemodel.js — what Home (home.js) shows and in what order, worked out
// from stored workstreams and the deck's live sessions. No DOM, so node tests
// import it; no model calls, so drawing Home costs nothing.

/** Statuses on the grid by default; done and archived wait behind the filter. */
export const SHOWN = ['active', 'paused'];
const STATUS_RANK = { active: 0, paused: 1, done: 2, archived: 3 };
const NEEDS = new Set(['input', 'error']);

/** A session that is running now: the rail's Active bucket, not closed by the pilot. Subagents ride with theirs. */
export const isLive = (s) => s?.kind !== 'agent' && s?.bucket === 'active' && !s?.hidden;
/** Without app.js's sigOf (tests), the signal the index computed. */
const baseSig = (s) => !s?.alive ? 'ended' : s.glance?.signal || (s.status === 'busy' ? 'working' : 'done');

/**
 * session id → workstream slug. A summary's own `workstream` (#35: { slug, title }
 * or null for none) wins; otherwise the list's `ids` (GET /api/workstreams?sessions=1).
 */
export function workstreamMap(list, sessions = []) {
  const map = new Map();
  for (const w of list || []) for (const id of w.ids || []) map.set(id, w.slug);
  for (const s of sessions) {
    if (!s || !('workstream' in s)) continue;
    const slug = typeof s.workstream === 'string' ? s.workstream : s.workstream?.slug;
    if (slug) map.set(s.id, slug); else map.delete(s.id);
  }
  return map;
}

const time = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };

/**
 * Each workstream with what its card needs from live state: its live sessions
 * and their signals, whether one needs you, how many are working, and when
 * anything last happened (the record's `updated` or a session's activity).
 */
export function cardStates(list, sessions = [], { sigOf = baseSig, map = workstreamMap(list, sessions) } = {}) {
  const bySlug = new Map();
  for (const s of sessions) {
    const slug = s && map.get(s.id);
    if (!slug) continue;
    (bySlug.get(slug) || bySlug.set(slug, []).get(slug)).push(s);
  }
  return (list || []).map(w => {
    const mine = bySlug.get(w.slug) || [];
    const live = mine.filter(isLive).map(s => ({ s, sig: sigOf(s) }));
    return { ...w, status: w.status || 'active', live,
      needs: live.filter(x => NEEDS.has(x.sig)).length,
      running: live.filter(x => x.sig === 'working').length,
      last: Math.max(time(w.updated), ...mine.map(s => time(s.statusUpdatedAt) || time(s.mtime))) };
  });
}

/**
 * The grid's order: needs-you first, then sessions running, then the rest;
 * within each, active before paused, then the most recent activity. A paused
 * workstream with a session waiting on you still rises: the wait is real.
 * Done and archived only with `all`.
 */
export function orderCards(cards, { all = false } = {}) {
  return cards.filter(c => all || SHOWN.includes(c.status)).sort((a, b) =>
    (b.needs > 0) - (a.needs > 0) || (b.running > 0) - (a.running > 0)
    || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.last - a.last || String(a.slug).localeCompare(String(b.slug)));
}

/**
 * Live and recent sessions without a workstream, for the Unaffiliated card:
 * needs-you first, live before recent, newest first. `total` counts them all.
 */
export function unaffiliated(sessions, map, { sigOf = baseSig, limit = 8 } = {}) {
  const rows = (sessions || []).filter(s => s?.kind !== 'agent' && !s.hidden && (s.bucket === 'active' || s.bucket === 'recent') && !map.get(s.id))
    .map(s => ({ s, live: isLive(s), sig: isLive(s) ? sigOf(s) : 'ended' }))
    .sort((a, b) => NEEDS.has(b.sig) - NEEDS.has(a.sig) || b.live - a.live || (time(b.s.statusUpdatedAt) || time(b.s.mtime)) - (time(a.s.statusUpdatedAt) || time(a.s.mtime)));
  return { rows: rows.slice(0, limit), total: rows.length };
}

// ------------------------------------------------------------ the expanded view's records

/** "session abc, event def" (lib/workstreams.mjs fmtSource) → { session, event }; anything else → { text }. */
export function parseSource(src) {
  if (!src) return null;
  if (typeof src === 'object') return { session: src.session || null, event: src.event || null };
  const session = /\bsession ([^\s,()]+)/.exec(src)?.[1] || null;
  const event = /\bevent ([^\s,()]+)/.exec(src)?.[1] || null;
  return session || event ? { session, event } : { text: String(src) };
}

/** notes.md bullets, newest first: [{ date, text, source }]. Lines that are not dated bullets are kept, undated. */
export function parseNotes(md) {
  const out = [];
  for (const line of String(md || '').split('\n')) {
    const m = /^- (?:(\d{4}-\d{2}-\d{2}): )?(.*)$/.exec(line);
    if (!m || !m[2].trim()) continue;
    let text = m[2].trim(); let source = null;
    const s = /\s\(((?:session|event) [^()]*)\)$/.exec(text);
    if (s) { source = parseSource(s[1]); text = text.slice(0, s.index).trim(); }
    out.push({ date: m[1] || null, text, source });
  }
  return out.reverse();
}

/** A wrap-up record's path, sessions/<date>-<title-slug>-<id8>.md → { date, title, id8 }. */
export function parseRecord(file) {
  const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})-(.*)-([A-Za-z0-9]{1,8})\.md$/.exec(String(file || ''));
  if (!m) return { file, date: null, title: String(file || ''), id8: null };
  return { file, date: m[1], title: m[2].replace(/-/g, ' '), id8: m[3] };
}

/** Active decisions first (newest on top); superseded and reverted ones kept, apart. */
export function decisionGroups(decisions) {
  const all = [...(decisions || [])].sort((a, b) => (b.n || 0) - (a.n || 0));
  return { active: all.filter(d => (d.status || 'active') === 'active'), past: all.filter(d => (d.status || 'active') !== 'active') };
}

/** Starred files by repo: [[repo, [file…]]], repos in name order. */
export function groupFiles(files) {
  const by = new Map();
  for (const f of files || []) { const r = f.repo || ''; (by.get(r) || by.set(r, []).get(r)).push(f); }
  return [...by].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The Sessions tab's rows: the assigned sessions the deck knows (live first,
 * then by last activity), then wrap-up records of sessions not among them.
 * A wrapped-up session that is still listed is one row, not two.
 */
export function sessionRows(ids, records, byId) {
  const id8 = (id) => String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const known = (ids || []).map(byId).filter(Boolean)
    .sort((a, b) => isLive(b) - isLive(a) || (b.statusUpdatedAt || b.mtime || 0) - (a.statusUpdatedAt || a.mtime || 0));
  const recs = (records || []).map(parseRecord);
  const recordOf = new Map(known.map(s => [s.id, recs.find(r => r.id8 && id8(s.id) === r.id8) || null]));
  const rest = recs.filter(r => !r.id8 || !known.some(s => id8(s.id) === r.id8)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { known, recordOf, records: rest, count: known.length + rest.length };
}

/**
 * Run `fn` one at a time: a call while it runs is not dropped but folded into
 * one more run after it, so a change that lands mid-fetch is fetched too.
 */
export function coalesce(fn) {
  let running = null; let again = false;
  const run = () => {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await fn(); } while (again); }
      finally { running = null; }
    })();
    return running;
  };
  return run;
}
