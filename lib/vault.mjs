// lib/vault.mjs — the Vault: a local git repo with no remote, for files,
// scratch code and artifacts that must never sync to GitHub. Items tied to a
// workstream live under <slug>/, the rest under loose/.
//
// Append-only from the deck's side: a save never overwrites (a clashing name
// gets -2, -3, ...), and nothing here deletes or moves Vault content out.
// Each saved file gets a sidecar <name>.meta.json saying where it came from.
// Workstreams link in through vault.json pointers ({path, sha256, title,
// source}), never content, so the GitHub-synced record leaks nothing.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const META = '.meta.json';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LIST_MAX = 2000;
// Folders listed but not walked: big, rebuildable, and not what anyone saved.
const HEAVY = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo', '.parcel-cache', '.gradle', 'target', '.pytest_cache', '.mypy_cache']);
// A pre-push hook, so even a remote someone adds by hand gets nothing.
const PRE_PUSH = '#!/bin/sh\n# agent-deck vault guard\necho "agent-deck: the Vault is local-only; refusing to push." >&2\nexit 1\n';
// git's global options that take a separate value; the subcommand is the first word after them.
const OPT_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

/** git's subcommand and its own arguments, past any global options. */
export function gitCommand(args) {
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) i += OPT_VALUE.has(args[i]) ? 2 : 1;
  return { cmd: args[i], rest: args.slice(i + 1) };
}
/** Would these git arguments give the Vault a remote, or push it? */
export function remoteBound(args) {
  const { cmd, rest } = gitCommand(args);
  const words = rest.filter(a => !String(a).startsWith('-'));
  if (cmd === 'push') return true;
  if (cmd === 'remote' && ['add', 'set-url', 'rename'].includes(words[0])) return true;
  // `git config remote.x.url <url>` makes one too; reading a key (one word) is fine.
  if (cmd === 'config' && words.length >= 2 && /^remote\./i.test(words[0])) return true;
  return false;
}

/** Error with an HTTP-ish status for the route to pass on. */
class VaultError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

/** The repo (a dir holding .git, file or folder) that contains `p`, or null. */
export function repoOf(p) {
  let dir = p;
  try { dir = fs.realpathSync(p); } catch { /* not there: walk the path as given */ }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A file name safe to keep: no separators or control chars, not hidden, not too long. */
export function cleanName(name) {
  const n = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f:]/g, '-').replace(/^[.\s]+/, '').trim().slice(0, 120);
  return n || 'file';
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

