// lib/workstreams.mjs — workstreams: long efforts that outlive their sessions,
// stored as plain markdown and JSON in one private GitHub repo, cloned locally
// (default ~/.agent-deck/workstreams/). Every change is one commit; pushes are
// debounced and retried, so it works offline. Before writing it fetches and
// rebases. What's derived or append-only merges itself (index.json is regenerated,
// workstream.md field by field, notes.md by appending, a duplicate decision number
// renumbered); any other conflict stops writes and is reported, never auto-resolved.
// Everything written passes the secret scrubber (lib/scrub.mjs) first.
//
//   <slug>/workstream.md              frontmatter (title, goal, status, created, updated, pinned) + body sections
//   <slug>/decisions/NNNN-<slug>.md   frontmatter (title, status, supersedes, source, date) + body
//   <slug>/notes.md                   dated bullets, each with its source
//   <slug>/sessions/<date>-<title-slug>-<id8>.md   one wrap-up record per session (#36)
//   <slug>/files.json · links.json · vault.json     starred files, PRs/issues, Vault pointers
//   index.json                        slug, title, status, updated per workstream
//
// git and gh are run through injectable runners, so tests use a local bare repo as the remote.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './scrub.mjs';

export const STATUSES = ['active', 'paused', 'done', 'archived'];
export const DECISION_STATUSES = ['active', 'superseded', 'reverted'];
export const REPO_NAME = 'agent-deck-workstreams';
const LISTS = ['files', 'links', 'vault'];
// Slugs that would shadow /api/workstreams/<route>.
const RESERVED = ['setup', 'sync'];
const QUIET = new Set(['remote', 'ahead', 'pushing']);
// Body sections of workstream.md, in order: field → heading.
const SECTIONS = [['summary', 'Summary'], ['where', 'Where we are'], ['next', 'Next step'], ['questions', 'Open questions']];

/** A runner for `bin`: (args, { cwd }) → { ok, code, stdout, stderr }. Never throws. */
export function runner(bin, env = {}) {
  return (args, { cwd, timeout = 60_000 } = {}) => new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 16 << 20, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout ?? '', stderr: stderr ?? (err?.message || '') }));
  });
}

export function slugify(s, max = 48) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'untitled';
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** owner/name for a github.com https or ssh URL; null for anything else. */
export function githubRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/|ssh:\/\/[^@/]+@github\.com(?::\d+)?\/|[^@/\s]+@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// ------------------------------------------------------------ frontmatter
// A YAML subset that GitHub renders: one `key: value` per line; strings bare when
// safe, otherwise JSON-quoted; arrays and objects as JSON (YAML flow style).
const BARE = /^[A-Za-z0-9][A-Za-z0-9 _./()+,-]*$/;
function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return BARE.test(v) && !/^(?:true|false|null|yes|no|~|-?\d[\d.]*)$/i.test(v) && !/[ ]$/.test(v) && !v.includes(': ') ? v : JSON.stringify(v);
  return JSON.stringify(v);
}
export function frontmatter(fields, body = '') {
  const lines = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body ? `\n${body.replace(/\s+$/, '')}\n` : ''}`;
}
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':'); if (i < 1) continue;
    const k = line.slice(0, i).trim(); const raw = line.slice(i + 1).trim();
    let v = raw;
    if (/^["[{]|^(?:null|true|false|-?\d+(?:\.\d+)?)$/.test(raw)) { try { v = JSON.parse(raw); } catch { /* a bare string */ } }
    fields[k] = v;
  }
  return { fields, body: text.slice(m[0].length).replace(/^\n/, '') };
}

function sectionsToBody(s) {
  return SECTIONS.map(([k, h]) => { const t = String(s[k] || '').trim(); return t ? `## ${h}\n\n${t}` : `## ${h}`; }).join('\n\n');
}
function bodyToSections(body) {
  const out = Object.fromEntries(SECTIONS.map(([k]) => [k, '']));
  const byHeading = Object.fromEntries(SECTIONS.map(([k, h]) => [h.toLowerCase(), k]));
  let key = null;
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && byHeading[h[1].toLowerCase()]) { key = byHeading[h[1].toLowerCase()]; continue; }
    if (key) out[key] += line + '\n';
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

/**
 * Merge two edits of a workstream.md that git could not: field by field, and the
 * body whole. `updated` takes the later. Null when both sides changed the same thing.
 */
