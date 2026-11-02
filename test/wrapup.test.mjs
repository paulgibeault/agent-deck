// Wrap-up (lib/wrapup.mjs, lib/routes/wrapup.mjs, #36): the gather step, the
// budget cap, the model's JSON, Finish writing exactly what is ticked in one
// commit, conflicts, redactions, ending the agent, worktree choices, reopen and
// follow-ups, loose sessions, and the model failing. A local bare repo stands in
// for GitHub, a fake narrator for the model, a fake agent manager for the deck's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, promptFor, parseReply, draft, mergeReply, plan, recordBody, worktreeRows, WrapState, WRAPUP_BUDGET } from '../lib/wrapup.mjs';
import { WorkstreamStore, runner } from '../lib/workstreams.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { DeckState } from '../lib/deckstate.mjs';
import { deckStore } from '../lib/routes/workstreams.mjs';
import { vaultText } from '../lib/routes/wrapup.mjs';
import { starsFor } from '../lib/stars.mjs';
import { create as createWorktree, worktreesFor } from '../lib/worktrees.mjs';
import { parseRecord, sessionRows } from '../public/homemodel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Commits made here carry a neutral identity, whatever the machine's git config says.
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wrap-')));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const noGh = async () => ({ ok: false, code: 1, stdout: '', stderr: 'no gh in tests' });

const ev = (seq, kind, extra = {}) => ({ id: `e${seq}`, seq, ts: new Date(Date.UTC(2026, 10, 1, 10, seq)).toISOString(), kind, ...extra });
const EVENTS = [
  ev(1, 'prompt', { text: 'Fix the login bug in #12' }),
  ev(2, 'text', { text: 'We decided to use the bare repo for tests. It keeps GitHub out.' }),
  ev(3, 'text', { text: 'Let us go with token refresh on 401 rather than a timer.' }),
  ev(4, 'tool', { tool: { name: 'Bash', display: 'Bash', summary: 'npm test', command: 'npm test', result: { text: 'ok 3' }, isError: false } }),
  ev(5, 'turn_end', { text: '' }),
];

// ------------------------------------------------------------ gather
test('gather: own and subagent stars, candidates not already starred, refs, files, cost, backends', () => {
  const m = gather({
    summary: { id: 'sess-1', title: 'Fix login', cwd: '/w/app', gitBranch: 'fix', harness: 'claude' },
    events: EVENTS,
    stars: { e2: { tag: 'decision', comment: 'Bare repo in tests', excerpt: 'We decided to use the bare repo for tests.', kind: 'event', at: '2026-11-01T10:02:30Z', ts: EVENTS[1].ts },
      '/w/app/lib/auth.mjs': { tag: 'star', comment: 'the fix', excerpt: '', kind: 'file', at: '2026-11-01T10:03:00Z' } },
    subStars: [{ sessionId: 'agent-a', stars: { s9: { tag: 'note', excerpt: 'The CI cache is cold on Mondays.', kind: 'event', at: '2026-11-01T10:04:00Z' } } }],
    candidates: [{ eventId: 'e2', ts: EVENTS[1].ts, cue: 'decided', sentence: 'We decided to use the bare repo for tests.' }, { eventId: 'e3', ts: EVENTS[2].ts, cue: 'go with', sentence: 'Let us go with token refresh on 401 rather than a timer.' }],
    refs: [{ kind: 'pr', repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', title: 'Fix login', state: 'merged', ci: 'success', lastSeq: 9 }],
    files: ['/w/app/lib/auth.mjs', '/w/app/lib/auth.mjs', '/tmp/notes.txt'],
    work: { repo: true, branch: 'fix', files: [{ path: 'a.js', x: ' ', y: 'M', added: 3, deleted: 1 }], totals: { files: 1, added: 3, deleted: 1 } },
    costUsd: 1.25, backends: ['opencode', 'Claude'],
  });
  assert.deepEqual(m.stars.map(s => [s.key, s.session, s.tag]), [['e2', 'sess-1', 'decision'], ['/w/app/lib/auth.mjs', 'sess-1', 'star'], ['s9', 'agent-a', 'note']]);
  assert.equal(m.stars[2].sub, true, 'a subagent’s star is marked as one');
  assert.deepEqual(m.candidates.map(c => c.eventId), ['e3'], 'a starred event is not offered again as a candidate');
  assert.equal(m.refs[0].state, 'merged'); assert.equal(m.refs[0].lastSeq, undefined);
  assert.deepEqual(m.files, ['/w/app/lib/auth.mjs', '/tmp/notes.txt']);
  assert.deepEqual([m.stats.turns, m.stats.costUsd, m.stats.durationMs, m.stats.backends], [1, 1.25, 4 * 60_000, ['opencode', 'Claude']]);
  assert.deepEqual([m.work.files, m.work.added, m.work.deleted], [1, 3, 1]);
  assert.equal(m.lastTest.command, 'npm test');
  assert.equal(m.lastTest.failed, false);
});

test('gather: a follow-up covers only what came after the last wrap-up, cost included', () => {
  const since = EVENTS[2].ts;
  const m = gather({ summary: { id: 's' }, events: EVENTS, since, costUsd: 2, costBefore: 1.5,
    stars: { e2: { tag: 'decision', excerpt: 'old', kind: 'event', at: EVENTS[1].ts }, e4: { tag: 'note', excerpt: 'new', kind: 'event', at: EVENTS[3].ts } } });
  assert.deepEqual(m.stars.map(s => s.key), ['e4']);
  assert.equal(m.stats.turns, 0);
  assert.equal(m.stats.events, 2);
  assert.equal(m.stats.costUsd, 0.5);
});

// ------------------------------------------------------------ the model call
test('promptFor: the workstream summary and active decisions go in, and the input never passes the budget', () => {
  const big = Array.from({ length: 3000 }, (_, i) => ev(i + 1, i % 50 === 0 ? 'prompt' : 'text', { text: `line ${i} `.repeat(30) }));
  const stars = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`e${i}`, { tag: 'note', excerpt: 'x'.repeat(5000), kind: 'event', at: '2026-11-01T00:00:00Z' }]));
  const m = gather({ summary: { id: 's', title: 'Big' }, events: big, stars, files: Array.from({ length: 500 }, (_, i) => `/f/${i}.js`) });
  const ws = { title: 'Login', goal: 'Logins work', summary: 'We refresh tokens.', decisions: [{ n: 1, title: 'Use a bare repo', status: 'active' }, { n: 2, title: 'Old idea', status: 'superseded' }] };
  const { prompt, system } = promptFor({ material: m, events: big, workstream: ws });
  assert.ok(prompt.length <= WRAPUP_BUDGET, `${prompt.length} > ${WRAPUP_BUDGET}`);
  assert.match(prompt, /Current summary: We refresh tokens\./);
  assert.match(prompt, /- 0001 Use a bare repo/);
  assert.doesNotMatch(prompt, /Old idea/, 'superseded decisions are not sent');
  assert.match(prompt, /## Conversation\n/, 'the conversation keeps a share of the budget');
  assert.match(prompt, /…and 440 more/);
  assert.match(system, /ONE JSON object/);
  const small = promptFor({ material: gather({ summary: { id: 's' }, events: EVENTS }), events: EVENTS, workstream: null, budget: 2000 });
  assert.ok(small.prompt.length <= 2000);
  assert.match(small.prompt, /a loose session/);
});

