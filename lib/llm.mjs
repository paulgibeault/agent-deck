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
// failures retrying will not fix soon, and `.unreachable` / `.timeout` when no
// answer came back at all (Narrator falls back to Claude on those, never on a
// bad answer). Concurrency, routing and accounting stay in Narrator.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
// Written by the open-act client bootstrap: NODE_HOST, LOCAL_PORT, ...
const TUNNEL_CONF = path.join(os.homedir(), '.config', 'open-act', 'client.conf');

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
export function openaiTransport({ url, model, tunnelConf = TUNNEL_CONF } = {}) {
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
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw Object.assign(new Error('model call timed out'), { timeout: true });
        const code = e.cause?.code || e.cause?.message || e.message;
        throw Object.assign(new Error(tunnelTrouble(base, code, tunnelConf) || `${base} unreachable: ${code}`), { unreachable: true, code });
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
    /**
     * GET {url}/models: is the server there, and what does it serve. Not a
     * model call, so the Models dialog may run it when it opens.
     */
    async probe({ timeoutMs = 3000 } = {}) {
      const started = Date.now();
      try {
        const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
        const j = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, ms: Date.now() - started, models: [], error: `${base} HTTP ${res.status}` };
        const models = (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []).map(m => m?.id || m?.name || m?.model).filter(x => typeof x === 'string');
        return { ok: true, ms: Date.now() - started, models: [...new Set(models)], error: null };
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ok: false, ms: Date.now() - started, models: [], error: `${base} did not answer in ${timeoutMs / 1000}s` };
        const code = e.cause?.code || e.cause?.message || e.message;
        return { ok: false, ms: null, models: [], error: tunnelTrouble(base, code, tunnelConf) || `${base} unreachable: ${code}` };
      }
    },
  };
}

/**
 * When `base` is the open-act tunnel's local end, what a failed connection says
 * about it, or null. Nothing listening means the tunnel is down; a connection
 * the tunnel accepts and then drops means it is up but the node's model server
 * is not answering.
 */
export function tunnelTrouble(base, code, confFile = TUNNEL_CONF) {
  const conf = readConf(confFile);
  if (!conf) return null;
  let u;
  try { u = new URL(base); } catch { return null; }
  // The tunnel's local end; heal-tunnel.sh assumes 8080 when the conf does not say.
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!LOOPBACK.includes(u.hostname) || port !== String(conf.LOCAL_PORT || '8080')) return null;
  const node = conf.NODE_HOST || 'the node';
  if (code === 'ECONNREFUSED') return `the open-act tunnel to ${node} is down (nothing on ${u.host}). Heal it with the plug button or scripts/heal-tunnel.sh`;
  // Worded so the heal button (it looks for "open-act tunnel") stays away: healing cannot fix this.
  if (/ECONNRESET|UND_ERR_SOCKET|other side closed/i.test(code)) return `the model server on ${node} is not answering (${code} through the tunnel on ${u.host}, which is up)`;
  return null;
}
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** KEY=value lines, as the open-act bootstrap writes them (# starts a comment); null if unreadable. */
function readConf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

/** Both backends, as the Narrator's transport pool: `claude` and `local`. */
export function transportsFromEnv(env = process.env) {
  return { claude: claudeTransport(), local: openaiTransport({ url: env.DECK_LLM_URL, model: env.DECK_LLM_MODEL || HOUSEHOLD_MODEL }) };
}
