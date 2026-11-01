// lib/routes.mjs — the route table: server.mjs mounts every lib/routes/*.mjs,
// one file per feature, so features add endpoints without editing server.mjs.
// A route module's default export takes the server's context and returns its routes:
//   export default function routes(ctx) {
//     return [{ method: 'POST', path: '/api/thing', handler: async (req, res, { url, q, m }) => ctx.send(res, 200, {}) }];
//   }
// `path` matches exactly; `pattern` is a RegExp (no g or y flag) whose match arrives as `m`.
// Both must be under /api/: other GETs are served as static files before routes run.
// No `method` matches any. A module that fails to load is skipped with a warning, so
// one broken feature does not keep the deck from starting. ctx carries send, readBody, root and the services (see server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Import each module in `dir` (in name order) and collect its routes. */
export async function loadRoutes(dir, ctx) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort(); } catch { return []; }
  const table = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (typeof mod.default !== 'function') throw new Error('no default export function');
      const routes = [];
      for (const r of mod.default(ctx) || []) {
        const ok = typeof r.handler === 'function' && (typeof r.path === 'string' ? r.path.startsWith('/api/')
          : r.pattern instanceof RegExp && !r.pattern.global && !r.pattern.sticky && r.pattern.source.startsWith('^\\/api\\/'));
        if (!ok) throw new Error('each route needs a handler and a path or pattern under /api/ (patterns: anchored, no g or y flag)');
        routes.push({ ...r, from: f });
      }
      table.push(...routes);
    } catch (e) { console.error(`agent-deck: skipping lib/routes/${f}: ${e.message}`); }
  }
  return table;
}

/** The first route for this request, with the pattern's match; null when none. */
export function matchRoute(table, method, pathname) {
  for (const r of table) {
    if (r.method && r.method !== method) continue;
    if (typeof r.path === 'string') { if (r.path === pathname) return { route: r, m: null }; continue; }
    const m = r.pattern.exec(pathname);
    if (m) return { route: r, m };
  }
  return null;
}
