// Backends and moving sessions between them: backend identity from the
// harness config, the handoff prompt, GitHub refs found in a session's
// events, and AgentManager.migrate across a Claude and an ACP harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../lib/agent.mjs';
import { AcpDriver } from '../lib/harness/acp.mjs';
import { ClaudeDriver } from '../lib/harness/claude.mjs';
import { loadHarnesses, backendOf } from '../lib/harnesses.mjs';
import { handoffPrompt, returnPrompt, lastTestRun } from '../lib/handoff.mjs';
import { refsFromEvents, checksOf } from '../lib/ghrefs.mjs';
import { DailyUsage } from '../lib/daily.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { githubRepo, place } from '../lib/gitinfo.mjs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.join(__dirname, 'fixtures', 'fake-acp.mjs');
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-agent.mjs');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const cwd = tmp('deck-mig-proj-');
process.env.CLAUDE_CONFIG_DIR ||= tmp('deck-mig-home-');

test('backends: defaults by harness, overridable in harnesses.json', () => {
  assert.deepEqual(backendOf({ type: 'claude', bin: 'claude' }, 'claude'), { kind: 'anthropic', label: 'Claude Code' });
  assert.deepEqual(backendOf({ type: 'acp', bin: '/usr/local/bin/opencode' }, 'oc'), { kind: 'local', label: 'Local' });
  assert.deepEqual(backendOf({ type: 'acp', bin: 'gemini' }, 'g'), { kind: 'google', label: 'Google' });
  assert.deepEqual(backendOf({ type: 'acp', bin: 'opencode', backend: 'openai', backendLabel: 'GPT via opencode' }, 'x'), { kind: 'openai', label: 'GPT via opencode' });
  assert.deepEqual(backendOf({ type: 'acp', bin: 'mystery', label: 'Mystery agent' }, 'm'), { kind: 'other', label: 'Mystery agent' });

  const dir = tmp('deck-mig-cfg-');
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ default: 'gem', harnesses: {
    claude: { type: 'claude' }, gem: { type: 'acp', bin: 'gemini', args: ['--acp'], label: 'Gemini CLI' } } }));
  const { drivers } = loadHarnesses(dir);
  const list = new AgentManager({ drivers, defaultHarness: 'gem' }).harnessList();
  assert.deepEqual(list.map(h => [h.name, h.backend.kind, h.default]), [['claude', 'anthropic', false], ['gem', 'google', true]]);
});

const ev = (seq, kind, x) => ({ id: `e${seq}`, seq, ts: '2026-10-18T10:00:00Z', kind, ...x });

