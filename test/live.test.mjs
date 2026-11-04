// The live strip and hook runs: the Claude driver's partial-message and hook
// parsing (against test/fixtures/fake-agent.mjs), lib/live.mjs, and side
// events merged into a session's events by time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ClaudeDriver } from '../lib/harness/claude.mjs';
import { Live, hookEvent, liveView } from '../lib/live.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { liveLine, tail, nextRow, clean } from '../public/livestrip.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deck-live-'));

test('the driver turns partial messages, status and hook runs into events', async () => {
  process.env.CLAUDE_CONFIG_DIR = tmp();
  const cwd = tmp();
  const proc = new ClaudeDriver({ bin: FAKE }).start({ id: '11111111-2222-3333-4444-555555555555', cwd, permissionMode: 'default' });
  const lives = [], statuses = [], hooks = [];
  proc.on('live', (m) => lives.push(m && JSON.parse(JSON.stringify(m))));
  proc.on('status', (s) => statuses.push(s.status));
  proc.on('hook', (h) => hooks.push(h));
  const done = new Promise((r) => proc.on('result', r));
  proc.send('stream please');
  await done;
  proc.stop();
  assert.deepEqual(statuses, ['requesting']);
  assert.deepEqual(hooks.map(h => h.phase), ['started', 'response']);
  assert.equal(hooks[1].stdout, 'lint ok\n');
  assert.equal(hooks[1].exitCode, 0);
  const last = lives.filter(Boolean).at(-1);
  assert.equal(last.msgId, 'msg_stream');
  assert.equal(last.blocks[0].type, 'thinking');
  assert.equal(last.blocks[0].tokens, 42);
  assert.equal(last.blocks[1].text, 'Streaming a reply.');
  assert.equal(lives.at(-1), null, 'the message ending clears it');
});

test('hookEvent: a running hook, a finished one, a failed one', () => {
  const run = hookEvent({ id: 'h', name: 'PostToolUse:Bash', event: 'PostToolUse', phase: 'started', at: 1000 });
  assert.equal(run.id, 'hook-h');
  assert.equal(run.kind, 'system');
  assert.equal(run.subtype, 'hook');
  assert.equal(run.hook.pending, true);
  const ok = hookEvent({ id: 'h', name: 'PostToolUse:Bash', phase: 'response', outcome: 'success', exitCode: 0, stdout: 'fine\n', at: 1250 }, 1000);
  assert.equal(ok.text, 'PostToolUse:Bash\nfine');
  assert.equal(ok.hook.durationMs, 250);
  assert.equal(ok.ts, new Date(1000).toISOString(), 'a hook sits where it started');
  assert.equal(ok.error, undefined);
  const bad = hookEvent({ id: 'h', name: 'Stop', phase: 'response', outcome: 'error', exitCode: 2, stderr: 'nope', at: 2000 }, 1000);
  assert.equal(bad.error, true);
  assert.match(bad.text, /^Stop · error\nnope$/);
});

test('Live: throttled views, requesting cleared by the reply, hooks kept in a side file', async () => {
  const agents = new EventEmitter();
  const pushed = [];
  const index = { pushSide: (id, evs) => pushed.push(...evs.map(e => ({ ...e, sid: id }))) };
  const dir = tmp();
  const live = new Live({ agents, index, dir, throttleMs: 20 });
  assert.equal(typeof index.sideEvents, 'function');
  const updates = [];
  live.on('update', (v) => updates.push(v));
  const proc = new EventEmitter();
  agents.emit('proc', { id: 's1', harness: 'claude', proc });

  proc.emit('status', { status: 'requesting' });
  assert.equal(updates.at(-1).status, 'requesting');
  const msg = { msgId: 'm', blocks: [{ type: 'text', text: 'a'.repeat(1000), tokens: null }], at: 0 };
  proc.emit('live', msg);
  proc.emit('live', msg);
  await new Promise(r => setTimeout(r, 40));
  const v = updates.at(-1);
  assert.equal(v.status, null, 'the reply started, so no longer requesting');
  assert.equal(v.blocks[0].chars, 1000);
  assert.ok(v.blocks[0].text.length <= 601, 'only the tail travels');
  assert.equal(live.snapshot().length, 1);

  proc.emit('hook', { id: 'k', name: 'Stop', event: 'Stop', phase: 'started', at: 5 });
  proc.emit('hook', { id: 'k', name: 'Stop', event: 'Stop', phase: 'response', outcome: 'success', exitCode: 0, stdout: 'ok', at: 9 });
  assert.deepEqual(pushed.map(e => [e.sid, e.hook.pending]), [['s1', true], ['s1', false]]);
  const kept = live.read('s1');
  assert.equal(kept.length, 1, 'only the finished run is kept');
  assert.equal(kept[0].hook.durationMs, 4);

  proc.emit('live', null);
  assert.equal(live.snapshot().length, 0);
  proc.emit('exit', {});
  assert.deepEqual(updates.at(-1), { id: 's1', gone: true });
  assert.deepEqual(live.read('../etc/passwd'), [], 'ids never become paths outside the dir');
});

