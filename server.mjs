#!/usr/bin/env node
// agent-deck server: http + sse + transcript tailing + git + pilot shell.
// Zero dependencies. Binds 127.0.0.1 only; every API request needs the launch
// token. The static app shell is public so the installed web app can load it
// (and show its launch screen) before it has a token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SessionIndex } from './lib/sessions.mjs';
import { ShellRunner } from './lib/shell.mjs';
import * as gitinfo from './lib/gitinfo.mjs';
import { Narrator } from './lib/narrator.mjs';
import { UsageTracker, readUsageReport, parseUsageReport } from './lib/usage.mjs';
import { Attention } from './lib/attention.mjs';
import { BriefService } from './lib/briefs.mjs';
import { ask } from './lib/ask.mjs';
import { DeckState } from './lib/deckstate.mjs';
import { AgentManager } from './lib/agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- config
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1] ?? true;
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
}
const PORT = Number(arg('port', process.env.DECK_PORT || 7777));
const HOST = '127.0.0.1';
const RECENT_DAYS = Number(arg('days', 3));
const EDITOR_CMD = process.env.DECK_EDITOR || 'code';
const OPEN = argv.includes('--open');
const NARRATOR = !argv.includes('--no-narrator') && process.env.DECK_NARRATOR !== 'off';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.map': 'application/json',
};

// ------------------------------------------------------------- services
const index = new SessionIndex({ recentDays: RECENT_DAYS }).start();
const shell = new ShellRunner();
const deck = new DeckState();
// The token persists in the deck state dir so the installed app's cookie
// survives backend restarts. --token / DECK_TOKEN override it.
const TOKEN = String(arg('token', process.env.DECK_TOKEN || deck.token()));
const narrator = new Narrator();
const usage = new UsageTracker();
narrator.onRateLimit = (info) => usage.update(info, 'the deck\'s own model calls');
const briefs = new BriefService({ index, narrator, enabled: NARRATOR }).start();
briefs.isHidden = (id) => deck.hidden.has(id);
const snapshot = () => index.snapshot(deck.hidden);
const agents = new AgentManager();
index.external = () => agents.registryEntries();
index.deckState = (id) => agents.publicState(id);

// ---------------------------------------------------------------- SSE
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
let snapshotTimer = null;
function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => { snapshotTimer = null; const snap = snapshot(); broadcast('sessions.snapshot', snap); attention.observe(snap.active); }, 150);
}
// Needs you: signal changes across live sessions, for the UI now and narration later.
const attention = new Attention();
attention.on('attention', (entry) => broadcast('attention', entry));
// Signals also move without a file change (a question goes unanswered, a turn
// goes quiet), and a change is announced once it settles, so look every second.
setInterval(() => attention.observe(snapshot().active), 1000).unref();
index.on('sessions', scheduleSnapshot);
index.on('events', ({ sessionId, appended, updated }) => {
  if (appended.length) broadcast('event.batch', { sessionId, events: appended });
  for (const ev of updated) broadcast('event.update', { sessionId, event: ev });
});
index.on('session', (payload) => broadcast('session.update', payload));
briefs.on('brief', (b) => broadcast('brief.update', { ...b, narrator: narrator.status() }));
agents.on('change', (st) => {
  broadcast('deck.update', st);
  index.refresh(st.id);
  scheduleSnapshot();
});
agents.on('ratelimit', (info) => usage.update(info, 'a session the deck launched'));
const usageView = () => ({ limits: usage.snapshot(), error: usageError, narrator: { enabled: NARRATOR, ...narrator.status() } });
usage.on('usage', () => broadcast('usage', usageView()));
// `claude -p /usage` reads the plan quota without a model call, so it is free
// to ask: on start, every few minutes while someone is watching, and on demand.
// Model calls (the deck's own, and launched sessions) update it in between.
const QUOTA_STALE_MS = 3 * 60_000;
let probing = null, usageError = null;
function probeQuota() {
  if (probing) return probing;
  probing = readUsageReport()
    .then((text) => {
      const r = parseUsageReport(text);
      if (!r) throw new Error(`could not read claude /usage: ${text.trim().slice(0, 200) || 'empty reply'}`);
      usageError = null; usage.report(r);
    })
    .catch((e) => { usageError = { message: e.message, at: Date.now() }; })
    .finally(() => { probing = null; broadcast('usage', usageView()); });
  return probing;
}
probeQuota();
setInterval(() => {
  const snap = usage.snapshot();
  if (clients.size && (!snap?.reportAt || Date.now() - snap.reportAt > QUOTA_STALE_MS)) probeQuota();
}, 30_000).unref();
shell.on('output', (d) => broadcast('shell.output', d));
shell.on('exit', (d) => broadcast('shell.exit', d));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000).unref();