test('parseReply: fenced JSON, cleaned; supersedes and conflicts only name real active decisions; a bad reply is null', () => {
  const decisions = [{ n: 3, title: 'Timer refresh', status: 'active' }, { n: 1, title: 'Gone', status: 'superseded' }];
  const r = parseReply('Here you go:\n```json\n' + JSON.stringify({
    summary: 'Fixed login.', next: 'Ship it.', notes: ['Cache is cold', '', 42], questions: [{ text: 'Mobile too?' }],
    decisions: [{ title: 'Refresh on 401', body: 'Simpler.', supersedes: '3', source: 'e3' }, { title: 'Bad sup', supersedes: '0001' }, { body: 'no title' }],
    conflicts: [{ existing: '0003', decision: 0, why: 'Replaces the timer' }, { existing: '0009', decision: 0 }, { existing: '0003', decision: 5 }],
    workstreamSummary: 'Login refreshes on 401.',
  }) + '\n```', { decisions });
  assert.equal(r.summary, 'Fixed login.');
  assert.deepEqual(r.notes, ['Cache is cold']);
  assert.deepEqual(r.questions, ['Mobile too?']);
  assert.deepEqual(r.decisions.map(d => [d.title, d.supersedes, d.source]), [['Refresh on 401', '0003', 'e3'], ['Bad sup', null, null]]);
  assert.deepEqual(r.conflicts, [{ existing: '0003', decision: 0, why: 'Replaces the timer' }]);
  assert.equal(r.workstreamSummary, 'Login refreshes on 401.');
  for (const bad of ['', 'no json here', '{"unrelated": 1}', '[1,2]', '{not json}']) assert.equal(parseReply(bad), null, bad);
});

test('the no-model preview: stars ticked, candidates and touched files not, summaries blank; a reply merges in without overwriting edits', () => {
  const m = gather({ summary: { id: 's1', title: 'Fix login' }, events: EVENTS,
    stars: { e2: { tag: 'decision', comment: 'Bare repo in tests', excerpt: 'We decided to use the bare repo.', kind: 'event', at: 'x' },
      '/tmp/out.csv': { tag: 'vault', kind: 'file', excerpt: '', at: 'x' } },
    candidates: [{ eventId: 'e3', sentence: 'Go with token refresh on 401.' }], files: ['/r/a.js'] });
  const ws = { slug: 'login', summary: 'Before.', decisions: [{ n: 3, title: 'Timer refresh', status: 'active' }] };
  const p = draft({ material: m, workstream: ws, repoOf: () => '/r', date: '2026-11-01', artifacts: ['/tmp/scratch.py'] });
  assert.equal(p.model, null);
  assert.deepEqual([p.summary.text, p.next.text, p.wsSummary.text, p.wsSummary.on], ['', '', '', false]);
  assert.deepEqual(p.decisions.map(d => [d.title, d.on, d.origin]), [['Bare repo in tests', true, 'star'], ['Go with token refresh on 401.', false, 'candidate']]);
  assert.deepEqual(p.files.map(f => [f.path, f.on]), [['/r/a.js', false]]);
  assert.deepEqual(p.vault.map(v => [v.path, v.on]), [['/tmp/out.csv', true], ['/tmp/scratch.py', false]]);

  p.summary.text = 'Typed by hand.';
  const reply = parseReply({ summary: 'From the model.', next: 'Ship.', workstreamSummary: 'After.', notes: ['n1'],
    decisions: [{ title: 'Refresh on 401', source: 'e3' }, { title: 'New one' }], conflicts: [{ existing: '0003', decision: 0, why: 'timer' }] }, { decisions: ws.decisions });
  const q = mergeReply(p, reply, ws);
  assert.equal(q.summary.text, 'Typed by hand.', 'nothing typed is overwritten');
  assert.deepEqual([q.next.text, q.wsSummary.text, q.wsSummary.on], ['Ship.', 'After.', true]);
  const cand = q.decisions.find(d => d.source.event === 'e3');
  assert.deepEqual([cand.title, cand.on, cand.conflict.with, cand.conflict.title, cand.conflict.choice], ['Refresh on 401', true, '0003', 'Timer refresh', null]);
  assert.equal(q.decisions.length, 3);
  assert.deepEqual(q.notes.map(n => n.text), ['n1']);
  assert.equal(p.decisions.length, 2, 'the preview passed in is left alone');
});

// ------------------------------------------------------------ plan and conflicts
test('conflicts: keep old drops the new one, take new supersedes, keep both leaves both; unresolved stops Finish', () => {
  const base = { sessionId: 's1', slug: 'w', title: 'T', date: '2026-11-01', summary: { on: true, text: 'S' } };
  const d = (choice) => ({ ...base, decisions: [{ on: true, title: 'New way', body: '', supersedes: null, conflict: { with: '0003', choice } }] });
  assert.deepEqual(plan(d('old')).decisions, []);
  assert.equal(plan(d('new')).decisions[0].supersedes, '0003');
  assert.equal(plan(d('both')).decisions[0].supersedes, null);
  assert.throws(() => plan(d(null)), { code: 400, message: /keep old, take new, or keep both/ });
  // An unticked decision in conflict needs no answer.
  assert.deepEqual(plan({ ...base, decisions: [{ on: false, title: 'x', conflict: { with: '0003', choice: null } }] }).decisions, []);
});

