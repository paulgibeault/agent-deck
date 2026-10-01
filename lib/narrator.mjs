// lib/narrator.mjs — one-shot model calls through the Claude Code CLI.
//
// `claude -p` with no tools, no MCP servers and no session persistence, so a
// call never writes a transcript the deck would then show as a session. Uses
// whatever login the CLI already has; no API key handling here.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Calls run with cwd = tmpdir, so a relative override must be resolved now.
const BIN = process.env.DECK_CLAUDE_BIN
  ? (process.env.DECK_CLAUDE_BIN.includes('/') ? path.resolve(process.env.DECK_CLAUDE_BIN) : process.env.DECK_CLAUDE_BIN)
  : 'claude';
const TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 2;

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

/** Pull the final `result` message out of --output-format json (object or array). */
function parseResult(stdout) {
  let d;
  try { d = JSON.parse(stdout); } catch { return null; }
  if (Array.isArray(d)) d = d.findLast(x => x?.type === 'result') || d.at(-1);
  return d && typeof d === 'object' ? d : null;
}

export class Narrator {
  constructor({ briefModel, askModel } = {}) {
    this.briefModel = briefModel || process.env.DECK_BRIEF_MODEL || 'haiku';
    this.askModel = askModel || process.env.DECK_ASK_MODEL || 'sonnet';
    this.active = 0;
    this.waiting = [];
    this.totalCostUsd = 0;
    this.calls = 0;
    this.lastError = null;     // { message, at, auth }
  }

  /** True while a recent auth/CLI failure says scheduled calls are pointless. */
  blocked(now = Date.now()) {
    return !!(this.lastError?.fatal && now - this.lastError.at < 5 * 60_000);
  }

  async _slot() {
    if (this.active < MAX_CONCURRENT) { this.active++; return; }
    await new Promise(r => this.waiting.push(r));
    this.active++;
  }
  _release() { this.active--; this.waiting.shift()?.(); }

  /**
   * Run one prompt. Resolves { text, costUsd, durationMs } or rejects with an
   * Error whose `.fatal` is true for failures retrying will not fix soon.
   */
  async run({ system, prompt, model }) {
    await this._slot();
    const started = Date.now();
    try {
      const out = await new Promise((resolve, reject) => {
        const args = ['-p', '--model', model, '--no-session-persistence', '--tools', '', '--strict-mcp-config',
          '--output-format', 'json', '--system-prompt', system];
        let child;
        try { child = spawn(BIN, args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (e) { return reject(Object.assign(new Error(`cannot start ${BIN}: ${e.message}`), { fatal: true })); }
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('model call timed out')); }, TIMEOUT_MS);
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
          if (r.is_error) {
            const msg = String(r.result || r.subtype || 'model call failed');
            return reject(Object.assign(new Error(msg), { fatal: /authenticat|login|oauth|api key|credit|billing/i.test(msg) }));
          }
          resolve(r);
        });
        child.stdin.end(prompt);
      });
      const costUsd = Number(out.total_cost_usd) || 0;
      this.totalCostUsd += costUsd;
      this.calls++;
      this.lastError = null;
      return { text: String(out.result ?? ''), costUsd, durationMs: Date.now() - started };
    } catch (e) {
      this.lastError = { message: e.message, at: Date.now(), fatal: !!e.fatal };
      throw e;
    } finally {
      this._release();
    }
  }

  status() {
    return { briefModel: this.briefModel, askModel: this.askModel, totalCostUsd: this.totalCostUsd, calls: this.calls,
      error: this.lastError ? { message: this.lastError.message, at: this.lastError.at, fatal: this.lastError.fatal } : null };
  }
}

/** First JSON object in a model reply (tolerates code fences and prose). */
export function extractJson(text) {
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
