// Session title overrides (lib/titles.mjs, lib/routes/titles.mjs): kept in
// deck state, applied in summaries, and naming a streamed (ACP) session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DeckState } from '../lib/deckstate.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { AgentManager } from '../lib/agent.mjs';
import { AcpDriver } from '../lib/harness/acp.mjs';
import { Titles, cleanOverride } from '../lib/titles.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-acp.mjs');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const cwd = tmp('deck-titles-proj-');

function until(agents, id, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => { const st = agents.publicState(id); if (st && pred(st)) { agents.off('change', check); clearTimeout(t); resolve(st); } };
    const t = setTimeout(() => { agents.off('change', check); reject(new Error(`timed out; state: ${JSON.stringify(agents.publicState(id))}`)); }, ms);
    agents.on('change', check);
    check();
  });
}

/** A fake ACP harness wired to a SessionIndex as server.mjs does, plus the deck's titles. */
function deck(t, dir = tmp('deck-titles-state-')) {
  const acp = new AcpDriver({ bin: process.execPath, args: [FAKE], label: 'fake acp' });
  const index = new SessionIndex({ claudeDir: tmp('deck-titles-home-') });
  const agents = new AgentManager({ drivers: { fake: acp }, defaultHarness: 'fake',
    wakeable: (id) => index.files.has(id) ? { cwd: index.cwdOf(id), title: index.loaded.get(id)?.state.meta.title || null } : { error: 'unknown session' } });
  index.external = () => agents.registryEntries();
  index.deckState = (id) => agents.publicState(id);
  agents.on('stream', ({ id, cwd, title, events, meta }) => index.pushStream(id, { cwd, title, events, meta }));
  agents.on('change', (st) => index.refresh(st.id));
  t.after(() => agents.shutdown());
  const state = new DeckState(dir);
  return { agents, index, state, titles: new Titles({ deck: state, index, agents }), dir };
}

test('cleanOverride: one trimmed line, capped; nothing is null', () => {
  assert.equal(cleanOverride('  Fix the\n  login  bug '), 'Fix the login bug');
  assert.equal(cleanOverride('   '), null);
  assert.equal(cleanOverride(null), null);
  assert.equal(cleanOverride('x'.repeat(500)).length, 200);
});

test('a title override is kept in deck state and outlives a restart', () => {
  const dir = tmp('deck-titles-state-');
  const titles = new Titles({ deck: new DeckState(dir) });
  assert.equal(titles.set('s1', ' Release notes '), 'Release notes');
  assert.equal(new Titles({ deck: new DeckState(dir) }).get('s1'), 'Release notes');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).ns.titles, { s1: 'Release notes' });
  titles.set('s1', '');
  assert.equal(new Titles({ deck: new DeckState(dir) }).get('s1'), null, 'an empty title clears it');
});

test('summaries carry the override, so every view shows it; clearing brings the agent\'s back', () => {
  const index = new SessionIndex({ claudeDir: tmp('deck-titles-home-') });
  index.addStream('s1', { cwd, title: 'what the agent called it' });
  const titles = new Titles({ deck: new DeckState(tmp('deck-titles-state-')), index });
  assert.equal(index.summary('s1').title, 'what the agent called it');
  assert.equal(index.summary('s1').retitled, undefined);
  titles.set('s1', 'Mine');
  assert.equal(index.summary('s1').title, 'Mine');
  assert.equal(index.summary('s1').retitled, true);
  assert.equal(index.snapshot().recent.concat(index.snapshot().active).find(s => s.id === 's1').title, 'Mine', 'the rail and Home read snapshots');
  titles.set('s1', null);
  assert.equal(index.summary('s1').title, 'what the agent called it');
});

