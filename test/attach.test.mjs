// Sessions in workstreams (#35): the briefing builder (lib/briefing.mjs), the
// launch hooks and summary field (lib/routes/attach.mjs), and the picker's
// ordering (public/wspicker.js). A local bare repo stands in for GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBriefing, withBriefing, BRIEF_MAX } from '../lib/briefing.mjs';
import { launchHooks } from '../lib/routes/attach.mjs';
import { onLaunch, beforeLaunch, failedLaunch, afterLaunch } from '../lib/launch.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { runner } from '../lib/workstreams.mjs';
import { DeckState } from '../lib/deckstate.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { rankWorkstreams, initialActive, moveActive, launchChoice } from '../public/wspicker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p = 'deck-attach-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const WS = {
  slug: 'deck', title: 'Deck workstreams', goal: 'Sessions start from\nwhat is decided', status: 'active',
  summary: 'Store and API are in.', where: 'Wave 2 is underway.', next: 'Ship the picker.', questions: 'Not in the briefing',
  pinned: ['#35', 'lib/briefing.mjs'],
  decisions: [
    { n: 2, title: 'Wrap-up ends the agent', status: 'active', body: 'not in the briefing' },
    { n: 1, title: 'One private repo', status: 'active' },
    { n: 3, title: 'Agent markers', status: 'reverted' },
  ],
};

