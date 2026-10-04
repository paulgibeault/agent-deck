import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnChanges, editOps } from '../public/changes.js';
import { SessionState } from '../lib/transcript.mjs';

const tool = (id, name, input, diff, extra = {}) => ({ id, kind: 'tool', ts: `2026-10-03T10:00:0${id.length}Z`, tool: { name, input, diff, pending: false, ...extra } });

test('turnChanges groups edits by turn and file, newest turn first', () => {
  const events = [
    { id: 'p1', kind: 'prompt', text: 'first', ts: 't1' },
    tool('e1', 'Edit', { file_path: '/r/a.js' }, { file: '/r/a.js', add: 2, del: 1 }),
    tool('e2', 'Edit', { file_path: '/r/a.js' }, { file: '/r/a.js', add: 1, del: 0 }),
    tool('w1', 'Write', { file_path: '/r/lib/b.md' }, { file: '/r/lib/b.md', add: 5, del: 0, created: true }),
    { id: 'p2', kind: 'prompt', text: 'second', ts: 't2' },
    tool('r1', 'Read', { file_path: '/r/a.js' }),
    tool('s1', 'Bash', { command: 'sed -i "" s/a/b/ x.js', description: 'Swap' }),
    { id: 'p3', kind: 'prompt', text: 'third (nothing changed)', ts: 't3' },
    tool('x1', 'Edit', { file_path: '/r/c.js' }, { file: '/r/c.js', add: 1, del: 1 }, { isError: true }),
  ];
  const turns = turnChanges(events, '/r');
  assert.deepEqual(turns.map(t => t.n), [2, 1]);              // turn 3 changed nothing (its edit failed)
  const [t2, t1] = turns;
  assert.equal(t2.files.length, 0); assert.equal(t2.shell[0].id, 's1');
  assert.deepEqual(t1.files.map(f => [f.rel, f.add, f.del, f.edits.length, f.created]), [['a.js', 3, 1, 2, false], ['lib/b.md', 5, 0, 1, true]]);
  assert.deepEqual([t1.add, t1.del], [8, 1]);
});

test('editOps builds hunks from the full result, or falls back to the input', () => {
  const ev = { tool: { name: 'Edit', input: { old_string: 'a\nb', new_string: 'a\nc' } } };
  const fromPatch = editOps(ev, { toolUseResult: { structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' a', '-b', '+c'] }] } });
  assert.deepEqual(fromPatch.map(o => [o.t, o.an ?? null, o.bn ?? null]), [['hunk', null, null], ['eq', 10, 10], ['del', 11, null], ['add', null, 11]]);
  assert.deepEqual(editOps(ev, null).map(o => o.t), ['eq', 'del', 'add']);
  const created = editOps({ tool: { name: 'Write', input: {} } }, { toolUseResult: { type: 'create', content: 'x\ny\n' } });
  assert.deepEqual(created.map(o => o.t), ['hunk', 'add', 'add']);
});

test('the transcript records line counts on file edits', () => {
  const s = new SessionState('s');
  s.ingest({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-03T10:00:00Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/r/a.js', old_string: 'b', new_string: 'c' } }] } });
  s.ingest({ type: 'user', uuid: 'u1', timestamp: '2026-10-03T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    toolUseResult: { filePath: '/r/a.js', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-b', '+c', '+d'] }] } });
  assert.deepEqual(s.events.find(e => e.id === 'tu1').tool.diff, { file: '/r/a.js', add: 2, del: 1, created: undefined });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TurnSnapshots } from '../lib/turnsnap.mjs';

test('turn snapshots capture any change between a prompt and its turn end, without touching the index', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-snap-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'mine\n'); g('add', 'staged.txt');          // the user's own staging
  const indexBefore = g('diff', '--cached', '--name-only');
  const snaps = new TurnSnapshots({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-')) });

  await snaps.observe('s', repo, [{ id: 'p1', kind: 'prompt', ts: 't1' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');                           // as a script would
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'export {}\n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  const live = await snaps.changes('s', repo);
  assert.equal(live.turns.p1.live, true);                                                    // in progress: diffed against now
  await snaps.observe('s', repo, [{ id: 'e1', kind: 'turn_end', ts: 't2' }]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'after the turn\n');                            // not this turn's

  const { turns } = await snaps.changes('s', repo);
  const files = Object.fromEntries(turns.p1.files.map(f => [f.path, [f.status, f.add, f.del]]));
  assert.deepEqual(files, { 'a.txt': ['M', 2, 1], 'gone.txt': ['D', 0, 1], 'src/new.js': ['A', 1, 0] });
  const d = await snaps.diff('s', repo, 'p1', 'a.txt');
  assert.match(d.diff, /^-two$/m); assert.match(d.diff, /^\+TWO$/m); assert.doesNotMatch(d.diff, /after the turn/);
  assert.equal(g('diff', '--cached', '--name-only'), indexBefore);                           // user's index untouched
  fs.rmSync(repo, { recursive: true, force: true });
});
