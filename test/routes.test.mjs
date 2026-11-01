// The route table (lib/routes.mjs): mounting lib/routes/*.mjs modules,
// matching by method, path and pattern, and the shipped modules' shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadRoutes, matchRoute } from '../lib/routes.mjs';

const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'routes');

test('mounts a route module and serves its routes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-routes-'));
  fs.writeFileSync(path.join(dir, 'things.mjs'), `
    export default function routes({ send, greeting }) {
      return [
        { method: 'GET', path: '/api/things', handler: (req, res) => send(res, 200, { greeting }) },
        { method: 'POST', pattern: /^\\/api\\/things\\/([^/]+)$/, handler: (req, res, { m }) => send(res, 200, { id: decodeURIComponent(m[1]) }) },
      ];
    }`);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a route module');
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const table = await loadRoutes(dir, { send, greeting: 'hi' });
  assert.equal(table.length, 2);
  assert.equal(table[0].from, 'things.mjs');

  assert.equal(matchRoute(table, 'GET', '/api/things').route, table[0]);
  assert.equal(matchRoute(table, 'POST', '/api/things'), null);
  assert.equal(matchRoute(table, 'GET', '/api/things/a'), null);
  assert.equal(matchRoute(table, 'POST', '/api/things/a%20b').m[1], 'a%20b');
  assert.equal(matchRoute(table, 'GET', '/api/other'), null);

  // Served the way server.mjs serves them.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = matchRoute(table, req.method, url.pathname);
    if (hit) return hit.route.handler(req, res, { url, q: url.searchParams, m: hit.m });
    send(res, 404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/things`)).json(), { greeting: 'hi' });
    assert.deepEqual(await (await fetch(`${base}/api/things/a%20b`, { method: 'POST' })).json(), { id: 'a b' });
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  } finally { server.close(); }
});

test('a broken route module is skipped, not fatal; bad routes are refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-routes-'));
  const write = (f, src) => fs.writeFileSync(path.join(dir, f), src);
  write('a-nohandler.mjs', 'export default () => [{ method: "GET", path: "/api/x" }];');
  write('b-static.mjs', 'export default () => [{ method: "GET", path: "/vault/export", handler() {} }];');
  write('c-sticky.mjs', 'export default () => [{ pattern: /^\\/api\\/y$/g, handler() {} }];');
  write('d-helper.mjs', 'export const util = 1;');
  write('e-throws.mjs', 'export default () => { throw new Error("boom"); };');
  write('f-good.mjs', 'export default () => [{ method: "GET", path: "/api/ok", handler() {} }];');
  const warned = [];
  t.mock.method(console, 'error', (m) => warned.push(m));
  const table = await loadRoutes(dir, {});
  assert.deepEqual(table.map(r => r.from), ['f-good.mjs'], 'only the good module mounts');
  assert.equal(warned.length, 5);
  assert.match(warned.join('\n'), /b-static\.mjs: .*under \/api\//);
});

test('a missing routes folder mounts nothing', async () => {
  assert.deepEqual(await loadRoutes(path.join(os.tmpdir(), 'deck-no-such-routes-dir'), {}), []);
});

test('the shipped route modules load, and the tunnel heal route is among them', async () => {
  const table = await loadRoutes(ROUTES, { send() {}, root: '/' });
  const hit = matchRoute(table, 'POST', '/api/tunnel/heal');
  assert.equal(hit?.route.from, 'tunnel.mjs');
  assert.equal(matchRoute(table, 'GET', '/api/tunnel/heal'), null);
});
