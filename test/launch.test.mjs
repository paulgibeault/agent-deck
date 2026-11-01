// lib/launch.mjs: hooks around POST /api/launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onLaunch, beforeLaunch, failedLaunch, afterLaunch } from '../lib/launch.mjs';

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