test('plan: only ticked items; a loose session keeps it all in its record', () => {
  const p = { sessionId: 's1', slug: 'w', title: 'T', date: '2026-11-01', summary: { on: true, text: 'Done.' }, next: { on: true, text: 'Next.' },
    wsSummary: { on: false, text: 'ignored' },
    decisions: [{ on: true, title: 'Yes' }, { on: false, title: 'No' }], notes: [{ on: true, text: 'kept' }, { on: false, text: 'dropped' }],
    questions: [{ on: true, text: 'Why?' }], files: [{ on: true, path: '/r/lib/a.js', repo: '/r', why: 'fix' }, { on: false, path: '/r/b.js', repo: '/r' }],
    links: [{ on: true, kind: 'pr', repo: 'o/r', number: 7 }, { on: false, kind: 'issue', repo: 'o/r', number: 8 }], vault: [{ on: false, path: '/tmp/x' }],
    worktrees: [{ path: '/wt/a', choice: 'remove', choices: ['remove', 'keep'] }, { path: '/wt/b', choice: 'keep', choices: ['remove', 'keep'] }, { path: '/wt/c', choice: 'nuke', choices: ['keep'] }] };
  const pl = plan(p);
  assert.deepEqual(pl.decisions.map(d => d.title), ['Yes']);
  assert.deepEqual(pl.notes.map(n => n.text), ['kept']);
  assert.deepEqual(pl.files, [{ repo: '/r', path: 'lib/a.js', sha: null, why: 'fix', source: { session: 's1' } }]);
  assert.deepEqual(pl.links.map(l => l.number), [7]);
  assert.deepEqual(pl.vault, []);
  assert.deepEqual(pl.patch, { next: 'Next.', questions: '- Why?' });
  assert.deepEqual(pl.worktrees, [{ path: '/wt/a', action: 'remove' }], 'keep runs nothing, and a choice not offered is dropped');
  assert.match(pl.body, /## Decisions\n\n- Yes\n/);
  assert.doesNotMatch(pl.body, /dropped|No\b/);
  const loose = plan({ ...p, slug: null });
  assert.deepEqual([loose.decisions, loose.notes, loose.files, loose.links, loose.patch], [[], [], [], [], {}]);
  assert.match(loose.body, /- Yes/, 'the record carries them');
  assert.match(recordBody({ sessionId: 's', title: 'T', queued: ['do the thing'] }), /## Queued, not sent\n\n- do the thing/);
});

test('worktree rows: the safe choice preselected; nothing preselected to lose work', () => {
  const rows = worktreeRows([
    { record: { path: '/wt/m', branch: 'deck/m' }, decision: { state: 'merged', choices: ['remove', 'keep'], safe: 'remove', deleteBranch: true } },
    { record: { path: '/wt/d', branch: 'deck/d' }, decision: { state: 'dirty', choices: ['keep', 'stash', 'remove-anyway'], safe: null, dirty: 2 } },
    { record: { path: '/wt/u', branch: 'deck/u' }, decision: { state: 'unmerged', choices: ['push-remove', 'keep', 'remove-anyway'], safe: null, unmerged: 3 } },
  ]);
  assert.deepEqual(rows.map(r => r.choice), ['remove', null, null]);
  // Unchosen runs nothing.
  assert.deepEqual(plan({ sessionId: 's', title: 'T', worktrees: rows.map(r => ({ ...r, choice: r.path === '/wt/m' ? null : r.choice })) }).worktrees, []);
});

// ------------------------------------------------------------ the store's one commit
async function storeWith(root = tmp()) {
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
  const git = runner('git');
  const store = new WorkstreamStore({ dir: path.join(root, 'ws'), git, gh: noGh, pushDelay: 60_000 });
  await store.useRepo({ repo: remote });
  return { store, remote, root };
}
const commits = (dir) => Number(sh(dir, 'rev-list', '--count', 'HEAD'));

test('store.wrapUp: record, decisions (superseding), notes, lists and workstream.md in one commit; records listed for Home', async () => {
  const { store, remote } = await storeWith();
  const { workstream: w } = await store.create({ title: 'Login', summary: 'Before.' });
  await store.addDecision(w.slug, { title: 'Timer refresh' });
  await store.setList(w.slug, 'links', [{ kind: 'pr', repo: 'o/r', number: 7, state: 'open' }]);
  const before = commits(store.dir);
  const r = await store.wrapUp(w.slug, {
    record: { id: 'abcdef1234567', title: 'Fix login', date: '2026-11-01', body: '# Fix login\n\n## Summary\n\nRefresh on 401 now.\n' },
    decisions: [{ title: 'Refresh on 401', body: 'Simpler', supersedes: '0001', source: { session: 'abcdef1234567', event: 'e3' } }, { title: 'Keep the bare repo' }],
    notes: [{ text: 'CI cache cold on Mondays', source: { session: 'abcdef1234567' } }],
    files: [{ repo: '/r', path: 'lib/a.js', why: 'the fix' }], links: [{ kind: 'pr', repo: 'O/R', number: 7, state: 'merged' }],
    vault: [{ path: 'login/out.csv', sha256: 'x', title: 'out.csv', source: 'abcdef12' }], patch: { summary: 'After.', next: 'Ship.' },
  });
  assert.equal(commits(store.dir), before + 1, 'one commit');
  assert.equal(r.record, 'login/sessions/2026-11-01-fix-login-abcdef12.md');
  assert.deepEqual(r.decisions, ['0002', '0003']);
  const got = store.get(w.slug);
  assert.deepEqual(got.decisions.map(d => [d.n, d.status, d.supersedes ?? null, d.supersededBy ?? null]), [[1, 'superseded', null, '0002'], [2, 'active', '0001', null], [3, 'active', null, null]]);
  assert.match(got.notes, /- 2026-11-01: CI cache cold on Mondays \(session abcdef1234567\)\n/);
  assert.deepEqual(got.links.map(l => l.state), ['merged'], 'a link merges by identity');
  assert.deepEqual([got.files.length, got.vault.length, got.summary, got.next], [1, 1, 'After.', 'Ship.']);
  assert.deepEqual(got.records, [{ file: 'sessions/2026-11-01-fix-login-abcdef12.md', date: '2026-11-01', title: 'Fix login', session: 'abcdef1234567', summary: 'Refresh on 401 now.' }]);
  assert.match(sh(store.dir, 'log', '-1', '--format=%s'), /^wrapup\(login\): Fix login$/);
  await store.flush();
  assert.match(sh(remote, 'log', '-1', '--format=%s'), /^wrapup\(login\)/, 'pushed');
  // Home reads the record objects.
  const pr = parseRecord(got.records[0]);
  assert.deepEqual([pr.id8, pr.summary], ['abcdef12', 'Refresh on 401 now.']);
  assert.equal(sessionRows(['abcdef1234567'], got.records, (id) => ({ id, bucket: 'recent' })).recordOf.get('abcdef1234567').title, 'Fix login');
  // A follow-up is its own file, linked to the first; a loose one lands under loose/ and in no index.
  const f = await store.wrapUp(w.slug, { record: { id: 'abcdef1234567', title: 'Fix login', date: '2026-11-02', body: 'more' } });
  assert.equal(f.record, 'login/sessions/2026-11-01-fix-login-abcdef12-followup.md');
  assert.equal(store.get(w.slug).records[1].first, 'sessions/2026-11-01-fix-login-abcdef12.md');
  const l = await store.wrapUp(null, { record: { id: 'zz99', title: 'Scratch', date: '2026-11-02', body: 'x' } });
  assert.equal(l.record, 'loose/sessions/2026-11-02-scratch-zz99.md');
  assert.ok(!store.list().some(x => x.slug === 'loose'));
  assert.equal((await store.create({ title: 'Loose' })).workstream.slug, 'loose-2', 'loose/ is reserved');
});

// ------------------------------------------------------------ the routes, end to end
/** A deck with a session in a git repo, a fake agent manager, a fake model, and the route table. */
async function deckWith({ reply = null, modelFails = null, alive = true, cwd = null } = {}) {
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
  const repo = cwd || path.join(root, 'app');
  if (!cwd) {
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.js'), 'one\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'init');
  }
  const deck = new DeckState(path.join(root, 'state'));
  const store = deckStore(deck);
  await store.useRepo({ repo: remote });
  const { workstream: ws } = await store.create({ title: 'Login', summary: 'Tokens refresh on a timer.' });
  await store.addDecision(ws.slug, { title: 'Timer refresh' });
  deck.ns('workstreams').set('sess-1', ws.slug);

  const sessions = new Map();
  const summary = (id) => {
    const s = sessions.get(id); if (!s) return null;
    return { kind: 'session', id, title: s.title, cwd: s.cwd, alive: s.alive, status: s.alive ? 'idle' : null, harness: 'claude', gitBranch: 'main', subagents: s.subagents || [],
      workstream: deck.ns('workstreams').get(id) ? { slug: deck.ns('workstreams').get(id), title: 'Login' } : null, wrapped: index.wrappedOf(id) || undefined };
  };
  const index = { summary, files: new Map([['sess-1', {}]]), registry: new Map(), agents: new Map(), refreshRegistry() {},
    load: (id) => sessions.has(id) ? { state: { events: sessions.get(id).events, filesList: () => (sessions.get(id).files || []).map(p => ({ path: p, lastTs: '2026-11-01T10:05:00Z' })) } } : null,
    brief: () => ({ cost: { totalCostUSD: 0.42 } }), wrappedOf: () => null };
  sessions.set('sess-1', { title: 'Fix login', cwd: repo, alive, events: EVENTS, subagents: [{ id: 'agent-a' }], files: [path.join(repo, 'a.js')] });

  // The deck's agent manager, as far as wrap-up uses it.
  const agents = new EventEmitter();
  const A = { proc: alive, status: 'idle', queue: [{ id: 'q1', text: 'also update the docs' }], permissions: [{ requestId: 'p1', tool: 'Bash' }], startedAt: Date.now() - 60_000 };
  Object.assign(agents, {
    log: [],
    publicState: (id) => id === 'sess-1' ? { id, alive: A.proc, status: A.status, queue: A.queue, permissions: A.permissions, totalCostUsd: 0.42, startedAt: A.startedAt } : null,
    running: (id) => id === 'sess-1' && !!A.proc,
    has: (id) => id === 'sess-1',
    answer(id, requestId, decision) { agents.log.push(['answer', requestId, decision]); A.permissions = A.permissions.filter(p => p.requestId !== requestId); },
    queueOp(id, { op, itemId }) { agents.log.push(['queue', op, itemId]); A.queue = A.queue.filter(q => q.id !== itemId); },
    stop(id) { agents.log.push(['stop', id]); const was = !!A.proc; A.proc = false; A.status = 'exited'; return was; },
    send: async (id, text) => { agents.log.push(['send', text]); A.status = 'busy'; return { id: 'x' }; },
    wakeable: (id) => sessions.has(id) ? { cwd: sessions.get(id).cwd } : { error: 'unknown session' },
    interrupt: () => true, lineageOf: () => null, harnessList: () => [{ name: 'claude', label: 'Claude' }], recordedHarness: () => 'claude',
  });
  const calls = [];
  const narrator = { useState() { return this; }, view: () => ({}), run: async (a) => { calls.push(a); if (modelFails) throw new Error(modelFails); return { text: typeof reply === 'function' ? reply(a) : reply ?? '{}', costUsd: 0.01, durationMs: 5, transport: 'claude', model: 'sonnet' }; } };
  const broadcasts = [];
  const send = (res, code, body) => { res.code = code; res.body = body; };
  const table = await loadRoutes(path.join(__dirname, '..', 'lib', 'routes'), { root: path.join(__dirname, '..'), send, readBody: async (req) => req.body || {}, deck, index, agents, narrator,
    broadcast: (e, d) => broadcasts.push([e, d]), scheduleSnapshot: () => {}, narratorEnabled: true });
  const api = async (method, url, body) => {
    const u = new URL(url, 'http://x');
    const hit = matchRoute(table, method, u.pathname);
    assert.ok(hit, `no route for ${method} ${u.pathname}`);
    const res = {};
    await hit.route.handler({ method, body }, res, { url: u, q: u.searchParams, m: hit.m });
    return res;
  };
  return { root, remote, repo, deck, store, ws, sessions, index, agents, A, calls, api, broadcasts };
}

test('Finish: exactly the ticked items in one commit, pushed; the agent ended, its queue cleared and permissions denied', async () => {
  const reply = JSON.stringify({ summary: 'Login refreshes tokens on 401.', next: 'Ship it.', workstreamSummary: 'Tokens refresh on 401.', notes: ['Mondays are slow'], questions: ['Mobile?'],
    decisions: [{ title: 'Refresh on 401', body: 'No timer.', source: 'e3' }], conflicts: [{ existing: '0001', decision: 0, why: 'replaces the timer' }] });
  const d = await deckWith({ reply });
  starsFor(d.deck).put('sess-1', 'e2', { tag: 'decision', comment: 'Bare repo in tests', excerpt: 'We decided to use the bare repo.', kind: 'event', ts: EVENTS[1].ts });
  starsFor(d.deck).put('agent-a', 's9', { tag: 'note', excerpt: 'Subagent found the cache is cold.', kind: 'event' });

  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g.code, 200, JSON.stringify(g.body));
  const pre = g.body.precheck;
  assert.deepEqual([pre.busy, pre.queue.length, pre.permissions, pre.workstream.slug, pre.store.ready], [false, 1, 1, 'login', true]);
  assert.equal(d.calls.length, 0, 'opening the dialog makes no model call');
  assert.deepEqual(g.body.preview.notes.map(n => n.text), ['Subagent found the cache is cold.'], 'a subagent’s star is collected');

  const dr = await d.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g.body.preview });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].purpose, 'wrapup');
  assert.match(d.calls[0].prompt, /Current summary: Tokens refresh on a timer\./);
  assert.match(d.calls[0].prompt, /\[decision\] \(event e2\) "Bare repo in tests"/);
  const again = await d.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g.body.preview });
  assert.equal(d.calls.length, 1, 'one model call per wrap-up');
  assert.equal(again.body.preview.summary.text, 'Login refreshes tokens on 401.');

  const p = dr.body.preview;
  const conflict = p.decisions.find(x => x.conflict);
  assert.equal(conflict.conflict.with, '0001');
  // Unresolved: render says so and Finish refuses, writing nothing.
  const before = commits(d.store.dir);
  assert.match((await d.api('POST', '/api/sessions/sess-1/wrapup/render', { preview: p })).body.error, /keep old, take new, or keep both/);
  assert.equal((await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p })).code, 400);
  assert.equal(commits(d.store.dir), before);
  assert.deepEqual(d.agents.log, [], 'nothing stopped before Finish');

  conflict.conflict.choice = 'new';
  p.notes.find(n => n.text === 'Mondays are slow').on = false;   // unticked: not written
  p.wsSummary.text = 'Tokens refresh on 401 (edited).';
  p.files[0].on = true; p.files[0].why = 'the fix';
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p, queue: 'keep' });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.equal(commits(d.store.dir), before + 1, 'one commit');
  assert.equal(f.body.pushed, true);
  assert.equal(sh(d.remote, 'rev-parse', 'HEAD'), sh(d.store.dir, 'rev-parse', 'HEAD'));
  const w = d.store.get('login');
  assert.deepEqual(w.decisions.map(x => [x.n, x.title, x.status]), [[1, 'Timer refresh', 'superseded'], [2, 'Bare repo in tests', 'active'], [3, 'Refresh on 401', 'active']]);
  assert.equal(w.decisions[2].supersedes, '0001');
  assert.match(w.notes, /Subagent found the cache is cold\. \(session agent-a, event s9\)/);
  assert.doesNotMatch(w.notes, /Mondays/);
  assert.deepEqual([w.summary, w.next, w.questions], ['Tokens refresh on 401 (edited).', 'Ship it.', '- Mobile?']);
  assert.deepEqual(w.files.map(x => [x.path, x.why]), [['a.js', 'the fix']]);
  const rec = fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8');
  assert.match(rec, /^---\nsession: sess-1\ntitle: Fix login\n/);
  assert.match(rec, /## Summary\n\nLogin refreshes tokens on 401\./);
  assert.match(rec, /## Queued, not sent\n\n- also update the docs/);
  assert.match(rec, /\$0\.42/);
  // The agent: permission denied, queue cleared, process stopped; then wrapped.
  assert.deepEqual(d.agents.log, [['answer', 'p1', 'deny'], ['queue', 'remove', 'q1'], ['stop', 'sess-1']]);
  assert.deepEqual([f.body.stopped, f.body.denied, f.body.cleared], [true, 1, 1]);
  assert.equal(d.index.wrappedOf('sess-1').slug, 'login');
  assert.equal(d.deck.ns('wrapup').get('sess-1').record, f.body.record);
  assert.ok(d.broadcasts.some(([e, x]) => e === 'wrapup.changed' && x.wrapped));

  // Reopen: resuming it marks it reopened; the next wrap-up is a follow-up linked to the first.
  d.agents.emit('change', { id: 'sess-1', alive: true, startedAt: Date.now() + 1000 });
  assert.ok(d.index.wrappedOf('sess-1').reopened);
  const later = ev(9, 'text', { text: 'One more fix after the merge.', ts: new Date(Date.now() + 5000).toISOString() });
  d.sessions.get('sess-1').events = [...EVENTS, later];
  d.A.proc = true; d.A.status = 'idle';
  const g2 = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g2.body.preview.followup.first, f.body.record.replace(/^login\//, ''), 'the first record, in the same area');
  assert.equal(g2.body.preview.facts.stats.events, 1, 'only what happened since');
  assert.deepEqual(g2.body.preview.decisions, [], 'stars from before are not offered again');
  const p2 = g2.body.preview; p2.summary.text = 'A small fix after the merge.';
  const f2 = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p2 });
  assert.equal(f2.code, 200, JSON.stringify(f2.body));
  assert.equal(f2.body.record, f.body.record.replace(/\.md$/, '-followup.md'));
  const rec2 = fs.readFileSync(path.join(d.store.dir, f2.body.record), 'utf8');
  assert.match(rec2, /followup: true\nfirst: sessions\/.*-sess1\.md/);
  assert.match(rec2, /Follow-up to \[the first wrap-up\]\(.*-sess1\.md\)/);
  assert.equal(d.deck.ns('wrapup').get('sess-1').count, 2);
});

