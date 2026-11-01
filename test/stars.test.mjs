// Stars and tags (lib/stars.mjs, lib/routes/stars.mjs) and the decision-language
// candidates (public/said.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DeckState } from '../lib/deckstate.mjs';
import { Stars, starsFor, onTag, candidates } from '../lib/stars.mjs';
import { decisionCue, prose, eventCue } from '../public/said.js';
import { StarStore } from '../public/stars.js';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deck-stars-'));
const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes');

test('a star survives a reload, excerpt and all', () => {
  const dir = tmp();
  const stars = starsFor(new DeckState(dir));
  stars.put('s1', 'toolu_1', { tag: 'decision', comment: 'cheaper\nthan a queue', excerpt: 'We will go with SQLite.', ts: '2026-01-01T00:00:00Z' });
  stars.put('s1', '/repo/src/a.js', { excerpt: 'src/a.js' });

  const again = new Stars(new DeckState(dir).ns('stars'));
  const s = again.get('s1', 'toolu_1');
  assert.equal(s.tag, 'decision');
  assert.equal(s.comment, 'cheaper than a queue', 'the comment is one line');
  assert.equal(s.excerpt, 'We will go with SQLite.');
  assert.equal(s.kind, 'event');
  assert.equal(s.ts, '2026-01-01T00:00:00Z');
  assert.ok(Date.parse(s.at));
  assert.deepEqual(again.get('s1', '/repo/src/a.js'), { tag: 'star', at: again.get('s1', '/repo/src/a.js').at, excerpt: 'src/a.js', kind: 'file' });
  assert.deepEqual(again.sessions(), ['s1']);
});

test('re-tagging keeps the saved excerpt; long excerpts are clipped', () => {
  const stars = starsFor(new DeckState(tmp()));
  stars.put('s', 'e1', { excerpt: 'the original text' });
  // The transcript was compacted: the page no longer has the text, only the key.
  const s = stars.put('s', 'e1', { tag: 'note', comment: 'remember this' });
  assert.equal(s.excerpt, 'the original text');
  assert.equal(s.tag, 'note');
  const long = stars.put('s', 'e2', { excerpt: 'x'.repeat(10_000) });
  assert.equal(long.excerpt.length, 2000);
});

test('bad input is refused; the Vault takes files only', () => {
  const stars = starsFor(new DeckState(tmp()));
  assert.throws(() => stars.put('s', 'e1', { tag: 'nope' }), (e) => e.code === 400);
  assert.throws(() => stars.put('s', '', {}), (e) => e.code === 400);
  assert.throws(() => stars.put('s', 'e1', { tag: 'vault' }), /only files/);
  assert.equal(stars.put('s', '/r/f.md', { tag: 'vault' }).tag, 'vault');
});

test('unstarring the last star leaves no trace in state.json', () => {
  const dir = tmp();
  const stars = starsFor(new DeckState(dir));
  stars.put('s', 'e1', {});
  assert.equal(stars.remove('s', 'e1'), true);
  assert.equal(stars.remove('s', 'e1'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), { hidden: [] });
});

test('a tag handler runs when an item newly gets its tag (the Vault hook)', async () => {
  const stars = starsFor(new DeckState(tmp()));
  const seen = [];
  const off = onTag('vault', (p) => { seen.push(p.key); });
  stars.put('s', '/r/a.md', { tag: 'star' });
  stars.put('s', '/r/a.md', { tag: 'vault' });
  stars.put('s', '/r/a.md', { tag: 'vault', comment: 'again' }); // already tagged: not again
  off();
  stars.put('s', '/r/b.md', { tag: 'vault' });
  assert.deepEqual(seen, ['/r/a.md']);
});

// ---- candidates
test('decision language in agent prose is a candidate', () => {
  assert.equal(decisionCue("Given the options, we'll go with the sidecar approach.").cue, "we'll go with");
  assert.equal(decisionCue('I decided to keep the cache.').cue, 'decided');
  assert.equal(decisionCue('The trade-off is memory for speed.').cue, 'trade-off');
  assert.equal(decisionCue('Going forward, tests run in parallel.').cue, 'going forward');
  assert.equal(decisionCue('Use a map instead of an array.').cue, 'instead of');
  const c = decisionCue('Read the file. Then, after some thought, we decided to split it. Done.');
  assert.equal(c.sentence, 'Then, after some thought, we decided to split it.');
  assert.equal(decisionCue('All tests pass.'), null);
  assert.equal(decisionCue(''), null);
});

test('candidates do not fire on code blocks or quoted tool output', () => {
  const fenced = 'Here is the output:\n```\n$ grep -r decided .\nsrc/a.js: // we decided instead of X\n```\nAll good.';
  assert.equal(decisionCue(fenced), null, 'fenced code');
  assert.equal(decisionCue('Output:\n~~~\ntrade-off: 3\n~~~\n'), null, 'tilde fence');
  assert.equal(decisionCue('The log says:\n> Going forward, retries are disabled.\n> (exit 1)\nI will look.'), null, 'blockquote');
  assert.equal(decisionCue('Set `useInsteadOf` and `instead of` flags.'), null, 'code spans');
  assert.equal(decisionCue('The error was "decided to abort" from the tool.'), null, 'a quoted phrase');
  assert.equal(decisionCue('Result:\n\n    we decided nothing here\n\nok'), null, 'indented code');
  // A nested list item is prose, not indented code.
  assert.ok(decisionCue('- Plan\n    - we decided to drop the flag'));
  // An unclosed fence hides the rest rather than guessing.
  assert.equal(decisionCue('```\nwe decided'), null);
  assert.match(prose('a ```x``` b'), /^a\s+b$/);
});