export class Vault {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.queue = Promise.resolve();   // saves one at a time, so git never races its own index lock
  }

  /**
   * Run git in the Vault. Adding a remote or pushing is refused here, the
   * one place the deck runs git on it.
   */
  git(...args) {
    if (remoteBound(args)) return Promise.reject(new VaultError('The Vault is local-only: it never gets a remote.', 403));
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', this.dir, '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        if (err) { err.message = (stderr || err.message).trim(); reject(err); } else resolve(stdout);
      });
    });
  }

  exists() { return fs.existsSync(path.join(this.dir, '.git')); }

  /**
   * Create the repo on first use, and make sure the push guard is in place
   * every time: a folder picked with /api/vault/config may be an existing repo.
   */
  async init() {
    if (!this.exists()) {
      fs.mkdirSync(this.dir, { recursive: true });
      await this.git('init', '-q');
      this.guarded = false;
    }
    if (this.guarded) return;
    // From the git dir, not --git-path hooks: that follows a global core.hooksPath out of the Vault.
    const hooks = path.join((await this.git('rev-parse', '--absolute-git-dir')).trim(), 'hooks');
    const hook = path.join(hooks, 'pre-push');
    fs.mkdirSync(hooks, { recursive: true });
    let cur = null; try { cur = fs.readFileSync(hook, 'utf8'); } catch { /* none yet */ }
    if (cur !== PRE_PUSH) {
      // Someone else's hook is kept beside ours, not thrown away.
      if (cur != null && !cur.includes('the Vault is local-only')) fs.renameSync(hook, `${hook}.before-vault-${Date.now()}`);
      fs.writeFileSync(hook, PRE_PUSH, { mode: 0o755 });
    }
    fs.chmodSync(hook, 0o755);
    // A global core.hooksPath would bypass this repo's hooks; it uses its own.
    const set = (await this.git('config', '--local', 'core.hooksPath').catch(() => '')).trim();
    if (set !== hooks) await this.git('config', '--local', 'core.hooksPath', hooks);
    this.guarded = true;
  }

  /** Remote names, if any: there should be none. */
  async remotes() {
    if (!this.exists()) return [];
    return (await this.git('remote')).split('\n').map(s => s.trim()).filter(Boolean);
  }

  /** Where the Vault is and whether it is sound: `warning` is set when a remote has appeared. */
  async status() {
    const remotes = await this.remotes().catch(() => []);
    return {
      dir: this.dir, exists: this.exists(), remotes,
      warning: remotes.length ? `The Vault has a remote (${remotes.join(', ')}). It should never sync: remove it with \`git -C "${this.dir}" remote remove ${remotes[0]}\`.` : null,
    };
  }

  /** The folder for a workstream slug, or loose/. */
  area(workstream) {
    const slug = workstream == null || workstream === '' ? 'loose' : String(workstream);
    if (!SLUG.test(slug)) throw new VaultError(`bad workstream slug: ${slug}`);
    return slug;
  }

  /**
   * Copy a file in. Returns { path (absolute), rel, meta, warning }.
   * `source` is { path, sessionId, eventId, via } (all optional), kept in the sidecar.
   */
  saveFile(src, { workstream, name, title, source = {}, sha = null, warn = true } = {}) {
    return this._serial(async () => {
      let st; try { st = fs.statSync(src); } catch { throw new VaultError(`no such file: ${src}`, 404); }
      if (!st.isFile()) throw new VaultError('Only files can be saved to the Vault.');
      return this._store(name || path.basename(src), (to) => fs.copyFileSync(src, to, fs.constants.COPYFILE_EXCL), { workstream, title, source: { path: src, ...source }, sha, warn });
    });
  }

  /** Save bytes (an attachment, an image from a transcript, the text an event shows) under `name`. */
  saveData(name, data, { workstream, title, source = {} } = {}) {
    return this._serial(() => this._store(name, (to) => fs.writeFileSync(to, data, { flag: 'wx' }), { workstream, title, source,
      sha: createHash('sha256').update(data).digest('hex') }));
  }

  async _store(name, write, { workstream, title, source, sha = null, warn = true }) {
    await this.init();
    const area = this.area(workstream);
    const dir = path.join(this.dir, area);
    fs.mkdirSync(dir, { recursive: true });
    const file = this._claim(dir, cleanName(name), write);
    const side = file + META;
    const mine = [file];
    try {
      const st = fs.statSync(file);
      const meta = {
        title: title || path.basename(file), savedAt: new Date().toISOString(), size: st.size, sha256: sha || await sha256File(file),
        source: Object.fromEntries(Object.entries(source || {}).filter(([, v]) => v != null && v !== '')),
      };
      fs.writeFileSync(side, JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
      mine.push(side);
      const rel = path.relative(this.dir, file);
      await this._commit([file, side], `Save ${rel}${meta.source.sessionId ? `\n\nFrom session ${meta.source.sessionId}${meta.source.eventId ? `, event ${meta.source.eventId}` : ''}.` : ''}`);
      return { path: file, rel, meta, warning: warn ? (await this.status()).warning : null };
    } catch (e) {
      // A save that did not commit takes back only what it just wrote, so no orphan
      // is left to look "already saved". Nothing saved before is touched.
      await this.git('rm', '-q', '--cached', '--ignore-unmatch', '--', ...mine).catch(() => {});
      for (const f of mine) fs.rmSync(f, { force: true });
      throw e;
    }
  }

  /** Write under a name nothing holds yet (nor its sidecar): name, name-2, name-3, ... Never overwrites. */
  _claim(dir, name, write) {
    const ext = name.endsWith(META) ? '' : path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 1; i < 10000; i++) {
      const to = path.join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
      if (fs.existsSync(to) || fs.existsSync(to + META)) continue;
      try { write(to); return to; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw new VaultError(`no free name for ${name}`, 409);
  }

  async _commit(files, msg) {
    // -f: a global ignore rule (*.log, say) must not leave a saved file out of history.
    await this.git('add', '-f', '--', ...files);
    // Fall back to a deck identity only where git has none, so a fresh machine can still commit. Asked once.
    this.who ??= (await this.git('config', 'user.email').catch(() => '')).trim() ? [] : ['-c', 'user.name=agent-deck', '-c', 'user.email=agent-deck@localhost'];
    await this.git(...this.who, 'commit', '-q', '-m', msg, '--', ...files);
  }

  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * For wrap-up: copy a session's artifacts into <workstream>/, but only the
   * ones outside any repo (repo files are already kept by git). Returns
   * { copied: [save results], skipped: [{ path, reason }] }. A file already
   * saved from the same place with the same content is skipped, so running it twice adds nothing.
   */
  async copyArtifacts(paths, { workstream, source = {} } = {}) {
    const copied = [], skipped = [];
    const area = this.area(workstream);
    const seen = this._saved(area);   // read once per batch
    const vaultReal = this.exists() ? fs.realpathSync(this.dir) : null;
    for (const p of paths || []) {
      const abs = path.resolve(String(p));
      let st; try { st = fs.statSync(abs); } catch { skipped.push({ path: abs, reason: 'missing' }); continue; }
      if (!st.isFile()) { skipped.push({ path: abs, reason: 'not a file' }); continue; }
      const repo = repoOf(abs);
      if (repo) { skipped.push({ path: abs, reason: repo === vaultReal ? 'already in the Vault' : 'in a repository' }); continue; }
      const sha = await sha256File(abs);
      if (seen.has(`${sha}\0${abs}`)) { skipped.push({ path: abs, reason: 'already saved' }); continue; }
      copied.push(await this.saveFile(abs, { workstream, sha, warn: false, source: { via: 'wrapup', ...source } }));
      seen.add(`${sha}\0${abs}`);
    }
    // Remotes checked once for the batch, not per file.
    return { copied, skipped, warning: copied.length ? (await this.status()).warning : null };
  }

  /** What `area` holds already, by sidecar: a set of "sha256\0source path". */
  _saved(area) {
    const out = new Set();
    let names; try { names = fs.readdirSync(path.join(this.dir, area)); } catch { return out; }
    for (const n of names) {
      if (!n.endsWith(META)) continue;
      try { const m = JSON.parse(fs.readFileSync(path.join(this.dir, area, n), 'utf8')); if (m.sha256 && m.source?.path) out.add(`${m.sha256}\0${m.source.path}`); } catch { /* not ours */ }
    }
    return out;
  }

  /** Make a fresh folder under loose/ for a scratch session; never reuses one. Returns its absolute path. */
  async scratch(name) {
    await this.init();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const base = cleanName(name || `scratch-${stamp}`);
    for (let i = 1; i < 1000; i++) {
      const dir = path.join(this.dir, 'loose', i === 1 ? base : `${base}-${i}`);
      try { fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw new VaultError('no free scratch folder name', 409);
  }

  /**
   * What's in the Vault: { items, truncated }. Files carry their sidecar meta;
   * sidecars are folded in. Breadth-first, so every area shows before any one
   * deep folder fills the cap; heavy folders (node_modules, build caches) are
   * listed with `heavy: true` but not walked. Items come back in tree order.
   */
  async list({ max = LIST_MAX } = {}) {
    const out = [];
    let truncated = false;
    let level = [{ dir: this.dir, rel: '' }];
    while (level.length && !truncated) {
      const next = [];
      for (const { dir, rel } of level) {
        let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        const names = new Set(ents.map(e => e.name));
        for (const e of ents) {
          if (e.name === '.git' || (e.name.endsWith(META) && names.has(e.name.slice(0, -META.length)))) continue;
          if (out.length >= max) { truncated = true; break; }
          const r = rel ? `${rel}/${e.name}` : e.name;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            const heavy = HEAVY.has(e.name);
            out.push({ rel: r, path: abs, dir: true, ...(heavy ? { heavy } : {}) });
            if (!heavy) next.push({ dir: abs, rel: r });
            continue;
          }
          let st; try { st = await fs.promises.stat(abs); } catch { continue; }
          let meta = null; try { meta = JSON.parse(await fs.promises.readFile(abs + META, 'utf8')); } catch { /* no sidecar: made in place */ }
          out.push({ rel: r, path: abs, size: st.size, mtime: st.mtimeMs, meta });
        }
        if (truncated) break;
      }
      level = next;
    }
    // Tree order: by path segments, so a folder's contents follow it.
    const key = (r) => r.split('/');
    out.sort((a, b) => {
      const x = key(a.rel), y = key(b.rel);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i].localeCompare(y[i]);
      return x.length - y.length;
    });
    return { items: out, truncated };
  }

  /** Recent history, newest first: [{ sha, at, subject }]. */
  async log(n = 20) {
    if (!this.exists()) return [];
    const out = await this.git('log', `-${n}`, '--format=%h%x09%cI%x09%s').catch(() => '');
    return out.split('\n').filter(Boolean).map(l => { const [sha, at, subject] = l.split('\t'); return { sha, at, subject }; });
  }

  // ------------------------------------------------------- pointers
  /**
   * A workstream's link to a Vault file: { path (Vault-relative), sha256, title, source }.
   * Never the content. `source` is a short string (default: the session it came from).
   */
  async pointer(file, { title, source } = {}) {
    const abs = path.resolve(this.dir, file);
    const rel = path.relative(this.dir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new VaultError(`not in the Vault: ${file}`);
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(abs + META, 'utf8')); } catch { /* no sidecar */ }
    return pointerOf({ path: rel.split(path.sep).join('/'), sha256: await sha256File(abs), title: title || meta.title || path.basename(abs), source: source ?? meta.source?.sessionId ?? null });
  }

  /** Each pointer with `state`: ok, missing or changed (for the curation pass). */
  async checkPointers(pointers) {
    return Promise.all((pointers || []).map(async (p) => {
      const abs = path.resolve(this.dir, String(p.path ?? ''));
      if (!p.path || path.relative(this.dir, abs).startsWith('..')) return { ...pointerOf(p), state: 'missing' };
      const sha = await sha256File(abs).catch(() => null);
      return { ...pointerOf(p), state: sha == null ? 'missing' : sha === p.sha256 ? 'ok' : 'changed' };
    }));
  }
}

