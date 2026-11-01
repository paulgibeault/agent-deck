// public/place.js — what the header's repo and place chips say, from what
// /api/sessions/:id/place reports (lib/gitinfo.mjs place). No DOM here, so
// the tests can check it; header.js draws the chips.

const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const plural = (n, w) => `${n} ${w}`;

/** "3 ahead, 1 behind", "in step" or null when not known. */
export function aheadBehind(x) {
  if (x?.ahead == null || x?.behind == null) return null;
  if (!x.ahead && !x.behind) return 'in step';
  return [x.ahead ? plural(x.ahead, 'ahead') : null, x.behind ? plural(x.behind, 'behind') : null].filter(Boolean).join(', ');
}

/**
 * The repo chip: { kind, icon, text, title, url? }. kind is github, remote
 * (another host), local (a repo with no origin) or folder (not a repo).
 * Null until the place is known.
 */
export function repoChip(p, { cwd = p?.cwd, tilde = (x) => x } = {}) {
  if (!p) return null;
  if (!p.repo) return { kind: 'folder', icon: 'i-folder', text: base(cwd), title: `Folder ${tilde(cwd)} · not a git repo` };
  const where = tilde(p.worktree?.main || p.root);
  if (p.github) return { kind: 'github', icon: 'i-git', text: p.github.repo, url: p.github.url, title: `${p.github.repo} on GitHub\n${where}` };
  if (p.remote) return { kind: 'remote', icon: 'i-git', text: p.remote.repo, title: `${p.remote.repo}${p.remote.host ? ` on ${p.remote.host}` : ''}\n${where}` };
  return { kind: 'local', icon: 'i-git', text: base(p.worktree?.main || p.root), title: `Local repo, no remote\n${where}` };
}

/**
 * The place chip: a worktree chip (glyph and branch) in a linked worktree,
 * else a branch chip. `recorded` is the branch the session itself reported.
 * A live session is where its folder is now; an ended one shows what it
 * recorded, since the folder may have moved on (as the server picks prBranch).
 * Null when there is no branch to show.
 */
export function placeChip(p, { recorded = null, live = false, tilde = (x) => x } = {}) {
  if (!p?.repo) return null;
  const now = p.branch || (p.detached ? `detached ${p.detached}` : null);
  const rec = String(recorded || '').replace(/^HEAD$/, '') || null;
  const branch = (live ? now || rec : rec || now);
  if (!branch) return null;
  const lines = [
    p.worktree ? `Worktree on ${branch} · of ${tilde(p.worktree.main)}` : `Branch ${branch}`,
    tilde(p.root || p.cwd),
  ];
  // Base and ahead/behind are the folder's, so they only describe the chip's branch when it is the folder's own.
  if (now && now !== branch) lines.push(`The folder is now on ${now}`);
  else {
    if (p.base && p.base.branch !== now) lines.push(`Base ${p.base.branch}${aheadBehind(p.base) ? ` · ${aheadBehind(p.base)}` : ''}`);
    else if (p.base) lines.push(`Base ${p.base.branch} (this branch)`);
    if (p.upstream && aheadBehind(p.upstream)) lines.push(`${p.upstream.ref} · ${aheadBehind(p.upstream)}`);
  }
  lines.push('Click for its changes');
  return { kind: p.worktree ? 'worktree' : 'branch', icon: p.worktree ? 'i-worktree' : 'i-branch', text: branch, title: lines.join('\n') };
}
