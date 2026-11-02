// lib/routes/gh.mjs — GitHub state for the chips (lib/ghstate.mjs), asked by
// the page's poll (public/ghchips.js) for whatever it has on screen.
//   GET  /api/gh/state?k=owner/repo#12,owner/repo%3,...  { items: { key: info|null }, gh, rateLimited, retryAfter }
//        ETag'd: an unchanged answer is a 304, so a steady poll costs the page nothing.
//   GET  /api/gh/fixci?repo=owner/repo&number=12            { prompt }: failing checks and log tails, size-capped
//   POST /api/gh/seen  body { sessionId, key, activity }    the pilot looked at a PR's reviews
//   POST /api/gh/merged body { sessionId, key }             { first }: a session's own PR merged; news only once
import { createHash } from 'node:crypto';
import { parseKey, keyOf, fixCiPrompt, logTail } from '../ghstate.mjs';

const MAX_KEYS = 100;
const MAX_LOGS = 3;
const SEEN_KEEP = 300;

export default function routes({ send, readBody, deck, index, github, scheduleSnapshot }) {
  // Review activity the pilot has looked at, kept across restarts.
  if (github && deck) {
    const ns = () => deck.ns('gh');
    github.seen = {
      get: (k) => ns().get('seen', {})[k],
      set: (k, n) => {
        const seen = ns().get('seen', {});
        delete seen[k]; seen[k] = n;
        const keys = Object.keys(seen);
        for (const old of keys.slice(0, Math.max(0, keys.length - SEEN_KEEP))) delete seen[old];
        ns().set('seen', seen);
      },
    };
  }
  const state = () => github?.state;
  return [
    {
      method: 'GET', path: '/api/gh/state',
      async handler(req, res, { q }) {
        const items = String(q.get('k') || '').split(',').map(parseKey).filter(Boolean).slice(0, MAX_KEYS);
        const out = state() ? await state().fetch(items) : { items: {}, gh: false, rateLimited: false, retryAfter: 0 };
        const body = JSON.stringify(out);
        const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end(body);
      },
    },
    {
      method: 'GET', path: '/api/gh/fixci',
      async handler(req, res, { q }) {
        const it = { kind: 'ref', repo: q.get('repo') || '', number: Number(q.get('number')) };
        const key = keyOf(it);
        if (!parseKey(key)) return send(res, 400, { error: 'repo (owner/name) and number are needed' });
        if (!state()) return send(res, 503, { error: 'gh is not available' });
        const { items } = await state().fetch([it], { maxAge: 5_000 });
        const pr = items[key];
        if (!pr || pr.kind !== 'pr') return send(res, 404, { error: 'no such pull request (or gh could not say)' });
        // One log per Actions run: several failing jobs often share one.
        const byRun = new Map();
        for (const f of pr.fails) if (f.runId && !byRun.has(f.runId)) byRun.set(f.runId, f);
        const runs = [...byRun.values()].slice(0, MAX_LOGS);
        const logs = await Promise.all(runs.map(async (f) => ({ name: f.name, runId: f.runId, text: logTail(await state().failedLog(pr.repo, f.runId)) })));
        return send(res, 200, { prompt: fixCiPrompt({ repo: pr.repo, number: pr.number, title: pr.title, branch: pr.head, fails: pr.fails, logs }) });
      },
    },
    {
      method: 'POST', path: '/api/gh/seen',
      async handler(req, res) {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const it = parseKey(body?.key);
        if (!it || !github) return send(res, 400, { error: 'key (owner/repo#N) is needed' });
        // What the pilot saw, else what the deck knows now.
        const n = Number.isFinite(body.activity) ? body.activity : state()?.cache.get(keyOf(it))?.value?.activity;
        if (Number.isFinite(n)) github.seen?.set(keyOf(it), n);
        if (body.sessionId && index?.files?.has(body.sessionId)) { index.refresh(body.sessionId); scheduleSnapshot?.(); }
        return send(res, 200, { ok: true });
      },
    },
    {
      // The page saw a session's own PR merged: { first } says whether that is news, so a
      // reload does not announce a merge again. Kept per session beside `seen`.
      method: 'POST', path: '/api/gh/merged',
      async handler(req, res) {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const it = parseKey(body?.key);
        if (!it || typeof body.sessionId !== 'string' || !body.sessionId) return send(res, 400, { error: 'sessionId and key (owner/repo#N) are needed' });
        if (!deck) return send(res, 200, { first: true });
        const ns = deck.ns('gh');
        const all = ns.get('merged', {});
        const list = all[body.sessionId] || [];
        if (list.includes(keyOf(it))) return send(res, 200, { first: false });
        delete all[body.sessionId];
        all[body.sessionId] = [...list, keyOf(it)];
        const ids = Object.keys(all);
        for (const old of ids.slice(0, Math.max(0, ids.length - SEEN_KEEP))) delete all[old];
        ns.set('merged', all);
        return send(res, 200, { first: true });
      },
    },
  ];
}
