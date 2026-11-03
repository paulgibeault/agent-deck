// lib/routes/live.mjs — the live strip and hook runs (lib/live.mjs).
//   SSE `live`  { id, status, thinking, blocks: [{ type, name, text, chars, tokens }], at } | { id, gone: true }
//   GET /api/live → [ the same, for every session with something live ]  (a client that just connected)
import path from 'node:path';
import { Live } from '../live.mjs';

export default function routes({ send, deck, index, agents, broadcast }) {
  if (!index || !agents) return [];
  const live = new Live({ agents, index, dir: deck?.dir ? path.join(deck.dir, 'side') : null });
  // Sessions read before this module loaded have no side events yet; drop
  // the ones that should have, so their next load merges them in.
  for (const [id, e] of index.loaded || []) if (e.kind === 'session' && !index.pinned?.has(id) && live.read(id).length) index.loaded.delete(id);
  live.on('update', (v) => broadcast('live', v));
  return [{ method: 'GET', path: '/api/live', handler: (req, res) => send(res, 200, live.snapshot()) }];
}
