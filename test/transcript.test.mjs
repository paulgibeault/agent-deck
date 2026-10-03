import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionState, TranscriptTail, parseLine, toolSummary, probeHead, probeTail, cwdSlug, displayToolName } from '../lib/transcript.mjs';
import { computeBrief } from '../lib/brief.mjs';
import { SessionIndex } from '../lib/sessions.mjs';
import { runsClaude } from '../lib/spawns.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'session.jsonl');
const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

function loadFixture() {
  const s = new SessionState('sess-1');
  for (const l of lines) s.ingest(parseLine(l));
  return s;
}

test('every fixture record parses and ingests without throwing', () => {
  const s = loadFixture();
  assert.equal(s.meta.records, lines.length);
  const kinds = {};
  for (const e of s.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  assert.deepEqual(kinds, { queue: 3, prompt: 1, thinking: 1, tool: 3, system: 2, text: 1, turn_end: 1, raw: 1 });
});

test('unknown record types degrade to raw events, silent ones are skipped', () => {
  const s = loadFixture();
  const raw = s.events.filter(e => e.kind === 'raw');
  assert.equal(raw.length, 1);
  assert.equal(raw[0].subtype, 'some-future-record');
  assert.deepEqual(s.meta.unknownTypes, { 'some-future-record': 1 });
  assert.ok(!s.events.some(e => e.subtype === 'attachment' || e.subtype === 'atis-latch'));
});

test('tool_use and tool_result fold into one event with duration and error', () => {
  const s = loadFixture();
  const bash = s.events.find(e => e.kind === 'tool' && e.tool.name === 'Bash');
  assert.equal(bash.tool.pending, false);
  assert.equal(bash.tool.isError, true);
  assert.equal(bash.tool.durationMs, 2500);
  assert.equal(bash.tool.summary, 'npm test');
  assert.match(bash.tool.result.text, /1 failing/);
  assert.equal(bash.tool.meta.stdout, '[35 chars]'); // bulky duplicates are slimmed
});

test('Edit summary is refined from structuredPatch once the result lands', () => {
  const s = loadFixture();
  const edit = s.events.find(e => e.kind === 'tool' && e.tool.name === 'Edit');
  assert.equal(edit.tool.summary, 'solver.js +0 −1');
  assert.equal(edit.tool.durationMs, 250);
});

test('files touched: absolute tool paths and relative history deltas dedupe', () => {
  const s = loadFixture();
  const files = s.filesList();
  assert.equal(files.length, 1);
  assert.equal(files[0].path, '/tmp/proj/solver.js');
  assert.equal(files[0].writes, 2);
});

test('async subagent is tracked and marked done by the hand-back message', () => {
  const s = loadFixture();
  const agent = s.events.find(e => e.kind === 'tool' && e.tool.name === 'Agent');
  assert.equal(agent.tool.agentId, 'agent1');
  assert.ok(s.meta.doneAgents.has('agent1'));
  const pub = s.publicMeta();
  assert.deepEqual(pub.subagents.map(a => a.agentId), ['agent1']);
});

test('queue mirrors enqueue / dequeue / remove', () => {
  const s = loadFixture();
  assert.deepEqual(s.meta.queue.map(q => q.content), ['now add a changelog entry']);
  s.ingest({ type: 'queue-operation', operation: 'enqueue', content: 'b', timestamp: 'x' });
  s.ingest({ type: 'queue-operation', operation: 'remove', content: 'now add a changelog entry', timestamp: 'x' });
  assert.deepEqual(s.meta.queue.map(q => q.content), ['b']);
});

test('sideband metadata: title precedence, pr, cost, mode, usage dedupe by message id', () => {
  const s = loadFixture();
  assert.equal(s.title, 'Fix solver test');
  assert.equal(s.meta.pr.number, 15);
  assert.equal(s.meta.cost.totalCostUSD, 0.42);
  assert.equal(s.meta.mode, 'normal');
  assert.equal(s.meta.model, 'claude-opus-5-5');
  assert.equal(s.meta.effort, 'medium');
  // msg_1 appears in two records (thinking + tool_use) but counts once.
  assert.equal(s.meta.usage.messages, 4);
  assert.equal(s.meta.usage.output, 50 + 30 + 40 + 25);
  assert.equal(s.meta.usage.thinking, 20);
  assert.equal(s.meta.errors, 2); // bash error + api_error
  assert.equal(s.meta.turns, 1);
  assert.equal(s.meta.inTurn, false);
});

test('detail() returns the full result text and raw records', () => {
  const s = loadFixture();
  const d = s.detail('toolu_bash1');
  assert.equal(d.raw.length, 2);
  assert.equal(d.resultText, '1 failing\n  solver › smallest proof');
  assert.equal(d.toolUseResult.stdout, '1 failing\n  solver › smallest proof');
  assert.equal(s.detail('nope'), null);
});

test('TranscriptTail reads incrementally and survives partial lines', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-')), 't.jsonl');
  const [l1, l2, l3] = lines;
  fs.writeFileSync(tmp, l1 + '\n' + l2.slice(0, 20));
  const tail = new TranscriptTail(tmp);
  assert.equal(tail.readNew().length, 1);
  fs.appendFileSync(tmp, l2.slice(20) + '\n' + l3 + '\n');
  const more = tail.readNew();
  assert.equal(more.length, 2);
  assert.equal(more[1].type, 'user');
  assert.equal(tail.readNew().length, 0);
  fs.writeFileSync(tmp, l1 + '\n'); // truncation resets
  assert.equal(tail.readNew().length, 1);
});

