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
import { UsageTracker, parseUsageReport, parseReset } from '../lib/usage.mjs';
import { Attention, sayFor } from '../lib/attention.mjs';
import { activitySince, milestoneOf, CADENCE } from '../public/activity.js';

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

/** Pretend the last brief landed `ms` ago, past the scheduler's spacing rules. */
function age(briefs, id, ms) { briefs.st.get(id).updatedAt -= ms; }

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
  age(briefs, 'sess-1', CADENCE.minGapMs);
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
  assert.equal(n.calls.length, 1, 'too soon after the last brief');
  age(briefs, 'sess-1', CADENCE.minGapMs);
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 2);
  const b = briefs.publicBrief('sess-1');
  assert.equal(b.brief.summary, 'Brief 2.');
  assert.deepEqual(b.history.map(x => x.brief.summary), ['Brief 1.']);
});

// --- the refresh policy: events that change the story, not a clock

let toolN = 0;
const toolUse = (name, input) => ({ type: 'assistant', uuid: `a${++toolN}`, timestamp: '2026-09-29T06:00:00.000Z',
  message: { id: `m${toolN}`, role: 'assistant', content: [{ type: 'tool_use', id: `tu${toolN}`, name, input }] } });
const toolResult = (n) => ({ type: 'user', uuid: `r${n}`, timestamp: '2026-09-29T06:00:01.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: 'ok' }] } });
function work(st, name, input) { st.ingest(toolUse(name, input)); st.ingest(toolResult(toolN)); }

/** A shown session with one brief written, whose phase the test controls. */
async function briefed(phase = 'working', state = 'running') {
  const { idx } = tempIndex();
  idx.load('sess-1');
  const brief = idx.brief.bind(idx);
  const ctl = { phase, state };
  idx.brief = (id) => ({ ...brief(id), phase: ctl.phase, state: ctl.state });
  let k = 0;
  const n = stubNarrator(() => JSON.stringify({ summary: `Brief ${++k}.` }));
  const briefs = new BriefService({ index: idx, narrator: n });
  briefs.setView('c1', 'sess-1');
  briefs.tick();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n.calls.length, 1);
  const st = idx.loaded.get('sess-1').state;
  const due = (ms = 0) => { if (ms) age(briefs, 'sess-1', ms); return briefs._due('sess-1', idx.loaded.get('sess-1'), briefs.shown().has('sess-1'), Date.now()); };
  return { idx, briefs, n, st, ctl, due };
}

test('activitySince: weighs edits and commands, barely counts reads, spots milestones', () => {
  const st = new SessionState('x');
  const from = st.seq;
  work(st, 'Read', { file_path: '/a.js' });
  work(st, 'Edit', { file_path: '/a.js', old_string: 'a', new_string: 'b' });
  work(st, 'Bash', { command: 'npm test' });
  work(st, 'Bash', { command: 'git add -A && git commit -m "x" && git push' });
  const a = activitySince(st.events, from);
  assert.deepEqual([a.events, a.looks, a.edits, a.commands], [4, 1, 1, 2]);
  assert.equal(a.score, 0.25 + 2 + 1 + 1);
  assert.deepEqual(a.milestones, ['commit']);
  assert.equal(milestoneOf(st.events.at(-1)), 'commit');
  assert.equal(activitySince(st.events, st.seq).events, 0);
});

test('brief policy: mid-turn, reads alone never refresh; a run of edits does, after the drift wait', async () => {
  const { st, due } = await briefed();
  for (let i = 0; i < 20; i++) work(st, 'Read', { file_path: `/f${i}.js` });
  assert.equal(due(CADENCE.minGapMs), null, '20 reads = 5 points: not enough');
  for (let i = 0; i < 6; i++) work(st, 'Edit', { file_path: `/f${i}.js`, old_string: 'a', new_string: 'b' });
  assert.equal(due(), null, 'enough work, but too soon');
  assert.equal(due(CADENCE.driftMs), 'drift');
});

test('brief policy: a long turn with a little work gets the heartbeat', async () => {
  const { st, due } = await briefed();
  work(st, 'Bash', { command: 'npm test' });
  work(st, 'Edit', { file_path: '/a.js', old_string: 'a', new_string: 'b' });
  assert.equal(due(CADENCE.driftMs), null);
  assert.equal(due(CADENCE.heartbeatMs), 'heartbeat');
});

test('brief policy: a commit or push refreshes once the trigger spacing has passed', async () => {
  const { st, due } = await briefed();
  work(st, 'Bash', { command: 'git push origin main' });
  assert.equal(due(CADENCE.minGapMs), null, 'commit right after a brief waits');
  assert.equal(due(CADENCE.triggerGapMs), 'milestone');
});

test('brief policy: a handoff refreshes, a permission prompt does not', async () => {
  const { st, ctl, due } = await briefed();
  work(st, 'Bash', { command: 'ls' });
  ctl.phase = 'turn'; ctl.state = 'needs permission';
  assert.equal(due(CADENCE.minGapMs), null, 'permission prompt: the status line has it');
  ctl.state = 'idle';
  assert.equal(due(), 'handoff');
});

test('brief policy: in the background only handoffs, subagents and slow drift', async () => {
  const { idx, briefs, st, ctl, due } = await briefed();
  briefs.setView('c1', null);
  idx.registry.get = () => ({ alive: true });
  for (let i = 0; i < 10; i++) work(st, 'Edit', { file_path: `/f${i}.js`, old_string: 'a', new_string: 'b' });
  work(st, 'Bash', { command: 'git commit -m x' });
  assert.equal(due(CADENCE.driftMs), null, 'no milestone or 3-minute drift in the background');
  assert.equal(due(CADENCE.backgroundDriftMs), 'drift');
  ctl.phase = 'turn'; ctl.state = 'idle';
  assert.equal(due(), 'handoff');
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
  const closed = idx.snapshot(deck.hidden);
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].hidden, true);
  assert.equal(closed.recent.length, 0);

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

test('Narrator + /usage: quota arrives from a verbose reply and from claude /usage, and calls are counted by purpose', async () => {
  // The CLI path is read when narrator.mjs loads, so run it in a child with the fake CLI.
  const { execFileSync } = await import('node:child_process');
  const script = `import { Narrator } from ${JSON.stringify(path.join(__dirname, '..', 'lib', 'narrator.mjs'))};
    const n = new Narrator(); let q = null; n.onRateLimit = (i) => { q = i; };
    await n.run({ system: 'live brief', prompt: 'Session: x', model: 'haiku', purpose: 'brief' });
    const { readUsageReport, parseUsageReport } = await import(${JSON.stringify(path.join(__dirname, '..', 'lib', 'usage.mjs'))});
    const report = parseUsageReport(await readUsageReport());
    console.log(JSON.stringify({ q, by: n.status().byPurpose, report }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, DECK_CLAUDE_BIN: path.join(__dirname, 'fixtures', 'fake-claude.mjs'), FAKE_5H: '0.61' }, encoding: 'utf8' });
  const { q, by, report } = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(q.unifiedWindows.five_hour.utilization, 0.61);
  assert.equal(by.brief.calls, 1);
  assert.equal(report.windows.find(w => w.key === 'five_hour').utilization, 0.61, 'claude /usage through the same CLI');
  assert.equal(by['quota check'], undefined, 'reading /usage is not a model call');
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

test('parseUsageReport: windows, per-model weeks, resets in their zone, and what drives usage', () => {
  const now = Date.parse('2026-10-03T17:00:00Z');   // 11:00 in America/Boise (UTC-6)
  const r = parseUsageReport(`You are currently using your subscription to power your Claude Code usage

Current session: 44% used · resets Oct 3 at 2:09pm (America/Boise)
Current week (all models): 13% used · resets Oct 7 at 4:59pm (America/Boise)
Current week (Fable): 5% used · resets Oct 7 at 4:59pm (America/Boise)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.

Last 24h · 488 requests · 5 sessions
  79% of your usage was at >150k context
  Top subagents: Explore 3%

Last 7d · 1919 requests · 19 sessions
  74% of your usage was at >150k context`, now);
  assert.match(r.account, /subscription/);
  assert.deepEqual(r.windows.map(w => [w.key, w.utilization]), [['five_hour', 0.44], ['seven_day', 0.13], ['seven_day_fable', 0.05]]);
  assert.equal(r.windows[0].resetsAt, Date.parse('2026-10-03T20:09:00Z'));
  assert.equal(r.windows[1].resetsAt, Date.parse('2026-10-07T22:59:00Z'));
  assert.equal(r.windows[2].label, 'Week (Fable)');
  assert.equal(r.contributors.sections.length, 2);
  assert.deepEqual(r.contributors.sections[0].items, ['79% of your usage was at >150k context', 'Top subagents: Explore 3%']);
  assert.equal(parseUsageReport('/status isn\'t available in this environment.'), null);
  // A bare time is the next one; a date already past rolls to next year.
  assert.equal(parseReset('9:30am (UTC)', now), Date.parse('2026-10-04T09:30:00Z'));
  assert.equal(parseReset('Jan 2 at 1am (UTC)', now), Date.parse('2027-01-02T01:00:00Z'));
});

test('UsageTracker: a /usage report and model-call quota merge per window', () => {
  const u = new UsageTracker();
  const t0 = Date.parse('2026-10-03T10:00:00Z');
  const reset = t0 + 3 * 3600_000;
  u.report({ account: 'Using your subscription', notes: [], contributors: null, windows: [
    { key: 'five_hour', label: 'Session', utilization: 0.40, resetsAt: reset - 30_000 },
    { key: 'seven_day_fable', label: 'Week (Fable)', utilization: 0.05, resetsAt: reset + 86400_000 }] }, t0);
  u.update({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.45, resetsAt: reset / 1000 } } }, 'call', t0 + 20 * 60_000);
  const s = u.snapshot(t0 + 20 * 60_000);
  assert.deepEqual(s.windows.map(w => [w.key, w.utilization]), [['five_hour', 0.45], ['seven_day_fable', 0.05]], 'the call updates its window; the per-model week stays');
  assert.equal(s.windows[0].label, 'Session', 'the label from /usage is kept');
  assert.equal(s.account, 'Using your subscription');
  assert.ok(s.windows[0].pace?.perHour > 0, 'minute-rounded and exact resets count as one window');
});

test('pricing: labels and an estimate per inference', async () => {
  const { modelLabel, costOf, priceOf } = await import('../public/pricing.js');
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(priceOf('claude-haiku-4-5-20251001').context, 200_000);
  assert.equal(costOf('claude-unknown', { input: 1 }), null);
  const c = costOf('claude-opus-5-5', { input: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6, output: 1e6 });
  assert.deepEqual([c.input, c.cacheRead, c.cacheWrite, c.output], [4, 0.2, 4 * 1.25 + 4 * 2, 20]);
  assert.equal(costOf('claude-opus-5-5', { output: 1e6 }, 'fast').output, 40);
});
