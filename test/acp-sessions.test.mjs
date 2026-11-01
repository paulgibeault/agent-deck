// ACP sessions under the deck: acp-events mapping, SessionState.push, and
// AgentManager + AcpDriver against test/fixtures/fake-acp.mjs, through the
// session index the way the server wires them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpEvents } from '../lib/acp-events.mjs';
import { SessionState } from '../lib/transcript.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { AgentManager } from '../lib/agent.mjs';
import { AcpDriver, hopelessRetry } from '../lib/harness/acp.mjs';
import { ClaudeDriver } from '../lib/harness/claude.mjs';
import { loadHarnesses } from '../lib/harnesses.mjs';
import { classify } from '../public/classify.js';
import { activitySince } from '../public/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-acp.mjs');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acp-proj-')));

function until(agents, id, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => { const st = agents.publicState(id()); if (st && pred(st)) { agents.off('change', check); clearTimeout(t); resolve(st); } };
    const t = setTimeout(() => { agents.off('change', check); reject(new Error(`timed out; state: ${JSON.stringify(agents.publicState(id()))}`)); }, ms);
    agents.on('change', check);
    check();
  });
}

/** An AgentManager with a fake ACP harness, wired to a SessionIndex like server.mjs does. */
function deck(t, env = {}, opts = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acp-log-')), 'methods.log');
  const acp = new AcpDriver({ bin: process.execPath, args: [FAKE], label: 'fake acp', env: { ...process.env, FAKE_ACP_LOG: log, ...env } });
  const index = new SessionIndex({ claudeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acp-home-')) });
  const agents = new AgentManager({ drivers: { fake: acp, claude: new ClaudeDriver({ bin: path.join(cwd, 'no-claude') }) }, defaultHarness: 'fake',
    wakeable: (id) => index.files.has(id) ? { cwd: index.cwdOf(id) } : { error: 'unknown session' }, ...opts });
  index.external = () => agents.registryEntries();
  index.deckState = (id) => agents.publicState(id);
  agents.on('stream', ({ id, cwd, title, events, meta }) => index.pushStream(id, { cwd, title, events, meta }));
  agents.on('change', (st) => index.refresh(st.id));
  t.after(() => agents.shutdown());
  return { agents, index, acp, methods: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

test('acp-events: opencode retries become one api_error per turn, updated in place', () => {
  const m = new AcpEvents();
  const retry = (attempt) => m.update({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': attempt == null ? null
    : { attempt, nextRetryAt: new Date(Date.now() + 5000).toISOString(), error: { type: 'provider.internal', message: 'image input is not supported', status: 500 } } } }).events;
  const [a] = retry(1);
  assert.deepEqual(retry(null), [], 'a cleared retry says nothing');
  const [b] = retry(2);
  assert.equal(a.id, b.id);
  assert.equal(b.kind, 'system');
  assert.equal(b.subtype, 'api_error');
  assert.equal(b.error, true);
  assert.equal(b.text, '500 image input is not supported');
  assert.equal(b.retry, 2);
  assert.ok(b.retryInMs > 0 && b.retryInMs <= 5000);
  m.turnEnd({ stopReason: 'cancelled' });
  assert.notEqual(retry(1)[0].id, a.id, 'the next turn gets its own');
  assert.equal(m.update({ sessionUpdate: 'session_info_update', title: 'x' }).events[0].kind, 'raw', 'other session info stays raw');
});

test('acp-events: chunks merge by messageId, tool calls finish in place, usage and config become meta', () => {
  const m = new AcpEvents();
  const a = m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg1', content: { type: 'text', text: 'Hel' } }).events[0];
  const b = m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'msg1', content: { type: 'text', text: 'lo' } }).events[0];
  assert.equal(a.id, b.id);
  assert.equal(b.kind, 'text');
  assert.equal(b.text, 'Hello');
  assert.equal(m.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg1:reasoning:0', content: { type: 'text', text: 'hmm' } }).events[0].kind, 'thinking');

  const file = path.join(cwd, 'hello.txt');
  let ev = m.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'write', title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} }).events[0];
  assert.equal(ev.tool.pending, true);
  ev = m.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', locations: [{ path: file }], rawInput: { path: file, content: 'a\nb' } }).events[0];
  assert.deepEqual(ev.tool.paths, [file]);
  assert.equal(ev.tool.summary, 'hello.txt');
  ev = m.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', locations: [], content: [{ type: 'content', content: { type: 'text', text: 'Created' } }] }).events[0];
  assert.equal(ev.id, 'c1');
  assert.equal(ev.tool.pending, false);
  assert.equal(ev.tool.isError, false);
  assert.equal(ev.tool.result.text, 'Created');
  assert.deepEqual(ev.tool.input, { path: file, content: 'a\nb' }, 'an update that leaves rawInput out keeps the earlier one');
  assert.deepEqual(ev.tool.diff, { file, add: 2, del: 0, oldText: null, newText: 'a\nb' }, 'a write without a diff keeps its content as the new text');
  const bash = m.update({ sessionUpdate: 'tool_call', toolCallId: 'c2', name: 'bash', kind: 'execute', status: 'failed', rawInput: { command: 'ls /nope' }, rawOutput: { error: 'no such dir' } }).events[0];
  assert.equal(bash.tool.command, 'ls /nope');
  assert.equal(bash.tool.isError, true);
  assert.equal(bash.tool.result.text, 'no such dir');

  assert.deepEqual(m.update({ sessionUpdate: 'usage_update', used: 8307, size: 65536, cost: { amount: 0, currency: 'USD' } }).meta,
    { context: { used: 8307, size: 65536 }, cost: { totalCostUSD: 0, currency: 'USD' } });
  assert.deepEqual(m.update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', category: 'mode', currentValue: 'plan' }, { id: 'effort', category: 'thought_level', currentValue: 'low' }] }).meta, { mode: 'plan', effort: 'low' });
  assert.deepEqual(m.update({ sessionUpdate: 'available_commands_update', availableCommands: [] }).events, []);
  assert.equal(m.update({ sessionUpdate: 'plan', entries: [] }).events[0].kind, 'raw', 'unknown updates degrade to raw');
  const end = m.turnEnd({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } });
  assert.equal(end.kind, 'turn_end');
  assert.equal(end.usage.output_tokens, 2);
});

