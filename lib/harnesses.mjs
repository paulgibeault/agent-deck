// lib/harnesses.mjs — which agents the deck can launch: <state dir>/harnesses.json
// (optional) → one driver per harness. Without the file the deck offers
// Claude Code and opencode, with opencode (the household model) first:
//
//   { "default": "opencode",
//     "harnesses": {
//       "claude":   { "type": "claude", "bin": "claude" },
//       "opencode": { "type": "acp", "bin": "opencode", "args": ["acp"], "label": "opencode · household" } } }
//
// Adding another ACP agent (Gemini CLI, say) is an entry here, not code.
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeDriver, BIN } from './harness/claude.mjs';
import { AcpDriver } from './harness/acp.mjs';

export const DEFAULT_HARNESSES = {
  default: 'opencode',
  harnesses: {
    claude: { type: 'claude', bin: BIN, label: 'Claude Code' },
    opencode: { type: 'acp', bin: 'opencode', args: ['acp'], label: 'opencode · household' },
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
    else if (h.type === 'acp' && bin) drivers[name] = new AcpDriver({ bin, args: h.args || [], label: h.label || name });
    else console.error(`agent-deck: harness ${name}: unknown type ${h.type}`);
  }
  if (!Object.keys(drivers).length) return loadHarnesses(null);
  return { drivers, defaultHarness: drivers[cfg.default] ? cfg.default : Object.keys(drivers)[0] };
}