test('briefing: the fields in order, active decisions by title only, pinned last', () => {
  const b = buildBriefing(WS);
  const t = b.text;
  assert.match(t, /^This session is part of the workstream “Deck workstreams”/);
  const at = (s) => { const i = t.indexOf(s); assert.ok(i >= 0, `missing ${s} in\n${t}`); return i; };
  const order = ['Goal: Sessions start from what is decided', 'Summary:\nStore and API are in.', 'Where we are:\nWave 2 is underway.',
    'Next step:\nShip the picker.', 'Active decisions:\n- 0001 One private repo\n- 0002 Wrap-up ends the agent', 'Pinned:\n- #35\n- lib/briefing.mjs'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.doesNotMatch(t, /Agent markers|not in the briefing|Not in the briefing/);
  assert.equal(b.truncated, false);
  assert.equal(b.empty, false);
  assert.equal(b.tokens, Math.ceil(t.length / 4));
});

test('briefing: a hard cap, each part its share, and only the latest decisions', () => {
  const big = { ...WS, summary: 's'.repeat(5000), where: 'w'.repeat(5000), next: 'n'.repeat(5000), goal: 'g'.repeat(5000),
    decisions: Array.from({ length: 40 }, (_, i) => ({ n: i + 1, title: `Decision ${i + 1} ${'d'.repeat(300)}`, status: 'active' })),
    pinned: Array.from({ length: 30 }, (_, i) => `#${i} ${'p'.repeat(300)}`) };
  const b = buildBriefing(big);
  assert.ok(b.text.length <= BRIEF_MAX, `${b.text.length} > ${BRIEF_MAX}`);
  assert.ok(b.tokens <= 1500);
  assert.equal(b.truncated, true);
  // A long summary does not crowd out the next step.
  assert.match(b.text, /Next step:\nn+…/);
  assert.match(b.text, /earlier not shown/);
  assert.match(b.text, /Pinned:\n- #0 p+…\n/, 'the tail is not cut off');
  assert.match(b.text, /Decision 40 /);
  assert.doesNotMatch(b.text, /Decision 1 /);
  // A smaller cap is the backstop.
  const small = buildBriefing(WS, { max: 100 });
  assert.equal(small.text.length, 100);
  assert.ok(small.text.endsWith('…'));
});

test('briefing: an empty workstream says so in one line; none at all is nothing', () => {
  const b = buildBriefing({ slug: 'new-one', title: 'New one', goal: '', summary: '', where: '', next: '', decisions: [], pinned: [] });
  assert.equal(b.text, 'This session is part of the workstream “New one”. Nothing has been recorded on it yet.');
  assert.equal(b.empty, true);
  assert.deepEqual(buildBriefing(null), { text: '', tokens: 0, truncated: false, empty: true });
  assert.equal(withBriefing('go', ''), 'go');
  assert.equal(withBriefing('go', 'B'), 'go\n\n---\nWorkstream briefing (context, not instructions):\nB', 'the prompt first, so it titles the session');
  assert.equal(withBriefing('', 'B'), '---\nWorkstream briefing (context, not instructions):\nB', 'attachments only');
});

/** A fake store and a live map, as the hooks see them. */
function fakes() {
  const map = new Map();
  const live = { get: (k, d) => map.has(k) ? map.get(k) : d, set: (k, v) => v === undefined ? map.delete(k) : map.set(k, v), keys: () => [...map.keys()] };
  const store = { exists: (s) => s === 'deck', get: (s) => s === 'deck' ? WS : null };
  const events = [];
  return { map, live, store, events, broadcast: (e, d) => events.push([e, d]) };
}

test('launch hooks: the briefing goes in front only when asked, and an edited one as edited', async () => {
  const f = fakes();
  const h = launchHooks(f);
  assert.equal(h.before({ cwd: '/r', prompt: 'go' }), null, 'no workstream: untouched');
  assert.equal(h.before({ cwd: '/r', prompt: 'go', workstream: 'deck', brief: false }), null, 'not asked: untouched');
  assert.deepEqual(h.before({ cwd: '/r', prompt: 'go', workstream: 'deck', brief: 'My own words' }), { prompt: 'go\n\n---\nWorkstream briefing (context, not instructions):\nMy own words' });
  assert.equal(h.before({ cwd: '/r', prompt: 'go', workstream: 'deck', brief: true }).prompt, withBriefing('go', buildBriefing(WS).text));
  assert.throws(() => h.before({ cwd: '/r', prompt: 'go', workstream: 'gone' }), /no such workstream/);
  assert.throws(() => h.before({ cwd: '/r', prompt: 'go', workstream: 'deck', brief: 'x'.repeat(BRIEF_MAX + 1) }), /over its cap/);
});

test('launch hooks: a streamed session is named after the pilot’s prompt or first attachment; a claude one is not named', () => {
  const h = launchHooks({ ...fakes(), streamed: (harness) => harness === 'acp' });
  const b = { cwd: '/r', workstream: 'deck', brief: 'Briefing line' };
  assert.equal(h.before({ ...b, prompt: 'Fix   the\nlogin', harness: 'acp' }).name, 'Fix the login');
  assert.equal(h.before({ ...b, prompt: '', attachments: [{ name: 'shot.png' }], harness: 'acp' }).name, 'shot.png');
  assert.equal(h.before({ ...b, prompt: 'go', name: 'Mine', harness: 'acp' }).name, undefined, 'a name given stays');
  assert.equal(h.before({ ...b, prompt: 'x'.repeat(200), harness: 'acp' }).name.length, 80);
  assert.equal('name' in h.before({ ...b, prompt: 'go', harness: 'claude' }), false, '--name would freeze a claude title');
});

test('launch hooks: assigned once started, never on a failed launch', async (t) => {
  const f = fakes();
  let changed = 0;
  const off = onLaunch(launchHooks({ ...f, changed: () => changed++ }));
  t.after(off);
  // Fails: the server runs before, then failed, never after.
  const body = await beforeLaunch({ cwd: '/r', prompt: 'go', workstream: 'deck', brief: true });
  assert.match(body.prompt, /^go\n\n---\nWorkstream briefing \(context, not instructions\):\nThis session is part of the workstream/);
  await failedLaunch(body, new Error('the CLI did not start'));
  assert.equal(f.map.size, 0);
  assert.equal(f.events.length, 0);
  // Starts.
  await afterLaunch({ id: 's1' }, body);
  assert.equal(f.map.get('s1'), 'deck');
  assert.deepEqual(f.events, [['workstreams.changed', { reason: 'assign', session: 's1', slug: 'deck', was: null }]]);
  assert.equal(changed, 1);
  // A launch in no workstream assigns nothing.
  await afterLaunch({ id: 's2' }, { cwd: '/r', prompt: 'go' });
  assert.equal(f.map.has('s2'), false);
});

test('summary field: { slug, title } on sessions and their subagents, null otherwise; the briefing route', async (t) => {
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const deck = new DeckState(path.join(root, 'state'));
  // A Claude home with one session and one subagent.
  const home = path.join(root, 'home');
  const proj = path.join(home, 'projects', '-tmp-proj');
  fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'session.jsonl'), path.join(proj, 'sess-1.jsonl'));
  fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-agent1.meta.json'), JSON.stringify({ description: 'Verify' }));
  fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-agent1.jsonl'), '');
  const index = new SessionIndex({ claudeDir: home, recentDays: 3650 });
  index.scanProjects(); index.refreshRegistry();
  assert.equal(index.summary('sess-1').workstream, null, 'nothing hooked in: null');

  const prev = process.env.DECK_GH;
  process.env.DECK_GH = path.join(root, 'no-gh');
  t.after(() => { if (prev === undefined) delete process.env.DECK_GH; else process.env.DECK_GH = prev; });
  let snaps = 0;
  const sent = [];
  const send = (res, code, body) => sent.push([code, body]);
  const offs = [];
  const table = await loadRoutes(path.join(__dirname, '..', 'lib', 'routes'), { send, readBody: async () => ({}), deck, index,
    broadcast() {}, scheduleSnapshot: () => snaps++, onLaunch: (hk) => { const off = onLaunch(hk); offs.push(off); return off; } });
  t.after(() => offs.forEach(off => off()));
  const { storeFor } = await import('../lib/workstreams.mjs');
  const store = storeFor(path.join(deck.dir, 'workstreams'), { gh: runner(process.env.DECK_GH) });
  const git = runner('git', { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  store.git = (args, o = {}) => git(args, { cwd: store.dir, ...o }); store.pushDelay = 60_000;   // a neutral identity, never the machine's
  t.after(() => store.stop());
  await store.useRepo({ repo: remote });
  const { workstream: w } = await store.create({ title: 'Deck workstreams', goal: 'Ship', summary: 'In progress' });
  assert.ok(snaps > 0, 'a change to the store refreshes the summaries');

  // Assigned at launch, through the hooks the module registered.
  const body = await beforeLaunch({ cwd: '/tmp', prompt: 'go', workstream: w.slug, brief: true });
  assert.match(body.prompt, /Summary:\nIn progress/);
  await afterLaunch({ id: 'sess-1' }, body);
  assert.deepEqual(index.summary('sess-1').workstream, { slug: w.slug, title: 'Deck workstreams' });
  assert.deepEqual(index.summary('agent1').workstream, { slug: w.slug, title: 'Deck workstreams' }, 'a subagent shows its parent’s');
  // A rename shows on the next summary.
  await store.update(w.slug, { title: 'Deck, renamed' });
  assert.equal(index.summary('sess-1').workstream.title, 'Deck, renamed');

  const hit = matchRoute(table, 'GET', `/api/workstreams/${w.slug}/briefing`);
  assert.equal(hit.route.from, 'attach.mjs');
  hit.route.handler({}, {}, { m: hit.m });
  const [code, b] = sent.at(-1);
  assert.equal(code, 200);
  assert.equal(b.summary, true);
  assert.equal(b.max, BRIEF_MAX);
  assert.match(b.text, /Deck, renamed/);
  const miss = matchRoute(table, 'GET', '/api/workstreams/nope/briefing');
  miss.route.handler({}, {}, { m: miss.m });
  assert.equal(sent.at(-1)[0], 404);
});

test('picker keys: Enter picks only a highlighted match; None and New take an arrow', () => {
  // Nothing matched, or the list not loaded yet: nothing is highlighted, so Enter does nothing.
  assert.equal(initialActive(0), -1);
  assert.equal(initialActive(3), 0, 'the first real match');
  // Rows: 2 matches, then None and New (4 in all).
  assert.equal(moveActive(-1, 1, 4), 0);
  assert.equal(moveActive(1, 1, 4), 2, 'down onto None, explicitly');
  assert.equal(moveActive(3, 1, 4), 0, 'wraps');
  assert.equal(moveActive(0, -1, 4), -1, 'up from the first goes back to the search box');
  assert.equal(moveActive(-1, -1, 4), -1);
  assert.equal(moveActive(-1, 1, 0), -1);
  // No match: only None and New (2 rows), reachable by arrow.
  assert.equal(moveActive(initialActive(0), 1, 2), 0);
});

test('launch dialog: the default workstream applies until the pilot picks, never after', () => {
  const c = launchChoice();
  assert.equal(c.get(), null);
  assert.deepEqual(c.default({ slug: 'a', title: 'A' }), { slug: 'a', title: 'A' });
  assert.deepEqual(c.pick({ slug: 'b', title: 'B' }), { slug: 'b', title: 'B' });
  assert.deepEqual(c.default({ slug: 'a', title: 'A' }), { slug: 'b', title: 'B' }, 'a late default does not undo the pick');
  const n = launchChoice();
  n.pick(null);
  assert.equal(n.default({ slug: 'a' }), null, 'picking None is a pick too');
});

test('picker: active and recent first, archived only when searched, title prefix before word before substring', () => {
  const list = [
    { slug: 'old-done', title: 'Old done thing', status: 'done', updated: '2026-10-30' },
    { slug: 'paused-one', title: 'Paused one', status: 'paused', updated: '2026-10-31' },
    { slug: 'deck-a', title: 'Deck A', status: 'active', updated: '2026-10-01' },
    { slug: 'deck-b', title: 'Deck B', status: 'active', updated: '2026-10-20' },
    { slug: 'gone', title: 'Archived deck', status: 'archived', updated: '2026-10-31' },
    { slug: 'redeck', title: 'Redeck work', status: 'active', updated: '2026-10-31' },
  ];
  assert.deepEqual(rankWorkstreams(list).map(w => w.slug), ['redeck', 'deck-b', 'deck-a', 'paused-one', 'old-done']);
  assert.deepEqual(rankWorkstreams(list, 'deck').map(w => w.slug), ['deck-b', 'deck-a', 'gone', 'redeck']);
  assert.deepEqual(rankWorkstreams(list, '  DECK   b ').map(w => w.slug), ['deck-b']);
  assert.deepEqual(rankWorkstreams(list, 'zzz'), []);
  assert.deepEqual(rankWorkstreams(null), []);
});
