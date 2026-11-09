// The New session dialog's folders for a workstream (public/launchdirs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchDirs, dirLabels } from '../public/launchdirs.js';

const s = (cwd, mtime, slug) => ({ cwd, mtime, workstream: slug ? { slug, title: slug } : null });

test('the workstream\'s folders come first, most recent first; the rest are other', () => {
  const r = launchDirs([s('/a', 1, 'w'), s('/b', 3, 'w'), s('/c', 9, 'x'), s('/a', 2, 'w')], 'w');
  assert.deepEqual(r, { mine: ['/b', '/a'], other: ['/c'] });
});

test('the folder it last launched in leads, even with no session there yet', () => {
  assert.deepEqual(launchDirs([s('/b', 3, 'w')], 'w', { remembered: '/new/' }).mine, ['/new', '/b']);
});

test('no workstream: everything is other, and a remembered folder is ignored', () => {
  assert.deepEqual(launchDirs([s('/a', 1, 'w'), s('/b', 2)], null, { remembered: '/r' }), { mine: [], other: ['/b', '/a'] });
});

test('worktrees are not offered, a slug given as a string counts, and the lists are capped', () => {
  const wt = s('/Users/p/.agent-deck/worktrees/repo/x', 9, 'w');
  const cc = s('/r/.claude/worktrees/y', 9, 'w');
  assert.deepEqual(launchDirs([wt, cc, { cwd: '/a', mtime: 1, workstream: 'w' }], 'w').mine, ['/a']);
  const many = Array.from({ length: 12 }, (_, i) => s(`/d${i}`, i, i < 6 ? 'w' : null));
  const r = launchDirs(many, 'w');
  assert.equal(r.mine.length, 4);
  assert.equal(r.other.length, 6);
});

test('labels are the last folder, with the parent only where two collide', () => {
  assert.deepEqual(dirLabels(['/w/a/app', '/w/b/app', '/w/site', '/']), ['a/app', 'b/app', 'site', '/']);
});