export function mergeWorkstream(base, ours, theirs) {
  const [b, o, t] = [base, ours, theirs].map(x => parseFrontmatter(x ?? ''));
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const fields = {};
  for (const k of new Set([...Object.keys(o.fields), ...Object.keys(t.fields)])) {
    if (k === 'updated') { fields[k] = [o.fields[k], t.fields[k]].filter(Boolean).sort().pop(); continue; }
    const [bv, ov, tv] = [b.fields[k], o.fields[k], t.fields[k]];
    if (same(ov, tv) || same(tv, bv)) fields[k] = ov; else if (same(ov, bv)) fields[k] = tv; else return null;
  }
  let body;
  if (o.body === t.body || t.body === b.body) body = o.body; else if (o.body === b.body) body = t.body; else return null;
  return frontmatter(fields, body);
}

/** notes.md only grows: both sides' new bullets, theirs after ours. Null if either side rewrote what was there. */
export function mergeNotes(base, ours, theirs) {
  const b = String(base ?? '').replace(/\s*$/, '\n');
  const [o, t] = [ours, theirs].map(x => String(x ?? '').replace(/\s*$/, '\n'));
  if (!o.startsWith(b) || !t.startsWith(b)) return null;
  return o + t.slice(b.length);
}

const today = (d) => d.toISOString().slice(0, 10);
const fmtSource = (src) => !src ? '' : typeof src === 'string' ? src : [src.session && `session ${src.session}`, src.event && `event ${src.event}`].filter(Boolean).join(', ');

// ---------------------------------------------------------------- store
export class WorkstreamStore extends EventEmitter {
  /**
   * dir: the local clone. git, gh: runners (see runner()). vault: () => [text]
   * of Vault files, redacted wherever quoted. pushDelay: debounce (ms);
   * retryDelay: wait after a failed push. fetchTimeout: how long a
   * pre-write fetch may take before the write goes ahead offline. now: clock, for tests.
   */
  constructor({ dir, git = runner('git'), gh = runner('gh'), vault = () => [], pushDelay = 3000, retryDelay = 60_000, fetchTimeout = 10_000, now = () => new Date() } = {}) {
    super();
    this.dir = dir;
    this.git = (args, o = {}) => git(args, { cwd: this.dir, ...o });
    this.gh = gh;
    this.vault = vault;
    this.pushDelay = pushDelay;
    this.retryDelay = retryDelay;
    this.fetchTimeout = fetchTimeout;
    this.now = now;
    this.queue = Promise.resolve();
    this.pushTimer = null;
    // remote and ahead are cached here, refreshed on setup, fetch, commit and push, so status() spawns nothing.
    this.sync = { remote: null, ahead: 0, conflict: null, dirty: null, lastError: null, lastPush: null, pushing: false };
    this._known = false;
  }

  /** Where Vault content comes from, for redaction: () => [text]. Wired by the Vault (#31) or wrap-up (#36). */
  setVault(fn) { this.vault = typeof fn === 'function' ? fn : () => []; }

  ready() { return !!this.dir && fs.existsSync(path.join(this.dir, '.git')); }

  /** Where the store stands: set up or not, its remote, unpushed commits, a conflict or a dirty clone. */
  async status() {
    if (!this.ready()) return { ready: false, dir: this.dir, ...this.sync };
    if (!this._known) await this._refresh();
    return { ready: true, dir: this.dir, ...this.sync };
  }

  async _refresh() {
    if (!this.ready()) return;
    this._known = true;
    const remote = (await this.git(['remote', 'get-url', 'origin'])).stdout.trim() || null;
    this._setSync({ remote, ahead: await this._ahead() });
  }

  // ------------------------------------------------------------ setup
  /** The repo the deck would create: <gh user>/agent-deck-workstreams, and whether it exists already. */
  async suggest() {
    const who = await this.gh(['api', 'user', '--jq', '.login']);
    if (!who.ok) return { error: (who.stderr || 'gh is not signed in').trim() };
    const repo = `${who.stdout.trim()}/${REPO_NAME}`;
    const view = await this.gh(['repo', 'view', repo, '--json', 'visibility,url']);
    let info = null; try { info = view.ok ? JSON.parse(view.stdout) : null; } catch { /* not there */ }
    return { repo, exists: !!info, visibility: info?.visibility?.toLowerCase() || null,
      command: `gh repo create ${repo} --private` };
  }

