// lib/briefs.mjs: the brief's shape (Completed · In progress · Planned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../lib/briefs.mjs';

test('brief: three lists, capped and trimmed; next is the first planned item', () => {
  const b = normalize({ summary: ' s ', done: ['a', ' ', 'b', 'c', 'd', 'e', 'f'], doing: ['x', 'y', 'z', 'w'], planned: ['p1', 'p2', 'p3', 'p4', 'p5'] });
  assert.deepEqual(b.done, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(b.doing, ['x', 'y', 'z']);
  assert.deepEqual(b.planned, ['p1', 'p2', 'p3', 'p4']);
  assert.equal('next' in b, false, 'not kept: the brief goes back to the model on each refresh');
});

test('brief: an older reply with one next sentence becomes one planned item; missing lists are empty', () => {
  const b = normalize({ summary: 's', done: ['a'], next: 'write the test' });
  assert.deepEqual(b.doing, []);
  assert.deepEqual(b.planned, ['write the test']);
  assert.deepEqual(normalize({ summary: 's' }).planned, []);
});

test('handoff: the brief goes in as Completed, In progress and Planned, each labelled', async () => {
  const { handoffPrompt } = await import('../lib/handoff.mjs');
  const brief = { summary: 'Half done.', done: ['Added X'], doing: ['Fixing Y'], planned: ['Ship Z'] };
  const text = handoffPrompt({ summary: { cwd: '/r' }, events: [], brief, budget: 20000 });
  assert.match(text, /Completed:\n- Added X/);
  assert.match(text, /In progress:\n- Fixing Y/);
  assert.match(text, /Planned:\n- Ship Z/);
});

test('brief: notes are capped at 3, sorted most urgent first, with unknown kinds read as risks', () => {
  const b = normalize({ summary: 's', notes: [
    { kind: 'decision', text: 'Chose SQLite', seq: 2 },
    { kind: 'question', text: 'Which port?', seq: 9 },
    { kind: 'bogus', text: 'Force-pushed main', seq: 5 },
    { kind: 'failure', text: 'never shown: over the cap', seq: 7 },
    { kind: 'failure', text: ' ' },
  ] });
  assert.deepEqual(b.notes.map(n => `${n.kind}:${n.text}`), ['risk:Force-pushed main', 'question:Which port?', 'decision:Chose SQLite']);
});

test('brief: a note pointing at an event that does not exist keeps its text but loses its link', () => {
  const b = normalize({ summary: 's', notes: [{ kind: 'failure', text: 'Tests fail', seq: 99 }, { kind: 'question', text: 'Ship it?', seq: 3 }] }, new Set([1, 2, 3]));
  assert.deepEqual(b.notes, [{ kind: 'failure', text: 'Tests fail', seq: null }, { kind: 'question', text: 'Ship it?', seq: 3 }]);
  assert.deepEqual(normalize({ summary: 's' }).notes, []);
});
