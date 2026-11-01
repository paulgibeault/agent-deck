// Automatic worktrees (lib/worktrees.mjs, lib/routes/worktrees.mjs): detection,
// when the model is asked, branch names, the cleanup decision table and its
// actions, setup failures, and the launch hook. Temp repos only; the model is
// a fake narrator, and "push" goes to a local bare repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  worktreeOf, sharing, sharedMap, candidates, namedRef, branchName, decide, inspect, act, runSetup, copyUntracked, Worktrees, CONFIDENT,
} from '../lib/worktrees.mjs';
import { launchFields, chosenOf, resumeMode, latest } from '../public/wtpick.js';
import { discard, PENDING_MS } from '../lib/worktrees.mjs';
import { place } from '../lib/gitinfo.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { beforeLaunch, failedLaunch, afterLaunch, onLaunch } from '../lib/launch.mjs';
import { DeckState } from '../lib/deckstate.mjs';

// Hermetic git: no user or system config, a fixed identity.
const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gitcfg-'));
fs.writeFileSync(path.join(gitHome, 'config'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(gitHome, 'config'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes');

/** A repo on main with one commit; opts add a feature branch ahead, uncommitted work, other branches. */
function repo({ feature = false, dirty = false, branches = [] } = {}) {
  const dir = path.join(tmp('wt-repo-'), 'app');
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  for (const b of branches) { git(dir, 'branch', b); }
  if (feature) {
    git(dir, 'switch', '-qc', 'feature-x');
    for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`); git(dir, 'add', '.'); git(dir, 'commit', '-qm', `f${n}`); }
  }
  if (dirty) { fs.appendFileSync(path.join(dir, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n'); }
  return dir;
}
const fakeNarrator = (reply) => {
  const n = { calls: [], async run(x) { n.calls.push(x); if (reply instanceof Error) throw reply; return { text: typeof reply === 'function' ? reply(x) : reply }; } };
  return n;
};
/** A worktree made a while ago whose launch settled with no session: past the pending window. */
const old = (svc, rec) => svc.update(rec.path, { pending: undefined, created: 0 });
function service(stateDir,{ live = [], narrator = null, prOf = null, modelCalls = () => true } = {}) {
  const deck = new DeckState(stateDir);
  return new Worktrees({ state: deck.ns('worktrees'), stateDir, narrator, modelCalls, live: () => live, known: () => false, prOf });
}

test('detection: a subdirectory and a symlinked path share the worktree; another worktree of the repo does not', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  const link = path.join(tmp('wt-link-'), 'via-link');
  fs.symlinkSync(dir, link);
  const other = path.join(tmp('wt-other-'), 'other');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', other);

  assert.equal((await worktreeOf(link)).top, dir, 'a symlink resolves to the real top level');
  assert.equal((await worktreeOf(path.join(dir, 'src', 'deep'))).top, dir);
  assert.equal((await worktreeOf(other)).linked, true);
  assert.equal((await worktreeOf(other)).main, dir, 'a linked worktree knows its main checkout');
  assert.equal(await worktreeOf(tmp('wt-plain-')), null, 'not a repo');

  const live = [{ id: 'a', cwd: path.join(dir, 'src', 'deep'), title: 'Refactor auth' }, { id: 'b', cwd: other }, { id: 'c', cwd: link }];
  assert.deepEqual((await sharing(link, live)).map(s => s.id), ['a', 'c']);
  assert.deepEqual((await sharing(dir, live, { except: 'c' })).map(s => s.id), ['a']);
  assert.deepEqual((await sharing(other, live)).map(s => s.id), ['b']);
  const map = await sharedMap(live);
  assert.deepEqual(Object.keys(map).sort(), ['a', 'c']);
  assert.equal(map.a[0].id, 'c');
});

test('candidates collapse (on main, nothing ahead or uncommitted): fresh from main is preselected, no model call', async () => {
  const dir = repo({ branches: ['fix-login'] });
  const n = fakeNarrator('{"pick":"head","confidence":1}');
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir, title: 'Refactor auth' }], narrator: n });
  const p = await svc.plan({ cwd: dir, prompt: 'Add a dark mode toggle', ask: true });
  assert.equal(p.conflict, true);
  assert.deepEqual(p.with.map(w => w.id), ['a']);
  assert.equal(p.suggestion.pick, 'default');
  assert.equal(p.suggestion.via, 'collapsed');
  assert.equal(p.suggestion.preselect, true);
  assert.ok(!p.candidates.some(c => c.id === 'head'), 'continue and fresh are one base');
  assert.ok(p.candidates.some(c => c.id === 'branch:fix-login'), 'other branches are still offered');
  assert.equal(n.calls.length, 0);
});

test('a branch or PR named in the prompt picks it with no model call', async () => {
  const dir = repo({ feature: true, dirty: true, branches: ['fix-login', 'old-2'] });
  const n = fakeNarrator('{"pick":"head","confidence":1}');
  const prOf = async (b) => b === 'fix-login' ? { number: 41, state: 'open', checks: { state: 'failure' } } : null;
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }], narrator: n, prOf });

  let p = await svc.plan({ cwd: dir, prompt: 'Address the review comments on fix-login.', ask: true });
  assert.equal(p.suggestion.pick, 'branch:fix-login');
  assert.equal(p.suggestion.via, 'named');
  p = await svc.plan({ cwd: dir, prompt: 'Fix CI on #41 please', ask: true });
  assert.equal(p.suggestion.pick, 'branch:fix-login');
  assert.match(p.candidates.find(c => c.id === 'branch:fix-login').facts, /PR #41, CI red/);
  p = await svc.plan({ cwd: dir, prompt: 'Write tests for `feature-x`', ask: true });
  assert.equal(p.suggestion.pick, 'head', 'the occupied branch is "continue"');
  assert.equal(n.calls.length, 0);

  // An ordinary word that happens to be a branch is not a named branch; a branch not in the recent list is added.
  const list = [{ id: 'default', kind: 'default', branch: 'main' }];
  assert.equal(namedRef('the main thing is speed', list, ['main']), null);
  assert.deepEqual(namedRef('pick up old-2 again', list, ['main', 'old-2']), { id: 'branch:old-2', name: 'old-2' });
  assert.ok(list.some(c => c.id === 'branch:old-2'));
});

test('the model is asked once when the candidates differ; low confidence or a failed call preselects nothing', async () => {
  const dir = repo({ feature: true, dirty: true, branches: ['fix-login'] });
  const live = [{ id: 'a', cwd: dir, title: 'Refactor auth' }];
  const c = await candidates(await worktreeOf(dir));
  assert.deepEqual(c.list.map(x => x.id), ['head', 'default', 'branch:fix-login', 'fork']);
  assert.equal(c.occupied.ahead, 3);
  assert.equal(c.occupied.dirty, 2);

  const sure = fakeNarrator('```json\n{"pick":"head","confidence":0.85,"reason":"The prompt asks to add tests for the auth refactor."}\n```');
  let p = await service(tmp('wt-state-'), { live, narrator: sure }).plan({ cwd: dir, prompt: 'Add tests for the refactor', ask: true });
  assert.equal(sure.calls.length, 1);
  assert.equal(sure.calls[0].purpose, 'worktree');
  assert.equal(sure.calls[0].thinking, false);
  assert.match(sure.calls[0].prompt, /head: Continue from feature-x · 3 ahead of main · 2 files uncommitted \(not carried\)/);
  assert.match(sure.calls[0].prompt, /Refactor auth/);
  assert.ok(sure.calls[0].prompt.length + sure.calls[0].system.length < 4500, 'about 1k tokens in');
  assert.deepEqual([p.suggestion.pick, p.suggestion.preselect], ['head', true]);

  const unsure = fakeNarrator('{"pick":"default","confidence":0.3,"reason":"Hard to say."}');
  p = await service(tmp('wt-state-'), { live, narrator: unsure }).plan({ cwd: dir, prompt: 'Something else', ask: true });
  assert.equal(p.suggestion.pick, 'default');
  assert.ok(p.suggestion.confidence < CONFIDENT);
  assert.equal(p.suggestion.preselect, false, 'low confidence: shown, not preselected');

  const bad = fakeNarrator('{"pick":"nonsense","confidence":0.99}');
  p = await service(tmp('wt-state-'), { live, narrator: bad }).plan({ cwd: dir, prompt: 'x', ask: true });
  assert.ok(p.suggestion.error && !p.suggestion.preselect);
  const down = fakeNarrator(new Error('local model unreachable'));
  p = await service(tmp('wt-state-'), { live, narrator: down }).plan({ cwd: dir, prompt: 'x', ask: true });
  assert.match(p.suggestion.error, /unreachable/);

  // Not asked unless the page asks (it does once the prompt settles).
  const idle = fakeNarrator('{}');
  p = await service(tmp('wt-state-'), { live, narrator: idle }).plan({ cwd: dir, prompt: 'x' });
  assert.equal(p.suggestion, null);
  assert.equal(idle.calls.length, 0);
});

test('no conflict: an unshared folder, and anything inside the Vault', async () => {
  const dir = repo();
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: path.join(tmp('wt-else-')) }] });
  assert.equal((await svc.plan({ cwd: dir })).conflict, false);
  const shared = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  shared.vaultDir = () => path.dirname(dir);
  const p = await shared.plan({ cwd: dir });
  assert.deepEqual([p.conflict, p.skipped], [false, 'vault']);
});

test('branch names: deck/<slug>-<id4>, and a taken branch or folder gets a new id', async () => {
  const dir = repo();
  const root = path.join(tmp('wt-root-'), 'app');
  git(dir, 'branch', 'deck/fix-the-login-bug-aaaa');
  fs.mkdirSync(path.join(root, 'deck', 'fix-the-login-bug-bbbb'), { recursive: true });
  const ids = ['aaaa', 'bbbb', 'cccc'];
  const b = await branchName('Fix the login bug!', { top: dir, root, rand: () => ids.shift() });
  assert.equal(b, 'deck/fix-the-login-bug-cccc');
  assert.match(await branchName('', { top: dir, root }), /^deck\/session-[0-9a-f]{4}$/);
  assert.equal(await branchName('Ünïcode   and a very long title that goes on and on beyond reason', { top: dir, rand: () => '0000' }), 'deck/unicode-and-a-very-long-title-0000');
});

test('making one: from the occupied HEAD, the base recorded for the header, configured files copied, uncommitted work not carried', async () => {
  const dir = repo({ feature: true, dirty: true });
  fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{}');
  const state = tmp('wt-state-');
  const svc = service(state, { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: dir, base: 'head', title: 'Add tests', rand: () => 'abcd' });
  assert.equal(rec.branch, 'deck/add-tests-abcd');
  assert.equal(rec.path, path.join(state, 'worktrees', 'app', 'deck', 'add-tests-abcd'));
  assert.equal(git(rec.path, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(rec.copied.sort(), ['.claude/settings.local.json', '.env.local']);
  assert.equal(fs.readFileSync(path.join(rec.path, 'a.txt'), 'utf8'), 'one\n', 'uncommitted changes stay where they are');
  assert.ok(!fs.existsSync(path.join(rec.path, 'new.txt')));
  assert.deepEqual(svc.records().map(r => r.path), [rec.path]);
  const where = await place(rec.path);
  assert.equal(where.worktree.main, dir);
  assert.equal(where.base.branch, 'feature-x', 'the header shows the real base');
  assert.equal(where.base.ahead, 0);

  // A fork carries the working copy; fresh starts at main.
  const fork = await svc.start({ cwd: dir, base: 'fork', title: 'Try it', rand: () => 'f0f0' });
  assert.equal(fs.readFileSync(path.join(fork.path, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.ok(fs.existsSync(path.join(fork.path, 'new.txt')));
  const fresh = await svc.start({ cwd: dir, base: 'default', title: 'Other', rand: () => 'e0e0' });
  assert.equal(git(fresh.path, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'main'));
  await assert.rejects(svc.start({ cwd: dir, base: 'branch:nope', title: 'x' }), /unknown base/);

  // Copies never overwrite, and never leave the repo.
  const to = tmp('wt-copy-');
  fs.writeFileSync(path.join(to, '.env.local'), 'MINE\n');
  assert.deepEqual(copyUntracked(dir, to, ['.env*', '../outside', '.claude/settings.local.json']), ['.claude/settings.local.json']);
  assert.equal(fs.readFileSync(path.join(to, '.env.local'), 'utf8'), 'MINE\n');
});

test('cleanup decision table', () => {
  const rows = [
    [{ exists: false }, 'gone', ['forget'], 'forget'],
    [{ exists: true, dirty: 2, unmerged: 0 }, 'dirty', ['keep', 'stash', 'remove-anyway'], null],
    [{ exists: true, dirty: 1, unmerged: 3, remote: true }, 'dirty', ['keep', 'stash', 'remove-anyway'], null],
    [{ exists: true, dirty: 0, unmerged: 3, remote: true }, 'unmerged', ['push-remove', 'keep', 'remove-anyway'], null],
    [{ exists: true, dirty: 0, unmerged: 3, remote: false }, 'unmerged', ['keep', 'remove-anyway'], null],
    [{ exists: true, dirty: 0, unmerged: 0, merged: true, commits: 2 }, 'merged', ['remove', 'keep'], 'remove'],
    [{ exists: true, dirty: 0, unmerged: 0, merged: false, commits: 0 }, 'empty', ['remove', 'keep'], 'remove'],
  ];
  for (const [f, state, choices, safe] of rows) {
    const d = decide(f);
    assert.deepEqual([d.state, d.choices, d.safe], [state, choices, safe], JSON.stringify(f));
    assert.equal(d.ask, safe === null, 'anything not safe asks');
  }
  assert.equal(decide({ exists: true, dirty: 0, unmerged: 5, remote: true }).unmerged, 5, 'the ahead count is shown');
});

test('cleanup actions: only what the state allows; nothing uncommitted or unmerged goes without its own choice', async () => {
  const dir = repo({ feature: true });
  const bare = path.join(tmp('wt-bare-'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(dir, 'remote', 'add', 'origin', bare);
  const state = tmp('wt-state-');
  const svc = service(state, { live: [{ id: 'a', cwd: dir }] });
  let n = 0;
  const mk = (base = 'head') => svc.start({ cwd: dir, base, title: 'w', rand: () => String(1000 + n++) }).then(r => old(svc, r));

  // Empty and clean: remove, and its branch goes too.
  const empty = await mk();
  assert.equal(decide(await inspect(empty)).state, 'empty');
  let r = await svc.act(empty.path, 'remove');
  assert.deepEqual([r.removed, r.branchDeleted], [true, true]);
  assert.ok(!fs.existsSync(empty.path));
  assert.equal(svc.record(empty.path), null);

  // Uncommitted: remove is refused and nothing is touched; stash keeps the changes.
  const dirty = await mk();
  fs.writeFileSync(path.join(dirty.path, 'wip.txt'), 'wip\n');
  await assert.rejects(svc.act(dirty.path, 'remove'), (e) => e.status === 409);
  assert.ok(fs.existsSync(path.join(dirty.path, 'wip.txt')));
  r = await svc.act(dirty.path, 'stash');
  assert.equal(r.removed, true);
  assert.match(git(dir, 'stash', 'list'), /before its worktree was removed/);
  assert.match(git(dir, 'show', '--name-only', '--format=', 'stash@{0}^3'), /wip\.txt/, 'the untracked file is in the stash');

  // Unmerged commits: remove is refused; push & remove pushes to the (local, bare) remote first.
  const ahead = await mk();
  fs.writeFileSync(path.join(ahead.path, 'b.txt'), 'b\n'); git(ahead.path, 'add', '.'); git(ahead.path, 'commit', '-qm', 'b');
  let f = await inspect(ahead);
  assert.deepEqual([f.unmerged, decide(f).state], [1, 'unmerged']);
  await assert.rejects(act(ahead, 'remove'), /not a choice/);
  const tip = git(ahead.path, 'rev-parse', 'HEAD');
  r = await svc.act(ahead.path, 'push-remove');
  assert.equal(r.pushed, `origin/${ahead.branch}`);
  assert.equal(git(bare, 'rev-parse', `refs/heads/${ahead.branch}`), tip, 'the remote has it before anything is removed');
  assert.ok(!fs.existsSync(ahead.path));

  // Merged into its base: remove.
  const merged = await mk();
  fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm\n'); git(merged.path, 'add', '.'); git(merged.path, 'commit', '-qm', 'm');
  git(dir, 'merge', '-q', '--ff-only', merged.branch);
  f = await inspect(merged);
  assert.deepEqual([f.merged, decide(f).state], [true, 'merged']);

  // Keep is just a note; remove anyway takes an explicit choice and discards.
  const kept = await mk();
  fs.writeFileSync(path.join(kept.path, 'k.txt'), 'k\n'); git(kept.path, 'add', '.'); git(kept.path, 'commit', '-qm', 'k');
  r = await svc.act(kept.path, 'keep');
  assert.equal(r.removed, false);
  assert.ok(svc.record(kept.path).kept);
  assert.ok(fs.existsSync(kept.path));
  r = await svc.act(kept.path, 'remove-anyway');
  assert.deepEqual([r.removed, r.branchDeleted], [true, true]);

  // A folder already gone: forget the record.
  const gone = await mk();
  fs.rmSync(gone.path, { recursive: true, force: true });
  assert.equal(decide(await inspect(gone)).state, 'gone');
  await svc.act(gone.path, 'forget');
  assert.equal(svc.record(gone.path), null);

  // The plan lists what is left, flags orphans, and acts on nothing.
  const plan = await svc.planCleanup();
  assert.deepEqual(plan.map(p => [p.record.path, p.decision.state, p.orphan]), [[merged.path, 'merged', true]]);
  assert.ok(fs.existsSync(merged.path));
});

test('a setup command that fails leaves the worktree and reports the error', async () => {
  const dir = repo();
  const state = tmp('wt-state-');
  const svc = service(state, { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: dir, base: 'default', title: 'setup', rand: () => '5e7a' });
  assert.equal(await svc.setup(rec.path), null, 'no command configured: nothing runs');
  svc.setRepoConfig(rec.repo, { setup: 'echo installing; echo broken >&2; exit 3' });
  const r = await svc.setup(rec.path);
  assert.deepEqual([r.ok, r.code], [false, 3]);
  assert.match(r.tail, /broken/);
  const after = svc.record(rec.path);
  assert.deepEqual([after.setup.state, after.setup.error], ['failed', 'exited with 3']);
  assert.ok(fs.existsSync(path.join(rec.path, 'a.txt')), 'the session can still work there');
  const ok = await runSetup(rec.path, 'test -f a.txt');
  assert.equal(ok.ok, true);
  const t = await runSetup(rec.path, 'sleep 5', { timeout: 100 });
  assert.match(t.error, /timed out/);
});

test('the launch hook: starts in a new worktree when asked, and failed() removes the one it just made', async (t) => {
  const dir = repo({ feature: true });
  const state = tmp('wt-state-');
  const deck = new DeckState(state);
  const index = { registry: new Map([['live1', { sessionId: 'live1', cwd: dir, alive: true }]]), files: new Map(), summary: () => null };
  const sent = [];
  const table = await loadRoutes(ROUTES, { send: (res, code, body) => sent.push([code, body]), readBody: async () => ({}), deck, index,
    agents: { running: () => false, on() {} }, broadcast: () => {}, onLaunch: (hk) => t.after(onLaunch(hk)) });
  assert.ok(matchRoute(table, 'POST', '/api/worktrees/plan'));
  t.mock.method(console, 'error', () => {});

  // No choice in the body: the folder as it is.
  assert.equal((await beforeLaunch({ cwd: dir, prompt: 'go' })).cwd, dir);
  assert.equal((await beforeLaunch({ cwd: dir, prompt: 'go', worktree: { use: false } })).cwd, dir);

  const body = await beforeLaunch({ cwd: dir, prompt: 'Add tests for the refactor', worktree: { use: true, base: 'head', suggestion: { pick: 'head', confidence: 0.9, reason: 'tests' } } });
  assert.notEqual(body.cwd, dir);
  assert.ok(body.cwd.startsWith(path.join(state, 'worktrees', 'app', 'deck', 'add-tests-for-the-refactor-')));
  assert.ok(fs.existsSync(body.cwd));
  const branch = git(body.cwd, 'symbolic-ref', '--short', 'HEAD');
  await failedLaunch(body, new Error('the CLI did not start'));
  assert.ok(!fs.existsSync(body.cwd), 'its own new worktree is gone');
  assert.equal(git(dir, 'branch', '--list', branch), '', 'and its branch');
  assert.deepEqual(deck.ns('worktrees').get('list', []), []);
  // failed() for a launch it made nothing for touches nothing.
  await failedLaunch({ cwd: dir, worktreeMade: dir }, new Error('x'));
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));

  // A launch that starts records its session and the suggestion it started from.
  const ok = await beforeLaunch({ cwd: dir, prompt: 'Second', worktree: { use: true, base: 'default', suggestion: { pick: 'head', confidence: 0.3 } } });
  await afterLaunch({ id: 'sess-2' }, ok);
  const rec = deck.ns('worktrees').get('list')[0];
  assert.equal(rec.sessionId, 'sess-2');
  assert.equal(rec.base.branch, 'main');
  assert.deepEqual([rec.suggestion.pick, rec.suggestion.confidence], ['head', 0.3]);
  await assert.rejects(beforeLaunch({ cwd: dir, prompt: 'x', worktree: { use: true, base: 'nope' } }), /unknown base/);
});

test('with model calls off (--no-narrator) nothing is asked and nothing is preselected', async () => {
  const dir = repo({ feature: true, dirty: true });
  const n = fakeNarrator('{"pick":"head","confidence":0.9}');
  const p = await service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }], narrator: n, modelCalls: () => false }).plan({ cwd: dir, prompt: 'Add tests for the refactor', ask: true });
  assert.equal(n.calls.length, 0);
  assert.equal(p.suggestion, null);
  assert.equal(chosenOf(p, null), null);
});

test('a worktree its session is running in is in use: no removal offered, and /act refuses it', async () => {
  const dir = repo();
  const live = [{ id: 'a', cwd: dir }];
  const svc = service(tmp('wt-state-'), { live });
  const rec = await svc.start({ cwd: dir, base: 'default', title: 'busy', rand: () => 'b5b5' });
  svc.update(rec.path, { sessionId: 's1' });
  live.push({ id: 's1', cwd: rec.path });
  let [it] = await svc.planCleanup();
  assert.deepEqual([it.alive, it.decision.state, it.decision.choices, it.decision.safe], [true, 'in-use', [], null]);
  for (const a of ['remove', 'remove-anyway', 'stash', 'keep']) await assert.rejects(svc.act(rec.path, a), (e) => e.status === 409);
  assert.ok(fs.existsSync(rec.path));
  // Another live session working inside it counts too.
  live.pop(); live.push({ id: 'other', cwd: rec.path });
  [it] = await svc.planCleanup();
  assert.equal(it.decision.state, 'in-use');
  live.pop();
  [it] = await svc.planCleanup();
  assert.equal(it.decision.state, 'empty');
  assert.deepEqual(decide({ exists: true, dirty: 0, unmerged: 0, commits: 0, baseKnown: true }, { alive: true }).choices, []);
});

test('no resolvable base: state unknown, no safe choice, and remove anyway keeps the branch (git branch -d only)', async () => {
  const dir = repo({ feature: true });
  const svc = service(tmp('wt-state-'), { live: [] });
  const rec = old(svc, await svc.start({ cwd: dir, base: 'head', title: 'lost', rand: () => '1057' }));
  fs.writeFileSync(path.join(rec.path, 'x.txt'), 'x\n'); git(rec.path, 'add', '.'); git(rec.path, 'commit', '-qm', 'x');
  const tip = git(rec.path, 'rev-parse', 'HEAD');
  // The start commit and base branch are gone (rewritten history, a deleted branch): nothing to measure against.
  svc.update(rec.path, { base: { ...rec.base, sha: '0'.repeat(40), branch: 'no-such-branch' } });
  const [it] = await svc.planCleanup();
  assert.deepEqual([it.facts.baseKnown, it.facts.unmerged], [false, null]);
  assert.deepEqual([it.decision.state, it.decision.safe, it.decision.choices], ['unknown', null, ['keep', 'remove-anyway']]);
  assert.match(it.decision.warning, /unknown/);
  await assert.rejects(svc.act(rec.path, 'remove'), (e) => e.status === 409);
  const r = await svc.act(rec.path, 'remove-anyway');
  assert.deepEqual([r.removed, r.branchDeleted], [true, false]);
  assert.equal(git(dir, 'rev-parse', `refs/heads/${rec.branch}`), tip, 'the branch and its commit are still there');
  assert.equal(decide({ exists: true, dirty: 0, unmerged: null, commits: 3, baseKnown: false }).state, 'unknown');
  assert.deepEqual(decide({ exists: true, dirty: 2, baseKnown: false }).choices, ['keep', 'stash', 'remove-anyway']);
});

test('launch fields: a plan loading or failed stops the launch; a shared folder needs a choice; the chosen card goes along', () => {
  const plan = { conflict: true, candidates: [{ id: 'head', kind: 'head', ref: 'feature-x', branch: 'feature-x' }, { id: 'default', kind: 'default', ref: 'main', branch: 'main' }],
    suggestion: { pick: 'head', confidence: 0.4, preselect: false, via: 'model' } };
  assert.throws(() => launchFields(undefined, null), /Still checking/);
  assert.throws(() => launchFields({ state: 'loading' }, null), /Still checking/);
  assert.throws(() => launchFields({ state: 'failed', error: 'timeout' }, null), /Could not check .*timeout/);
  assert.equal(launchFields({ state: 'ok', plan: { conflict: false } }, null), null);
  assert.throws(() => launchFields({ state: 'ok', plan }, null), /choose where this one starts/, 'low confidence: nothing chosen yet');
  assert.deepEqual(launchFields({ state: 'ok', plan }, 'same'), { worktree: { use: false } });
  const f = launchFields({ state: 'ok', plan }, 'default').worktree;
  assert.deepEqual([f.use, f.base, f.cand], [true, 'default', { id: 'default', kind: 'default', ref: 'main', branch: 'main' }]);
  assert.equal(f.suggestion.chosen, 'default');
  const sure = { ...plan, suggestion: { ...plan.suggestion, preselect: true } };
  assert.equal(launchFields({ state: 'ok', plan: sure }, null).worktree.base, 'head');
  assert.throws(() => launchFields({ state: 'ok', plan }, 'branch:gone'), /no longer offered/);
});

test('a launch from a subfolder lands in the same subfolder of the new worktree', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'src', 'app.js'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'web');
  fs.mkdirSync(path.join(dir, 'scratch'));
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: path.join(dir, 'web', 'src'), base: 'default', cand: { id: 'default', kind: 'default', ref: 'main', branch: 'main' }, title: 'sub', rand: () => '5ab0' });
  assert.equal(rec.cwd, path.join(rec.path, 'web', 'src'));
  assert.ok(fs.existsSync(path.join(rec.cwd, 'app.js')));
  const un = await svc.start({ cwd: path.join(dir, 'scratch'), base: 'default', title: 'sub2', rand: () => '5ab1' });
  assert.equal(un.cwd, path.join(un.path, 'scratch'));
  assert.ok(fs.statSync(un.cwd).isDirectory(), 'an untracked folder is made');
  // A card from the page is checked: a ref git cannot resolve, or an option-looking one, is refused.
  await assert.rejects(svc.start({ cwd: dir, base: 'branch:x', cand: { kind: 'branch', ref: '--upload-pack=x' }, title: 'bad' }), /unknown base/);
  await assert.rejects(svc.start({ cwd: dir, base: 'default', cand: { kind: 'default', ref: 'feature-zz', branch: 'main' }, title: 'bad' }), /unknown base/);
});

test('a fork whose uncommitted changes cannot be read stops with the error and leaves nothing behind', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads anything');
  const dir = repo({ dirty: true });
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  fs.chmodSync(path.join(dir, 'a.txt'), 0o000);
  t.after(() => fs.chmodSync(path.join(dir, 'a.txt'), 0o644));
  await assert.rejects(svc.start({ cwd: dir, base: 'fork', title: 'fork', rand: () => 'f00d' }), (e) => /could not read the uncommitted changes/.test(e.message) && !!e.carryError);
  assert.deepEqual(svc.records(), []);
  assert.equal(git(dir, 'branch', '--list', 'deck/*'), '');
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
});

test('Resume <branch>: continue on it, or a new branch from it; cleanup never deletes a branch the deck did not make', async () => {
  const dir = repo({ feature: true, branches: ['fix-login'] });
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const p = await svc.plan({ cwd: dir });
  const card = p.candidates.find(c => c.id === 'branch:fix-login');
  assert.equal(card.checkedOutAt, null);
  assert.equal(resumeMode(card), 'continue', 'continue is the default when possible');
  assert.equal(resumeMode(card, { 'branch:fix-login': 'new' }), 'new');
  assert.equal(launchFields({ state: 'ok', plan: p }, 'branch:fix-login').worktree.cand.mode, 'continue');

  // Continue on: the branch itself, in the new worktree.
  const tip = git(dir, 'rev-parse', 'fix-login');
  const cont = old(svc, await svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'continue' }, title: 'review fixes' }));
  assert.deepEqual([cont.branch, cont.ownBranch, cont.mode], ['fix-login', false, 'continue']);
  assert.equal(git(cont.path, 'symbolic-ref', '--short', 'HEAD'), 'fix-login');
  // Now another worktree has it: continue is shown disabled, and refused if sent anyway.
  const p2 = await svc.plan({ cwd: dir });
  const card2 = p2.candidates.find(c => c.id === 'branch:fix-login');
  assert.equal(card2.checkedOutAt, cont.path);
  assert.equal(resumeMode(card2, { 'branch:fix-login': 'continue' }), 'new');
  await assert.rejects(svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'continue' }, title: 'again' }), /unknown base/);

  // New branch from: today's behaviour.
  const fresh = old(svc, await svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'new' }, title: 'spin off', rand: () => 'ab12' }));
  assert.deepEqual([fresh.branch, fresh.ownBranch, fresh.mode], ['deck/spin-off-ab12', true, 'new']);
  assert.equal(git(fresh.path, 'rev-parse', 'HEAD'), tip);

  // Commits and uncommitted work on the pilot's branch: removal removes the worktree only.
  fs.writeFileSync(path.join(cont.path, 'fix.txt'), 'fix\n'); git(cont.path, 'add', '.'); git(cont.path, 'commit', '-qm', 'fix');
  const fixed = git(cont.path, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cont.path, 'wip.txt'), 'wip\n');
  let [it] = (await svc.planCleanup()).filter(x => x.record.path === cont.path);
  assert.deepEqual([it.decision.state, it.decision.keepsBranch, it.decision.choices], ['dirty', true, ['keep', 'stash', 'remove-anyway']]);
  let r = await svc.act(cont.path, 'remove-anyway');
  assert.deepEqual([r.removed, r.branchDeleted], [true, false]);
  assert.equal(git(dir, 'rev-parse', 'fix-login'), fixed, 'the branch and its commit stay');

  // Clean: remove is the safe choice, and the branch still stays.
  const again = old(svc, await svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'continue' }, title: 'once more' }));
  [it] = (await svc.planCleanup()).filter(x => x.record.path === again.path);
  assert.deepEqual([it.decision.state, it.decision.safe], ['clean', 'remove']);
  r = await svc.act(again.path, 'remove');
  assert.equal(r.branchDeleted, false);
  assert.equal(git(dir, 'rev-parse', 'fix-login'), fixed);
  // A failed launch's discard keeps it too.
  const third = await svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'continue' }, title: 'third' });
  await discard(third);
  assert.ok(!fs.existsSync(third.path));
  assert.equal(git(dir, 'rev-parse', 'fix-login'), fixed);
  // The deck's own branch from "new" does go when it is removed clean and empty.
  r = await svc.act(fresh.path, 'remove');
  assert.equal(r.branchDeleted, true);
});

test('a just-made worktree is in use until its session is known: no choices, /act refuses; failed() still discards its own', async (t) => {
  const dir = repo();
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: dir, base: 'default', title: 'starting', rand: () => '9e9e' });
  assert.ok(rec.pending && !rec.sessionId);
  let [it] = await svc.planCleanup();
  assert.deepEqual([it.alive, it.orphan, it.decision.state, it.decision.choices], [true, false, 'in-use', []]);
  for (const a of ['remove', 'remove-anyway', 'forget']) await assert.rejects(svc.act(rec.path, a), (e) => e.status === 409);
  assert.ok(fs.existsSync(rec.path));
  // No pending mark, but made a moment ago with no session: in use too.
  svc.update(rec.path, { pending: undefined });
  assert.equal(svc.inUse(svc.record(rec.path), []), true);
  // Past the window (a deck that died mid-launch), it is an orphan again.
  assert.equal(svc.inUse(svc.record(rec.path), [], Date.now() + PENDING_MS + 1), false);
  // Once the launch's after() names its session, liveness decides.
  svc.update(rec.path, { sessionId: 'gone-now' });
  [it] = await svc.planCleanup();
  assert.deepEqual([it.decision.state, it.orphan], ['empty', true]);

  // Through the launch hook: pending from before() to after(); failed() discards it.
  const deck = new DeckState(tmp('wt-state-'));
  const index = { registry: new Map([['live1', { sessionId: 'live1', cwd: dir, alive: true }]]), files: new Map(), summary: () => null };
  t.mock.method(console, 'error', () => {});
  await loadRoutes(ROUTES, { send() {}, readBody: async () => ({}), deck, index, agents: { running: () => false, on() {} }, broadcast: () => {}, onLaunch: (hk) => t.after(onLaunch(hk)) });
  const body = await beforeLaunch({ cwd: dir, prompt: 'Starting up', worktree: { use: true, base: 'default' } });
  const made = deck.ns('worktrees').get('list').find(r => r.path === body.worktreeMade);
  assert.ok(made.pending && !made.sessionId, 'pending while the agent starts');
  await failedLaunch(body, new Error('did not start'));
  assert.ok(!fs.existsSync(body.worktreeMade));
  const ok = await beforeLaunch({ cwd: dir, prompt: 'Second start', worktree: { use: true, base: 'default' } });
  await afterLaunch({ id: 'sess-9' }, ok);
  const done = deck.ns('worktrees').get('list').find(r => r.path === ok.worktreeMade);
  assert.deepEqual([done.sessionId, done.pending], ['sess-9', undefined]);
});

test('a deck branch from origin/<default> has no upstream, so a push never goes to the default branch', async () => {
  const dir = repo({ feature: true });
  const bare = path.join(tmp('wt-bare-'), 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const p = await svc.plan({ cwd: dir });
  const def = p.candidates.find(c => c.id === 'default');
  assert.equal(def.ref, 'origin/main');
  const rec = await svc.start({ cwd: dir, base: 'default', cand: def, title: 'fresh', rand: () => 'f7e5' });
  assert.equal(git(rec.path, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'origin/main'));
  assert.throws(() => git(rec.path, 'rev-parse', '--abbrev-ref', `${rec.branch}@{u}`), 'no upstream');
  assert.equal(git(dir, 'config', '--get-regexp', `^branch\\.${rec.branch.replace(/[/.-]/g, '.')}\\.`).includes('merge'), false);
});

test('the header falls back to the default branch when the recorded base was deleted', async () => {
  const dir = repo({ branches: ['fix-login'] });
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: dir, base: 'branch:fix-login', cand: { kind: 'branch', ref: 'fix-login', mode: 'new' }, title: 'from fix', rand: () => 'dede' });
  assert.equal((await place(rec.path)).base.branch, 'fix-login');
  git(dir, 'branch', '-D', 'fix-login');
  assert.equal((await place(rec.path)).base.branch, 'main');
});

test('carry: untracked names split on NUL exactly; folders and nested repos are named as not carried', async () => {
  const dir = repo({ dirty: true });
  fs.writeFileSync(path.join(dir, ' spaced name.txt '), 's\n');
  const nested = path.join(dir, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q', nested]);
  fs.writeFileSync(path.join(nested, 'x.txt'), 'x\n');
  const svc = service(tmp('wt-state-'), { live: [{ id: 'a', cwd: dir }] });
  const rec = await svc.start({ cwd: dir, base: 'fork', title: 'fork', rand: () => 'c0c0' });
  assert.ok(fs.existsSync(path.join(rec.path, ' spaced name.txt ')), 'leading and trailing spaces kept');
  assert.deepEqual(rec.carried.skipped, ['vendor/lib/']);
  assert.equal(rec.carried.untracked, 2);
});

test('runSetup: a command that cannot start still finishes', async () => {
  const r = await runSetup(path.join(tmp('wt-none-'), 'missing-dir'), 'true', { timeout: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('latest(): an earlier open of a reused dialog goes stale', () => {
  const opens = latest();
  const first = opens();
  assert.equal(first(), true);
  const second = opens();
  assert.deepEqual([first(), second()], [false, true], 'the first open\'s late answer is dropped');
});

test('Restart in worktree keeps the session\'s model and permission mode, and its subfolder', async () => {
  const dir = repo({ feature: true });
  fs.mkdirSync(path.join(dir, 'pkg')); fs.writeFileSync(path.join(dir, 'pkg', 'i.js'), '1\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'pkg');
  const deck = new DeckState(tmp('wt-state-'));
  const launched = [];
  const index = {
    registry: new Map([['old', { sessionId: 'old', cwd: dir, alive: true }], ['s', { sessionId: 's', cwd: path.join(dir, 'pkg'), alive: true }]]),
    files: new Map(), load: () => null,
    summary: (id) => id === 's' ? { id, cwd: path.join(dir, 'pkg'), title: 'Restart me', harness: 'claude', model: 'claude-sonnet' } : null,
  };
  const agents = { on() {}, running: () => true, stopped: [], stop(id) { this.stopped.push(id); return true; }, harnessList: () => [{ name: 'claude', label: 'Claude Code' }],
    publicState: (id) => id === 's' ? { model: 'opus', permissionMode: 'acceptEdits', status: 'idle' } : null,
    async launch(o) { launched.push(o); return { id: 'new1', cwd: o.cwd }; } };
  let out = null;
  const table = await loadRoutes(ROUTES, { send: (res, code, body) => { out = [code, body]; }, deck, index, agents, broadcast: () => {},
    readBody: async () => ({ sessionId: 's', base: 'default', cand: { id: 'default', kind: 'default', ref: 'main', branch: 'main' } }) });
  await matchRoute(table, 'POST', '/api/worktrees/restart').route.handler({}, {}, {});
  assert.equal(out[0], 200, JSON.stringify(out[1]));
  assert.deepEqual([launched[0].model, launched[0].permissionMode, launched[0].harness], ['opus', 'acceptEdits', 'claude']);
  assert.equal(launched[0].cwd, path.join(out[1].record.path, 'pkg'));
  assert.match(launched[0].prompt, /own git worktree/);
  assert.deepEqual(agents.stopped, ['s']);
  assert.equal(out[1].record.sessionId, 'new1');
});