  /** Create the private repo on GitHub and clone it. Only on the user's say-so (`confirm`). */
  async createRepo({ confirm = false } = {}) {
    if (!confirm) throw Object.assign(new Error('creating a GitHub repo needs confirmation'), { code: 400 });
    if (this.ready()) throw Object.assign(new Error('the workstreams repo is already set up'), { code: 409 });
    const s = await this.suggest();
    if (s.error) throw Object.assign(new Error(s.error), { code: 502 });
    if (!s.exists) {
      const r = await this.gh(['repo', 'create', s.repo, '--private', '--description', 'agent-deck workstreams']);
      if (!r.ok) throw Object.assign(new Error(`gh repo create failed: ${r.stderr.trim()}`), { code: 502 });
    }
    return this.useRepo({ repo: s.repo });
  }

  /**
   * Use an existing repo: `owner/name` (cloned with gh) or a git URL or path
   * (cloned with git). Anything on GitHub, as owner/name or a github.com https
   * or ssh URL, is refused unless gh says it's private. Clones into `dir`.
   */
  async useRepo({ repo } = {}) {
    if (this.ready()) throw Object.assign(new Error('the workstreams repo is already set up'), { code: 409 });
    if (!repo || typeof repo !== 'string' || !repo.trim()) throw Object.assign(new Error('which repo?'), { code: 400 });
    repo = repo.trim();
    // Never let a repo string be read as an option by git or gh.
    if (repo.startsWith('-')) throw Object.assign(new Error('a repo cannot start with "-"'), { code: 400 });
    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    if (fs.existsSync(this.dir) && fs.readdirSync(this.dir).length) throw Object.assign(new Error(`${this.dir} exists and is not empty`), { code: 409 });
    const shorthand = /^[\w.-]+\/[\w.-]+$/.test(repo) && !fs.existsSync(repo);
    const onGitHub = shorthand ? repo : githubRepo(repo);
    if (onGitHub) {
      const view = await this.gh(['repo', 'view', onGitHub, '--json', 'visibility']);
      let vis = null; try { vis = JSON.parse(view.stdout).visibility; } catch { /* unknown */ }
      if (!view.ok) throw Object.assign(new Error(`cannot see ${onGitHub}: ${view.stderr.trim()}`), { code: 404 });
      if (String(vis).toUpperCase() !== 'PRIVATE') throw Object.assign(new Error(`${onGitHub} is ${String(vis).toLowerCase()}; workstreams need a private repo`), { code: 409 });
    }
    const r = shorthand ? await this.gh(['repo', 'clone', repo, this.dir])
      : await this.git(['clone', '--', repo, this.dir], { cwd: path.dirname(this.dir) });
    if (!r.ok) throw Object.assign(new Error(`clone failed: ${r.stderr.trim()}`), { code: 502 });
    await this._refresh();
    this.emit('changed', { reason: 'setup' });
    return this.status();
  }

  // ------------------------------------------------------------ reads
  /** index.json: [{ slug, title, status, updated }], newest first. */
  list() {
    if (!this.ready()) return [];
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')).workstreams || []; }
    catch { return this._buildIndex(); }
  }

  exists(slug) { return SLUG_RE.test(slug || '') && fs.existsSync(path.join(this.dir, slug, 'workstream.md')); }

