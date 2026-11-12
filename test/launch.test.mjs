// lib/launch.mjs: hooks around POST /api/launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onLaunch, beforeLaunch, failedLaunch, afterLaunch, resolveCwd, folderState, makeFolder, unmakeFolder } from '../lib/launch.mjs';

test('launch hooks: before patches the body in order, after sees the result, a failing after is logged only', async (t) => {
  const seen = [];
  const offs = [
    onLaunch({ before: (b) => b.worktree ? { cwd: `${b.cwd}/wt` } : null }),
    onLaunch({ before: (b) => ({ prompt: `[brief]\n${b.prompt}`, cwdSeen: b.cwd }), after: (st, b) => seen.push([st.id, b.ws]) }),
    onLaunch({ after: () => { throw new Error('feature bug'); } }),
  ];
  t.after(() => offs.forEach(off => off()));
  t.mock.method(console, 'error', () => {});
  const body = await beforeLaunch({ cwd: '/r', prompt: 'go', worktree: true, ws: 'deck' });
  assert.equal(body.cwd, '/r/wt');
  assert.equal(body.cwdSeen, '/r/wt', 'each hook sees what the ones before it left');
  assert.equal(body.prompt, '[brief]\ngo');
  await afterLaunch({ id: 's1' }, body);
  assert.deepEqual(seen, [['s1', 'deck']]);
});

test('launch hooks: a before that throws stops the launch', async (t) => {
  const off = onLaunch({ before: () => { throw new Error('no base chosen'); } });
  t.after(off);
  await assert.rejects(beforeLaunch({ cwd: '/r', prompt: 'go' }), /no base chosen/);
});

test('launch hooks: failed lets a before undo what it made', async (t) => {
  const made = new Set();
  const off = onLaunch({ before: (b) => { made.add('wt'); return { cwd: '/r/wt' }; }, failed: (b, err) => { assert.match(err.message, /did not start/); made.delete('wt'); } });
  t.after(off);
  const body = await beforeLaunch({ cwd: '/r', prompt: 'go' });
  assert.ok(made.has('wt'));
  await failedLaunch(body, new Error('the CLI did not start'));
  assert.equal(made.size, 0);
});

test('launch hooks: a later before that throws undoes the earlier ones', async (t) => {
  const made = new Set();
  const offs = [
    onLaunch({ before: () => { made.add('wt'); return { cwd: '/r/wt' }; }, failed: () => made.delete('wt') }),
    onLaunch({ before: () => { throw new Error('unknown workstream'); } }),
  ];
  t.after(() => offs.forEach(off => off()));
  await assert.rejects(beforeLaunch({ cwd: '/r', prompt: 'go' }), /unknown workstream/);
  assert.equal(made.size, 0, 'the worktree the first hook made was undone');
});

test('launch folder: ~ is home, a relative path is refused', () => {
  assert.equal(resolveCwd('~/work/new/', '/Users/p'), '/Users/p/work/new');
  assert.equal(resolveCwd('~', '/Users/p'), '/Users/p');
  assert.equal(resolveCwd(' /a/b/../c '), '/a/c');
  assert.equal(resolveCwd('work/new'), null);
  assert.equal(resolveCwd(''), null);
});

test('launch folder: a missing folder is made with its parents, and unmade only while empty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'file'), 'x');
  assert.equal(folderState(root), 'dir');
  assert.equal(folderState(path.join(root, 'a', 'b')), 'missing');
  assert.equal(folderState(path.join(root, 'file')), 'blocked');
  assert.equal(folderState(path.join(root, 'file', 'sub')), 'blocked');

  const made = makeFolder(path.join(root, 'a', 'b'));
  assert.deepEqual(made, [path.join(root, 'a', 'b'), path.join(root, 'a')]);
  assert.equal(folderState(path.join(root, 'a', 'b')), 'dir');
  unmakeFolder(made);
  assert.ok(!fs.existsSync(path.join(root, 'a')));

  const again = makeFolder(path.join(root, 'a', 'b'));
  fs.writeFileSync(path.join(root, 'a', 'b', 'kept'), 'x');
  unmakeFolder(again);
  assert.ok(fs.existsSync(path.join(root, 'a', 'b', 'kept')), 'a folder something was written to stays');
});