test('SessionState.push: appends, replaces by id, and keeps turns, text, files, errors and usage', () => {
  const st = new SessionState('s');
  const m = new AcpEvents();
  const file = path.join(cwd, 'x.js');
  let r = st.push(m.prompt('do it'));
  assert.equal(r.appended.length, 1);
  assert.equal(st.meta.turns, 1);
  assert.equal(st.meta.inTurn, true);
  st.push(m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'Work' } }).events[0]);
  r = st.push(m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'ing' } }).events[0]);
  assert.equal(r.updated.length, 1);
  assert.equal(r.updated[0].text, 'Working');
  assert.equal(r.updated[0].seq, 2, 'an update keeps its place');
  st.push(m.update({ sessionUpdate: 'tool_call', toolCallId: 't', name: 'edit', kind: 'edit', status: 'in_progress', locations: [{ path: file }], rawInput: { filePath: file } }).events[0]);
  st.push(m.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', content: [] }).events[0]);
  st.push(m.turnEnd({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } }));
  assert.equal(st.events.length, 4);
  assert.equal(st.meta.lastText, 'Working');
  assert.equal(st.meta.inTurn, false);
  assert.equal(st.meta.errors, 1);
  assert.equal(st.meta.usage.output, 3);
  assert.deepEqual(st.filesList().map(f => [f.path, f.writes]), [[file, 1]]);
  assert.equal(st.pushMeta({ model: 'household/qwen', context: { used: 1, size: 2 } }), true);
  assert.equal(st.pushMeta({ model: 'household/qwen' }), false, 'no change, no update');
  assert.equal(st.publicMeta().context.size, 2);
});

