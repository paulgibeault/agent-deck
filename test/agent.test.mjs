// Deck-launched sessions against test/fixtures/fake-agent.mjs: launch,
// queue pumping, permission prompts, interrupt, exit reporting, and the
// index picking the transcript up as a live session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager, messageContent, normalizeAttachments, wireText } from '../lib/agent.mjs';
import { promptParts } from '../lib/transcript.mjs';
import { SessionIndex } from '../lib/sessions.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-'));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-proj-')));
process.env.CLAUDE_CONFIG_DIR = claudeDir;

function until(agents, id, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => { const st = agents.publicState(id); if (st && pred(st)) { agents.off('change', check); clearTimeout(t); resolve(st); } };
    const t = setTimeout(() => { agents.off('change', check); reject(new Error(`timed out; state: ${JSON.stringify(agents.publicState(id))}`)); }, ms);
    agents.on('change', check);
    check();
  });
}

test('launch, queue, permission, interrupt, stop', async (t) => {
  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());

  const st = await agents.launch({ cwd, prompt: 'hello there' });
  assert.equal(st.alive, true);
  assert.equal(st.status, 'busy');
  const id = st.id;
  assert.equal(agents.registryEntries()[0].kind, 'deck');

  await until(agents, id, s => s.status === 'idle');
  assert.equal(agents.publicState(id).lastResult.subtype, 'success');

  // Queue while busy: only the head goes out, the rest waits and can be reordered.
  agents.send(id, 'slow one');
  const b = agents.send(id, 'second');
  const c = agents.send(id, 'third');
  assert.deepEqual(agents.publicState(id).queue.map(x => x.text), ['second', 'third']);
  agents.queueOp(id, { op: 'up', itemId: c.id });
  assert.deepEqual(agents.publicState(id).queue.map(x => x.text), ['third', 'second']);
  agents.queueOp(id, { op: 'remove', itemId: b.id });

  // Interrupt ends the slow turn and holds the queue.
  assert.equal(agents.interrupt(id), true);
  let s = await until(agents, id, x => x.status === 'idle');
  assert.equal(s.held, true);
  assert.equal(s.queue.length, 1);
  agents.queueOp(id, { op: 'resume' });
  await until(agents, id, x => x.status === 'busy');
  s = await until(agents, id, x => x.status === 'idle' && !x.queue.length);

  // A prompt being edited is not sent when the turn ends; saving the edit sends the new text.
  agents.send(id, 'slow one');
  const e = agents.send(id, 'old wording');
  agents.queueOp(id, { op: 'editing', itemId: e.id });
  assert.equal(agents.publicState(id).editing, e.id);
  agents.interrupt(id);
  s = await until(agents, id, x => x.status === 'idle');
  agents.queueOp(id, { op: 'resume' });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(agents.publicState(id).queue.map(x => x.text), ['old wording'], 'held back while editing');
  agents.queueOp(id, { op: 'edit', itemId: e.id, text: 'new wording' });
  s = await until(agents, id, x => x.status === 'idle' && !x.queue.length && !x.editing);

  // Send now cuts the running turn short and sends everything queued, plus the new prompt, as one message.
  agents.send(id, 'slow one');
  agents.send(id, 'queued one');
  agents.send(id, 'queued two');
  agents.sendNow(id, 'urgent');
  s = await until(agents, id, x => x.status === 'busy' && !x.queue.length && !x.interrupting);
  assert.equal(s.held, false);
  s = await until(agents, id, x => x.status === 'idle' && !x.queue.length);
  // With nothing typed, Send now sends what is queued; with nothing at all, it refuses.
  agents.send(id, 'slow one');
  agents.send(id, 'only the queue');
  agents.sendNow(id, '');
  s = await until(agents, id, x => x.status === 'busy' && !x.queue.length && !x.interrupting);
  s = await until(agents, id, x => x.status === 'idle' && !x.queue.length);
  assert.throws(() => agents.sendNow(id, '  '), /nothing to send/);

  // Permission prompt waits for the pilot.
  agents.send(id, 'needs permission');
  s = await until(agents, id, x => x.permissions.length === 1);
  assert.equal(agents.registryEntries()[0].waiting, 'permission');
  const p = s.permissions[0];
  assert.equal(p.toolName, 'Bash');
  assert.equal(p.input.command, 'rm -rf build');
  agents.answer(id, p.requestId, 'always');
  s = await until(agents, id, x => x.status === 'idle' && !x.permissions.length);

  const lines = fs.readFileSync(path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`), 'utf8');
  assert.match(lines, /will not ask again/);
  assert.match(lines, /"content":"new wording"/);
  assert.doesNotMatch(lines, /"content":"old wording"/);
  assert.match(lines, /"content":"queued one\\n\\nqueued two\\n\\nurgent"/);
  assert.match(lines, /"content":"only the queue"/);

  // The index sees it as a live, idle session.
  const index = new SessionIndex({ claudeDir });
  index.external = () => agents.registryEntries();
  index.deckState = (x) => agents.publicState(x);
  index.start(); t.after(() => index.stop());
  const sum = index.summary(id);
  assert.equal(sum.bucket, 'active');
  assert.equal(sum.deck.launched, true);
  assert.equal(index.brief(id).phase, 'turn');

  agents.stop(id);
  s = await until(agents, id, x => x.status === 'exited');
  assert.equal(s.exit.code, 0);
  index.refreshRegistry();
  assert.equal(index.summary(id).bucket, 'recent');
});

test('launch failure surfaces the CLI error', async (t) => {
  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());
  const st = await agents.launch({ cwd, prompt: 'crash now' });
  const s = await until(agents, st.id, x => x.status === 'exited');
  assert.equal(s.exit.code, 3);
  assert.match(s.exit.stderr, /crashed on purpose/);
  await assert.rejects(() => agents.launch({ cwd: path.join(cwd, 'nope'), prompt: 'x' }), /not a directory/);
});

test('sending to a session that is not running resumes it; queued prompts outlive the backend', async (t) => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-store-')), 'agents.json');
  const wakeable = (id) => id === 'sub-1' ? { error: 'subagents take their prompts from the parent session' } : { cwd };
  const agents = new AgentManager({ bin: FAKE, store, wakeable });
  t.after(() => agents.stopAll());
  let st = await agents.launch({ cwd, prompt: 'hello', permissionMode: 'acceptEdits' });
  const id = st.id;
  await until(agents, id, x => x.status === 'idle');
  agents.stop(id);
  await until(agents, id, x => x.status === 'exited');

  // A plain send starts it again, with the mode it last ran with and the model passed in.
  const item = await agents.send(id, 'are you back?', undefined, { model: 'haiku' });
  assert.equal(item.text, 'are you back?');
  st = await until(agents, id, x => x.alive && x.status === 'idle');
  assert.equal(st.resumed, true);
  assert.equal(st.permissionMode, 'acceptEdits');
  assert.equal(st.model, 'haiku');
  await assert.rejects(async () => agents.send('sub-1', 'x'), /parent session/);

  // Queue behind a slow turn, then the backend goes away: the queue is saved.
  agents.send(id, 'slow one');
  agents.send(id, 'queued a');
  agents.send(id, 'queued b');
  await until(agents, id, x => x.status === 'busy' && x.queue.length === 2);
  agents.flush(); agents.stopAll();
  await until(agents, id, x => x.status === 'exited');

  // A new manager (the restarted backend) holds them until play.
  const again = new AgentManager({ bin: FAKE, store, wakeable });
  t.after(() => again.stopAll());
  st = again.publicState(id);
  assert.deepEqual(st.queue.map(x => x.text), ['queued a', 'queued b']);
  assert.equal(st.held, true);
  assert.equal(st.alive, false);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(again.publicState(id).alive, false, 'nothing starts on its own');
  // Play starts it with the first; the second follows when that turn ends.
  await again.queueOp(id, { op: 'resume' });
  st = await until(again, id, x => x.alive && x.status === 'idle' && !x.queue.length);
  assert.equal(st.turns, 2);

  // An idle process ends by itself; that is not an error.
  const quick = new AgentManager({ bin: FAKE, wakeable, idleMs: 150 });
  t.after(() => quick.stopAll());
  const q = await quick.launch({ cwd, prompt: 'hi' });
  st = await until(quick, q.id, x => x.status === 'exited');
  assert.equal(st.endedIdle, true);
  assert.equal(st.exit.code, 0);
});

test('missing binary rejects launch', async () => {
  const agents = new AgentManager({ bin: path.join(cwd, 'no-such-claude') });
  await assert.rejects(() => agents.launch({ cwd, prompt: 'hi' }), /not found|ENOENT/);
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('attachments: content blocks out, descriptors back, data kept off the wire', async (t) => {
  const files = normalizeAttachments([
    { name: 'shot.png', mediaType: 'image/png', data: PNG },
    { name: 'notes.md', mediaType: 'text/markdown', data: Buffer.from('# hi').toString('base64') },
  ]);
  const content = messageContent('look at these', files);
  assert.deepEqual(content.map(b => b.type), ['image', 'text', 'text']);
  assert.equal(content[1].text, 'Attached file notes.md:\n\n# hi');
  assert.equal(messageContent('plain', []), 'plain');
  const parts = promptParts(content);
  assert.equal(parts.text, 'look at these');
  assert.deepEqual(parts.attachments.map(a => [a.kind, a.index, a.name ?? a.mediaType]), [['image', 0, 'image/png'], ['text', 1, 'notes.md']]);
  assert.throws(() => normalizeAttachments([{ name: 'x.zip', mediaType: 'application/zip', data: 'AAAA' }]), /cannot be attached/);
  assert.throws(() => normalizeAttachments([{ name: 'big.png', mediaType: 'image/png', data: 'A'.repeat(8 << 20) }]), /too large/);

  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());
  const st = await agents.launch({ cwd, prompt: '', attachments: [{ name: 'shot.png', mediaType: 'image/png', data: PNG }] });
  await until(agents, st.id, x => x.status === 'idle');
  agents.send(st.id, 'slow one');
  const item = agents.send(st.id, 'with a picture', [{ name: 'shot.png', mediaType: 'image/png', data: PNG }]);
  assert.deepEqual(item.attachments, [{ name: 'shot.png', mediaType: 'image/png', size: 68 }]);
  assert.doesNotMatch(JSON.stringify(agents.publicState(st.id)), new RegExp(PNG.slice(0, 20)));
  agents.interrupt(st.id); await until(agents, st.id, x => x.status === 'idle');
  agents.queueOp(st.id, { op: 'resume' });
  await until(agents, st.id, x => x.status === 'idle' && !x.queue.length && x.turns === 3);
  const lines = fs.readFileSync(path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${st.id}.jsonl`), 'utf8');
  assert.match(lines, /Fake reply to: with a picture \(with 1 attachment\)/);
  assert.match(lines, /"type":"image"/);
});

