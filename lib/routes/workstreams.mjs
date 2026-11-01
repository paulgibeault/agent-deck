// lib/routes/workstreams.mjs — the workstreams API (lib/workstreams.mjs), the
// first-use setup of its private repo, and which session belongs to which
// workstream. That mapping is live deck state (deck.ns('workstreams'):
// session id → slug, so a session has at most one); wrap-up (#36) makes it durable.
// DECK_GH names the gh binary (tests and sandboxed runs point it at a stand-in).
import path from 'node:path';
import { storeFor, runner } from '../workstreams.mjs';

/** The deck's workstreams store; lib/routes/attach.mjs shares it. */
export const deckStore = (deck) => storeFor(path.join(deck.dir, 'workstreams'), { gh: runner(process.env.DECK_GH || 'gh') });

export default function routes({ send, readBody, deck, index, broadcast, scheduleSnapshot }) {
  if (!deck) return [];
  const store = deckStore(deck);
  const live = deck.ns('workstreams');
  store.on('changed', (e) => broadcast?.('workstreams.changed', e));
  store.resume().catch(() => {});

  // Errors carry an HTTP code (and the conflict or dirty clone, when that's why).
  const wrap = (fn) => async (req, res, ctx) => {
    try { return await fn(req, res, ctx); }
    catch (e) { return send(res, Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message, ...(e.conflict ? { conflict: e.conflict } : {}), ...(e.dirty ? { dirty: e.dirty } : {}) }); }
  };
  const slugOf = (m) => decodeURIComponent(m[1]);

  // A mapping whose session is gone (deleted) is left in state but not counted; unassigning it still works.
  const known = (id) => !index || !!index.summary(id);
  const isLive = (id) => index?.summary(id)?.bucket === 'active' && !deck.hidden.has(id);
  /** Sessions per workstream: all assigned, and those live now. */
  function counts() {
    const out = {};
    for (const id of live.keys().filter(known)) {
      const slug = live.get(id);
      const c = out[slug] ||= { sessions: 0, live: 0 };
      c.sessions++;
      if (isLive(id)) c.live++;
    }
    return out;
  }
  const sessionsOf = (slug) => live.keys().filter(id => live.get(id) === slug && known(id));
  /** The few fields a Home card shows, and its quiet counts; the full record stays behind GET /:slug. */
  function cardOf(slug) {
    const w = store.get(slug);
    if (!w) return {};
    return { goal: w.goal || '', next: w.next || '', pinned: w.pinned || [], links: w.links,
      counts: { decisions: w.decisions.filter(d => (d.status || 'active') === 'active').length, notes: (w.notes.match(/^- /gm) || []).length,
        files: w.files.length, records: w.records.length, vault: w.vault.length } };
  }

  return [
    // ?sessions=1 adds each one's session ids; ?cards=1 those and what a Home card shows (#33), in one read.
    { method: 'GET', path: '/api/workstreams', handler: wrap(async (req, res, { q } = {}) => {
      const c = counts();
      const cards = q?.get('cards') === '1';
      const ids = cards || q?.get('sessions') === '1';
      return send(res, 200, { sync: await store.status(),
        workstreams: store.list().map(w => ({ ...w, sessions: c[w.slug]?.sessions || 0, live: c[w.slug]?.live || 0,
          ...(ids ? { ids: sessionsOf(w.slug) } : {}), ...(cards ? cardOf(w.slug) : {}) })) });
    }) },
    { method: 'POST', path: '/api/workstreams', handler: wrap(async (req, res) => send(res, 201, await store.create(await readBody(req)))) },

    // First use: what would be created, then create it (only with confirm: true) or use an existing repo.
    { method: 'GET', path: '/api/workstreams/setup', handler: wrap(async (req, res) => {
      const status = await store.status();
      return send(res, 200, status.ready ? status : { ...status, suggest: await store.suggest() });
    }) },
    { method: 'POST', path: '/api/workstreams/setup', handler: wrap(async (req, res) => {
      const { action, repo, confirm } = await readBody(req);
      if (action === 'create') return send(res, 200, await store.createRepo({ confirm: confirm === true }));
      if (action === 'use') return send(res, 200, await store.useRepo({ repo }));
      return send(res, 400, { error: 'action is create or use' });
    }) },
    // Pull, then push now; how a conflict, once resolved by hand, is cleared.
    { method: 'POST', path: '/api/workstreams/sync', handler: wrap(async (req, res) => send(res, 200, await store.resync())) },

    { method: 'GET', pattern: /^\/api\/workstreams\/([^/]+)$/, handler: wrap(async (req, res, { m }) => {
      const w = store.get(slugOf(m));
      if (!w) return send(res, 404, { error: 'no such workstream' });
      const ids = sessionsOf(w.slug);
      return send(res, 200, { ...w, sessions: ids, live: ids.filter(isLive).length });
    }) },
    { method: 'PATCH', pattern: /^\/api\/workstreams\/([^/]+)$/, handler: wrap(async (req, res, { m }) => send(res, 200, await store.update(slugOf(m), await readBody(req)))) },
    { method: 'POST', pattern: /^\/api\/workstreams\/([^/]+)\/decisions$/, handler: wrap(async (req, res, { m }) => send(res, 201, await store.addDecision(slugOf(m), await readBody(req)))) },
    { method: 'POST', pattern: /^\/api\/workstreams\/([^/]+)\/notes$/, handler: wrap(async (req, res, { m }) => send(res, 201, await store.addNote(slugOf(m), await readBody(req)))) },

    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/workstream$/, handler: wrap(async (req, res, { m }) => send(res, 200, { slug: live.get(slugOf(m), null) })) },
    // Assign ({ slug }) or unassign ({ slug: null }); a session belongs to at most one workstream.
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/workstream$/, handler: wrap(async (req, res, { m }) => {
      const id = slugOf(m);
      const { slug = null } = await readBody(req);
      // Unassigning needs no live session: a deleted one's mapping can still be cleared.
      if (slug !== null && !known(id)) return send(res, 404, { error: 'unknown session' });
      if (slug !== null && !store.exists(slug)) return send(res, 404, { error: 'no such workstream' });
      const was = live.get(id, null);
      live.set(id, slug ?? undefined);
      if (was !== slug) { broadcast?.('workstreams.changed', { reason: 'assign', session: id, slug, was }); scheduleSnapshot?.(); }   // summaries carry it (lib/routes/attach.mjs)
      return send(res, 200, { session: id, slug, was });
    }) },
  ];
}
