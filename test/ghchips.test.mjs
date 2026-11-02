// GitHub chips (#30): state and CI from one batched gh query (lib/ghstate.mjs),
// issues placed after their PRs, the poll's pacing (public/ghpoll.js), the
// fix-CI prompt, and the route, all against a fake gh (test/fixtures/fake-gh.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stateOf, issueFromBranch, buildQuery, parseData, parseHttp, backoffOf, associate, GhState, keyOf, parseKey, fixCiPrompt, logTail } from '../lib/ghstate.mjs';
import { GitHubInfo, refsFromEvents } from '../lib/ghrefs.mjs';
import { PollScheduler, POLL, coalesce, chipState, chipClass, chipLabel, countLinks } from '../public/ghpoll.js';
import { parseQuery, answer, conflicts } from './fixtures/fake-gh.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-gh.mjs');
const DATA = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'gh-data.json'), 'utf8'));
const R = 'octo-example/widgets';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gh-'));
/** A fake gh data file of our own, and a log of the calls made. */
function fakeEnv(data = DATA) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gh.json'), JSON.stringify(data));
  process.env.FAKE_GH_DATA = path.join(dir, 'gh.json');
  process.env.FAKE_GH_LOG = path.join(dir, 'calls.log');
  return { calls: () => { try { return fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } } };
}

test('state → class: GitHub\'s own states, CI only on open and draft PRs', () => {
  const pr = (o) => ({ __typename: 'PullRequest', state: 'OPEN', isDraft: false, merged: false, ...o });
  assert.equal(stateOf(pr()), 'open');
  assert.equal(stateOf(pr({ isDraft: true })), 'draft');
  assert.equal(stateOf(pr({ state: 'MERGED', merged: true })), 'merged');
  assert.equal(stateOf(pr({ state: 'CLOSED' })), 'closed');
  const issue = (o) => ({ __typename: 'Issue', state: 'OPEN', ...o });
  assert.equal(stateOf(issue()), 'open');
  assert.equal(stateOf(issue({ state: 'CLOSED', stateReason: 'COMPLETED' })), 'closed');
  assert.equal(stateOf(issue({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })), 'not-planned');
  assert.equal(stateOf(null), null);

  assert.equal(chipClass({ kind: 'pr', st: 'open', ci: 'failure' }), 'gh pr st-open ci-failure');
  assert.equal(chipClass({ kind: 'pr', st: 'draft', ci: 'pending' }), 'gh pr st-draft ci-pending');
  assert.equal(chipClass({ kind: 'pr', st: 'merged', ci: 'success' }), 'gh pr st-merged', 'no CI glyph once merged');
  assert.equal(chipClass({ kind: 'pr', st: 'closed' }), 'gh pr st-closed');
  assert.equal(chipClass({ kind: 'issue', st: 'not-planned' }), 'gh issue st-not-planned');
  // From the place's older shape (state, draft, checks) before the poll answers.
  assert.equal(chipClass({ kind: 'pr', state: 'open', draft: true, checks: { state: 'success' } }), 'gh pr st-draft ci-success');
  assert.equal(chipClass({ kind: 'issue' }), 'gh issue st-unknown');
  assert.deepEqual(chipState({ kind: 'pr', state: 'merged' }), { kind: 'pr', st: 'merged', ci: null });
  // The shape is in the label too, not only the colour.
  assert.equal(chipLabel({ kind: 'pr', number: 34, st: 'open', ci: 'failure', review: 'changes_requested', conflicts: true, title: 'Fix it' }),
    'Pull request #34: open, CI failing, changes requested, merge conflicts. Fix it');
  assert.equal(chipLabel({ kind: 'issue', number: 14, st: 'not-planned' }, 'widgets#14'), 'Issue widgets#14: closed as not planned.');
});