test('subagents: live state, messages relayed by the session, stop_task, no idle end while one runs', async (t) => {
  const agents = new AgentManager({ bin: FAKE, idleMs: 300 });
  t.after(() => agents.stopAll());
  const { id } = await agents.launch({ cwd, prompt: 'start a background agent' });
  let st = await until(agents, id, s => s.status === 'idle' && s.subagents.afake0001);
  assert.deepEqual({ status: st.subagents.afake0001.status, activity: st.subagents.afake0001.activity }, { status: 'running', activity: 'Running Fake step' });

  // Idle with a subagent still running: the process stays up.
  await new Promise(r => setTimeout(r, 600));
  assert.equal(agents.publicState(id).alive, true);

  // A message for the subagent goes out as a relay request, and the queue says who it is for.
  agents.send(id, 'slow one');
  const item = agents.send(id, 'also check the README', undefined, { to: { id: 'afake0001', title: 'Fake helper' } });
  assert.deepEqual(item.to, { id: 'afake0001', title: 'Fake helper' });
  assert.deepEqual(agents.publicState(id).queue[0].to, { id: 'afake0001', title: 'Fake helper' });
  assert.throws(() => agents.send(id, 'see this', [{ name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('x').toString('base64') }], { to: { id: 'afake0001' } }), /cannot carry attachments/);
  agents.interrupt(id);
  await until(agents, id, s => s.status === 'idle' && s.held);
  agents.queueOp(id, { op: 'resume' });
  await until(agents, id, s => s.status === 'idle' && !s.queue.length);
  const file = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  const prompts = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'last-prompt').map(r => r.lastPrompt);
  assert.match(prompts.at(-1), /SendMessage \(to: "afake0001"[;)]/);
  assert.match(prompts.at(-1), /also check the README$/);

  // stop_task ends the subagent alone; an unknown task is the CLI's error.
  assert.equal(await agents.stopTask(id, 'afake0001'), true);
  st = await until(agents, id, s => s.subagents.afake0001?.status === 'stopped');
  assert.equal(st.subagents.afake0001.activity, null);
  await assert.rejects(agents.stopTask(id, 'nope'), /No task found/);
  // Nothing left running: the idle end applies again.
  await until(agents, id, s => !s.alive, 3000);
});