test('redactions: secrets and lines quoted from the Vault are shown in the preview and never written', async () => {
  const d = await deckWith({ alive: false });
  const vault = path.join(d.deck.dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'private.txt'), 'the launch codes are 0000-1111-2222\n');
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const p = g.body.preview;
  p.summary.text = 'Used ghp_abcdefghijklmnopqrstuvwxyz0123456789AB and the launch codes are 0000-1111-2222 to test.';
  const r = await d.api('POST', '/api/sessions/sess-1/wrapup/render', { preview: p });
  assert.deepEqual(r.body.redactions.map(x => x.kind).sort(), ['github-token', 'vault']);
  assert.ok(r.body.redactions.every(x => !x.masked.includes('abcdefghij') && !x.masked.includes('0000-1111')), 'masked, not shown');
  assert.match(r.body.body, /\[redacted:github-token\]/);
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.ok(f.body.redactions.length >= 2);
  const rec = fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8');
  assert.doesNotMatch(rec, /ghp_abc|0000-1111/);
  // The Vault reader skips sidecars and big or binary files.
  fs.writeFileSync(path.join(vault, 'x.meta.json'), '{"title":"a long title line here"}');
  fs.writeFileSync(path.join(vault, 'bin'), Buffer.from([1, 0, 2]));
  assert.deepEqual(vaultText(() => vault)(), ['the launch codes are 0000-1111-2222\n']);
});