test('brief: pending tool → running; finished dead session → ended; live idle → idle', () => {
  const s = new SessionState('x');
  const mid = lines.slice(0, 11); // up to and including the Bash tool_use
  for (const l of mid) s.ingest(parseLine(l));
  const live = { kind: 'session', alive: true, subagents: [] };
  let b = computeBrief(s, live, { status: 'busy' }, Date.parse('2026-09-29T05:47:17.000Z'));
  assert.equal(b.state, 'running');
  assert.match(b.detail, /^Bash npm test/);
  assert.equal(b.activeTool.name, 'Bash');
  assert.equal(b.waitingOn, 'tool');
  assert.equal(b.signal, 'working');
  const full = loadFixture();
  b = computeBrief(full, { kind: 'session', alive: false, subagents: [] }, null);
  assert.equal(b.state, 'ended');
  assert.equal(b.waitingOn, null);
  assert.equal(b.signal, 'ended');
  b = computeBrief(full, live, { status: 'idle' }, Date.parse('2026-09-29T05:50:00.000Z'));
  assert.equal(b.state, 'idle');
  assert.match(b.detail, /1 queued/);
  assert.equal(b.lastText, 'The test passes now.');
  assert.equal(b.queueDepth, 1);
  assert.equal(b.waitingOn, 'you');
  assert.equal(b.asked, false);
  assert.equal(b.signal, 'done', 'a clean finish is green');
  full.meta.lastText = 'Tests pass. Should I also update the docs?';
  const q = computeBrief(full, live, { status: 'idle' });
  assert.equal(q.asked, true);
  assert.equal(q.signal, 'input');
  assert.deepEqual([q.need.kind, q.need.text], ['question', 'Should I also update the docs?']);
  assert.equal(computeBrief(full, live, { status: 'busy', waiting: 'permission' }).signal, 'input');
  // The newest event an error: red, until something newer lands.
  full.meta.lastText = 'The test passes now.';
  full.events.push({ id: 'e-x', seq: 999, kind: 'tool', ts: '2026-09-29T05:49:00.000Z', tool: { name: 'Bash', display: 'Bash', summary: 'npm test', isError: true, pending: false, result: { text: 'exit 1' } } });
  const e = computeBrief(full, live, { status: 'idle' });
  assert.equal(e.signal, 'error');
  assert.equal(e.need.seq, 999);
});