test('issues go right after their PR: closes, the branch name, the session\'s own "fixes #N"', () => {
  assert.equal(issueFromBranch('123-foo'), 123);
  assert.equal(issueFromBranch('feature/45_bar'), 45);
  assert.equal(issueFromBranch('issue-7'), 7);
  assert.equal(issueFromBranch('gh12-x'), 12);
  assert.equal(issueFromBranch('v2-release'), null);
  assert.equal(issueFromBranch('main'), null);

  const ref = (kind, number, o = {}) => ({ kind, repo: R, number, url: `u${number}`, ...o });
  const infos = {
    [`${R}#34`]: { kind: 'pr', number: 34, closes: [{ repo: R, number: 12 }], head: '12-fix-widget' },
    [`${R}#36`]: { kind: 'pr', number: 36, closes: [], head: '20-speed' },
    [`${R}#50`]: { kind: 'pr', number: 50, closes: [] },
  };
  // Most recent first: an unrelated issue, PR 36, issue 12 (closed by 34), PR 34.
  const out = associate([ref('issue', 99), ref('pr', 36), ref('issue', 12), ref('pr', 34)], infos);
  assert.deepEqual(out.map(r => `${r.kind}${r.number}${r.of ? `<${r.of.split('#')[1]}` : ''}`),
    ['issue99', 'pr36', 'issue20<36', 'pr34', 'issue12<34'], 'issue 20 from the branch name is added; 12 moves to its PR');
  assert.equal(out.find(r => r.number === 20).url, `https://github.com/${R}/issues/20`);

  // The session's own PR (branch: true) takes the issues its commits fix, and its branch's issue.
  const own = associate([ref('pr', 50, { branch: true }), ref('issue', 18), ref('issue', 9, { fixes: true })], infos, { branch: '18-thing' });
  assert.deepEqual(own.map(r => `${r.number}${r.of ? '<' : ''}`), ['50', '18<', '9<']);
  // A number that turns out to be a PR is not hung under another PR.
  const two = associate([ref('pr', 34), ref('issue', 36)], infos);
  assert.deepEqual(two.map(r => r.number), [34, 12, 36, 20], 'GitHub says 36 is a PR: it gets its own branch issue');
  assert.equal(two[2].of, undefined);

  // refsFromEvents marks the issues a commit says it fixes.
  const refs = refsFromEvents([{ kind: 'tool', seq: 1, tool: { name: 'Bash', input: { command: 'git commit -m "Widen it, fixes #12"' } } }], { repo: R });
  assert.deepEqual(refs.map(r => [r.number, r.fixes]), [[12, true]]);
});

test('poll pacing: 60s, 15s while CI runs, paused while hidden, backing off on failures and rate limits', () => {
  const now = 1_000_000;
  const s = new PollScheduler();
  assert.equal(s.next({ now }), POLL.base);
  assert.equal(s.next({ running: true, now }), POLL.fast);
  assert.equal(s.next({ hidden: true, now }), null);
  assert.equal(s.next({ watching: false, now }), null);
  // Failures double the wait, up to the cap; running CI does not hurry a back-off.
  s.fail({ now }); assert.equal(s.next({ now, running: true }), 60_000);
  s.fail({ now }); assert.equal(s.next({ now }), 120_000);
  s.fail({ now }); assert.equal(s.next({ now }), 240_000);
  for (let i = 0; i < 10; i++) s.fail({ now });
  assert.equal(s.next({ now }), POLL.max);
  assert.equal(s.next({ now: now + POLL.max - 1000 }), POLL.base, 'the wait counts down');
  s.ok(); assert.equal(s.next({ now, running: true }), POLL.fast);
  // A rate limit waits at least as long as the server says.
  s.fail({ retryAfter: 600, now }); assert.equal(s.next({ now }), 600_000);
  s.ok(); s.fail({ retryAfter: 5, now }); assert.equal(s.next({ now }), 60_000);
  assert.equal(s.next({ now, hidden: true }), null, 'hidden still pauses');
});

