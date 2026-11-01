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
import * as filetree from './lib/filetree.mjs';
import { TurnSnapshots } from './lib/turnsnap.mjs';
import { Narrator } from './lib/narrator.mjs';
import { UsageTracker, readUsageReport, parseUsageReport } from './lib/usage.mjs';
import { Attention } from './lib/attention.mjs';
import { BriefService } from './lib/briefs.mjs';
import { ask } from './lib/ask.mjs';
import { DeckState } from './lib/deckstate.mjs';
import { AgentManager } from './lib/agent.mjs';
import { loadHarnesses } from './lib/harnesses.mjs';
import { AzureTts } from './lib/tts.mjs';
import { KokoroTts } from './lib/kokoro.mjs';
import { ProcessMonitor } from './lib/procs.mjs';
import { handoffPrompt, returnPrompt } from './lib/handoff.mjs';
import { refsFromEvents, GitHubInfo } from './lib/ghrefs.mjs';
import { DailyUsage } from './lib/daily.mjs';
import { loadRoutes, matchRoute } from './lib/routes.mjs';
import { onLaunch, beforeLaunch, failedLaunch, afterLaunch } from './lib/launch.mjs';

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
// Sending to a session that is not running resumes it under the deck,
// unless it is a subagent or runs somewhere else (a terminal, the desktop app).
const agents = new AgentManager({
  ...loadHarnesses(deck.dir),
  store: path.join(deck.dir, 'agents.json'),
  wakeable: (id) => {
    if (!index.files.has(id)) return { error: 'unknown session' };
    if (index.registry.get(id)?.alive && !agents.running(id)) return { error: 'this session is running outside the deck (a terminal or the desktop app); send it prompts there' };
    const cwd = index.cwdOf(id);
    if (!cwd) return { error: 'the session\'s folder is not known' };
    // A streamed session the deck has no events for (it restarted since) comes back with its history.
    const f = index.files.get(id);
    const loaded = index.loaded.get(id);
    return { cwd, replay: !!f.stream && !loaded?.state.events.length, title: f.stream ? loaded?.state.meta.title || null : null };
  },
});
const tts = new AzureTts({ dir: deck.dir });
const kokoro = new KokoroTts({ dir: deck.dir });
index.external = () => agents.registryEntries();
index.deckState = (id) => agents.publicState(id);
index.harnessOf = (id) => agents.recordedHarness(id);
index.lineage = (id) => agents.lineageOf(id);
const github = new GitHubInfo();
const daily = new DailyUsage();
/** Today's tokens and estimated cost per harness: Claude Code transcripts (and their subagents), plus streamed sessions. */
function usageToday() {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const files = [], streams = [];
  for (const f of index.files.values()) {
    if (f.mtime < day) continue;
    if (f.stream) {
      const events = index.loaded.get(f.id)?.state.events;
      const harness = agents.recordedHarness(f.id) || index.deckState(f.id)?.harness;
      if (events && harness) streams.push({ sessionId: f.id, harness, events });
      continue;
    }
    files.push({ file: f.file, sessionId: f.id });
    index.scanAgents(f.id);
  }
  for (const a of index.agents.values()) if (a.mtime >= day && a.file) files.push({ file: a.file, sessionId: a.parentId });
  const r = daily.today(files, streams);
  // Transcripts on disk are Claude Code's, whatever its harness is called here.
  const claude = agents.harnessList().find(x => x.type === 'claude')?.name || 'claude';
  if (claude !== 'claude' && r.backends.claude) { r.backends[claude] = r.backends.claude; delete r.backends.claude; }
  return r;
}
// Red CI on a live session's branch PR counts as needing the pilot. gh is
// asked every couple of minutes for live sessions only; no model calls.
const ci = new Map();          // sessionId -> { pr, url, failing }
const places = new Map();      // cwd -> { at, value }: where a folder is, briefly cached
async function placeOf(cwd) {
  const c = places.get(cwd);
  if (c && Date.now() - c.at < 5 * 60_000) return c.value;
  const value = await gitinfo.place(cwd);
  places.set(cwd, { at: Date.now(), value });
  return value;
}
async function watchCi() {
  const live = index.snapshot().active.filter(s => s.cwd);
  const changed = [];
  for (const s of live) {
    let next = null;
    const where = await placeOf(s.cwd).catch(() => null);
    const repo = where?.github?.repo; const branch = where?.branch;
    if (repo && branch && branch !== where.defaultBranch) {
      const pr = await github.branchPr(repo, branch);
      if (pr?.state === 'open' && pr.checks?.state === 'failure') next = { pr: pr.number, url: pr.url, failing: pr.checks.failing };
    }
    if (JSON.stringify(next) !== JSON.stringify(ci.get(s.id) || null)) { next ? ci.set(s.id, next) : ci.delete(s.id); changed.push(s.id); }
  }
  for (const id of ci.keys()) if (!live.some(s => s.id === id)) { ci.delete(id); changed.push(id); }
  for (const id of changed) index.refresh(id);
  if (changed.length) scheduleSnapshot();
}
index.ci = (id) => ci.get(id) || null;
setTimeout(() => watchCi().catch(() => {}), 5000).unref();
setInterval(() => watchCi().catch(() => {}), 120_000).unref();
// The process view: what the deck, its sessions and their tool calls are running.
const procs = new ProcessMonitor({
  known: () => ({
    sessions: [...index.registry.values()].filter(r => r.alive && r.pid)
      .map(r => ({ pid: r.pid, sessionId: r.sessionId, title: index.summary(r.sessionId)?.title, deck: agents.running(r.sessionId) })),
    shell: [...shell.runs.values()].filter(r => r.child?.pid).map(r => ({ pid: r.child.pid, runId: r.id, cmd: r.cmd })),
    work: (id) => index.workOf(id),
    allSessions: () => [...index.loaded.keys()],
    subagents: (id) => (index.summary(id)?.subagents || []).filter(a => a.status === 'running').map(a => ({ id: a.id, title: a.title, agentType: a.agentType })),
  }),
});

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
// Turn boundaries seen live snapshot the session's working tree (lib/turnsnap.mjs).
const snaps = new TurnSnapshots({ dir: deck.dir });
index.on('events', ({ sessionId, appended, updated }) => {
  if (appended.length && index.files.has(sessionId)) {
    const cwd = index.cwdOf(sessionId);
    // Replayed history (an ACP session/load) happened before; the tree now says nothing about it.
    const live = appended.filter(e => !e.replayed);
    if (cwd && live.some(e => e.kind === 'prompt' || e.kind === 'turn_end')) snaps.observe(sessionId, cwd, live).catch(() => {});
  }
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
// ACP sessions have no transcript file; their events come from the driver.
agents.on('stream', ({ id, cwd, title, events, meta }) => index.pushStream(id, { cwd, title, events, meta }));
// They are kept only in memory here, so after a restart list again the ones the agents still keep.
agents.storedStreams().then((list) => {
  for (const x of list) if (x.cwd) index.addStream(x.id, { cwd: x.cwd, title: x.title, at: Date.parse(x.updatedAt) || null });
}).catch(() => {});
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
// Prompts may carry attachments (base64), so they get a larger allowance.
const PROMPT_BODY_LIMIT = 48 << 20;
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; let chunks = [];
    // Over the limit: keep draining so the client gets a 413 rather than a dropped connection.
    req.on('data', c => { size += c.length; if (size > limit) chunks = null; else chunks?.push(c); });
    req.on('end', () => {
      if (!chunks) return reject(Object.assign(new Error(`request too large (${Math.round(size / 1024 / 1024)} MB; limit ${Math.round(limit / 1024 / 1024)} MB)`), { code: 413 }));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
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

/**
 * What moving session `id` to `harness` would do: a new session there with a
 * handoff, or, when the session came from that backend and the session it
 * came from can still be resumed, that one again with what happened since.
 */
async function planMove(id, { harness, note = '' }) {
  const entry = index.load(id);
  const summary = index.summary(id);
  if (!entry || summary?.kind !== 'session') throw Object.assign(new Error('unknown session'), { code: 404 });
  if (!summary.cwd) throw Object.assign(new Error('the session\'s folder is not known'), { code: 409 });
  const list = agents.harnessList();
  const to = list.find(x => x.name === harness);
  if (!to) throw new Error(`unknown harness: ${harness}`);
  const from = list.find(x => x.name === summary.harness);
  const label = (x) => !x ? summary.harness || 'another agent' : x.backend.label === x.label ? x.label : `${x.backend.label} (${x.label})`;
  const work = await gitinfo.changes(summary.cwd).catch(() => null);
  const back = agents.lineageOf(id)?.from;
  if (back && back.harness === harness && !agents.wakeable(back.id).error) {
    return { summary, resume: back.id, prompt: returnPrompt({ events: entry.state.events, away: label(from), work, note: String(note || '') }) };
  }
  return { summary, resume: null, prompt: handoffPrompt({ summary, events: entry.state.events, brief: briefs.publicBrief(id).brief, from: label(from), to: label(to),
    files: entry.state.filesList().map(f => f.path), work, note: String(note || '') }) };
}

// --------------------------------------------------------------- routes
// What a lib/routes/*.mjs module is handed (lib/routes.mjs).
const featureRoutes = await loadRoutes(path.join(__dirname, 'lib', 'routes'), {
  root: __dirname, send, readBody, deck, index, agents, briefs, narrator, broadcast, scheduleSnapshot, narratorEnabled: NARRATOR, onLaunch,
});

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
  if (p === '/api/config' && req.method === 'GET') return send(res, 200, { cliModel: cliModel(), harnesses: agents.harnessList() });
  if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageView());
  if (p === '/api/usage/today' && req.method === 'GET') return send(res, 200, usageToday());
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

  // Read aloud: Azure neural voices (lib/tts.mjs) and Kokoro voices made on
  // this machine (lib/kokoro.mjs). The page speaks browser voices itself.
  if (p === '/api/tts/voices' && req.method === 'GET') {
    try { return send(res, 200, { ...tts.status(), voices: await tts.voices(), kokoro: kokoro.status() }); }
    catch (e) { return send(res, 200, { ...tts.status(), voices: [], error: e.message, kokoro: kokoro.status() }); }
  }
  if (p === '/api/tts/config' && req.method === 'POST') {
    const { key, region } = await readBody(req);
    try { await tts.configure({ key, region }); return send(res, 200, { ...tts.status(), voices: await tts.voices() }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/tts' && req.method === 'POST') {
    const { text, voice = '', rate } = await readBody(req);
    const local = String(voice).startsWith('kokoro:');
    try {
      const audio = local ? await kokoro.synth({ text, voice: voice.slice(7), rate }) : await tts.synth({ text, voice: String(voice).replace(/^azure:/, ''), rate });
      return send(res, 200, audio, { 'Content-Type': local ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
    }
    catch (e) { return send(res, e.code || 502, { error: e.message }); }
  }

  if (p === '/api/launch' && req.method === 'POST') {
    let body;
    try {
      const raw = await readBody(req, PROMPT_BODY_LIMIT);
      // Checked before the hooks, so none of them acts on a launch that cannot start.
      if (!raw?.prompt?.trim() && !raw?.attachments?.length) throw new Error('a first prompt is required');
      if (!raw.cwd || !fs.existsSync(raw.cwd) || !fs.statSync(raw.cwd).isDirectory()) throw new Error(`not a directory: ${raw.cwd}`);
      // Features shape the launch from their own fields (lib/launch.mjs).
      body = await beforeLaunch(raw);
    } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.message }); }
    let st;
    try {
      const { cwd, prompt, attachments, model, permissionMode, name, harness } = body;
      st = await agents.launch({ cwd, prompt, attachments, model: model || undefined, permissionMode: permissionMode || 'default', name: name || undefined, harness: harness || undefined });
    } catch (e) {
      await failedLaunch(body, e);
      return send(res, 400, { error: e.message });
    }
    send(res, 200, st);
    // The session is up; what features do with it does not hold the page.
    afterLaunch(st, body);
    return;
  }

  let m;
  if ((m = /^\/api\/sessions\/([^/]+)\/(send|send-now|queue|interrupt|permission|stop)$/.exec(p)) && req.method === 'POST') {
    let id = decodeURIComponent(m[1]);
    const body = await readBody(req, PROMPT_BODY_LIMIT);
    // A subagent is driven through the session it runs in: prompts are
    // relayed by it (lib/agent.mjs wireText), interrupt and stop end the
    // subagent alone (stop_task); its queue and permissions are that session's.
    const sub = index.agents.get(id);
    if (sub) {
      const to = { id, title: index.agentSummary(sub).title };
      id = sub.parentId;
      if (!agents._driverOf(id)?.caps.subagents) return send(res, 409, { error: 'this session\'s agent offers no way to message a subagent' });
      try {
        switch (m[2]) {
          // Send now would cut the session's own turn short; for a subagent it queues like send.
          case 'send': case 'send-now': return send(res, 200, { item: await agents.send(id, body.text, body.attachments, { model: body.model, to }) });
          case 'interrupt': case 'stop': return send(res, 200, { stopped: await agents.stopTask(id, to.id) });
          case 'queue': await agents.queueOp(id, body); break;
          case 'permission': agents.answer(id, body.requestId, body.decision, body.message); break;
        }
        return send(res, 200, { ok: true, state: agents.publicState(id) });
      } catch (e) { return send(res, e.code === 404 ? 404 : e.code === 409 ? 409 : 400, { error: e.message }); }
    }
    try {
      switch (m[2]) {
        case 'send': return send(res, 200, { item: await agents.send(id, body.text, body.attachments, { model: body.model }) });
        case 'send-now': return send(res, 200, { item: await agents.sendNow(id, body.text, body.attachments, { model: body.model }) });
        case 'queue': await agents.queueOp(id, body); break;
        case 'interrupt': return send(res, 200, { interrupted: agents.interrupt(id) });
        case 'permission': agents.answer(id, body.requestId, body.decision, body.message); break;
        case 'stop': return send(res, 200, { stopped: agents.stop(id) });
      }
      return send(res, 200, { ok: true, state: agents.publicState(id) });
    } catch (e) { return send(res, e.code === 404 ? 404 : e.code === 409 ? 409 : 400, { error: e.message }); }
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/(migrate|handoff)$/.exec(p)) && (req.method === 'POST' || m[2] === 'handoff')) {
    const id = decodeURIComponent(m[1]);
    const body = req.method === 'POST' ? await readBody(req, PROMPT_BODY_LIMIT) : { harness: q.get('harness'), note: q.get('note') };
    let mv;
    try { mv = await planMove(id, body); } catch (e) { return send(res, e.code || 400, { error: e.message }); }
    if (m[2] === 'handoff') return send(res, 200, { prompt: mv.prompt, resume: mv.resume, resumeTitle: mv.resume ? index.summary(mv.resume)?.title || null : null });
    // The pilot may have edited the handoff in the move dialog.
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : mv.prompt;
    try {
      const st = await agents.migrate(id, { harness: body.harness, prompt, cwd: mv.summary.cwd, name: mv.summary.title, resume: mv.resume });
      scheduleSnapshot();
      return send(res, 200, st);
    } catch (e) { return send(res, e.code === 409 ? 409 : 400, { error: e.message }); }
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/place$/.exec(p)) && req.method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const summary = index.summary(id);
    if (!summary) return send(res, 404, { error: 'unknown session' });
    const where = summary.cwd ? await gitinfo.place(summary.cwd) : { repo: false, cwd: null };
    const events = index.load(id)?.state.events || [];
    const repo = where.github?.repo || null;
    const refs = refsFromEvents(events, { repo, pr: summary.pr });
    // The branch's PR is the one for the branch the session worked on; the folder may have moved on since.
    const recorded = summary.gitBranch && summary.gitBranch !== 'HEAD' ? summary.gitBranch : null;
    const prBranch = summary.alive ? where.branch || recorded : recorded || where.branch;
    // gh can be slow: answer with what git and the transcript say, and let the page ask again for titles.
    const enriched = github.enrich(refs, { repo, branch: prBranch, defaultBranch: where.defaultBranch });
    const done = await Promise.race([enriched, new Promise(r => setTimeout(r, 1500, null))]);
    return send(res, 200, { ...where, prBranch, refs: done || refs.map(({ lastSeq, ...r }) => r), pending: !done });
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
  if ((m = /^\/api\/sessions\/([^/]+)\/tasks\/([^/]+)\/stop$/.exec(p)) && req.method === 'POST') {
    try { return send(res, 200, { stopped: await agents.stopTask(decodeURIComponent(m[1]), decodeURIComponent(m[2])) }); }
    catch (e) { return send(res, e.code === 404 ? 404 : e.code === 409 ? 409 : 400, { error: e.message }); }
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/tasks\/([^/]+)\/output$/.exec(p))) {
    const r = index.taskOutput(decodeURIComponent(m[1]), decodeURIComponent(m[2]), q.get('tail'));
    return r ? send(res, 200, r) : send(res, 404, { error: 'unknown task' });
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
  if ((m = /^\/api\/sessions\/([^/]+)\/turn-changes$/.exec(p))) {
    const id = decodeURIComponent(m[1]); const cwd = index.cwdOf(id);
    if (!cwd) return send(res, 404, { error: 'no folder for this session' });
    return send(res, 200, await snaps.changes(id, cwd));
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/turn-diff$/.exec(p))) {
    const id = decodeURIComponent(m[1]); const cwd = index.cwdOf(id);
    if (!cwd || !q.get('turn') || !q.get('file')) return send(res, 400, { error: 'turn and file required' });
    const r = await snaps.diff(id, cwd, q.get('turn'), q.get('file'));
    return send(res, r.error ? 404 : 200, r);
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/tree$/.exec(p))) {
    const cwd = index.cwdOf(decodeURIComponent(m[1]));
    if (!cwd) return send(res, 404, { error: 'no folder for this session' });
    const r = q.get('all') ? await filetree.allFiles(cwd) : await filetree.listDir(cwd, q.get('dir') || '');
    return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/file/raw' && req.method === 'GET') {
    // Images, PDFs, audio/video for the Files view; streamed with a real type.
    const file = q.get('path');
    const type = file && filetree.RAW_TYPES[path.extname(file).toLowerCase()];
    if (!type) return send(res, 400, { error: 'not a viewable media file' });
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return send(res, 400, { error: 'not a file' });
      // SVG can carry script: sandbox it so it can only ever render.
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
      return fs.createReadStream(file).pipe(res);
    } catch (e) { return send(res, 404, { error: e.message }); }
  }
  if (p === '/api/file' && req.method === 'GET') {
    const file = q.get('path');
    if (!file) return send(res, 400, { error: 'path required' });
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return send(res, 400, { error: 'not a file' });
      if (q.get('meta')) return send(res, 200, { path: file, size: st.size, mtime: st.mtimeMs });
      const LIMIT = 2 * 1024 * 1024;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.allocUnsafe(Math.min(st.size, LIMIT));
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const binary = buf.subarray(0, Math.min(n, 8000)).includes(0);
      return send(res, 200, { path: file, size: st.size, mtime: st.mtimeMs, truncated: st.size > LIMIT, binary, content: binary ? null : buf.toString('utf8', 0, n) });
    } catch (e) { return send(res, 404, { error: e.message }); }
  }
  if (p === '/api/procs' && req.method === 'GET') {
    try { return send(res, 200, await procs.list(q.get('scope') === 'all' ? 'all' : 'agents')); }
    catch (e) { return send(res, e.code === 501 ? 501 : 500, { error: e.message }); }
  }
  if ((m = /^\/api\/procs\/(\d+)$/.exec(p)) && req.method === 'GET') {
    const r = await procs.detail(Number(m[1]));
    return r ? send(res, 200, r) : send(res, 404, { error: 'that process is gone' });
  }
  if ((m = /^\/api\/procs\/(\d+)\/signal$/.exec(p)) && req.method === 'POST') {
    const pid = Number(m[1]);
    const { signal = 'TERM', tree = false, start = null } = await readBody(req);
    // A session the deck launched ends through the deck, which keeps its state straight.
    const launched = [...index.registry.values()].find(r => r.pid === pid && r.alive && agents.running(r.sessionId));
    if (launched && signal === 'TERM' && !tree) return send(res, 200, { sent: agents.stop(launched.sessionId) ? [pid] : [], failed: [], via: 'deck' });
    try { return send(res, 200, await procs.signal(pid, { signal, tree: !!tree, start })); }
    catch (e) { return send(res, [400, 404, 409].includes(e.code) ? e.code : 500, { error: e.message }); }
  }
  if ((m = /^\/api\/sessions\/([^/]+)\/procs$/.exec(p)) && req.method === 'GET') {
    try { return send(res, 200, await procs.forSession(decodeURIComponent(m[1]))); }
    catch (e) { return send(res, e.code === 501 ? 501 : 500, { error: e.message }); }
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
  // Feature routes (lib/routes/*.mjs) come after the core ones, which they cannot shadow.
  const hit = matchRoute(featureRoutes, req.method, p);
  if (hit) return hit.route.handler(req, res, { url, q, m: hit.m });
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
  catch (e) {
    if (e.code !== 413) console.error(e);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { error: e.message }); else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  const snap = snapshot();
  console.log(`agent-deck ${VERSION}\n  ${url}\n  claude dir: ${index.claudeDir}\n  sessions: ${snap.active.length} active · ${snap.recent.length} recent · ${snap.closed.length} closed\n  brief + ask: ${NARRATOR ? `${narrator.llm.label} (${narrator.briefModel} / ${narrator.askModel})` : 'off'}\n  launch: ${agents.harnessList().map(h => h.default ? `${h.label} (default)` : h.label).join(' · ')}`);
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
// ACP sessions are closed before the agent goes, or it resumes them later with nobody to answer.
async function shutdown() { agents.flush(); await agents.shutdown(); index.stop(); server.close(); process.exit(0); }

/**
 * Replace this process with a fresh one on the same port and arguments.
 * Deck-launched claude sessions are children of this process, so they end.
 * The new server is detached and logs to the deck state dir.
 */
async function restart() {
  console.log(`--- ${new Date().toString()} restart requested from the deck`);
  agents.flush(); await agents.shutdown(); index.stop();
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