test('a loose session is recorded under loose/, touching no workstream', async () => {
  const d = await deckWith({ alive: false });
  d.deck.ns('workstreams').set('sess-1', undefined);
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g.body.preview.slug, null);
  assert.equal(g.body.precheck.workstream, null);
  const p = g.body.preview;
  p.summary.text = 'A scratch session.';
  p.decisions = [{ on: true, title: 'Recorded in the body only' }];
  const ws = fs.readFileSync(path.join(d.store.dir, 'login', 'workstream.md'), 'utf8');
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.match(f.body.record, /^loose\/sessions\/\d{4}-\d{2}-\d{2}-fix-login-sess1\.md$/);
  assert.match(fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8'), /- Recorded in the body only/);
  assert.equal(fs.readFileSync(path.join(d.store.dir, 'login', 'workstream.md'), 'utf8'), ws);
  assert.equal(d.store.get('login').decisions.length, 1);
  assert.equal(f.body.stopped, false, 'nothing to stop: it was not running');
  // Picking loose for a session in a workstream works the same way.
  const d2 = await deckWith({ alive: false });
  assert.equal((await d2.api('GET', '/api/sessions/sess-1/wrapup?slug=loose')).body.preview.slug, null);
});

test('the model failing, or answering badly, leaves the no-model preview with blank fields; Finish still works', async () => {
  const d = await deckWith({ modelFails: 'claude -p timed out', alive: false });
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const r = await d.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g.body.preview });
  assert.equal(r.code, 200);
  assert.match(r.body.error, /timed out/);
  assert.equal(r.body.preview.summary.text, '');
  assert.equal(r.body.preview.model, null);
  assert.deepEqual(r.body.preview, g.body.preview, 'the preview as it was');
  // A failed call may be asked again; a bad answer counts as failed.
  const bad = await deckWith({ reply: 'Sorry, I cannot help with that.', alive: false });
  const g2 = await bad.api('GET', '/api/sessions/sess-1/wrapup');
  const r2 = await bad.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g2.body.preview });
  assert.match(r2.body.error, /not the JSON asked for/);
  await bad.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g2.body.preview });
  assert.equal(bad.calls.length, 2);
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: r.body.preview });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.match(fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8'), /## Summary\n\n_No summary\._/);
});

