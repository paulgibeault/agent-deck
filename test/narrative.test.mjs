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
import { UsageTracker } from '../lib/usage.mjs';
import { Attention, sayFor } from '../lib/attention.mjs';

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
    async run(opts) { this.calls.push(opts); return { text: reply(opts.prompt, opts.system), costUsd: 0.001, durationMs: 1 }; },
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

test('BriefService: briefs run without thinking, skip invisible changes and keep history', async () => {
  const { idx } = tempIndex();
  idx.load('sess-1');
  let k = 0;
  const n = stubNarrator(() => JSON.stringify({ summary: `Brief ${++k}.` }));
  const briefs = new BriefService({ index: idx, narrator: n });
  briefs.setView('c1', 'sess-1');
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 1);
  assert.equal(n.calls[0].thinking, false);

  // A sideband record bumps the record count but adds no event the model sees.
  const st = idx.loaded.get('sess-1').state;
  st.ingest({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} });
  assert.equal(briefs.publicBrief('sess-1').stale, true);
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 1, 'no visible change: no call');
  assert.equal(briefs.publicBrief('sess-1').stale, false);

  st.ingest({ type: 'user', message: { role: 'user', content: 'next thing' }, uuid: 'new-2', timestamp: '2026-09-29T06:00:00.000Z' });
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 2);
  const b = briefs.publicBrief('sess-1');
  assert.equal(b.brief.summary, 'Brief 2.');
  assert.deepEqual(b.history.map(x => x.brief.summary), ['Brief 1.']);
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

test('UsageTracker: keeps the latest quota and works out the pace of each window', () => {
  const u = new UsageTracker();
  const t0 = Date.parse('2026-10-03T10:00:00Z');
  const reset = t0 / 1000 + 3 * 3600;
  const info = (five) => ({ status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits',
    unifiedWindows: { five_hour: { utilization: five, resetsAt: reset }, seven_day: { utilization: 0.1, resetsAt: reset + 86400 } } });
  let seen = 0; u.on('usage', () => seen++);
  u.update(info(0.2), 'test', t0);
  let s = u.snapshot(t0);
  assert.equal(s.windows.length, 2);
  assert.equal(s.windows[0].resetsAt, reset * 1000, 'seconds become milliseconds');
  assert.equal(s.windows[0].pace, null, 'one sample: no pace yet');
  u.update(info(0.3), 'test', t0 + 30 * 60_000);
  s = u.snapshot(t0 + 30 * 60_000);
  const p = s.windows.find(w => w.key === 'five_hour').pace;
  assert.ok(Math.abs(p.perHour - 0.2) < 1e-9, '10 points in half an hour');
  assert.ok(Math.abs(p.fullInMs - 3.5 * 3600_000) < 1000, '70 points left at 20 an hour');
  assert.equal(p.hitsBeforeReset, false, 'the reset (2.5h away) comes first');
  assert.equal(seen, 2);
});

test('Narrator: the quota in a verbose reply reaches onRateLimit, and calls are counted by purpose', async () => {
  // The CLI path is read when narrator.mjs loads, so run it in a child with the fake CLI.
  const { execFileSync } = await import('node:child_process');
  const script = `import { Narrator } from ${JSON.stringify(path.join(__dirname, '..', 'lib', 'narrator.mjs'))};
    const n = new Narrator(); let q = null; n.onRateLimit = (i) => { q = i; };
    await n.probe();
    console.log(JSON.stringify({ q, by: n.status().byPurpose }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, DECK_CLAUDE_BIN: path.join(__dirname, 'fixtures', 'fake-claude.mjs'), FAKE_5H: '0.61' }, encoding: 'utf8' });
  const { q, by } = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(q.unifiedWindows.five_hour.utilization, 0.61);
  assert.equal(by['quota check'].calls, 1);
});

test('Attention: signal changes become needs-you entries with a line to speak', () => {
  const a = new Attention();
  const heard = []; a.on('attention', (e) => heard.push(e));
  const sess = (signal, need = null) => [{ id: 's1', title: 'Fix the solver', project: 'p', glance: { signal, need } }];
  a.observe(sess('working'), 1000);
  assert.equal(heard.length, 0, 'first sighting is recorded, not announced');
  a.observe(sess('working'), 2000);
  assert.equal(heard.length, 0, 'no change, no entry');
  a.observe(sess('done'), 2500);
  a.observe(sess('input', { kind: 'question', text: 'Ship it?' }), 2800);
  assert.equal(heard.length, 0, 'a change is held until it settles');
  a.observe(sess('input', { kind: 'question', text: 'Ship it?' }), 3900);
  assert.equal(heard.length, 1, 'the brief "done" never surfaced; only the question');
  assert.equal(heard.at(-1).needsYou, true);
  assert.equal(heard.at(-1).priority, 'high');
  assert.equal(heard.at(-1).say, 'Fix the solver is asking: Ship it?');
  assert.equal(a.needs().length, 1);
  a.observe(sess('done'), 4000);
  a.observe(sess('done'), 5100);
  assert.equal(heard.at(-1).say, 'Fix the solver is done.');
  assert.equal(a.needs().length, 0);
  a.observe([], 6000);
  assert.equal(a.cur.size, 0, 'gone sessions are dropped');
  assert.equal(sayFor('X', 'error', { text: 'npm test failed' }), 'X hit an error: npm test failed.');
});
