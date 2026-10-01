// lib/gitinfo.mjs — git status / diff / log helpers for a session cwd.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

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