test('pre-checks: mid-turn blocks Finish; stash only when chosen; asking the agent to commit is one prompt', async () => {
  const d = await deckWith();
  fs.writeFileSync(path.join(d.repo, 'a.js'), 'two\n');
  d.A.status = 'busy';
  // A turn held only by a permission prompt waits on the pilot: Finish may deny it.
  assert.equal((await d.api('GET', '/api/sessions/sess-1/wrapup?precheck=1')).body.precheck.busy, false);
  d.A.permissions = [];
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup?precheck=1');
  assert.equal(g.body.preview, undefined);
  assert.deepEqual([g.body.precheck.busy, g.body.precheck.work.files], [true, 1]);
  const p = (await d.api('GET', '/api/sessions/sess-1/wrapup')).body.preview;
  assert.equal((await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p })).code, 409);
  d.A.status = 'idle';
  const c = await d.api('POST', '/api/sessions/sess-1/wrapup/commit', {});
  assert.equal(c.code, 200);
  assert.deepEqual(d.agents.log.filter(x => x[0] === 'send').length, 1);
  d.A.status = 'idle';
  // Left: the change stays in the folder.
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p, work: 'leave' });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.equal(f.body.stash, null);
  assert.equal(fs.readFileSync(path.join(d.repo, 'a.js'), 'utf8'), 'two\n');
  const d2 = await deckWith({ alive: false });
  fs.writeFileSync(path.join(d2.repo, 'a.js'), 'three\n');
  const p2 = (await d2.api('GET', '/api/sessions/sess-1/wrapup')).body.preview;
  const f2 = await d2.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p2, work: 'stash' });
  assert.ok(f2.body.stash);
  assert.equal(fs.readFileSync(path.join(d2.repo, 'a.js'), 'utf8'), 'one\n');
  assert.match(sh(d2.repo, 'stash', 'list'), /agent-deck wrap-up sess-1/);
});

test('worktrees: the safe choice runs only as shown; unmerged work is kept unless chosen; nothing else is touched', async () => {
  const d = await deckWith({ alive: false });
  const svc = worktreesFor({ deck: d.deck });
  const mk = async (title) => svc.put({ ...(await createWorktree({ wt: { top: d.repo, main: d.repo }, cand: { kind: 'default', ref: 'main', branch: 'main' }, title, stateDir: d.deck.dir })), sessionId: 'sess-1' });
  const empty = await mk('empty one');
  const work = await mk('with work');
  fs.writeFileSync(path.join(work.path, 'b.js'), 'b\n'); sh(work.path, 'add', '.'); sh(work.path, 'commit', '-q', '-m', 'b');
  const other = await mk('someone else');
  svc.put({ ...svc.record(other.path), sessionId: 'sess-2' });

  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const rows = g.body.preview.worktrees;
  assert.deepEqual(rows.map(r => [path.basename(r.path) === path.basename(empty.path) ? 'empty' : 'work', r.state, r.choice]).sort(), [['empty', 'empty', 'remove'], ['work', 'unmerged', null]]);
  // As shown: the empty one goes, the one with work stays.
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.deepEqual(f.body.worktrees.map(w => [w.path, w.action, w.removed]), [[empty.path, 'remove', true]]);
  assert.ok(!fs.existsSync(empty.path));
  assert.ok(fs.existsSync(work.path) && fs.existsSync(other.path));
  assert.ok(svc.record(work.path) && svc.record(other.path));
  // Another session's worktree cannot be named.
  const g2 = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const p2 = g2.body.preview;
  p2.worktrees.push({ path: other.path, choice: 'remove', choices: ['remove', 'keep'] });
  assert.equal((await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: p2 })).code, 400);
  assert.ok(fs.existsSync(other.path));
  // Wrapped sessions count as finished for the Worktrees dialog.
  assert.equal((await svc.planCleanup({ sessionId: 'sess-1' }))[0].orphan, true);
});

