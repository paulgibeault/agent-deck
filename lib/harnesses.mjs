// lib/harnesses.mjs — which agents the deck can launch: <state dir>/harnesses.json
// (optional) → one driver per harness. Without the file the deck offers
// Claude Code and opencode, with opencode (the household model) first:
//
//   { "default": "opencode",
//     "harnesses": {
//       "claude":   { "type": "claude", "bin": "claude" },
//       "opencode": { "type": "acp", "bin": "opencode", "args": ["acp"], "label": "opencode · household",
//                     "resume": "opencode -s {id}" } } }
//
// `resume` is the terminal command that reopens a session ({id} for its id);
// `actor` the agent's short name in the UI (default: the label's first word).
// `backend` says where the model runs, which the UI shows on every session:
// local | anthropic | google | openai | other, with an optional `backendLabel`.
// Without it: claude → anthropic, opencode → local (the household model),
// gemini → google, codex → openai.
// Adding another ACP agent (Gemini CLI, say) is an entry here, not code.
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeDriver, BIN } from './harness/claude.mjs';
import { AcpDriver } from './harness/acp.mjs';

export const BACKENDS = { local: 'Local', anthropic: 'Claude Code', google: 'Google', openai: 'OpenAI', other: 'Other' };
const BIN_BACKEND = { claude: 'anthropic', opencode: 'local', gemini: 'google', codex: 'openai' };

/** Where a harness's model runs: { kind, label }. */
export function backendOf(h, name) {
  const kind = BACKENDS[h.backend] ? h.backend : h.type === 'claude' ? 'anthropic' : BIN_BACKEND[path.basename(String(h.bin || ''))] || BIN_BACKEND[name] || 'other';
  return { kind, label: h.backendLabel || (kind === 'other' ? h.label || name : BACKENDS[kind]) };
}

export const DEFAULT_HARNESSES = {
  default: 'opencode',
  harnesses: {
    claude: { type: 'claude', bin: BIN, label: 'Claude Code' },
    opencode: { type: 'acp', bin: 'opencode', args: ['acp'], label: 'opencode · household', resume: 'opencode -s {id}' },
  },
};

/** Read the config (defaults if absent or broken) and build the drivers. */
export function loadHarnesses(dir) {
  let cfg = DEFAULT_HARNESSES;
  const file = dir ? path.join(dir, 'harnesses.json') : null;
  if (file) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.error(`agent-deck: ignoring ${file}: ${e.message}`); }
  }
  const drivers = {};
  for (const [name, h] of Object.entries(cfg.harnesses || {})) {
    // Relative bins (test fixtures) are relative to where the deck was started.
    const bin = h.bin && h.bin.includes('/') ? path.resolve(h.bin) : h.bin;
    if (h.type === 'claude') drivers[name] = new ClaudeDriver({ bin: bin || BIN, label: h.label || name });
    else if (h.type === 'acp' && bin) {
      // opencode reopens a session with -s; another agent's command comes from its entry.
      const resumeCommand = h.resume ?? (path.basename(bin) === 'opencode' ? `${h.bin} -s {id}` : null);
      drivers[name] = new AcpDriver({ bin, args: h.args || [], label: h.label || name, actor: h.actor, resumeCommand });
    }
    else { console.error(`agent-deck: harness ${name}: unknown type ${h.type}`); continue; }
    drivers[name].backend = backendOf(h, name);
  }
  if (!Object.keys(drivers).length) return loadHarnesses(null);
  return { drivers, defaultHarness: drivers[cfg.default] ? cfg.default : Object.keys(drivers)[0] };
}
