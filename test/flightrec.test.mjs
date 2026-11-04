import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlight, layoutFlight, sliceFlight, chipHeight, countsOf, flightDigest, fmtAge, contextUsed } from '../public/flightrec.js';

const T0 = Date.parse('2026-11-03T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const ev = (o) => ({ id: `e${++seq}`, seq, sessionId: 's', ...o });
const tool = (s, name, input, extra = {}) => ev({ ts: at(s), kind: 'tool', tool: { name, display: name, kind: 'other', summary: JSON.stringify(input), input, pending: false, ...extra } });
const said = (s, usage) => ev({ ts: at(s), kind: 'text', text: 'ok', usage });
const use = (n) => ({ input_tokens: 10, cache_read_input_tokens: n - 10, cache_creation_input_tokens: 0, output_tokens: 5 });

test('chips: one per event that matters, sized by duration, in order', () => {
  const f = buildFlight([
    ev({ ts: at(0), kind: 'prompt', text: 'do the thing' }),
    ev({ ts: at(1), kind: 'thinking', text: 'hmm' }),
    tool(2, 'Read', { file_path: '/a' }, { durationMs: 200 }),
    tool(3, 'Bash', { command: 'npm test' }, { durationMs: 30_000 }),
    said(40, use(50_000)),
    ev({ ts: at(41), kind: 'turn_end' }),
    ev({ ts: at(41), kind: 'request', request: {} }),
  ], { now: T0 + 60_000 });
  assert.deepEqual(f.chips.map(c => c.kind), ['prompt', 'thinking', 'tool', 'tool', 'text']);
  assert.equal(f.chips[3].dur, 30_000);
  assert.equal(f.chips[3].group, 'bash');
  assert.equal(f.chips[4].dur, 37_000);          // a message is credited with the time since the event before it
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].events, 4);
  assert.equal(f.age, 40_000);                   // not live: first event to last
  // Even slots: a young session is a short stack of thin chips on the left; a full row squeezes.
  assert.deepEqual([layoutFlight(f, 500, 3).slot, layoutFlight(f, 500, 3).end], [3, 15]);
  assert.equal(layoutFlight(f, 10, 3).slot, 2);
  assert.equal(layoutFlight(f, 500).end, 500);
  // Height alone says duration: the strip on a fixed scale, the details scaled to what is in view.
  const strip = { minH: 3, maxH: 18, longest: 600_000 };
  assert.equal(chipHeight(0, strip), 3);
  assert.ok(chipHeight(30_000, strip) > chipHeight(200, strip));
  assert.ok(chipHeight(30_000, strip) < 18);
  assert.equal(chipHeight(30_000, { minH: 2, maxH: 96, longest: 30_000 }), 96);
  assert.equal(chipHeight(3_600_000, strip), 18);
});

test('a running tool grows with the clock; a live session ages to now', () => {
  const f = buildFlight([ev({ ts: at(0), kind: 'prompt', text: 'go' }), tool(5, 'Bash', { command: 'sleep 99' }, { pending: true })], { now: T0 + 25_000, live: true });
  assert.equal(f.chips[1].dur, 20_000);
  assert.equal(f.chips[1].pending, true);
  assert.equal(f.age, 25_000);
});

