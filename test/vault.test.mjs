// The Vault (lib/vault.mjs): local-only, append-only, sidecars on save,
// artifact copies only from outside repos, pointers without content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Vault, vaultFor, pointerOf, readPointers, writePointers, repoOf, cleanName, remoteBound } from '../lib/vault.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { DeckState } from '../lib/deckstate.mjs';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes');

test('no remote: adding one or pushing is refused, a push is blocked by hook, and one that appears is warned about', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  await v.init();
  await assert.rejects(v.git('remote', 'add', 'origin', 'https://example.invalid/x.git'), /local-only/);
  await assert.rejects(v.git('remote', 'set-url', 'origin', 'x'), /local-only/);
  await assert.rejects(v.git('push'), /local-only/);
  assert.deepEqual(await v.remotes(), []);
  assert.equal((await v.status()).warning, null);

  // Someone adds one by hand: status warns, and git itself refuses the push.
  const bare = path.join(tmp('vault-remote-'), 'r.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(v.dir, 'remote', 'add', 'origin', bare);
  const st = await v.status();
  assert.deepEqual(st.remotes, ['origin']);
  assert.match(st.warning, /has a remote \(origin\)/);
  await v.saveData('a.txt', 'x');
  assert.throws(() => execFileSync('git', ['-C', v.dir, 'push', '-q', 'origin', 'HEAD'], { stdio: 'pipe' }), /local-only/);
  assert.equal(git(bare, 'rev-list', '--all').trim(), '', 'nothing reached the remote');
  // A save says so too.
  assert.match((await v.saveData('b.txt', 'y')).warning, /remote/);
});

test('save copies the file into loose/ (or a workstream) with a sidecar, and commits both', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const src = path.join(tmp('vault-src-'), 'mock.png');
  fs.writeFileSync(src, 'PNGDATA');
  const r = await v.saveFile(src, { source: { sessionId: 's1', eventId: 'e9', via: 'details' } });
  assert.equal(r.rel, path.join('loose', 'mock.png'));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'PNGDATA');
  const meta = JSON.parse(fs.readFileSync(r.path + '.meta.json', 'utf8'));
  assert.equal(meta.source.sessionId, 's1');
  assert.equal(meta.source.eventId, 'e9');
  assert.equal(meta.source.path, src);
  assert.equal(meta.size, 7);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(meta.savedAt)));
  assert.deepEqual(git(v.dir, 'ls-files').trim().split('\n').sort(), ['loose/mock.png', 'loose/mock.png.meta.json']);
  assert.match(git(v.dir, 'log', '-1', '--format=%B'), /Save loose\/mock\.png[\s\S]*session s1, event e9/);

  const w = await v.saveData('notes.md', '# hi', { workstream: 'billing-rewrite' });
  assert.equal(w.rel, path.join('billing-rewrite', 'notes.md'));
  await assert.rejects(v.saveData('x', 'y', { workstream: '../escape' }), /bad workstream slug/);
  await assert.rejects(v.saveFile(path.dirname(src)), /Only files/);

  // The listing folds sidecars into their files.
  const { items: list, truncated } = await v.list();
  assert.equal(truncated, false);
  assert.deepEqual(list.map(x => x.rel), ['billing-rewrite', 'billing-rewrite/notes.md', 'loose', 'loose/mock.png']);
  assert.equal(list.find(x => x.rel === 'loose/mock.png').meta.source.sessionId, 's1');
});

test('a name clash gets a new name; nothing is overwritten', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const a = await v.saveData('report.txt', 'first');
  const b = await v.saveData('report.txt', 'second');
  const c = await v.saveData('report.txt', 'third');
  assert.deepEqual([a, b, c].map(x => path.basename(x.path)), ['report.txt', 'report-2.txt', 'report-3.txt']);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'second');
  // A stray sidecar holds its name too, and parallel saves still never collide.
  fs.writeFileSync(path.join(v.dir, 'loose', 'x.txt.meta.json'), '{}');
  const many = await Promise.all([1, 2, 3].map(n => v.saveData('x.txt', String(n))));
  assert.deepEqual(many.map(x => path.basename(x.path)), ['x-2.txt', 'x-3.txt', 'x-4.txt']);
  assert.deepEqual(many.map(x => fs.readFileSync(x.path, 'utf8')), ['1', '2', '3']);
  assert.equal(cleanName('../../.git/config'), 'config');
  assert.equal(cleanName('.hidden'), 'hidden');
});

