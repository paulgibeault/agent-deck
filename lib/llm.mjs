// lib/llm.mjs — transports for the deck's own one-shot model calls.
//
// `claude`: the Claude Code CLI (`claude -p`) with no tools, no MCP servers and
// no session persistence, so a call never writes a transcript the deck would
// then show as a session. Uses whatever login the CLI already has.
// `openai`: any OpenAI-compatible /chat/completions endpoint, e.g. the
// household llama-server behind the open-act tunnel.
//
// A transport's call({ system, prompt, model, thinking, timeoutMs, onRateLimit })
// resolves { text, costUsd } or rejects with an Error whose `.fatal` is true for
// failures retrying will not fix soon. Concurrency and accounting stay in Narrator.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Calls run with cwd = tmpdir, so a relative override must be resolved now.
export const BIN = process.env.DECK_CLAUDE_BIN
  ? (process.env.DECK_CLAUDE_BIN.includes('/') ? path.resolve(process.env.DECK_CLAUDE_BIN) : process.env.DECK_CLAUDE_BIN)
  : 'claude';
export const TIMEOUT_MS = 120_000;
// The household model, through the open-act tunnel.
const HOUSEHOLD_URL = 'http://127.0.0.1:8080/v1';
const HOUSEHOLD_MODEL = 'qwen3.6-35b-a3b';

// Variables a parent Claude Code session injects for its own children. If the
// deck is started from inside a session they would make the CLI try to reuse
// that host's auth channel instead of its own login.
const HOST_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION)$/;

export function childEnv() {
  const env = {};
  const hosted = !!process.env.CLAUDE_CODE_HOST_SESSION_ID;
  for (const [k, v] of Object.entries(process.env)) {
    if (HOST_ENV.test(k)) continue;
    if (hosted && k === 'ANTHROPIC_BASE_URL') continue;
    env[k] = v;
  }
  return env;
}

/**
 * Pull the final `result` message out of --output-format json (an array of
 * every message with --verbose, else just the result object), plus the
 * rate_limit_event the CLI sends with each call.
 */
function parseResult(stdout) {
  let d;
  try { d = JSON.parse(stdout); } catch { return null; }
  const rateLimit = Array.isArray(d) ? d.findLast(x => x?.type === 'rate_limit_event')?.rate_limit_info || null : null;
  if (Array.isArray(d)) d = d.findLast(x => x?.type === 'result') || d.at(-1);
  return d && typeof d === 'object' ? { ...d, rateLimit } : null;
}

export function claudeTransport() {
  return {
    name: 'claude', label: 'claude -p', defaultModel: null,
    async call({ system, prompt, model, thinking = true, timeoutMs = TIMEOUT_MS, onRateLimit }) {
      const out = await new Promise((resolve, reject) => {
        const args = ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--strict-mcp-config',
          '--output-format', 'json', '--verbose', '--system-prompt', system];
        if (!thinking) args.push('--settings', JSON.stringify({ alwaysThinkingEnabled: false }));
        let child;
        try { child = spawn(BIN, args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { return reject(Object.assign(new Error(`cannot start ${BIN}: ${e.message}`), { fatal: true })); }
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('model call timed out')); }, timeoutMs);
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(Object.assign(new Error(e.code === 'ENOENT' ? `${BIN} CLI not found on PATH (set DECK_CLAUDE_BIN)` : e.message), { fatal: true }));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const r = parseResult(stdout);
          if (!r) return reject(new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(0, 300) || 'no output'}`));
          if (r.rateLimit) { try { onRateLimit?.(r.rateLimit); } catch { /* a listener's problem */ } }
          if (r.is_error) {
            const msg = String(r.result || r.subtype || 'model call failed');
            return reject(Object.assign(new Error(msg), { fatal: /authenticat|login|oauth|api key|credit|billing/i.test(msg) }));
          }
          resolve(r);
        });
        child.stdin.end(prompt);
      });
      return { text: String(out.result ?? ''), costUsd: Number(out.total_cost_usd) || 0 };
    },
  };
}

/**
 * POST {url}/chat/completions. Reasoning models (Qwen) return their thinking in
 * a separate field; only `message.content` is the answer. An unreachable
 * endpoint is not fatal: a dropped tunnel comes back, and the narrator with it.
 */
export function openaiTransport({ url, model } = {}) {
  const base = String(url || HOUSEHOLD_URL).replace(/\/+$/, '');
  return {
    name: 'openai', label: `openai ${base}`, defaultModel: model || null,
    async call({ system, prompt, model: m, thinking = true, timeoutMs = TIMEOUT_MS }) {
      const body = { model: m || model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
      // llama-server's Qwen template honours this; other servers ignore it.
      if (!thinking) body.chat_template_kwargs = { enable_thinking: false };
      let res, d;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        d = await res.text();
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('model call timed out');
        throw new Error(`${base} unreachable: ${e.cause?.code || e.cause?.message || e.message}`);
      }
      let j = null;
      try { j = JSON.parse(d); } catch { /* reported below */ }
      if (!res.ok) {
        const msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || d.trim().slice(0, 300) || res.statusText;
        // Auth, billing, wrong URL or model: retrying soon won't help.
        throw Object.assign(new Error(`${base} HTTP ${res.status}: ${msg}`), { fatal: [401, 402, 403, 404].includes(res.status) });
      }
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error(`${base}: no message content in reply`);
      return { text, costUsd: Number(j.usage?.cost) || 0 };
    },
  };
}

/** DECK_LLM=openai|claude (default openai: the household model), DECK_LLM_URL, DECK_LLM_MODEL. */
export function transportFromEnv(env = process.env) {
  const kind = (env.DECK_LLM || 'openai').toLowerCase();
  if (kind === 'openai') return openaiTransport({ url: env.DECK_LLM_URL, model: env.DECK_LLM_MODEL || HOUSEHOLD_MODEL });
  if (kind !== 'claude') throw new Error(`DECK_LLM must be claude or openai, not ${env.DECK_LLM}`);
  return claudeTransport();
}