  /** Everything about one workstream; null when there is none. */
  get(slug) {
    if (!this.ready() || !this.exists(slug)) return null;
    const base = path.join(this.dir, slug);
    const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(base, 'workstream.md'), 'utf8'));
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')); } catch { return []; } };
    const mdDir = (d) => { try { return fs.readdirSync(path.join(base, d)).filter(f => f.endsWith('.md')).sort(); } catch { return []; } };
    const decisions = mdDir('decisions').map(f => {
      const { fields: df, body: db } = parseFrontmatter(fs.readFileSync(path.join(base, 'decisions', f), 'utf8'));
      return { n: parseInt(f, 10), file: `decisions/${f}`, ...df, body: db.trim() };
    });
    let notes = '';
    try { notes = fs.readFileSync(path.join(base, 'notes.md'), 'utf8'); } catch { /* none yet */ }
    return {
      slug, ...fields, ...bodyToSections(body), decisions, notes,
      records: mdDir('sessions').map(f => `sessions/${f}`),
      files: readJson('files.json'), links: readJson('links.json'), vault: readJson('vault.json'),
    };
  }

  // ------------------------------------------------------------ writes
  /** A new workstream. Returns { workstream, commit, redactions }. */
  create({ title, goal = '', status = 'active', pinned = [], ...sections } = {}) {
    if (!String(title || '').trim()) return Promise.reject(Object.assign(new Error('a workstream needs a title'), { code: 400 }));
    if (!STATUSES.includes(status)) return Promise.reject(Object.assign(new Error(`status is one of ${STATUSES.join(', ')}`), { code: 400 }));
    return this._write(async (w) => {
      let slug = slugify(title); const root = slug;
      for (let i = 2; fs.existsSync(path.join(this.dir, slug)) || RESERVED.includes(slug); i++) slug = `${root}-${i}`;
      const at = this.now().toISOString();
      w.file(`${slug}/workstream.md`, frontmatter({ title: String(title).trim(), goal: String(goal), status, created: at, updated: at, pinned },
        sectionsToBody(sections)));
      w.file(`${slug}/notes.md`, `# Notes\n`);
      for (const l of LISTS) w.json(`${slug}/${l}.json`, []);
      return { slug, message: `create(${slug}): ${String(title).trim()}` };
    });
  }

  /** Change fields: title, goal, status, pinned, and the body sections (summary, where, next, questions). */
  update(slug, patch = {}) {
    const allowed = ['title', 'goal', 'status', 'pinned', ...SECTIONS.map(([k]) => k)];
    const keys = Object.keys(patch).filter(k => allowed.includes(k));
    if (!keys.length) return Promise.reject(Object.assign(new Error(`nothing to change; fields: ${allowed.join(', ')}`), { code: 400 }));
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) return Promise.reject(Object.assign(new Error(`status is one of ${STATUSES.join(', ')}`), { code: 400 }));
    if (patch.pinned !== undefined && !Array.isArray(patch.pinned)) return Promise.reject(Object.assign(new Error('pinned is a list'), { code: 400 }));
    return this._write(async (w) => {
      this._need(slug);
      const file = path.join(this.dir, slug, 'workstream.md');
      const { fields, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const sections = bodyToSections(body);
      for (const k of keys) { if (SECTIONS.some(([s]) => s === k)) sections[k] = String(patch[k] ?? ''); else fields[k] = k === 'pinned' ? patch[k] : String(patch[k]); }
      fields.updated = this.now().toISOString();
      w.file(`${slug}/workstream.md`, frontmatter(fields, sectionsToBody(sections)));
      return { slug, message: `edit(${slug}): ${keys.join(', ')}` };
    });
  }

  /** Record a decision as decisions/NNNN-<slug>.md, numbered after the highest so far. Marks what it supersedes. */
  addDecision(slug, { title, body = '', status = 'active', supersedes = null, source = null } = {}) {
    if (!String(title || '').trim()) return Promise.reject(Object.assign(new Error('a decision needs a title'), { code: 400 }));
    if (!DECISION_STATUSES.includes(status)) return Promise.reject(Object.assign(new Error(`status is one of ${DECISION_STATUSES.join(', ')}`), { code: 400 }));
    return this._write(async (w) => {
      this._need(slug);
      const dir = path.join(this.dir, slug, 'decisions');
      const have = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => /^(\d{4})-/.exec(f)?.[1]).filter(Boolean).map(Number) : [];
      const n = (have.length ? Math.max(...have) : 0) + 1;
      const nnnn = String(n).padStart(4, '0');
      if (supersedes != null) {
        const old = String(supersedes).padStart(4, '0');
        const f = fs.existsSync(dir) && fs.readdirSync(dir).find(x => x.startsWith(`${old}-`));
        if (!f) throw Object.assign(new Error(`no decision ${old} to supersede`), { code: 400 });
        const { fields, body: b } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        w.file(`${slug}/decisions/${f}`, frontmatter({ ...fields, status: 'superseded', supersededBy: nnnn }, b));
      }
      w.file(`${slug}/decisions/${nnnn}-${slugify(title, 40)}.md`, frontmatter({ title: String(title).trim(), status,
        supersedes: supersedes != null ? String(supersedes).padStart(4, '0') : null, source, date: today(this.now()) }, String(body)));
      this._touch(w, slug);
      return { slug, n, message: `decision(${slug}): ${nnnn} ${String(title).trim()}` };
    });
  }

  /** A dated bullet in notes.md, with its source. */
  addNote(slug, { text, source = null } = {}) {
    if (!String(text || '').trim()) return Promise.reject(Object.assign(new Error('an empty note'), { code: 400 }));
    return this._write(async (w) => {
      this._need(slug);
      const file = path.join(this.dir, slug, 'notes.md');
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Notes\n';
      const src = fmtSource(source);
      w.file(`${slug}/notes.md`, `${prev.replace(/\s*$/, '\n')}- ${today(this.now())}: ${String(text).trim().replace(/\n+/g, ' ')}${src ? ` (${src})` : ''}\n`);
      this._touch(w, slug);
      return { slug, message: `note(${slug}): ${String(text).trim().slice(0, 60)}` };
    });
  }

  /** Replace files.json, links.json or vault.json. */
  setList(slug, kind, items) {
    if (!LISTS.includes(kind) || !Array.isArray(items)) return Promise.reject(Object.assign(new Error(`a list of ${LISTS.join(', ')}`), { code: 400 }));
    return this._write(async (w) => {
      this._need(slug);
      w.json(`${slug}/${kind}.json`, items);
      this._touch(w, slug);
      return { slug, message: `${kind}(${slug}): ${items.length} item${items.length === 1 ? '' : 's'}` };
    });
  }

  /**
   * A session's durable record (the wrap-up, #36): sessions/<date>-<title-slug>-<id8>.md.
   * A second wrap-up of the same session appends a follow-up to its record.
   */
  addSessionRecord(slug, { id, title = 'session', body = '', date } = {}) {
    if (!id) return Promise.reject(Object.assign(new Error('which session?'), { code: 400 }));
    return this._write(async (w) => {
      this._need(slug);
      const id8 = String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
      const dir = path.join(this.dir, slug, 'sessions');
      const prev = fs.existsSync(dir) && fs.readdirSync(dir).find(f => f.endsWith(`-${id8}.md`));
      const d = date || today(this.now());
      if (prev) {
        const old = fs.readFileSync(path.join(dir, prev), 'utf8');
        w.file(`${slug}/sessions/${prev}`, `${old.replace(/\s*$/, '\n')}\n## Follow-up, ${d}\n\n${String(body).trim()}\n`);
      } else {
        w.file(`${slug}/sessions/${d}-${slugify(title, 40)}-${id8}.md`, frontmatter({ session: String(id), title: String(title), date: d }, String(body)));
      }
      this._touch(w, slug);
      return { slug, message: `wrapup(${slug}): ${String(title).trim()}` };
    });
  }

  /** What the scrubber would take out of `text`, for previews. */
  preview(text) { return scrub(text, { vault: this.vault() }); }

  // --------------------------------------------------------- the sync
  /** Fetch and rebase now, then push; clears a conflict once it no longer stands. */
  resync() { return this._enqueue(async () => { await this._pull(); return this._push(); }); }

  /** Push now rather than after the debounce (tests, shutdown). */
  flush() { clearTimeout(this.pushTimer); this.pushTimer = null; return this._enqueue(() => this._push()); }

  /** On start: anything committed while offline gets pushed. */
  async resume() { await this._refresh(); if (this.ready() && this.sync.ahead > 0) this._schedulePush(0); }

  stop() { clearTimeout(this.pushTimer); this.pushTimer = null; }

  // ---------------------------------------------------------- internals
  _need(slug) { if (!this.exists(slug)) throw Object.assign(new Error(`no workstream ${slug}`), { code: 404 }); }

  _touch(w, slug) {
    const file = path.join(this.dir, slug, 'workstream.md');
    const { fields, body } = parseFrontmatter(w.read(`${slug}/workstream.md`) ?? fs.readFileSync(file, 'utf8'));
    w.file(`${slug}/workstream.md`, frontmatter({ ...fields, updated: this.now().toISOString() }, body));
  }

  _enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * One change, one commit: refuse a dirty clone, pull, let `fn` stage files,
   * scrub and write them, regenerate index.json, commit, and schedule a push.
   * All or nothing: if anything fails once files are written, the tree goes back to HEAD.
   */
  _write(fn) {
    return this._enqueue(async () => {
      if (!this.ready()) throw Object.assign(new Error('the workstreams repo is not set up'), { code: 409 });
      if (this.sync.conflict) throw Object.assign(new Error('the workstreams repo has a conflict to resolve first'), { code: 409, conflict: this.sync.conflict });
      await this._checkClean();
      await this._pull();
      const staged = new Map();
      const w = {
        file: (rel, text) => staged.set(rel, String(text)),
        json: (rel, v) => staged.set(rel, v),
        read: (rel) => { const v = staged.get(rel); return typeof v === 'string' ? v : undefined; },
      };
      const out = await fn(w);
      for (const rel of staged.keys()) {
        if (!path.join(this.dir, rel).startsWith(this.dir + path.sep)) throw new Error(`refusing to write outside the repo: ${rel}`);
      }
      const vault = this.vault();
      const redactions = [];
      let message;
      try {
        for (const [rel, v] of staged) {
          const abs = path.join(this.dir, rel);
          let text;
          if (typeof v === 'string') { const s = scrub(v, { vault }); text = s.text; redactions.push(...s.redactions.map(r => ({ ...r, file: rel }))); }
          else { const s = scrubDeep(v, vault); text = JSON.stringify(s.value, null, 2) + '\n'; redactions.push(...s.redactions.map(r => ({ ...r, file: rel }))); }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, text);
        }
        this._writeIndex();
        message = scrub(out.message, { vault }).text;
        await this._commit(message, [...staged.keys(), 'index.json']);
      } catch (e) { await this._restore(); throw e; }
      const commit = (await this.git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
      await this._refresh();
      this._schedulePush();
      this.emit('changed', { slug: out.slug, reason: message.split('(')[0] });
      return { workstream: this.get(out.slug), commit, message, redactions, ...(out.n ? { n: out.n } : {}) };
    });
  }

  async _commit(message, files) {
    const add = await this.git(['add', '-A', '--', ...files]);
    if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const r = await this.git([...await this._who(), 'commit', '-q', '--no-verify', '-m', message]);
    if (!r.ok && !/nothing to commit/.test(r.stdout + r.stderr)) throw new Error(`git commit failed: ${(r.stderr || r.stdout).trim()}`);
  }

  // index.json is derived: always regenerated from the workstream files, never merged.
  _writeIndex() {
    fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify({ workstreams: this._buildIndex() }, null, 2) + '\n');
  }

  /**
   * Hand edits or a half-finished write leave the clone dirty; rebasing over
   * that would fail and look like a conflict. Report it as what it is and wait.
   */
  async _checkClean() {
    const st = await this.git(['status', '--porcelain']);
    const files = st.stdout.split('\n').filter(Boolean).map(l => l.slice(3));
    if (!files.length) { if (this.sync.dirty) this._setSync({ dirty: null }); return; }
    const dirty = { at: this.now().toISOString(), files,
      hint: `uncommitted changes in ${this.dir}: commit or discard them by hand (git status), then sync again` };
    this._setSync({ dirty });
    throw Object.assign(new Error(`the workstreams clone has uncommitted changes: ${files.join(', ')}`), { code: 409, dirty });
  }

  /** Back to HEAD after a failed write. Safe: writes only start on a clean tree. */
  async _restore() {
    if ((await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).ok) await this.git(['reset', '-q', '--hard', 'HEAD']);
    else await this.git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
    await this.git(['clean', '-f', '-d', '-q']);
  }

  // The user's identity when git has one; otherwise a neutral one, so a fresh machine can still commit and rebase.
  async _who() {
    const named = (await this.git(['config', 'user.email'])).stdout.trim();
    return named ? [] : ['-c', 'user.name=agent-deck', '-c', 'user.email=agent-deck@localhost'];
  }

  _buildIndex() {
    const out = [];
    for (const slug of fs.readdirSync(this.dir).filter(f => SLUG_RE.test(f)).sort()) {
      const file = path.join(this.dir, slug, 'workstream.md');
      if (!fs.existsSync(file)) continue;
      const { fields } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({ slug, title: fields.title || slug, status: fields.status || 'active', updated: fields.updated || fields.created || null });
    }
    return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  async _hasRemote() { return (await this.git(['remote'])).stdout.split('\n').includes('origin'); }

  /** The remote branch to rebase onto and push to: the upstream, else origin/<current branch>. */
  async _upstream() {
    const u = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (u.ok && u.stdout.trim()) return u.stdout.trim();
    const branch = (await this.git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    const r = await this.git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]);
    return r.ok ? `origin/${branch}` : null;
  }

  async _ahead() {
    if (!(await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).ok) return 0;
    const up = await this._upstream();
    const r = await this.git(['rev-list', '--count', up ? `${up}..HEAD` : 'HEAD']);
    return parseInt(r.stdout, 10) || 0;
  }

  /**
   * `pull --rebase`, in two steps so being offline (fetch fails: carry on, push
   * later) is told apart from a conflict (rebase fails: abort it, record the
   * conflicting files and the commits involved, and refuse writes until resolved).
   */
  async _pull() {
    if (!(await this._hasRemote())) return;
    // Capped, so an offline write commits locally after a few seconds rather than a minute.
    const f = await this.git(['fetch', '-q', 'origin'], { timeout: this.fetchTimeout });
    if (!f.ok) { this._setSync({ lastError: { at: this.now().toISOString(), op: 'fetch', message: f.stderr.trim() || 'fetch timed out' } }); return; }
    if (this.sync.lastError) this._setSync({ lastError: null });
    const up = await this._upstream();
    if (!up || !(await this.git(['rev-parse', '--verify', '-q', 'HEAD'])).ok) {
      // Nothing local yet: start from what the remote has.
      if (up) await this.git(['reset', '-q', '--hard', up]);
      return this._refresh();
    }
    await this._checkClean();
    const who = await this._who();
    let r = await this.git([...who, 'rebase', '-q', up]);
    let files = [];
    // Stops git could not merge but we can: index.json (regenerated) and workstream.md (field by field).
    for (let i = 0; !r.ok && i < 100; i++) {
      files = (await this.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      if (!files.length || !(await this._resolve(files))) break;
      r = await this.git([...who, '-c', 'core.editor=true', 'rebase', '--continue']);
    }
    if (r.ok) {
      if (this.sync.conflict) this._setSync({ conflict: null });
      await this._renumber(up);
      return this._refresh();
    }
    await this.git(['rebase', '--abort']);
    const theirs = (await this.git(['log', '--oneline', `HEAD..${up}`])).stdout.trim();
    const ours = (await this.git(['log', '--oneline', `${up}..HEAD`])).stdout.trim();
    const conflict = { at: this.now().toISOString(), upstream: up, files, ours: ours.split('\n').filter(Boolean), theirs: theirs.split('\n').filter(Boolean),
      message: (r.stderr || r.stdout).trim().split('\n').slice(0, 6).join('\n'),
      hint: `resolve by hand in ${this.dir}: git pull --rebase, fix the files, git rebase --continue; then sync again` };
    this._setSync({ conflict });
    await this._refresh();
    throw Object.assign(new Error(`conflict with ${up} in ${files.join(', ') || 'the workstreams repo'}`), { code: 409, conflict });
  }

  /** Resolve a rebase stop when every conflicted file is one we know how to merge; false otherwise. */
  async _resolve(files) {
    const show = async (stage, f) => { const r = await this.git(['show', `:${stage}:${f}`]); return r.ok ? r.stdout : null; };
    const merged = new Map();
    for (const f of files) {
      if (f === 'index.json') continue;
      const kind = /^[a-z0-9][a-z0-9-]*\/(workstream|notes)\.md$/.exec(f)?.[1];
      if (!kind) return false;
      const [b, o, t] = [await show(1, f), await show(2, f), await show(3, f)];
      const text = kind === 'workstream' ? mergeWorkstream(b, o, t) : mergeNotes(b, o, t);
      if (text == null) return false;
      merged.set(f, text);
    }
    for (const [f, text] of merged) fs.writeFileSync(path.join(this.dir, f), text);
    this._writeIndex();
    const add = await this.git(['add', '--', ...files, 'index.json']);
    return add.ok;
  }

  /**
   * Two machines can each number a decision 0003. After a rebase, a decision
   * number used twice in a workstream is given up by the local, unpushed one:
   * it takes the next free number, and supersedes/supersededBy follow. One commit per workstream.
   */
  async _renumber(up) {
    const pushed = new Set((await this.git(['ls-tree', '-r', '--name-only', up])).stdout.split('\n').filter(Boolean));
    for (const slug of fs.readdirSync(this.dir).filter(f => SLUG_RE.test(f))) {
      const dir = path.join(this.dir, slug, 'decisions');
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => /^\d{4}-.*\.md$/.test(f)).sort();
      const rel = (f) => `${slug}/decisions/${f}`;
      const byN = new Map();
      for (const f of files) byN.set(f.slice(0, 4), [...(byN.get(f.slice(0, 4)) || []), f]);
      let next = Math.max(0, ...files.map(f => parseInt(f, 10))) + 1;
      const moves = []; // [oldN, newN, file]
      for (const [n, fs4] of byN) {
        if (fs4.length < 2) continue;
        for (const f of fs4.filter(x => !pushed.has(rel(x)))) moves.push([n, String(next++).padStart(4, '0'), f]);
      }
      if (!moves.length) continue;
      const local = new Set(files.filter(f => !pushed.has(rel(f))));
      const moved = new Map(moves.map(([, n, f]) => [f, n]));
      const renum = new Map(moves.map(([o, n]) => [o, n]));
      const touched = [];
      for (const f of files) {
        const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        let changed = false;
        // A local decision was written without sight of the other machine's duplicate, so its `supersedes` means the local one.
        if (local.has(f) && renum.has(fields.supersedes)) { fields.supersedes = renum.get(fields.supersedes); changed = true; }
        // supersededBy pointed at the moved decision when the pushed copy of this file didn't already say so.
        if (renum.has(fields.supersededBy)) {
          const was = pushed.has(rel(f)) ? parseFrontmatter((await this.git(['show', `${up}:${rel(f)}`])).stdout).fields.supersededBy : undefined;
          if (was !== fields.supersededBy) { fields.supersededBy = renum.get(fields.supersededBy); changed = true; }
        }
        const to = moved.has(f) ? `${moved.get(f)}${f.slice(4)}` : f;
        if (!changed && to === f) continue;
        if (to !== f) { fs.rmSync(path.join(dir, f)); touched.push(rel(f)); }
        fs.writeFileSync(path.join(dir, to), frontmatter(fields, body));
        touched.push(rel(to));
      }
      try { await this._commit(`renumber(${slug}): ${moves.map(([o, n]) => `${o} → ${n}`).join(', ')}`, touched); }
      catch (e) { await this._restore(); throw e; }
      this.emit('changed', { slug, reason: 'renumber' });
    }
  }

  _schedulePush(delay = this.pushDelay) {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this._enqueue(() => this._push()).catch(() => {}); }, delay);
    this.pushTimer.unref?.();
  }

  /** Push what's committed. Rejected (the remote moved): pull and try once more. Offline: retry later. */
  async _push() {
    if (!this.ready() || !(await this._hasRemote()) || this.sync.conflict) return this.status();
    if (await this._ahead() === 0) return this.status();
    this._setSync({ pushing: true });
    try {
      let r = await this.git(['push', '-q', '-u', 'origin', 'HEAD']);
      if (!r.ok && /rejected|non-fast-forward|fetch first/i.test(r.stderr)) { await this._pull(); r = await this.git(['push', '-q', '-u', 'origin', 'HEAD']); }
      if (r.ok) this._setSync({ lastPush: this.now().toISOString(), lastError: null });
      else { this._setSync({ lastError: { at: this.now().toISOString(), op: 'push', message: r.stderr.trim() } }); this._schedulePush(this.retryDelay); }
    } finally { this._setSync({ pushing: false }); await this._refresh(); }
    return this.status();
  }

  _setSync(patch) {
    const before = JSON.stringify(this.sync);
    Object.assign(this.sync, patch);
    // Cached figures (remote, ahead, pushing) alone are not news.
    if (JSON.stringify(this.sync) !== before && Object.keys(patch).some(k => !QUIET.has(k))) this.emit('changed', { reason: 'sync' });
  }
}

/** scrub() over every string in a JSON value, keys included. */
export function scrubDeep(value, vault = []) {
  const redactions = [];
  const walk = (v) => {
    if (typeof v === 'string') { const s = scrub(v, { vault }); redactions.push(...s.redactions); return s.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
    return v;
  };
  return { value: walk(value), redactions };
}

// One store per clone, so the routes and later features share its queue and push timer.
// Later callers get the same store; a `vault` they pass replaces the hook (the Vault, #31,
// or wrap-up, #36, wires it: storeFor(dir, { vault }) or store.setVault(fn)).
const stores = new Map();
export function storeFor(dir, opts = {}) {
  if (!stores.has(dir)) stores.set(dir, new WorkstreamStore({ dir, ...opts }));
  else if (opts.vault) stores.get(dir).setVault(opts.vault);
  return stores.get(dir);
}