test('renaming a streamed (ACP) session sets its name, which a resume keeps', async (t) => {
  const { agents, index, titles } = deck(t);
  const id = (await agents.launch({ cwd, prompt: 'hello' })).id;
  await until(agents, id, x => x.status === 'idle');
  assert.equal(index.summary(id).title, 'hello');

  titles.set(id, 'Renamed');
  assert.equal(agents.agents.get(id).name, 'Renamed');
  assert.equal(agents.registryEntries().find(r => r.sessionId === id).name, 'Renamed');
  assert.equal(index.summary(id).title, 'Renamed');

  agents.stop(id);
  await until(agents, id, x => x.status === 'exited');
  // As after a deck restart: the record has lost its name; the override names the resumed session.
  agents.agents.get(id).name = null;
  await agents.send(id, 'are you back?');
  await until(agents, id, x => x.alive && x.status === 'idle');
  assert.equal(agents.agents.get(id).name, 'Renamed');

  titles.set(id, '');
  assert.equal(agents.agents.get(id).name, 'hello', 'cleared: back to the name it streamed under');
  assert.equal(index.summary(id).title, 'hello');
});

test('after a restart, a streamed session renamed then cleared gets its own name back, not the pilot\'s', async (t) => {
  const { agents, index, titles } = deck(t);
  const id = (await agents.launch({ cwd, prompt: 'hello' })).id;
  await until(agents, id, x => x.status === 'idle');
  agents.stop(id);
  await until(agents, id, x => x.status === 'exited');
  // As after a deck restart: no agent record, and the session listed again with no title of its own.
  agents.agents.delete(id);
  index.loaded.get(id).state.meta.title = null;
  titles.set(id, 'Renamed');
  await agents.send(id, 'are you back?');
  await until(agents, id, x => x.alive && x.status === 'idle');
  assert.equal(index.summary(id).title, 'Renamed');
  assert.notEqual(index.loaded.get(id).state.meta.title, 'Renamed', 'the streamed events did not take the pilot\'s title as the session\'s own');
  titles.set(id, '');
  assert.equal(agents.agents.get(id).name, 'are you back?');
  assert.equal(index.summary(id).title, 'are you back?');
});

test('titles of sessions nobody knows any more are pruned; known and streamed ones stay', () => {
  const dir = tmp('deck-titles-state-');
  const pre = new Titles({ deck: new DeckState(dir) });
  for (const id of ['s1', 'gone', 'ses_kept']) pre.set(id, `title ${id}`);
  const index = new SessionIndex({ claudeDir: tmp('deck-titles-home-') });
  index.addStream('s1', { cwd });
  // A streamed session the deck recorded (agents.json) but has not listed again yet.
  const agents = { agents: new Map(), harnesses: new Map([['ses_kept', 'opencode']]), on() {} };
  const titles = new Titles({ deck: new DeckState(dir), index, agents });
  assert.equal(titles.get('s1'), 'title s1');
  assert.equal(titles.get('ses_kept'), 'title ses_kept');
  assert.equal(titles.get('gone'), null);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).ns.titles).sort(), ['s1', 'ses_kept']);
});

test('a resume the agent gives a fresh id takes the title with it', () => {
  const agents = Object.assign(new EventEmitter(), { agents: new Map(), harnesses: new Map() });
  const titles = new Titles({ deck: new DeckState(tmp('deck-titles-state-')), agents });
  titles.set('old', 'Mine');
  const proc = new EventEmitter();
  agents.emit('proc', { id: 'old', harness: 'claude', proc });
  proc.emit('init', { sessionId: 'new' });
  assert.equal(titles.get('new'), 'Mine');
  assert.equal(titles.get('old'), null);
});

test('POST /api/sessions/:id/title renames a session; unknown ids and bad bodies are refused', async (t) => {
  const { agents, index, state } = deck(t);
  index.addStream('s1', { cwd, title: 'first' });
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); });
  let snapped = 0;
  const table = await loadRoutes(path.join(__dirname, '..', 'lib', 'routes'), { send, readBody, deck: state, index, agents, scheduleSnapshot: () => snapped++, root: '/' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
    send(res, 404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const post = (id, body) => fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${encodeURIComponent(id)}/title`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  let r = await post('s1', { title: 'Second' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { title: 'Second', override: 'Second' });
  assert.equal(index.summary('s1').title, 'Second');
  assert.equal(snapped, 1, 'the rail hears of it');
  r = await post('s1', { title: '' });
  assert.deepEqual(await r.json(), { title: 'first', override: null });
  assert.equal((await post('nope', { title: 'x' })).status, 404);
  assert.equal((await post('s1', { title: 3 })).status, 400);
  assert.equal((await post('s1', '{oops')).status, 400);
});
