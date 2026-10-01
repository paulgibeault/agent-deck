import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionState, parseLine } from '../lib/transcript.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { digest, turnOf } from '../lib/digest.mjs';
import { BriefService } from '../lib/briefs.mjs';
import { extractJson } from '../lib/narrator.mjs';
import { resolveScope, ask } from '../lib/ask.mjs';
import { DeckState } from '../lib/deckstate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'session.jsonl');

function fixtureState() {
  const s = new SessionState('sess-1');
  for (const l of fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)) s.ingest(parseLine(l));
  return s;
}

function tempIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-home-'));
  const proj = path.join(dir, 'projects', '-tmp-proj');
  fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(proj, 'sess-1.jsonl'));
  const idx = new SessionIndex({ claudeDir: dir, recentDays: 3650 });
  idx.scanProjects(); idx.refreshRegistry();
  return { idx, dir, proj };
}

/** A Narrator stand-in: records prompts, replies with `reply(prompt)`. */
function stubNarrator(reply) {
  return {
    briefModel: 'stub', askModel: 'stub', calls: [],
    blocked: () => false,
    async run({ system, prompt, model }) { this.calls.push({ system, prompt, model }); return { text: reply(prompt, system), costUsd: 0.001, durationMs: 1 }; },
  };
}

test('digest: one line per event with #seq, prompts kept when over budget', () => {
  const s = fixtureState();
  const d = digest(s.events);
  assert.match(d, /^#\d+ \d\d:\d\d:\d\d USER: /m);
  assert.match(d, / TOOL Bash .* → /);
  assert.ok(!/thinking/i.test(d.split('\n').find(l => l.includes('ASSISTANT')) || ''), 'thinking is not digested');
  const small = digest(s.events, 300);
  assert.ok(small.length <= 300);
  assert.match(small, /USER:/, 'the prompt survives a tight budget');
});

test('turnOf: spans the prompt through its turn end', () => {
  const s = fixtureState();
  const tool = s.events.find(e => e.kind === 'tool');
  const turn = turnOf(s.events, tool.seq);
  assert.equal(turn[0].kind, 'prompt');
  assert.equal(turn.at(-1).kind, 'turn_end');
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json'), null);
});

test('BriefService: shown session gets a brief once, then only on new records', async () => {
  const { idx } = tempIndex();
  idx.load('sess-1');
  const n = stubNarrator(() => JSON.stringify({
    summary: 'Fixed the solver test.', done: ['ran tests'], now: 'idle', next: null,
    progress: { unit: 'tests', segments: [{ label: 'passing', count: 3, tone: 'done' }, { label: 'bogus', count: 0, tone: 'nope' }] },
    watch: { text: 'one flaky test', seq: 4 },
  }));
  const briefs = new BriefService({ index: idx, narrator: n });
  const updates = [];
  briefs.on('brief', (b) => updates.push(b));

  briefs.tick();
  assert.equal(n.calls.length, 0, 'not shown and not live: paused');

  briefs.setView('c1', 'sess-1');
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 1);
  assert.match(n.calls[0].prompt, /Transcript to date:/);
  const b = briefs.publicBrief('sess-1');
  assert.equal(b.brief.summary, 'Fixed the solver test.');
  assert.deepEqual(b.brief.progress, { unit: 'tests', total: 3, segments: [{ label: 'passing', count: 3, tone: 'done' }] });
  assert.deepEqual(b.brief.watch, { text: 'one flaky test', seq: 4 });
  assert.equal(b.stale, false);
  assert.ok(updates.some(u => u.pending) && updates.at(-1).pending === false);

  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 1, 'nothing new: no call');

  // New activity: the next refresh is incremental.
  idx.loaded.get('sess-1').state.ingest({ type: 'user', message: { role: 'user', content: 'and now the docs' }, uuid: 'new-1', timestamp: '2026-09-29T06:00:00.000Z' });
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 2);
  assert.match(n.calls[1].prompt, /Previous brief \(update it\):/);
  assert.match(n.calls[1].prompt, /Events since the previous brief \(1\):[\s\S]*and now the docs/);
});

test('BriefService: a reply that is not a brief is reported, not stored', async () => {
  const { idx } = tempIndex();
  idx.load('sess-1');
  const briefs = new BriefService({ index: idx, narrator: stubNarrator(() => 'sorry, no') });
  briefs.refresh('sess-1');
  await new Promise(r => setTimeout(r, 10));
  const b = briefs.publicBrief('sess-1');
  assert.equal(b.brief, null);
  assert.match(b.error, /not a brief/);
});

test('ask: resolves scope items and sends them labelled', async () => {
  const { idx } = tempIndex();
  const entry = idx.load('sess-1');
  const tool = entry.state.events.find(e => e.kind === 'tool' && e.tool.name === 'Bash');
  const n = stubNarrator(() => 'It failed because of X.');
  const briefs = new BriefService({ index: idx, narrator: n });
  const blocks = resolveScope(idx, briefs, [
    { kind: 'event', sessionId: 'sess-1', eventId: tool.id, label: 'Output' },
    { kind: 'turn', sessionId: 'sess-1', eventId: tool.id },
    { kind: 'text', label: 'Files', text: 'a.js\nb.js' },
    { kind: 'event', sessionId: 'sess-1', eventId: 'nope' },
  ]);
  assert.deepEqual(blocks.map(b => b.label), ['Output', 'The turn it belongs to', 'Files']);
  assert.match(blocks[0].text, /Tool: Bash/);
  const r = await ask({ index: idx, briefs, narrator: n, question: 'why?', scope: [{ kind: 'text', label: 'Files', text: 'a.js' }], sessionId: 'sess-1' });
  assert.equal(r.answer, 'It failed because of X.');
  assert.match(n.calls[0].prompt, /=== THE ITEM: Files ===\na\.js[\s\S]*=== QUESTION ===\nwhy\?$/);
  await assert.rejects(ask({ index: idx, briefs, narrator: n, question: 'q', scope: [] }), /nothing to ask about/);
});

test('DeckState: hide persists; trash moves transcript and sidecar dir; index forgets', () => {
  const { idx, proj } = tempIndex();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-state-'));
  const deck = new DeckState(stateDir);
  deck.setHidden('sess-1', true);
  assert.equal(new DeckState(stateDir).hidden.has('sess-1'), true);
  assert.equal(idx.snapshot(deck.hidden).hidden.length, 1);
  assert.equal(idx.snapshot(deck.hidden).recent.length, 0);

  const dest = deck.trashSession('sess-1', idx.fileOf('sess-1'));
  assert.ok(!fs.existsSync(path.join(proj, 'sess-1.jsonl')));
  assert.ok(!fs.existsSync(path.join(proj, 'sess-1')));
  assert.ok(fs.existsSync(path.join(dest, 'sess-1.jsonl')));
  assert.ok(fs.existsSync(path.join(dest, 'sess-1', 'subagents')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'origin.json'), 'utf8')).id, 'sess-1');
  assert.equal(deck.hidden.has('sess-1'), false);
  idx.forget('sess-1');
  const snap = idx.snapshot();
  assert.equal(snap.recent.length + snap.closed.length + snap.active.length, 0);
});