test('side events load between the transcript records their time falls between', () => {
  const dir = tmp();
  const proj = path.join(dir, 'projects', '-tmp-proj');
  fs.mkdirSync(proj, { recursive: true });
  const rec = (uuid, ts, text) => JSON.stringify({ type: 'user', uuid, timestamp: ts, cwd: '/tmp/proj', sessionId: 'sess-1', message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), [rec('u1', '2026-11-01T10:00:00.000Z', 'first'), rec('u2', '2026-11-01T10:00:10.000Z', 'second')].join('\n') + '\n');
  const idx = new SessionIndex({ claudeDir: dir, recentDays: 3650 });
  idx.sideEvents = (id) => id === 'sess-1' ? [hookEvent({ id: 'k', name: 'Stop', phase: 'response', outcome: 'success', exitCode: 0, at: Date.parse('2026-11-01T10:00:05.000Z') }, Date.parse('2026-11-01T10:00:05.000Z'))] : [];
  idx.scanProjects();
  const evs = idx.load('sess-1').state.events;
  assert.deepEqual(evs.map(e => e.kind === 'system' ? e.subtype : e.text), ['first', 'hook', 'second']);
  const sent = [];
  idx.on('events', (x) => sent.push(x));
  idx.pushSide('sess-1', [hookEvent({ id: 'k2', name: 'Stop', phase: 'started', at: Date.now() })]);
  assert.equal(sent[0].appended[0].id, 'hook-k2');
});

test('liveLine: what the strip shows for each state', () => {
  assert.equal(liveLine(null), null);
  assert.equal(liveLine({ id: 's', status: null, blocks: [] }), null);
  assert.equal(liveLine({ id: 's', status: 'requesting', blocks: [] }).icon, 'i-api');
  assert.equal(liveLine({ id: 's', status: 'compacting', blocks: [] }).icon, 'i-collapse');
  const think = liveLine({ id: 's', thinking: 1500, blocks: [{ type: 'thinking', text: '', tokens: null }] });
  assert.equal(think.count, '~1.5k tokens');
  const tool = liveLine({ id: 's', blocks: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', text: '{"command":"ls' }] });
  assert.equal(tool.head, 'Bash');
  assert.equal(tool.mono, true);
  assert.equal(tail('x'.repeat(300)).length, 161);
  assert.equal(liveView({ id: 's', msg: null, status: 'requesting', thinking: null, at: 1 }).blocks.length, 0);
});

test('nextRow: whole rows, held still until the next one is complete', () => {
  const fit = () => 12;                       // twelve characters a row
  const st = { key: null, start: 0, shown: null };
  const step = (text) => nextRow(st, { key: 'k', chars: text.length, body: text }, fit);
  // Before the first row fills, it fills in place.
  assert.deepEqual(step('hello'), { text: 'hello', fresh: false });
  // Past the first row: it shows whole, ending on a word.
  assert.deepEqual(step('hello there friend'), { text: 'hello there', fresh: true });
  // More text, but the row being written isn't complete: the shown row holds.
  assert.deepEqual(step('hello there friend of'), { text: 'hello there', fresh: false });
  // Several rows completed at once: only the newest complete one shows.
  const r = step('hello there friend of mine, more words follow here');
  assert.equal(r.fresh, true);
  assert.ok(!/here$/.test(r.text) && r.text.length <= 12);
  // A new block starts over.
  assert.deepEqual(nextRow(st, { key: 'k2', chars: 3, body: 'new' }, fit), { text: 'new', fresh: false });
});

test('nextRow: carries on from the tail when it fell behind', () => {
  const st = { key: 'k', start: 0, shown: 'x' };
  const body = '…' + 'abcdefghij'.repeat(3);   // the last 30 of 1000 characters
  const r = nextRow(st, { key: 'k', chars: 1000, body }, () => 10);
  assert.equal(r.fresh, true);
  assert.equal(r.text.length, 10);
  assert.equal(st.start, 990);
  assert.equal(nextRow(st, { key: 'k', chars: 0, body: '' }, () => 10), null);
});

test('clean: a tool call reads as text', () => {
  assert.equal(clean('{"command": "a\\nb \\"c\\""}', true), '{"command": "a b "c""}');
  assert.equal(clean('  two\n lines ', false), 'two lines');
});