test('ACP session: launch, streamed events in the index, a permission answered in the deck, interrupt', async (t) => {
  const { agents, index } = deck(t);
  let id = null; const cur = () => id;
  const st = await agents.launch({ cwd, prompt: 'hello there' });
  id = st.id;
  assert.match(id, /^ses_fake_/, 'the agent assigns the id');
  assert.equal(st.harness, 'fake');
  assert.equal(st.model, 'fake/model');
  await until(agents, cur, s => s.status === 'idle');

  const sum = index.summary(id);
  assert.equal(sum.bucket, 'active');
  assert.equal(sum.harness, 'fake');
  assert.equal(sum.deck.launched, true);
  const kinds = index.events(id).events.map(e => e.kind);
  assert.deepEqual(kinds, ['prompt', 'thinking', 'text', 'turn_end']);
  assert.equal(index.events(id).events[2].text, 'Fake reply to: hello there');
  assert.equal(index.metaOf(id).context.size, 65536);
  assert.equal(index.brief(id).lastText, 'Fake reply to: hello there');
  assert.equal(sum.title, 'hello there', 'the first prompt names it');

  // Permission: the card shows the write and its diff; allowing lets the tool finish.
  agents.send(id, 'needs permission');
  let s = await until(agents, cur, x => x.permissions.length === 1);
  const p = s.permissions[0];
  assert.equal(p.toolName, 'write');
  assert.equal(p.kind, 'edit');
  assert.equal(p.diff.newText, 'hi');
  assert.equal(agents.registryEntries()[0].waiting, 'permission');
  agents.answer(id, p.requestId, 'allow');
  s = await until(agents, cur, x => x.status === 'idle' && !x.permissions.length);
  assert.equal(s.lastResult.stopReason, 'end_turn');
  const tool = index.events(id).events.find(e => e.id === 'call_write_1');
  assert.equal(tool.tool.pending, false);
  assert.equal(tool.tool.isError, false);

  // Deny ends the turn, as opencode does.
  agents.send(id, 'permission again');
  s = await until(agents, cur, x => x.permissions.length === 1);
  agents.answer(id, s.permissions[0].requestId, 'deny');
  s = await until(agents, cur, x => x.status === 'idle' && !x.permissions.length);
  assert.equal(s.lastResult.stopReason, 'cancelled');

  // Interrupt a long turn; queued prompts wait, held.
  agents.send(id, 'slow one');
  agents.send(id, 'after that');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(agents.interrupt(id), true);
  s = await until(agents, cur, x => x.status === 'idle');
  assert.equal(s.lastResult.stopReason, 'cancelled');
  assert.equal(s.held, true);
  agents.queueOp(id, { op: 'resume' });
  s = await until(agents, cur, x => x.status === 'idle' && !x.queue.length && x.turns === 5);
});

test('ACP session: a model error that can only repeat ends the turn as an error, not a retry loop', async (t) => {
  const { agents, index } = deck(t);
  const st = await agents.launch({ cwd, prompt: 'retry with an image' });
  const s = await until(agents, () => st.id, x => x.status === 'idle');
  assert.equal(s.lastResult.isError, true);
  assert.match(s.lastResult.error, /image input is not supported/);
  const evs = index.events(st.id).events;
  const errs = evs.filter(e => e.subtype === 'api_error');
  assert.equal(errs.length, 1, 'one row, not one per attempt');
  assert.equal(errs[0].retry, 1, 'stopped on the first failure');
  assert.equal(errs[0].gaveUp, true);
  assert.match(errs[0].text, /start a new session/i);
  assert.equal(evs.at(-1).text, 'failed');
  assert.equal(index.brief(st.id).signal, 'error');
});

test('ACP session: giving up on a hopeless retry holds the queue, as Stop does', async (t) => {
  const { agents } = deck(t);
  const st = await agents.launch({ cwd, prompt: 'retry with an image' });
  agents.send(st.id, 'and then this');   // queued behind the failing turn
  const s = await until(agents, () => st.id, x => x.status === 'idle');
  assert.equal(s.lastResult.isError, true);
  assert.equal(s.held, true, 'not sent into the same failure');
  assert.deepEqual(s.queue.map(x => x.text), ['and then this']);
});