test('toolSummary one-liners', () => {
  assert.equal(toolSummary('Read', { file_path: '/a/b.js', offset: 10, limit: 5 }), 'b.js :10+5');
  assert.equal(toolSummary('Write', { file_path: '/a/b.js', content: 'x\ny' }), 'b.js (2 lines)');
  assert.equal(toolSummary('Grep', { pattern: 'foo', path: '/a/src' }), '/foo/ in src');
  assert.equal(toolSummary('Agent', { description: 'Do it', subagent_type: 'Explore' }), '"Do it" · Explore');
  assert.equal(toolSummary('mcp__x__y', { a: 1 }), '{"a":1}');
  assert.equal(displayToolName('mcp__ccd_pr__get_status'), 'ccd_pr.get_status');
});

test('probeHead / probeTail / cwdSlug', () => {
  assert.deepEqual(probeHead(FIXTURE), { cwd: '/tmp/proj', sessionId: 'sess-1', version: '2.1.284', gitBranch: 'main', startTs: '2026-09-29T05:47:11.815Z', entrypoint: 'claude-desktop' });
  const t = probeTail(FIXTURE);
  assert.equal(t.title, 'Fix solver test');
  assert.equal(t.lastPrompt, 'fix the failing test');
  assert.equal(t.pr.number, 15);
  assert.equal(cwdSlug('/Users/me/work/x.y/.claude/worktrees/z'), '-Users-me-work-x-y--claude-worktrees-z');
});

test('SessionIndex: buckets, subagent tree, paging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-home-'));
  const proj = path.join(dir, 'projects', '-tmp-proj');
  fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(proj, 'sess-1.jsonl'));
  fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-agent1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Verify fix', toolUseId: 'toolu_agent1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-agent1.jsonl'),
    JSON.stringify({ type: 'user', isSidechain: true, agentId: 'agent1', message: { role: 'user', content: 'Run the tests and report.' }, uuid: 'x1', timestamp: '2026-09-29T05:47:23.000Z', cwd: '/tmp/proj', sessionId: 'sess-1' }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'agent1', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'All green.' }], stop_reason: 'end_turn', usage: { output_tokens: 3 } }, uuid: 'x2', timestamp: '2026-09-29T05:47:30.000Z', cwd: '/tmp/proj', sessionId: 'sess-1' }) + '\n');
  const idx = new SessionIndex({ claudeDir: dir, recentDays: 3650 });
  idx.scanProjects(); idx.refreshRegistry();
  const snap = idx.snapshot();
  assert.equal(snap.active.length, 0);
  assert.equal(snap.recent.length, 1);
  const s = snap.recent[0];
  assert.equal(s.title, 'Fix solver test');
  assert.equal(s.cwd, '/tmp/proj');
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].title, 'Verify fix');
  assert.equal(s.subagents[0].status, 'ended');
  idx.load('sess-1'); idx.load('agent1');
  assert.equal(idx.summary('agent1').status, 'done');
  const page = idx.events('sess-1', 0, 5);
  assert.equal(page.events.length, 5);
  assert.equal(page.more, true);
  const rest = idx.events('sess-1', page.events.at(-1).seq, 100);
  assert.equal(page.events.length + rest.events.length, page.total);
  assert.equal(idx.brief('sess-1').state, 'ended');
  assert.equal(idx.filesOf('sess-1').length, 1);
});