test('artifact copy takes only files outside repositories, once', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const repo = tmp('vault-repo-');
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'out'));
  const inRepo = path.join(repo, 'out', 'chart.png');
  fs.writeFileSync(inRepo, 'in repo');
  const loose = tmp('vault-tmp-');
  const outside = path.join(loose, 'report.html');
  fs.writeFileSync(outside, '<h1>report</h1>');
  const saved = await v.saveData('kept.txt', 'k');

  const r = await v.copyArtifacts([inRepo, outside, path.join(loose, 'gone.txt'), loose, saved.path], { workstream: 'ws-a', source: { sessionId: 's2' } });
  assert.deepEqual(r.copied.map(c => c.rel), [path.join('ws-a', 'report.html')]);
  assert.equal(r.copied[0].meta.source.via, 'wrapup');
  assert.equal(r.copied[0].meta.source.sessionId, 's2');
  assert.deepEqual(r.skipped.map(s => s.reason), ['in a repository', 'missing', 'not a file', 'already in the Vault']);
  assert.equal(repoOf(inRepo), repo);
  assert.equal(repoOf(outside), null);
  // A second wrap-up adds nothing new.
  const again = await v.copyArtifacts([outside], { workstream: 'ws-a' });
  assert.deepEqual(again.copied, []);
  assert.deepEqual(again.skipped.map(s => s.reason), ['already saved']);
});

test('pointers carry path, sha256, title and source only, never content', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const secret = 'TOP SECRET MOCKUP CONTENT';
  const s = await v.saveData('mockup.svg', secret, { workstream: 'ws-b', title: 'The mock-ups', source: { sessionId: 's3' } });
  const p = await v.pointer(s.rel);
  assert.deepEqual(Object.keys(p).sort(), ['path', 'sha256', 'source', 'title']);
  assert.deepEqual(p, { path: 'ws-b/mockup.svg', sha256: s.meta.sha256, title: 'The mock-ups', source: 's3' });
  await assert.rejects(v.pointer('../outside.txt'), /not in the Vault/);

  // Extra fields, content among them, are dropped on the way to vault.json.
  const ws = tmp('vault-ws-');
  writePointers(ws, [{ ...p, content: secret, data: Buffer.from(secret) }]);
  const text = fs.readFileSync(path.join(ws, 'vault.json'), 'utf8');
  assert.ok(!text.includes(secret));
  assert.deepEqual(readPointers(ws), [p]);
  assert.deepEqual(Object.keys(pointerOf({ path: 'a', body: 'x' })).sort(), ['path', 'sha256', 'source', 'title']);
  // Merged by path.
  writePointers(ws, [{ ...p, title: 'Renamed' }, { path: 'loose/x', sha256: 'f', title: 'x', source: null }]);
  assert.deepEqual(readPointers(ws).map(x => x.title), ['Renamed', 'x']);

  // Curation can tell ok, changed and missing apart.
  const checked = await v.checkPointers([p, { ...p, sha256: 'old' }, { path: 'ws-b/gone.svg', sha256: 'x', title: 'g', source: null }]);
  assert.deepEqual(checked.map(c => c.state), ['ok', 'changed', 'missing']);
});

test('scratch folders are fresh each time, under loose/', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const a = await v.scratch('proto');
  const b = await v.scratch('proto');
  assert.equal(a, path.join(v.dir, 'loose', 'proto'));
  assert.equal(b, path.join(v.dir, 'loose', 'proto-2'));
  assert.ok(fs.statSync(b).isDirectory());
});