test('wireText: prompts pass through, a subagent message asks for a verbatim relay', () => {
  assert.equal(wireText({ text: 'hi' }), 'hi');
  const w = wireText({ text: 'do X', to: { id: 'a1', title: 'Helper' } });
  assert.match(w, /^\[agent-deck\] .*"Helper" \(agent id a1\).*SendMessage \(to: "a1"[;)]/);
  assert.ok(w.endsWith('\n\ndo X'));
});

test('send now merges only the session\'s own prompts; messages for subagents stay separate relays', async (t) => {
  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());
  const { id } = await agents.launch({ cwd, prompt: 'slow one' });
  await until(agents, id, s => s.status === 'busy');
  const to = { id: 'afake0001', title: 'Fake helper' };
  agents.send(id, 'for the helper', undefined, { to });
  agents.send(id, 'queued for the session');
  assert.throws(() => agents.sendNow(id, 'now, helper', undefined, { to }), /queued/);
  const merged = agents.sendNow(id, 'typed now');
  assert.equal(merged.text, 'queued for the session\n\ntyped now');
  assert.equal(merged.to, undefined);
  const q = agents.publicState(id).queue;
  assert.deepEqual(q.map(x => x.to?.id || null), [null, 'afake0001'], 'the relay waits behind the merged prompt');
});

test('features can listen to a launched session\'s process', async (t) => {
  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());
  const seen = [];
  agents.on('proc', ({ id, harness, proc }) => { seen.push({ id, harness }); proc.on('result', () => seen.push('result')); });
  const st = await agents.launch({ cwd, prompt: 'hello' });
  assert.deepEqual(seen[0], { id: st.id, harness: 'claude' });
  await until(agents, st.id, s => s.status === 'idle');
  assert.ok(seen.includes('result'));
});

test('a proc listener that throws does not break the launch', async (t) => {
  const agents = new AgentManager({ bin: FAKE });
  t.after(() => agents.stopAll());
  t.mock.method(console, 'error', () => {});
  agents.on('proc', () => { throw new Error('feature bug'); });
  const st = await agents.launch({ cwd, prompt: 'hello' });
  const s = await until(agents, st.id, x => x.status === 'idle');
  assert.equal(s.turns, 1, 'the first prompt still went out');
});