test('the rate limit, from gh -i headers and the query\'s own budget', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const res = parseHttp('HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1793548800\r\n\r\n{"message":"x"}');
  assert.equal(res.status, 403);
  assert.equal(res.headers['retry-after'], '120');
  assert.equal(res.body, '{"message":"x"}');
  assert.equal(backoffOf(res, now), 120_000);
  assert.equal(backoffOf({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 900) } }, now), 900_000);
  assert.equal(backoffOf({ status: 200, headers: {}, json: { errors: [{ type: 'RATE_LIMITED' }] } }, now), 300_000);
  assert.equal(backoffOf({ status: 200, headers: {}, json: { data: { rateLimit: { remaining: 10, resetAt: '2026-11-01T12:30:00Z' } } } }, now), 1_800_000);
  assert.equal(backoffOf({ status: 200, headers: {}, json: { data: { rateLimit: { remaining: 4000, resetAt: '2026-11-01T12:30:00Z' } } } }, now), 0);
  assert.equal(parseHttp('{"data":{}}').status, null, 'no head: just a body');
});

test('one query for everything: the fake gh parses what buildQuery writes', () => {
  const items = [
    { kind: 'ref', repo: R, number: 34 }, { kind: 'ref', repo: R, number: 14 }, { kind: 'ref', repo: 'Octo-Example/widgets', number: 34 },
    { kind: 'branch', repo: R, branch: '12-fix-"widget"' }, { kind: 'milestone', repo: R, number: 3 },
    { kind: 'ref', repo: 'other/repo', number: 1 }, { kind: 'ref', repo: 'not a repo', number: 2 },
  ];
  const { query, plan } = buildQuery(items);
  assert.equal(plan.length, 5, 'duplicates (repos compare case-blind) and bad repos left out');
  assert.match(query, /rateLimit \{ remaining resetAt \}/);
  assert.match(query, /fragment P on PullRequest/); assert.match(query, /fragment I on Issue/); assert.match(query, /fragment M on Milestone/);
  const parsed = parseQuery(query);
  assert.deepEqual(parsed.repos.map(r => r.repo), [R, 'other/repo']);
  assert.deepEqual(parsed.repos[0].items.map(i => i.kind + (i.number ?? i.branch)), ['ref34', 'ref14', 'branch12-fix-"widget"', 'milestone3']);
  assert.equal(parsed.rateLimit, true);
  // Only the fragments in use: GitHub refuses unused ones.
  assert.doesNotMatch(buildQuery([{ kind: 'branch', repo: R, branch: 'x' }]).query, /fragment I on Issue/);

  const data = answer(buildQuery([{ kind: 'ref', repo: R, number: 34 }, { kind: 'branch', repo: R, branch: '12-fix-widget' }, { kind: 'ref', repo: R, number: 404 }, { kind: 'milestone', repo: R, number: 3 }]).query, DATA);
  const out = parseData(data, buildQuery([{ kind: 'ref', repo: R, number: 34 }, { kind: 'branch', repo: R, branch: '12-fix-widget' }, { kind: 'ref', repo: R, number: 404 }, { kind: 'milestone', repo: R, number: 3 }]).plan);
  const pr = out[`${R}#34`];
  assert.equal(pr.st, 'open'); assert.equal(pr.ci, 'failure'); assert.equal(pr.review, 'changes_requested');
  assert.equal(pr.unresolved, 2); assert.equal(pr.activity, 2 + 6); assert.equal(pr.conflicts, true); assert.equal(pr.author, 'octocat');
  assert.deepEqual(pr.fails.map(f => [f.name, f.runId]), [['lint', 9001], ['test (node 20)', 9001]]);
  assert.match(pr.fails[0].url, /actions\/runs\/9001/);
  assert.deepEqual(pr.closes, [{ repo: R, number: 12 }]);
  assert.equal(out[`${R}@12-fix-widget`].number, 34);
  assert.equal(out[`${R}#404`], null);
  assert.deepEqual([out[`${R}%3`].open, out[`${R}%3`].closed], [4, 9]);

  assert.deepEqual(parseKey(`${R}#34`), { kind: 'ref', repo: R, number: 34 });
  assert.deepEqual(parseKey(`${R}%3`), { kind: 'milestone', repo: R, number: 3 });
  assert.deepEqual(parseKey(`${R}@a/b`), { kind: 'branch', repo: R, branch: 'a/b' });
  assert.equal(parseKey('nope'), null);
});

