// Deck-launched sessions against test/fixtures/fake-agent.mjs: launch,
// queue pumping, permission prompts, interrupt, exit reporting, and the
// index picking the transcript up as a live session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../lib/agent.mjs';
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