// ------------------------------------------------------------- helpers
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': isBuf ? headers['Content-Type'] || 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authorized(req, url) {
  return url.searchParams.get('t') === TOKEN || cookies(req).deck === TOKEN || req.headers['x-deck-token'] === TOKEN;
}
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

/** The model the CLI uses when none is passed: the `model` in Claude Code's user settings. */
function cliModel() {
  try { return JSON.parse(fs.readFileSync(path.join(index.claudeDir, 'settings.json'), 'utf8')).model || null; } catch { return null; }
}

// --------------------------------------------------------------- routes
async function route(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const clientId = randomBytes(6).toString('hex');
    res.write(`event: hello\ndata: ${JSON.stringify({ serverStartedAt: STARTED, token: TOKEN.slice(0, 4), version: VERSION, clientId, narrator: { enabled: NARRATOR, ...narrator.status() } })}\n\n`);
    res.write(`event: sessions.snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: briefs.snapshot\ndata: ${JSON.stringify(briefs.all())}\n\n`);
    res.write(`event: usage\ndata: ${JSON.stringify(usageView())}\n\n`);
    res.write(`event: attention.snapshot\ndata: ${JSON.stringify(attention.view())}\n\n`);
    clients.add(res);
    req.on('close', () => { clients.delete(res); briefs.dropClient(clientId); });
    return;
  }
  if (p === '/api/restart' && req.method === 'POST') {
    send(res, 200, { ok: true, startedAt: STARTED });
    setTimeout(restart, 100);
    return;
  }
  if (p === '/api/health') return send(res, 200, { ok: true, startedAt: STARTED, clients: clients.size, loaded: index.loaded.size });
  if (p === '/api/sessions' && req.method === 'GET') return send(res, 200, snapshot());
  if (p === '/api/attention' && req.method === 'GET') return send(res, 200, attention.view());
  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { cliModel: cliModel() });
  if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageView());
  if (p === '/api/usage/refresh' && req.method === 'POST') {
    await probeQuota();
    return send(res, 200, usageView());
  }
  if (p === '/api/briefs' && req.method === 'GET') return send(res, 200, { briefs: briefs.all(), narrator: { enabled: NARRATOR, ...narrator.status() } });
  if (p === '/api/view' && req.method === 'POST') {
    const { clientId, sessionId } = await readBody(req);
    if (!clientId) return send(res, 400, { error: 'clientId required' });
    if (sessionId) index.load(sessionId);
    briefs.setView(clientId, sessionId || null);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/ask' && req.method === 'POST') {
    const { question, scope, sessionId } = await readBody(req);
    if (!question || !Array.isArray(scope)) return send(res, 400, { error: 'question and scope required' });
    if (!NARRATOR) return send(res, 409, { error: 'model calls are off (started with --no-narrator)' });
    try { return send(res, 200, await ask({ index, briefs, narrator, question, scope, sessionId })); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  if (p === '/api/launch' && req.method === 'POST') {
    const { cwd, prompt, model, permissionMode, name } = await readBody(req);
    try {
      const st = await agents.launch({ cwd, prompt, model: model || undefined, permissionMode: permissionMode || 'default', name: name || undefined });
      return send(res, 200, st);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  let m;
  if ((m = /^\/api\/sessions\/([^/]+)\/(send|send-now|queue|interrupt|permission|stop|resume)$/.exec(p)) && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const body = await readBody(req);
    try {
      switch (m[2]) {
        case 'send': return send(res, 200, { item: agents.send(id, body.text) });
        case 'send-now': return send(res, 200, { item: agents.sendNow(id, body.text) });
        case 'queue': agents.queueOp(id, body); break;
        case 'interrupt': return send(res, 200, { interrupted: agents.interrupt(id) });
        case 'permission': agents.answer(id, body.requestId, body.decision, body.message); break;
        case 'stop': return send(res, 200, { stopped: agents.stop(id) });
        case 'resume': {
          const cwd = index.cwdOf(id);
          if (!cwd) return send(res, 404, { error: 'unknown session' });
          if (index.registry.get(id)?.alive) return send(res, 409, { error: 'session is still running outside the deck' });
          return send(res, 200, await agents.launch({ cwd, resume: id, prompt: body.prompt, model: body.model || undefined, permissionMode: body.permissionMode || 'default' }));
        }
      }
      return send(res, 200, { ok: true, state: agents.publicState(id) });
    } catch (e) { return send(res, e.code === 404 ? 404 : e.code === 409 ? 409 : 400, { error: e.message }); }
  }
  if ((m = /^\/api\/sessions\/([^/]+)$/.exec(p))) {
    const id = decodeURIComponent(m[1]);
    const summary = index.summary(id);
    if (!summary) return send(res, 404, { error: 'unknown session' });
    index.load(id);
    return send(res, 200, { summary: index.summary(id), meta: index.metaOf(id), brief: index.brief(id) });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/brief\/refresh$/.exec(p)) && req.method === 'POST') {
    if (!NARRATOR) return send(res, 409, { error: 'model calls are off (started with --no-narrator)' });
    return briefs.refresh(decodeURIComponent(m[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'unknown session' });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/hide$/.exec(p)) && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    if (!index.files.has(id)) return send(res, 404, { error: 'unknown session' });
    const { hidden = true } = await readBody(req);
    deck.setHidden(id, !!hidden);
    scheduleSnapshot();
    return send(res, 200, { ok: true, hidden: !!hidden });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/delete$/.exec(p)) && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const where = index.fileOf(id);
    if (!where) return send(res, 404, { error: 'unknown session' });
    if (index.registry.get(id)?.alive) return send(res, 409, { error: 'session is still running; end it first' });
    const trashedTo = deck.trashSession(id, where);
    index.forget(id);
    briefs.forget(id);
    return send(res, 200, { ok: true, trashedTo });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/events$/.exec(p))) {
    const r = index.events(decodeURIComponent(m[1]), Number(q.get('from') || 0), Number(q.get('limit') || 5000));
    return r ? send(res, 200, r) : send(res, 404, { error: 'unknown session' });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
    const r = index.detail(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return r ? send(res, 200, r) : send(res, 404, { error: 'unknown event' });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/events\/([^/]+)\/image\/(\d+)$/.exec(p))) {
    const img = index.image(decodeURIComponent(m[1]), decodeURIComponent(m[2]), Number(m[3]));
    return img ? send(res, 200, img.data, { 'Content-Type': img.mediaType || 'image/png' }) : send(res, 404, 'no image');
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/files$/.exec(p))) {
    const r = index.filesOf(decodeURIComponent(m[1]));
    return r ? send(res, 200, { files: r }) : send(res, 404, { error: 'unknown session' });
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/changes$/.exec(p))) {
    const cwd = index.cwdOf(decodeURIComponent(m[1]));
    if (!cwd) return send(res, 404, { error: 'no cwd' });
    return send(res, 200, await gitinfo.changes(cwd));
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/diff$/.exec(p))) {
    const cwd = index.cwdOf(decodeURIComponent(m[1]));
    const file = q.get('file');
    if (!cwd || !file) return send(res, 400, { error: 'cwd and file required' });
    return send(res, 200, await gitinfo.fileDiff(cwd, file));
  }
  if (p === '/api/file' && req.method === 'GET') {
    const file = q.get('path');
    if (!file) return send(res, 400, { error: 'path required' });
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return send(res, 400, { error: 'not a file' });
      const LIMIT = 2 * 1024 * 1024;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(Math.min(st.size, LIMIT));
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const binary = buf.subarray(0, Math.min(n, 8000)).includes(0);
      return send(res, 200, { path: file, size: st.size, mtime: st.mtimeMs, truncated: st.size > LIMIT, binary, content: binary ? null : buf.toString('utf8', 0, n) });
    } catch (e) { return send(res, 404, { error: e.message }); }
  }
  if (p === '/api/shell/history') return send(res, 200, { runs: shell.history() });
  if (p === '/api/shell/run' && req.method === 'POST') {
    const { cmd, cwd } = await readBody(req);
    if (!cmd || typeof cmd !== 'string') return send(res, 400, { error: 'cmd required' });
    if (cwd && !fs.existsSync(cwd)) return send(res, 400, { error: `cwd does not exist: ${cwd}` });
    const run = shell.run({ cmd, cwd });
    return send(res, 200, { runId: run.id, startedAt: run.startedAt });
  }
  if (p === '/api/shell/kill' && req.method === 'POST') {
    const { runId } = await readBody(req);
    return send(res, 200, { killed: shell.kill(runId) });
  }
  if (p === '/api/open-editor' && req.method === 'POST') {
    const { path: file, line } = await readBody(req);
    if (!file) return send(res, 400, { error: 'path required' });
    const target = line ? `${file}:${line}` : file;
    try {
      const child = spawn(EDITOR_CMD, ['-g', target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
      child.on('error', () => { /* reported below only if spawn throws synchronously */ });
      child.unref();
      return send(res, 200, { ok: true, editor: EDITOR_CMD, target });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  return send(res, 404, { error: 'not found' });
}

// --------------------------------------------------------------- server
const STARTED = Date.now();
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const COOKIE = `deck=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    if (p === '/') {
      // ?t=<token> signs this browser in, then drops the token from the URL so
      // an installed app's start URL stays clean.
      if (url.searchParams.get('t') === TOKEN) return send(res, 302, '', { 'Set-Cookie': COOKIE, Location: '/' });
      if (authorized(req, url)) res.setHeader('Set-Cookie', COOKIE);
      return serveStatic(res, 'index.html');
    }
    return serveStatic(res, p.slice(1));
  }
  if (!authorized(req, url)) return send(res, 401, { error: 'missing or wrong token' });
  try { await route(req, res, url); }
  catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  const snap = snapshot();
  console.log(`agent-deck ${VERSION}\n  ${url}\n  claude dir: ${index.claudeDir}\n  sessions: ${snap.active.length} active · ${snap.recent.length} recent · ${snap.closed.length} closed\n  brief + ask: ${NARRATOR ? `claude -p (${narrator.briefModel} / ${narrator.askModel})` : 'off'}`);
  if (OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }
});
// A restarted server can beat its predecessor to the port; give it a moment.
let listenRetries = process.env.DECK_RESTARTED ? 40 : 0;
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  if (listenRetries-- > 0) { setTimeout(() => server.listen(PORT, HOST), 250); return; }
  console.error(`agent-deck: port ${PORT} is already in use (is the deck already running?)`);
  process.exit(1);
});
function shutdown() { agents.stopAll(); index.stop(); server.close(); process.exit(0); }

/**
 * Replace this process with a fresh one on the same port and arguments.
 * Deck-launched claude sessions are children of this process, so they end.
 * The new server is detached and logs to the deck state dir.
 */
function restart() {
  console.log(`--- ${new Date().toString()} restart requested from the deck`);
  agents.stopAll(); index.stop();
  for (const c of clients) c.end();
  const log = fs.openSync(path.join(deck.dir, 'server.log'), 'a');
  const relaunch = () => {
    const args = [...process.execArgv, ...process.argv.slice(1).filter(a => a !== '--open')];
    spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, DECK_RESTARTED: '1' }, detached: true, stdio: ['ignore', log, log] }).unref();
    process.exit(0);
  };
  server.close(relaunch);
  server.closeAllConnections?.();
  setTimeout(relaunch, 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
