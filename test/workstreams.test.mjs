// Workstreams (lib/workstreams.mjs, lib/routes/workstreams.mjs): the repo store
// round trip, decision numbering, the secret scrubber, offline commits pushed
// later, conflicts surfaced, and the API. A local bare repo stands in for GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { WorkstreamStore, frontmatter, parseFrontmatter, slugify, runner, githubRepo, storeFor } from '../lib/workstreams.mjs';
import { scrub } from '../lib/scrub.mjs';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';
import { DeckState } from '../lib/deckstate.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ws-')));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Commits made by tests carry a neutral identity, whatever the machine's git config says.
const git = runner('git', { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const noGh = async () => ({ ok: false, code: 1, stdout: '', stderr: 'gh is not available in tests' });

/** A bare "remote" and a store cloned from it. */
async function setup(root = tmp(), name = 'a') {
  const remote = path.join(root, 'remote.git');
  if (!fs.existsSync(remote)) sh(root, 'init', '-q', '--bare', remote);
  const store = new WorkstreamStore({ dir: path.join(root, name), git, gh: noGh, pushDelay: 60_000, retryDelay: 60_000 });
  await store.useRepo({ repo: remote });
  return { root, remote, store };
}
const remoteLog = (remote) => { try { return sh(remote, 'log', '--format=%s', 'HEAD'); } catch { return ''; } };

test('create and read back: frontmatter, sections, index, one commit', async () => {
  const { store, remote } = await setup();
  const { workstream: w, message, commit } = await store.create({ title: 'Fix #12: login, again', goal: 'Logins work on "slow" networks\nand offline', pinned: ['#12', 'lib/auth.mjs'],
    summary: 'Started.', next: 'Write a test.' });
  assert.equal(w.slug, 'fix-12-login-again');
  assert.equal(message, 'create(fix-12-login-again): Fix #12: login, again');
  assert.match(commit, /^[0-9a-f]{7,}$/);

  const back = store.get(w.slug);
  assert.equal(back.title, 'Fix #12: login, again');
  assert.equal(back.goal, 'Logins work on "slow" networks\nand offline');
  assert.equal(back.status, 'active');
  assert.deepEqual(back.pinned, ['#12', 'lib/auth.mjs']);
  assert.equal(back.summary, 'Started.');
  assert.equal(back.next, 'Write a test.');
  assert.equal(back.where, '');
  assert.deepEqual([back.files, back.links, back.vault, back.decisions], [[], [], [], []]);

  // Reads fine on GitHub: frontmatter, then headed sections.
  const md = fs.readFileSync(path.join(store.dir, w.slug, 'workstream.md'), 'utf8');
  assert.match(md, /^---\ntitle: "Fix #12: login, again"\n/);
  assert.match(md, /\n## Summary\n\nStarted\.\n/);

  await store.update(w.slug, { status: 'paused', where: 'Half way.', ignored: 1 });
  assert.equal(store.get(w.slug).status, 'paused');
  assert.equal(store.get(w.slug).where, 'Half way.');
  await assert.rejects(store.update(w.slug, { status: 'sideways' }), /status is one of/);
  await assert.rejects(store.update('nope', { goal: 'x' }), { code: 404 });

  // A second one with the same title gets its own slug; reserved slugs are avoided.
  assert.equal((await store.create({ title: 'Fix #12: login, again' })).workstream.slug, 'fix-12-login-again-2');
  assert.equal((await store.create({ title: 'Setup' })).workstream.slug, 'setup-2');

  const idx = JSON.parse(fs.readFileSync(path.join(store.dir, 'index.json'), 'utf8')).workstreams;
  assert.deepEqual(idx.map(x => x.slug).sort(), ['fix-12-login-again', 'fix-12-login-again-2', 'setup-2']);
  assert.deepEqual(Object.keys(idx[0]), ['slug', 'title', 'status', 'updated']);
  assert.deepEqual(store.list(), idx);

  // One commit per change, and the push (debounced) lands them all.
  assert.deepEqual(sh(store.dir, 'log', '--format=%s').split('\n'),
    ['create(setup-2): Setup', 'create(fix-12-login-again-2): Fix #12: login, again', 'edit(fix-12-login-again): status, where', 'create(fix-12-login-again): Fix #12: login, again']);
  assert.equal(sh(store.dir, 'status', '--porcelain'), '');
  assert.equal((await store.status()).ahead, 4);
  await store.flush();
  assert.equal(remoteLog(remote).split('\n').length, 4);
  assert.equal((await store.status()).ahead, 0);
  store.stop();
});

test('decisions are numbered in order, across clones, and supersede', async () => {
  const { root, store: a } = await setup();
  const { workstream: { slug } } = await a.create({ title: 'Store' });
  const d1 = await a.addDecision(slug, { title: 'Use git', body: 'Plain files.', source: { session: 's1', event: 'e9' } });
  const d2 = await a.addDecision(slug, { title: 'One repo' });
  assert.deepEqual([d1.n, d2.n], [1, 2]);
  await a.flush();

  // Another clone writes next: it pulls first, so it numbers after a's.
  const { store: b } = await setup(root, 'b');
  const d3 = await b.addDecision(slug, { title: 'Use git, but squash', supersedes: 1 });
  assert.equal(d3.n, 3);
  assert.equal(d3.message, `decision(${slug}): 0003 Use git, but squash`);

  const ds = b.get(slug).decisions;
  assert.deepEqual(ds.map(d => d.file), [`decisions/0001-use-git.md`, `decisions/0002-one-repo.md`, `decisions/0003-use-git-but-squash.md`]);
  assert.deepEqual(ds.map(d => d.status), ['superseded', 'active', 'active']);
  assert.equal(ds[0].supersededBy, '0003');
  assert.equal(ds[2].supersedes, '0001');
  assert.deepEqual(ds[0].source, { session: 's1', event: 'e9' });
  assert.equal(ds[0].body, 'Plain files.');
  assert.match(ds[0].date, /^\d{4}-\d{2}-\d{2}$/);
  await assert.rejects(b.addDecision(slug, { title: 'x', supersedes: 42 }), /no decision 0042/);
  await assert.rejects(b.addDecision(slug, { title: 'x', status: 'maybe' }), /status is one of/);

  await b.addNote(slug, { text: 'Rebase beats merge here', source: { session: 's2' } });
  assert.match(b.get(slug).notes, /^- \d{4}-\d{2}-\d{2}: Rebase beats merge here \(session s2\)$/m);
  a.stop(); b.stop();
});

// Realistic shapes, fake values.
const FAKE = {
  ghp: 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5',
  pat: 'github_pat_11ABCDEFG0123456789_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV',
  ant: 'sk-ant-api03-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa-ZyXwVuTsRqPoNmLkJiHgFe_AAAA',
  oai: 'sk-proj-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0',
  akid: 'AKIA' + 'IOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  slack: 'xoxb-' + '1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  google: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
};

test('scrubber: token shapes, .env values and Vault lines go; ordinary text stays', () => {
  const text = [
    `export GITHUB_TOKEN=${FAKE.ghp}`,
    `gh auth with ${FAKE.pat} worked`,
    `ANTHROPIC_API_KEY="${FAKE.ant}"`,
    `client = OpenAI(api_key="${FAKE.oai}")`,
    `aws_access_key_id = ${FAKE.akid}`,
    `aws_secret_access_key = ${FAKE.awsSecret}`,
    `DATABASE_PASSWORD=hunter2hunter2`,
    `"client_secret": "s3cr3t-value-123",`,
    `SLACK=${FAKE.slack}`,
    `curl -H "Authorization: Bearer ${FAKE.jwt}"`,
    `maps key ${FAKE.google}`,
    `clone https://bot:p4ssw0rd-xyz@example.invalid/org/repo.git`,
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '-----END OPENSSH PRIVATE KEY-----',
    `the vault says: internal-host-name.corp.example port 2222`,
  ].join('\n');
  const { text: out, redactions } = scrub(text, { vault: ['notes\ninternal-host-name.corp.example port 2222\nshort'] });
  for (const v of [...Object.values(FAKE), 'hunter2hunter2', 's3cr3t-value-123', 'p4ssw0rd-xyz', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', 'internal-host-name.corp.example']) {
    assert.ok(!out.includes(v), `leaked: ${v}`);
  }
  for (const k of ['github-token', 'api-key', 'aws-key-id', 'secret-value', 'slack-token', 'jwt', 'google-key', 'url-password', 'private-key', 'vault']) {
    assert.ok(redactions.some(r => r.kind === k), `no ${k} redaction`);
  }
  // Names and structure survive, so the text still reads; masks show no more than a known prefix.
  assert.match(out, /^export GITHUB_TOKEN=\[redacted:github-token\]$/m);
  assert.match(out, /^DATABASE_PASSWORD=\[redacted:secret-value\]$/m);
  assert.match(out, /https:\/\/bot:\[redacted:url-password\]@example\.invalid/);
  assert.deepEqual(redactions.find(r => r.kind === 'github-token').masked, 'ghp_…(40)');
  assert.ok(redactions.every(r => !/[0-9]{4}|hunter|s3cr3t/.test(r.masked)), 'masks leak nothing');

  const prose = [
    'We cut output tokens by half; see commit 3f9c2a1b4d5e6f708192a3b4c5d6e7f8a9b0c1d2.',
    'author: someone, DECK_PORT=7832, the token: none, password: short',
    'Decision: sk-1 is a ticket, AKIA alone is a word, Bearer of bad news.',
  ].join('\n');
  assert.deepEqual(scrub(prose), { text: prose, redactions: [] });
});

test('the store scrubs everything it writes, JSON included, and reports it', async () => {
  const { store } = await setup();
  store.vault = () => ['a line quoted from the vault, word for word'];
  const r = await store.create({ title: `Rotate ${FAKE.ghp}`, goal: `stop leaking ${FAKE.akid}; a line quoted from the vault, word for word` });
  const slug = r.workstream.slug;
  assert.ok(r.redactions.length >= 3);
  assert.ok(r.redactions.every(x => x.file && x.kind));
  await store.setList(slug, 'files', [{ repo: 'o/r', path: '.env', why: `has "quotes" and API_TOKEN=${FAKE.oai}\\`, source: { session: 's1' } }]);
  await store.addNote(slug, { text: `token was ${FAKE.slack}` });
  const all = sh(store.dir, 'log', '-p', '--all') + fs.readdirSync(store.dir, { recursive: true }).map(f => { try { return fs.readFileSync(path.join(store.dir, f), 'utf8'); } catch { return ''; } }).join('');
  for (const v of [FAKE.ghp, FAKE.akid, FAKE.oai, FAKE.slack, 'word for word']) assert.ok(!all.includes(v), `leaked into the repo: ${v}`);
  // The JSON stays valid even when a redacted value sat next to escapes.
  const files = JSON.parse(fs.readFileSync(path.join(store.dir, slug, 'files.json'), 'utf8'));
  assert.equal(files[0].path, '.env');
  assert.match(files[0].why, /API_TOKEN=\[redacted/);
  assert.equal(store.preview(`x ${FAKE.ant}`).redactions[0].kind, 'api-key');
  store.stop();
});

test('offline: commits locally, pushes later; a restart picks up what is unpushed', async () => {
  const { root, remote, store } = await setup();
  await store.create({ title: 'Online' });
  await store.flush();
  assert.equal(remoteLog(remote), 'create(online): Online');

  const away = path.join(root, 'away.git');
  fs.renameSync(remote, away); // the network goes
  const r = await store.update('online', { goal: 'written offline' });
  assert.equal(r.message, 'edit(online): goal');
  await store.flush();
  let st = await store.status();
  assert.equal(st.ahead, 1);
  assert.equal(st.lastError.op, 'push');
  assert.equal(store.get('online').goal, 'written offline');

  fs.renameSync(away, remote); // and comes back; a fresh store (a restart) pushes on resume
  store.stop();
  const again = new WorkstreamStore({ dir: store.dir, git, gh: noGh, pushDelay: 60_000 });
  const changed = new Promise(r => again.on('changed', r));
  await again.resume();
  await changed;
  await again.queue;
  st = await again.status();
  assert.equal(st.ahead, 0);
  assert.equal(st.lastError, null);
  assert.ok(st.lastPush);
  assert.equal(remoteLog(remote).split('\n')[0], 'edit(online): goal');
  again.stop();
});

test('the push is debounced: a burst of changes goes up in one push', async () => {
  const { remote, store } = await setup();
  store.pushDelay = 30;
  await store.create({ title: 'Burst' });
  await store.update('burst', { goal: 'g' });
  assert.equal(remoteLog(remote), '');
  await new Promise(r => setTimeout(r, 300));
  await store.queue;
  assert.equal(remoteLog(remote).split('\n').length, 2);
  store.stop();
});

test('a conflict is surfaced, not swallowed: nothing lost, writes stop until resolved', async () => {
  const { root, remote, store: a } = await setup();
  await a.create({ title: 'Shared' });
  await a.flush();
  const { store: b } = await setup(root, 'b');

  // b edits while it cannot reach the remote; a edits the same line and pushes.
  sh(b.dir, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
  await b.update('shared', { goal: 'from b' });
  sh(b.dir, 'remote', 'set-url', 'origin', remote);
  await a.update('shared', { goal: 'from a' });
  await a.flush();

  const events = [];
  b.on('changed', e => events.push(e));
  await assert.rejects(b.update('shared', { status: 'paused' }), (e) => {
    assert.equal(e.code, 409);
    assert.ok(e.conflict.files.includes('shared/workstream.md'), e.conflict.files.join());
    assert.deepEqual(e.conflict.ours.map(l => l.replace(/^\S+ /, '')), ['edit(shared): goal']);
    assert.deepEqual(e.conflict.theirs.map(l => l.replace(/^\S+ /, '')), ['edit(shared): goal']);
    assert.match(e.conflict.hint, /git pull --rebase/);
    return true;
  });
  assert.ok(events.some(e => e.reason === 'sync'), 'the conflict is announced');
  const st = await b.status();
  assert.ok(st.conflict);
  // Not auto-resolved: b's work is intact, no rebase is left half done, and the remote still has a's.
  assert.equal(b.get('shared').goal, 'from b');
  assert.ok(!fs.existsSync(path.join(b.dir, '.git', 'rebase-merge')));
  assert.equal(sh(b.dir, 'status', '--porcelain'), '');
  await b.flush();
  assert.match(sh(remote, 'show', 'HEAD:shared/workstream.md'), /goal: from a/);
  // Writes wait for the resolution.
  await assert.rejects(b.addNote('shared', { text: 'later' }), { code: 409 });

  // Resolved by hand (here: keep a's), then a sync clears it.
  sh(b.dir, 'reset', '-q', '--hard', 'origin/HEAD');
  await b.resync();
  assert.equal((await b.status()).conflict, null);
  await b.addNote('shared', { text: 'after the fix' });
  a.stop(); b.stop();
});

test('setup: create needs confirmation, runs gh repo create --private, and use refuses public repos', async () => {
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
  const calls = [];
  let exists = false;
  // A stand-in gh: the "GitHub repo" is the local bare one.
  const gh = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api') return { ok: true, stdout: 'someone\n', stderr: '' };
    if (args[0] === 'repo' && args[1] === 'view') {
      if (args[2] === 'someone/public-one') return { ok: true, stdout: '{"visibility":"PUBLIC"}', stderr: '' };
      return exists ? { ok: true, stdout: '{"visibility":"PRIVATE","url":"u"}', stderr: '' } : { ok: false, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'repo' && args[1] === 'create') { exists = true; return { ok: true, stdout: '', stderr: '' }; }
    if (args[0] === 'repo' && args[1] === 'clone') { sh(root, 'clone', '-q', remote, args[3]); return { ok: true, stdout: '', stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  const store = new WorkstreamStore({ dir: path.join(root, 'ws'), git, gh, pushDelay: 60_000 });
  assert.deepEqual(await store.suggest(), { repo: 'someone/agent-deck-workstreams', exists: false, visibility: null, command: 'gh repo create someone/agent-deck-workstreams --private' });
  await assert.rejects(store.useRepo({ repo: 'someone/public-one' }), /public; workstreams need a private repo/);
  await assert.rejects(store.createRepo(), { code: 400 });
  assert.ok(!calls.some(c => c.startsWith('repo create')), 'nothing created without confirmation');
  const st = await store.createRepo({ confirm: true });
  assert.ok(calls.includes('repo create someone/agent-deck-workstreams --private --description agent-deck workstreams'));
  assert.equal(st.ready, true);
  await assert.rejects(store.createRepo({ confirm: true }), { code: 409 });
  await store.create({ title: 'First' });
  await store.flush();
  assert.equal(remoteLog(remote), 'create(first): First');
  store.stop();
});

test('the API: create, patch, assign a session, live counts, and workstreams.changed', async () => {
  const root = tmp();
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
  const deck = new DeckState(path.join(root, 'state'));
  const sessions = { s1: { bucket: 'active' }, s2: { bucket: 'recent' } };
  const index = { summary: (id) => sessions[id] || null };
  const events = [];
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s ? JSON.parse(s) : {})); });
  const prev = process.env.DECK_GH;
  process.env.DECK_GH = path.join(root, 'no-gh');
  const table = (await loadRoutes(path.join(import.meta.dirname, '..', 'lib', 'routes'), { send, readBody, deck, index, broadcast: (e, d) => events.push([e, d]) }))
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
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    let r = await call('GET', '/api/workstreams/setup');
    assert.equal(r.body.ready, false);
    assert.ok(r.body.suggest.error, 'no gh: says so rather than failing');
    assert.equal((await call('POST', '/api/workstreams', { title: 'x' })).status, 409, 'not set up yet');
    assert.equal((await call('POST', '/api/workstreams/setup', { action: 'create' })).status, 400, 'create needs confirm');
    r = await call('POST', '/api/workstreams/setup', { action: 'use', repo: remote });
    assert.equal(r.body.ready, true);

    r = await call('POST', '/api/workstreams', { title: 'Deck workstreams', goal: 'Ship #28' });
    assert.equal(r.status, 201);
    const slug = r.body.workstream.slug;
    r = await call('PATCH', `/api/workstreams/${slug}`, { status: 'paused', next: 'Home (#33)' });
    assert.equal(r.body.workstream.status, 'paused');
    assert.equal((await call('PATCH', `/api/workstreams/${slug}`, { status: 'odd' })).status, 400);
    assert.equal((await call('PATCH', '/api/workstreams/nope', { goal: 'x' })).status, 404);
    r = await call('POST', `/api/workstreams/${slug}/decisions`, { title: 'Markdown and JSON' });
    assert.equal(r.body.n, 1);

    assert.equal((await call('POST', '/api/sessions/s1/workstream', { slug })).body.slug, slug);
    assert.equal((await call('POST', '/api/sessions/s2/workstream', { slug })).status, 200);
    assert.equal((await call('POST', '/api/sessions/zz/workstream', { slug })).status, 404);
    assert.equal((await call('POST', '/api/sessions/s1/workstream', { slug: 'nope' })).status, 404);
    assert.equal((await call('GET', '/api/sessions/s1/workstream')).body.slug, slug);
    assert.equal(deck.ns('workstreams').get('s1'), slug);

    r = await call('GET', '/api/workstreams');
    assert.equal(r.body.sync.ready, true);
    assert.deepEqual(r.body.workstreams.map(w => [w.slug, w.title, w.status, w.sessions, w.live]), [[slug, 'Deck workstreams', 'paused', 2, 1]]);
    r = await call('GET', `/api/workstreams/${slug}`);
    assert.equal(r.body.goal, 'Ship #28');
    // `live` is a count in both; the detail lists the session ids.
    assert.deepEqual(r.body.sessions.sort(), ['s1', 's2']);
    assert.equal(r.body.live, 1);
    assert.deepEqual(r.body.records, []);

    // Unassign.
    assert.deepEqual((await call('POST', '/api/sessions/s2/workstream', { slug: null })).body, { session: 's2', slug: null, was: slug });
    assert.equal(deck.ns('workstreams').get('s2'), undefined);

    // A session deleted after it was assigned: no longer counted, and it can still be unassigned.
    delete sessions.s1;
    r = await call('GET', '/api/workstreams');
    assert.deepEqual([r.body.workstreams[0].sessions, r.body.workstreams[0].live], [0, 0]);
    assert.deepEqual((await call('GET', `/api/workstreams/${slug}`)).body.sessions, []);
    assert.deepEqual((await call('POST', '/api/sessions/s1/workstream', { slug: null })).body, { session: 's1', slug: null, was: slug });
    assert.deepEqual(deck.ns('workstreams').keys(), []);
    assert.equal((await call('POST', '/api/sessions/zz/workstream', { slug: null })).status, 200, 'unassigning an unknown id is harmless');

    const reasons = events.filter(([e]) => e === 'workstreams.changed').map(([, d]) => d.reason);
    for (const want of ['setup', 'create', 'edit', 'decision', 'assign']) assert.ok(reasons.includes(want), `no ${want} event in ${reasons}`);
    assert.equal(events.every(([e]) => e === 'workstreams.changed'), true);
  } finally { server.close(); }
});

test('slugs and frontmatter round trip awkward values', () => {
  assert.equal(slugify('Ünïcode — and  spaces!'), 'unicode-and-spaces');
  assert.equal(slugify(''), 'untitled');
  const fields = { a: 'plain words', b: 'true', c: '42', d: 'has: colon', e: ['x', 'y'], f: { session: 's', event: null }, g: null, h: 'trailing ', i: '# heading' };
  const text = frontmatter(fields, '## Body\n\ntext');
  assert.match(text, /^a: plain words$/m, 'plain strings stay bare');
  assert.match(text, /^i: "# heading"$/m, 'a # would start a YAML comment');
  const { fields: back, body } = parseFrontmatter(text);
  assert.deepEqual(back, fields);
  assert.equal(body, '## Body\n\ntext\n');
});

/** Two clones of one remote; `offline(store, fn)` runs fn with that clone cut off. */
async function pair() {
  const { root, remote, store: a } = await setup();
  const { store: b } = await setup(root, 'b');
  const offline = async (s, fn) => {
    sh(s.dir, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    try { return await fn(); } finally { sh(s.dir, 'remote', 'set-url', 'origin', remote); }
  };
  return { root, remote, a, b, offline };
}

test('index.json, workstream.md dates and notes merge themselves; two clones writing apart never lock', async () => {
  const { remote, a, b, offline } = await pair();
  await a.create({ title: 'Base' });
  await a.flush();
  await b.resync();
  await offline(b, async () => {
    await b.create({ title: 'From b' });
    await b.addNote('base', { text: 'b was here' });
  });
  await a.create({ title: 'From a' });
  await a.addNote('base', { text: 'a was here' });
  await a.update('base', { goal: 'set by a' });
  await a.flush();

  // b's next write rebases over a's: index.json regenerated, notes appended, the goal and the later `updated` kept.
  const real = b.git; const ran = [];
  b.git = (args, o) => { ran.push(args.join(' ')); return real(args, o); };
  await b.update('from-b', { goal: 'g' });
  b.git = real;
  assert.ok(ran.some(c => c.endsWith('rebase --continue')), 'git did stop, and the store carried on');
  const st = await b.status();
  assert.equal(st.conflict, null);
  assert.deepEqual(b.list().map(w => w.slug).sort(), ['base', 'from-a', 'from-b']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'index.json'), 'utf8')).workstreams, b._buildIndex());
  const base = b.get('base');
  assert.equal(base.goal, 'set by a');
  assert.match(base.notes, /a was here[\s\S]*b was here/);
  await b.flush();
  assert.equal((await b.status()).ahead, 0);
  assert.equal(JSON.parse(sh(remote, 'show', 'HEAD:index.json')).workstreams.length, 3);
  a.stop(); b.stop();
});

test('decision numbers taken on both machines: the local, unpushed one moves, references follow', async () => {
  const { remote, a, b, offline } = await pair();
  await a.create({ title: 'Base' });
  await a.addDecision('base', { title: 'First' });
  await a.flush();
  await b.resync();
  await offline(b, async () => {
    assert.equal((await b.addDecision('base', { title: 'B second' })).n, 2);
    assert.equal((await b.addDecision('base', { title: 'B third', supersedes: 2 })).n, 3);
  });
  assert.equal((await a.addDecision('base', { title: 'A second' })).n, 2);
  await a.flush();

  await b.addNote('base', { text: 'after both' });
  const ds = Object.fromEntries(b.get('base').decisions.map(d => [d.file, d]));
  assert.deepEqual(Object.keys(ds).sort(), ['decisions/0001-first.md', 'decisions/0002-a-second.md', 'decisions/0003-b-third.md', 'decisions/0004-b-second.md']);
  assert.equal(ds['decisions/0003-b-third.md'].supersedes, '0004');
  assert.equal(ds['decisions/0004-b-second.md'].status, 'superseded');
  assert.equal(ds['decisions/0004-b-second.md'].supersededBy, '0003');
  assert.equal(ds['decisions/0002-a-second.md'].status, 'active', 'the pushed one is left alone');
  assert.match(sh(b.dir, 'log', '--format=%s'), /^renumber\(base\): 0002 → 0004$/m);
  await b.flush();
  // a picks it up with no duplicates of its own to fix.
  await a.addNote('base', { text: 'seen' });
  assert.deepEqual(a.get('base').decisions.map(d => d.n), [1, 2, 3, 4]);
  assert.doesNotMatch(sh(a.dir, 'log', '-1', '--format=%s'), /renumber/);
  await a.flush();
  assert.equal(remoteLog(remote).split('\n')[0], 'note(base): seen');
  a.stop(); b.stop();
});

test('a dirty clone is its own state, not a conflict; failed writes leave the tree as it was', async () => {
  const { store } = await setup();
  await store.create({ title: 'Clean' });
  const file = path.join(store.dir, 'clean', 'workstream.md');
  const before = fs.readFileSync(file, 'utf8');

  fs.appendFileSync(file, 'a hand edit\n');
  await assert.rejects(store.update('clean', { goal: 'x' }), (e) => {
    assert.equal(e.code, 409);
    assert.deepEqual(e.dirty.files, ['clean/workstream.md']);
    assert.equal(e.conflict, undefined);
    return true;
  });
  const st = await store.status();
  assert.equal(st.conflict, null);
  assert.deepEqual(st.dirty.files, ['clean/workstream.md']);
  assert.match(fs.readFileSync(file, 'utf8'), /a hand edit/, 'the hand edit is not thrown away');
  fs.writeFileSync(file, before);
  await store.update('clean', { goal: 'x' });
  assert.equal((await store.status()).dirty, null);

  // A commit that fails: nothing half-written stays behind.
  const head = sh(store.dir, 'rev-parse', 'HEAD');
  const real = store.git;
  store.git = (args, o) => args.includes('commit') ? Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'disk full' }) : real(args, o);
  await assert.rejects(store.create({ title: 'Never' }), /disk full/);
  store.git = real;
  assert.equal(sh(store.dir, 'status', '--porcelain'), '');
  assert.equal(sh(store.dir, 'rev-parse', 'HEAD'), head);
  assert.ok(!fs.existsSync(path.join(store.dir, 'never')));

  // A path outside the repo: refused before anything is written.
  await assert.rejects(store._write(async (w) => { w.file('clean/ok.md', 'x'); w.file('../escape.md', 'y'); return { slug: 'clean', message: 'm' }; }), /outside the repo/);
  assert.ok(!fs.existsSync(path.join(store.dir, 'clean', 'ok.md')));
  assert.ok(!fs.existsSync(path.join(path.dirname(store.dir), 'escape.md')));
  assert.equal(sh(store.dir, 'status', '--porcelain'), '');
  store.stop();
});

