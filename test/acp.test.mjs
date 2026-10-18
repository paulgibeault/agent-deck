import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, AcpError } from '../lib/acp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-acp.mjs');
const CWD = fs.realpathSync(os.tmpdir());

/** A connection to the fake agent; `env` adds FAKE_ACP_* switches. */
function fake(env = {}) {
  return new AcpConnection({ bin: process.execPath, args: [FAKE], cwd: CWD, env: { ...process.env, ...env } });
}

/** Collect session/update payloads for one session. */
function updates(conn, sessionId) {
  const seen = [];
  conn.on('update', (p) => { if (p.sessionId === sessionId) seen.push(p.update); });
  return seen;
}
const text = (ups, kind) => ups.filter(u => u.sessionUpdate === kind).map(u => u.content.text).join('');

test('framing: messages split across writes, several per write, blank and non-JSON lines', async () => {
  // A one-off agent that answers initialize in awkward pieces.
  const script = `
    const w = (s) => process.stdout.write(s);
    process.stdin.once('data', () => {
      const r = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } });
      const n = (u) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } });
      w('not json\\n\\n' + n({ n: 1 }) + '\\n' + n({ n: 2 }) + '\\n' + r.slice(0, 10));
      setTimeout(() => w(r.slice(10) + '\\n'), 30);
    });
    process.stdin.on('end', () => process.exit(0));`;
  const conn = new AcpConnection({ bin: process.execPath, args: ['-e', script], cwd: CWD });
  const seen = [];
  conn.on('update', (p) => seen.push(p.update.n));
  const init = await conn.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(seen, [1, 2]);
  await conn.close();
});

test('initialize, session/new and a prompt with streamed chunks', async () => {
  const conn = fake();
  try {
    const init = await conn.initialize();
    assert.equal(init.agentInfo.name, 'FakeACP');
    assert.deepEqual(init._client, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, 'the deck advertises no fs or terminal');
    const s = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
    assert.match(s.sessionId, /^ses_fake_/);
    assert.equal(s.configOptions.find(o => o.id === 'mode').currentValue, 'build');
    assert.ok(conn.sessions.has(s.sessionId));
    const ups = updates(conn, s.sessionId);
    const r = await conn.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.usage.outputTokens, 18);
    assert.equal(text(ups, 'agent_message_chunk'), 'Fake reply to: hello', 'two chunks, one message');
    assert.equal(text(ups, 'agent_thought_chunk'), 'Thinking about it.');
    assert.deepEqual(ups.find(u => u.sessionUpdate === 'usage_update'), { sessionUpdate: 'usage_update', used: 8307, size: 65536, cost: { amount: 0, currency: 'USD' } });
    assert.equal(conn.prompting.size, 0);
  } finally { await conn.close(); }
});

test('a tool call arrives as tool_call then tool_call_update by toolCallId', async () => {
  const conn = fake();
  try {
    await conn.initialize();
    const { sessionId } = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
    const ups = updates(conn, sessionId);
    await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'use a tool' }] });
    const calls = ups.filter(u => u.toolCallId === 'call_read_1');
    assert.deepEqual(calls.map(u => `${u.sessionUpdate}:${u.status}`), ['tool_call:pending', 'tool_call_update:in_progress', 'tool_call_update:completed']);
    assert.equal(calls[0].kind, 'read');
    assert.equal(calls[2].content[0].content.text, '# Fake readme');
  } finally { await conn.close(); }
});

test('errors: JSON-RPC errors reject with AcpError and the agent\'s code', async () => {
  const conn = fake();
  try {
    await conn.initialize();
    await assert.rejects(conn.request('session/nope', {}), (e) => e instanceof AcpError && e.code === -32601 && e.method === 'session/nope');
    await assert.rejects(conn.request('session/new', { cwd: 'relative', mcpServers: [] }), (e) => e.code === -32602 && /absolute/.test(e.message));
    const { sessionId } = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
    const first = conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'slow' }] });
    await assert.rejects(conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] }), /already has an active ACP prompt/);
    conn.notify('session/cancel', { sessionId });
    await first;
  } finally { await conn.close(); }
});

