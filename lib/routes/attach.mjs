// lib/routes/attach.mjs — sessions in workstreams (#35): which workstream a
// session belongs to, on its summary (the rail, header and Home read
// `workstream: { slug, title } | null`); a launch that names a workstream is
// assigned to it once it starts, and may carry the workstream briefing
// (lib/briefing.mjs) after its first prompt. Assigning later is
// POST /api/sessions/:id/workstream (lib/routes/workstreams.mjs).
//   GET /api/workstreams/:slug/briefing → { text, tokens, truncated, empty, max, summary }
import { deckStore } from './workstreams.mjs';
import { buildBriefing, withBriefing, BRIEF_MAX, BRIEF_TOKENS, tokensOf } from '../briefing.mjs';

/**
 * The launch hooks (lib/launch.mjs), given the store and the session → slug map.
 * The body's own fields: `workstream` (a slug) and `brief` (the text the pilot
 * saw and maybe edited, or true for the built one; absent or false for none).
 * `streamed(harness)` says whether the deck titles that harness's sessions by their first prompt.
 */
export function launchHooks({ store, live, broadcast, changed = () => {}, streamed = () => false }) {
  return {
    // Checked before the launch, so a stale slug stops it rather than starting a session that silently isn't in it.
    before(body) {
      const slug = body.workstream || null;
      if (!slug) return null;
      if (!store.exists(slug)) throw new Error(`no such workstream: ${slug}`);
      if (!body.brief) return null;
      const text = typeof body.brief === 'string' ? body.brief : buildBriefing(store.get(slug)).text;
      if (text.length > BRIEF_MAX) throw new Error(`the briefing is over its cap (about ${tokensOf(text)} of ${BRIEF_TOKENS} tokens); shorten it`);
      const out = { prompt: withBriefing(body.prompt, text) };
      // A streamed session is titled by its whole first prompt, now prompt and briefing:
      // name it after the pilot's own prompt (or first attachment). A claude session is not
      // named here, as --name would freeze its title.
      if (!body.name && streamed(body.harness)) {
        const own = String(body.prompt || '').replace(/\s+/g, ' ').trim() || String(body.attachments?.[0]?.name || '').trim();
        if (own) out.name = own.length > 80 ? own.slice(0, 79) + '…' : own;
      }
      return out;
    },
    // Only a session that started is assigned: a failed launch never reaches here.
    after(st, body) {
      const slug = body.workstream || null;
      if (!slug || !st?.id) return;
      const was = live.get(st.id, null);
      live.set(st.id, slug);
      broadcast?.('workstreams.changed', { reason: 'assign', session: st.id, slug, was });
      changed();
    },
  };
}

// Store changes that can change a title on a summary; sync and the rest cannot.
const RETITLES = new Set(['setup', 'create', 'edit']);

export default function routes({ send, deck, index, agents, broadcast, scheduleSnapshot, onLaunch }) {
  if (!deck) return [];
  const store = deckStore(deck);   // the same one lib/routes/workstreams.mjs uses
  const live = deck.ns('workstreams');

  // Titles by slug, read once per change rather than on every summary.
  let titles = null;
  const titleOf = (slug) => {
    if (!titles) { try { titles = new Map(store.list().map(w => [w.slug, w.title])); } catch { titles = new Map(); } }
    return titles.get(slug) ?? slug;
  };
  store.on('changed', (e) => { titles = null; if (RETITLES.has(e?.reason)) scheduleSnapshot?.(); });
  if (index) index.workstreamOf = (id) => { const slug = live.get(id, null); return slug ? { slug, title: titleOf(slug) } : null; };

  const streamed = (harness) => agents?.drivers?.[harness || agents.defaultHarness]?.caps?.events === 'stream';
  onLaunch?.(launchHooks({ store, live, broadcast, streamed, changed: () => scheduleSnapshot?.() }));

  return [
    { method: 'GET', pattern: /^\/api\/workstreams\/([^/]+)\/briefing$/, handler: (req, res, { m }) => {
      const w = store.get(decodeURIComponent(m[1]));
      if (!w) return send(res, 404, { error: 'no such workstream' });
      // `summary` says whether to brief by default (only once there is something to brief with).
      return send(res, 200, { ...buildBriefing(w), max: BRIEF_MAX, summary: !!String(w.summary || '').trim() });
    } },
  ];
}