/** Only the four pointer fields, whatever else came in: content cannot ride along. */
export function pointerOf(p) {
  const s = (v) => v == null ? null : String(v);
  return { path: s(p.path), sha256: s(p.sha256), title: s(p.title), source: s(p.source) };
}

/** A workstream repo's vault.json: its pointers, [] when there is none yet. */
export function readPointers(repoDir) {
  try { const v = JSON.parse(fs.readFileSync(path.join(repoDir, 'vault.json'), 'utf8')); return Array.isArray(v) ? v.map(pointerOf) : []; } catch { return []; }
}

/**
 * Merge pointers into <repoDir>/vault.json (one per path; a newer one for the
 * same path replaces the old). Writes nothing but the four fields. Does not commit:
 * the workstream store does that. Returns the full list.
 */
export function writePointers(repoDir, pointers) {
  const byPath = new Map(readPointers(repoDir).map(p => [p.path, p]));
  for (const p of pointers || []) { const q = pointerOf(p); if (q.path) byPath.set(q.path, q); }
  const list = [...byPath.values()];
  const file = path.join(repoDir, 'vault.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return list;
}

/** The Vault for this deck: a custom dir from deck.ns('vault') `dir`, else <state dir>/vault. */
const open = new Map();
export function vaultFor(deck) {
  const dir = deck.ns('vault').get('dir') || path.join(deck.dir, 'vault');
  if (!open.has(dir)) open.set(dir, new Vault(dir));
  return open.get(dir);
}

export { VaultError };
