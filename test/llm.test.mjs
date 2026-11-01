import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openaiTransport, transportsFromEnv, tunnelTrouble } from '../lib/llm.mjs';
import { Narrator } from '../lib/narrator.mjs';

/** A tiny OpenAI-compatible server: `handle(body, res)` answers each POST. */
async function fakeServer(handle) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { const body = JSON.parse(b || '{}'); seen.push({ url: req.url, body }); handle(body, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1`;
  return { url, seen, close: () => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); } };
}

const json = (res, status, d) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
const reply = (content, extra = {}) => ({ choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'thinking out loud' } }], ...extra });

test('openai transport: system + user messages, content only, thinking off, models from DECK_LLM_MODEL', async () => {
  const s = await fakeServer((body, res) => json(res, 200, reply('The brief.')));
  try {
    const n = new Narrator({ llm: openaiTransport({ url: s.url + '/', model: 'qwen-test' }) });
    assert.equal(n.briefModel, 'qwen-test');
    assert.equal(n.askModel, 'qwen-test');
    const r = await n.run({ system: 'sys', prompt: 'hello', model: n.briefModel, thinking: false, purpose: 'brief' });
    assert.equal(r.text, 'The brief.', 'reasoning_content is not the answer');
    assert.equal(r.costUsd, 0, 'no usage, no cost');
    assert.equal(s.seen[0].url, '/v1/chat/completions');
    assert.deepEqual(s.seen[0].body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
    assert.equal(s.seen[0].body.model, 'qwen-test');
    assert.deepEqual(s.seen[0].body.chat_template_kwargs, { enable_thinking: false });
    const st = n.status();
    assert.equal(st.llm, 'openai');
    assert.match(st.llmLabel, /127\.0\.0\.1/);
    assert.equal(st.byPurpose.brief.calls, 1);
  } finally { await s.close(); }
});

test('openai transport: cost comes from usage when the server reports one', async () => {
  const s = await fakeServer((body, res) => json(res, 200, reply('ok', { usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0042 } })));
  try {
    const n = new Narrator({ llm: openaiTransport({ url: s.url, model: 'm' }) });
    const r = await n.run({ system: 's', prompt: 'p', model: 'm', purpose: 'ask' });
    assert.equal(r.costUsd, 0.0042);
    assert.equal(n.status().totalCostUsd, 0.0042);
    assert.equal(s.seen[0].body.chat_template_kwargs, undefined, 'thinking left to the model by default');
  } finally { await s.close(); }
});

test('openai transport: HTTP 500 is an error but not fatal; 401 is fatal', async () => {
  let status = 500;
  const s = await fakeServer((body, res) => json(res, status, { error: { message: status === 500 ? 'slot busy' : 'bad key' } }));
  try {
    const n = new Narrator({ llm: openaiTransport({ url: s.url, model: 'm' }) });
    await assert.rejects(n.run({ system: 's', prompt: 'p', model: 'm' }), (e) => /HTTP 500: slot busy/.test(e.message) && !e.fatal);
    assert.equal(n.blocked(), false);
    status = 401;
    await assert.rejects(n.run({ system: 's', prompt: 'p', model: 'm' }), (e) => /HTTP 401: bad key/.test(e.message) && e.fatal);
    assert.equal(n.blocked(), true, 'auth failures pause scheduled calls');
  } finally { await s.close(); }
});

test('openai transport: a refused connection is retryable, so a dropped tunnel does not disable the narrator', async () => {
  const s = await fakeServer(() => {});
  const url = s.url;
  await s.close();
  // No open-act client here, whatever this machine has.
  const n = new Narrator({ llm: openaiTransport({ url, model: 'm', tunnelConf: path.join(os.tmpdir(), 'deck-no-open-act.conf') }) });
  await assert.rejects(n.run({ system: 's', prompt: 'p', model: 'm' }), (e) => /unreachable: ECONNREFUSED/.test(e.message) && !e.fatal);
  assert.equal(n.blocked(), false);
  assert.equal(n.status().error.fatal, false);
});

test('openai transport: a refused connection on the open-act tunnel port says the tunnel is down', async () => {
  const s = await fakeServer(() => {});
  const url = s.url;
  await s.close();
  const conf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-llm-')), 'client.conf');
  fs.writeFileSync(conf, `# comment\nNODE_HOST=gpu-node.example\nLOCAL_PORT=${new URL(url).port}\nMODEL2_ID=x\n`);
  const n = new Narrator({ llm: openaiTransport({ url, model: 'm', tunnelConf: conf }) });
  await assert.rejects(n.run({ system: 's', prompt: 'p', model: 'm' }), (e) => /open-act tunnel to gpu-node\.example is down/.test(e.message) && /heal-tunnel\.sh/.test(e.message) && !e.fatal);
});

