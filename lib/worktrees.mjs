// lib/worktrees.mjs — automatic git worktrees for sessions that would share a
// working tree (#32), and the cleanup plan for the ones the deck made.
//
// Two live sessions whose folders resolve (realpath, then git's top level) to
// the same worktree step on each other. A session the deck launches into one
// starts in a fresh worktree instead: branch deck/<slug>-<id4>, under
// <state dir>/worktrees/<repo>/, from a base picked among git-gathered
// candidates. A model is asked (purpose 'worktree') only when the candidates
// really differ and the prompt names no branch or PR.
//
// Removal is the user's data: planCleanup() only says what each worktree's
// state allows; act() runs one action the user clicked. Nothing here removes
// a worktree or deletes a branch on its own.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { extractJson } from './narrator.mjs';
import { defaultBranch } from './gitinfo.mjs';

export const DEFAULT_COPY = ['.env*', '.claude/settings.local.json'];
const SETUP_TIMEOUT_MS = 10 * 60_000;
const TOP_TTL_MS = 30_000;
// A worktree with no session yet counts as in use this long after it was made (a launch is starting there).
export const PENDING_MS = 10 * 60_000;
// At or above this the suggestion is preselected; below, the pilot chooses.
export const CONFIDENT = 0.6;

export function git(cwd, args, { timeout = 15_000, input = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout, maxBuffer: 16 << 20, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? '', stderr: String(stderr ?? '').trim() }));
    if (input != null) child.stdin.end(input);
  });
}
const out = (r) => r.ok ? r.stdout.trim() : null;
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** Is `p` the folder `dir` or inside it? (both real paths) */
export const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// ------------------------------------------------------------ detection
const tops = new Map();   // cwd -> { at, value }
/**
 * The worktree a folder is in: { top, common, main, linked }, all real paths,
 * so a symlinked path and a subdirectory land on the same one. Null outside git.
 */
export async function worktreeOf(cwd, { fresh = false } = {}) {
  if (!cwd) return null;
  const c = tops.get(cwd);
  if (!fresh && c && Date.now() - c.at < TOP_TTL_MS) return c.value;
  const real = realpath(cwd);
  let value = null;
  if (fs.existsSync(real)) {
    const r = await git(real, ['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']);
    const [top, common, gitDir] = r.ok ? r.stdout.split('\n') : [];
    if (top) {
      const commonDir = realpath(path.resolve(real, common));
      value = { top: realpath(top), common: commonDir, main: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir, linked: realpath(gitDir) !== commonDir };
    }
  }
  const now = Date.now();
  // Folders come and go with sessions: drop what has expired rather than keep every one ever seen.
  for (const [k, v] of tops) if (now - v.at >= TOP_TTL_MS) tops.delete(k);
  tops.set(cwd, { at: now, value });
  return value;
}

/** The live sessions (`live`: [{ id, cwd, … }]) working in the same worktree as `cwd`, `except` one. */
export async function sharing(cwd, live, { except = null, me = null } = {}) {
  me ||= await worktreeOf(cwd, { fresh: true });
  if (!me) return [];
  const others = live.filter(s => s.id !== except && s.cwd);
  const wts = await Promise.all(others.map(s => worktreeOf(s.cwd)));
  return others.filter((s, i) => wts[i]?.top === me.top);
}

/** Every live session that shares its worktree with another: id -> the others. */
export async function sharedMap(live) {
  const by = new Map();
  const wts = await Promise.all(live.map(s => worktreeOf(s.cwd)));
  live.forEach((s, i) => { const top = wts[i]?.top; if (top) by.set(top, [...(by.get(top) || []), s]); });
  const map = {};
  for (const group of by.values()) {
    if (group.length < 2) continue;
    for (const s of group) map[s.id] = group.filter(o => o !== s).map(({ id, title, deck, startedAt }) => ({ id, title: title || null, deck: !!deck, startedAt: startedAt || null }));
  }
  return map;
}

// ------------------------------------------------------------ candidates
/** The default branch as the header has it (lib/gitinfo.mjs), so cards, cleanup and header agree. */
const defaultOf = (dir, main) => defaultBranch(dir, { main, linked: realpath(dir) !== realpath(main) });

async function counts(dir, a, b) {
  const r = out(await git(dir, ['rev-list', '--left-right', '--count', `${a}...${b}`]));
  if (!r) return { ahead: null, behind: null };
  const [ahead, behind] = r.split(/\s+/).map(Number);
  return { ahead, behind };
}

/**
 * What a new worktree could start from, gathered with git alone: the occupied
 * worktree's HEAD, the default branch, a few recent branches (with their PR,
 * if `prOf(branch)` knows one) and, when there are uncommitted changes, the
 * working copy as it is. `collapsed` when they all come to the same base.
 */
