// public/launchdirs.js — the folders the New session dialog offers for a
// workstream. No DOM, so the tests check it.

// A worktree is made per session from a repo folder; the repo is what to reuse.
const WORKTREE = /\/\.(?:agent-deck|claude)\/worktrees\//;
const clean = (p) => { const s = String(p || '').trim(); return s.length > 1 ? s.replace(/\/+$/, '') : s; };
const slugOf = (s) => typeof s.workstream === 'string' ? s.workstream : s.workstream?.slug || null;

/**
 * { mine, other }: `mine` is the workstream's folders, the one it last launched
 * in (`remembered`) first and then by its sessions, most recent first; `other`
 * is every other recent folder. No slug: everything is `other`.
 */
export function launchDirs(sessions, slug, { remembered = null, mineMax = 4, otherMax = 6 } = {}) {
  const usable = (sessions || []).filter(s => s?.cwd && !WORKTREE.test(s.cwd)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const mine = [...new Set([slug ? clean(remembered) : '', ...usable.filter(s => slug && slugOf(s) === slug).map(s => clean(s.cwd))].filter(Boolean))].slice(0, mineMax);
  const other = [...new Set(usable.map(s => clean(s.cwd)))].filter(c => !mine.includes(c)).slice(0, otherMax);
  return { mine, other };
}

/** Short names for the chips: the last folder, with its parent where two would read the same. */
export function dirLabels(dirs) {
  const tail = (p, n) => p.split('/').filter(Boolean).slice(-n).join('/') || p;
  return dirs.map(d => dirs.some(o => o !== d && tail(o, 1) === tail(d, 1)) ? tail(d, 2) : tail(d, 1));
}