test('acp-events: a retry the model recovers from stops being an error; a later failure gets its own row', () => {
  const m = new AcpEvents();
  const fail = (attempt) => m.update({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt, nextRetryAt: new Date(Date.now() + 1000).toISOString(), error: { message: 'overloaded', status: 503 } } } }).events[0];
  const a = fail(1);
  const [rec, text] = m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } }).events;
  assert.equal(rec.id, a.id);
  assert.equal(rec.error, false);
  assert.equal(rec.recovered, true);
  assert.equal(text.kind, 'text');
  assert.equal(m.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '!' } }).events.length, 1, 'said once');
  assert.notEqual(fail(1).id, a.id);
});

test('hopelessRetry: what can only repeat, or too many tries', () => {
  assert.equal(hopelessRetry({ status: 500, text: '500 image input is not supported', retry: 1 }), true);
  assert.equal(hopelessRetry({ status: 400, text: '400 bad request', retry: 1 }), true);
  assert.equal(hopelessRetry({ status: 429, text: '429 rate limited', retry: 1 }), false);
  assert.equal(hopelessRetry({ status: 503, text: '503 overloaded', retry: 2 }), false);
  assert.equal(hopelessRetry({ status: 503, text: '503 overloaded', retry: 4 }), true);
});

test('ACP session: an edit and a command arrive as kind-classified tools with diff text', async (t) => {
  const { agents, index } = deck(t);
  const st = await agents.launch({ cwd, prompt: 'edit then run' });
  await until(agents, () => st.id, x => x.status === 'idle');
  const evs = index.events(st.id).events;
  const edit = evs.find(e => e.id === 'call_edit_1').tool;
  assert.equal(edit.kind, 'edit');
  assert.deepEqual([edit.diff.add, edit.diff.del, edit.diff.oldText], [1, 1, 'one\ntwo\nthree\n']);
  const run = evs.find(e => e.id === 'call_bash_1').tool;
  assert.deepEqual([run.kind, run.command], ['execute', 'git commit -m "fake"']);
  assert.deepEqual(classify({ kind: 'tool', tool: run }).intent, 'commit');
  assert.deepEqual(activitySince(evs, 0).milestones, ['commit']);
});