test('handoff: place, every prompt, the conversation, files, and the next step', () => {
  const events = [
    ev(1, 'prompt', { text: 'Add a dark mode toggle' }),
    ev(2, 'text', { text: 'Looking at the settings page.' }),
    ev(3, 'tool', { tool: { name: 'Edit', display: 'Edit', summary: 'src/settings.tsx', pending: false } }),
    ev(4, 'turn_end', {}),
    ...Array.from({ length: 400 }, (_, i) => ev(5 + i, 'text', { text: `filler ${i} `.repeat(30) })),
    ev(500, 'prompt', { text: 'Now persist it in localStorage' }),
  ];
  const p = handoffPrompt({ summary: { cwd: '/w/app', gitBranch: 'dark-mode' }, events, from: 'Claude Code', to: 'Local (opencode)',
    files: ['src/settings.tsx'], note: 'Finish the persistence, then run the tests', budget: 8000 });
  assert.match(p, /ran on Claude Code and now continues on Local \(opencode\)/);
  assert.match(p, /Folder: \/w\/app\nBranch: dark-mode/);
  assert.match(p, /Add a dark mode toggle/);                 // old prompts survive trimming
  assert.match(p, /Now persist it in localStorage/);
  assert.match(p, /- src\/settings\.tsx/);
  assert.match(p, /## What to do now\nFinish the persistence, then run the tests$/);
  assert.ok(p.length < 8000 + 500, `handoff is ${p.length} chars`);
  assert.match(handoffPrompt({ events: [] }), /Pick up where it left off/);
});

test('GitHub refs: links, gh commands and their output, "fixes #N", the linked PR; newest first', () => {
  const bash = (seq, command, result = '') => ev(seq, 'tool', { tool: { name: 'Bash', command, input: { command }, result: { text: result }, pending: false } });
  const refs = refsFromEvents([
    ev(1, 'prompt', { text: 'Fix https://github.com/acme/app/issues/12 please' }),
    bash(2, 'gh issue view 12'),
    bash(3, 'git commit -m "Theme toggle (fixes #12, closes #13)"'),
    bash(4, 'gh pr create --fill', 'https://github.com/acme/app/pull/40\n'),
    bash(5, 'curl -s https://example.com', 'see https://github.com/other/thing/pull/99'),   // tool output that is not gh: ignored
    bash(6, 'gh pr view 7 --repo acme/lib'),
    bash(6, "cat > t.mjs <<'EOF'\n  bash(1, 'gh pr view 8 --repo acme/lib') // https://github.com/acme/app/issues/77\nEOF\nnode t.mjs"),   // text in a heredoc is not a command
    bash(6, 'echo "see gh issue view 5" && grep -r "fixes #6" .'),
    ev(7, 'text', { text: 'Opened https://github.com/acme/app/pull/40.' }),
  ], { repo: 'acme/app', pr: { number: 3, url: 'https://github.com/acme/app/pull/3' } });
  assert.deepEqual(refs.map(r => `${r.kind} ${r.repo}#${r.number}`),
    ['pr acme/app#40', 'pr acme/lib#7', 'issue acme/app#12', 'issue acme/app#13', 'pr acme/app#3']);
  assert.equal(refs[0].url, 'https://github.com/acme/app/pull/40');
});

test('place: repo root, linked worktree, branch, GitHub repo', async () => {
  assert.equal(githubRepo('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(githubRepo('https://github.com/acme/app'), 'acme/app');
  assert.equal(githubRepo('https://gitlab.com/acme/app.git'), null);
  const repo = tmp('deck-mig-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'init');
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  const wt = path.join(tmp('deck-mig-wt-'), 'feature');
  git('worktree', 'add', '-q', '-b', 'feature', wt);
  const main = await place(repo);
  assert.equal(main.root, repo); assert.equal(main.branch, 'main'); assert.equal(main.worktree, null);
  assert.deepEqual(main.github, { repo: 'acme/app', url: 'https://github.com/acme/app' });
  const linked = await place(wt);
  assert.equal(linked.branch, 'feature');
  assert.equal(linked.worktree.name, 'feature');
  assert.equal(linked.worktree.main, repo);
  const plain = tmp('deck-mig-norepo-');
  assert.deepEqual(await place(plain), { repo: false, cwd: plain });
});

function until(agents, id, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => { const st = agents.publicState(id); if (st && pred(st)) { agents.off('change', check); clearTimeout(t); resolve(st); } };
    const t = setTimeout(() => { agents.off('change', check); reject(new Error(`timed out; state: ${JSON.stringify(agents.publicState(id))}`)); }, ms);
    agents.on('change', check);
    check();
  });
}
function manager(t, opts = {}) {
  const log = path.join(tmp('deck-mig-log-'), 'methods.log');
  const agents = new AgentManager({ drivers: {
    claude: new ClaudeDriver({ bin: FAKE_CLAUDE }),
    fake: new AcpDriver({ bin: process.execPath, args: [FAKE_ACP], label: 'fake acp', env: { ...process.env, FAKE_ACP_LOG: log } }),
  }, defaultHarness: 'claude', ...opts });
  t.after(() => agents.shutdown());
  return agents;
}

test('migrate: a live Claude session moves to the ACP harness; the old one ends, both are linked', async (t) => {
  const agents = manager(t);
  const st = await agents.launch({ cwd, prompt: 'hello', permissionMode: 'acceptEdits' });
  await until(agents, st.id, s => s.status === 'idle');
  await assert.rejects(agents.migrate(st.id, { harness: 'claude', prompt: 'x', cwd }), /already runs there/);

  const moved = await agents.migrate(st.id, { harness: 'fake', prompt: 'You are taking over…', cwd, name: 'hello' });
  assert.notEqual(moved.id, st.id);
  assert.equal(moved.harness, 'fake');
  assert.equal(moved.permissionMode, 'default');   // acceptEdits is Claude's; the ACP harness asks
  await until(agents, st.id, s => !s.alive);
  assert.deepEqual(agents.lineageOf(moved.id).from, { id: st.id, harness: 'claude', at: agents.lineageOf(moved.id).from.at });
  assert.equal(agents.lineageOf(st.id).to.id, moved.id);
  assert.equal(agents.lineageOf(st.id).to.harness, 'fake');
  assert.equal(agents.recordedHarness(moved.id), 'fake');
});

test('migrate: prompts kept from before a restart go along, still held; the link survives a restart', async (t) => {
  const store = path.join(tmp('deck-mig-store-'), 'agents.json');
  fs.writeFileSync(store, JSON.stringify({ queues: { old1: { cwd, items: [{ id: 'q1', text: 'and then this', at: 1, attachments: [] }] } } }));
  const agents = manager(t, { store });
  assert.equal(agents.publicState('old1').held, true);
  const moved = await agents.migrate('old1', { harness: 'fake', prompt: 'take over', cwd });
  const st = agents.publicState(moved.id);
  assert.deepEqual(st.queue.map(q => q.text), ['and then this']);
  assert.equal(st.held, true);
  assert.equal(agents.publicState('old1').queue.length, 0);
  agents.flush();
  const again = new AgentManager({ drivers: agents.drivers, store });
  assert.equal(again.lineageOf(moved.id).from.id, 'old1');
  assert.equal(again.lineageOf('old1').to.id, moved.id);
});

test('handoff: what is not committed and the last test run; a move back hears only what happened since', () => {
  const bash = (seq, command, result, isError = false) => ev(seq, 'tool', { tool: { name: 'Bash', display: 'Bash', summary: command, command, result: { text: result }, isError, pending: false } });
  const events = [ev(1, 'prompt', { text: 'make it pass' }), bash(2, 'npm test', '1 failing'), bash(3, 'ls', 'a b'), bash(4, 'npm run test -- --watch=false', 'ok 12 passed')];
  assert.deepEqual(lastTestRun(events), { command: 'npm run test -- --watch=false', failed: false, output: 'ok 12 passed' });
  assert.equal(lastTestRun(events.slice(0, 3)).failed, false);
  assert.equal(lastTestRun([bash(1, 'pytest -q', 'E assert 1 == 2', true)]).failed, true);
  assert.equal(lastTestRun([bash(1, 'cd app && CI=1 npx vitest run', 'ok')]).command, 'cd app && CI=1 npx vitest run');
  assert.equal(lastTestRun([bash(1, 'gh issue create --body "make sure npm test passes"', 'url')]), null);
  assert.equal(lastTestRun([bash(1, 'echo "run pytest later"', '')]), null);
  const work = { repo: true, branch: 'fix', totals: { files: 2, added: 12, deleted: 3 },
    files: [{ path: 'a.js', x: ' ', y: 'M', added: 10, deleted: 3 }, { path: 'new.txt', x: '?', y: '?', untracked: true, added: 2, deleted: 0 }] };
  const p = handoffPrompt({ events, work, from: 'Claude Code' });
  assert.match(p, /## Not committed yet\n2 files, \+12 −3 against HEAD on fix:\n·M a\.js \+10 −3\n\?\? new\.txt \+2 −0/);
  assert.match(p, /## Last test run \(passed\)\n\$ npm run test -- --watch=false/);

  const away = [ev(1, 'prompt', { text: 'You are taking over a coding session… (the whole handoff)' }), ev(2, 'text', { text: 'Fixed the parser.' }), bash(3, 'go test ./...', 'FAIL x', true)];
  const r = returnPrompt({ events: away, away: 'Local (opencode)', note: 'commit it' });
  assert.match(r, /moved to Local \(opencode\) and carried on there/);
  assert.doesNotMatch(r, /the whole handoff/);
  assert.match(r, /Fixed the parser/);
  assert.match(r, /## Last test run \(failed\)\n\$ go test/);
  assert.match(r, /## What to do now\ncommit it$/);
});

test('CI: checks summarized; red CI on a finished turn needs you', () => {
  assert.equal(checksOf([]), null);
  assert.deepEqual(checksOf([
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
  ]), { state: 'failure', passed: 1, failed: 1, pending: 2, failing: ['lint'] });
  assert.equal(checksOf([{ __typename: 'CheckRun', name: 'x', status: 'QUEUED' }]).state, 'pending');

  const index = new SessionIndex({ claudeDir: tmp('deck-mig-ci-') });
  index.ci = (id) => id === 's1' ? { pr: 20, url: 'u', failing: ['lint', 'test'] } : null;
  assert.deepEqual(index._withCi('s1', { signal: 'done' }), { signal: 'error', need: { kind: 'ci', text: 'CI failed on PR #20: lint, test', url: 'u' } });
  assert.deepEqual(index._withCi('s1', { signal: 'working' }), { signal: 'working' });   // the agent may be fixing it
  assert.deepEqual(index._withCi('s2', { signal: 'done' }), { signal: 'done' });
});

test('today: responses counted once, only today, priced; files read incrementally; streamed turns too', () => {
  const dir = tmp('deck-mig-daily-');
  const file = path.join(dir, 's.jsonl');
  const now = new Date().toISOString();
  const rec = (id, ts, usage, model = 'claude-sonnet-4-6') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage } }) + '\n';
  fs.writeFileSync(file, rec('old', '2000-01-01T00:00:00Z', { input_tokens: 999, output_tokens: 999 })
    + rec('m1', now, { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000 })
    + rec('m1', now, { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10_000 }));   // a second block of the same response
  const d = new DailyUsage();
  let t = d.today([{ file, sessionId: 's' }]).backends.claude;
  assert.equal(t.calls, 1); assert.equal(t.input, 1000); assert.equal(t.output, 2000); assert.equal(t.sessions, 1);
  assert.ok(Math.abs(t.costUsd - (1000 * 3 + 2000 * 15 + 10_000 * 0.3) / 1e6) < 1e-9);
  fs.appendFileSync(file, rec('m2', now, { input_tokens: 5, output_tokens: 5 }, 'mystery-model'));
  t = d.today([{ file, sessionId: 's' }]).backends.claude;
  assert.equal(t.calls, 2); assert.equal(t.unpriced, 1);
  const streamed = d.today([], [{ sessionId: 'a', harness: 'opencode', events: [ev(1, 'turn_end', { ts: now, usage: { input_tokens: 300, output_tokens: 40 } })] }]).backends.opencode;
  assert.deepEqual([streamed.calls, streamed.input, streamed.output, streamed.sessions], [1, 300, 40, 1]);
});

test('migrate back: a session moved away returns to the one it came from, which resumes', async (t) => {
  const agents = manager(t);
  const a = await agents.launch({ cwd, prompt: 'start here' });
  await until(agents, a.id, s => s.status === 'idle');
  const b = await agents.migrate(a.id, { harness: 'fake', prompt: 'take over', cwd });
  await until(agents, a.id, s => !s.alive);
  await until(agents, b.id, s => s.status === 'idle');
  const back = await agents.migrate(b.id, { resume: a.id, prompt: 'what happened since' });
  assert.equal(back.id, a.id);
  assert.equal(back.alive, true);
  assert.equal(agents.lineageOf(a.id).from.id, b.id);
  assert.equal(agents.lineageOf(b.id).to.id, a.id);
  await until(agents, b.id, s => !s.alive);
});

test('moves: the first saved form (lineage by new id) still loads', () => {
  const store = path.join(tmp('deck-mig-legacy-'), 'agents.json');
  fs.writeFileSync(store, JSON.stringify({ lineage: { newer: { from: 'older', harness: 'claude', at: 5 } } }));
  const agents = new AgentManager({ store });
  assert.equal(agents.lineageOf('newer').from.id, 'older');
  assert.equal(agents.lineageOf('older').to.id, 'newer');
});
