// public/ghpoll.js — the GitHub chips' pure parts: when to poll next, what a
// chip's state and CI are called, and counts for a set of links. No DOM here,
// so the tests can check it; public/ghchips.js draws and polls.

/** Every 60s while visible, every 15s while a watched PR's CI runs, at most every 15 minutes when backing off. */
export const POLL = { base: 60_000, fast: 15_000, max: 15 * 60_000 };

/**
 * When to poll next. Hidden pages and empty watch lists wait (null). A rate
 * limit waits at least as long as the server says; failures double the wait each time.
 */
export class PollScheduler {
  constructor(opts = {}) { this.o = { ...POLL, ...opts }; this.fails = 0; this.until = 0; }
  /** The poll went through. */
  ok() { this.fails = 0; this.until = 0; }
  /** The poll failed (network, server), or the server is rate limited for `retryAfter` seconds. */
  fail({ retryAfter = 0, now = Date.now() } = {}) {
    this.fails++;
    const wait = Math.min(this.o.max, this.o.base * 2 ** (this.fails - 1));
    this.until = now + Math.max(wait, retryAfter * 1000);
  }
  /** ms until the next poll, or null to wait for a reason to (visible again, something to watch). */
  next({ hidden = false, watching = true, running = false, now = Date.now() } = {}) {
    if (hidden || !watching) return null;
    const every = running ? this.o.fast : this.o.base;
    return Math.max(every, this.until - now);
  }
}

/**
 * `fn` run one at a time: a call while it runs is not dropped but remembered,
 * and `fn` runs once more as soon as the current run ends. Returns the runner.
 */
export function coalesce(fn) {
  let running = null, again = false;
  return function run() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await fn(); } while (again); }
      finally { running = null; }
    })();
    return running;
  };
}

/** Same as lib/ghstate.mjs keyOf: `owner/repo#12`, `owner/repo%3` for a milestone. */
export function keyOf(r) {
  const repo = String(r.repo || '').toLowerCase();
  return r.kind === 'milestone' ? `${repo}%${r.number}` : `${repo}#${r.number}`;
}

export const ST_LABEL = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed', 'not-planned': 'closed as not planned' };
export const CI_LABEL = { success: 'CI passing', failure: 'CI failing', pending: 'CI running' };
export const REVIEW_LABEL = { approved: 'approved', changes_requested: 'changes requested', review_required: 'review required' };

/** What a ref (the place's, overlaid with the live state) shows: { kind, st, ci }. ci only on an open or draft PR. */
export function chipState(r) {
  if (r.kind === 'milestone') return { kind: 'milestone', st: r.state === 'closed' ? 'closed' : r.state ? 'open' : 'unknown', ci: null };
  const kind = r.kind === 'pr' ? 'pr' : 'issue';
  const st = r.st || (r.state === 'merged' ? 'merged' : r.draft && r.state === 'open' ? 'draft' : r.state) || 'unknown';
  const ci = kind === 'pr' && (st === 'open' || st === 'draft') ? r.ci || r.checks?.state || null : null;
  return { kind, st, ci };
}
/** The chip's classes: state for colour, CI for its corner glyph. */
export function chipClass(r) {
  const { kind, st, ci } = chipState(r);
  return `gh ${kind} st-${st}${ci ? ` ci-${ci}` : ''}`;
}
/** "Pull request #34: open, CI failing, changes requested. Fix the widget" — the chip spelled out for a screen reader. */
export function chipLabel(r, num = `#${r.number}`) {
  const { kind, st, ci } = chipState(r);
  if (kind === 'milestone') return `Milestone ${r.number}${st !== 'unknown' ? `: ${st}` : ''}${r.open != null ? `, ${r.open} open, ${r.closed} closed` : ''}.${r.title ? ` ${r.title}` : ''}`;
  const bits = [ST_LABEL[st] || null, ci ? CI_LABEL[ci] : null, kind === 'pr' && st === 'open' && r.review ? REVIEW_LABEL[r.review] : null,
    r.conflicts && st === 'open' ? 'merge conflicts' : null].filter(Boolean);
  return `${kind === 'pr' ? 'Pull request' : 'Issue'} ${num}${bits.length ? `: ${bits.join(', ')}` : ''}.${r.title ? ` ${r.title}` : ''}`;
}

/**
 * Open and closed counts for a workstream's pinned links ({ kind: 'issue'|'pr'|'milestone', repo, number }):
 * issues and PRs count one each, a milestone its issues. `info(link)` is the known state or undefined.
 * Returns { open, closed, known, total }; known < total while some are not in yet.
 */
export function countLinks(links, info) {
  const out = { open: 0, closed: 0, known: 0, total: links.length };
  for (const l of links) {
    const i = info(l);
    if (!i) continue;
    out.known++;
    if (i.kind === 'milestone') { out.open += i.open || 0; out.closed += i.closed || 0; }
    else if (i.state === 'open') out.open++;
    else out.closed++;
  }
  return out;
}