test('milestones: errors, git, compactions logged and inferred, context thresholds', () => {
  const f = buildFlight([
    ev({ ts: at(0), kind: 'prompt', text: 'ship it' }),
    said(1, use(90_000)),
    tool(2, 'Bash', { command: 'npm test' }, { isError: true, durationMs: 1000 }),
    tool(4, 'Bash', { command: 'git commit -m x && git push' }, { durationMs: 1000 }),
    said(6, use(170_000)),
    ev({ ts: at(7), kind: 'system', subtype: 'compact_boundary', text: 'Conversation compacted', pre: 170_000, trigger: 'auto' }),
    ev({ ts: at(7), kind: 'system', subtype: 'compact_summary', text: 'summary…' }),
    said(8, use(30_000)),                         // follows a logged compaction: not a second one
    said(9, use(150_000)),
    said(10, use(40_000)),                        // a drop nothing logged
    ev({ ts: at(11), kind: 'system', subtype: 'api_error', error: true, text: 'overloaded' }),
  ]);
  const kinds = f.marks.map(m => m.kind);
  assert.equal(f.errors, 2);
  assert.equal(f.compactions, 2);
  assert.equal(kinds.filter(k => k === 'compact').length, 2);
  assert.match(f.marks.find(m => m.kind === 'compact').label, /from 170k \(auto\)/);
  assert.match(f.marks.filter(m => m.kind === 'compact')[1].label, /150k → 40k/);
  assert.equal(kinds.filter(k => k === 'git').length, 1);
  assert.deepEqual(f.marks.filter(m => m.kind === 'ctx').map(m => m.label.match(/\d+%/)[0]), ['50%', '80%']);
  assert.equal(f.window, 200_000);
  assert.equal(f.peak, 170_000);
  assert.equal(f.ctxNow, 40_000);
  assert.equal(f.chips.at(-1).fam, 'err');
  assert.equal(f.chips[2].tool, 'Bash');
  // Sorted by position.
  assert.deepEqual(f.marks.map(m => m.i), [...f.marks.map(m => m.i)].sort((a, b) => a - b));
});

test('context window: reported, named [1m], or inferred from use', () => {
  const evs = [said(0, use(50_000))];
  assert.equal(buildFlight(evs).window, 200_000);
  assert.equal(buildFlight(evs, { model: 'claude-opus-5-5 opus[1m]' }).window, 1_000_000);
  assert.equal(buildFlight([said(0, use(300_000))]).window, 1_000_000);
  // The model's own window (pricing.js): Opus 5.5 has 1M, Haiku 4.5 200k.
  assert.equal(buildFlight([{ ...said(0, use(190_000)), model: 'claude-opus-5-5' }]).window, 1_000_000);
  assert.equal(buildFlight([{ ...said(0, use(50_000)), model: 'claude-haiku-4-5-20251001' }]).window, 200_000);
  const acp = buildFlight([ev({ ts: at(0), kind: 'prompt', text: 'hi' })], { ctxSize: 32_000, ctxUsed: 20_000 });
  assert.equal(acp.window, 32_000);
  assert.equal(acp.ctxNow, 20_000);
  assert.equal(contextUsed({ input_tokens: 0 }), null);
});

test('digest and age read as text', () => {
  const f = buildFlight([ev({ ts: at(0), kind: 'prompt', text: 'fix the bug' }), tool(1, 'Bash', { command: 'npm test' }, { isError: true, durationMs: 4000 })]);
  const d = flightDigest(f);
  assert.match(d, /2 events/);
  assert.match(d, /Turn 1 .*"fix the bug"/);
  assert.match(d, /\[error\]/);
  assert.equal(fmtAge(2 * 3600_000 + 14 * 60_000), '2h 14m');
  assert.equal(fmtAge(26 * 3600_000), '1d 2h');
  assert.equal(buildFlight([]).chips.length, 0);
});

test('sliceFlight: a zoomed run with its own indexes, totals and starting context', () => {
  const f = buildFlight([
    ev({ ts: at(0), kind: 'prompt', text: 'go' }),
    said(1, use(40_000)),
    tool(2, 'Bash', { command: 'npm test' }, { isError: true, durationMs: 5000 }),
    tool(8, 'Read', { file_path: '/a' }, { durationMs: 100 }),
    said(9, use(60_000)),
    tool(10, 'Edit', { file_path: '/a' }, { durationMs: 300 }),
  ]);
  const z = sliceFlight(f, 2, 4);
  assert.deepEqual(z.chips.map(c => c.i), [0, 1, 2]);
  assert.equal(z.offset, 2);
  assert.equal(z.errors, 1);
  assert.deepEqual(z.marks.map(m => [m.kind, m.i]), [['error', 0]]);
  assert.deepEqual(z.samples, [{ i: 0, used: 40_000 }, { i: 2, used: 60_000 }]);   // the level coming in, then its own
  assert.equal(z.start, T0 + 2000);
  assert.equal(z.active, 5000 + 100 + 1000);
  assert.equal(countsOf(z.chips).bash.n, 1);
  // A zoom of a zoom keeps its place in the session.
  assert.equal(sliceFlight(z, 1, 2).offset, 3);
  assert.equal(sliceFlight(f, 4, 1).chips.length, 4);
});