test('the deck finds its Vault in the state dir or a configured one; the routes save and refuse remotes', async () => {
  const dir = tmp('vault-deck-');
  const deck = new DeckState(dir);
  assert.equal(vaultFor(deck).dir, path.join(dir, 'vault'));

  const replies = [];
  const send = (res, code, body) => replies.push({ code, body });
  const bodies = [];
  const readBody = async () => bodies.shift();
  const table = await loadRoutes(ROUTES, { send, readBody, deck, index: { image: () => ({ mediaType: 'image/png', data: Buffer.from('img') }) } });
  const call = async (method, p, body, q = '') => { if (body) bodies.push(body); await matchRoute(table, method, p).route.handler({}, {}, { q: new URLSearchParams(q) }); return replies.pop(); };

  const src = path.join(dir, 'a.txt'); fs.writeFileSync(src, 'a');
  let r = await call('POST', '/api/vault/save', { path: src, sessionId: 's', eventId: 'e' });
  assert.equal(r.code, 200); assert.equal(r.body.rel, path.join('loose', 'a.txt'));
  r = await call('POST', '/api/vault/save', { sessionId: 's', eventId: 'evt12345', image: 0 });
  assert.equal(r.body.rel, path.join('loose', 'image-evt12345-0.png'));
  assert.equal((await call('POST', '/api/vault/save', { path: 'relative.txt' })).code, 400);
  r = await call('GET', '/api/vault', undefined);
  assert.deepEqual(r.body.items.filter(x => !x.dir).map(x => x.rel), ['loose/a.txt', 'loose/image-evt12345-0.png']);
  assert.equal(r.body.log.length, 2);

  // A configured folder that already has a remote is refused.
  const other = tmp('vault-other-');
  git(other, 'init', '-q'); git(other, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
  r = await call('POST', '/api/vault/config', { dir: other }); assert.equal(r.code, 409, JSON.stringify(r.body));
  const mine = path.join(tmp('vault-mine-'), 'v');
  r = await call('POST', '/api/vault/config', { dir: mine });
  assert.equal(r.body.dir, mine);
  assert.equal(vaultFor(new DeckState(dir)).dir, mine, 'kept in state.json');
});

test('the remote guard finds the subcommand past git\'s global options', async () => {
  for (const args of [['push'], ['-c', 'x=y', 'push'], ['-C', '/tmp', '-c', 'a=b', 'push', 'origin'], ['--git-dir=/x', 'push'], ['--git-dir', '/x', 'push'],
    ['-c', 'x=y', 'remote', 'add', 'o', 'u'], ['remote', '-v', 'set-url', 'o', 'u'], ['--no-pager', 'remote', 'rename', 'a', 'b'], ['config', 'remote.o.url', 'u'], ['-c', 'k=v', 'config', '--local', 'remote.o.url', 'u']]) {
    assert.ok(remoteBound(args), args.join(' '));
  }
  for (const args of [['remote'], ['remote', '-v'], ['-c', 'push.default=nothing', 'log'], ['config', 'remote.o.url'], ['commit', '-m', 'push'], ['log', '--', 'push']]) {
    assert.ok(!remoteBound(args), args.join(' '));
  }
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  await v.init();
  await assert.rejects(v.git('-c', 'x=y', 'push'), /local-only/);
  await assert.rejects(v.git('-c', 'x=y', 'remote', 'add', 'origin', 'u'), /local-only/);
  await assert.rejects(v.git('config', 'remote.origin.url', 'u'), /local-only/);
  assert.deepEqual(await v.remotes(), []);
});

test('a file a global ignore rule matches still saves and commits; a failed commit leaves no orphan', async (t) => {
  const home = tmp('vault-home-');
  fs.writeFileSync(path.join(home, 'ignore'), '*.log\n');
  fs.writeFileSync(path.join(home, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'ignore')}\n`);
  const was = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  t.after(() => { if (was == null) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = was; });

  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  const r = await v.saveData('build.log', 'lines');
  assert.deepEqual(git(v.dir, 'ls-files').trim().split('\n').sort(), ['loose/build.log', 'loose/build.log.meta.json']);
  assert.equal(git(v.dir, 'status', '--porcelain', '--ignored').trim(), '', 'nothing left uncommitted');

  // A commit that fails takes back only what that save wrote.
  const src = path.join(tmp('vault-src-'), 'run.log'); fs.writeFileSync(src, 'x');
  const hook = path.join(v.dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(v.copyArtifacts([src]));
  assert.ok(!fs.existsSync(path.join(v.dir, 'loose', 'run.log')));
  assert.ok(!fs.existsSync(path.join(v.dir, 'loose', 'run.log.meta.json')));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'lines', 'the earlier save is untouched');
  fs.rmSync(hook);
  // So the retry is a real save, not "already saved".
  const again = await v.copyArtifacts([src]);
  assert.deepEqual(again.copied.map(c => c.rel), [path.join('loose', 'run.log')]);
});

test('an existing repo picked as the Vault gets the push guard, and someone else\'s hook is kept', async () => {
  const dir = tmp('vault-existing-');
  git(dir, 'init', '-q');
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const v = new Vault(dir);
  await v.init();
  assert.match(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8'), /refusing to push/);
  assert.equal(fs.readdirSync(hooks).filter(f => f.startsWith('pre-push.before-vault-')).length, 1);
  assert.equal(git(dir, 'config', '--local', 'core.hooksPath').trim(), fs.realpathSync(hooks));
  await new Vault(dir).init();   // idempotent: no second backup
  assert.equal(fs.readdirSync(hooks).filter(f => f.startsWith('pre-push.before-vault-')).length, 1);
});

test('the listing goes breadth-first, skips heavy folders and says when it is cut short', async () => {
  const v = new Vault(path.join(tmp('vault-'), 'vault'));
  await v.init();
  const deep = path.join(v.dir, 'aaa', 'proto');
  fs.mkdirSync(path.join(deep, 'node_modules', 'x'), { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(deep, `f${i}.txt`), '');
  fs.writeFileSync(path.join(deep, 'node_modules', 'x', 'index.js'), '');
  fs.mkdirSync(path.join(v.dir, 'zzz-ws'));
  fs.writeFileSync(path.join(v.dir, 'zzz-ws', 'mock.svg'), '');
  const all = await v.list();
  assert.equal(all.truncated, false);
  assert.ok(all.items.find(x => x.rel === 'aaa/proto/node_modules').heavy);
  assert.ok(!all.items.some(x => x.rel.includes('node_modules/')), 'not walked');
  const cut = await v.list({ max: 10 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.items.length, 10);
  assert.ok(cut.items.some(x => x.rel === 'zzz-ws/mock.svg'), 'a later area is not starved by a deep one');
  assert.deepEqual(cut.items.slice(0, 3).map(x => x.rel), ['aaa', 'aaa/proto', 'aaa/proto/f0.txt'], 'tree order');
});

test('saving from an event keeps what the event shows; without it, the file as it is now, said so; relative paths are the session\'s', async () => {
  const dir = tmp('vault-ev-');
  const deck = new DeckState(dir);
  const cwd = path.join(dir, 'proj'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'plan.md'), 'changed on disk since');
  const replies = [];
  const send = (res, code, body) => replies.push({ code, body });
  const bodies = [];
  const readBody = async () => { const b = bodies.shift(); if (b instanceof Error) throw b; return b; };
  const table = await loadRoutes(ROUTES, { send, readBody, deck, index: { cwdOf: (id) => id === 's' ? cwd : null } });
  const save = async (body) => { bodies.push(body); await matchRoute(table, 'POST', '/api/vault/save').route.handler({}, {}, {}); return replies.pop(); };

  let r = await save({ path: 'plan.md', content: '# the plan as written', sessionId: 's', eventId: 'e1' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(fs.readFileSync(r.body.path, 'utf8'), '# the plan as written');
  assert.equal(r.body.meta.source.via, 'event');
  assert.equal(r.body.meta.source.path, path.join(cwd, 'plan.md'));
  r = await save({ path: 'plan.md', sessionId: 's', eventId: 'e2' });
  assert.equal(fs.readFileSync(r.body.path, 'utf8'), 'changed on disk since');
  assert.equal(r.body.meta.source.via, 'disk-now');
  assert.equal(path.basename(r.body.path), 'plan-2.md');
  assert.equal((await save({ path: 'plan.md', sessionId: 'unknown' })).code, 400);

  // Bad bodies get 400 and 413, not 500.
  assert.equal((await save(new SyntaxError('Unexpected token'))).code, 400);
  assert.equal((await save(Object.assign(new Error('request too large'), { code: 413 }))).code, 413);
});
