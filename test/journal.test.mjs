// The deck's journal for sessions with no transcript of their own (ACP):
// the file format, a session surviving a deck restart, ids that a resume
// cannot overwrite, and history listed and replayed from the agent itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../lib/journal.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { AgentManager } from '../lib/agent.mjs';
import { AcpDriver } from '../lib/harness/acp.mjs';
import { AcpEvents, opencodeIdTime } from '../lib/acp-events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-acp.mjs');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const cwd = tmp('deck-jr-proj-');

test('journal: header, latest version of each event in first-seen order, meta, titles; scan; retention; compaction', () => {
  const dir = tmp('deck-jr-dir-');
  const j = new Journal({ dir, retentionDays: 30 });
  const file = j.open('s1', { harness: 'opencode', cwd: '/w/app', title: 'first prompt' });
  assert.equal(file, path.join(dir, 'opencode', '-w-app', 's1.jsonl'));
  const text = { id: 't:m1', kind: 'text', text: 'Hel' };
  j.record('s1', { events: [{ id: 'p1', kind: 'prompt', text: 'hi' }, text], meta: { model: 'm' } });
  text.text = 'Hello';                                   // the same event object grows until the flush
  j.flush();
  j.record('s1', { events: [{ id: 't:m1', kind: 'text', text: 'Hello there' }, { id: 'e1', kind: 'turn_end' }], meta: { mode: 'build' }, title: 'Greeting' });
  j.flush();
  const r = j.read(file);
  assert.deepEqual(r.events.map(e => [e.id, e.text ?? null]), [['p1', 'hi'], ['t:m1', 'Hello there'], ['e1', null]]);
  assert.deepEqual(r.meta, { model: 'm', mode: 'build' });
  assert.equal(r.title, 'Greeting');
  assert.equal(r.header.harness, 'opencode');

  const [s] = j.scan();
  assert.deepEqual([s.id, s.harness, s.cwd, s.title], ['s1', 'opencode', '/w/app', 'Greeting']);

  // Past the retention window a journal is deleted, as Claude Code deletes its transcripts.
  j.close('s1');
  const old = Date.now() - 31 * 86_400_000;
  fs.utimesSync(file, old / 1000, old / 1000);
  assert.deepEqual(j.scan(), []);
  assert.equal(fs.existsSync(file), false);

  // A file that is mostly stale versions is rewritten on read.
  const big = j.open('s2', { harness: 'opencode', cwd: '/w/app' });
  for (let i = 0; i < 400; i++) { j.record('s2', { events: [{ id: 't:long', kind: 'text', text: 'x'.repeat(1000 + i) }] }); j.flush(); }
  j.close('s2');
  const before = fs.statSync(big).size;
  assert.equal(j.read(big).events[0].text.length, 1399);
  assert.ok(fs.statSync(big).size < before / 10, `compacted ${before} → ${fs.statSync(big).size}`);
  assert.equal(j.read(big).events[0].text.length, 1399);
});

test('replay: turns split at each user message, times from opencode message ids; made-up ids differ per run', () => {
  const at = Date.parse('2026-10-18T04:01:53Z');
  const id = (ms) => `msg_${((BigInt(ms) * 4096n) % (2n ** 48n)).toString(16).padStart(12, '0')}abc`;
  assert.equal(opencodeIdTime(id(at - 3600_000), at), at - 3600_000);
  assert.equal(opencodeIdTime('call_abc', at), null);

  const m = new AcpEvents({ replay: true, until: at });
  const evs = [];
  for (const u of [
    { sessionUpdate: 'user_message_chunk', messageId: id(at - 600_000), content: { type: 'text', text: 'q1' } },
    { sessionUpdate: 'agent_message_chunk', messageId: id(at - 590_000), content: { type: 'text', text: 'a1' } },
    { sessionUpdate: 'user_message_chunk', messageId: id(at - 300_000), content: { type: 'text', text: 'q2' } },
    { sessionUpdate: 'agent_message_chunk', messageId: id(at - 290_000), content: { type: 'text', text: 'a2' } },
  ]) evs.push(...m.update(u).events);
  evs.push(...m.finish());
  assert.deepEqual(evs.map(e => e.kind), ['prompt', 'text', 'turn_end', 'prompt', 'text', 'turn_end']);
  assert.equal(evs[1].ts, new Date(at - 590_000).toISOString());
  assert.equal(evs[3].ts, new Date(at - 300_000).toISOString());

  // Two runs of one session (a resume) never reuse a prompt id.
  assert.notEqual(new AcpEvents().prompt('a').id, new AcpEvents().prompt('a').id);
});

function until(pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = pred(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 20); };
    tick();
  });
}

