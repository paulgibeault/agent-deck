#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json --output-format
// stream-json` so deck-launched sessions can be exercised without a model
// login: DECK_AGENT_BIN=<this file>. Writes a small transcript where the real
// CLI would, and speaks the same stdout protocol the deck reads.
//
// Prompt words steer it: "permission" asks to run a Bash command first,
// "slow" works for 60s (interruptible), "crash" exits with an error, "fail"
// ends the turn on a failed tool call, "background agent" starts a subagent
// (task afake0001) that runs until stop_task stops it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const id = opt('--session-id') || opt('--resume') || randomUUID();
const mode = opt('--permission-mode') || 'default';
const model = opt('--model') || 'fake-model';
const cwd = process.cwd();
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${id}.jsonl`);

let parent = null;
let cost = 0;
const now = () => new Date().toISOString();
const base = () => ({ isSidechain: false, cwd, sessionId: id, version: 'fake', gitBranch: 'main', timestamp: now() });
function record(rec) {
  const uuid = randomUUID();
  fs.appendFileSync(file, JSON.stringify({ parentUuid: parent, ...base(), uuid, ...rec }) + '\n');
  parent = uuid;
}
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

out({ type: 'system', subtype: 'init', session_id: id, cwd, model, permissionMode: mode, tools: ['Bash'] });

const waiting = new Map();   // request_id -> resolve
const tasks = new Set();     // running background subagents
let interrupt = null;
let busy = Promise.resolve();
// Turns run one after another, so a turn can still be waiting to start when
// its interrupt arrives (Send now writes both at once). Like the real CLI,
// that interrupt applies to the turn that is starting, not to nothing.
let pending = 0, earlyInterrupt = false;

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'control_response') waiting.get(msg.response.request_id)?.(msg.response.response);
    else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
      if (interrupt) interrupt(); else if (pending) earlyInterrupt = true;
    } else if (msg.type === 'control_request' && msg.request.subtype === 'stop_task') {
      const tid = msg.request.task_id;
      if (!tasks.has(tid)) { out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `No task found with ID: ${tid}` } }); continue; }
      tasks.delete(tid);
      out({ type: 'system', subtype: 'task_updated', task_id: tid, patch: { status: 'killed' } });
      out({ type: 'system', subtype: 'task_notification', task_id: tid, status: 'stopped', summary: 'stopped' });
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else if (msg.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported control request subtype: ${msg.request.subtype}` } });
    } else if (msg.type === 'user') { pending++; busy = busy.then(() => turn(msg.message.content)).finally(() => { pending--; }); }
  }
});
process.stdin.on('end', () => busy.then(() => process.exit(0)));

async function turn(content) {
  // Attachments arrive as content blocks; the words steer, the rest is counted.
  const blocks = Array.isArray(content) ? content : null;
  const text = blocks ? blocks.filter(b => b.type === 'text' && !b.text.startsWith('Attached file ')).map(b => b.text).join('\n') : String(content);
  const files = blocks ? blocks.length - blocks.filter(b => b.type === 'text' && !b.text.startsWith('Attached file ')).length : 0;
  fs.appendFileSync(file, JSON.stringify({ type: 'last-prompt', lastPrompt: text, sessionId: id }) + '\n');
  record({ type: 'user', message: { role: 'user', content } });
  const started = Date.now();
  let reply = `Fake reply to: ${text}${files ? ` (with ${files} attachment${files === 1 ? '' : 's'})` : ''}`;
  if (/crash/.test(text)) { process.stderr.write('fake-agent: crashed on purpose\n'); process.exit(3); }
  if (/permission/.test(text)) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { command: 'rm -rf build', description: 'Clean the build folder' };
    record({ type: 'assistant', message: { model, id: `msg_${toolUseId}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }] } });
    const requestId = randomUUID();
    const answer = await new Promise((resolve) => {
      waiting.set(requestId, resolve);
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: input.description, tool_use_id: toolUseId, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'session' }] } });
    });
    waiting.delete(requestId);
    const ok = answer.behavior === 'allow';
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: ok ? '(no output)' : answer.message, is_error: !ok }] } });
    reply = ok ? `Cleaned the build folder${answer.updatedPermissions ? ' (and will not ask again)' : ''}.` : `Understood, I left the build folder alone.`;
  }
  // "fail" ends the turn on a failed tool call, with nothing after it.
  if (/fail/.test(text)) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    record({ type: 'assistant', message: { model, id: `msg_${toolUseId}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'npm test' } }] } });
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '3 tests failed', is_error: true }] } });
    reply = null;
  }
  if (/background agent/.test(text)) {
    tasks.add('afake0001');
    out({ type: 'system', subtype: 'task_started', task_id: 'afake0001', task_type: 'local_agent', description: 'Fake helper', is_backgrounded: true });
    out({ type: 'system', subtype: 'task_progress', task_id: 'afake0001', description: 'Running Fake step' });
  }
  let interrupted = false;
  if (/slow/.test(text)) {
    interrupted = earlyInterrupt || await new Promise((resolve) => { interrupt = () => resolve(true); setTimeout(() => resolve(false), 60_000); });
    interrupt = null;
  } else await sleep(400);
  earlyInterrupt = false;
  if (interrupted) record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  else if (reply) record({ type: 'assistant', message: { model, id: `msg_${randomUUID().slice(0, 8)}`, role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } });
  cost += 0.001;
  out({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: false, duration_ms: Date.now() - started, total_cost_usd: cost, stop_reason: interrupted ? null : 'end_turn', session_id: id, result: interrupted ? '' : reply });
}
