// lib/routes/models.mjs — the Models dialog: which backend and model each
// request class runs on, backend health, and a Test call per class.
// Routes persist in deck state (ns 'models'); attaching it here keeps
// server.mjs out of it.

import { hasClass } from '../narrator.mjs';

const TEST_SYSTEM = 'You are a connectivity check. Reply with one short line.';
const TEST_PROMPT = 'Say hello in five words or fewer.';

export default function routes({ send, readBody, deck, narrator, narratorEnabled = true }) {
  if (!narrator || !deck) return [];   // a context without the model services (route-table tests)
  narrator.useState(deck.ns('models'));
  const view = () => ({ enabled: narratorEnabled, ...narrator.view() });
  const fail = (res, e) => send(res, e.code === 413 ? 413 : 400, { error: e.message });
  return [
    {
      // Opening the dialog checks the local server is reachable (GET /v1/models, not a model call).
      method: 'GET', path: '/api/models',
      async handler(req, res, { q }) {
        if (q.get('probe') !== '0') await narrator.probe().catch(() => null);
        return send(res, 200, view());
      },
    },
    {
      method: 'POST', path: '/api/models/route',
      async handler(req, res) {
        try { const b = await readBody(req); narrator.setRoute(String(b.class || ''), b); }
        catch (e) { return fail(res, e); }
        return send(res, 200, view());
      },
    },
    {
      method: 'POST', path: '/api/models/everything-claude',
      async handler(req, res) {
        try { const b = await readBody(req); narrator.setAllClaude(!!b.on); }
        catch (e) { return fail(res, e); }
        return send(res, 200, view());
      },
    },
    {
      // An explicit ask: one tiny call on the class's route, fallback and all.
      method: 'POST', path: '/api/models/test',
      async handler(req, res) {
        if (!narratorEnabled) return send(res, 409, { error: 'model calls are off (started with --no-narrator)' });
        let cls;
        try { cls = String((await readBody(req)).class || ''); } catch (e) { return fail(res, e); }
        if (!hasClass(cls)) return send(res, 400, { error: `unknown request class: ${cls}` });
        const started = Date.now();
        try {
          // Tagged so the class's own usage and cost stay what the deck spent; health still learns from it.
          const r = await narrator.run({ system: TEST_SYSTEM, prompt: TEST_PROMPT, purpose: `test:${cls}` });
          return send(res, 200, { ok: true, ms: Date.now() - started, line: String(r.text).trim().split('\n')[0].slice(0, 200),
            transport: r.transport, model: r.model, fellBack: r.fellBack, fallbackReason: r.fallbackReason || null, costUsd: r.costUsd, models: view() });
        } catch (e) {
          return send(res, 200, { ok: false, ms: Date.now() - started, error: e.message, fatal: !!e.fatal, models: view() });
        }
      },
    },
  ];
}