test('worktrees: nothing is removed unchosen, even the safe one; unmerged work goes only when the pilot picks it', async () => {
  const d = await deckWith({ alive: false });
  const svc = worktreesFor({ deck: d.deck });
  const mk = async (title) => svc.put({ ...(await createWorktree({ wt: { top: d.repo, main: d.repo }, cand: { kind: 'default', ref: 'main', branch: 'main' }, title, stateDir: d.deck.dir })), sessionId: 'sess-1' });
  const empty = await mk('empty one');
  const dirty = await mk('dirty one');
  fs.writeFileSync(path.join(dirty.path, 'wip.js'), 'wip\n');
  const work = await mk('with work');
  fs.writeFileSync(path.join(work.path, 'b.js'), 'b\n'); sh(work.path, 'add', '.'); sh(work.path, 'commit', '-q', '-m', 'b');

  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const rows = g.body.preview.worktrees;
  const row = (wt) => rows.find(r => r.path === wt.path);
  assert.deepEqual([row(empty).choice, row(dirty).choice, row(work).choice], ['remove', null, null], 'only the safe one preselected');
  assert.ok(row(dirty).choices.length && row(work).choices.includes('remove-anyway'));
  // The pilot unticks the safe one and leaves the rest: nothing runs.
  row(empty).choice = null;
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.deepEqual(f.body.worktrees, []);
  for (const wt of [empty, dirty, work]) assert.ok(fs.existsSync(wt.path) && svc.record(wt.path), wt.path);
  assert.equal(fs.readFileSync(path.join(dirty.path, 'wip.js'), 'utf8'), 'wip\n');

  // A follow-up where the pilot chooses: the unmerged one goes as chosen, the safe one as shown; act() re-checks git first.
  d.agents.emit('change', { id: 'sess-1', alive: true, startedAt: Date.now() + 1000 });
  const g2 = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const w2 = g2.body.preview.worktrees.find(r => r.path === work.path);
  w2.choice = 'remove-anyway';
  // A choice the preview claims but git does not allow is refused server-side, not run.
  const dr = g2.body.preview.worktrees.find(r => r.path === dirty.path);
  Object.assign(dr, { choices: [...dr.choices, 'remove'], choice: 'remove' });
  const f2 = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g2.body.preview });
  assert.equal(f2.code, 200, JSON.stringify(f2.body));
  // The safe one is preselected again and shown, so this time it runs.
  const byPath = (p) => f2.body.worktrees.find(w => w.path === p);
  assert.deepEqual([empty, dirty, work].map(x => [byPath(x.path)?.action, !!byPath(x.path)?.error]), [['remove', false], ['remove', true], ['remove-anyway', false]]);
  assert.match(byPath(dirty.path).error, /not a choice/);
  assert.ok(!fs.existsSync(work.path) && !fs.existsSync(empty.path));
  assert.ok(fs.existsSync(dirty.path), 'the dirty one was not chosen');
});

test('reopen: resuming a session whose worktree Finish removed puts the worktree back at the same path first', async () => {
  const d = await deckWith({ alive: false });
  const svc = worktreesFor({ deck: d.deck });
  const wt = svc.put({ ...(await createWorktree({ wt: { top: d.repo, main: d.repo }, cand: { kind: 'default', ref: 'main', branch: 'main' }, title: 'its own', stateDir: d.deck.dir })), sessionId: 'sess-1' });
  d.sessions.get('sess-1').cwd = wt.path;
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g.body.preview.worktrees[0].choice, 'remove', 'empty: the safe choice, shown');
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  assert.equal(f.body.worktrees[0].removed, true);
  assert.ok(!fs.existsSync(wt.path) && !svc.record(wt.path));
  // The deck resumes it: the worktree comes back (its branch was deleted with it: a new one at the same commit).
  // wakeable stays synchronous: a move's plan (server.mjs planMove) reads .error off it, and asking restores nothing.
  const asked = d.agents.wakeable('sess-1');
  assert.equal(typeof asked.then, 'undefined');
  assert.equal(asked.cwd, wt.path);
  assert.ok(!fs.existsSync(wt.path), 'asking puts nothing back');
  assert.equal(typeof d.agents.wakeable('nope').then, 'undefined');
  assert.ok(d.agents.wakeable('nope').error, 'an unresumable session says so at once: a move falls back to a handoff');
  await d.agents.beforeWake('sess-1');
  assert.ok(fs.existsSync(path.join(wt.path, 'a.js')));
  assert.equal(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
  assert.equal(svc.record(wt.path).sessionId, 'sess-1');
  assert.deepEqual(d.deck.ns('wrapup').get('sess-1').removed, undefined, 'restored once');
  // A folder that is there already is left alone.
  await d.agents.beforeWake('sess-1');
  assert.equal(d.agents.wakeable('sess-1').cwd, wt.path);
});