test('only agent text counts: tool results, prompts and thinking never do', () => {
  const evs = [
    { id: 'p', kind: 'prompt', text: "We'll go with whatever you decide." },
    { id: 't', kind: 'tool', tool: { name: 'Bash', result: { text: 'decided instead of trade-off' } } },
    { id: 'k', kind: 'thinking', text: 'I decided already.' },
    { id: 'a', kind: 'text', ts: '2026-01-01T00:00:01Z', text: 'We decided to ship it.' },
    { id: 'b', kind: 'text', text: 'Shipped.' },
  ];
  assert.deepEqual(candidates(evs), [{ eventId: 'a', ts: '2026-01-01T00:00:01Z', cue: 'decided', sentence: 'We decided to ship it.' }]);
  const ev = { kind: 'text', text: 'We decided.' };
  assert.equal(eventCue(ev), ev._cue, 'worked out once and kept on the event');
  assert.equal(eventCue({ kind: 'tool', tool: {} }), null);
});

// ---- the API
async function serve() {
  const deck = new DeckState(tmp());
  const sent = [];
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch (e) { reject(e); } });
  });
  const index = {
    files: new Map([['s1', {}]]), agents: new Map([['sub1', {}]]),
    load: (id) => id === 's1' ? { state: { events: [{ id: 'a', kind: 'text', text: "We'll go with plan B." }] } } : null,
  };
  const agents = { recordedHarness: (id) => id === 'acp1' ? 'opencode' : null };
  const table = await loadRoutes(ROUTES, { send, readBody, deck, index, agents, root: '/', broadcast: (event, data) => sent.push({ event, data }) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
    send(res, 404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, sent, deck, close: () => server.close() };
}

test('API: PUT, GET and DELETE a star, with a live stars.changed for each change', async () => {
  const { base, sent, deck, close } = await serve();
  try {
    const file = '/repo/src/a b.js';
    const url = (key) => `${base}/api/sessions/s1/stars/${encodeURIComponent(key)}`;
    const put = (key, body) => fetch(url(key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    let r = await put('ev1', { tag: 'question', comment: 'why?', excerpt: 'Should we cache?' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).star.tag, 'question');
    r = await put(file, { tag: 'vault', kind: 'file', excerpt: 'src/a b.js' });
    assert.equal(r.status, 200);

    const got = await (await fetch(`${base}/api/sessions/s1/stars`)).json();
    assert.deepEqual(Object.keys(got.stars).sort(), [file, 'ev1'].sort());
    assert.equal(got.stars.ev1.excerpt, 'Should we cache?');
    assert.equal(got.candidates, undefined, 'candidates only on request');
    assert.equal(starsFor(deck).get('s1', file).kind, 'file');

    assert.deepEqual(sent.map(s => [s.event, s.data.sessionId, s.data.key, s.data.star.tag]), [['stars.changed', 's1', 'ev1', 'question'], ['stars.changed', 's1', file, 'vault']]);

    r = await fetch(url('ev1'), { method: 'DELETE' });
    assert.deepEqual(await r.json(), { removed: true });
    assert.deepEqual(sent.at(-1), { event: 'stars.changed', data: { sessionId: 's1', key: 'ev1', star: null } });
    r = await fetch(url('ev1'), { method: 'DELETE' });
    assert.deepEqual(await r.json(), { removed: false });
    assert.equal(sent.length, 3, 'nothing to say when nothing was removed');

    r = await put('ev2', { tag: 'bogus' });
    assert.equal(r.status, 400);
    r = await fetch(url('ev2'), { method: 'PUT', body: '{not json' });
    assert.equal(r.status, 400);
    assert.equal(sent.length, 3);
  } finally { close(); }
});

test('API: candidates for wrap-up, and an unknown session has no stars', async () => {
  const { base, close } = await serve();
  try {
    const r = await (await fetch(`${base}/api/sessions/s1/stars?candidates=1`)).json();
    assert.deepEqual(r, { stars: {}, candidates: [{ eventId: 'a', ts: null, cue: "we'll go with", sentence: "We'll go with plan B." }] });
    assert.deepEqual(await (await fetch(`${base}/api/sessions/nope/stars?candidates=1`)).json(), { stars: {}, candidates: [] });
  } finally { close(); }
});

test('API: a body that is not a JSON object is a 400, not a 500', async () => {
  const { base, sent, close } = await serve();
  try {
    for (const body of ['null', '[]', '"star"', '7']) {
      const r = await fetch(`${base}/api/sessions/s1/stars/ev1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(r.status, 400, body);
    }
    assert.equal(sent.length, 0);
  } finally { close(); }
  assert.throws(() => starsFor(new DeckState(tmp())).put('s', 'e', null), (e) => e.code === 400);
});

test('stars of sessions the deck no longer knows are pruned', async () => {
  const stars = starsFor(new DeckState(tmp()));
  for (const id of ['a', 'b', 'c']) stars.put(id, 'e', {});
  assert.deepEqual(stars.prune(id => id === 'b'), ['a', 'c']);
  assert.deepEqual(stars.sessions(), ['b']);

  // Through the API: on a list, keeping sessions, subagents and deck-launched streams.
  const { base, deck, close } = await serve();
  try {
    const st = starsFor(deck);
    for (const id of ['s1', 'sub1', 'acp1', 'deleted']) st.put(id, 'e', {});
    await fetch(`${base}/api/sessions/s1/stars`);
    assert.deepEqual(st.sessions().sort(), ['acp1', 's1', 'sub1']);
  } finally { close(); }
});

// ---- the page's copy (public/stars.js StarStore), against a scripted server
function scripted() {
  const calls = [];
  const request = (method, path, body) => new Promise((resolve, reject) => calls.push({ method, path, body, resolve, reject }));
  const changes = [];
  const store = new StarStore(request, (sid, keys) => changes.push(keys));
  const tick = () => new Promise(r => setTimeout(r, 0));
  return { store, calls, changes, tick };
}

test('StarStore: requests for one item go in order, and a late reply does not undo a newer change', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { store, calls, tick } = scripted();
  store.get('s', 'k'); calls.shift().resolve({ stars: {} }); await tick();
  const p1 = store.save('s', 'k', { tag: 'star' }, { kind: 'event', excerpt: () => 'text' });
  const p2 = store.save('s', 'k', null);
  await tick();
  assert.deepEqual(calls.map(c => c.method), ['PUT'], 'the DELETE waits for the PUT');
  assert.equal(calls[0].body.excerpt, 'text');
  assert.equal(store.get('s', 'k'), null, 'the newest change shows at once');
  calls.shift().resolve({ star: { tag: 'star', excerpt: 'text' } }); await tick();
  assert.equal(store.get('s', 'k'), null, 'the PUT reply is stale: the unstar stands');
  assert.deepEqual(calls.map(c => c.method), ['DELETE']);
  calls.shift().resolve({ removed: true }); await Promise.all([p1, p2]);
  assert.equal(store.get('s', 'k'), null);

  // A failed older save does not roll back a newer one; the newer one's failure rolls back to the server's state.
  const a = store.save('s', 'k', { tag: 'note' });
  const b = store.save('s', 'k', { tag: 'decision' });
  await tick(); calls.shift().reject(new Error('boom')); await tick();
  assert.equal(store.get('s', 'k').tag, 'decision');
  calls.shift().resolve({ star: { tag: 'decision', excerpt: '' } }); await Promise.all([a, b]);
  assert.equal(store.get('s', 'k').tag, 'decision');
  const c = store.save('s', 'k', { tag: 'question' });
  await tick(); calls.shift().reject(new Error('down')); await c;
  assert.equal(store.get('s', 'k').tag, 'decision', 'rolled back to what the server has');
});

test('StarStore: a save and a live event during the first load survive it', async () => {
  const { store, calls, changes, tick } = scripted();
  assert.equal(store.get('s', 'x'), null);
  assert.equal(calls[0].method, 'GET');
  const saved = store.save('s', 'mine', { tag: 'star' });
  store.applyRemote({ sessionId: 's', key: 'theirs', star: { tag: 'note' } });
  calls.shift().resolve({ stars: { old: { tag: 'star' } } }); await tick();
  assert.equal(store.get('s', 'mine').tag, 'star', 'the optimistic star is kept');
  assert.equal(store.get('s', 'theirs').tag, 'note', 'the live event is kept');
  assert.equal(store.get('s', 'old').tag, 'star', 'and the server data merged in');
  assert.equal(changes.filter(k => k === null).length, 1, 'one notice for the whole load');
  calls.shift().resolve({ star: { tag: 'star' } }); await saved;
});

test('StarStore: a failed load is not cached; a reconnect reloads', async () => {
  const { store, calls, tick } = scripted();
  store.get('s', 'k'); calls.shift().reject(new Error('offline')); await tick();
  assert.equal(store.get('s', 'k'), null);
  assert.equal(calls.length, 0, 'not hammered on every read');
  store.failedAt.set('s', 0); // the retry interval has passed
  store.get('s', 'k');
  calls.shift().resolve({ stars: { k: { tag: 'star' } } }); await tick();
  assert.equal(store.get('s', 'k').tag, 'star');
  store.reset();
  assert.equal(calls[0]?.method, 'GET', 'reloaded after a reconnect');
  calls.shift().resolve({ stars: {} }); await tick();
  assert.equal(store.get('s', 'k'), null);
  assert.equal(store.get('other', 'k'), null, 'an unloaded session reads as empty');
});