export async function candidates(wt, { prOf = null, recent = 3 } = {}) {
  const dir = wt.top;
  const [head, sha, status, branches] = await Promise.all([
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['rev-parse', '--short', 'HEAD']),
    git(dir, ['status', '--porcelain', '--untracked-files=normal']),
    git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
  ]);
  const def = await defaultOf(dir, wt.main);
  const branch = out(head), short = out(sha);
  const dirty = status.ok ? status.stdout.split('\n').filter(Boolean).length : 0;
  const vs = def ? await counts(dir, 'HEAD', def.ref) : { ahead: null, behind: null };
  const occupied = { branch, sha: short, dirty, ahead: vs.ahead, behind: vs.behind, defaultBranch: def?.branch || null };
  const all = branches.ok ? branches.stdout.split('\n').filter(Boolean) : [];
  const list = [];
  const collapsed = !!def && branch === def.branch && !vs.ahead && !dirty;
  // On the default branch with nothing ahead or uncommitted, "continue" and "fresh" are the same base.
  if (!collapsed && (branch || short)) list.push({ id: 'head', kind: 'head', ref: branch || short, branch, ahead: vs.ahead, behind: vs.behind, dirty, label: `Continue from ${branch || short}` });
  if (def) {
    let fetchedAt = null;
    try { fetchedAt = fs.statSync(path.join(wt.common, 'FETCH_HEAD')).mtimeMs; } catch { /* never fetched */ }
    list.push({ id: 'default', kind: 'default', ref: def.ref, branch: def.branch, remote: def.remote, fetchedAt, label: `Fresh from ${def.branch}` });
  }
  const others = all.filter(b => b !== branch && b !== def?.branch && !b.startsWith('deck/')).slice(0, recent);
  list.push(...await Promise.all(others.map(async (b) => {
    const [c, pr] = await Promise.all([def ? counts(dir, b, def.ref) : {}, prOf ? Promise.resolve(prOf(b, dir)).catch(() => null) : null]);
    return { id: `branch:${b}`, kind: 'branch', ref: b, branch: b, ahead: c.ahead ?? null, pr: pr || null, label: `Resume ${b}` };
  })));
  if (dirty) list.push({ id: 'fork', kind: 'fork', ref: branch || short, branch, dirty, label: 'Fork the working copy as it is now' });
  const checked = await checkedOut(dir);
  markResumable(list, checked);
  return { occupied, list, collapsed, branches: all, defaultBranch: def?.branch || null, checked };
}

/** Branch -> the worktree that has it checked out (git allows one at a time). */
export async function checkedOut(dir) {
  const r = await git(dir, ['worktree', 'list', '--porcelain']);
  const map = new Map();
  let at = null;
  for (const l of r.ok ? r.stdout.split('\n') : []) {
    if (l.startsWith('worktree ')) at = l.slice(9);
    else if (l.startsWith('branch refs/heads/')) map.set(l.slice(18), at);
  }
  return map;
}
/**
 * A resume card may continue on the branch itself (check it out in the new
 * worktree) when no worktree has it, or start a new deck branch from it.
 */
