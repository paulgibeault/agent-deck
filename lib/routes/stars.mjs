// lib/routes/stars.mjs — a session's stars and tags (lib/stars.mjs). Every
// change goes out live as `stars.changed`, so all tabs and devices agree.
//   GET    /api/sessions/:id/stars[?candidates=1]  { stars, candidates? }
//   PUT    /api/sessions/:id/stars/:key            body { tag, comment, excerpt, kind, ts } → { star }
//   DELETE /api/sessions/:id/stars/:key            → { removed }
import { starsFor, candidates } from '../stars.mjs';

const LIST = /^\/api\/sessions\/([^/]+)\/stars$/;
const ONE = /^\/api\/sessions\/([^/]+)\/stars\/([^/]+)$/;

const PRUNE_MS = 60 * 60_000;

export default function routes({ send, readBody, deck, index, agents, broadcast }) {
  const stars = () => starsFor(deck); // on first use: the route table also loads without a deck (tests)
  // A deleted session's stars go lazily: on a list, at most hourly, once the
  // index has scanned. Streamed sessions the deck launched count as known
  // before they reappear in the index.
  let prunedAt = 0;
  const prune = () => {
    if (!index?.files?.size || Date.now() - prunedAt < PRUNE_MS) return;
    prunedAt = Date.now();
    stars().prune(id => index.files.has(id) || index.agents?.has(id) || !!agents?.recordedHarness?.(id));
  };
  const ids = (m) => [decodeURIComponent(m[1]), m[2] != null ? decodeURIComponent(m[2]) : null];
  return [
    {
      method: 'GET', pattern: LIST,
      handler(req, res, { q, m }) {
        const [id] = ids(m);
        prune();
        const out = { stars: stars().list(id) };
        // Candidates need the session's events: only on request (wrap-up).
        if (q.get('candidates')) out.candidates = candidates(index?.load(id)?.state?.events);
        return send(res, 200, out);
      },
    },
    {
      method: 'PUT', pattern: ONE,
      async handler(req, res, { m }) {
        const [id, key] = ids(m);
        let star;
        try {
          const body = await readBody(req, 64 << 10);
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'the body must be a JSON object' });
          star = stars().put(id, key, body);
        }
        catch (e) { return send(res, e.code === 400 || e instanceof SyntaxError ? 400 : e.code || 500, { error: e.message }); }
        broadcast?.('stars.changed', { sessionId: id, key, star });
        return send(res, 200, { star });
      },
    },
    {
      method: 'DELETE', pattern: ONE,
      handler(req, res, { m }) {
        const [id, key] = ids(m);
        const removed = stars().remove(id, key);
        if (removed) broadcast?.('stars.changed', { sessionId: id, key, star: null });
        return send(res, 200, { removed });
      },
    },
  ];
}