test('tunnelTrouble: a dropped connection means the node\'s model is down; other ports and hosts are not the tunnel', () => {
  const conf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-llm-')), 'client.conf');
  fs.writeFileSync(conf, 'NODE_HOST=gpu-node.example\nLOCAL_PORT=8080   # forwarded\n');
  const down = tunnelTrouble('http://127.0.0.1:8080/v1', 'UND_ERR_SOCKET', conf);
  assert.match(down, /model server on gpu-node\.example is not answering/);
  assert.doesNotMatch(down, /open-act tunnel/, 'healing the tunnel cannot fix this, so the heal button stays away');
  assert.match(tunnelTrouble('http://[::1]:8080/v1', 'ECONNREFUSED', conf), /tunnel to gpu-node\.example is down/);
  assert.equal(tunnelTrouble('http://127.0.0.1:9999/v1', 'ECONNREFUSED', conf), null);
  assert.equal(tunnelTrouble('http://example.com:8080/v1', 'ECONNREFUSED', conf), null);
  assert.equal(tunnelTrouble('http://127.0.0.1:8080/v1', 'ECONNREFUSED', conf + '.missing'), null, 'no open-act client, no hint');
  // No LOCAL_PORT: 8080, as heal-tunnel.sh assumes; a URL without a port is not that.
  fs.writeFileSync(conf, 'NODE_HOST=gpu-node.example\n');
  assert.match(tunnelTrouble('http://127.0.0.1:8080/v1', 'ECONNREFUSED', conf), /is down/);
  assert.equal(tunnelTrouble('http://localhost/v1', 'ECONNREFUSED', conf), null);
});

test('openai transport: a slow server times out, non-fatal, and frees its slot', async () => {
  const s = await fakeServer(() => { /* never answers */ });
  try {
    const n = new Narrator({ llm: openaiTransport({ url: s.url, model: 'm' }), timeoutMs: 100 });
    await assert.rejects(n.run({ system: 's', prompt: 'p', model: 'm' }), (e) => e.message === 'model call timed out' && !e.fatal);
    assert.equal(n.active, 0);
  } finally { await s.close(); }
});

test('Narrator: one local call in flight by default, two with DECK_LLM_CONCURRENCY=2', async () => {
  let inFlight = 0, peak = 0;
  const s = await fakeServer((body, res) => { inFlight++; peak = Math.max(peak, inFlight); setTimeout(() => { inFlight--; json(res, 200, reply('ok')); }, 30); });
  try {
    const n = new Narrator({ llm: openaiTransport({ url: s.url, model: 'm' }) });
    await Promise.all([1, 2, 3].map(() => n.run({ system: 's', prompt: 'p', model: 'm' })));
    assert.equal(peak, 1, 'the local server may serve one request at a time');
    peak = 0;
    const n2 = new Narrator({ llm: openaiTransport({ url: s.url, model: 'm' }), env: { DECK_LLM_CONCURRENCY: '2' } });
    await Promise.all([1, 2, 3, 4, 5].map(() => n2.run({ system: 's', prompt: 'p', model: 'm' })));
    assert.equal(peak, 2);
    assert.equal(n2.calls, 5);
  } finally { await s.close(); }
});

test('transportsFromEnv: the household model by default; DECK_LLM picks the first-run backend for every class', () => {
  const h = transportsFromEnv({}).local;
  assert.equal(h.name, 'openai');
  assert.equal(h.label, 'openai http://127.0.0.1:8080/v1');
  assert.equal(h.defaultModel, 'qwen3.6-35b-a3b');
  const t = transportsFromEnv({ DECK_LLM_URL: 'http://h:1/v1', DECK_LLM_MODEL: 'q' }).local;
  assert.equal(t.defaultModel, 'q');
  assert.equal(transportsFromEnv({}).claude.name, 'claude');
  const env = { DECK_LLM: 'claude' };
  assert.equal(new Narrator({ transports: transportsFromEnv(env), env }).briefModel, 'haiku');
  assert.equal(new Narrator({ transports: transportsFromEnv({}), env: {} }).effective('brief').transport, 'local');
  assert.throws(() => new Narrator({ transports: transportsFromEnv({}), env: { DECK_LLM: 'gpt' } }), /claude or openai/);
});
