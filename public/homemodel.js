// public/homemodel.js — what Home (home.js) shows and in what order, worked out
// from stored workstreams and the deck's live sessions. No DOM, so node tests
// import it; no model calls, so drawing Home costs nothing.
import { liveNotes, NOTE_KINDS } from './briefnotes.js';

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

/** Note kinds that put a workstream with the needs-you ones: something failed, or the agent asks. */
const URGENT = new Set(['failure', 'question']);
const kindRank = (k) => { const i = NOTE_KINDS.indexOf(k); return i < 0 ? NOTE_KINDS.length : i; };

/**
 * The live (not dismissed) brief notes of some sessions: `bySession`, [{ s, notes }]
 * for each one that has any, in the order given; and `all`, [{ s, n }] for every
 * note, most urgent kind first and the sessions' order within a kind. `briefOf(id)`
 * is app.js's: the session's current brief or null. `live` is briefnotes.js's
 * liveNotes (in node it has no localStorage, so nothing reads as dismissed).
 */
export function sessionNotes(ss, briefOf, { live = liveNotes } = {}) {
  const bySession = []; const all = [];
  if (!briefOf) return { bySession, all };
  for (const s of ss || []) {
    const notes = live(s.id, briefOf(s.id));
    if (!notes.length) continue;
    bySession.push({ s, notes });
    for (const n of notes) all.push({ s, n });
  }
  all.sort((a, b) => kindRank(a.n.kind) - kindRank(b.n.kind));
  return { bySession, all };
}

const time = (v) => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : 0; };

/**
 * Each workstream with what its card needs from live state: its live sessions
 * and their signals, whether one needs you, how many are working, and when
 * anything last happened (the record's `updated` or a session's activity).
 * With `briefOf`, also its live sessions' brief notes (sessionNotes, sessions
 * that need you first) and `flags`, how many of those are failures or questions.
 */
export function cardStates(list, sessions = [], { sigOf = baseSig, map = workstreamMap(list, sessions), briefOf = null, live: liveFn, seen = null, now = Date.now() } = {}) {
  const bySlug = new Map();
  for (const s of sessions) {
    const slug = s && map.get(s.id);
    if (!slug) continue;
    (bySlug.get(slug) || bySlug.set(slug, []).get(slug)).push(s);
  }
  return (list || []).map(w => {
    const mine = bySlug.get(w.slug) || [];
    const live = mine.filter(isLive).map(s => ({ s, sig: sigOf(s) }));
    const notes = sessionNotes([...live].sort((a, b) => NEEDS.has(b.sig) - NEEDS.has(a.sig)).map(x => x.s), briefOf, liveFn ? { live: liveFn } : {});
    const c = { ...w, status: w.status || 'active', live, notes,
      flags: notes.all.filter(x => URGENT.has(x.n.kind)).length,
      needs: live.filter(x => NEEDS.has(x.sig)).length,
      running: live.filter(x => x.sig === 'working').length,
      last: Math.max(time(w.updated), ...mine.map(s => time(s.statusUpdatedAt) || time(s.mtime))),
      progress: briefProgress(live.map(x => x.s), briefOf),
      days: activityDays(mine, now) };
    c.seenAt = seen?.(c) ?? null;
    c.state = cardState(c, now);
    return c;
  });
}

/** After this long with nothing happening, a workstream reads as quiet: its edge fades. */
export const QUIET_MS = 7 * 86_400_000;
/**
 * One word for a card's color, most urgent first: error (a session failed, or a
 * brief reports a failure), input (one waits on you, or a brief asks), working,
 * paused, fresh (something happened since you last looked: `seenAt`), quiet
 * (nothing for QUIET_MS), else idle. Done and archived keep their status.
 */
export function cardState(c, now = Date.now()) {
  if (c.live?.some(x => x.sig === 'error') || c.notes?.all?.some(x => x.n.kind === 'failure')) return 'error';
  if (c.needs > 0 || c.flags > 0) return 'input';
  if (c.running > 0) return 'working';
  if (c.status === 'done' || c.status === 'archived' || c.status === 'paused') return c.status;
  if (c.seenAt != null && c.last > c.seenAt) return 'fresh';
  if (c.last && now - c.last > QUIET_MS) return 'quiet';
  return 'idle';
}

/** Where a card sits on Home: needs you, running, or the rest. */
export const sectionOf = (c) => c.state === 'error' || c.state === 'input' ? 'needs' : c.state === 'working' ? 'running' : 'rest';

/**
 * The live sessions' briefs summed: how many things are done, in progress and
 * still planned. Null when no brief lists anything.
 */
export function briefProgress(ss, briefOf) {
  if (!briefOf) return null;
  const p = { done: 0, doing: 0, todo: 0, sessions: 0 };
  for (const s of ss || []) {
    const b = briefOf(s.id); if (!b) continue;
    const n = [b.done?.length || 0, b.doing?.length || 0, b.planned?.length || 0];
    if (!n[0] && !n[1] && !n[2]) continue;
    p.done += n[0]; p.doing += n[1]; p.todo += n[2]; p.sessions++;
  }
  return p.sessions ? p : null;
}

/** Activity per day over the last `n` days, oldest first: how many of the sessions ran on each (start through last write). */
export function activityDays(ss, now = Date.now(), n = 14) {
  const out = new Array(n).fill(0);
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = day(now);
  for (const s of ss || []) {
    const end = time(s.mtime) || time(s.statusUpdatedAt); if (!end) continue;
    const start = Math.min(end, time(s.startedAt) || end);
    for (let i = 0; i < n; i++) {
      const d0 = today - (n - 1 - i) * 86_400_000;
      if (start < d0 + 86_400_000 && end >= d0) out[i]++;
    }
  }
  return out;
}

/**
 * The grid's order: needs-you first (a session waiting on you, or a failure or
 * open question in a live session's brief), then sessions running, then the
 * rest; within each, active before paused, then the most recent activity. A
 * paused workstream with a session waiting on you still rises: the wait is real.
 * Done and archived only with `all`.
 */
const wants = (c) => c.needs > 0 || c.flags > 0;
export function orderCards(cards, { all = false } = {}) {
  return cards.filter(c => all || SHOWN.includes(c.status)).sort((a, b) =>
    wants(b) - wants(a) || (b.running > 0) - (a.running > 0)
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

/**
 * A wrap-up record → { file, date, title, id8, … }: the detail's { file, date, title,
 * session, summary } (#36), or a bare path, sessions/<date>-<title-slug>-<id8>.md.
 */
export function parseRecord(file) {
  if (file && typeof file === 'object') return { ...file, date: file.date || null, title: file.title || String(file.file || ''), id8: file.session ? String(file.session).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : null };
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