test('GhState through the fake gh: one batched call, cached, and quiet while rate limited', async () => {
  const env = fakeEnv();
  const g = new GhState({ bin: FAKE });
  const items = [{ kind: 'ref', repo: R, number: 34 }, { kind: 'ref', repo: R, number: 35 }, { kind: 'ref', repo: R, number: 36 }, { kind: 'ref', repo: R, number: 13 }, { kind: 'ref', repo: R, number: 14 }];
  const r = await g.fetch(items);
  assert.equal(r.gh, true); assert.equal(r.rateLimited, false);
  assert.deepEqual(items.map(i => r.items[keyOf(i)].st), ['open', 'draft', 'merged', 'closed', 'not-planned']);
  assert.equal(r.items[`${R}#35`].ci, 'pending');
  assert.equal(env.calls().length, 1, 'one gh call for all five');
  await g.fetch(items);
  assert.equal(env.calls().length, 1, 'fresh answers come from the cache');
  assert.match(await g.failedLog(R, 9001), /no-unused-vars/);
  assert.equal(await g.failedLog(R, 'x; rm -rf'), null, 'run ids are numbers');

  const limited = fakeEnv({ ...DATA, limited: 300 });
  const g2 = new GhState({ bin: FAKE });
  const a = await g2.fetch(items);
  assert.equal(a.rateLimited, true);
  assert.ok(a.retryAfter >= 290 && a.retryAfter <= 300, `retryAfter ${a.retryAfter}`);
  assert.equal(a.items[`${R}#34`], undefined, 'unknown, not "missing"');
  await g2.fetch(items, { maxAge: 0 });
  assert.equal(limited.calls().length, 1, 'no second call while blocked');

  const none = new GhState({ bin: path.join(tmp(), 'no-such-gh') });
  const n = await none.fetch(items);
  assert.equal(n.gh, false);
});

test('GitHubInfo: the branch\'s PR leads with its issues; reviews raise "needs you" until looked at', async () => {
  fakeEnv();
  const gi = new GitHubInfo({ bin: FAKE });
  const refs = [{ kind: 'issue', repo: R, number: 14, url: 'u', lastSeq: 9 }, { kind: 'pr', repo: R, number: 36, url: 'u', lastSeq: 5 }];
  const out = await gi.enrich(refs, { repo: R, branch: '12-fix-widget', defaultBranch: 'main' });
  assert.deepEqual(out.map(r => `${r.number}:${r.st}${r.branch ? '*' : ''}${r.of ? '<' : ''}`), ['34:open*', '12:open<', '14:not-planned', '36:merged', '13:closed<']);
  assert.ok(out.every(r => !('lastSeq' in r)));

  const pr = await gi.branchPr(R, '12-fix-widget');
  assert.deepEqual(gi.needOf(pr), { pr: 34, url: pr.url, failing: ['lint', 'test (node 20)'] }, 'red CI first');
  const green = { ...pr, ci: 'success', checks: null };
  const need = gi.needOf(green);
  assert.equal(need.kind, 'review'); assert.equal(need.signal, 'input'); assert.equal(need.text, 'Changes requested on PR #34');
  assert.equal(gi.needOf({ ...green, review: null, unresolved: 1 }).text, '1 unresolved review comment on PR #34');
  assert.equal(gi.needOf({ ...green, review: 'approved', unresolved: 0 }), null);
  assert.equal(gi.needOf({ ...pr, state: 'merged' }), null);
  const seen = new Map();
  gi.seen = { get: (k) => seen.get(k), set: (k, v) => seen.set(k, v) };
  assert.equal(gi.current(need), need);
  seen.set(`${R}#34`, 8);
  assert.equal(gi.current(need), null, 'looked at');
  assert.equal(gi.current({ ...need, activity: 9 })?.activity, 9, 'something new since');
  assert.deepEqual(gi.current({ pr: 1, failing: [] }), { pr: 1, failing: [] }, 'CI needs are not "seen" away');
});

