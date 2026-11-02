// lib/gitinfo.mjs — git status / diff / log helpers for a session cwd.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, args, { timeout = 8000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

export async function isRepo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

function parseStatus(text) {
  const lines = text.split('\n').filter(Boolean);
  const head = lines.shift() || '';
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const bm = /^## (?:No commits yet on )?([^.\s]+(?:\.[^.\s]+)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head);
  if (bm) {
    out.branch = bm[1]; out.upstream = bm[2] || null;
    const ab = bm[3] || '';
    const a = /ahead (\d+)/.exec(ab); const b = /behind (\d+)/.exec(ab);
    out.ahead = a ? +a[1] : 0; out.behind = b ? +b[1] : 0;
  }
  for (const l of lines) {
    const x = l[0], y = l[1];
    let p = l.slice(3);
    let from = null;
    if (/^[RC]/.test(x) && p.includes(' -> ')) { [from, p] = p.split(' -> '); }
    out.files.push({ path: p, from, x, y, untracked: x === '?' , staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && y !== '?' });
  }
  return out;
}

function parseNumstat(text) {
  const map = new Map();
  for (const l of text.split('\n')) {
    if (!l) continue;
    const [a, d, ...rest] = l.split('\t');
    const p = rest.join('\t');
    map.set(p, { added: a === '-' ? null : +a, deleted: d === '-' ? null : +d, binary: a === '-' });
  }
  return map;
}

/** Composite view for the Changes tab. */
export async function changes(cwd) {
  if (!(await isRepo(cwd))) return { repo: false, cwd };
  const [st, num, root, log, base] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']),
    git(cwd, ['diff', 'HEAD', '--numstat', '--no-color', '-M']),
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['log', '-n', '25', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s']),
    git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  const status = parseStatus(st.stdout);
  const numstat = parseNumstat(num.stdout);
  let added = 0, deleted = 0;
  for (const f of status.files) {
    const n = numstat.get(f.path);
    if (n) { f.added = n.added; f.deleted = n.deleted; f.binary = n.binary; added += n.added || 0; deleted += n.deleted || 0; }
    else if (f.untracked) {
      try {
        const full = `${root.stdout.trim()}/${f.path}`;
        const txt = fs.readFileSync(full, 'utf8');
        f.added = txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0); f.deleted = 0; added += f.added;
      } catch { /* binary or unreadable */ }
    }
  }
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean).map(l => {
    const [sha, short, author, date, subject] = l.split('\x1f');
    return { sha, short, author, date, subject };
  }) : [];
  // Ahead/behind against the default branch (not only the upstream).
  const defaultBranch = base.ok ? base.stdout.trim() : null;
  let vsBase = null;
  if (defaultBranch && status.branch && defaultBranch !== `origin/${status.branch}`) {
    const r = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${defaultBranch}`]);
    if (r.ok) { const [a, b] = r.stdout.trim().split(/\s+/).map(Number); vsBase = { base: defaultBranch, ahead: a, behind: b }; }
  }
  return { repo: true, cwd, root: root.stdout.trim(), ...status, totals: { files: status.files.length, added, deleted }, commits, vsBase, fetchedAt: Date.now() };
}

/** Unified diff of one file (working tree vs HEAD; untracked → whole file as added). */
export async function fileDiff(cwd, file) {
  if (!(await isRepo(cwd))) return { repo: false };
  let r = await git(cwd, ['diff', 'HEAD', '--no-color', '-M', '--', file]);
  if (r.ok && r.stdout.trim()) return { diff: r.stdout, file };
  r = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
  if (r.stdout.trim()) return { diff: r.stdout, file, untracked: true };
  return { diff: '', file };
}

/** The GitHub owner/repo a remote URL points at, or null. */
export function githubRepo(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A remote URL as the header names it: `{ host, path, name }`, where name is
 * the last two path parts (owner/repo on most hosts). Null when unparseable.
 * Credentials in an https URL are dropped.
 */
export function remoteInfo(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  // scp-like (git@host:owner/repo.git), a URL (ssh://, https://), or a local path.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  let host = null, p = u;
  if (/^[a-z][\w+.-]*:\/\//i.test(u)) { try { const x = new URL(u); host = x.hostname || null; p = decodeURIComponent(x.pathname); } catch { return null; } }
  else if (scp && !/^[a-z]:[\\/]/i.test(u)) { host = scp[1]; p = scp[2]; }
  const parts = p.replace(/\.git\/?$/, '').replace(/\/+$/, '').split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;
  return { host, path: parts.join('/'), name: parts.slice(-2).join('/') };
}

const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Where a session works, for its header: the repo root, whether the folder is
 * a linked worktree (and of which checkout), the branch, the remote (GitHub or
 * not), and the base branch with how far HEAD is ahead and behind it.
 */
export async function place(cwd) {
  if (!(await isRepo(cwd))) return { repo: false, cwd };
  const [top, gitDir, common, head, origin, originHead, upstream] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--absolute-git-dir']),
    git(cwd, ['rev-parse', '--git-common-dir']),
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);
  const root = top.stdout.trim();
  // Compared as real paths: a folder reached through a symlink (macOS /tmp) is not a linked worktree.
  const commonDir = realpath(path.resolve(cwd, common.stdout.trim() || '.git'));
  const linked = gitDir.ok && realpath(gitDir.stdout.trim()) !== commonDir;
  const main = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  let branch = head.ok ? head.stdout.trim() : null, detached = null;
  if (!branch) { const r = await git(cwd, ['rev-parse', '--short', 'HEAD']); detached = r.ok ? r.stdout.trim() : null; }
  const defaultBranch = originHead.ok ? originHead.stdout.trim().replace(/^origin\//, '') : null;
  const base = await baseOf(cwd, { linked, main, branch });
  const counts = async (ref) => {
    const r = await git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
    if (!r.ok) return null;
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  };
  const up = upstream.ok ? upstream.stdout.trim() : null;
  const [vsBase, vsUp] = await Promise.all([base && base.branch !== branch ? counts(base.ref) : null, up ? counts(up) : null]);
  const repo = githubRepo(origin.stdout);
  const remote = origin.ok ? remoteInfo(origin.stdout) : null;
  return {
    repo: true, cwd, root,
    worktree: linked ? { name: path.basename(root), main } : null,
    branch, detached, defaultBranch,
    base: base ? { branch: base.branch, ref: base.ref, ...vsBase } : null,
    upstream: up ? { ref: up, ...vsUp } : null,
    github: repo ? { repo, url: `https://github.com/${repo}` } : null,
    remote: remote && !repo ? { name: 'origin', host: remote.host, repo: remote.name } : null,
  };
}