export function markResumable(list, checked) {
  for (const c of list) if (c.kind === 'branch') c.checkedOutAt = checked.get(c.branch) || null;
  return list;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A branch or PR the prompt names outright, as a candidate id: `#41` or
 * "PR 41" for a candidate's PR, a branch name that cannot be an ordinary word
 * (it has - / _ or a digit, or is in backticks). A named branch the list does
 * not have yet is added to it. Null when the prompt names none.
 */
export function namedRef(prompt, list, branches = []) {
  const text = String(prompt || '');
  for (const m of text.matchAll(/(?:#|\bPR\s*#?|\bpull\/)(\d+)\b/gi)) {
    const c = list.find(x => x.pr?.number === Number(m[1]));
    if (c) return { id: c.id, name: `PR #${m[1]}` };
  }
  const names = [...new Set([...list.map(c => c.branch).filter(Boolean), ...branches])].sort((a, b) => b.length - a.length);
  for (const b of names) {
    const plain = /[-/_\d]/.test(b);
    const re = plain ? new RegExp(`(^|[\\s\`'"(])${esc(b)}($|[\\s\`'".,:;)!?])`) : new RegExp(`\`${esc(b)}\``);
    if (!re.test(text)) continue;
    const c = list.find(x => x.kind !== 'fork' && x.branch === b);
    if (c) return { id: c.id, name: b };
    list.push({ id: `branch:${b}`, kind: 'branch', ref: b, branch: b, ahead: null, pr: null, label: `Resume ${b}` });
    return { id: `branch:${b}`, name: b };
  }
  return null;
}

/** One line of facts for a candidate, as the model and the cards read it. */
export function facts(c, def) {
  const f = [];
  if (c.kind === 'head' || c.kind === 'branch') {
    if (c.ahead != null && def) f.push(`${c.ahead} ahead of ${def}`);
    if (c.behind) f.push(`${c.behind} behind`);
  }
  if (c.kind === 'head' && c.dirty) f.push(`${c.dirty} files uncommitted (not carried)`);
  if (c.kind === 'fork') f.push(`carries ${c.dirty} uncommitted files`);
  if (c.kind === 'default') f.push(c.remote ? (c.fetchedAt ? `fetched ${Math.round((Date.now() - c.fetchedAt) / 60_000)} min ago, fetched again on start` : 'fetched on start') : 'local, no remote');
  if (c.pr) f.push(`PR #${c.pr.number}${c.pr.state && c.pr.state !== 'open' ? ` ${c.pr.state}` : ''}${c.pr.checks?.state === 'failure' ? ', CI red' : c.pr.checks?.state === 'success' ? ', CI green' : ''}`);
  return f.join(' · ');
}

const SYSTEM = 'You pick where a new coding-agent session starts: the base of its own git worktree, because another session is already working in the same folder. '
  + 'Continue (occupied HEAD) when the task builds on, reviews or tests the work in progress; fresh from the default branch for an unrelated task; '
  + 'an existing branch when the task resumes it or fixes its PR; fork the working copy only when the task wants to try something on top of exactly what is on disk. '
  + 'Answer with JSON only: {"pick": "<candidate id>", "confidence": <0 to 1>, "reason": "<one short sentence>"}';
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * One small model call that picks a candidate. Resolves { pick, confidence,
 * reason, preselect } (preselect only at CONFIDENT or above), or { error }
 * when the call fails or answers with something that is not a candidate.
 */
export async function suggest({ narrator, prompt, list, occupied, others = [], next = null }) {
  const lines = [
    `The new session's task:\n${clip(prompt, 1600)}`,
    others.length ? `Already working in that folder: ${others.map(o => `"${clip(o.title || o.id, 80)}"${o.brief ? ` (${clip(o.brief, 300)})` : ''}`).join('; ')}` : null,
    next ? `The workstream's next step: ${clip(next, 200)}` : null,
    `Candidates:\n${list.map(c => `- ${c.id}: ${c.label}${facts(c, occupied.defaultBranch) ? ` · ${facts(c, occupied.defaultBranch)}` : ''}`).join('\n')}`,
  ].filter(Boolean);
  try {
    const r = await narrator.run({ system: SYSTEM, prompt: lines.join('\n\n'), thinking: false, purpose: 'worktree' });
    const j = extractJson(r.text);
    if (!j || !list.some(c => c.id === j.pick)) return { error: 'the model did not pick a candidate' };
    const word = { high: 0.9, medium: 0.6, low: 0.3 }[String(j.confidence).toLowerCase()];
    const confidence = Math.max(0, Math.min(1, Number.isFinite(Number(j.confidence)) ? Number(j.confidence) : word ?? 0));
    return { pick: j.pick, confidence, reason: clip(j.reason, 200) || null, preselect: confidence >= CONFIDENT, via: 'model' };
  } catch (e) { return { error: e.message }; }
}

// ------------------------------------------------------------ making one
const KINDS = new Set(['head', 'default', 'branch', 'fork']);
/**
 * The card a dialog chose, made safe to use: a known kind, and for a branch
 * or the default branch a ref git resolves (one call). Null when it is not.
 */
export async function checkCand(wt, c) {
  if (!c || typeof c !== 'object' || !KINDS.has(c.kind)) return null;
  const id = c.kind === 'branch' ? `branch:${c.ref}` : c.kind;
  if (c.kind === 'head' || c.kind === 'fork') {
    // These start at the occupied worktree's HEAD as it is now; only its branch name is kept, for the record.
    const b = out(await git(wt.top, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
    return { id, kind: c.kind, ref: b || 'HEAD', branch: b };
  }
  const ref = String(c.ref || '');
  if (!ref || ref.startsWith('-') || /\s|\.\./.test(ref)) return null;
  const branch = c.kind === 'branch' ? ref : String(c.branch || '');
  if (c.kind === 'default' && ref !== branch && ref !== `origin/${branch}`) return null;
  if (!(await git(wt.top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) return null;
  const mode = c.kind === 'branch' && c.mode === 'continue' ? 'continue' : 'new';
  if (mode === 'continue' && (!(await git(wt.top, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`])).ok || (await checkedOut(wt.top)).has(ref))) return null;
  return { id, kind: c.kind, ref, branch, remote: ref.startsWith('origin/'), mode };
}
/** deck/<title-slug>-<id4>, retried until neither the branch nor its folder exists. */
export async function branchName(title, { top, root, rand = () => randomBytes(2).toString('hex') } = {}) {
  const slug = String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40).replace(/-+$/, '') || 'session';
  for (let i = 0; i < 30; i++) {
    const b = `deck/${slug}-${rand()}`;
    const taken = (await git(top, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).ok || (root && fs.existsSync(path.join(root, b)));
    if (!taken) return b;
  }
  throw new Error('no free branch name');
}

/** Copy untracked files matching `patterns` (a * matches within one name) from `from` into `to`, never over a file there. */
export function copyUntracked(from, to, patterns = DEFAULT_COPY, tracked = new Set()) {
  const copied = [];
  for (const p of patterns) {
    const rel = String(p || '').replace(/^\/+/, '');
    if (!rel || rel.split('/').includes('..')) continue;
    const dir = path.dirname(rel), name = path.basename(rel);
    let names = [name];
    if (name.includes('*')) {
      const re = new RegExp(`^${name.split('*').map(esc).join('.*')}$`);
      try { names = fs.readdirSync(path.join(from, dir)).filter(n => re.test(n)); } catch { names = []; }
    }
    for (const n of names) {
      const r = path.join(dir === '.' ? '' : dir, n);
      const src = path.join(from, r), dst = path.join(to, r);
      try {
        if (tracked.has(r) || !fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(r);
      } catch { /* gone, or unreadable: skip it */ }
    }
  }
  return copied;
}

/**
 * Make the worktree: fetch the default branch first when it has a remote,
 * add the worktree on a new branch from the candidate's base, record that
 * base in the branch's config (gitinfo's place() shows it), carry the working
 * copy for a fork, and copy the configured untracked files. Returns the record.
 */
export async function create({ wt, cand, title, stateDir, copy = DEFAULT_COPY, rand, suggestion = null, sub = '' }) {
  const top = wt.top;
  if (cand.kind === 'default' && cand.remote) await git(top, ['fetch', '--quiet', 'origin', cand.branch], { timeout: 30_000 });
  const root = path.join(stateDir, 'worktrees', path.basename(wt.main));
  // "Continue on <branch>" checks the pilot's own branch out; anything else is a new deck branch.
  const own = !(cand.kind === 'branch' && cand.mode === 'continue');
  const id4 = rand || (() => randomBytes(2).toString('hex'));
  let branch, dir;
  if (own) { branch = await branchName(title, { top, root, rand }); dir = path.join(root, branch); }
  else {
    branch = cand.branch;
    dir = path.join(root, branch);
    for (let i = 0; fs.existsSync(dir) && i < 30; i++) dir = path.join(root, `${branch}-${id4()}`);
  }
  const start = cand.kind === 'head' || cand.kind === 'fork' ? out(await git(top, ['rev-parse', 'HEAD'])) : cand.ref;
  if (!start) throw new Error(`no commit to start from in ${top}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = await git(top, own ? ['worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, start] : ['worktree', 'add', '--quiet', dir, branch]);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.stderr || add.code}`);
  const baseBranch = own ? (cand.kind === 'default' ? cand.branch : cand.branch || null) : null;
  // Only a branch the deck made gets the deck's note of where it started.
  if (own && baseBranch) await git(dir, ['config', `branch.${branch}.deckbase`, baseBranch]);
  const sha = out(await git(dir, ['rev-parse', 'HEAD']));
  // The launch folder keeps its place: a session started in <repo>/web starts in <worktree>/web.
  const rel = sub && !sub.startsWith('..') && !path.isAbsolute(sub) ? sub : '';
  const rec = { path: dir, cwd: rel ? path.join(dir, rel) : dir, sub: rel || null, repo: wt.main, from: top, branch, ownBranch: own, mode: cand.kind === 'branch' ? (own ? 'new' : 'continue') : null,
    base: { kind: cand.kind, ref: cand.ref, branch: own ? baseBranch : cand.branch, sha }, sessionId: null, created: Date.now(), suggestion, copied: [], carried: null, setup: null };
  if (cand.kind === 'fork') {
    // A fork that cannot carry the working copy is not what was asked for: undo it and say why.
    try { rec.carried = await carry(top, dir); }
    catch (e) { await discard(rec); throw Object.assign(new Error(e.message), { carryError: e.message }); }
  }
  const tracked = new Set((out(await git(top, ['ls-files'])) || '').split('\n').filter(Boolean));
  rec.copied = copyUntracked(top, dir, copy, tracked);
  // An untracked or empty folder has no copy in the worktree yet.
  if (rel) fs.mkdirSync(rec.cwd, { recursive: true });
  return rec;
}

/** The working copy's changes, as a patch (tracked) and copies (untracked, not ignored). */
async function carry(from, to) {
  const diff = await git(from, ['diff', 'HEAD', '--binary']);
  // A diff that failed is not "no changes".
  if (!diff.ok) throw new Error(`could not read the uncommitted changes: ${diff.stderr || `git diff exited with ${diff.code}`}`);
  if (diff.stdout.trim()) {
    const apply = await git(to, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: diff.stdout });
    if (!apply.ok) throw new Error(`could not carry the uncommitted changes: ${apply.stderr}`);
  }
  const ls = await git(from, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!ls.ok) throw new Error(`could not list the untracked files: ${ls.stderr}`);
  // NUL-separated exactly: a name may start or end with a space.
  const others = ls.stdout.split('\0').filter(Boolean);
  const skipped = [];
  let copied = 0;
  for (const r of others) {
    const src = path.join(from, r), dst = path.join(to, r);
    try {
      const st = fs.lstatSync(src);
      // A nested repo or anything that is not a file or a link is named, not carried.
      if (!st.isFile() && !st.isSymbolicLink()) { skipped.push(r); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst); else fs.copyFileSync(src, dst);
      copied++;
    } catch { skipped.push(r); }
  }
  return { tracked: !!diff.stdout.trim(), untracked: copied, skipped };
}

/** Undo a create() whose launch failed: it is the deck's own and nothing ran in it yet. */
export async function discard(rec) {
  await git(rec.from || rec.repo, ['worktree', 'remove', '--force', rec.path]);
  // A branch the deck did not make is never deleted.
  if (rec.ownBranch !== false) await git(rec.repo, ['branch', '-D', rec.branch]);
  await git(rec.repo, ['worktree', 'prune']);
}

/**
 * Run the repo's setup command (e.g. `npm ci`) in the new worktree. Never
 * throws: resolves { ok, code, error, tail, ms }, so a failure leaves the
 * session as it is and only reports.
 */
export function runSetup(dir, cmd, { timeout = SETUP_TIMEOUT_MS } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let tail = '', done = false, timer = null;   // declared first: a spawn that throws at once still finishes
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ cmd, ms: Date.now() - started, tail: tail.slice(-2000), ...r }); };
    let child;
    // Its own process group, so a timeout ends what it started too (npm and its children).
    try { child = spawn('sh', ['-c', cmd], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true }); }
    catch (e) { return finish({ ok: false, code: null, error: e.message }); }
    const keep = (d) => { tail = (tail + d).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } finish({ ok: false, code: null, error: `timed out after ${Math.round(timeout / 1000)}s` }); }, timeout);
    child.on('error', (e) => finish({ ok: false, code: null, error: e.message }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, code, error: null } : { ok: false, code, error: `exited with ${code}` }));
  });
}

// ------------------------------------------------------------ cleanup
/**
 * Where a deck-made worktree stands, from git: { exists, dirty, commits (made
 * since it started), unmerged (in neither its base nor the default branch),
 * merged, remote }.
 */
export async function inspect(rec, { def: given } = {}) {
  const exists = fs.existsSync(rec.path) && (await git(rec.path, ['rev-parse', '--is-inside-work-tree'])).ok;
  const repo = rec.repo;
  const has = async (ref) => !!ref && (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
  const branchOk = await has(`refs/heads/${rec.branch}`);
  if (!exists) return { exists: false, branch: branchOk };
  const status = await git(rec.path, ['status', '--porcelain', '--untracked-files=normal']);
  const dirty = status.ok ? status.stdout.split('\n').filter(Boolean).length : 0;
  const def = given !== undefined ? await given : await defaultOf(repo, repo);
  const targets = [];
  for (const r of [rec.base?.branch, def?.ref]) if (r && await has(r) && !targets.includes(r)) targets.push(r);
  const tip = branchOk ? `refs/heads/${rec.branch}` : 'HEAD';
  const remote = (await git(repo, ['remote', 'get-url', 'origin'])).ok;
  const num = (r) => { const t = out(r); return t != null && /^\d+$/.test(t) ? Number(t) : null; };
  const startOk = await has(rec.base?.sha);
  const commits = startOk ? num(await git(rec.path, ['rev-list', '--count', `${rec.base.sha}..${tip}`])) : null;
  // Without a base to measure against, nothing can be called merged: say so rather than guess 0.
  if (!targets.length || commits == null) return { exists: true, branch: branchOk, dirty, commits, unmerged: null, merged: false, baseKnown: false, remote };
  const unmerged = num(await git(rec.path, ['rev-list', '--count', tip, ...targets.map(t => `^${t}`)]));
  if (unmerged == null) return { exists: true, branch: branchOk, dirty, commits, unmerged: null, merged: false, baseKnown: false, remote };
  return { exists: true, branch: branchOk, dirty, commits, unmerged, merged: unmerged === 0 && !!commits, baseKnown: true, remote };
}

/**
 * The cleanup decision table: what a worktree in this state may do, and
 * which choice (if any) needs no second thought. Pure, so wrap-up and the
 * Worktrees dialog read the same rules. `safe` choices still run only on a click.
 *   gone              → forget the record
 *   its session runs  → in use: nothing to choose
 *   the pilot's branch → remove (the branch stays) · keep; uncommitted → keep · stash & remove · remove anyway
 *   base not found    → keep · stash & remove · remove anyway (ask, warned; the branch is kept: only `git branch -d`)
 *   uncommitted       → keep · stash & remove · remove anyway (ask)
 *   unmerged commits  → push branch & remove · keep · remove anyway (ask, with the count)
 *   merged            → remove (and delete the merged branch) · keep
 *   no commits, clean → remove (and delete the empty branch) · keep
 */
export function decide(f, { alive = false, keepsBranch = false } = {}) {
  if (!f.exists) return { state: 'gone', choices: ['forget'], safe: 'forget', ask: false };
  if (alive) return { state: 'in-use', choices: [], safe: null, ask: false };
  // The pilot's own branch ("Continue on"): removing a clean worktree loses nothing, since the branch stays.
  if (keepsBranch && !f.dirty) return { state: 'clean', choices: ['remove', 'keep'], safe: 'remove', ask: false, keepsBranch: true };
  if (keepsBranch) return { state: 'dirty', choices: ['keep', 'stash', 'remove-anyway'], safe: null, ask: true, dirty: f.dirty, unmerged: 0, keepsBranch: true };
  if (f.baseKnown === false) return { state: 'unknown', choices: ['keep', ...(f.dirty ? ['stash'] : []), 'remove-anyway'], safe: null, ask: true, dirty: f.dirty || 0, unmerged: null,
    warning: 'Its base branch cannot be found, so whether its commits are merged is unknown. Removing keeps the branch unless git sees it merged.' };
  if (f.dirty) return { state: 'dirty', choices: ['keep', 'stash', 'remove-anyway'], safe: null, ask: true, dirty: f.dirty, unmerged: f.unmerged || 0 };
  if (f.unmerged) return { state: 'unmerged', choices: [...(f.remote ? ['push-remove'] : []), 'keep', 'remove-anyway'], safe: null, ask: true, unmerged: f.unmerged };
  if (f.merged) return { state: 'merged', choices: ['remove', 'keep'], safe: 'remove', ask: false, deleteBranch: true };
  return { state: 'empty', choices: ['remove', 'keep'], safe: 'remove', ask: false, deleteBranch: true };
}

/**
 * Run one cleanup action the user chose for one worktree. `remove` is
 * refused unless the worktree is still clean and merged (or empty) now;
 * `push-remove` pushes to origin and removes only once the remote has the
 * branch's tip. Returns { done, removed, branchDeleted, stash?, pushed? }.
 */
export async function act(rec, action, { facts: f = null, alive = false } = {}) {
  if (alive) throw Object.assign(new Error('a session is starting or running in it; end it first'), { status: 409 });
  f ||= await inspect(rec);
  const keepsBranch = rec.ownBranch === false;
  const d = decide(f, { alive, keepsBranch });
  if (!d.choices.includes(action)) throw Object.assign(new Error(`“${action}” is not a choice for this worktree now (${d.state})`), { status: 409 });
  const repo = rec.repo;
  const remove = async (force) => {
    const r = await git(repo, ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), rec.path]);
    if (!r.ok) throw Object.assign(new Error(`git worktree remove failed: ${r.stderr}`), { status: 409 });
    await git(repo, ['worktree', 'prune']);
  };
  // -D only when the facts say merged, empty, or the user chose to lose it; with no known base,
  // -d, which git refuses for anything unmerged.
  // Never a branch the deck did not make ("Continue on <branch>").
  const dropBranch = async () => !keepsBranch && f.branch && (await git(repo, ['branch', f.baseKnown ? '-D' : '-d', rec.branch])).ok;
  switch (action) {
    case 'keep': return { done: 'keep', removed: false };
    case 'forget': await git(repo, ['worktree', 'prune']); return { done: 'forget', removed: true, branchDeleted: false };
    case 'remove': await remove(false); return { done: 'remove', removed: true, branchDeleted: await dropBranch() };
    case 'remove-anyway': await remove(true); return { done: 'remove-anyway', removed: true, branchDeleted: await dropBranch() };
    case 'stash': {
      const s = await git(rec.path, ['stash', 'push', '--include-untracked', '-m', `agent-deck: ${rec.branch} before its worktree was removed`]);
      if (!s.ok) throw Object.assign(new Error(`git stash failed: ${s.stderr}`), { status: 409 });
      const ref = out(await git(repo, ['rev-parse', '--short', 'refs/stash']));
      await remove(false);
      // The branch goes only when nothing on it is unmerged; the stash keeps the changes either way.
      return { done: 'stash', removed: true, stash: ref, branchDeleted: f.unmerged === 0 ? await dropBranch() : false };
    }
    case 'push-remove': {
      const p = await git(rec.path, ['push', '--quiet', '-u', 'origin', `refs/heads/${rec.branch}:refs/heads/${rec.branch}`], { timeout: 60_000 });
      if (!p.ok) throw Object.assign(new Error(`git push failed: ${p.stderr}`), { status: 502 });
      const [mine, theirs] = await Promise.all([git(repo, ['rev-parse', `refs/heads/${rec.branch}`]), git(repo, ['rev-parse', `refs/remotes/origin/${rec.branch}`])]);
      if (!mine.ok || out(mine) !== out(theirs)) throw Object.assign(new Error('the remote does not have the branch’s tip; nothing removed'), { status: 409 });
      await remove(false);
      return { done: 'push-remove', removed: true, pushed: `origin/${rec.branch}`, branchDeleted: await dropBranch() };
    }
  }
  throw new Error(`unknown action: ${action}`);
}

// ------------------------------------------------------------ the service
/**
 * The deck's worktrees: records in deck.ns('worktrees') ({ list, repos }),
 * planning a launch, and the cleanup plan. `live()` lists live sessions as
 * [{ id, cwd, title, deck, startedAt }]; `known(id)` says whether the deck
 * still has a session; `wrapped(id)` (wrap-up, #36) whether it was wrapped up.
 */
export class Worktrees {
  // `modelCalls()`: false when the deck runs with model calls off (--no-narrator); then nothing is asked.
  constructor({ state, stateDir, narrator = null, modelCalls = () => true, live = () => [], running = () => false, known = () => false, wrapped = () => false, vaultDir = () => null, prOf = null, brief = () => null }) {
    Object.assign(this, { state, stateDir, narrator, modelCalls, live, running, known, wrapped, vaultDir, prOf, brief });
  }
  /** Is a live session working in this worktree: its own, or any other whose folder is inside it? */
  inUse(rec, live = this.live(), now = Date.now()) {
    // A launch that just made it has an agent starting there before any registry knows the session.
    // Bounded, so a deck that died mid-launch does not pin a worktree forever.
    if (!rec.sessionId && now - (rec.pending || rec.created || 0) < PENDING_MS) return true;
    // A deck-run session may not be in the registry yet (a streamed one before its agent names it).
    if (rec.sessionId && this.running(rec.sessionId)) return true;
    const dir = realpath(rec.path);
    return live.some(s => (rec.sessionId && s.id === rec.sessionId) || (s.cwd && inside(realpath(s.cwd), dir)));
  }

  records() { return this.state.get('list', []); }
  _save(list) { this.state.set('list', list.length ? list : undefined); }
  record(p) { return this.records().find(r => r.path === p) || null; }
  put(rec) { this._save([...this.records().filter(r => r.path !== rec.path), rec]); return rec; }
  update(p, patch) { const r = this.record(p); return r ? this.put({ ...r, ...patch }) : null; }
  forget(p) { this._save(this.records().filter(r => r.path !== p)); }

  /** Per-repo setup: { setup: 'npm ci', copy: [...] } keyed by the main checkout. */
  repoConfig(repo) { const c = this.state.get('repos', {})[repo] || {}; return { setup: c.setup || '', copy: Array.isArray(c.copy) ? c.copy : DEFAULT_COPY }; }
  setRepoConfig(repo, { setup, copy }) {
    const all = this.state.get('repos', {});
    const next = { setup: String(setup || '').trim() || undefined, copy: Array.isArray(copy) ? copy.map(String).map(s => s.trim()).filter(Boolean) : undefined };
    if (!next.setup && !next.copy) delete all[repo]; else all[repo] = next;
    this.state.set('repos', Object.keys(all).length ? all : undefined);
    return this.repoConfig(repo);
  }

  /**
   * A launch into `cwd`: does it share a worktree with a live session, and if
   * so, the candidates and (when it matters and `ask`) the model's pick.
   * Folders in the Vault are left alone.
   */
  async plan({ cwd, prompt = '', ask = false, except = null, next = null }) {
    const wt = await worktreeOf(cwd, { fresh: true });
    if (!wt) return { conflict: false };
    const vault = this.vaultDir();
    if (vault && inside(wt.top, realpath(vault))) return { conflict: false, skipped: 'vault' };
    const others = await sharing(cwd, this.live(), { except, me: wt });
    if (!others.length) return { conflict: false, top: wt.top };
    const c = await candidates(wt, { prOf: this.prOf });
    const named = c.collapsed ? null : namedRef(prompt, c.list, c.branches);
    markResumable(c.list, c.checked);   // a branch the prompt named joins the list

    let suggestion = null;
    if (c.collapsed) suggestion = { pick: 'default', confidence: 1, reason: `Nothing ahead of ${c.defaultBranch} and nothing uncommitted: every base is the same.`, preselect: true, via: 'collapsed' };
    else if (named) suggestion = { pick: named.id, confidence: 1, reason: `The prompt names ${named.name}.`, preselect: true, via: 'named' };
    else if (ask && this.narrator && this.modelCalls() && String(prompt).trim()) {
      suggestion = await suggest({ narrator: this.narrator, prompt, list: c.list, occupied: c.occupied, next,
        others: others.map(o => ({ id: o.id, title: o.title, brief: this.brief(o.id) })) });
    }
    return {
      conflict: true, top: wt.top, repo: wt.main, occupied: c.occupied,
      with: others.map(({ id, title, deck, startedAt }) => ({ id, title: title || null, deck: !!deck, startedAt: startedAt || null })),
      candidates: c.list.map(x => ({ ...x, facts: facts(x, c.defaultBranch) })), suggestion,
    };
  }

  /**
   * Make the worktree for a chosen base and record it. `cand` is the card the
   * dialog chose ({ id, kind, ref, branch }), checked here with one git call
   * rather than gathering every candidate again; without it, `base` (an id)
   * is looked up among freshly gathered candidates.
   */
  async start({ cwd, base, cand = null, title, suggestion = null, prompt = '', rand }) {
    const wt = await worktreeOf(cwd, { fresh: true });
    if (!wt) throw new Error(`not a git repo: ${cwd}`);
    // A card that does not check out is refused, never swapped for another base.
    let pick = cand ? await checkCand(wt, cand) : null;
    if (!cand) {
      const c = await candidates(wt, { prOf: null });
      namedRef(prompt, c.list, c.branches);
      pick = c.list.find(x => x.id === base);
      // "Continue" folds into "fresh" when they collapse; a branch may be any local one.
      if (!pick && base === 'head' && c.collapsed) pick = c.list.find(x => x.id === 'default');
      if (!pick && String(base).startsWith('branch:') && c.branches.includes(base.slice(7))) pick = { id: base, kind: 'branch', ref: base.slice(7), branch: base.slice(7) };
    }
    if (!pick) throw new Error(`unknown base for the new worktree: ${cand?.id || base}`);
    const sub = path.relative(wt.top, realpath(cwd));
    const rec = await create({ wt, cand: pick, title, stateDir: this.stateDir, copy: this.repoConfig(wt.main).copy, rand, suggestion, sub });
    // Pending until its session is known (the launch's `after`): an agent is about to work in it.
    return this.put({ ...rec, pending: Date.now() });
  }

  /** Run the repo's setup command for a record, keeping its outcome on the record. */
  async setup(p) {
    const rec = this.record(p);
    const cmd = rec && this.repoConfig(rec.repo).setup;
    if (!cmd) return null;
    this.update(p, { setup: { cmd, state: 'running', at: Date.now() } });
    const r = await runSetup(p, cmd);
    this.update(p, { setup: { cmd, state: r.ok ? 'done' : 'failed', at: Date.now(), ms: r.ms, code: r.code, error: r.error, tail: r.ok ? null : r.tail } });
    return r;
  }

  /**
   * The cleanup plan, for the Worktrees dialog and for wrap-up (#36): each
   * record (or only `sessionId`'s) with its git facts, the decision table's
   * choices, and whether it is an orphan (no live session, and its session is
   * gone or wrapped up). Plans only; act() runs what the user picks.
   */
  async planCleanup({ sessionId = null } = {}) {
    const live = this.live();
    const recs = this.records().filter(r => !sessionId || r.sessionId === sessionId);
    // The default branch once per repo, not once per worktree.
    const defs = new Map();
    for (const r of recs) if (!defs.has(r.repo)) defs.set(r.repo, defaultOf(r.repo, r.repo).catch(() => null));
    return Promise.all(recs.map(async (rec) => {
      const f = await inspect(rec, { def: defs.get(rec.repo) });
      const alive = this.inUse(rec, live);
      const orphan = !alive && (!rec.sessionId || !this.known(rec.sessionId) || !!this.wrapped(rec.sessionId));
      return { record: rec, facts: f, decision: decide(f, { alive, keepsBranch: rec.ownBranch === false }), alive, orphan };
    }));
  }

  /** One action on one worktree, chosen by the user. Refused while its session runs. Drops the record once it is gone. */
  async act(p, action) {
    const rec = this.record(p);
    if (!rec) throw Object.assign(new Error('not a worktree the deck made'), { status: 404 });
    const r = await act(rec, action, { alive: this.inUse(rec) });
    if (r.removed) this.forget(p);
    else if (action === 'keep') this.update(p, { kept: Date.now() });
    return r;
  }

  /** `git worktree prune` in each repo the deck made worktrees in: drops git's records of folders already gone. */
  async prune() {
    const repos = [...new Set(this.records().map(r => r.repo))];
    for (const r of repos) await git(r, ['worktree', 'prune']);
    return repos.length;
  }
}

const services = new WeakMap();
/**
 * The deck's one Worktrees service, built from a route module's ctx (server.mjs
 * hands every lib/routes/*.mjs the same one). Wrap-up (#36) calls
 * worktreesFor(ctx).planCleanup({ sessionId }) for the choices to show.
 */
export function worktreesFor(ctx, extra = {}) {
  if (services.has(ctx.deck)) return services.get(ctx.deck);
  const { deck, index, agents, narrator, briefs } = ctx;
  const svc = new Worktrees({
    state: deck.ns('worktrees'), stateDir: deck.dir, narrator, modelCalls: () => ctx.narratorEnabled !== false,
    live: () => {
      index?.refreshRegistry?.(true);
      return [...(index?.registry?.values() || [])].filter(r => r.alive && r.cwd)
        .map(r => ({ id: r.sessionId, cwd: r.cwd, startedAt: r.startedAt || null, deck: !!agents?.running(r.sessionId), title: index.summary(r.sessionId)?.title || null }));
    },
    running: (id) => !!agents?.running?.(id),
    known: (id) => !!index?.files?.has(id),
    brief: (id) => briefs?.publicBrief(id)?.brief?.summary || null,
    ...extra,
  });
  services.set(ctx.deck, svc);
  return svc;
}