// ------------------------------------------------------------ review fixes
test('Finish runs only from its own click: no submit button, and Enter in a field never submits the dialog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'wrapup.js'), 'utf8');
  assert.doesNotMatch(src, /type: 'submit'/, 'no submit button: Enter has nothing to press');
  assert.match(src, /h\('button', \{ type: 'button', class: 'btn primary wu-finish'[^\n]*onclick: \(\) => finish\(\)/);
  assert.match(src, /onsubmit: \(e\) => e\.preventDefault\(\),/, 'a submit (implicit or not) does nothing');
  assert.match(src, /onkeydown: \(e\) => \{ if \(e\.key === 'Enter' && e\.target\.tagName === 'INPUT'\) e\.preventDefault\(\); \}/);
  assert.equal(src.match(/(?<!function )\bfinish\(\)/g).length, 1, 'finish() is called from one place: the button');
});

test('a model draft belongs to one session and workstream, expires, and its decision ids are re-checked against the target', async () => {
  const reply = JSON.stringify({ summary: 'Drafted for Login.', decisions: [{ title: 'Refresh on 401', supersedes: '0001' }, { title: 'Second' }],
    conflicts: [{ existing: '0001', decision: 1, why: 'x' }] });
  const d = await deckWith({ reply, alive: false });
  const { workstream: other } = await d.store.create({ title: 'Other' });
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  const dr = await d.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: g.body.preview });
  assert.equal(dr.body.preview.decisions.find(x => x.title === 'Refresh on 401').supersedes, '0001');
  // Picking another workstream: the Login draft is not carried over.
  const o = await d.api('GET', `/api/sessions/sess-1/wrapup?slug=${other.slug}`);
  assert.deepEqual([o.body.preview.slug, o.body.preview.summary.text, o.body.preview.model, o.body.model], [other.slug, '', null, null]);
  // Its own draft is a new call; ids that name no decision there are dropped.
  const od = await d.api('POST', '/api/sessions/sess-1/wrapup/draft', { preview: o.body.preview });
  assert.equal(d.calls.length, 2);
  assert.deepEqual(od.body.preview.decisions.filter(x => x.origin === 'model').map(x => [x.title, x.supersedes, x.conflict]), [['Refresh on 401', null, null], ['Second', null, null]]);
  // mergeReply checks too, whatever the reply says.
  const p = draft({ material: gather({ summary: { id: 's' } }), workstream: { slug: 'w', decisions: [{ n: 2, title: 'Two', status: 'active' }, { n: 1, title: 'Gone', status: 'superseded' }] } });
  const q = mergeReply(p, { decisions: [{ title: 'A', supersedes: '0001' }, { title: 'B', supersedes: '0002' }], conflicts: [{ existing: '0001', decision: 0 }, { existing: '0002', decision: 1 }] },
    { decisions: [{ n: 2, title: 'Two', status: 'active' }, { n: 1, title: 'Gone', status: 'superseded' }] });
  assert.deepEqual(q.decisions.map(x => [x.title, x.supersedes, x.conflict?.with ?? null]), [['A', null, null], ['B', '0002', '0002']]);
  // After an hour the draft is gone: the preview opens without it.
  const now = Date.now;
  try {
    Date.now = () => now() + 61 * 60_000;
    const later = await d.api('GET', '/api/sessions/sess-1/wrapup');
    assert.deepEqual([later.body.preview.summary.text, later.body.model], ['', null]);
  } finally { Date.now = now; }
});

test('WrapState.mark keeps the worktrees an earlier wrap-up removed', () => {
  const m = new Map();
  const w = new WrapState({ get: (k, d) => m.has(k) ? structuredClone(m.get(k)) : d, set: (k, v) => m.set(k, structuredClone(v)) });
  w.mark('s', { slug: 'a', record: 'a/sessions/x.md' });
  w.removed('s', [{ record: { path: '/wt/x' }, head: 'abc' }]);
  w.reopen('s');
  const again = w.mark('s', { slug: 'a', record: 'a/sessions/x-followup.md' });
  assert.deepEqual([again.count, again.first, again.removed.map(x => x.record.path)], [2, 'a/sessions/x.md', ['/wt/x']]);
});

test('a session running outside the deck is not wrapped up behind its back', async () => {
  const d = await deckWith();
  d.A.proc = false;   // alive (its summary says so) but not the deck's process: a terminal
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g.body.precheck.external, true);
  const before = commits(d.store.dir);
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview });
  assert.equal(f.code, 409);
  assert.match(f.body.error, /running outside the deck.*end it there first/);
  assert.equal(commits(d.store.dir), before, 'nothing written');
  assert.equal(d.deck.ns('wrapup').get('sess-1') ?? null, null, 'not marked wrapped');
  assert.deepEqual(d.agents.log, []);
});

test('follow-ups are decided per area: into another area it is a first record linking back by a path that resolves', async () => {
  const d = await deckWith({ alive: false });
  const go = async (slug) => {
    const g = await d.api('GET', `/api/sessions/sess-1/wrapup${slug ? `?slug=${slug}` : ''}`);
    g.body.preview.summary.text = `into ${slug || 'login'}`;
    const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview });
    assert.equal(f.code, 200, JSON.stringify(f.body));
    d.agents.emit('change', { id: 'sess-1', alive: true, startedAt: Date.now() + 1000 });
    return { g, f, text: fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8') };
  };
  const one = await go(null);
  assert.match(one.f.body.record, /^login\/sessions\/.*-sess1\.md$/);
  const two = await go('loose');
  assert.match(two.f.body.record, /^loose\/sessions\/.*-sess1\.md$/, 'loose/ has no first record of it: not a follow-up file');
  assert.doesNotMatch(two.text, /^followup: true/m);
  const href = /Follow-up to \[the first wrap-up\]\(([^)]+)\)/.exec(two.text)?.[1];
  assert.equal(href, `../../${one.f.body.record}`);
  assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(d.store.dir, two.f.body.record)), href)), 'the link resolves');
  const three = await go(null);
  assert.match(three.f.body.record, /^login\/sessions\/.*-sess1-followup\.md$/, 'back in login: a follow-up of the first');
  assert.match(three.text, new RegExp(`first: sessions/${path.basename(one.f.body.record)}`));
  assert.match(three.text, new RegExp(`\\]\\(${path.basename(one.f.body.record).replace(/\./g, '\\.')}\\)`));
  // The render shows the same link Finish writes.
  const g4 = await d.api('GET', '/api/sessions/sess-1/wrapup?slug=loose');
  const r4 = await d.api('POST', '/api/sessions/sess-1/wrapup/render', { preview: g4.body.preview });
  assert.match(r4.body.body, new RegExp(`\\]\\(${path.basename(two.f.body.record).replace(/\./g, '\\.')}\\)`));
});

test('Finish records the facts as they stand then, not the preview’s: uncommitted work, and the stash comes after the commit', async () => {
  const d = await deckWith({ alive: false });
  const g = await d.api('GET', '/api/sessions/sess-1/wrapup');
  assert.equal(g.body.preview.facts.work, null, 'clean when the dialog opened');
  fs.writeFileSync(path.join(d.repo, 'late.js'), 'x\n');
  const f = await d.api('POST', '/api/sessions/sess-1/wrapup/finish', { preview: g.body.preview, work: 'stash' });
  assert.equal(f.code, 200, JSON.stringify(f.body));
  const rec = fs.readFileSync(path.join(d.store.dir, f.body.record), 'utf8');
  assert.match(rec, /## Not committed at wrap-up\n\n1 file, \+1 −0 on main; stashed at Finish/);
  assert.ok(f.body.stash);
  assert.ok(!fs.existsSync(path.join(d.repo, 'late.js')));
});
