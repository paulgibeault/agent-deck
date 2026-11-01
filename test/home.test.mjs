// Home (public/home.js, #33): the card order, the Unaffiliated card, the records
// the expanded view reads (public/homemodel.js), and the list route's ?sessions
// and ?cards (lib/routes/workstreams.mjs), and the Vault tab route (lib/routes/home.mjs). A local bare repo stands in for GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { workstreamMap, cardStates, orderCards, unaffiliated, parseNotes, parseRecord, parseSource, decisionGroups, groupFiles, sessionRows, coalesce } from '../public/homemodel.js';
import { storeFor } from '../lib/workstreams.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { DeckState } from '../lib/deckstate.mjs';

const T = Date.parse('2026-11-01T12:00:00Z');
const iso = (minAgo) => new Date(T - minAgo * 60_000).toISOString();
const live = (id, signal, minAgo = 1) => ({ id, kind: 'session', bucket: 'active', alive: true, mtime: T - minAgo * 60_000, glance: { signal } });
const recent = (id, minAgo = 60) => ({ id, kind: 'session', bucket: 'recent', alive: false, mtime: T - minAgo * 60_000 });

test('cards: needs-you, then running, then recent; paused after active; done and archived behind the filter', () => {
  const list = [
    { slug: 'quiet-old', status: 'active', updated: iso(600), ids: [] },
    { slug: 'quiet-new', status: 'active', updated: iso(5), ids: ['r1'] },
    { slug: 'running', status: 'active', updated: iso(900), ids: ['w1'] },
    { slug: 'needs', status: 'active', updated: iso(2000), ids: ['n1', 'w2'] },
    { slug: 'paused-new', status: 'paused', updated: iso(1) },
    { slug: 'paused-waiting', status: 'paused', updated: iso(3000), ids: ['n2'] },
    { slug: 'done', status: 'done', updated: iso(0) },
    { slug: 'archived', status: 'archived', updated: iso(0) },
  ];
  const sessions = [live('n1', 'input'), live('w2', 'working'), live('w1', 'working'), recent('r1', 2), live('n2', 'error')];
  const cards = cardStates(list, sessions);
  const needs = cards.find(c => c.slug === 'needs');
  assert.deepEqual([needs.needs, needs.running, needs.live.map(x => x.sig)], [1, 1, ['input', 'working']]);
  assert.equal(cards.find(c => c.slug === 'quiet-new').live.length, 0, 'a recent session is not a live dot');
  assert.equal(cards.find(c => c.slug === 'quiet-old').last, Date.parse(iso(600)));
  assert.equal(cards.find(c => c.slug === 'running').last, T - 60_000, 'a session’s activity counts as the workstream’s');

  // A paused workstream with a session waiting on you rises with the other needs-you ones.
  assert.deepEqual(orderCards(cards).map(c => c.slug), ['needs', 'paused-waiting', 'running', 'quiet-new', 'quiet-old', 'paused-new']);
  assert.deepEqual(orderCards(cards, { all: true }).map(c => c.slug).slice(-2), ['done', 'archived']);
  // Missing status reads as active.
  assert.equal(cardStates([{ slug: 'x' }])[0].status, 'active');
});

test('cards use app.js’s signal when given one; a hidden or ended session is no live dot', () => {
  const list = [{ slug: 'a', status: 'active', ids: ['s1', 's2', 's3'] }];
  const sessions = [live('s1', 'done'), { ...live('s2', 'working'), hidden: true }, recent('s3')];
  const [c] = cardStates(list, sessions, { sigOf: (s) => s.id === 's1' ? 'input' : 'working' });
  assert.deepEqual(c.live.map(x => [x.s.id, x.sig]), [['s1', 'input']]);
  assert.equal(c.needs, 1);
});

test('the session → workstream map: a summary’s own field (#35) wins over the list', () => {
  const list = [{ slug: 'a', ids: ['s1', 's2'] }, { slug: 'b', ids: [] }];
  const map = workstreamMap(list, [{ id: 's1', workstream: { slug: 'b', title: 'B' } }, { id: 's2', workstream: null }, { id: 's3' }]);
  assert.deepEqual([...map], [['s1', 'b']]);
  assert.deepEqual([...workstreamMap(list, [{ id: 's2', workstream: 'b' }])], [['s1', 'a'], ['s2', 'b']], 'a bare slug works too');
  assert.deepEqual([...workstreamMap(list, [])], [['s1', 'a'], ['s2', 'a']]);
});

