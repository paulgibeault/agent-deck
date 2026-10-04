// Deck-launched sessions against test/fixtures/fake-agent.mjs: launch,
// queue pumping, permission prompts, interrupt, exit reporting, and the
// index picking the transcript up as a live session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager, messageContent, normalizeAttachments } from '../lib/agent.mjs';
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
  assert.throws(() => agents.send(st.id, 'more'), /ended/);
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