test('github URLs get the private check too; repo strings cannot be options', async () => {
  assert.equal(githubRepo('https://github.com/someone/repo.git'), 'someone/repo');
  assert.equal(githubRepo('https://github.com/someone/repo'), 'someone/repo');
  assert.equal(githubRepo('git@github.com:someone/repo.git'), 'someone/repo');
  assert.equal(githubRepo('ssh://git@github.com/someone/repo.git'), 'someone/repo');
  assert.equal(githubRepo('https://example.invalid/someone/repo.git'), null);
  assert.equal(githubRepo('/srv/git/repo.git'), null);

  const root = tmp();
  const calls = [];
  const gh = async (args) => { calls.push(['gh', ...args]); return args[1] === 'view' ? { ok: true, stdout: '{"visibility":"PUBLIC"}', stderr: '' } : { ok: false, stdout: '', stderr: 'no' }; };
  const gitSpy = async (args, o) => { calls.push(['git', ...args]); return git(args, o); };
  const store = new WorkstreamStore({ dir: path.join(root, 'ws'), git: gitSpy, gh, pushDelay: 60_000 });
  for (const url of ['https://github.com/someone/public-one.git', 'git@github.com:someone/public-one.git']) {
    await assert.rejects(store.useRepo({ repo: url }), /someone\/public-one is public; workstreams need a private repo/);
  }
  assert.ok(calls.every(c => c[0] === 'gh' && c[2] === 'view'), 'nothing cloned');
  calls.length = 0;
  for (const repo of ['--upload-pack=touch pwned', '-c/x', ' --template=/x']) {
    await assert.rejects(store.useRepo({ repo }), { code: 400 });
  }
  assert.deepEqual(calls, [], 'neither git nor gh ran');
  assert.ok(!fs.existsSync(path.join(root, 'ws')));

  // A plain URL or path is cloned with `--` before it.
  const remote = path.join(root, 'remote.git');
  sh(root, 'init', '-q', '--bare', remote);
  await store.useRepo({ repo: remote });
  assert.ok(calls.some(c => c[0] === 'git' && c[1] === 'clone' && c[2] === '--' && c[3] === remote));
  store.stop();
});

test('the vault hook can be set later, through storeFor too; status() answers from its cache', async () => {
  const { store } = await setup();
  const shared = storeFor(store.dir);
  assert.notEqual(shared, store);
  storeFor(store.dir, { vault: () => ['secret line from the vault'] });
  assert.equal(shared.preview('x secret line from the vault y').redactions[0].kind, 'vault');
  shared.setVault(null);
  assert.deepEqual(shared.preview('secret line from the vault').redactions, []);

  // status() answers from the cache: no git once it's known.
  await store.status();
  const real = store.git; let spawned = 0;
  store.git = (args, o) => { spawned++; return real(args, o); };
  assert.equal((await store.status()).ready, true);
  assert.equal(spawned, 0);
  store.git = real;
  store.stop();
});
