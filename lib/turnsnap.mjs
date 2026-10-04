// lib/turnsnap.mjs — what each turn changed, from git, whatever made the change.
//
// At every turn boundary seen live (a prompt arrives, a turn ends) the deck
// writes the working tree to a git tree object through its own private index
// (GIT_INDEX_FILE), so the user's index, branch and stash are never touched.
// A turn's changes are then `git diff <start tree> <end tree>`: edits by tools,
// by shell scripts and by subagents alike. Turns that happened before the deck
// was watching have no snapshots; the client falls back to the tool edits.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

function git(cwd, args, { env = {}, timeout = 20_000, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

export class TurnSnapshots {
  constructor({ dir }) {
    this.dir = path.join(dir, 'turnsnaps');
    this.file = path.join(this.dir, 'index.json');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* read-only */ }
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = { sessions: {} }; }
    this.roots = new Map();   // cwd -> repo root | null
    this.chains = new Map();  // root -> promise (one snapshot at a time per repo)
    this.open = new Map();    // sessionId -> prompt id of the turn in progress
    this.diffs = new Map();   // "a..b" -> files
    this.saveTimer = null;
  }

  async rootOf(cwd) {
    if (!this.roots.has(cwd)) {
      const r = fs.existsSync(cwd) ? await git(cwd, ['rev-parse', '--show-toplevel']) : { ok: false };
      this.roots.set(cwd, r.ok ? r.stdout.trim() : null);
    }
    return this.roots.get(cwd);
  }

  /** The working tree, as a tree object id. Serialized per repo. */
  async snapshot(cwd) {
    const root = await this.rootOf(cwd);
    if (!root) return null;
    const run = async () => {
      const env = { GIT_INDEX_FILE: path.join(this.dir, createHash('sha1').update(root).digest('hex').slice(0, 16) + '.index') };
      // Seeded from HEAD once, the private index keeps git's stat cache warm.
      if (!fs.existsSync(env.GIT_INDEX_FILE)) await git(root, ['read-tree', 'HEAD'], { env });
      const add = await git(root, ['add', '-A', '--', '.'], { env });
      if (!add.ok) return null;
      const w = await git(root, ['write-tree'], { env });
      return w.ok ? { root, tree: w.stdout.trim() } : null;
    };
    const p = (this.chains.get(root) || Promise.resolve()).then(run, run);
    this.chains.set(root, p.catch(() => null));
    return p;
  }

  /** Feed live events for a session; snapshots at turn starts and ends. */
  async observe(sessionId, cwd, events) {
    for (const ev of events) {
      const start = ev.kind === 'prompt', end = ev.kind === 'turn_end';
      if (!start && !end) continue;
      const snap = await this.snapshot(cwd).catch(() => null);
      if (!snap) return;
      const s = this.data.sessions[sessionId] ||= { root: snap.root, turns: {} };
      const prev = this.open.get(sessionId);
      if (prev && s.turns[prev] && !s.turns[prev].b) Object.assign(s.turns[prev], { b: snap.tree, bTs: ev.ts });
      if (start) { s.turns[ev.id] = { a: snap.tree, aTs: ev.ts }; this.open.set(sessionId, ev.id); }
      else this.open.delete(sessionId);
      this.save();
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* ignore */ } }, 500);
    this.saveTimer.unref?.();
  }

  async filesBetween(root, a, b) {
    const key = `${a}..${b}`;
    if (this.diffs.has(key)) return this.diffs.get(key);
    const [ns, nm] = await Promise.all([
      git(root, ['diff', '--no-renames', '--numstat', '-z', a, b]),
      git(root, ['diff', '--no-renames', '--name-status', '-z', a, b]),
    ]);
    const files = new Map();
    const st = nm.stdout.split('\0');
    for (let i = 0; i + 1 < st.length; i += 2) if (st[i]) files.set(st[i + 1], { path: st[i + 1], status: st[i][0], add: 0, del: 0 });
    for (const rec of ns.stdout.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(rec); if (!m) continue;
      const f = files.get(m[3]) || { path: m[3], status: 'M' };
      Object.assign(f, { add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' || undefined });
      files.set(m[3], f);
    }
    const out = [...files.values()];
    if (a !== b) this.diffs.set(key, out);
    if (this.diffs.size > 500) this.diffs.delete(this.diffs.keys().next().value);
    return out;
  }

  /** { root, turns: { [promptId]: { files, live? } } } for a session. */
  async changes(sessionId, cwd) {
    const s = this.data.sessions[sessionId];
    if (!s) return { root: await this.rootOf(cwd), turns: {} };
    const turns = {};
    let now = null;
    for (const [id, t] of Object.entries(s.turns)) {
      let b = t.b;
      if (!b) {
        if (this.open.get(sessionId) !== id) continue;   // never closed (deck stopped mid-turn)
        now ||= await this.snapshot(cwd); if (!now) continue; b = now.tree;
      }
      turns[id] = { files: await this.filesBetween(s.root, t.a, b), live: !t.b || undefined };
    }
    return { root: s.root, turns };
  }

  /** Unified diff of one file across one turn. */
  async diff(sessionId, cwd, turnId, file) {
    const s = this.data.sessions[sessionId]; const t = s?.turns[turnId];
    if (!t) return { error: 'no snapshot for that turn' };
    let b = t.b;
    if (!b) { const now = await this.snapshot(cwd); if (!now) return { error: 'snapshot failed' }; b = now.tree; }
    const r = await git(s.root, ['diff', '--no-renames', '--no-color', '-U3', t.a, b, '--', file]);
    return r.ok ? { file, diff: r.stdout } : { error: r.stderr.trim() || 'git diff failed' };
  }
}