/**
 * The branch a session's work is measured against: origin's default branch;
 * else, in a linked worktree, the branch its main checkout is on; else a local
 * main or master. `ref` is what to compare with (origin/x when that exists).
 */
async function baseOf(cwd, { linked, main, branch }) {
  const [have, recorded] = await Promise.all([
    refSet(cwd),
    // A worktree the deck made records the branch it started from (lib/worktrees.mjs).
    branch ? git(cwd, ['config', '--get', `branch.${branch}.deckbase`]) : null,
  ]);
  const rec = recorded?.ok ? recorded.stdout.trim() : null;
  // One deleted since falls back to the usual order.
  if (rec && have.has(`refs/heads/${rec}`)) return { branch: rec, ref: refFor(have, rec) };
  const d = await defaultBranch(cwd, { main, linked, have });
  return d ? { branch: d.branch, ref: d.ref } : null;
}

const refSet = async (cwd) => {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/']);
  return new Set(r.ok ? r.stdout.split('\n').filter(Boolean) : []);
};
const refFor = (have, b) => have.has(`refs/remotes/origin/${b}`) ? `origin/${b}` : b;

/**
 * The repo's default branch, the one place the deck decides it (the header
 * and lib/worktrees.mjs both ask here): origin's HEAD; else, in a linked
 * worktree, the branch its main checkout is on; else a local main or master.
 * { branch, ref (origin/x when that exists), remote (origin has it) }, or null.
 */
export async function defaultBranch(cwd, { main = null, linked = false, have = null } = {}) {
  const [originHead, refs, mainHead] = await Promise.all([
    git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    have || refSet(cwd),
    linked && main ? git(main, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : null,
  ]);
  const b = (originHead.ok ? originHead.stdout.trim().replace(/^origin\//, '') : null) || (mainHead?.ok ? mainHead.stdout.trim() : null)
    || ['main', 'master'].find(x => refs.has(`refs/heads/${x}`)) || null;
  return b ? { branch: b, ref: refFor(refs, b), remote: refs.has(`refs/remotes/origin/${b}`) } : null;
}