test('the fix-CI prompt names the failing checks and stays under its cap', () => {
  const tail = logTail(DATA.logs['9001'], 4);
  assert.equal(tail.split('\n').length, 4);
  assert.doesNotMatch(tail, /\t|2026-11-01T|\x1b/, 'columns, timestamps and colours dropped');
  assert.match(tail, /actual: 336/);

  const fails = [{ name: 'lint', url: 'https://example.com/run/1' }, { name: 'test', url: null }];
  const p = fixCiPrompt({ repo: R, number: 34, title: 'Fix it', branch: '12-fix', fails, logs: [{ name: 'lint', runId: 1, text: logTail(DATA.logs['9001']) }] });
  assert.match(p, /^CI is failing on PR #34 "Fix it" in octo-example\/widgets \(branch 12-fix\)/);
  assert.match(p, /- lint \(https:\/\/example.com\/run\/1\)\n- test\n/);
  assert.match(p, /Log tail, lint:\n```\n[\s\S]*no-unused-vars[\s\S]*```/);
  assert.match(p, /Please find the cause, fix it, and push/);

  const huge = 'x'.repeat(50_000) + '\nTHE END';
  for (const max of [6000, 2500, 900]) {
    const q = fixCiPrompt({ repo: R, number: 34, fails, logs: [{ name: 'a', text: huge }, { name: 'b', text: huge }] }, { max });
    assert.ok(q.length <= max, `${q.length} <= ${max}`);
    assert.match(q, /Please find the cause/, 'the ask always fits');
  }
  const big = fixCiPrompt({ repo: R, number: 34, fails, logs: [{ name: 'a', text: huge }] }, { max: 6000 });
  assert.match(big, /THE END\n```/, 'the tail is what is kept');
  const many = fixCiPrompt({ repo: R, number: 34, fails: Array.from({ length: 500 }, (_, i) => ({ name: `check-${i}`, url: null })) }, { max: 1000 });
  assert.ok(many.length <= 1000);
});

test('link counts for workstream cards: issues and PRs one each, milestones their issues', () => {
  const info = { [`${R}#1`]: { kind: 'issue', state: 'open' }, [`${R}#2`]: { kind: 'issue', state: 'closed' }, [`${R}#3`]: { kind: 'pr', state: 'merged' },
    [`${R}%3`]: { kind: 'milestone', open: 4, closed: 9 } };
  const links = [{ kind: 'issue', repo: R, number: 1 }, { kind: 'issue', repo: R, number: 2 }, { kind: 'pr', repo: R, number: 3 }, { kind: 'milestone', repo: R, number: 3 }, { kind: 'issue', repo: R, number: 77 }];
  const k = (l) => `${l.repo.toLowerCase()}${l.kind === 'milestone' ? '%' : '#'}${l.number}`;
  assert.deepEqual(countLinks(links, (l) => info[k(l)]), { open: 5, closed: 11, known: 4, total: 5 });
});

test('the route: state with an ETag (304 when unchanged), the fix-CI prompt, and "seen"', async () => {
  fakeEnv();
  const store = {};
  const deck = { ns: () => ({ get: (k, d) => structuredClone(store[k] ?? d), set: (k, v) => { store[k] = v; } }) };
  const github = new GitHubInfo({ bin: FAKE });
  const refreshed = [];
  const index = { files: new Map([['s1', {}]]), refresh: (id) => refreshed.push(id) };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
  const table = await loadRoutes(path.join(HERE, '..', 'lib', 'routes'), { send, readBody, deck, index, github, scheduleSnapshot() {} });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
    send(res, 404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const q = `${base}/api/gh/state?k=${[`${R}#34`, `${R}%3`, 'garbage'].map(encodeURIComponent).join(',')}`;
    const a = await fetch(q);
    const body = await a.json();
    assert.equal(body.items[`${R}#34`].ci, 'failure');
    assert.equal(body.items[`${R}%3`].open, 4);
    assert.deepEqual(Object.keys(body.items).length, 2);
    const etag = a.headers.get('etag');
    assert.ok(etag);
    assert.equal((await fetch(q, { headers: { 'If-None-Match': etag } })).status, 304);

    const fix = await (await fetch(`${base}/api/gh/fixci?repo=${encodeURIComponent(R)}&number=34`)).json();
    assert.match(fix.prompt, /Failing checks:\n- lint/);
    assert.match(fix.prompt, /Log tail, lint:[\s\S]*actual: 336/);
    assert.equal(fix.prompt.match(/Log tail/g).length, 1, 'both checks share run 9001: one log');
    assert.equal((await fetch(`${base}/api/gh/fixci?repo=${encodeURIComponent(R)}&number=12`)).status, 404, 'an issue has no CI');
    assert.equal((await fetch(`${base}/api/gh/fixci?repo=bad&number=1`)).status, 400);

    const seen = await fetch(`${base}/api/gh/seen`, { method: 'POST', body: JSON.stringify({ sessionId: 's1', key: `${R}#34`, activity: 8 }) });
    assert.equal(seen.status, 200);
    assert.deepEqual(store.seen, { [`${R}#34`]: 8 });
    assert.deepEqual(refreshed, ['s1']);
    assert.equal(github.current({ kind: 'review', key: `${R}#34`, activity: 8 }), null);
  } finally { server.close(); }
});

test('Issue and PullRequest fields of different types are aliased; the fake gh refuses them otherwise', async () => {
  const { query } = buildQuery([{ kind: 'ref', repo: R, number: 34 }]);
  assert.deepEqual(conflicts(query), []);
  assert.match(query, /prState: state/);
  assert.deepEqual(conflicts(query.replace('prState: state', 'state')), ['state']);
  // Served the way GitHub would: a refused query leaves everything unknown.
  fakeEnv();
  const g = new GhState({ bin: FAKE });
  const run = g._run;
  g._run = (args) => run.call(g, args.map(a => a.startsWith('query=') ? a.replace('prState: state', 'state') : a));
  assert.equal((await g.fetch([{ kind: 'ref', repo: R, number: 34 }])).items[`${R}#34`], undefined);
  // The aliased one comes back with the state mapped.
  const ok = await new GhState({ bin: FAKE }).fetch([{ kind: 'ref', repo: R, number: 36 }, { kind: 'ref', repo: R, number: 12 }]);
  assert.deepEqual([ok.items[`${R}#36`].st, ok.items[`${R}#12`].st], ['merged', 'open']);
});

test('caching: stale values come back at once while they refresh; failures are cached briefly', async () => {
  const items = [{ kind: 'ref', repo: R, number: 34 }];
  // A gh that cannot answer (offline, signed out) is asked once, not on every request.
  const down = fakeEnv({ ...DATA, fail: true });
  const g = new GhState({ bin: FAKE });
  assert.equal((await g.fetch(items)).items[`${R}#34`], undefined);
  assert.equal((await g.fetch(items, { maxAge: 0 })).items[`${R}#34`], undefined);
  assert.equal(down.calls().length, 1);

  // Stale while revalidating: a slow refresh holds nobody up.
  const env = fakeEnv();
  const h = new GhState({ bin: FAKE });
  await h.fetch([...items, { kind: 'ref', repo: R, number: 12 }]);
  const slow = structuredClone(DATA);
  slow.delay = 1500;
  slow.nodes[`${R}#34`].state = 'MERGED'; slow.nodes[`${R}#34`].merged = true;
  fs.writeFileSync(process.env.FAKE_GH_DATA, JSON.stringify(slow));
  let t = Date.now();
  const stale = await h.fetch(items, { maxAge: 0 });
  assert.ok(Date.now() - t < 500, 'answered without waiting');
  assert.equal(stale.items[`${R}#34`].st, 'open');
  t = Date.now();
  const other = await h.fetch([{ kind: 'ref', repo: R, number: 12 }]);
  assert.ok(Date.now() - t < 500, 'a fresh item does not queue behind the slow call');
  assert.equal(other.items[`${R}#12`].st, 'open');
  await h.fetch(items, { maxAge: 0 });
  await Promise.all(h.inflight.values());
  assert.equal(env.calls().length, 2, 'an item already being asked about is not asked twice');
  assert.equal((await h.fetch(items)).items[`${R}#34`].st, 'merged', 'the refresh landed');
});

test('coalesce: a poll asked for during one runs right after it, once', async () => {
  let runs = 0, release;
  const run = coalesce(async () => { runs++; if (runs === 1) await new Promise(r => { release = r; }); });
  const first = run();
  run(); run();   // during the first: remembered, not dropped
  assert.equal(runs, 1);
  release();
  await first;
  assert.equal(runs, 2, 'one more run for both asks');
  await run();
  assert.equal(runs, 3);
});

test('branch names: years and single digits are not issues; a guess shows only if GitHub confirms it', async () => {
  assert.equal(issueFromBranch('2024-cleanup'), null);
  assert.equal(issueFromBranch('1999-party'), null);
  assert.equal(issueFromBranch('1-click-login'), null);
  assert.equal(issueFromBranch('issue-3'), 3, 'a tagged one may be small');
  assert.equal(issueFromBranch('1234-fix'), 1234);

  const data = structuredClone(DATA);
  data.nodes[`${R}#38`].headRefName = '77-ghost';        // there is no issue 77
  data.nodes[`${R}#36`].headRefName = '35-speed';        // 35 is a PR, not an issue
  data.nodes[`${R}#36`].closingIssuesReferences.nodes = [];
  data.nodes[`${R}#35`].headRefName = '12-theme';        // 12 is a real issue
  fakeEnv(data);
  const gi = new GitHubInfo({ bin: FAKE });
  const out = await gi.enrich([38, 36, 35].map((n, i) => ({ kind: 'pr', repo: R, number: n, url: 'u', lastSeq: 9 - i })), { repo: R });
  assert.deepEqual(out.map(r => `${r.number}${r.of ? '<' : ''}`), ['38', '36', '35', '12<']);
  assert.ok(out.every(r => !('fromBranch' in r)));
});

test('merged: a session\'s own merged PR is news once, remembered across reloads', async () => {
  fakeEnv();
  const store = {};
  const deck = { ns: () => ({ get: (k, d) => structuredClone(store[k] ?? d), set: (k, v) => { store[k] = v; } }) };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
  const table = await loadRoutes(path.join(HERE, '..', 'lib', 'routes'), { send, readBody, deck, github: new GitHubInfo({ bin: FAKE }) });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    return hit ? hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m }) : send(res, 404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/gh/merged`, { method: 'POST', body: JSON.stringify(body) });
    return { code: r.status, ...(await r.json()) };
  };
  try {
    assert.deepEqual(await post({ sessionId: 's1', key: `${R}#34` }), { code: 200, first: true });
    assert.deepEqual(await post({ sessionId: 's1', key: `${R}#34` }), { code: 200, first: false }, 'a reload does not announce it again');
    assert.deepEqual(await post({ sessionId: 's2', key: `${R}#34` }), { code: 200, first: true }, 'per session');
    assert.deepEqual(store.merged, { s1: [`${R}#34`], s2: [`${R}#34`] });
    assert.equal((await post({ sessionId: 's1', key: 'nope' })).code, 400);
  } finally { server.close(); }
});

test('milestones: their own label', () => {
  assert.equal(chipClass({ kind: 'milestone', state: 'open' }), 'gh milestone st-open');
  assert.equal(chipLabel({ kind: 'milestone', number: 3, state: 'open', open: 4, closed: 9, title: 'v2.0' }), 'Milestone 3: open, 4 open, 9 closed. v2.0');
  assert.equal(chipLabel({ kind: 'milestone', number: 3 }), 'Milestone 3.');
});