/** A deck the way server.mjs wires one: journal, index, manager with the fake ACP agent. */
function deck(t, stateDir, env = {}) {
  const journal = new Journal({ dir: path.join(stateDir, 'sessions') });
  const index = new SessionIndex({ claudeDir: tmp('deck-jr-home-'), journal });
  index.scanJournal();
  const acp = new AcpDriver({ bin: process.execPath, args: [FAKE], label: 'fake acp', env: { ...process.env, FAKE_ACP_HISTORY_CWD: cwd, ...env } });
  const agents = new AgentManager({ drivers: { fake: acp }, defaultHarness: 'fake', store: path.join(stateDir, 'agents.json'),
    wakeable: (id) => { const s = index.summary(id); return s?.cwd ? { cwd: s.cwd, harness: s.stream ? s.harness : undefined, title: s.stream ? s.title : undefined } : { error: 'unknown session' }; } });
  index.external = () => agents.registryEntries();
  index.deckState = (id) => agents.publicState(id);
  agents.on('stream', ({ id, cwd, title, harness, events, meta }) => index.pushStream(id, { cwd, title, harness, events, meta }));
  agents.on('change', (st) => index.refresh(st.id));
  index.importer = async (id) => {
    const f = index.files.get(id);
    const h = await agents.drivers[f.harness].loadHistory(id, { cwd: f.cwd, until: f.mtime });
    if (h) index.pushStream(id, { cwd: f.cwd, harness: f.harness, title: f.probe.title, events: h.events, meta: h.meta, history: true });
  };
  t.after(() => agents.shutdown());
  return { agents, index, journal };
}

test('a session the deck ran is listed again after a restart, with its events, and resumes without losing them', async (t) => {
  const stateDir = tmp('deck-jr-state-');
  const one = deck(t, stateDir);
  const st = await one.agents.launch({ cwd, prompt: 'hello there' });
  await until(() => one.agents.publicState(st.id)?.status === 'idle');
  await one.agents.shutdown(); one.agents.flush(); one.journal.flush();

  // The deck restarts: only the journal remembers.
  const two = deck(t, stateDir);
  const s = two.index.summary(st.id);
  assert.equal(s.stream, true); assert.equal(s.journal, true);
  assert.equal(s.harness, 'fake'); assert.equal(s.cwd, cwd); assert.equal(s.title, 'hello there');
  assert.ok(two.index.snapshot().recent.some(x => x.id === st.id));
  const kinds = two.index.load(st.id).state.events.map(e => e.kind);
  assert.deepEqual(kinds.filter(k => k !== 'thinking'), ['prompt', 'text', 'turn_end']);

  await two.agents.send(st.id, 'and again');
  await until(() => two.index.load(st.id).state.events.filter(e => e.kind === 'turn_end').length === 2);
  const prompts = two.index.load(st.id).state.events.filter(e => e.kind === 'prompt').map(e => e.text);
  assert.deepEqual(prompts, ['hello there', 'and again']);
});

test("sessions the agent lists come in; opening one replays its history from the agent into the journal", async (t) => {
  const stateDir = tmp('deck-jr-state-');
  const { agents, index, journal } = deck(t, stateDir, { FAKE_ACP_HISTORY_AT: String(Date.now()) });
  const list = await agents.drivers.fake.listSessions();
  assert.deepEqual(list.map(x => x.sessionId), ['ses_hist_1', 'ses_hist_2']);   // both pages
  index.forgotten = (id) => id === 'ses_hist_2';                              // deleted here before
  index.addRemote('fake', list);
  assert.equal(index.files.has('ses_hist_2'), false);
  const s = index.summary('ses_hist_1');
  assert.deepEqual([s.remote, s.harness, s.title, s.cwd], [true, 'fake', 'Old work', cwd]);
  const batches = [];
  index.on('events', (x) => batches.push(x));

  index.load('ses_hist_1');   // opening it fetches the history
  const evs = await until(() => { const e = index.load('ses_hist_1').state.events; return e.length >= 6 && e; });
  assert.deepEqual(evs.map(e => e.kind), ['prompt', 'text', 'tool', 'turn_end', 'prompt', 'text', 'turn_end']);
  assert.equal(evs[1].text, 'first answer');
  assert.equal(index.summary('ses_hist_1').remote, undefined);
  assert.ok(batches.length && batches.every(x => x.history));   // a replay, not live: nothing to read aloud
  assert.equal(index.summary('ses_hist_1').mtime, s.mtime);      // keeps the time its agent listed
  journal.flush();
  const again = new Journal({ dir: path.join(stateDir, 'sessions') }).read(index.files.get('ses_hist_1').file);
  assert.equal(again.events.length, 7);
  assert.equal(again.header.harness, 'fake');
  // The file keeps the session's own time, so after a restart it sorts where it did.
  assert.ok(Math.abs(fs.statSync(index.files.get('ses_hist_1').file).mtimeMs - s.mtime) < 1000);
});
