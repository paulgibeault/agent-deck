// lib/routes/titles.mjs — rename a session from its header (lib/titles.mjs).
//   POST /api/sessions/:id/title { title } → { title, override }; an empty title clears the override.
import { Titles } from '../titles.mjs';

export default function routes({ send, readBody, deck, index, agents, scheduleSnapshot }) {
  if (!deck || !index) return [];
  const titles = new Titles({ deck, index, agents });
  return [{
    method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/title$/,
    async handler(req, res, { m }) {
      const id = decodeURIComponent(m[1]);
      // Subagents keep the description they were given.
      if (index.summary(id)?.kind !== 'session') return send(res, 404, { error: 'unknown session' });
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      if (body?.title != null && typeof body.title !== 'string') return send(res, 400, { error: 'title must be a string' });
      const override = titles.set(id, body?.title);
      scheduleSnapshot?.();
      return send(res, 200, { title: index.summary(id).title, override });
    },
  }];
}