test('SessionIndex: a headless session started by a Bash `claude -p` call nests under that session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-home-'));
  const proj = path.join(dir, 'projects', '-tmp-proj');
  fs.mkdirSync(proj, { recursive: true });
  const rec = (o) => JSON.stringify({ sessionId: o.sid, cwd: '/tmp/proj', ...o }) + '\n';
  const t = (s) => `2026-10-03T17:00:${String(s).padStart(2, '0')}.000Z`;
  const bash = (sid, s, id, command) => rec({ sid, type: 'assistant', timestamp: t(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (sid, s, id) => rec({ sid, type: 'user', timestamp: t(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const prompt = (sid, s, text, entrypoint) => rec({ sid, type: 'user', timestamp: t(s), entrypoint, message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(proj, 'parent.jsonl'), prompt('parent', 0, 'try the CLI', 'cli')
    + bash('parent', 1, 'tu1', 'ls ~/.claude/projects') + result('parent', 2, 'tu1')
    + bash('parent', 10, 'tu2', 'cd /tmp && claude -p "/usage"') + result('parent', 12, 'tu2'));
  fs.writeFileSync(path.join(proj, 'child.jsonl'), prompt('child', 11, '<command-name>/usage</command-name>\n<command-args></command-args>', 'sdk-cli'));
  fs.writeFileSync(path.join(proj, 'stray.jsonl'), prompt('stray', 30, 'unrelated headless run', 'sdk-cli'));
  fs.writeFileSync(path.join(proj, 'early.jsonl'), prompt('early', 2, 'during ls, not claude', 'sdk-cli'));
  const idx = new SessionIndex({ claudeDir: dir, recentDays: 3650 });
  idx.scanProjects();
  assert.equal(idx.summary('child').spawnedBy, 'parent');
  assert.deepEqual(idx.summary('parent').spawned, ['child']);
  assert.equal(idx.summary('stray').spawnedBy, null, 'outside every claude call');
  assert.equal(idx.summary('early').spawnedBy, null, 'a call that only reads ~/.claude does not count');
  assert.equal(idx.summary('child').title, '/usage', 'slash-command prompts read as the command');
  assert.equal(runsClaude('npx claude-thing'), false);
  assert.equal(runsClaude('/opt/homebrew/bin/claude -p hi'), true);
});

test('inference: one per API response, on its first event, with switches and cache diagnostics', () => {
  const s = new SessionState('inf');
  const rec = (uuid, msgId, model, block, extra = {}, usage = {}) => ({ type: 'assistant', uuid, timestamp: '2026-10-03T10:00:00.000Z', requestId: `req_${msgId}`, effort: 'high', perTurnEffort: 'medium', ...extra,
    message: { id: msgId, model, role: 'assistant', stop_reason: 'tool_use', content: [block],
      usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 }, output_tokens: 30, output_tokens_details: { thinking_tokens: 10 }, service_tier: 'standard', speed: 'standard', ...usage },
      ...(extra.message || {}) } });
  s.ingest(rec('a1', 'm1', 'claude-fable-5-1', { type: 'thinking', thinking: '' }, { thinkingDurationMs: 900 }));
  s.ingest(rec('a2', 'm1', 'claude-fable-5-1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }));
  s.ingest(rec('a3', 'm2', 'claude-opus-5-5', { type: 'text', text: 'hi' }, { message: { diagnostics: { cache_miss_reason: { type: 'model_changed', cache_missed_input_tokens: 111845 } } } }));
  const [think, tool, text] = s.events;
  assert.equal(think.inference.model, 'claude-fable-5-1');
  assert.equal(think.inference.effort, 'medium');
  assert.equal(think.inference.sessionEffort, 'high');
  assert.equal(think.inference.thinkingMs, 900);
  assert.deepEqual(think.inference.usage, { input: 2, cacheRead: 1000, cacheWrite: 50, cacheWrite1h: 50, output: 30, thinking: 10 });
  assert.equal(think.inference.speed, undefined, 'standard speed is not worth showing');
  assert.equal(tool.inference, undefined, 'the rest of the response points back by msgId');
  assert.equal(tool.usage, undefined, 'usage is not repeated on every block');
  assert.equal(tool.msgId, 'm1');
  assert.equal(text.inference.switchedFrom, 'claude-fable-5-1');
  assert.deepEqual(text.inference.cacheMiss, { reason: 'model_changed', tokens: 111845 });
  assert.equal(s.meta.usage.messages, 2);

  s.ingest(rec('a4', 'm3', '<synthetic>', { type: 'text', text: 'API Error' }, { isApiErrorMessage: true }));
  assert.equal(s.events.at(-1).inference.synthetic, true);
  assert.equal(s.meta.model, 'claude-opus-5-5', 'a synthetic message is not a model switch');
});
