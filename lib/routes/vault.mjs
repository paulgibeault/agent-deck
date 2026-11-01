// lib/routes/vault.mjs — the Vault (lib/vault.mjs): what's in it, saving a
// file, the text an event shows, or a transcript image into it, a scratch
// folder to launch a session in, and where it lives. Nothing here deletes,
// overwrites or moves Vault content.
import path from 'node:path';
import { Vault, vaultFor } from '../vault.mjs';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export default function routes({ send, readBody, deck, index }) {
  const fail = (res, e) => send(res, e.status || (e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500), { error: e.message });
  // Say so at startup if a remote has appeared; the menu glyph and the Vault dialog say it too.
  if (deck) vaultFor(deck).status().then(s => { if (s.warning) console.warn(`agent-deck: ${s.warning}`); }).catch(() => {});

  return [
    {
      method: 'GET', path: '/api/vault',
      async handler(req, res, { q }) {
        try {
          const v = vaultFor(deck);
          const st = await v.status();
          if (q.get('status')) return send(res, 200, st);
          return send(res, 200, { ...st, ...(await v.list()), log: await v.log(10) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      // From a details view: { path, content? } (content: what a Write or edit event shows),
      // or { sessionId, eventId, image } a transcript image; plus sessionId, eventId, workstream, title.
      method: 'POST', path: '/api/vault/save',
      async handler(req, res) {
        try {
          const b = await readBody(req, 8 << 20);
          const v = vaultFor(deck);
          const opts = { workstream: b.workstream, title: b.title };
          const source = { sessionId: b.sessionId, eventId: b.eventId };
          if (b.path) {
            // A relative path is the session's: resolve it against the session's folder.
            const base = (b.sessionId && index?.cwdOf?.(b.sessionId)) || b.cwd || null;
            if (!path.isAbsolute(b.path) && !base) return send(res, 400, { error: 'a relative path needs its session' });
            const abs = path.resolve(base || '/', b.path);
            if (typeof b.content === 'string') return send(res, 200, await v.saveData(path.basename(abs), b.content, { ...opts, source: { ...source, path: abs, via: 'event' } }));
            // An event with nothing to show saves the file as it is now; say so.
            return send(res, 200, await v.saveFile(abs, { ...opts, source: { ...source, via: b.eventId ? 'disk-now' : 'files' } }));
          }
          if (b.sessionId && b.eventId && b.image != null) {
            const img = index?.image(b.sessionId, b.eventId, Number(b.image));
            if (!img) return send(res, 404, { error: 'no such image' });
            const name = b.name || `image-${String(b.eventId).slice(-8)}-${b.image}${EXT[img.mediaType] || '.bin'}`;
            return send(res, 200, await v.saveData(name, img.data, { ...opts, source: { ...source, image: Number(b.image), via: 'event' } }));
          }
          return send(res, 400, { error: 'path, or sessionId, eventId and image, required' });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      // A fresh folder under loose/ to launch a scratch session in.
      method: 'POST', path: '/api/vault/scratch',
      async handler(req, res) {
        try { const b = await readBody(req); return send(res, 200, { dir: await vaultFor(deck).scratch(b.name) }); } catch (e) { return fail(res, e); }
      },
    },
    {
      // Point the deck at another folder for its Vault (nothing is moved); { dir: null } goes back to the default.
      method: 'POST', path: '/api/vault/config',
      async handler(req, res) {
        try {
          const { dir } = await readBody(req);
          if (dir != null && (typeof dir !== 'string' || !path.isAbsolute(dir))) return send(res, 400, { error: 'dir must be an absolute path' });
          if (dir) {
            const remotes = await new Vault(dir).remotes().catch(() => []);
            if (remotes.length) return send(res, 409, { error: `That folder is a git repository with a remote (${remotes.join(', ')}); the Vault must never have one.` });
          }
          deck.ns('vault').set('dir', dir || undefined);
          const v = vaultFor(deck);
          // An existing repo gets the push guard now, not at its first save.
          if (v.exists()) await v.init();
          return send(res, 200, await v.status());
        } catch (e) { return fail(res, e); }
      },
    },
  ];
}