test('Unaffiliated: live and recent sessions without a workstream, needs-you and live first', () => {
  const sessions = [
    recent('old', 300), recent('newer', 10), live('busy', 'working', 30), live('waiting', 'input', 90),
    live('mine', 'input'), { ...recent('closed', 1), bucket: 'closed' }, { ...live('gone', 'done'), hidden: true },
    { id: 'sub', kind: 'agent', bucket: 'active' },
  ];
  const map = new Map([['mine', 'a']]);
  const u = unaffiliated(sessions, map);
  assert.deepEqual(u.rows.map(r => r.s.id), ['waiting', 'busy', 'newer', 'old']);
  assert.deepEqual(u.rows.map(r => r.live), [true, true, false, false]);
  assert.equal(u.total, 4);
  assert.deepEqual(unaffiliated(sessions, map, { limit: 2 }), { rows: u.rows.slice(0, 2), total: 4 });
});

test('the expanded view’s records: notes, wrap-up record names, decisions, files', () => {
  const notes = parseNotes('# Notes\n- 2026-10-30: Flaky on CI (session abc123, event e9)\n- 2026-10-31: Use the bare repo (from a review)\nnot a bullet\n- undated one\n');
  assert.deepEqual(notes, [
    { date: null, text: 'undated one', source: null },
    { date: '2026-10-31', text: 'Use the bare repo (from a review)', source: null },
    { date: '2026-10-30', text: 'Flaky on CI', source: { session: 'abc123', event: 'e9' } },
  ]);
  assert.deepEqual(parseSource({ session: 's', event: 'e' }), { session: 's', event: 'e' });
  assert.deepEqual(parseSource('a chat'), { text: 'a chat' });
  assert.deepEqual(parseRecord('sessions/2026-10-31-fix-the-login-ab12cd34.md'), { file: 'sessions/2026-10-31-fix-the-login-ab12cd34.md', date: '2026-10-31', title: 'fix the login', id8: 'ab12cd34' });
  const g = decisionGroups([{ n: 1, status: 'superseded' }, { n: 2 }, { n: 3, status: 'active' }, { n: 4, status: 'reverted' }]);
  assert.deepEqual([g.active.map(d => d.n), g.past.map(d => d.n)], [[3, 2], [4, 1]]);
  assert.deepEqual(groupFiles([{ repo: 'b', path: 'x' }, { repo: 'a', path: 'y' }, { repo: 'b', path: 'z' }]).map(([r, fs]) => [r, fs.map(f => f.path)]), [['a', ['y']], ['b', ['x', 'z']]]);
});

test('the list route: ?sessions=1 adds session ids, ?cards=1 what a card shows', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-home-')));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const deck = new DeckState(path.join(root, 'state'));
  const sessions = { s1: { bucket: 'active' }, s2: { bucket: 'recent' } };
  const index = { summary: (id) => sessions[id] || null };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s ? JSON.parse(s) : {})); });
  const prev = process.env.DECK_GH;
  process.env.DECK_GH = path.join(root, 'no-gh');
  const table = (await loadRoutes(path.join(import.meta.dirname, '..', 'lib', 'routes'), { send, readBody, deck, index, broadcast: () => {} }))
    .filter(r => r.from === 'workstreams.mjs');
  if (prev === undefined) delete process.env.DECK_GH; else process.env.DECK_GH = prev;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
    send(res, 404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  // Git identity for the store's commits, whatever this machine's config says.
  const env = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const saved = env.map(k => process.env[k]);
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  try {
    assert.equal((await call('POST', '/api/workstreams/setup', { action: 'use', repo: remote })).body.ready, true);
    const slug = (await call('POST', '/api/workstreams', { title: 'Home screen', goal: 'Cards for workstreams', next: 'Screenshots' })).body.workstream.slug;
    await call('POST', `/api/workstreams/${slug}/decisions`, { title: 'One repo' });
    await call('POST', `/api/workstreams/${slug}/decisions`, { title: 'Two repos', supersedes: 1 });
    await call('POST', `/api/workstreams/${slug}/notes`, { text: 'First', source: { session: 's1' } });
    await call('POST', `/api/workstreams/${slug}/notes`, { text: 'Second' });
    await call('POST', '/api/sessions/s1/workstream', { slug });
    await call('POST', '/api/sessions/s2/workstream', { slug });

    let [w] = (await call('GET', '/api/workstreams')).body.workstreams;
    assert.equal(w.ids, undefined, 'the plain list is unchanged');
    assert.equal(w.goal, undefined);
    [w] = (await call('GET', '/api/workstreams?sessions=1')).body.workstreams;
    assert.deepEqual([w.ids.sort(), w.sessions, w.live, w.counts], [['s1', 's2'], 2, 1, undefined]);
    // Cards are read cheaply: no full store.get (which parses every decision) per workstream.
    const store = storeFor(path.join(deck.dir, 'workstreams'));
    const get = store.get; let gets = 0;
    store.get = (...a) => { gets++; return get.apply(store, a); };
    [w] = (await call('GET', '/api/workstreams?cards=1')).body.workstreams;
    store.get = get;
    assert.equal(gets, 0);
    assert.deepEqual(w.ids.sort(), ['s1', 's2']);
    assert.deepEqual([w.goal, w.next, w.pinned, w.links], ['Cards for workstreams', 'Screenshots', [], []]);
    assert.deepEqual(w.counts, { decisions: 2, notes: 2, files: 0, records: 0, vault: 0 }, 'decision files counted, notes by their bullets');
  } finally {
    env.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    server.close();
  }
});

