// lib/routes/home.mjs — what Home's Vault tab (public/home.js, #33) shows for
// one workstream, without walking the whole Vault:
//   GET /api/home/vault/:slug  { pointers: [{ path, sha256, title, source, state, abs }], items, truncated }
// pointers: the workstream's vault.json, each checked against this machine's
// Vault (ok, missing, changed); items: the files in its <slug>/ folder there.
import fs from 'node:fs';
import path from 'node:path';
import { vaultFor, readPointers } from '../vault.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const META = '.meta.json';
const MAX = 200;

/** Files under `dir` (rel to `base`), breadth first, up to `max`; sidecars folded in. */
async function walk(base, dir, max) {
  const out = []; let level = [dir]; let truncated = false;
  while (level.length && !truncated) {
    const next = [];
    for (const d of level) {
      let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
      const names = new Set(ents.map(e => e.name));
      for (const e of ents) {
        if (e.name === '.git' || (e.name.endsWith(META) && names.has(e.name.slice(0, -META.length)))) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') next.push(abs); continue; }
        if (out.length >= max) { truncated = true; break; }
        let st; try { st = await fs.promises.stat(abs); } catch { continue; }
        let meta = null; try { meta = JSON.parse(await fs.promises.readFile(abs + META, 'utf8')); } catch { /* none */ }
        out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), path: abs, size: st.size, mtime: st.mtimeMs, meta });
      }
      if (truncated) break;
    }
    level = next;
  }
  return { items: out, truncated };
}

export default function routes({ send, deck }) {
  if (!deck) return [];
  return [{
    method: 'GET', pattern: /^\/api\/home\/vault\/([^/]+)$/,
    async handler(req, res, { m }) {
      const slug = decodeURIComponent(m[1]);
      if (!SLUG.test(slug)) return send(res, 400, { error: 'bad workstream slug' });
      try {
        const vault = vaultFor(deck);
        const pointers = (await vault.checkPointers(readPointers(path.join(deck.dir, 'workstreams', slug))))
          .map(p => ({ ...p, abs: path.join(vault.dir, p.path || '') }));
        return send(res, 200, { pointers, ...(await walk(vault.dir, path.join(vault.dir, slug), MAX)) });
      } catch (e) { return send(res, 500, { error: e.message }); }
    },
  }];
}