test('agent -> client requests: permission (id 0) allowed or rejected, a throwing handler, unknown methods get -32601', async () => {
  const conn = fake();
  try {
    await conn.initialize();
    const { sessionId } = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
    const ups = updates(conn, sessionId);
    const asked = [];
    let pick = 'once';
    conn.onRequest('session/request_permission', (params, { id }) => {
      asked.push({ id, params });
      if (pick === 'throw') throw new Error('handler broke');
      const opt = params.options.find(o => o.optionId === pick);
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    });

    let r = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission please' }] });
    assert.equal(asked[0].id, 0, 'agent request ids start at 0');
    assert.equal(asked[0].params.toolCall.content[0].type, 'diff');
    assert.deepEqual(asked[0].params.options.map(o => o.kind), ['allow_once', 'allow_always', 'reject_once']);
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(ups.findLast(u => u.toolCallId === 'call_write_1').status, 'completed');

    pick = 'reject';
    r = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission again' }] });
    assert.equal(asked[1].id, 1);
    assert.equal(r.stopReason, 'cancelled', 'rejecting ends the turn');
    assert.equal(ups.findLast(u => u.toolCallId === 'call_write_1').status, 'failed');

    pick = 'throw';
    r = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission once more' }] });
    assert.equal(r.stopReason, 'cancelled', 'a handler error is an error reply, which the agent treats as no');

    const before = ups.length;
    await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read it via fs' }] });
    assert.equal(text(ups.slice(before), 'agent_message_chunk'), 'fs reply: error -32601');
  } finally { await conn.close(); }
});

test('cancel: session/cancel ends a running prompt with stopReason cancelled', async () => {
  const conn = fake();
  try {
    await conn.initialize();
    const { sessionId } = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
    const ups = updates(conn, sessionId);
    const p = conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'slow count' }] });
    while (!ups.some(u => u.sessionUpdate === 'agent_message_chunk')) await new Promise(r => setTimeout(r, 10));
    conn.notify('session/cancel', { sessionId });
    const r = await p;
    assert.equal(r.stopReason, 'cancelled');
    assert.ok(text(ups, 'agent_message_chunk').split('\n').length < 300, 'stopped early');
  } finally { await conn.close(); }
});

test('close: cancels prompts in flight and closes each session before ending stdin', async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-acp-')), 'methods.log');
  const conn = fake({ FAKE_ACP_LOG: logFile });
  await conn.initialize();
  const a = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
  await conn.request('session/new', { cwd: CWD, mcpServers: [] });
  const running = conn.request('session/prompt', { sessionId: a.sessionId, prompt: [{ type: 'text', text: 'slow' }] });
  await new Promise(r => setTimeout(r, 100));
  const exits = [];
  conn.on('exit', (x) => exits.push(x));
  const info = await conn.close();
  assert.equal(info.code, 0, 'exited on its own once stdin ended');
  assert.equal((await running).stopReason, 'cancelled');
  const methods = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  const tail = methods.slice(methods.indexOf('session/cancel'));
  assert.deepEqual(tail, ['session/cancel', 'session/close', 'session/close', 'eof']);
  assert.equal(exits.length, 1);
  assert.equal(conn.alive, false);
  await assert.rejects(conn.request('session/new', { cwd: CWD, mcpServers: [] }), /exited 0/);
  assert.equal(await conn.close(), info, 'closing twice is harmless');
});

test('close: an agent that ignores the end of stdin is signalled', async () => {
  const conn = fake({ FAKE_ACP_STUBBORN: '1' });
  await conn.initialize();
  await conn.request('session/new', { cwd: CWD, mcpServers: [] });
  const info = await conn.close();
  assert.equal(info.signal, 'SIGTERM');
});

test('a crash rejects what is pending with the exit and stderr; a missing binary fails initialize', async () => {
  const conn = fake();
  await conn.initialize();
  const { sessionId } = await conn.request('session/new', { cwd: CWD, mcpServers: [] });
  const exited = new Promise(r => conn.once('exit', r));
  await assert.rejects(conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'crash' }] }), /exited 3: fake-acp: crashed on purpose/);
  assert.equal((await exited).code, 3);

  const missing = new AcpConnection({ bin: path.join(CWD, 'no-such-acp-agent'), cwd: CWD });
  await assert.rejects(missing.initialize(), /no-such-acp-agent not found/);
  assert.equal(missing.alive, false);
});
