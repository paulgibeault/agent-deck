#!/usr/bin/env node
// Stand-in for an ACP agent (`opencode acp`) so the deck's ACP client can be
// exercised without a model. Message shapes are copied from opencode 2.0.32.
//
// Prompt words steer it: "tool" runs a read tool, "permission" asks before an
// edit (allowed: it completes; rejected: the turn ends cancelled, as in
// opencode), "fs" asks the client to read a file (the deck has no fs, so it
// expects -32601), "slow" streams until session/cancel, "crash" exits.
//
// FAKE_ACP_LOG=<file> appends every method it receives, so a test can check
// what arrived and in what order. FAKE_ACP_STUBBORN=1 ignores the end of stdin.
import fs from 'node:fs';

const log = (m) => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, m + '\n'); };
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

const sessions = new Map();   // sessionId -> { cwd, active, cancel }
let nextSession = 1;
let nextRequest = 0;          // agent -> client ids start at 0, as opencode's do
const waiting = new Map();    // our request id -> resolve(reply)

function ask(method, params) {
  const id = nextRequest++;
  out({ jsonrpc: '2.0', id, method, params });
  return new Promise(r => waiting.set(id, r));
}

const configOptions = (mode = 'build') => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake/model', options: [{ value: 'fake/model', name: 'Fake model' }] },
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
];

const methods = {
  initialize: (p) => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
    authMethods: [], agentInfo: { name: 'FakeACP', version: '0.0.1' }, _client: p.clientCapabilities,
  }),
  'session/new': ({ cwd }) => {
    if (!cwd?.startsWith('/')) throw Object.assign(new Error('cwd must be absolute'), { code: -32602 });
    const sessionId = `ses_fake_${nextSession++}`;
    sessions.set(sessionId, { cwd, active: false, cancel: null });
    return { sessionId, configOptions: configOptions() };
  },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    if (configId !== 'mode') throw Object.assign(new Error(`unknown config option: ${configId}`), { code: -32602 });
    return { configOptions: configOptions(value) };
  },
  'session/resume': ({ sessionId, cwd }) => {
    // The real agent keeps closed sessions on disk; this one takes any id back.
    if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd, active: false, cancel: null });
    return { configOptions: configOptions() };
  },
  'session/close': ({ sessionId }) => { sessions.delete(sessionId); return {}; },
  'session/prompt': (p) => prompt(p),
};

async function prompt({ sessionId, prompt: blocks }) {
  const s = sessions.get(sessionId);
  if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: -32602 });
  if (s.active) throw Object.assign(new Error(`Internal error: Session already has an active ACP prompt: ${sessionId}`), { code: -32603 });
  s.active = true;
  try {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (/crash/.test(text)) { process.stderr.write('fake-acp: crashed on purpose\n'); process.exit(3); }
    const msgId = `msg_${Date.now()}`;
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: `${msgId}:reasoning:0`, content: { type: 'text', text: 'Thinking about it.' } });
    let stopReason = 'end_turn';
    let reply = `Fake reply to: ${text}`;

    if (/slow/.test(text)) {
      const cancelled = new Promise(r => { s.cancel = r; });
      for (let i = 1; i <= 300; i++) {
        if (await Promise.race([cancelled.then(() => true), sleep(50).then(() => false)])) { stopReason = 'cancelled'; break; }
        update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: `${i}\n` } });
      }
      reply = '';
    }
    if (/tool/.test(text)) {
      const toolCallId = 'call_read_1', path = `${s.cwd}/README.md`;
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name: 'read', title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', kind: 'read', title: 'read', locations: [{ path }], rawInput: { filePath: path } });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', locations: [{ path }], content: [{ type: 'content', content: { type: 'text', text: '# Fake readme' } }] });
    }
    if (/permission/.test(text)) {
      const toolCallId = 'call_write_1', path = `${s.cwd}/hello.txt`;
      const toolCall = { toolCallId, name: 'write', title: path, kind: 'edit', status: 'pending', locations: [{ path }], rawInput: { path, content: 'hi' }, content: [{ type: 'diff', path, oldText: null, newText: 'hi' }] };
      update(sessionId, { sessionUpdate: 'tool_call', ...toolCall, title: 'write', locations: [], rawInput: {} });
      const r = await ask('session/request_permission', { sessionId, toolCall, options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ] });
      const allowed = r.result?.outcome?.outcome === 'selected' && r.result.outcome.optionId !== 'reject';
      if (allowed) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', locations: [{ path }], content: [{ type: 'content', content: { type: 'text', text: 'Created file successfully: hello.txt' } }] });
      else {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', kind: 'edit', locations: [{ path }], content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }] });
        stopReason = 'cancelled'; reply = '';
      }
    }
    if (/\bfs\b/.test(text)) {
      const r = await ask('fs/read_text_file', { sessionId, path: `${s.cwd}/README.md` });
      reply = `fs reply: ${r.error ? `error ${r.error.code}` : 'ok'}`;
    }

    if (reply) {
      // Two chunks of one message, the way a model streams.
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: reply.slice(0, 5) } });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: reply.slice(5) } });
    }
    update(sessionId, { sessionUpdate: 'usage_update', used: 8307, size: 65536, cost: { amount: 0, currency: 'USD' } });
    return { stopReason, usage: { inputTokens: 1919, outputTokens: 18, totalTokens: 8307 }, _meta: {} };
  } finally {
    s.active = false; s.cancel = null;
  }
}

async function onRequest({ id, method, params }) {
  const fn = methods[method];
  if (!fn) return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `"Method not found": ${method}`, data: { method } } });
  try { out({ jsonrpc: '2.0', id, result: await fn(params || {}) }); }
  catch (e) { out({ jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } }); }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log(msg.method || (msg.error ? 'error' : 'result'));
    if (msg.method && msg.id !== undefined) onRequest(msg);
    else if (msg.method === 'session/cancel') sessions.get(msg.params.sessionId)?.cancel?.();
    else if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  }
});
process.stdin.on('end', () => {
  log('eof');
  if (process.env.FAKE_ACP_STUBBORN) setInterval(() => {}, 1000);
  else process.exit(0);
});
