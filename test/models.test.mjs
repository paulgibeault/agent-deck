// Per-class model routing (lib/narrator.mjs), the Models dialog's routes
// (lib/routes/models.mjs) and their persistence in deck state. Claude is a
// fake transport here; nothing runs the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openaiTransport } from '../lib/llm.mjs';
import { Narrator, registerClass } from '../lib/narrator.mjs';
import { DeckState } from '../lib/deckstate.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { fileURLToPath } from 'node:url';

const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes');
const NO_TUNNEL = path.join(os.tmpdir(), 'deck-no-open-act.conf');
const json = (res, status, d) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
const reply = (content) => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] });

/** A tiny OpenAI-compatible server: POSTs go to `handle`; GET /v1/models lists `models`. */
async function fakeServer(handle, models = ['qwen-a', 'qwen-b']) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') return json(res, 200, { object: 'list', data: models.map(id => ({ id, object: 'model' })) });
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { const body = JSON.parse(b || '{}'); seen.push(body); handle(body, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); } };
}
async function deadUrl() { const s = await fakeServer(() => {}); await s.close(); return s.url; }

/** Stands in for `claude -p`: records each call, answers after `ms`. */
function fakeClaude({ ms = 5, fail = null } = {}) {
  const calls = [];
  let inFlight = 0;
  const t = { name: 'claude', label: 'claude -p', defaultModel: null, calls, peak: 0,
    async call(a) {
      calls.push(a); inFlight++; t.peak = Math.max(t.peak, inFlight);
      await new Promise(r => setTimeout(r, ms));
      inFlight--;
      if (fail) throw fail;
      return { text: `claude ${a.model} says hi\nsecond line`, costUsd: 0.001 };
    } };
  return t;
}
const local = (url) => openaiTransport({ url, model: 'qwen-a', tunnelConf: NO_TUNNEL });
const tmpState = () => new DeckState(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-models-')));

test('routing: each class runs on its own backend, model and thinking', async () => {
  const s = await fakeServer((body, res) => json(res, 200, reply('local ok')));
  try {
    const claude = fakeClaude();
    const n = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    const b = await n.run({ system: 's', prompt: 'p', model: n.briefModel, thinking: false, purpose: 'brief' });
    assert.equal(b.transport, 'local');
    assert.equal(s.seen[0].model, 'qwen-a', 'local default model');
    assert.deepEqual(s.seen[0].chat_template_kwargs, { enable_thinking: false });
    const w = await n.run({ system: 's', prompt: 'p', purpose: 'wrapup' });
    assert.equal(w.transport, 'claude');
    assert.equal(claude.calls[0].model, 'sonnet');

    n.setRoute('ask', { transport: 'claude', model: 'opus', thinking: false });
    assert.equal(n.askModel, 'opus');
    await n.run({ system: 's', prompt: 'p', model: 'ignored', thinking: true, purpose: 'ask' });
    assert.equal(claude.calls[1].model, 'opus', 'the route wins over what the caller passes');
    assert.equal(claude.calls[1].thinking, false);
    // Switching backend drops a model the other backend would not know.
    n.setRoute('ask', { transport: 'local' });
    assert.equal(n.askModel, 'qwen-a');
    n.setRoute('ask', { model: 'qwen-b' });
    await n.run({ system: 's', prompt: 'p', purpose: 'ask' });
    assert.equal(s.seen.at(-1).model, 'qwen-b');
    assert.throws(() => n.setRoute('ask', { transport: 'gpt' }), /unknown backend/);
    assert.throws(() => n.setRoute('nope', {}), /unknown request class/);

    const u = n.view().classes.find(c => c.id === 'ask').usage;
    assert.equal(u.calls, 2);
    assert.deepEqual(u.via, { claude: 1, local: 1 });
  } finally { await s.close(); }
});

test('routing: DECK_LLM=claude makes every class start on Claude; DECK_ASK_MODEL sets Ask\'s model', () => {
  const n = new Narrator({ transports: { claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') }, env: { DECK_LLM: 'claude', DECK_ASK_MODEL: 'opus' } });
  assert.equal(n.effective('brief').transport, 'claude');
  assert.equal(n.briefModel, 'haiku');
  assert.equal(n.askModel, 'opus');
  assert.throws(() => new Narrator({ transports: {}, env: { DECK_LLM: 'gpt' } }), /claude or openai/);
});

test('a class registered later gets its defaults and a row', () => {
  registerClass('zz-test', { label: 'Test class', transport: 'claude', model: 'haiku', thinking: false });
  const n = new Narrator({ transports: { claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') }, env: {} });
  const row = n.view().classes.find(c => c.id === 'zz-test');
  assert.deepEqual(row.effective, { transport: 'claude', model: 'haiku', thinking: false, fallback: false, forced: false });
});

test('fallback: a refused local connection retries on Claude, and says so', async () => {
  const claude = fakeClaude();
  const n = new Narrator({ transports: { claude, local: local(await deadUrl()) }, env: {} });
  const r = await n.run({ system: 's', prompt: 'p', purpose: 'brief' });
  assert.equal(r.fellBack, true);
  assert.equal(r.transport, 'claude');
  assert.match(r.fallbackReason, /ECONNREFUSED/);
  assert.equal(claude.calls[0].model, 'haiku', 'the class\'s Claude model');
  assert.equal(claude.calls[0].thinking, false, 'the route\'s thinking setting goes along');
  assert.equal(n.health.local.ok, false);
  assert.match(n.health.local.error.message, /ECONNREFUSED/);
  assert.equal(n.health.claude.ok, true);
  assert.equal(n.view().classes.find(c => c.id === 'brief').usage.fallbacks, 1);

  // Fallback off: the error stands.
  n.setRoute('brief', { fallback: false });
  await assert.rejects(n.run({ system: 's', prompt: 'p', purpose: 'brief' }), /ECONNREFUSED/);
  assert.equal(claude.calls.length, 1);
});

test('no fallback on a 400 from the model: that is a bad request, not a dead backend', async () => {
  const s = await fakeServer((body, res) => json(res, 400, { error: { message: 'context too long' } }));
  try {
    const claude = fakeClaude();
    const n = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    await assert.rejects(n.run({ system: 's', prompt: 'p', purpose: 'ask' }), /HTTP 400: context too long/);
    assert.equal(claude.calls.length, 0);
  } finally { await s.close(); }
});

test('fallback on a fatal local error (401), and briefs keep running through it', async () => {
  const s = await fakeServer((body, res) => json(res, 401, { error: { message: 'bad key' } }));
  try {
    const claude = fakeClaude();
    const n = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    const r = await n.run({ system: 's', prompt: 'p', purpose: 'brief' });
    assert.equal(r.fellBack, true);
    assert.equal(n.blocked(), false, 'Claude is still there');
    n.setRoute('brief', { fallback: false });
    await assert.rejects(n.run({ system: 's', prompt: 'p', purpose: 'brief' }), /401/);
    assert.equal(n.blocked(), true);
  } finally { await s.close(); }
});

test('concurrency is per transport: one local call at a time while Claude runs two', async () => {
  let inFlight = 0, peak = 0;
  const s = await fakeServer((body, res) => { inFlight++; peak = Math.max(peak, inFlight); setTimeout(() => { inFlight--; json(res, 200, reply('ok')); }, 30); });
  try {
    const claude = fakeClaude({ ms: 30 });
    const n = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    const calls = [];
    for (let i = 0; i < 3; i++) calls.push(n.run({ system: 's', prompt: 'p', purpose: 'brief' }), n.run({ system: 's', prompt: 'p', purpose: 'wrapup' }));
    const started = Date.now();
    await Promise.all(calls);
    assert.equal(peak, 1);
    assert.equal(claude.peak, 2);
    assert.ok(Date.now() - started < 3 * 30 + 80, 'the local queue does not hold up Claude calls');
    assert.equal(n.active, 0);
  } finally { await s.close(); }
});

test('Everything → Claude overrides every row, and turning it off restores them', async () => {
  const s = await fakeServer((body, res) => json(res, 200, reply('local ok')));
  try {
    const claude = fakeClaude();
    const n = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    n.setRoute('ask', { model: 'qwen-b', thinking: false });
    n.setAllClaude(true);
    for (const c of n.view().classes) {
      assert.equal(c.effective.transport, 'claude', c.id);
      assert.equal(c.effective.fallback, false);
    }
    assert.deepEqual(n.effective('ask'), { transport: 'claude', model: 'sonnet', thinking: false, fallback: false, forced: true });
    assert.equal(n.effective('wrapup').forced, false, 'already on Claude');
    await n.run({ system: 's', prompt: 'p', purpose: 'brief' });
    assert.equal(s.seen.length, 0);
    assert.equal(claude.calls[0].model, 'haiku');
    n.setAllClaude(false);
    assert.deepEqual(n.effective('ask'), { transport: 'local', model: 'qwen-b', thinking: false, fallback: true, forced: false });
    await n.run({ system: 's', prompt: 'p', purpose: 'ask' });
    assert.equal(s.seen[0].model, 'qwen-b');
  } finally { await s.close(); }
});

test('a route changed mid-call does not move the call in flight', async () => {
  const claude = fakeClaude({ ms: 30 });
  const n = new Narrator({ transports: { claude, local: local('http://127.0.0.1:1/v1') }, env: {} });
  const p = n.run({ system: 's', prompt: 'p', purpose: 'wrapup' });
  n.setRoute('wrapup', { model: 'opus' });
  assert.equal((await p).model, 'sonnet');
  assert.equal(n.effective('wrapup').model, 'opus');
});

test('persistence: routes and the Claude switch survive a restart', () => {
  const st = tmpState();
  const transports = () => ({ claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') });
  const a = new Narrator({ transports: transports(), env: {}, state: st.ns('models') });
  a.setRoute('brief', { transport: 'claude', model: 'sonnet', thinking: true });
  a.setRoute('title', { fallback: false });
  a.setAllClaude(true);
  const b = new Narrator({ transports: transports(), env: { DECK_LLM: 'openai' }, state: new DeckState(st.dir).ns('models') });
  assert.equal(b.allClaude, true);
  assert.deepEqual(b.routeOf('brief'), { transport: 'claude', model: 'sonnet', thinking: true, fallback: true });
  assert.equal(b.routeOf('title').fallback, false);
  assert.equal(b.routeOf('ask').transport, 'local', 'untouched rows keep their defaults');
  b.setAllClaude(false);
  assert.equal(new DeckState(st.dir).ns('models').get('settings').allClaude, undefined);
});

test('persistence keeps only the user\'s changes, so env defaults stay defaults', () => {
  const st = tmpState();
  const transports = () => ({ claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') });
  const a = new Narrator({ transports: transports(), env: { DECK_LLM: 'claude', DECK_BRIEF_MODEL: 'opus' }, state: st.ns('models') });
  a.setRoute('brief', { thinking: true });
  assert.deepEqual(st.ns('models').get('settings').routes.brief, { thinking: true });
  // Started again without the env: brief is back on its own default backend, with the user's thinking.
  const b = new Narrator({ transports: transports(), env: {}, state: new DeckState(st.dir).ns('models') });
  assert.deepEqual(b.routeOf('brief'), { transport: 'local', model: null, thinking: true, fallback: true });
});

test('a bad backend name is refused, and one in state.json is ignored', () => {
  const st = tmpState();
  const n = new Narrator({ transports: { claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') }, env: {}, state: st.ns('models') });
  for (const t of ['constructor', '__proto__', 'toString', 'gpt']) assert.throws(() => n.setRoute('brief', { transport: t }), /unknown backend/, t);
  assert.equal(st.ns('models').get('settings'), undefined, 'nothing saved');
  st.ns('models').set('settings', { routes: { brief: { transport: 'constructor', thinking: 'yes', model: 'two words' }, ask: { transport: '__proto__', fallback: false } } });
  const m = new Narrator({ transports: { claude: fakeClaude(), local: local('http://127.0.0.1:1/v1') }, env: {}, state: new DeckState(st.dir).ns('models') });
  assert.deepEqual(m.routeOf('brief'), { transport: 'local', model: null, thinking: false, fallback: true });
  assert.deepEqual(m.routeOf('ask'), { transport: 'local', model: null, thinking: true, fallback: false });
  assert.equal(m.effective('brief').transport, 'local');
});

test('breaker: after local gives no answer, fallback classes go straight to Claude; others keep trying local', async () => {
  const claude = fakeClaude();
  let up = false;
  const s = await fakeServer((body, res) => json(res, 200, reply('local ok')));
  const url = s.url;
  await s.close();
  const n = new Narrator({ transports: { claude, local: local(url) }, env: {} });
  let localTries = 0;
  const call = n.transports.local.call;
  n.transports.local.call = (a) => { localTries++; return up ? Promise.resolve({ text: 'local ok', costUsd: 0 }) : call(a); };
  n.transports.local.probe = async () => ({ ok: up, ms: 1, models: [], error: up ? null : 'down' });

  assert.equal((await n.run({ system: 's', prompt: 'p', purpose: 'brief' })).fellBack, true);
  assert.equal(localTries, 1);
  const r = await n.run({ system: 's', prompt: 'p', purpose: 'ask' });
  assert.equal(r.fellBack, true);
  assert.match(r.fallbackReason, /skipped/);
  assert.equal(localTries, 1, 'the breaker skipped local');
  assert.ok(n.view().transports.find(t => t.id === 'local').skipUntil > Date.now());
  n.setRoute('title', { fallback: false });
  await assert.rejects(n.run({ system: 's', prompt: 'p', purpose: 'title' }), /ECONNREFUSED/);
  assert.equal(localTries, 2, 'no fallback, so it still tries local');

  up = true;
  await n.probe();
  assert.equal(n.localDownUntil, 0, 'a good probe closes the breaker');
  assert.equal((await n.run({ system: 's', prompt: 'p', purpose: 'ask' })).transport, 'local');
});

test('when the Claude fallback fails too, the error keeps the local cause, counted once', async () => {
  const claude = fakeClaude({ fail: new Error('claude is out of credits') });
  const n = new Narrator({ transports: { claude, local: local(await deadUrl()) }, env: {} });
  await assert.rejects(n.run({ system: 's', prompt: 'p', purpose: 'ask' }),
    (e) => /^http:.*unreachable: ECONNREFUSED/.test(e.message) && /Claude fallback failed: claude is out of credits/.test(e.message) && e.unreachable && e.cause.message === 'claude is out of credits');
  assert.match(n.status().error.message, /^http:.*ECONNREFUSED/);
  const u = n.view().classes.find(c => c.id === 'ask').usage;
  assert.equal(u.errors, 1);
  assert.equal(u.fallbacks, 0);
  // A fallback that works is not an error.
  claude.call = async () => ({ text: 'ok', costUsd: 0 });
  n.localDownUntil = 0;
  await n.run({ system: 's', prompt: 'p', purpose: 'brief' });
  assert.equal(n.view().classes.find(c => c.id === 'brief').usage.errors, 0);
});

test('routes: list with a reachability probe, change a row, flip the switch, test a class', async () => {
  const s = await fakeServer((body, res) => json(res, 200, reply('hello there\nmore')), ['qwen-a', 'qwen-b']);
  const server = { close() {} };
  try {
    const claude = fakeClaude();
    const narrator = new Narrator({ transports: { claude, local: local(s.url) }, env: {} });
    const deck = tmpState();
    const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const readBody = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
    const table = await loadRoutes(ROUTES, { send, readBody, deck, narrator, narratorEnabled: true, root: '/' });
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const hit = matchRoute(table, req.method, url.pathname);
      if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
      send(res, 404, {});
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    server.close = () => new Promise(r => srv.close(r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', body: JSON.stringify(body) })).json();

    const v = await (await fetch(`${base}/api/models`)).json();
    const loc = v.transports.find(t => t.id === 'local');
    assert.deepEqual(loc.models, ['qwen-a', 'qwen-b']);
    assert.equal(loc.health.probe.ok, true);
    assert.equal(s.seen.length, 0, 'the probe is not a model call');
    assert.deepEqual(v.classes.map(c => c.id).slice(0, 6), ['brief', 'ask', 'wrapup', 'curate', 'title', 'worktree']);

    const r = await post('/api/models/route', { class: 'title', model: 'qwen-b', thinking: false });
    assert.equal(r.classes.find(c => c.id === 'title').effective.model, 'qwen-b');
    assert.deepEqual(deck.ns('models').get('settings').routes.title, { model: 'qwen-b', thinking: false }, 'only what was changed');
    assert.match((await post('/api/models/route', { class: 'title', model: 'two words' })).error, /bad model/);

    const t = await post('/api/models/test', { class: 'title' });
    assert.equal(t.ok, true);
    assert.equal(t.line, 'hello there');
    assert.equal(t.transport, 'local');
    assert.equal(s.seen[0].model, 'qwen-b');
    const title = (await (await fetch(`${base}/api/models?probe=0`)).json()).classes.find(c => c.id === 'title');
    assert.equal(title.usage.calls, 0, 'Test calls stay out of the class\'s usage');
    assert.equal(narrator.byPurpose['test:title'].calls, 1);

    assert.equal((await post('/api/models/everything-claude', { on: true })).allClaude, true);
    const t2 = await post('/api/models/test', { class: 'title' });
    assert.equal(t2.transport, 'claude');
    assert.equal(t2.line, 'claude haiku says hi');
    assert.equal((await post('/api/models/test', { class: 'nope' })).error, 'unknown request class: nope');
  } finally { await server.close(); await s.close(); }
});

test('probe: an unreachable local server reports why, with no model call', async () => {
  const n = new Narrator({ transports: { claude: fakeClaude(), local: local(await deadUrl()) }, env: {} });
  const p = await n.probe();
  assert.equal(p.ok, false);
  assert.match(p.error, /ECONNREFUSED/);
  assert.equal(n.calls, 0);
});
