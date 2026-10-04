// lib/filetree.mjs — the Files tab's view of a session folder: one directory
// level at a time (lazy), git-aware (ignored entries flagged, status rolled up
// to folders), plus a flat list of every file for find-as-you-type. Never
// reads outside the folder it was given.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function git(cwd, args, { timeout = 8000, maxBuffer = 32 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }));
  });
}

/** Resolve `rel` under `root`, or null if it escapes (.., symlinks). */
export function within(root, rel = '') {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  const abs = path.resolve(realRoot, String(rel || '').replace(/^[/\\]+/, ''));
  let real;
  try { real = fs.realpathSync(abs); } catch { real = abs; }
  return real === realRoot || real.startsWith(realRoot + path.sep) ? { abs: real, rel: path.relative(realRoot, real), root: realRoot } : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ALWAYS_HIDDEN = new Set(['.git', '.DS_Store']);

// git status for a whole repo is cheap but not free; one per folder per few seconds.
const statusCache = new Map(); // root -> { at, repo, map: Map<rel, code>, dirs: Set<rel> }
async function repoStatus(root) {
  const hit = statusCache.get(root);
  if (hit && Date.now() - hit.at < 4000) return hit;
  const top = await git(root, ['rev-parse', '--show-prefix']);
  const out = { at: Date.now(), repo: top.ok, map: new Map(), dirs: new Set() };
  if (top.ok) {
    const r = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    const prefix = top.stdout.trim();
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const l = parts[i]; if (l.length < 4) continue;
      const x = l[0], y = l[1];
      let p = l.slice(3);
      if (x === 'R' || x === 'C') i++; // the next field is the old name
      if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
      const code = x === '?' ? 'U' : x === 'A' || y === 'A' ? 'A' : x === 'D' || y === 'D' ? 'D' : x === 'R' ? 'R' : 'M';
      out.map.set(p, code);
      for (let d = path.dirname(p); d && d !== '.'; d = path.dirname(d)) out.dirs.add(d);
    }
  }
  statusCache.set(root, out);
  return out;
}

async function ignoredIn(root, rel) {
  const r = await git(root, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '--', rel ? rel + '/' : '.']);
  return new Set(r.ok ? r.stdout.split('\n').filter(Boolean).map(s => s.replace(/\/$/, '')) : []);
}

/** One directory level: folders first, natural order. */
export async function listDir(root, rel = '') {
  const w = within(root, rel);
  if (!w) return { error: 'outside the session folder' };
  let dirents;
  try { dirents = fs.readdirSync(w.abs, { withFileTypes: true }); } catch (e) { return { error: e.message }; }
  const st = await repoStatus(w.root);
  const ignored = st.repo ? await ignoredIn(w.root, w.rel) : new Set();
  const entries = [];
  for (const d of dirents) {
    if (ALWAYS_HIDDEN.has(d.name)) continue;
    const r = w.rel ? `${w.rel}/${d.name}` : d.name;
    let s = null; try { s = fs.statSync(path.join(w.abs, d.name)); } catch { /* broken link */ }
    const dir = s ? s.isDirectory() : false;
    entries.push({
      name: d.name, path: r, dir, link: d.isSymbolicLink() || undefined,
      size: dir || !s ? undefined : s.size, mtime: s ? Math.round(s.mtimeMs) : undefined,
      ignored: ignored.has(r) || undefined,
      git: dir ? (st.dirs.has(r) ? 'M' : undefined) : st.map.get(r),
    });
  }
  entries.sort((a, b) => (b.dir - a.dir) || collator.compare(a.name, b.name));
  return { root: w.root, dir: w.rel, repo: st.repo, entries };
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache', 'target']);
/** Every file under root (git-tracked + untracked, not ignored), for finding. */
export async function allFiles(root, limit = 50_000) {
  const w = within(root, '');
  if (!w) return { error: 'no folder' };
  const st = await repoStatus(w.root);
  if (st.repo) {
    const r = await git(w.root, ['ls-files', '-co', '--exclude-standard']);
    if (r.ok) {
      const files = r.stdout.split('\n').filter(Boolean);
      return { root: w.root, files: files.slice(0, limit), truncated: files.length > limit };
    }
  }
  const files = []; const stack = [''];
  while (stack.length && files.length < limit) {
    const rel = stack.pop();
    let ds; try { ds = fs.readdirSync(path.join(w.root, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of ds) {
      if (WALK_SKIP.has(d.name) || d.name === '.DS_Store') continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(r); else files.push(r);
    }
  }
  return { root: w.root, files, truncated: files.length >= limit };
}

export const RAW_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