test('ACP session: a turn that ignores the cancel is reported, not shown as stopping forever', async (t) => {
  const { agents } = deck(t, {}, { interruptGraceMs: 100 });
  const st = await agents.launch({ cwd, prompt: 'deaf' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(agents.interrupt(st.id), true);
  let s = await until(agents, () => st.id, x => x.stopFailed);
  assert.equal(s.status, 'busy');
  s = await until(agents, () => st.id, x => x.status === 'idle');
  assert.equal(s.stopFailed, null, 'cleared when the turn ends');
});

test('ACP session: auto mode answers permission for the pilot; plan mode switches the agent', async (t) => {
  const { agents, index } = deck(t);
  const auto = await agents.launch({ cwd, prompt: 'permission please', permissionMode: 'auto' });
  let s = await until(agents, () => auto.id, x => x.status === 'idle');
  assert.equal(s.permissions.length, 0);
  assert.equal(s.lastResult.stopReason, 'end_turn');
  assert.equal(index.events(auto.id).events.find(e => e.id === 'call_write_1').tool.isError, false);

  const plan = await agents.launch({ cwd, prompt: 'look around', permissionMode: 'plan' });
  await until(agents, () => plan.id, x => x.status === 'idle');
  assert.equal(index.metaOf(plan.id).mode, 'plan');
  assert.equal(index.metaOf(auto.id).mode, 'build');
  await assert.rejects(agents.launch({ cwd, prompt: 'x', permissionMode: 'acceptEdits' }), /unknown permission mode/);
});

test('ACP session: stop closes it, a send resumes it under the same id, shutdown closes the agent', async (t) => {
  const { agents, index, methods } = deck(t);
  let id = null; const cur = () => id;
  id = (await agents.launch({ cwd, prompt: 'hello' })).id;
  await until(agents, cur, x => x.status === 'idle');
  agents.stop(id);
  let s = await until(agents, cur, x => x.status === 'exited');
  assert.equal(s.exit.code, 0);
  assert.equal(index.summary(id).alive, false);
  assert.ok(methods().includes('session/close'));

  await agents.send(id, 'are you back?');
  s = await until(agents, cur, x => x.alive && x.status === 'idle');
  assert.equal(s.resumed, true);
  assert.equal(s.harness, 'fake', 'the wake used the harness the session ran under');
  assert.equal(index.summary(id).title, 'hello', 'still named by its first prompt');
  assert.ok(methods().includes('session/resume'));
  assert.ok(index.events(id).events.some(e => e.kind === 'text' && e.text === 'Fake reply to: are you back?'), 'one event list across the restart');

  await agents.shutdown();
  const log = methods();
  assert.deepEqual(log.slice(-2), ['session/close', 'eof'], 'sessions closed before the agent exits');
});

test('ACP session: an agent that cannot start fails the launch with its error', async (t) => {
  const index = new SessionIndex({ claudeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acp-home-')) });
  const agents = new AgentManager({ drivers: { fake: new AcpDriver({ bin: path.join(cwd, 'no-such-acp') }) } });
  t.after(() => agents.shutdown());
  index.external = () => agents.registryEntries();
  await assert.rejects(agents.launch({ cwd, prompt: 'hi' }), /no-such-acp not found/);
});

test('harnesses.json: defaults without a file, entries with one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-harness-'));
  let h = loadHarnesses(dir);
  assert.equal(h.defaultHarness, 'opencode');
  assert.deepEqual(Object.keys(h.drivers), ['claude', 'opencode']);
  assert.deepEqual(h.drivers.opencode.args, ['acp']);
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ default: 'gemini', harnesses: {
    gemini: { type: 'acp', bin: 'gemini', args: ['--experimental-acp'], label: 'Gemini' }, odd: { type: 'nope' } } }));
  h = loadHarnesses(dir);
  assert.equal(h.defaultHarness, 'gemini');
  assert.deepEqual(Object.keys(h.drivers), ['gemini']);
  assert.equal(h.drivers.gemini.label, 'Gemini');
  assert.equal(h.drivers.gemini.actor, 'Gemini');
  assert.equal(h.drivers.gemini.resumeCommand, null, 'no resume command unless the entry gives one');
});

test('harness list: actor and resume command come from the harness', () => {
  const { drivers } = loadHarnesses(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-harness-')));
  const agents = new AgentManager({ drivers, defaultHarness: 'opencode' });
  const list = Object.fromEntries(agents.harnessList().map(x => [x.name, x]));
  assert.equal(list.claude.actor, 'Claude');
  assert.equal(list.claude.type, 'claude');
  assert.equal(list.claude.resumeCommand, 'claude --resume {id}');
  assert.equal(list.opencode.actor, 'opencode');
  assert.equal(list.opencode.type, 'acp');
  assert.equal(list.opencode.resumeCommand, 'opencode -s {id}');
  assert.equal(list.opencode.models, false);
});

test('acp-events: an edit keeps its before/after text; a prompt\'s files are described, not kept', () => {
  const m = new AcpEvents();
  const file = path.join(cwd, 'a.js');
  const ev = m.update({ sessionUpdate: 'tool_call', toolCallId: 'e1', kind: 'edit', status: 'completed', locations: [{ path: file }],
    content: [{ type: 'diff', path: file, oldText: 'a\nb\n', newText: 'a\nc\n' }] }).events[0];
  assert.deepEqual(ev.tool.diff, { file, add: 1, del: 1, created: undefined, oldText: 'a\nb\n', newText: 'a\nc\n' }, 'whole-file texts count only the changed lines');
  const big = 'x'.repeat(300 * 1024);
  const huge = m.update({ sessionUpdate: 'tool_call', toolCallId: 'e2', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: file, oldText: big, newText: big + 'y' }] }).events[0];
  assert.equal(huge.tool.diff.textOmitted, true);
  assert.equal(huge.tool.diff.newText, undefined);
  const p = m.prompt('look', [{ kind: 'image', index: 0, name: 'shot.png', mediaType: 'image/png', bytes: 400 }]);
  assert.equal(p.attachments[0].kept, false);
});