test('the Sessions tab: a wrapped-up session still listed is one row, and the count is the rows', () => {
  const byId = (id) => ({ ab12cd34ef: live('ab12cd34ef', 'working'), zz99: recent('zz99', 5) })[id];
  const r = sessionRows(['zz99', 'ab12cd34ef', 'gone'], ['sessions/2026-10-30-old-one-ff00ff00.md', 'sessions/2026-10-31-the-live-one-ab12cd34.md', 'sessions/2026-11-01-recent-zz99.md'], byId);
  assert.deepEqual(r.known.map(s => s.id), ['ab12cd34ef', 'zz99'], 'live first; an id the deck no longer lists is left out');
  assert.equal(r.recordOf.get('ab12cd34ef').title, 'the live one');
  assert.equal(r.recordOf.get('zz99').title, 'recent');
  assert.deepEqual(r.records.map(x => x.title), ['old one']);
  assert.equal(r.count, 3);
  assert.equal(sessionRows([], [], byId).count, 0);
});

test('coalesce: a call during a run is folded into one more run, never dropped', async () => {
  let runs = 0; let release; const gates = [];
  const run = coalesce(async () => { runs++; await new Promise(r => gates.push(r)); });
  const first = run();
  const second = run(); const third = run();   // both arrive mid-run
  assert.equal(second, first, 'callers share the one promise');
  assert.equal(third, first);
  while (gates.length || runs < 2) { await new Promise(r => setImmediate(r)); (release = gates.shift()) && release(); }
  await first;
  assert.equal(runs, 2, 'one extra run for the two calls that landed mid-run');
  const again = run(); while (gates.length || runs < 3) { await new Promise(r => setImmediate(r)); (release = gates.shift()) && release(); }
  await again;
  assert.equal(runs, 3, 'a call after it finished runs afresh');
});

test('the Vault tab route: the workstream’s pointers checked one by one, and its own folder', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-home-v-')));
  const deck = new DeckState(path.join(root, 'state'));
  const { vaultFor } = await import('../lib/vault.mjs');
  const vault = vaultFor(deck);
  const src = path.join(root, 'notes.txt'); fs.writeFileSync(src, 'kept locally\n');
  const saved = await vault.saveFile(src, { workstream: 'ws-a', title: 'a note' });
  const kept = await vault.pointer(saved.path);
  fs.mkdirSync(path.join(deck.dir, 'workstreams', 'ws-a'), { recursive: true });
  fs.writeFileSync(path.join(deck.dir, 'workstreams', 'ws-a', 'vault.json'), JSON.stringify([kept, { ...kept, path: 'ws-a/gone.txt', title: 'gone' }]));
  let body = null;
  const [route] = (await loadRoutes(path.join(import.meta.dirname, '..', 'lib', 'routes'), { send: (res, code, b) => { body = { code, ...b }; }, deck }))
    .filter(r => r.from === 'home.mjs');
  await route.handler({}, {}, { m: [null, 'ws-a'] });
  assert.equal(body.code, 200);
  assert.deepEqual(body.pointers.map(p => [p.path, p.state]), [[saved.rel, 'ok'], ['ws-a/gone.txt', 'missing']]);
  assert.deepEqual(body.items.map(i => i.rel), [saved.rel]);
  assert.equal(body.items[0].meta.title, 'a note');
  fs.appendFileSync(saved.path, 'edited\n');
  await route.handler({}, {}, { m: [null, 'ws-a'] });
  assert.equal(body.pointers[0].state, 'changed');
  await route.handler({}, {}, { m: [null, '..%2Fx'] });
  assert.equal(body.code, 400);
});
