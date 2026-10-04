// public/app.js — state, SSE wiring, panes. No build step, no dependencies.
import { renderRow, renderDetails, renderDiffDetails, inferenceCard, h, fmtTokens, fmtMs, fmtUsd, fmtTime, ago, relPath, basename,
  markdown, oneLine, tagFor, tagEl, rowHeight, svgUse, starIcon, ib, flashDone } from './events.js';
import { activitySince, CADENCE, WEIGHT } from './activity.js';
import { FILTERS, FILTER_ALL, filterCat } from './classify.js';
import { createFilesView, renderFileView } from './files.js';
import { turnChanges, renderTurnList, renderTurnFileDiff } from './changes.js';
import { attachable, guardWindowDrops } from './attach.js';
import { createNarration } from './narration.js';
import { renderStrip, renderTable, renderTaskDetails, renderOutput, taskState, taskTitle } from './background.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ api
async function req(path, opts) {
  const r = await fetch(path, opts);
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(body?.error || `${r.status} ${path}`);
  return body;
}
const api = {
  get: (path) => req(path),
  post: (path, body) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
  openEditor(path, line) { return api.post('/api/open-editor', { path, line }).catch(e => toast(`Open in editor failed: ${e.message}`)); },
};
const sid = (id) => encodeURIComponent(id);

// ------------------------------------------------------------ state
const prefs = (() => { try { return JSON.parse(localStorage.getItem('deck.prefs') || '{}'); } catch { return {}; } })();
function savePrefs() { try { localStorage.setItem('deck.prefs', JSON.stringify(prefs)); } catch { /* private mode */ } }

const state = {
  snapshot: { active: [], recent: [], closed: [] },
  byId: new Map(),            // id -> summary (sessions and agents)
  selected: null,
  cache: new Map(),           // id -> { events, byId, lastSeq, meta, brief, summary, loaded }
  expanded: new Set(),        // agentIds expanded inline in the events list
  tab: 'events',
  live: true,                 // the stream and the details pane both track the newest event
  picked: false,              // the user picked an event to look at (scrolling back up does not resume live)
  cursor: null,               // selected event id
  rows: [], offsets: [], total: 0,
  filter: '', kinds: initKinds(),
  treeFilter: '',
  subsOpen: new Set(), subsAll: new Set(),
  files: null, changes: null,
  shell: { runs: new Map(), order: [], history: (() => { try { return JSON.parse(localStorage.getItem('deck.shhist') || '[]'); } catch { return []; } })(), hi: -1 },
  detailsKey: null,
  briefs: new Map(),          // id -> generated brief (server publicBrief)
  briefAt: null,              // { id, at }: an earlier brief being read (its updatedAt); null = latest
  narrator: { enabled: true },
  clientId: null,
  ask: null,                  // { spec, primary, extras, thread, sessionId, ring }
  deck: new Map(),            // id -> deck-launched session state (lib/agent.mjs publicState)
  pendingOpen: null,          // a session just launched, opened once the index lists it
  qEdit: null,
  usage: null,
  attention: { needs: [], log: [] },   // needs-you entries from lib/attention.mjs                // { limits: plan quota (lib/usage.mjs), narrator: the deck's own model calls }                // a queued prompt being edited in place: { id, el, sessionId, original, done }
};

function toast(msg, action = null) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  if (action) t.append(h('button', { type: 'button', onclick: () => { action.fn(); t.remove(); } }, action.label));
  document.body.append(t); setTimeout(() => t.remove(), action ? 6000 : 3000);
}

// ------------------------------------------------------------ phases
// Four states the eye can tell apart: working, turn (your turn), done, ended.
function phaseOf(s) {
  if (!s) return 'ended';
  if (s.kind === 'agent') return s.status === 'running' ? 'working' : s.status === 'done' ? 'done' : 'ended';
  if (!s.alive) return 'ended';
  const c = state.cache.get(s.id);
  return c?.brief?.phase || s.glance?.phase || (s.status === 'busy' ? 'working' : 'turn');
}
const PHASE_LABEL = { working: 'Working', turn: 'Your turn', done: 'Done', ended: 'Ended' };
/**
 * The signal every view colours by (computed in lib/brief.mjs):
 *   input   orange  paused on the pilot: a permission prompt or a question
 *   error   red     the newest event is an error
 *   working yellow  busy (pulses)
 *   done    green   finished cleanly
 *   ended   grey    the process is gone
 * Input and error together are "needs you".
 */
const SIG_LABEL = { input: 'Needs input', error: 'Error', working: 'Working', done: 'Done', ended: 'Ended' };
function sigOf(s) {
  if (!s) return 'ended';
  if (s.kind === 'agent') return s.status === 'running' ? 'working' : s.status === 'done' ? 'done' : 'ended';
  if (!s.alive) return 'ended';
  if (deckOf(s.id)?.permissions?.length) return 'input';   // the deck hears these before the transcript shows them
  const c = state.cache.get(s.id);
  return c?.brief?.signal || s.glance?.signal || (s.status === 'busy' ? 'working' : 'done');
}
const needsYou = (s) => { const g = sigOf(s); return g === 'input' || g === 'error'; };
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
const recentErr = (s) => s.glance?.errors && s.glance.lastErrorTs && Date.now() - Date.parse(s.glance.lastErrorTs) < 30 * 60_000;

// ------------------------------------------------------------ SSE
let es = null;
function connect() {
  es = new EventSource('/api/stream');
  es.onopen = () => { setConn(true); hideLaunch(); if (state.selected) catchUp(state.selected); for (const id of state.expanded) catchUp(id); };
  es.onerror = () => { setConn(false); watchBackend(); };
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); state.clientId = d.clientId; state.narrator = d.narrator || state.narrator; reportView(); });
  es.addEventListener('sessions.snapshot', (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener('attention.snapshot', (e) => { state.attention = JSON.parse(e.data); });
  es.addEventListener('attention', (e) => { const a = JSON.parse(e.data); state.attention.log = [...state.attention.log, a].slice(-100); narrate(a); });
  es.addEventListener('usage', (e) => { state.usage = JSON.parse(e.data); state.usage._at = Date.now(); if (state.usage.narrator) state.narrator = { ...state.narrator, ...state.usage.narrator }; renderQuota(); });
  es.addEventListener('briefs.snapshot', (e) => { const all = JSON.parse(e.data); for (const [id, b] of Object.entries(all)) state.briefs.set(id, b); refreshBriefViews(); });
  es.addEventListener('brief.update', (e) => { const b = JSON.parse(e.data); if (b.narrator) state.narrator = { ...state.narrator, ...b.narrator }; narrateBrief(b); state.briefs.set(b.id, b); refreshBriefViews(b.id); });
  es.addEventListener('event.batch', (e) => { const { sessionId, events } = JSON.parse(e.data); narrateEvents(sessionId, events); onEvents(sessionId, events); });
  es.addEventListener('event.update', (e) => { const { sessionId, event } = JSON.parse(e.data); onUpdate(sessionId, event); });
  es.addEventListener('session.update', (e) => onSession(JSON.parse(e.data)));
  es.addEventListener('deck.update', (e) => onDeck(JSON.parse(e.data)));
  es.addEventListener('shell.output', (e) => shellOutput(JSON.parse(e.data)));
  es.addEventListener('shell.exit', (e) => shellExit(JSON.parse(e.data)));
}
function setConn(on) {
  if (restarting) return;
  $('conn').classList.toggle('on', on);
  connTitle(on ? 'Server connected · click to restart it' : 'Server offline · click to restart it');
}

// ------------------------------------------------------------ restart backend
// The server relaunches itself on the same port; once a new instance answers,
// drop the cached shell and reload so the UI matches the new backend.
let restarting = false;
function connTitle(t) { $('conn').title = t; $('conn').setAttribute('aria-label', t); }
$('conn').addEventListener('click', async () => {
  if (restarting) return;
  const live = [...state.deck.values()].filter(d => d.alive).length;
  const ok = await confirmDialog('Restart the backend?',
    `The deck server restarts and this window reloads.${live ? ` ${live} session${live > 1 ? 's' : ''} launched from the deck will end; you can resume ${live > 1 ? 'them' : 'it'} afterwards.` : ''}`, 'Restart');
  if (ok) restartBackend();
});
async function restartBackend() {
  let before;
  try { before = (await api.post('/api/restart')).startedAt; }
  catch (e) { toast(`Restart failed: ${e.message}`); return; }
  restarting = true;
  es?.close(); clearTimeout(launch.timer); launch.timer = null;
  $('conn').classList.remove('on'); $('conn').classList.add('restarting'); connTitle('Server restarting…'); $('conn').disabled = true;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok && (await r.json()).startedAt !== before) return hardReload();
    } catch { /* still down */ }
  }
  restarting = false; $('conn').disabled = false;
  toast('The backend did not come back. Check ~/.agent-deck/server.log.');
  setConn(false); watchBackend(0);
}
async function hardReload() {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* no cache api */ }
  location.reload();
}

// ------------------------------------------------------------ backend / launch screen
// The installed app can open with no backend (the service worker serves the
// shell). Probe first; if it isn't reachable, show the welcome screen with a
// Launch button (an agent-deck:// link, see scripts/install-app.sh) and keep
// probing until it answers.
async function probe() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return r.ok ? 'up' : r.status === 401 ? 'auth' : 'down';
  } catch { return 'down'; }
}

const launch = { timer: null, launchedAt: 0 };
function setLaunchStatus(s) {
  const text = { down: `Backend isn't running on ${location.host}`, starting: 'Starting the backend…', auth: 'Backend running · not signed in', up: 'Connected' }[s];
  $('launch-status').dataset.s = s;
  $('launch-status-t').textContent = text;
  $('launch-down').hidden = s === 'auth' || s === 'up';
  $('launch-auth').hidden = s !== 'auth';
  $('launch-help').hidden = !(launch.launchedAt && Date.now() - launch.launchedAt > 8000 && s !== 'auth');
}
function showLaunch(s) {
  const el = $('launch');
  if (el.hidden) { el.hidden = false; (s === 'auth' ? $('launch-token') : $('launch-go')).focus(); }
  setLaunchStatus(s === 'down' && launch.launchedAt ? 'starting' : s);
}
function hideLaunch() {
  $('launch').hidden = true;
  launch.launchedAt = 0;
  clearTimeout(launch.timer); launch.timer = null;
}

/** Poll until the backend answers, then (re)connect the stream. */
function watchBackend(delay = 2500) {
  if (launch.timer) return;
  launch.timer = setTimeout(async () => {
    launch.timer = null;
    if (es && es.readyState === EventSource.OPEN) return hideLaunch();
    const s = await probe();
    if (s === 'up') {
      if (!es || es.readyState === EventSource.CLOSED) { es?.close(); start(); } // EventSource gives up after a 401
      return;
    }
    showLaunch(s);
    watchBackend(launch.launchedAt ? 1000 : 2000);
  }, delay);
}

$('launch-go').addEventListener('click', () => {
  launch.launchedAt = Date.now();
  setLaunchStatus('starting');
  setTimeout(() => { if (!$('launch').hidden) setLaunchStatus($('launch-status').dataset.s); }, 8500);
  clearTimeout(launch.timer); launch.timer = null; watchBackend(600);
});
$('launch-auth').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('launch-token').value.trim();
  if (t) location.href = `/?t=${encodeURIComponent(t)}`; // the server sets the cookie and redirects back to /
});

let started = false;
/** First contact with a live backend: open the stream and load the initial state. */
function start() {
  hideLaunch();
  connect();
  if (started) return;
  started = true;
  loadShellHistory();
  api.get('/api/briefs').then(r => { for (const [id, b] of Object.entries(r.briefs)) state.briefs.set(id, b); state.narrator = { ...state.narrator, ...r.narrator }; refreshBriefViews(); }).catch(() => {});
  api.get('/api/sessions').then(snap => {
    applySnapshot(snap);
    if (prefs.selected && state.byId.has(prefs.selected)) select(prefs.selected);
    else goOverview();
  }).catch(() => goOverview());
}

async function boot() {
  const s = await probe();
  if (s === 'up') start();
  else { goOverview(); showLaunch(s); watchBackend(); }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works, just not offline */ });

/** Tell the server which session this tab shows, so its brief refreshes on the fast cadence. */
function reportView() {
  if (!state.clientId) return;
  api.post('/api/view', { clientId: state.clientId, sessionId: document.visibilityState === 'visible' ? state.selected : null }).catch(() => {});
}
document.addEventListener('visibilitychange', reportView);

function applySnapshot(snap) {
  state.snapshot = snap;
  state.byId.clear();
  for (const b of ['active', 'recent', 'closed']) for (const s of state.snapshot[b]) { state.byId.set(s.id, s); for (const a of s.subagents || []) state.byId.set(a.id, a); if (s.deck) state.deck.set(s.id, s.deck); }
  renderTree();
  if (state.pendingOpen && state.byId.has(state.pendingOpen)) openLaunched(state.pendingOpen);
  else if (state.selected) renderHeader(); else scheduleOverview();
}

function onSession({ id, meta, brief, summary }) {
  const c = ensureCache(id);
  c.meta = meta; c.brief = brief;
  if (summary) {
    const prev = state.byId.get(id);
    if (prev?.glance && !summary.glance) summary.glance = prev.glance;
    if (prev?.hidden) summary.hidden = true;   // closed is the deck's, not the index's; snapshots carry it
    c.summary = summary; state.byId.set(id, summary); for (const a of summary.subagents || []) state.byId.set(a.id, a);
    if (summary.deck) state.deck.set(id, summary.deck);
    for (const b of ['active', 'recent', 'closed']) { const i = state.snapshot[b].findIndex(x => x.id === id); if (i >= 0) state.snapshot[b][i] = summary; }
    scheduleTree();
  }
  if (id === state.selected) { renderHeader(); renderQueue(); renderBackground(); }
  if (state.detailsKey?.startsWith(`task:${id}:`)) showTaskDetails(id, state.detailsKey.slice(`task:${id}:`.length), true);
  if (summary?.subagents?.some(a => state.expanded.has(a.id)) && state.selected === id) scheduleRows();
}

function ensureCache(id) {
  if (!state.cache.has(id)) state.cache.set(id, { events: [], byId: new Map(), lastSeq: 0, meta: null, brief: null, summary: null, loaded: false, loading: null });
  return state.cache.get(id);
}

function onEvents(sessionId, events) {
  const c = state.cache.get(sessionId);
  if (!c || !c.loaded) return;
  let added = 0;
  for (const ev of events) {
    if (ev.seq <= c.lastSeq) continue;
    c.events.push(ev); c.byId.set(ev.id, ev); c.lastSeq = ev.seq; added++;
  }
  if (added && visibleSession(sessionId)) scheduleRows();
}
function onUpdate(sessionId, ev) {
  const c = state.cache.get(sessionId);
  if (!c || !c.loaded) return;
  const old = c.byId.get(ev.id);
  if (!old) return;
  const i = c.events.indexOf(old);
  if (i >= 0) c.events[i] = ev;
  c.byId.set(ev.id, ev);
  if (visibleSession(sessionId)) { scheduleRows(); if (state.cursor === ev.id) showEventDetails(ev, true); }
}
function visibleSession(id) { return id === state.selected || state.expanded.has(id); }

async function catchUp(id) {
  const c = state.cache.get(id);
  if (!c?.loaded) return;
  try {
    let more = true;
    while (more) {
      const r = await api.get(`/api/sessions/${sid(id)}/events?from=${c.lastSeq}`);
      onEvents(id, r.events); more = r.more;
    }
  } catch (e) { console.warn(e); }
}

async function loadSession(id) {
  const c = ensureCache(id);
  if (c.loaded) return c;
  if (c.loading) return c.loading;
  c.loading = (async () => {
    const info = await api.get(`/api/sessions/${sid(id)}`);
    c.meta = info.meta; c.brief = info.brief; c.summary = info.summary;
    let from = 0, more = true;
    while (more) {
      const r = await api.get(`/api/sessions/${sid(id)}/events?from=${from}&limit=4000`);
      for (const ev of r.events) { c.events.push(ev); c.byId.set(ev.id, ev); c.lastSeq = ev.seq; }
      from = c.lastSeq; more = r.more;
    }
    c.loaded = true; c.loading = null;
    return c;
  })();
  try { return await c.loading; } catch (e) { c.loading = null; throw e; }
}

// ------------------------------------------------------------ rail
let treeTimer = null;
function scheduleTree() { if (!treeTimer) treeTimer = requestAnimationFrame(() => { treeTimer = null; renderTree(); }); }

function sessRow(s, nested = false) {
  const phase = phaseOf(s);
  const sig = sigOf(s);
  const isAgent = s.kind === 'agent';
  const st = !isAgent && (phase === 'turn' || phase === 'working') ? statusOf(s, null, phase) : null;
  const meta = isAgent ? [s.agentType, s.worktreeBranch].filter(Boolean).join(' · ')
    : [s.gitBranch, s.pr ? `PR #${s.pr.number}` : null, ...(s.alive && !s.hidden ? [sig === 'input' || sig === 'error' ? st?.head.toLowerCase() : null] : [])].filter(Boolean).join(' · ');
  // The folder leads a session's second line; rows are not grouped by it.
  const sub = isAgent || nested ? (meta ? [meta] : null)
    : [h('span', { class: 'fld' }, svgUse('i-folder', 11), s.project || '?'), meta ? ` · ${meta}` : null];
  // No native tooltips: the hover card says all of it.
  const btn = h('button', { type: 'button', class: `sess${isAgent || nested ? ' agent' : ''}${s.id === state.selected ? ' selected' : ''}${phase === 'ended' && !isAgent ? ' dim' : ''}`, dataset: { id: s.id }, 'aria-label': `${s.title || s.id} · ${st?.head || SIG_LABEL[sig]}` },
    h('span', { class: `dot sig-${sig}${st?.quiet ? ' quiet' : ''}` }),
    h('span', { class: 't' }, h('span', { class: 'tt' }, s.title || s.id), sub ? h('span', { class: 'sub' }, ...sub) : null),
    h('span', { class: 'r' }, s.background ? h('span', { class: 'bgc', title: `${s.background} running in the background` }, svgUse('i-bg', 10), String(s.background)) : null, ago(Date.now() - (s.mtime || 0))));
  return h('li', {}, btn);
}

/**
 * A collapsible group under a session row: its subagents ('subs'), or the
 * sessions it started with `claude -p` ('tasks'). Collapsed unless it holds
 * the selection; the user's choice sticks.
 */
const spawnedOf = (s) => (s.spawned || []).map(id => state.byId.get(id)).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
function childBlock(s, kind) {
  const tasks = kind === 'tasks';
  const kids = tasks ? spawnedOf(s) : s.subagents || [];
  const isRun = tasks ? (c) => sigOf(c) === 'working' : (a) => a.status === 'running';
  const isDone = tasks ? (c) => !c.alive || sigOf(c) === 'done' : (a) => a.status === 'done';
  const done = kids.filter(isDone).length;
  const run = kids.filter(isRun).length;
  const key = tasks ? `t:${s.id}` : s.id;
  const containsSel = kids.some(a => a.id === state.selected);
  const open = state.subsOpen.has(key) ? true : state.subsOpen.has('!' + key) ? false : containsSel;
  const li = h('li', { class: `subs${open ? '' : ' collapsed'}`, dataset: { parent: s.id } });
  li.append(h('button', { type: 'button', class: 'subs-h', dataset: { subs: key }, 'aria-expanded': String(open) },
    svgUse('i-down', 10), h('span', {}, tasks ? 'Sub-tasks' : 'Subagents'), h('span', { class: 'muted' }, run || s.alive ? `${done} of ${kids.length} done${run ? ` · ${run} running` : ''}` : String(kids.length))));
  const bar = h('div', { class: 'bar', 'aria-hidden': 'true' });
  if (done) bar.append(h('span', { class: 'b-done', style: `flex-grow:${done}` }));
  if (run) bar.append(h('span', { class: 'b-run', style: `flex-grow:${run}` }));
  if (kids.length - done - run) bar.append(h('span', { class: 'b-other', style: `flex-grow:${kids.length - done - run}` }));
  li.append(bar);
  const out = [li];
  if (open) {
    const order = [...kids].sort((a, b) => isRun(b) - isRun(a) || b.mtime - a.mtime);
    const all = state.subsAll.has(key) || containsSel;
    const shown = all ? order : order.slice(0, 4);
    for (const a of shown) out.push(sessRow(a, true));
    if (order.length > 4 && !containsSel) out.push(h('li', {}, h('button', { type: 'button', class: 'more', dataset: { more: key } }, all ? 'Show fewer' : `+ ${order.length - 4} more`)));
  }
  return out;
}

function matchesQuery(s, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return [s.title, s.project, s.cwd, s.gitBranch, s.id, s.pr ? `#${s.pr.number}` : null].some(x => x && String(x).toLowerCase().includes(q))
    || (s.subagents || []).some(a => a.title?.toLowerCase().includes(q))
    || (s.spawned || []).some(id => state.byId.get(id)?.title?.toLowerCase().includes(q));
}
const matchesTree = (s) => matchesQuery(s, state.treeFilter);

/**
 * The rail's buckets. The server sorts by process: alive, recent file,
 * closed. The rail sorts by work: Active holds only sessions mid-turn (or
 * stopped mid-turn on you); a live session whose turn finished is Recent.
 */
const busy = (s) => sigOf(s) === 'working' || needsYou(s);
// Sessions another session started sit under it, not in the buckets.
const nestedChild = (s) => !!s.spawnedBy && state.byId.has(s.spawnedBy);
function railLists() {
  const snap = state.snapshot;
  const top = (list) => list.filter(s => !nestedChild(s));
  return {
    active: top(snap.active).filter(busy),
    recent: top([...snap.active.filter(s => !busy(s)), ...snap.recent]).sort((a, b) => b.mtime - a.mtime),
    closed: top(snap.closed),
  };
}

function renderTree() {
  const snap = state.snapshot;
  const lists = railLists();
  for (const b of ['active', 'recent', 'closed']) {
    const sec = document.querySelector(`.bucket[data-bucket=${b}]`);
    const ul = sec.querySelector('ul');
    const list = lists[b].filter(matchesTree);
    sec.querySelector('.count').textContent = list.length || '';
    const frag = document.createDocumentFragment();
    for (const s of list) {
      frag.append(sessRow(s));
      if (s.subagents?.length) frag.append(...childBlock(s, 'subs'));
      if (spawnedOf(s).length) frag.append(...childBlock(s, 'tasks'));
    }
    ul.replaceChildren(frag);
  }
  const total = snap.active.length + snap.recent.length + snap.closed.length;
  renderMini(lists);
  $('tree-foot').textContent = `${total} sessions · ${snap.active.length} live`;
  // A background tab still shows how many sessions need you.
  const needs = snap.active.filter(needsYou).length;
  document.title = needs ? `(${needs}) Agent Deck` : 'Agent Deck';
  // The rows were rebuilt: keep an open card on its (new) anchor.
  if (card.id && !OWN_CARDS.has(card.id)) {
    const anchor = document.querySelector(`#${prefs.railMin ? 'mini' : 'tree'} [data-id="${CSS.escape(card.id)}"]`);
    anchor ? showCard(card.id, anchor, true) : hideCard(true);
  }
  if ($('history').open) renderHistory();
}
// ------------------------------------------------------------ needs you
// The server turns signal changes into entries with a sentence to speak
// (lib/attention.mjs). The sentence goes to a polite live region, so a screen
// reader announces when a session needs you or finishes, and the entry goes
// to read aloud, which decides by its settings whether to speak it.
function narrate(entry) {
  if (entry.initial) return;
  const worth = entry.needsYou || (entry.signal === 'done' && entry.from === 'working');
  if (!worth || !entry.say) return;
  const el = $('announcer');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = entry.say; });
  const kind = entry.signal === 'input' ? 'needs' : entry.signal === 'error' ? 'error' : 'done';
  narration.auto({ id: `att:${entry.id}:${entry.at}`, sessionId: entry.id, kind, permission: entry.need?.kind === 'permission', markdown: kind === 'done' ? '' : entry.need?.text || '' });
}

// ------------------------------------------------------------ read aloud
// The player is public/narration.js (PLAN.md §7); here are only the hooks:
// live events in, the title bar controls, Read aloud buttons, the speaker
// under the prompt box, and holding the queue while the pilot types.
const titleFor = (id) => state.byId.get(id)?.title || state.cache.get(id)?.summary?.title || 'A session';
const narration = createNarration({
  prefs, savePrefs, api, host: $('deck'),
  isSubagent: (id) => state.byId.get(id)?.kind === 'agent',
  inScope: (id) => id === state.selected || state.byId.get(id)?.parentId === state.selected,
  titleOf: titleFor,
  onChange: renderReadAloud,
  onJump: jumpToNarration,
  onWarn: (msg) => toast(msg),
});
/** Live events only: catch-up and session loads go through onEvents, never here. */
function narrateEvents(sessionId, events) {
  for (const ev of events) {
    if (ev.kind === 'text' && ev.text?.trim()) narration.auto({ id: `${sessionId}:${ev.id}`, sessionId, eventId: ev.id, kind: 'said', markdown: ev.text });
    else if (ev.kind === 'system' && ev.subtype === 'task' && ev.status && ev.status !== 'running') narration.auto({ id: `${sessionId}:${ev.id}`, sessionId, eventId: ev.id, kind: 'background', markdown: ev.text });
  }
}
function narrateBrief(b) {
  const prev = state.briefs.get(b.id);
  if (b.brief?.summary && b.updatedAt && b.updatedAt !== prev?.updatedAt) narration.auto({ id: `brief:${b.id}:${b.updatedAt}`, sessionId: b.id, kind: 'brief', markdown: b.brief.summary });
}
function briefMarkdown(id) {
  const cur = state.briefs.get(id)?.brief;
  if (!cur) { const last = state.cache.get(id)?.brief?.lastText; return last ? `Last said: ${last}` : ''; }
  const parts = [cur.summary || ''];
  if (cur.done?.length) parts.push('**Done so far**', cur.done.map(x => `- ${x}`).join('\n'));
  if (cur.next) parts.push(`**Next:** ${cur.next}`);
  if (cur.watch?.text) parts.push(`**Watch:** ${cur.watch.text}`);
  return parts.filter(Boolean).join('\n\n');
}
function readBrief(id) { const md = briefMarkdown(id); if (md) narration.read({ sessionId: id, kind: 'brief', markdown: md }); }
function readEvent(ev) {
  if (!ev || !['text', 'prompt', 'thinking'].includes(ev.kind) || !ev.text) return false;
  narration.read({ sessionId: ev.sessionId, eventId: ev.id, kind: 'said', markdown: ev.text });
  return true;
}
async function jumpToNarration() {
  const it = narration.current();
  if (!it?.sessionId) return;
  await select(it.sessionId);
  const ev = it.eventId && findEvent(it.sessionId, it.eventId);
  if (ev) jumpToSeq(ev.seq);
}
function renderReadAloud(st) {
  const btn = $('ra-btn');
  btn.classList.toggle('off', !st.on);
  btn.classList.toggle('speaking', st.state === 'playing');
  btn.classList.toggle('blocked', st.state === 'blocked');
  btn.querySelector('use').setAttribute('href', st.on ? '#i-speaker' : '#i-speaker-off');
  btn.title = st.state === 'blocked' ? 'Read aloud: click anywhere to let the deck speak' : !st.on ? 'Read aloud: off' : !st.leader ? 'Read aloud: another deck window is speaking' : 'Read aloud';
  // Play/pause is always there: pausing with nothing playing makes new items wait in the queue.
  const paused = st.state === 'paused' || st.state === 'blocked';
  const playing = st.state === 'playing';
  const pb = $('ra-play');
  pb.classList.toggle('paused', paused);
  pb.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  pb.title = pb.ariaLabel = paused ? `Play${st.queued ? ` · ${st.queued} queued` : ''} (Space)`
    : st.state === 'held' ? 'Pause · held while you type (Space)'
    : playing ? 'Pause (Space)' : 'Pause: queue narration until you press play (Space)';
  const nb = $('ra-next');
  nb.disabled = !st.item && !st.queued;
  nb.title = nb.ariaLabel = st.queued ? `Next (]) · ${st.queued} queued` : 'Next (])';
  const bn = $('bell').querySelector('.bell-n');
  bn.hidden = !st.unheard;
  bn.textContent = st.unheard > 99 ? '99+' : String(st.unheard || '');
  $('bell').title = $('bell').ariaLabel = `Narration history${st.unheard ? ` · ${st.unheard} unheard` : ''} (b)`;
  if ($('bell-pop').matches(':popover-open')) renderBellList();
  const now = $('ra-now');
  now.hidden = !st.item;
  now.classList.toggle('playing', playing);
  if (st.item) { now.querySelector('.ra-now-t').textContent = `${playing ? 'Reading' : 'Paused'}: ${st.item.title}`; now.title = 'Open this in the session (j)'; }
}
$('ra-play').onclick = () => narration.toggle();
$('ra-next').onclick = () => narration.skip();

// The bell: every narration event, newest first. A dot marks what is still
// queued to be read; a row opens its event (play it from the details pane).
const bell = { q: '', unheardOnly: false, i: 0, ids: [] };
function bellText(e) {
  const t = String(e.text || '').replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
  if (e.kind === 'done') return 'Finished';
  if (e.kind === 'needs') return `${e.permission ? 'Needs your permission' : 'Asking'}${t ? `: ${t}` : ''}`;
  if (e.kind === 'error') return `Error${t ? `: ${t}` : ''}`;
  return t;
}
function renderBell() {
  const pop = $('bell-pop');
  const input = h('input', { type: 'search', placeholder: 'Search narration', value: bell.q, spellcheck: 'false', 'aria-label': 'Search narration',
    oninput: (e) => { bell.q = e.target.value; bell.i = 0; renderBellList(); },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); bell.i = Math.max(0, Math.min(bell.ids.length - 1, bell.i + (e.key === 'ArrowDown' ? 1 : -1))); renderBellList(); }
      else if (e.key === 'Enter') { e.preventDefault(); openBellEntry(bell.ids[bell.i]); }
    } });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
    h('button', { type: 'button', 'aria-pressed': String(!bell.unheardOnly), onclick: () => { bell.unheardOnly = false; renderBell(); } }, 'All'),
    h('button', { type: 'button', 'aria-pressed': String(bell.unheardOnly), onclick: () => { bell.unheardOnly = true; renderBell(); } }, 'Unheard'));
  pop.replaceChildren(
    h('div', { class: 'bell-h' }, h('label', { class: 'search grow' }, svgUse('i-search', 13), input), seg),
    h('ul', { class: 'bell-list', role: 'listbox', 'aria-label': 'Narration history' }),
    h('div', { class: 'bell-f' }, h('span', { class: 'muted bell-count' }), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'linkish', onclick: () => narration.markAllHeard() }, 'Mark all heard'),
      h('button', { type: 'button', class: 'linkish', onclick: async () => { if (await confirmDialog('Clear the narration history?', 'The list empties. Nothing queued is affected.', 'Clear')) narration.clearHistory(); } }, 'Clear')));
  renderBellList();
  return input;
}
function renderBellList() {
  const pop = $('bell-pop');
  const list = pop.querySelector('.bell-list');
  if (!list) return;
  const { entries, unheard } = narration.history();
  const q = bell.q.trim().toLowerCase();
  const shown = entries.filter(e => (!bell.unheardOnly || unheard.has(e.id))
    && (!q || `${e.title} ${narration.kindLabel(e.kind)} ${e.text}`.toLowerCase().includes(q)));
  bell.ids = shown.map(e => e.id);
  bell.i = Math.min(bell.i, Math.max(0, shown.length - 1));
  const now = Date.now();
  list.replaceChildren(...shown.slice(0, 200).map((e, i) => h('li', { class: `bell-row${i === bell.i ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === bell.i), dataset: { id: e.id },
      onclick: () => openBellEntry(e.id), onmousemove: () => { if (bell.i !== i) { bell.i = i; list.querySelector('.sel')?.classList.remove('sel'); list.children[i]?.classList.add('sel'); } } },
    h('span', { class: `bell-dot${unheard.has(e.id) ? ' on' : ''}`, title: unheard.has(e.id) ? 'Not read yet' : null }),
    h('span', { class: 'bell-main' },
      h('span', { class: 'bell-top' }, h('span', { class: `chip narr-k k-${e.kind}` }, narration.kindLabel(e.kind)), h('b', {}, e.title), h('span', { class: 'spacer' }), h('span', { class: 'muted bell-ago', title: new Date(e.at).toLocaleString() }, ago(now - e.at))),
      h('span', { class: 'bell-t' }, oneLine(bellText(e), 220))))));
  if (!shown.length) list.append(h('li', { class: 'bell-empty muted' }, entries.length ? 'Nothing matches.' : 'Narration events show up here as sessions speak.'));
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  pop.querySelector('.bell-count').textContent = `${entries.length} ${entries.length === 1 ? 'event' : 'events'}${unheard.size ? ` · ${unheard.size} unheard` : ''}`;
}
async function openBellEntry(id) {
  const e = narration.history().entries.find(x => x.id === id);
  if (!e?.sessionId) return;
  $('bell-pop').hidePopover();
  if (!state.byId.has(e.sessionId) && !state.cache.has(e.sessionId)) { toast('That session is no longer listed'); return; }
  await select(e.sessionId);
  const ev = e.eventId && findEvent(e.sessionId, e.eventId);
  if (ev) jumpToSeq(ev.seq);
}
$('bell-pop').addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  const r = $('bell').getBoundingClientRect();
  $('bell-pop').style.top = `${r.bottom + 6}px`;
  $('bell-pop').style.left = `${Math.max(8, r.left - 8)}px`;
  bell.i = 0;
  renderBell().focus();
});
$('ra-now').onclick = () => jumpToNarration();
$('ra-pop').addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  const pop = $('ra-pop'), r = $('ra-btn').getBoundingClientRect();
  narration.renderSettings(pop);
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.right = `${Math.max(8, innerWidth - r.right - 8)}px`;
});
// New items wait while the pilot types; they play once the prompt is sent or the field is left.
for (const el of [$('compose'), $('ns-prompt')]) {
  el.addEventListener('input', () => narration.hold(true));
  el.addEventListener('blur', () => narration.hold(false));
}
$('ask').addEventListener('input', () => narration.hold(true));
$('ask').addEventListener('focusout', () => narration.hold(false));
renderReadAloud(narration.status());

// ------------------------------------------------------------ plan quota
// A small ring in the top bar: how full the tightest plan window is. Quiet
// while there is room, amber when it is getting close, red when limited.
// Hover for every number the deck has; click to check again. The numbers come
// from `claude /usage` (free, polled by the server) and from model calls.
const WINDOW_LABEL = { five_hour: '5-hour session', seven_day: 'Weekly · all models' };
const winLabel = (w) => (typeof w === 'string' ? WINDOW_LABEL[w] : WINDOW_LABEL[w.key] || w.label?.replace(/^Week \((.+)\)$/, 'Weekly · $1')) || (w.key || w).replace(/_/g, ' ');
const pct = (u) => `${Math.round(u * 100)}%`;
// Hours and minutes: a reset "in 1h" that is really 1h 59m away misleads.
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60);
  if (hh < 48) return `${hh}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(hh / 24)}d${hh % 24 ? ` ${hh % 24}h` : ''}`;
}
function quotaTone(lim) {
  if (!lim) return 'none';
  const max = Math.max(0, ...lim.windows.map(w => w.utilization));
  if (lim.status === 'rejected' || max >= 0.95) return 'crit';
  if (lim.status === 'allowed_warning' || max >= 0.75 || lim.windows.some(w => w.pace?.hitsBeforeReset)) return 'warn';
  return 'ok';
}
function renderQuota() {
  const lim = state.usage?.limits;
  const btn = $('quota');
  const tone = quotaTone(lim);
  // The ring tracks the fullest window; the number is that window's use.
  const top = lim?.windows.length ? lim.windows.reduce((a, w) => (w.utilization > a.utilization ? w : a)) : null;
  btn.className = `quota ${tone}`;
  btn.querySelector('.qa').setAttribute('stroke-dasharray', `${top ? Math.min(100, Math.round(top.utilization * 100)) : 0} 100`);
  // The title bar has room for both everyday windows; the ring is the fullest of all.
  const shown = ['five_hour', 'seven_day'].map(k => lim?.windows.find(w => w.key === k)).filter(Boolean);
  btn.querySelector('.qpct').textContent = shown.length ? shown.map(w => `${w.key === 'five_hour' ? 'Session' : 'Week'} ${pct(w.utilization)}`).join(' · ') : top ? pct(top.utilization) : 'Plan usage –';
  btn.setAttribute('aria-label', top ? `Plan usage: ${winLabel(top)} ${pct(top.utilization)}${lim.status === 'rejected' ? ', limited' : ''}` : 'Plan usage: not known yet');
  if (card.id === 'quota') showUsageCard(true);
}
function untilText(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  const at = new Date(ts);
  const sameDay = at.toDateString() === new Date().toDateString();
  const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `resets ${ms > 0 ? `in ${dur(ms)}` : 'now'} · ${sameDay ? clock : `${at.toLocaleDateString([], { weekday: 'short' })} ${clock}`}`;
}
function usageCardBody() {
  const u = state.usage || {};
  const lim = u.limits;
  const n = u.narrator || state.narrator || {};
  const tone = quotaTone(lim);
  const rows = [];
  const statusTxt = !lim ? 'unknown' : lim.status === 'rejected' ? 'Limited' : lim.status === 'allowed_warning' ? 'Near the limit' : tone === 'warn' ? 'Filling up' : 'Room to work';
  rows.push(h('div', { class: 'hc-h' }, h('b', {}, 'Plan usage'), h('span', { class: `uq-st ${tone}` }, statusTxt)));
  if (lim?.account) rows.push(h('div', { class: 'uq-acct' }, lim.account.replace(/^You are currently using /, 'Using ').replace(/ to power your Claude Code usage$/, '')));
  if (u.error) rows.push(h('div', { class: 'uq-err' }, u.error.message));
  if (!lim) {
    rows.push(h('p', { class: 'hc-sum muted' }, u.error ? 'No quota reading yet.' : 'Reading claude /usage…'));
  } else {
    for (const w of lim.windows) {
      const wt = w.utilization >= 0.95 ? 'crit' : w.utilization >= 0.75 || w.pace?.hitsBeforeReset ? 'warn' : 'ok';
      const row = h('div', { class: 'uq-w' },
        h('div', { class: 'uq-l' }, h('b', {}, winLabel(w)), h('span', { class: `uq-p ${wt}` }, pct(w.utilization))),
        h('div', { class: 'uq-bar' }, h('span', { class: wt, style: `width:${Math.min(100, w.utilization * 100)}%` }),
          w.pace?.atReset != null && w.pace.atReset > w.utilization ? h('i', { style: `left:${Math.min(100, w.pace.atReset * 100)}%`, title: `projected ${pct(Math.min(1, w.pace.atReset))} at reset` }) : null),
        h('div', { class: 'uq-r' }, untilText(w.resetsAt)));
      // The pace: is this window going to run out before it resets?
      const p = w.pace;
      if (p && p.perHour > 0) {
        row.append(h('div', { class: `uq-pace${p.hitsBeforeReset ? ' warn' : ''}` },
          p.hitsBeforeReset ? `At this pace it runs out in ~${dur(p.fullInMs)}, before the reset.`
            : `At this pace: ~${pct(Math.min(1, p.atReset ?? w.utilization))} by the reset (${(p.perHour * 100).toFixed(1)} points an hour over the last ${dur(p.sinceMs)}).`));
      } else if (p) row.append(h('div', { class: 'uq-pace' }, `No change over the last ${dur(p.sinceMs)}.`));
      rows.push(row);
    }
    const extra = lim.isUsingOverage ? 'in use now' : lim.overageStatus === 'rejected' ? `off${lim.overageDisabledReason ? ` (${lim.overageDisabledReason.replace(/_/g, ' ')})` : ''}` : lim.overageStatus || null;
    if (extra) rows.push(h('div', { class: 'hc-f' }, h('span', {}, `Extra usage: ${extra}`)));
    for (const n of lim.notes || []) rows.push(h('div', { class: 'hc-f' }, h('span', {}, n)));
  }
  // What claude /usage says is driving it (this machine only).
  const c = lim?.contributors;
  if (c?.sections?.length) {
    rows.push(h('div', { class: 'uq-sec', title: c.note || '' }, h('b', {}, 'What’s driving usage'), h('span', {}, 'this machine')));
    for (const sec of c.sections) rows.push(h('div', { class: 'uq-why' }, h('b', {}, sec.title), h('ul', {}, ...sec.items.map(x => h('li', {}, x)))));
  }
  // What the deck itself spends on briefs, Ask and quota checks.
  const by = n.byPurpose || {};
  const kinds = Object.entries(by).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (kinds.length) {
    rows.push(h('div', { class: 'uq-sec' }, h('b', {}, 'This deck’s model calls'), h('span', {}, `${fmtUsd(n.totalCostUsd || 0)} · ${n.calls || 0} calls`)));
    rows.push(h('div', { class: 'uq-tbl' }, ...kinds.map(([k, v]) => h('div', {}, h('span', {}, k[0].toUpperCase() + k.slice(1)), h('span', {}, `${v.calls}`), h('span', {}, fmtUsd(v.costUsd)), h('span', {}, `${(v.ms / v.calls / 1000).toFixed(1)}s avg`)))));
    rows.push(h('div', { class: 'hc-f' }, h('span', {}, `models: brief ${n.briefModel || '?'} · ask ${n.askModel || '?'}`)));
  }
  // What the live sessions have spent, biggest first.
  // Transcripts do not always record cost; output tokens are the fallback measure.
  const live = state.snapshot.active.filter(s => s.glance?.cost != null || s.glance?.outTokens)
    .sort((a, b) => (b.glance.cost ?? 0) - (a.glance.cost ?? 0) || (b.glance.outTokens || 0) - (a.glance.outTokens || 0));
  if (live.length) {
    const total = live.reduce((x, s) => x + (s.glance.cost || 0), 0);
    const out = live.reduce((x, s) => x + (s.glance.outTokens || 0), 0);
    rows.push(h('div', { class: 'uq-sec' }, h('b', {}, 'Live sessions'), h('span', {}, [total ? fmtUsd(total) : null, out ? `${fmtTokens(out)} tokens out` : null].filter(Boolean).join(' · '))));
    rows.push(h('div', { class: 'uq-tbl three' }, ...live.slice(0, 5).map(s => h('div', {}, h('span', {}, oneLine(s.title, 30)),
      h('span', {}, s.glance.outTokens ? `${fmtTokens(s.glance.outTokens)} out` : ''), h('span', {}, s.glance.cost != null ? fmtUsd(s.glance.cost) : '')))));
  }
  rows.push(h('div', { class: 'hc-foot' },
    lim ? `as of ${ago(lim.ageMs + (Date.now() - (u._at || Date.now())))} ago · from ${lim.source || 'a model call'}` : 'not checked yet',
    h('span', { class: 'spacer' }), 'click to check now'));
  return rows;
}
function showUsageCard(refresh = false) {
  const el = $('hovercard'); const a = $('quota');
  clearTimeout(card.timer);
  card.id = 'quota'; card.anchor = a;
  el.replaceChildren(...usageCardBody());
  el.hidden = false;
  // Hangs from the meter in the title bar, kept on screen.
  const r = a.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth + 8));
  const top = r.bottom + 6;
  el.style.left = `${left}px`; el.style.top = `${top}px`;
  if (!refresh) el.classList.remove('in'), void el.offsetWidth, el.classList.add('in');
}
$('quota').addEventListener('mouseenter', () => { clearTimeout(card.timer); card.timer = setTimeout(() => showUsageCard(), 160); });
$('quota').addEventListener('mouseleave', () => hideCard());
$('quota').addEventListener('focus', () => showUsageCard());
$('quota').addEventListener('blur', () => hideCard());
$('quota').onclick = async () => {
  $('quota').classList.add('checking');
  try { const r = await api.post('/api/usage/refresh'); state.usage = { ...r, _at: Date.now() }; renderQuota(); }
  catch (e) { toast(`Quota check failed: ${e.message}`); }
  finally { $('quota').classList.remove('checking'); }
};
// Reset countdowns and "as of" age move on their own.
setInterval(() => { if (card.id === 'quota') showUsageCard(true); }, 15_000);

// ------------------------------------------------------------ minimized rail
// Collapsed, the rail is a grid of two-letter chips: Active, then the live
// sessions in Recent (waiting on their next prompt).
// Each chip's outline and letters take its status colour (a ping when it
// waits on an answer, badges for subagents and queued prompts); hovering or
// focusing one opens the same card as the full rail's rows.
function setRailMin(on) {
  prefs.railMin = on; savePrefs();
  $('deck').classList.toggle('rail-min', on);
  const t = $('rail-toggle');
  t.setAttribute('aria-expanded', String(!on));
  t.title = t.ariaLabel = on ? 'Expand the session list ([)' : 'Collapse the session list ([)';
  t.querySelector('use').setAttribute('href', on ? '#i-right' : '#i-left');
  hideCard(true);
  renderTree(); renderRows();
}
$('rail-toggle').onclick = () => setRailMin(!prefs.railMin);

const initials = (t) => {
  const w = String(t || '?').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || w[0]?.[1] || '')).toUpperCase();
};
function miniChip(s) {
  const phase = phaseOf(s);
  const st = phase === 'turn' || phase === 'working' ? statusOf(s, null, phase) : null;
  const runSubs = (s.subagents || []).filter(a => a.status === 'running').length;
  const q = deckOf(s.id)?.queue?.length || 0;
  const sig = sigOf(s);
  const chip = h('button', { type: 'button', class: `mchip sig-${sig}${st?.quiet ? ' quiet' : ''}${s.id === state.selected ? ' selected' : ''}`,
    dataset: { id: s.id }, 'aria-label': `${s.title} · ${st?.head || SIG_LABEL[sig]}` }, h('span', { class: 'mi' }, initials(s.title)));
  if (runSubs) chip.append(h('span', { class: 'mb subs', 'aria-hidden': 'true' }, String(runSubs)));
  if (q) chip.append(h('span', { class: 'mb q', 'aria-hidden': 'true' }, String(q)));
  return chip;
}
function renderMini(lists) {
  if (!prefs.railMin) return;
  const out = lists.active.map(miniChip);
  // Only sessions whose process is still running; finished and closed ones stay in the full list.
  const recent = lists.recent.filter(s => s.alive).slice(0, 8);
  if (out.length && recent.length) out.push(h('hr'));
  out.push(...recent.map(miniChip));
  $('mini').replaceChildren(...out);
}
// Clicking opens the session and puts the card away until the pointer leaves that chip.
$('mini').addEventListener('click', (e) => { const b = e.target.closest('.mchip'); if (b) { card.quiet = b.dataset.id; hideCard(true); select(b.dataset.id); } });

// The hover card: everything worth knowing before deciding to open a session.
// The same card serves the full rail's rows and the minimized rail's chips.
const card = { id: null, anchor: null, timer: null, quiet: null };
// Cards that are not a session's: the rail's hover logic leaves these alone.
const OWN_CARDS = new Set(['quota', 'details', 'inference']);
const plural = (n, w, many = w + 's') => `${n} ${n === 1 ? w : many}`;
function cardFacts(s) {
  const g = s.glance || {};
  const isAgent = s.kind === 'agent';
  const d = isAgent ? null : deckOf(s.id);
  const subs = s.subagents || [];
  const runSubs = subs.filter(a => a.status === 'running').length;
  const doneSubs = subs.filter(a => a.status === 'done').length;
  const when = (ts) => ts ? `${ago(Date.now() - ts)} ago · ${new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null;
  const bucket = isAgent ? null : s.hidden ? 'Closed (by you)' : busy(s) ? 'Active' : s.bucket === 'closed' ? 'Closed' : 'Recent';
  return [
    ['Status', [SIG_LABEL[sigOf(s)], bucket].filter(Boolean).join(' · ')],
    isAgent ? ['Subagent of', state.byId.get(s.parentId)?.title || s.parentId] : null,
    isAgent ? ['Type', s.agentType] : null,
    s.spawnedBy ? ['Started by', state.byId.get(s.spawnedBy)?.title || s.spawnedBy] : null,
    ['Folder', tilde(s.cwd), 'mono'],
    ['Branch', s.gitBranch || s.worktreeBranch, 'mono'],
    s.pr ? ['Pull request', `#${s.pr.number}${s.pr.title ? ` · ${oneLine(s.pr.title, 60)}` : ''}`] : null,
    ['Model', (g.model || s.model) ? [(g.model || s.model).replace('claude-', ''), g.effort].filter(Boolean).join(' · ') : null],
    isAgent ? null : ['Control', d?.alive ? `launched by the deck · ${PERM_LABEL[d.permissionMode] || d.permissionMode}` : s.alive ? 'observe only (outside the deck)' : 'not running'],
    s.alive && s.pid ? ['Process', `pid ${s.pid}${s.startedAt ? ` · started ${ago(Date.now() - s.startedAt)} ago` : ''}`] : null,
    ['Last active', when(s.mtime)],
    g.turnMs != null && sigOf(s) === 'working' ? ['This turn', fmtMs(g.turnMs)] : null,
    ['Turns', g.turns || null],
    ['Files touched', g.filesTouched || null],
    g.errors ? ['Errors', `${g.errors}${g.lastErrorTs ? ` · latest ${ago(Date.now() - Date.parse(g.lastErrorTs))} ago` : ''}`, recentErr(s) ? 'err' : ''] : null,
    ['Cost', g.cost != null ? fmtUsd(g.cost) : null],
    ['Output', g.outTokens ? `${fmtTokens(g.outTokens)} tokens` : null],
    s.spawned?.length ? ['Sub-tasks', `${s.spawned.length} session${s.spawned.length === 1 ? '' : 's'} started with claude -p`] : null,
    subs.length ? ['Subagents', [runSubs ? `${runSubs} running` : null, `${doneSubs} done`, `${subs.length} total`].filter(Boolean).join(' · ')] : null,
    d?.alive && (d.queue.length || d.held) ? ['Queue', [d.queue.length ? plural(d.queue.length, 'prompt') : null, d.held ? 'held after interrupt' : null].filter(Boolean).join(' · ')] : null,
    ['Events', s.eventCount || null],
    ['Session', s.id, 'mono'],
  ].filter(r => r && r[1] != null && r[1] !== '');
}
function cardBody(s) {
  const phase = phaseOf(s);
  const g = s.glance || {};
  const st = statusOf(s, null, phase);
  const d = deckOf(s.id);
  const pb = state.briefs.get(s.id);
  const runSubs = (s.subagents || []).filter(a => a.status === 'running');
  const rows = [];
  rows.push(h('div', { class: 'hc-h' }, h('span', { class: `dot sig-${sigOf(s)}${st.quiet ? ' quiet' : ''}` }), h('b', {}, s.title || s.id)));
  // Whose move, and why.
  rows.push(h('div', { class: `hc-st sig-${st.sig}${st.quiet ? ' quiet' : ''}` }, h('span', { class: 'nl-k' }, { claude: 'CLAUDE', you: 'YOU', done: 'DONE', ended: 'ENDED' }[st.who]),
    st.icon ? svgUse(st.icon, 12) : null, h('b', {}, st.head),
    st.clock != null ? h('span', { class: 'hc-clk' }, fmtClock(st.clock)) : st.right ? h('span', { class: 'hc-clk' }, st.right) : null));
  if (st.text) rows.push(h('div', { class: `hc-t${st.mono ? ' mono' : ''}` }, oneLine(st.text, 220)));
  // What it has done: the generated brief, else the last thing it said.
  const sum = pb?.brief?.summary;
  if (sum) rows.push(h('p', { class: 'hc-sum' }, oneLine(sum, 360)));
  else if (g.lastText && !g.asked) rows.push(h('p', { class: 'hc-sum muted' }, 'Last said · ', oneLine(g.lastText, 240)));
  if (pb?.brief?.watch) rows.push(h('div', { class: 'hc-watch' }, h('b', {}, 'WATCH '), oneLine(pb.brief.watch.text, 200)));
  if (pb?.brief?.progress) {
    const p = pb.brief.progress;
    rows.push(h('div', { class: 'hc-prog' }, h('span', {}, `${p.total} ${p.unit}: ` + p.segments.map(x => `${x.count} ${x.label}`).join(', ')),
      h('div', { class: 'prog-b' }, ...p.segments.map(x => h('span', { class: `tone-${x.tone}`, style: `flex-grow:${x.count}` })))));
  }
  rows.push(h('table', { class: 'hc-tbl' }, h('tbody', {}, ...cardFacts(s).map(([k, v, cls]) => h('tr', {}, h('th', {}, k), h('td', { class: cls || null }, String(v)))))));
  if (runSubs.length) rows.push(h('div', { class: 'hc-subs' }, h('b', {}, 'Running'),
    h('ul', {}, ...runSubs.slice(0, 4).map(a => h('li', {}, a.title)), runSubs.length > 4 ? h('li', { class: 'muted' }, `+${runSubs.length - 4} more`) : null)));
  if (d?.alive && d.queue[0]) rows.push(h('div', { class: 'hc-q' }, h('b', {}, 'Next up'), h('div', { class: 'mono muted' }, oneLine(d.queue[0].text, 120))));
  rows.push(h('div', { class: 'hc-foot' }, h('span', { class: 'spacer' }), 'click to open'));
  return rows;
}
function showCard(id, anchor, refresh = false) {
  const s = state.byId.get(id); const el = $('hovercard');
  if (!s || !anchor) { hideCard(true); return; }
  card.id = id; card.anchor = anchor;
  el.replaceChildren(...cardBody(s));
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  // Beside the rail when there is room, else over it.
  const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right + 10));
  const top = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.top - 6));
  el.style.left = `${left}px`; el.style.top = `${top}px`;
  if (!refresh) el.classList.remove('in'), void el.offsetWidth, el.classList.add('in');
}
function hideCard(now = false) {
  clearTimeout(card.timer);
  const go = () => { card.id = null; card.anchor = null; $('hovercard').hidden = true; };
  if (now) go(); else card.timer = setTimeout(go, 120);
}
function hoverCards(root, sel) {
  root.addEventListener('mouseover', (e) => {
    const b = e.target.closest(sel);
    if (!b) { if (card.id && !OWN_CARDS.has(card.id)) hideCard(); return; }
    clearTimeout(card.timer);
    if (card.id === b.dataset.id || card.quiet === b.dataset.id) return;
    card.quiet = null;
    card.timer = setTimeout(() => showCard(b.dataset.id, b), card.id ? 0 : 160);
  });
  root.addEventListener('mouseleave', () => { card.quiet = null; hideCard(); });
  root.addEventListener('focusin', (e) => { const b = e.target.closest(sel); if (b) showCard(b.dataset.id, b); });
  root.addEventListener('focusout', () => hideCard());
}
hoverCards($('mini'), '.mchip');
hoverCards($('tree'), '.sess');
$('mini').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const chips = [...$('mini').querySelectorAll('.mchip')]; const i = chips.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault(); e.stopPropagation();
  chips[Math.max(0, Math.min(chips.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});


$('tree').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.classList.contains('bk-t')) { t.closest('.bucket').classList.toggle('collapsed'); return; }
  if (t.dataset.askList) { askList(t.dataset.askList, t); return; }
  if (t.dataset.subs) {
    const id = t.dataset.subs; const open = t.getAttribute('aria-expanded') === 'true';
    state.subsOpen.delete(id); state.subsOpen.delete('!' + id); state.subsOpen.add(open ? '!' + id : id);
    renderTree(); return;
  }
  if (t.dataset.more) { const id = t.dataset.more; state.subsAll.has(id) ? state.subsAll.delete(id) : state.subsAll.add(id); renderTree(); return; }
  if (t.dataset.id) { card.quiet = t.dataset.id; hideCard(true); select(t.dataset.id); }
});

// ------------------------------------------------------------ overview
let ovTimer = null;
function scheduleOverview() { if (!state.selected && !ovTimer) ovTimer = requestAnimationFrame(() => { ovTimer = null; renderOverview(); }); }

function briefLine(id) {
  const pb = state.briefs.get(id);
  return pb?.brief?.summary || null;
}
/** How current a session's brief is, for the overview cards (sessions not open here). */
function freshness(id) {
  const pb = state.briefs.get(id);
  const s = state.byId.get(id);
  const phase = phaseOf(s);
  if (!state.narrator.enabled) return { text: 'Model briefs are off (server started with --no-narrator)' };
  if (pb?.pending) return { text: pb.brief ? 'Updating…' : 'Writing the first brief…', spin: true };
  // A per-session failure, or a CLI-wide one (bad login) that pauses all briefs.
  const error = pb?.error || (state.narrator.error?.fatal ? state.narrator.error.message : null);
  if (error && !pb?.brief) {
    const auth = /authenticat|login|oauth/i.test(error);
    return { text: `Brief unavailable: ${error}${auth ? '. Run claude in a terminal and sign in (/login), then refresh.' : ''}`, err: true };
  }
  const cad = phase === 'working' && s?.kind === 'session' && s.alive ? 'refreshes at turn end' : 'paused · refreshes when opened';
  if (!pb?.brief) return { text: `No brief yet · ${cad}` };
  return { text: `updated ${ago(Date.now() - pb.updatedAt)} ago · ${cad}${pb.error ? ' · last refresh failed' : ''}`, live: phase === 'working' };
}

function nowText(s) {
  const g = s.glance || {};
  if (g.activeTool) return { tag: g.activeTool.name, text: g.activeTool.summary || g.activeTool.name };
  if (phaseOf(s) === 'turn') return { tag: null, text: `Waiting for you${g.idleMs != null ? ` · idle ${ago(g.idleMs + (Date.now() - (g._at || Date.now())))}` : ''}` };
  return { tag: null, text: [g.state, g.detail].filter(Boolean).join(' · ') || '—' };
}

function renderOverview() {
  const ov = $('overview');
  const act = state.snapshot.active;
  const working = act.filter(s => sigOf(s) === 'working');
  const needs = act.filter(needsYou).sort((a, b) => (sigOf(a) === 'input' ? 0 : 1) - (sigOf(b) === 'input' ? 0 : 1));
  const ready = act.filter(s => sigOf(s) === 'done');
  const runningSubs = act.reduce((n, s) => n + (s.running || 0), 0);
  const runningBg = act.reduce((n, s) => n + (s.background || 0), 0);
  const spent = act.reduce((n, s) => n + (s.glance?.cost || 0), 0);
  const repos = new Set(act.map(s => s.cwd)).size;
  const askBtn = (key, what) => h('button', { type: 'button', class: 'ask-ico', dataset: { askList: key }, 'aria-label': `Ask about ${what}`, title: `Ask about ${what}` }, starIcon(11));

  const head = h('header', { class: 'ov-h' },
    h('h1', {}, act.length ? (needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you, ${working.length} working` : `${working.length} agent${working.length === 1 ? '' : 's'} working, nothing needs you`) : 'No agents running'),
    h('p', {}, act.length ? [`Live across ${repos} repo${repos === 1 ? '' : 's'}`, runningSubs ? `${runningSubs} subagent${runningSubs === 1 ? '' : 's'} running` : null, runningBg ? `${runningBg} in the background` : null, spent ? `${fmtUsd(spent)} spent in live sessions` : null].filter(Boolean).join(' · ')
      : 'Start one with New session, or run claude in a terminal or the desktop app and it shows up here.'));
  head.append(ib('i-plus', 'New session (n)', () => openLaunch(), { cls: 'ov-new', size: 18 }));
  const out = [head];

  // Needs you: questions and permission prompts first, then sessions stopped on an error.
  if (needs.length) {
    const sec = h('section', { class: 'ov-sec', dataset: { ov: 'needs' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Needs you'), askBtn('ov-needs', 'what needs you')));
    for (const s of needs) {
      const sig = sigOf(s);
      const st = statusOf(s, null, phaseOf(s));
      sec.append(h('button', { type: 'button', class: `need sig-${sig}`, dataset: { open: s.id, ...(sig === 'error' && st.seq ? { seq: String(st.seq) } : {}) } },
        h('span', { class: `pill sig-${sig}` }, st.icon ? svgUse(st.icon, 12) : h('span', { class: 'pd' }), st.head),
        h('span', { class: 'nt' }, h('b', {}, s.title, h('span', {}, ` · ${s.project}${s.gitBranch ? ' · ' + s.gitBranch : ''}`)), h('span', { class: 'nl' }, st.text || briefLine(s.id) || s.glance?.lastText || '')),
        h('span', { class: 'age' }, st.right || ''),
        h('span', { class: 'go' }, svgUse('i-right', 13))));
    }
    out.push(sec);
  }

  if (working.length) {
    const cards = h('div', { class: 'cards' });
    for (const s of working) {
      const nt = nowText(s);
      const f = freshness(s.id);
      const g = s.glance || {};
      cards.append(h('button', { type: 'button', class: 'card', dataset: { open: s.id } },
        h('span', { class: 'ch' }, h('span', { class: `dot sig-working${statusOf(s, null, 'working').quiet ? ' quiet' : ''}` }), h('b', {}, s.title), h('span', { class: 'muted' }, ago(Date.now() - s.mtime))),
        h('span', { class: 'cw' }, [tilde(s.cwd), s.gitBranch, s.pr ? `PR #${s.pr.number}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'nowbox' }, nt.tag ? h('span', { class: `tag f-${tagFor({ kind: 'tool', tool: { name: nt.tag, isError: false, display: nt.tag } }).fam}` }, nt.tag) : null, h('span', { class: 'nb' }, nt.text)),
        h('span', { class: 'fresh' }, h('span', { class: `fdot2${f.live ? ' live' : ''}` }), `Brief · ${f.text}`),
        h('span', { class: 'cs' }, briefLine(s.id) || g.lastText || ''),
        h('span', { class: 'cf' }, h('span', {}, g.turnMs != null ? `turn ${fmtMs(g.turnMs)}` : ''), h('span', {}, s.subagents?.length ? `${s.subagents.filter(a => a.status === 'done').length} / ${s.subagents.length} subagents` : 'no subagents'), s.background ? h('span', {}, `${s.background} in background`) : null, h('span', {}, g.cost != null ? fmtUsd(g.cost) : ''))));
    }
    out.push(h('section', { class: 'ov-sec', dataset: { ov: 'working' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Working'), askBtn('ov-working', 'the working sessions')), cards));
  }

  // Done: live sessions that finished cleanly and are ready for the next prompt.
  if (ready.length) {
    const sec = h('section', { class: 'ov-sec', dataset: { ov: 'ready' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Done · ready for more')));
    for (const s of ready) sec.append(h('button', { type: 'button', class: 'recent-row ready', dataset: { open: s.id } },
      h('span', {}, h('span', { class: 'dot sig-done' }), s.title), h('span', { class: 'w' }, oneLine(s.glance?.lastPrompt ? `finished: ${s.glance.lastPrompt}` : s.glance?.lastText || '', 80)),
      h('span', { class: 'a' }, s.glance?.idleMs != null ? `idle ${ago(s.glance.idleMs)}` : '')));
    out.push(sec);
  }

  const recent = state.snapshot.recent.slice(0, 8);
  if (recent.length) {
    const sec = h('section', { class: 'ov-sec', dataset: { ov: 'recent' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Recently finished'), askBtn('ov-recent', 'recently finished sessions')));
    for (const s of recent) sec.append(h('button', { type: 'button', class: 'recent-row', dataset: { open: s.id } }, h('span', {}, s.title), h('span', { class: 'w' }, [s.project, s.gitBranch].filter(Boolean).join(' · ')), h('span', { class: 'a' }, ago(Date.now() - s.mtime))));
    out.push(sec);
  }
  if (!act.length && !recent.length) out.push(h('div', { class: 'empty' }, 'Nothing to show yet.'));
  ov.replaceChildren(...out);
  applyRing();
}
$('overview').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.askList) { e.stopPropagation(); askList(b.dataset.askList, b); return; }
  if (b.dataset.open) { const seq = Number(b.dataset.seq) || null; select(b.dataset.open).then(() => { if (seq) jumpToSeq(seq); }); }
});

function goOverview() {
  state.selected = null; state.cursor = null;
  prefs.selected = null; savePrefs();
  $('session-view').hidden = true; $('overview').hidden = false;
  showDetailsEmpty();
  renderTree(); renderOverview(); reportView();
}
$('home').onclick = goOverview;

// ------------------------------------------------------------ selection
async function select(id) {
  if (!state.byId.has(id) && !state.cache.has(id)) return;
  const changed = state.selected !== id;
  state.selected = id;
  if (changed) { state.cursor = null; state.briefAt = null; setLive(true, true); }
  prefs.selected = id; savePrefs();
  $('overview').hidden = true; $('session-view').hidden = false;
  renderTree();
  reportView();
  renderHeader();
  if (changed) { $('vrows').replaceChildren(); showDetailsEmpty(); renderPerms(); }
  try { await loadSession(id); }
  catch (e) { toast(`Load failed: ${e.message}`); return; }
  if (state.selected !== id) return;
  renderHeader(); renderQueue(); renderPerms(); renderBackground(); scheduleRows(true);
  if (changed) {
    state.files = null; state.changes = null;
    $('files-count').textContent = ''; $('changes-count').textContent = '';
    $('files').replaceChildren(); $('changes').replaceChildren(); $('changes-head').textContent = '';
    if (state.tab === 'files') loadFiles();
    if (state.tab === 'changes') loadChanges();
    const s = state.byId.get(id);
    if (!$('sh-cwd').dataset.user) $('sh-cwd').value = s?.cwd || '';
  }
}

// ------------------------------------------------------------ session header + brief
function renderHeader() {
  const id = state.selected; if (!id) return;
  const c = state.cache.get(id); const s = state.byId.get(id) || c?.summary;
  const el = $('shead');
  if (!s) { el.replaceChildren(h('div', { class: 'muted' }, 'Loading…')); $('nowslot').replaceChildren(); return; }
  const b = c?.brief; const phase = phaseOf(s);
  const isAgent = s.kind === 'agent';

  const win = h('div', { class: 'sh-win' });
  const st = statusOf(s, b, phase);
  if (s.hidden) win.append(ib('i-reuse', 'Reopen (move it out of Closed)', reopenSession));
  else win.append(ib('i-x', isAgent ? 'Back to parent session' : 'Close (move it to Closed)', closeSession));
  if (!isAgent) win.append(ib('i-trash', s.alive ? 'Running sessions cannot be deleted' : 'Delete session…', deleteSession, { cls: 'danger', disabled: s.alive || null }));
  const top = h('div', { class: 'sh-top' }, h('span', { class: `dot sig-${sigOf(s)}${st.quiet ? ' quiet' : ''}`, title: st.head }), h('h1', { title: s.title }, s.title || id));
  if (isAgent) {
    const parent = state.byId.get(s.parentId);
    top.append(h('button', { type: 'button', class: 'sh-parent', onclick: () => select(s.parentId) }, `subagent of ${parent?.title || s.parentId}`));
  } else if (s.spawnedBy && state.byId.has(s.spawnedBy)) {
    top.append(h('button', { type: 'button', class: 'sh-parent', onclick: () => select(s.spawnedBy) }, `sub-task of ${state.byId.get(s.spawnedBy).title}`));
  }
  const d = isAgent ? null : deckOf(id);
  // The permission mode shows only when it is not the default (asks before acting).
  if (d?.alive) { if (d.permissionMode !== 'default') top.append(h('span', { class: 'sh-mode', title: `Launched by the deck · pid ${d.pid} · permissions: ${d.permissionMode}` }, PERM_LABEL[d.permissionMode] || d.permissionMode)); }
  else if (!isAgent && s.alive) top.append(h('span', { class: 'sh-mode', title: 'Observe only: launched outside the deck, so the deck can read it but not drive it' }, svgUse('i-eye', 14)));
  if (b?.pr) top.append(h('a', { class: 'sh-pr', href: b.pr.url, target: '_blank', rel: 'noopener' }, `PR #${b.pr.number}`));
  top.append(h('span', { class: 'spacer' }));
  // Where, which model, tokens and cost: one hover away rather than a line of figures under the brief.
  top.append(detailsBtn());
  if (d?.alive) top.append(ib('i-power', 'End the claude process now. It ends by itself after 30 minutes idle, and the next prompt starts it again.', stopSession, { cls: 'subtle' }));
  if (!isAgent) top.append(ib('i-copy', 'Copy resume command', (e) => { navigator.clipboard?.writeText(`cd ${JSON.stringify(s.cwd || '.')} && claude --resume ${id}`); flashDone(e.currentTarget); }));
  top.append(win);

  // The status line sits in the prompt panel, right above the text box: whose
  // move it is, next to where you would make yours.
  $('nowslot').replaceChildren(renderNow(st, phase));
  const out = [top, renderBriefBox(id, s, b)];

  patchChildren(el, out);
  if (card.id === 'details') showDetailsCard(detailsBtn(), true);
  applyRing();
}

/** The session's particulars, moved off the main view: place, model, tokens, cost, and what its brief has cost. */
function detailsCardBody(s, b) {
  const pb = state.briefs.get(s.id);
  const rows = [];
  const row = (k, v, cls) => v ? rows.push(h('tr', {}, h('th', {}, k), h('td', { class: cls || null }, v))) : null;
  row('Folder', s.cwd ? tilde(s.cwd) : null, 'mono');
  row('Branch', [b?.branch || s.gitBranch, b?.pr ? `PR #${b.pr.number}` : null].filter(Boolean).join(' · '));
  row('Model', [b?.model?.replace('claude-', ''), b?.effort, b?.mode].filter(Boolean).join(' · '));
  const t = b?.turnUsage;
  if (t?.messages) row('This turn', `${fmtTokens(t.input + t.cacheRead + t.cacheCreate)} in (${fmtTokens(t.cacheRead)} cached) · ${fmtTokens(t.output)} out${b.turnMs != null ? ` · ${fmtMs(b.turnMs)}` : ''}`);
  const u = b?.usage;
  if (u?.messages) row('Session', [plural(b.turns || 0, 'turn'), `${fmtTokens(u.output)} out`, b.cost?.totalCostUSD != null ? fmtUsd(b.cost.totalCostUSD) : null].filter(Boolean).join(' · '));
  if (b?.cost?.linesAdded != null) row('Lines', `+${b.cost.linesAdded} −${b.cost.linesRemoved}`);
  row('Files', b?.filesTouched ? plural(b.filesTouched, 'file') + ' touched' : null);
  row('Subagents', b?.subagents?.total ? `${b.subagents.running} running of ${b.subagents.total}` : null);
  row('Errors', b?.errors ? String(b.errors) : null, 'err');
  if (pb?.count) row('Brief', `${plural(pb.count, 'refresh', 'refreshes')} · ${fmtUsd(pb.costUsd || 0)} on ${state.narrator.briefModel || 'the brief model'}`);
  return [h('div', { class: 'hc-h' }, h('b', {}, 'Session details')), h('table', { class: 'hc-tbl' }, h('tbody', {}, ...rows))];
}
// The model label on an event row: hover for how that API response was produced.
function showInferenceCard(anchor) {
  const r = anchor.closest('.row');
  const sessionId = r?.dataset.sid || state.selected;
  let ev = r && findEvent(sessionId, r.dataset.id);
  // A later block of the response: the details sit on its first event.
  if (ev && !ev.inference && ev.msgId) {
    const evs = state.cache.get(sessionId)?.events || [];
    for (let i = evs.indexOf(ev); i >= 0; i--) if (evs[i].msgId === ev.msgId && evs[i].inference) { ev = evs[i]; break; }
  }
  if (!ev?.inference) return;
  const el = $('hovercard');
  clearTimeout(card.timer);
  card.id = 'inference'; card.anchor = anchor;
  el.replaceChildren(...inferenceCard(ev));
  el.hidden = false;
  const a = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, a.right - el.offsetWidth + 8))}px`;
  el.style.top = `${a.bottom + el.offsetHeight + 12 > window.innerHeight ? Math.max(8, a.top - el.offsetHeight - 6) : a.bottom + 6}px`;
  el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
}
$('vlist').addEventListener('mouseover', (e) => {
  const m = e.target.closest('.mdl');
  if (!m) { if (card.id === 'inference') hideCard(); return; }
  if (card.anchor === m) { clearTimeout(card.timer); return; }
  clearTimeout(card.timer);
  card.timer = setTimeout(() => showInferenceCard(m), card.id === 'inference' ? 0 : 200);
});
$('vlist').addEventListener('mouseleave', () => { if (card.id === 'inference') hideCard(); });

// One button for the life of the page: the header is rebuilt on every event,
// and a fresh node would lose the hover that opened the card.
let detailsEl = null;
function detailsBtn() {
  if (detailsEl) return detailsEl;
  const b = detailsEl = ib('i-info', 'Session details', null, { 'aria-describedby': 'hovercard' });
  b.addEventListener('mouseenter', () => { clearTimeout(card.timer); card.timer = setTimeout(() => showDetailsCard(b), 160); });
  b.addEventListener('mouseleave', () => hideCard());
  b.addEventListener('focus', () => showDetailsCard(b));
  b.addEventListener('blur', () => hideCard());
  return b;
}
function showDetailsCard(anchor, refresh = false) {
  const s = state.byId.get(state.selected); const el = $('hovercard');
  if (!s || !anchor?.isConnected) return;
  clearTimeout(card.timer);
  card.id = 'details'; card.anchor = anchor;
  el.replaceChildren(...detailsCardBody(s, state.cache.get(s.id)?.brief));
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth + 8))}px`;
  el.style.top = `${r.bottom + 6}px`;
  if (!refresh) el.classList.remove('in'), void el.offsetWidth, el.classList.add('in');
}

/** Like replaceChildren, but leaves nodes that are already in place attached (keeps text selection in them). */
function patchChildren(el, nodes) {
  nodes.forEach((n, i) => { const cur = el.children[i]; if (cur !== n) cur ? cur.replaceWith(n) : el.append(n); });
  while (el.children.length > nodes.length) el.lastElementChild.remove();
}

/**
 * Whose move it is, in plain words. `who` leads the status line: CLAUDE while
 * the agent has the ball, YOU when it is waiting on the pilot.
 */
function statusOf(s, b, phase) {
  const QUIET_MS = 90_000;
  const g = b || s.glance || {};
  const sig = sigOf(s);
  const observe = s.kind === 'session' && s.alive && !deckOf(s.id)?.alive;
  const where = observe ? ' · reply in its terminal' : '';
  const subs = g.subagents?.running || 0;
  const subsTxt = subs ? `${subs} subagent${subs === 1 ? '' : 's'} running` : null;
  const waited = g.need?.since ? ago(Date.now() - Date.parse(g.need.since)) : g.idleMs != null ? ago(g.idleMs) : null;
  if (sig === 'input' && (permLine(s.id) || g.need?.kind === 'permission')) return { sig, who: 'you', icon: 'i-hand', head: 'Needs your permission', text: permLine(s.id)?.replace(/^Wants to use /, '') || g.need.text, right: deckOf(s.id)?.alive ? 'answer below' : waited ? `waiting ${waited}` : '' };
  if (sig === 'input') return { sig, who: 'you', icon: 'i-q', head: 'Claude asked you', text: (g.need?.text || g.lastText || '') + where, right: waited ? `waiting ${waited}` : '' };
  if (sig === 'error') return { sig, who: phase === 'working' ? 'claude' : 'you', icon: 'i-x', head: phase === 'working' ? 'Hit an error' : 'Stopped on an error', text: g.need?.text || '', right: waited ? `${waited} ago` : '', seq: g.need?.seq };
  if (phase === 'turn') return { sig, who: 'you', icon: 'i-check', head: 'Done · your turn', text: (g.lastPrompt ? `finished: ${g.lastPrompt}` : 'waiting for your next prompt') + where, right: g.idleMs != null ? `idle ${ago(g.idleMs)}` : '' };
  if (phase === 'working') {
    const t = g.activeTool;
    if (t) return { sig, who: 'claude', head: `Running ${t.name}`, text: [t.summary, subsTxt].filter(Boolean).join(' · '), clock: t.startedMs || 0, mono: true };
    if (g.quietMs != null && g.quietMs > QUIET_MS) return { sig, quiet: true, who: 'claude', head: `Quiet for ${ago(g.quietMs)}`, text: `no new events while ${g.state || 'working'}; it may be thinking hard, or stalled`, clock: g.turnMs };
    if (g.waitingOn === 'subagents') return { sig, who: 'claude', head: `Waiting on ${subsTxt.replace(' running', '')}`, text: g.detail || '', clock: g.turnMs };
    const head = { thinking: 'Thinking', responding: 'Writing', 'starting turn': 'Starting the turn' }[g.state] || 'Working';
    return { sig, who: 'claude', head, text: [g.state === 'working' ? g.detail : null, subsTxt].filter(Boolean).join(' · '), clock: g.turnMs };
  }
  if (deckOf(s.id)?.exit && phase === 'ended') {
    const x = deckOf(s.id).exit;
    const bad = x.code !== 0 && x.code !== null || (x.signal && x.signal !== 'SIGTERM');
    if (bad) return { sig: 'error', who: 'ended', head: `claude exited ${x.signal || `with code ${x.code}`}`, text: x.stderr ? x.stderr.split('\n').at(-1) : '', title: x.stderr || '', right: `${ago(Date.now() - x.at)} ago` };
  }
  const last = g.lastEventTs ? `last activity ${ago(Date.now() - Date.parse(g.lastEventTs))} ago` : 'no activity recorded';
  // A top-level session that is not running just waits for the next prompt, which starts it again.
  if (phase === 'ended' && s.kind === 'session') return { sig, who: 'you', head: 'Your turn', text: last };
  return { sig, who: phase === 'done' ? 'done' : 'ended', head: phase === 'done' ? 'Done' : 'Ended', text: last };
}

function renderNow(st) {
  const box = h('div', { class: `nowline sig-${st.sig}${st.quiet ? ' quiet' : ''}`, role: 'status' },
    h('span', { class: 'nl-k' }, { claude: 'CLAUDE', you: 'YOU', done: 'DONE', ended: 'ENDED' }[st.who]),
    st.icon ? svgUse(st.icon, 14) : null,
    h('b', { class: 'nl-h' }, st.head),
    h('span', { class: `nl-t${st.mono ? ' mono' : ''}`, title: st.title || st.text }, st.text));
  if (st.clock != null) box.append(h('span', { class: 'nl-e', title: 'elapsed', dataset: { started: String(Date.now() - st.clock) } }, fmtClock(st.clock)));
  else if (st.right) box.append(h('span', { class: 'nl-e' }, st.right));
  if (st.seq) box.append(ib('i-right', 'Jump to the error', () => jumpToSeq(st.seq), { size: 13 }));
  return box;
}
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
setInterval(() => { for (const e of document.querySelectorAll('.nl-e[data-started]')) e.textContent = fmtClock(Date.now() - Number(e.dataset.started)); }, 1000);

// The brief box is rebuilt only when what it shows changes; the 5s header
// refresh otherwise just updates its freshness line, so a brief being read
// (or selected) is not torn down underneath the reader.
let briefBoxCache = null;   // { key, el, at }
function renderBriefBox(id, s, b) {
  const pb = state.briefs.get(id);
  const nb = pb?.brief;
  const all = nb ? [{ brief: nb, updatedAt: pb.updatedAt }, ...(pb.history || [])] : [];
  let i = state.briefAt?.id === id ? all.findIndex(x => x.updatedAt === state.briefAt.at) : 0;
  if (i < 0) { i = 0; state.briefAt = null; }
  const cur = all[i]?.brief, prev = all[i + 1]?.brief;
  const foot = briefFoot(id, s, pb, i, all);

  const key = JSON.stringify([id, pb?.updatedAt, pb?.pending, pb?.error, state.narrator.enabled, state.narrator.error?.message, prefs.briefCollapsed, i, all.length, nb ? null : b?.lastText]);
  if (briefBoxCache?.key === key) { briefBoxCache.el.querySelector('.brief-f').replaceWith(foot); return briefBoxCache.el; }
  const landed = !i && briefBoxCache?.id === id && briefBoxCache.at && pb?.updatedAt > briefBoxCache.at;

  const box = h('section', { id: 'brief-box', class: `brief${prefs.briefCollapsed ? ' collapsed' : ''}${landed ? ' landed' : ''}${i ? ' earlier' : ''}`, 'aria-labelledby': 'brief-h' });
  const head = h('div', { class: 'brief-h' }, h('h2', { id: 'brief-h' }, i ? 'Earlier brief' : 'Brief'), h('span', { class: 'spacer' }));
  if (all.length > 1) {
    const go = (j) => { state.briefAt = j ? { id, at: all[j].updatedAt } : null; renderHeader(); };
    head.append(h('span', { class: 'bhist' },
      ib('i-left', 'Earlier brief', () => go(i + 1), { size: 13, disabled: i >= all.length - 1 || null }),
      ib('i-right', 'Later brief', () => go(i - 1), { size: 13, disabled: !i || null }),
      i ? ib('i-latest', 'Latest brief', () => go(0), { size: 13 }) : null));
  }
  if (nb) head.append(ib(prefs.briefCollapsed ? 'i-down' : 'i-up', prefs.briefCollapsed ? 'Expand brief' : 'Collapse brief', () => { prefs.briefCollapsed = !prefs.briefCollapsed; savePrefs(); renderHeader(); }, { size: 13 }));
  head.append(ib('i-speaker', 'Read the brief aloud (r)', () => readBrief(id), { size: 13 }));
  head.append(h('button', { type: 'button', class: 'ask-ico', 'aria-label': 'Ask about this session', title: 'Ask about this session', onclick: () => openAsk({ kind: 'brief', sessionId: id, label: 'Session brief', what: 'this session' }, { type: 'brief' }) }, starIcon(12)));
  box.append(head);

  if (cur?.summary) box.append(h('p', { class: 'sum' }, cur.summary));
  else box.append(h('p', { class: 'sum fallback' }, b?.lastText ? [h('span', { class: 'lbl2' }, 'Last said · '), b.lastText] : 'No assistant message yet.'));

  if (cur?.progress) {
    const p = cur.progress;
    const legend = h('div', { class: 'prog-l' }, h('b', {}, `${p.total} ${p.unit}`));
    const bar = h('div', { class: 'prog-b', role: 'img', 'aria-label': p.segments.map(x => `${x.count} ${x.label}`).join(', ') });
    for (const sg of p.segments) {
      legend.append(h('span', {}, h('i', { class: `tone-${sg.tone}` }), `${sg.count} ${sg.label}`));
      bar.append(h('span', { class: `tone-${sg.tone}`, style: `flex-grow:${sg.count}` }));
    }
    box.append(h('div', { class: 'prog' }, legend, bar));
  }
  // Items this brief added over the one before it are marked, so a refresh
  // reads as a change rather than a wholesale rewrite.
  const isNew = (x) => prev && !prev.done.includes(x);
  // No "now" column: the status line under the brief says what it is doing, live and free.
  if (cur && (cur.done.length || cur.next)) {
    box.append(h('div', { class: 'dnn' },
      h('div', {}, h('h3', {}, 'Done so far'), cur.done.length ? h('ul', {}, ...cur.done.map(x => h('li', { class: isNew(x) ? 'new' : null, title: isNew(x) ? 'New since the previous brief' : null }, x))) : h('p', { class: 'muted' }, '—')),
      h('div', {}, h('h3', {}, 'Next'), h('p', {}, cur.next || '—'))));
  }
  if (cur?.watch) {
    const w = h('div', { class: 'watch' }, h('span', { class: 'wk' }, 'WATCH'), h('span', { class: 'wt' }, cur.watch.text));
    if (cur.watch.seq) w.append(h('button', { type: 'button', onclick: () => jumpToSeq(cur.watch.seq) }, 'Jump to event'));
    box.append(w);
  }
  box.append(foot);
  briefBoxCache = { key, el: box, id, at: pb?.updatedAt || 0 };
  return box;
}

const BRIEF_WHY = { first: 'first brief', handoff: 'when it handed back', subagent: 'when a subagent finished', milestone: 'on a commit or PR',
  drift: 'after a run of work', heartbeat: 'on the 10-minute check', idle: 'on new activity', manual: 'on request' };

/** What has happened since the brief, in a few words: "4 edits · 6 commands · 1 commit". */
function activityText(a) {
  const n = (k, w) => a[k] ? plural(a[k], w) : null;
  return [n('prompts', 'prompt'), n('edits', 'edit'), n('commands', 'command'), a.milestones.length ? a.milestones.join(', ') : null,
    n('errors', 'error'), n('agents', 'subagent'), n('said', 'message'), n('looks', 'read')].filter(Boolean);
}

/**
 * The brief's footer: when it was written and why, what has happened since
 * (counted live from the event stream, so it costs nothing), and what will
 * make it refresh next. Rebuilt on every header render; the brief above it
 * is not.
 */
function briefFoot(id, s, pb, i, all) {
  const foot = h('div', { class: 'brief-f' });
  const left = h('span', { class: 'bf-l' });
  foot.append(left);
  if (i) { left.append(`from ${ago(Date.now() - all[i].updatedAt)} ago · ${i} of ${all.length - 1} back`); return foot; }
  if (!state.narrator.enabled) { left.append('Model briefs are off (server started with --no-narrator)'); return foot; }
  const error = pb?.error || (state.narrator.error?.fatal ? state.narrator.error.message : null);
  if (error && !pb?.brief) {
    const auth = /authenticat|login|oauth/i.test(error);
    left.classList.add('err');
    left.append(`Brief unavailable: ${error}${auth ? '. Run claude in a terminal and sign in (/login), then refresh.' : ''}`);
  } else if (pb?.pending) {
    left.append(h('span', { class: 'spin' }), pb.brief ? 'Updating…' : 'Writing the first brief…');
  } else if (pb?.brief) {
    left.append(h('b', {}, `${ago(Date.now() - pb.updatedAt)} ago`), BRIEF_WHY[pb.reason] ? ` ${BRIEF_WHY[pb.reason]}` : '');
    if (pb.error) left.append(h('span', { class: 'err', title: pb.error }, ' · last refresh failed'));
  } else left.append('No brief yet');

  // Since the brief: the same tally the server's scheduler weighs.
  const c = state.cache.get(id);
  const a = pb?.brief && c?.loaded ? activitySince(c.events, pb.seq || 0) : null;
  if (a && !pb.pending) {
    const parts = activityText(a);
    foot.append(h('span', { class: 'bf-s', title: parts.length ? `Since this brief: ${parts.join(', ')}` : '' },
      parts.length ? `· since: ${parts.slice(0, 4).join(' · ')}${parts.length > 4 ? ' …' : ''}` : '· nothing new since'));
  }
  foot.append(h('span', { class: 'spacer' }));

  // What refreshes it next.
  const phase = phaseOf(s);
  const working = phase === 'working' || (phase === 'turn' && s?.glance?.need?.kind === 'permission');
  if (pb?.brief && !pb.pending && a) {
    const rule = `Refreshes when the turn ends or Claude asks you something, when a subagent finishes, on a commit, push or PR, `
      + `and mid-turn once enough work piles up (${CADENCE.driftScore} points: edit ${WEIGHT.edit}, command ${WEIGHT.command}, read ${WEIGHT.look}; at most every ${CADENCE.driftMs / 60_000} min) `
      + `or every ${CADENCE.heartbeatMs / 60_000} min while it keeps working. Reads and permission prompts alone do not refresh it.`;
    if (working) {
      const fill = Math.min(1, a.score / CADENCE.driftScore);
      foot.append(h('span', { class: 'bf-n', title: rule }, 'next: turn end',
        h('span', { class: 'bf-m', role: 'img', 'aria-label': `${Math.round(fill * 100)}% of the work that triggers a refresh` }, h('span', { style: `width:${fill * 100}%` }))));
    } else if (phase === 'turn') foot.append(h('span', { class: 'bf-n', title: rule }, 'next: on new activity'));
    else foot.append(h('span', { class: 'bf-n' }, 'final'));
  }
  if (state.narrator.enabled) foot.append(ib('i-refresh', 'Refresh the brief now', refreshBrief, { size: 12, disabled: pb?.pending || null }));
  return foot;
}
async function refreshBrief() {
  try { await api.post(`/api/sessions/${sid(state.selected)}/brief/refresh`); }
  catch (e) { toast(`Refresh failed: ${e.message}`); }
}
function refreshBriefViews(id) {
  if (state.selected && (!id || id === state.selected)) renderHeader();
  if (!state.selected) scheduleOverview();
}

// ------------------------------------------------------------ background tasks
// Commands Claude runs (or moves) into the background, Monitors, background
// agents (lib/transcript.mjs meta.tasks). A strip under the status line shows
// what is running, the Background tab lists them all, and a task's details
// show its command, Monitor events and the live end of its output file.
const bg = { filter: 'all', q: '', timer: null, out: null, key: null };
const tasksOf = (id) => state.cache.get(id)?.meta?.tasks || [];
const taskOf = (id, taskId) => tasksOf(id).find(t => t.id === taskId) || null;
const aliveOf = (id) => !!state.byId.get(id)?.alive;
function renderBackground() {
  const id = state.selected;
  const tasks = tasksOf(id), alive = aliveOf(id);
  $('bgslot').replaceChildren(...(id ? renderStrip(tasks, alive, { open: (tid) => showTaskDetails(id, tid), openTab: () => setTab('bg') }) : []));
  const running = tasks.filter(t => taskState(t, alive) === 'running').length;
  $('bg-count').textContent = tasks.length ? (running ? `${running} running` : String(tasks.length)) : '';
  $('bg-count').classList.toggle('live', running > 0);
  if (state.tab === 'bg') {
    const sel = state.detailsKey?.startsWith(`task:${id}:`) ? state.detailsKey.slice(`task:${id}:`.length) : null;
    $('bg-list').replaceChildren(renderTable(tasks, alive, { filter: bg.filter, q: bg.q, selected: sel, open: (tid) => showTaskDetails(id, tid) }));
  }
}
function taskCtx(id) {
  return {
    alive: aliveOf(id), api,
    openCall: (toolUseId) => { const ev = findEvent(id, toolUseId); if (ev) jumpToSeq(ev.seq); else toast('That call is not loaded'); },
    openAgent: (agentId) => select(agentId),
    runInShell: (cmd) => { setTab('shell'); $('sh-cmd').value = cmd; $('sh-cmd').focus(); },
    // Only a session the deck can drive takes the prompt.
    askStop: deckOf(id)?.alive ? (t) => api.post(`/api/sessions/${sid(id)}/send`, { text: `Please stop the background task ${t.id} (${taskTitle(t)}).`, model: prefs.launchModel || undefined }).then(() => toast('Asked Claude to stop it')).catch(e => toast(e.message)) : null,
  };
}
function showTaskDetails(id, taskId, refresh = false) {
  const t = taskOf(id, taskId);
  if (!t) { if (!refresh) toast('That task is not loaded yet'); return; }
  const key = `task:${id}:${taskId}`;
  if (!refresh) { pickEvent(); if (bg.key !== key) bg.out = null; }
  else if (state.detailsKey !== key) return;
  state.detailsKey = key; bg.key = key; syncDetailsPane();
  const body = $('details-body');
  const pre = body.querySelector('.bg-out');
  const stick = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  const keep = refresh ? body.scrollTop : 0;
  body.replaceChildren(renderTaskDetails(t, bg.out, taskCtx(id)));
  body.scrollTop = keep;
  const np = body.querySelector('.bg-out'); if (np && stick) np.scrollTop = np.scrollHeight;
  if (state.tab === 'bg') renderBackground();
  if (!refresh) pollTaskOutput();
}
/** Read the output tail now, and every 2s while the task runs and its details are open. */
async function pollTaskOutput() {
  clearTimeout(bg.timer);
  const key = bg.key;
  if (!key || state.detailsKey !== key) return;
  const [, id, ...rest] = key.split(':'); const taskId = rest.join(':');
  if (document.visibilityState === 'visible') {
    try {
      const r = await api.get(`/api/sessions/${sid(id)}/tasks/${sid(taskId)}/output?tail=65536`);
      if (state.detailsKey !== key) return;
      bg.out = r;
      const t = taskOf(id, taskId);
      const old = $('details-body').querySelector('.bg-out')?.closest('.dsec');
      if (t && old) {
        const pre = old.querySelector('.bg-out');
        const stick = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        const sec = renderOutput(r, t, aliveOf(id), taskCtx(id));
        old.replaceWith(sec);
        const np = sec.querySelector('.bg-out'); if (np && stick) np.scrollTop = np.scrollHeight;
      }
    } catch { /* the next tick tries again */ }
  }
  const t = taskOf(id, taskId);
  if (t && taskState(t, aliveOf(id)) === 'running') bg.timer = setTimeout(pollTaskOutput, 2000);
}
$('bg-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; bg.filter = b.dataset.f; for (const x of $('bg-seg').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); renderBackground(); };
$('bg-filter').oninput = (e) => { bg.q = e.target.value; renderBackground(); };

// ------------------------------------------------------------ close / delete
async function closeSession() {
  const s = state.byId.get(state.selected); if (!s) return;
  if (s.kind === 'agent') { select(s.parentId); return; }
  const id = s.id;
  try {
    await api.post(`/api/sessions/${sid(id)}/hide`, { hidden: true });
    goOverview();
    toast(`Closed “${oneLine(s.title, 40)}”`, { label: 'Undo', fn: () => api.post(`/api/sessions/${sid(id)}/hide`, { hidden: false }).then(() => select(id)) });
  } catch (e) { toast(`Close failed: ${e.message}`); }
}
async function reopenSession() {
  const id = state.selected;
  try { await api.post(`/api/sessions/${sid(id)}/hide`, { hidden: false }); }
  catch (e) { toast(`Reopen failed: ${e.message}`); }
}
function confirmDialog(title, body, okLabel) {
  const d = $('confirm');
  $('confirm-t').textContent = title; $('confirm-b').textContent = body; $('confirm-ok').textContent = okLabel;
  return new Promise((resolve) => { d.onclose = () => resolve(d.returnValue === 'ok'); d.returnValue = ''; d.showModal(); });
}
async function deleteSession() {
  const s = state.byId.get(state.selected); if (!s || s.kind !== 'session') return;
  const ok = await confirmDialog('Delete this session?', `“${s.title}” and its subagent transcripts move to ~/.agent-deck/trash. Claude Code will no longer list or resume it. You can restore it by moving the files back.`, 'Delete');
  if (!ok) return;
  try {
    const r = await api.post(`/api/sessions/${sid(s.id)}/delete`);
    state.cache.delete(s.id);
    goOverview();
    toast(`Deleted. Files are in ${tilde(r.trashedTo)}`);
  } catch (e) { toast(`Delete failed: ${e.message}`); }
}

// ------------------------------------------------------------ prompt queue
function renderQueue() {
  const id = state.selected;
  const c = state.cache.get(id);
  const s = state.byId.get(id);
  const d = s?.kind === 'session' ? deckOf(id) : null;
  const compose = $('compose'), sendBtn = $('send'), nowBtn = $('send-now'), stopBtn = $('stop');
  // Any session the deck can drive takes a prompt; one that is not running
  // starts again when it is sent. Subagents and sessions running elsewhere
  // get a line saying why there is no box.
  const canSend = s?.kind === 'session' && (d?.alive || !s.alive);
  $('prompt').classList.toggle('readonly', !canSend);
  $('prompt').hidden = !s;
  $('ro-why').replaceChildren(...(canSend || !s ? [] : roWhy(s)));
  if (canSend) {
    const q = d?.queue || [];
    const running = !!d?.alive;
    const idle = !running || d.status === 'idle';
    const rows = q.map((item, i) => h('li', { dataset: { qid: item.id } }, h('span', { class: 'muted' }, `${i + 1}.`),
      item.attachments?.length ? h('span', { class: 'q-att', title: item.attachments.map(a => a.name).join('\n') }, svgUse('i-clip', 11), String(item.attachments.length)) : null,
      h('span', { class: 'q editable', title: 'Click to edit', tabindex: '0', role: 'button', 'aria-label': `Edit queued prompt: ${oneLine(item.text, 80)}`, onclick: (e) => editQueued(item, e.currentTarget), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); editQueued(item, e.currentTarget); } } }, item.text.replace(/\s+/g, ' ')),
      ib('i-top', 'Send this next', () => queueOp('top', item.id), { size: 12, disabled: i === 0 && !d.held || !running || null }),
      ib('i-up', 'Move up', () => queueOp('up', item.id), { size: 12, disabled: i === 0 || null }),
      ib('i-down', 'Move down', () => queueOp('down', item.id), { size: 12, disabled: i === q.length - 1 || null }),
      ib('i-x', 'Remove from the queue', () => queueOp('remove', item.id), { size: 12 })));
    if (d?.held && q.length) rows.unshift(h('li', { class: 'held' }, h('span', { class: 'q' }, running ? 'Queue held after interrupt. Nothing goes out until you resume or send.' : 'Kept from before the backend restarted. Nothing goes out until you press play.'), ib('i-play', running ? 'Resume the queue' : 'Play: send these now', () => queueOp('resume'), { size: 13 })));
    // An open editor is left alone; the list catches up when it closes.
    if (!(state.qEdit && $('queue').contains(state.qEdit.el))) $('queue').replaceChildren(...rows);
    // One send button: it sends when Claude is idle and queues otherwise.
    // The bolt cuts in: interrupt the turn and send this prompt next.
    const starting = running && d.status === 'starting';
    const queues = running && (!idle || q.length > 0 || d.held);
    compose.disabled = false;
    compose.placeholder = starting ? 'Starting… · ⌘↩ queues it' : queues ? `Prompt · ⌘↩ queues it for when this turn ends · ⇧⌘↩ sends ${q.length ? 'it and the queue ' : ''}now` : 'Prompt · ⌘↩ to send';
    sendBtn.disabled = false;
    sendBtn.classList.toggle('queues', queues);
    sendBtn.title = queues ? 'Queue: goes out when the current turn ends (⌘↩)' : 'Send (⌘↩)';
    sendBtn.setAttribute('aria-label', queues ? 'Queue prompt' : 'Send');
    nowBtn.hidden = idle && !q.length && !d?.held;
    nowBtn.disabled = !!d?.interrupting;
    nowBtn.title = d?.interrupting ? 'Stopping…' : `Send now: ${idle ? '' : 'stop the current turn and '}send ${q.length ? `the ${q.length === 1 ? 'queued prompt' : `${q.length} queued prompts`} and anything typed, as one message` : 'this prompt'} (⇧⌘↩)`;
    // Stop: only while Claude is working. Ends the turn and holds the queue.
    stopBtn.hidden = idle;
    stopBtn.disabled = !!d?.interrupting;
    stopBtn.title = d?.interrupting ? 'Stopping…' : `Stop the current turn (⌘.)${q.length ? '; the queue is held until you resume or send' : ''}`;
    return;
  }
  const q = c?.meta?.queue || [];
  $('queue').replaceChildren(...q.map((item, i) => h('li', {}, h('span', { class: 'muted' }, `${i + 1}.`), h('span', { class: 'q', title: item.content }, item.content.replace(/\s+/g, ' ')),
    ib('i-copy', 'Copy', (e) => { navigator.clipboard?.writeText(item.content); flashDone(e.currentTarget); }, { size: 12 }))));
  compose.disabled = true; sendBtn.disabled = true; sendBtn.classList.remove('queues'); nowBtn.hidden = true; stopBtn.hidden = true;
  compose.placeholder = '';
  sendBtn.title = '';
}
/** Why a session has no prompt box, with a way to where prompts do go. */
function roWhy(s) {
  if (s.kind === 'agent') {
    const parent = state.byId.get(s.parentId);
    return [svgUse('i-info', 13), h('span', {}, 'Subagents take their instructions from the session that started them, so there is no prompt box here.'),
      parent ? h('button', { type: 'button', class: 'linkish', onclick: () => select(s.parentId) }, `Open ${parent.title || 'the parent session'}`) : null];
  }
  const where = s.entrypoint === 'claude-desktop' ? 'the Claude desktop app' : /vscode|jetbrains|ide/i.test(s.entrypoint || '') ? 'an editor' : 'a terminal';
  return [svgUse('i-eye', 13), h('span', {}, `Running in ${where}, so the deck can only watch. Send prompts there; once it ends you can continue it here.`)];
}
function focusCompose() { if (!$('compose').disabled) $('compose').focus({ preventScroll: true }); }

// ------------------------------------------------------------ deck-launched sessions
const PERM_LABEL = { default: 'asks', acceptEdits: 'accept edits', auto: 'auto', plan: 'plan only' };
function deckOf(id) { return id ? state.deck.get(id) || state.byId.get(id)?.deck || null : null; }

function onDeck(st) {
  if (st.gone) state.deck.delete(st.id); else state.deck.set(st.id, st);
  const s = state.byId.get(st.id);
  if (s && !st.gone) s.deck = st;
  if (st.id === state.selected) { renderHeader(); renderQueue(); renderPerms(); }
  else if (!state.selected) scheduleOverview();
}

function permLine(id) {
  const p = deckOf(id)?.permissions?.[0];
  return p ? `Wants to use ${p.displayName}${permSubject(p) ? ': ' + permSubject(p) : ''}` : null;
}
function permSubject(p) {
  const i = p.input || {};
  return oneLine(i.command || i.file_path || i.notebook_path || i.url || i.pattern || i.query || p.description || '', 120);
}
function suggestionText(list) {
  return list.map(x => x.type === 'setMode' ? `switch to ${PERM_LABEL[x.mode] || x.mode}`
    : x.type === 'addRules' ? `allow ${(x.rules || []).map(r => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ')}`
    : x.type === 'addDirectories' ? `add ${(x.directories || []).map(tilde).join(', ')}` : x.type).join('; ') + ' for this session';
}

function renderPerms() {
  const el = $('perms');
  const d = deckOf(state.selected);
  const list = d?.alive ? d.permissions : [];
  const key = list.map(p => p.requestId).join(',');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.hidden = !list.length;
  el.replaceChildren(...list.map(permCard));
  el.querySelector('.perm .btn.primary')?.focus({ preventScroll: true });
}
function permCard(p) {
  const i = p.input || {};
  const body = h('div', { class: 'perm-b' });
  if (p.toolName === 'ExitPlanMode' && i.plan) body.append(h('div', { class: 'md perm-plan', html: markdown(i.plan) }));
  else if (i.command) body.append(h('pre', { class: 'perm-cmd' }, i.command));
  else if (i.file_path || i.notebook_path) body.append(h('div', { class: 'mono' }, tilde(i.file_path || i.notebook_path)));
  else if (i.url) body.append(h('div', { class: 'mono' }, i.url));
  else body.append(h('pre', { class: 'perm-cmd' }, JSON.stringify(i, null, 2)));
  if (p.description && p.description !== i.command) body.prepend(h('div', { class: 'perm-d' }, p.description));
  if (p.reason || p.blockedPath) body.append(h('div', { class: 'muted perm-r' }, [p.reason, p.blockedPath ? `outside the allowed folders: ${tilde(p.blockedPath)}` : null].filter(Boolean).join(' · ')));
  const why = h('input', { class: 'field grow', type: 'text', placeholder: 'Tell Claude why (optional, sent with Deny)', spellcheck: 'false' });
  const act = (decision) => answerPerm(p.requestId, decision, why.value);
  why.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); act('deny'); } });
  const actions = h('div', { class: 'perm-a' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => act('allow') }, 'Allow'),
    p.suggestions.length ? h('button', { type: 'button', class: 'btn', title: suggestionText(p.suggestions), onclick: () => act('always') }, 'Allow for session') : null,
    h('button', { type: 'button', class: 'btn', onclick: () => act('deny') }, 'Deny'), why);
  return h('div', { class: 'perm' }, h('div', { class: 'perm-h' }, h('span', { class: 'perm-k' }, 'PERMISSION'),
    h('span', { class: `tag f-${tagFor({ kind: 'tool', tool: { name: p.toolName, isError: false } }).fam}` }, p.displayName),
    h('span', { class: 'muted' }, `asked ${ago(Date.now() - p.at)} ago`)), body, actions);
}
async function answerPerm(requestId, decision, message) {
  try { await api.post(`/api/sessions/${sid(state.selected)}/permission`, { requestId, decision, message }); }
  catch (e) { toast(`Answer failed: ${e.message}`); }
}

// A backend from before attachments drops big requests, which fetch reports only as a network error.
const sendError = (e, files) => e instanceof TypeError && files
  ? 'Send failed: the backend dropped the request. If it was started before attachments were supported, restart it.'
  : `Send failed: ${e.message}`;

// Files go with the prompt: the paperclip, a paste or a drop on the panel.
guardWindowDrops();
const composeFiles = attachable({ input: $('compose'), tray: $('compose-files'), clip: $('compose-clip'), file: $('compose-file'), drop: $('prompt'), toast });

async function sendPrompt(now = false) {
  const text = $('compose').value;
  if ($('compose').disabled) return;
  const id = state.selected;
  if (composeFiles.busy()) { toast('Still reading the attachments…'); return; }
  const attachments = composeFiles.payload();
  // Send now with an empty box still sends: it flushes the queue.
  if (!text.trim() && !attachments.length && !(now && deckOf(id)?.queue?.length)) { $('compose').focus(); return; }
  $('send').disabled = true; $('send-now').disabled = true;
  try {
    await api.post(`/api/sessions/${sid(id)}/${now ? 'send-now' : 'send'}`, { text, attachments: attachments.length ? attachments : undefined, model: prefs.launchModel || undefined });
    $('compose').value = ''; composeFiles.clear(); setLive(true, true);
    narration.hold(false);
  }
  catch (e) { toast(sendError(e, attachments.length)); }
  finally { if (id === state.selected) renderQueue(); }
}
$('send').onclick = () => sendPrompt(false);
$('send-now').onclick = () => sendPrompt(true);
$('stop').onclick = interruptSession;
$('compose').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendPrompt(e.shiftKey); } });

async function queueOp(op, itemId, text) {
  try { await api.post(`/api/sessions/${sid(state.selected)}/queue`, { op, itemId, text, model: prefs.launchModel || undefined }); return true; }
  catch (e) { if (op !== 'editing') toast(`Queue: ${e.message}`); return false; }
}

// Click a queued prompt to reword it in place. Leaving the box or ⌘↩ saves,
// Esc cancels. While it is open the deck holds that prompt back, so a turn
// ending mid-edit does not send the old wording.
function editQueued(item, span) {
  if (state.qEdit) return;
  const ta = h('textarea', { class: 'q-edit', rows: '1', spellcheck: 'true', 'aria-label': 'Edit queued prompt (⌘↩ or click away to save, Esc to cancel)' });
  ta.value = item.text;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
  state.qEdit = { id: item.id, el: ta, sessionId: state.selected, original: item.text, done: false };
  span.replaceWith(ta);
  fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finishEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false); }
  });
  ta.addEventListener('blur', () => finishEdit(true));
  queueOp('editing', item.id);
}
async function finishEdit(save) {
  const ed = state.qEdit; if (!ed || ed.done) return;
  ed.done = true;
  const text = ed.el.value;
  const changed = save && text.trim() && text !== ed.original;
  state.qEdit = null;
  const item = changed && deckOf(ed.sessionId)?.queue.find(x => x.id === ed.id);
  if (item) item.text = text;   // show the new wording now; the server confirms it
  if (ed.sessionId === state.selected) renderQueue();
  const path = `/api/sessions/${sid(ed.sessionId)}/queue`;
  if (!changed) { api.post(path, { op: 'editing', itemId: null }).catch(() => {}); return; }
  try { await api.post(path, { op: 'edit', itemId: ed.id, text }); }
  catch (e) {
    // Already sent or removed: keep the new wording rather than lose it.
    api.post(path, { op: 'editing', itemId: null }).catch(() => {});
    if (ed.sessionId === state.selected && !$('compose').value.trim()) { $('compose').value = text; toast('That prompt had already gone out. Your edit is in the prompt box.'); }
    else toast(`Edit not saved: ${e.message}`);
  }
}
async function interruptSession() {
  try { await api.post(`/api/sessions/${sid(state.selected)}/interrupt`); }
  catch (e) { toast(`Interrupt failed: ${e.message}`); }
}
async function stopSession() {
  const s = state.byId.get(state.selected); if (!s) return;
  const d = deckOf(s.id);
  const busy = d && d.status !== 'idle';
  if (busy || d?.queue.length) {
    const ok = await confirmDialog('End the claude process?', `${busy ? 'Claude is in the middle of a turn, which will be cut off. ' : ''}${d.queue.length ? `${d.queue.length} queued prompt${d.queue.length === 1 ? '' : 's'} will be dropped. ` : ''}The next prompt you send starts it again.`, 'End process');
    if (!ok) return;
  }
  try { await api.post(`/api/sessions/${sid(s.id)}/stop`); toast('Process ended'); }
  catch (e) { toast(`End failed: ${e.message}`); }
}

// The launch dialog: a new session under the deck.
// The model new sessions start with: picked in the title bar, preselected in
// the launch dialog (where a different pick applies to that launch only).
const MODELS = [['', 'Default'], ['opus', 'Opus'], ['opus[1m]', 'Opus 1M'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
let cliModel = null;
function modelOptions(sel) {
  const opts = MODELS.map(([v, l]) => h('option', { value: v }, v ? l : cliModel ? `${l} · ${cliModel}` : `${l} model`));
  // A saved pick no longer in the list still shows.
  if (prefs.launchModel && !MODELS.some(([v]) => v === prefs.launchModel)) opts.push(h('option', { value: prefs.launchModel }, prefs.launchModel));
  sel.replaceChildren(...opts);
}
function renderModelPicker() {
  const sel = $('tb-model');
  modelOptions(sel);
  sel.value = prefs.launchModel || '';
  sel.title = `New sessions start on ${sel.selectedOptions[0]?.textContent.replace(/^Default · /, '') || 'the CLI default'}`;
}
$('tb-model').addEventListener('change', (e) => { prefs.launchModel = e.target.value; savePrefs(); renderModelPicker(); });
renderModelPicker();
api.get('/api/config').then(r => { cliModel = r.cliModel; renderModelPicker(); }).catch(() => {});

function openLaunch() {
  const dlg = $('new-session');
  if (dlg.open) return;
  const cwds = [...new Set([...state.snapshot.active, ...state.snapshot.recent].map(s => s.cwd).filter(Boolean))].slice(0, 20);
  $('ns-cwds').replaceChildren(...cwds.map(c => h('option', { value: c })));
  $('ns-cwd').value = prefs.launchCwd || state.byId.get(state.selected)?.cwd || cwds[0] || '';
  $('ns-name').value = '';
  modelOptions($('ns-model'));
  $('ns-model').value = prefs.launchModel || '';
  $('ns-perm').value = prefs.launchPerm || 'default';
  $('ns-err').hidden = true;
  $('ns-go').disabled = false;
  $('ns-go').textContent = 'Start session';
  dlg.showModal();
  ($('ns-cwd').value ? $('ns-prompt') : $('ns-cwd')).focus();
}
$('new-btn').onclick = () => openLaunch();

// ------------------------------------------------------------ all sessions
// A searchable list of every session the deck knows, closed ones included.
const hist = { q: '', i: 0, ids: [] };
function openHistory() {
  hideCard(true);
  hist.q = ''; hist.i = 0; $('hist-q').value = '';
  renderHistory();
  $('history').showModal(); $('hist-q').focus();
}
function renderHistory() {
  const snap = state.snapshot;
  const lists = railLists();
  const where = new Map();
  for (const b of ['active', 'recent', 'closed']) for (const s of lists[b]) where.set(s.id, b);
  const all = [...snap.active, ...snap.recent, ...snap.closed].sort((a, b) => b.mtime - a.mtime);
  const list = all.filter(s => matchesQuery(s, hist.q));
  hist.ids = list.map(s => s.id);
  hist.i = Math.max(0, Math.min(hist.i, list.length - 1));
  $('hist-n').textContent = hist.q ? `${list.length} of ${all.length}` : `${all.length}`;
  const rows = list.slice(0, 300).map((s, i) => {
    const sig = sigOf(s);
    const b = where.get(s.id);
    return h('li', { role: 'option', class: `hist-row${i === hist.i ? ' cur' : ''}${s.id === state.selected ? ' selected' : ''}`, 'aria-selected': String(i === hist.i), dataset: { id: s.id } },
      h('span', { class: `dot sig-${sig}` }),
      h('span', { class: 't' }, h('span', { class: 'tt' }, s.title || s.id), h('span', { class: 'sub' }, [nestedChild(s) ? `sub-task of ${state.byId.get(s.spawnedBy).title}` : null, tilde(s.cwd) || s.project, s.gitBranch, s.pr ? `PR #${s.pr.number}` : null].filter(Boolean).join(' · '))),
      h('span', { class: `hb hb-${b}` }, s.hidden ? 'closed by you' : b),
      h('span', { class: 'r', title: new Date(s.mtime).toLocaleString() }, ago(Date.now() - (s.mtime || 0))));
  });
  if (!rows.length) rows.push(h('li', { class: 'hist-empty muted' }, hist.q ? `No session matches “${hist.q}”.` : 'No sessions yet.'));
  if (list.length > 300) rows.push(h('li', { class: 'hist-empty muted' }, `+${list.length - 300} more · narrow the search`));
  $('hist-list').replaceChildren(...rows);
  $('hist-list').querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}
function pickHistory(id) { if (!id) return; $('history').close(); select(id); }
$('history-btn').onclick = $('history-btn-f').onclick = openHistory;
$('hist-q').addEventListener('input', (e) => { hist.q = e.target.value.trim(); hist.i = 0; renderHistory(); });
$('hist-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hist.i += e.key === 'ArrowDown' ? 1 : -1; renderHistory(); }
  else if (e.key === 'Enter') { e.preventDefault(); pickHistory(hist.ids[hist.i]); }
});
$('hist-list').addEventListener('click', (e) => { const li = e.target.closest('.hist-row'); if (li) pickHistory(li.dataset.id); });
$('history').addEventListener('click', (e) => { if (e.target === $('history')) $('history').close(); });
$('ns-cancel').onclick = () => $('new-session').close();
const launchFiles = attachable({ input: $('ns-prompt'), tray: $('ns-files'), clip: $('ns-clip'), file: $('ns-file'), drop: $('ns-form'), toast });
$('ns-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('ns-form').requestSubmit(); } });
$('ns-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { cwd: $('ns-cwd').value.trim(), prompt: $('ns-prompt').value, model: $('ns-model').value, permissionMode: $('ns-perm').value, name: $('ns-name').value.trim() };
  if (launchFiles.busy()) { toast('Still reading the attachments…'); return; }
  const files = launchFiles.payload();
  if (files.length) body.attachments = files;
  if (!body.prompt.trim() && !files.length) { $('ns-prompt').focus(); return; }
  $('ns-go').disabled = true; $('ns-err').hidden = true;
  $('ns-go').textContent = 'Starting…';
  try {
    const st = await api.post('/api/launch', body);
    prefs.launchCwd = body.cwd;
    prefs.launchPerm = body.permissionMode; savePrefs();
    state.deck.set(st.id, st);
    $('ns-prompt').value = ''; launchFiles.clear();
    $('new-session').close();
    if (state.byId.has(st.id) && state.selected === st.id) { renderHeader(); renderQueue(); focusCompose(); }
    else if (state.byId.has(st.id)) openLaunched(st.id);
    else { state.pendingOpen = st.id; toast('Session started. Opening it as soon as it writes its transcript…'); }
  } catch (err) {
    $('ns-err').textContent = err instanceof TypeError && files.length ? sendError(err, files.length).replace('Send', 'Start')
      : err.message === 'not found'
      ? 'The deck backend is older than this page and cannot launch sessions. Restart it (stop the server and run npm start, or quit and relaunch the app), then try again.'
      : err.message;
    $('ns-err').hidden = false;
    $('ns-go').disabled = false; $('ns-go').textContent = 'Start session';
  }
});
function openLaunched(id) {
  state.pendingOpen = null;
  select(id).then(() => focusCompose());
}

// ------------------------------------------------------------ events list
let rowsTimer = null;
function scheduleRows(jump = false) {
  if (rowsTimer) { if (jump) rowsTimer.jump = true; return; }
  const t = { jump };
  rowsTimer = t;
  requestAnimationFrame(() => { rowsTimer = null; buildRows(); followLive(); renderRows(t.jump); if (state.tab === 'changes') renderTurns(); });
}
const isErr = (ev) => (ev.kind === 'tool' && ev.tool.isError) || !!ev.error;
// A Bash command's category depends only on its input, so it's safe to keep.
const catOf = (ev) => ev._cat || (ev._cat = filterCat(ev));
function evMatches(ev, q) {
  if (!q) return true;
  const hay = (ev.kind === 'tool' ? `${ev.tool.display} ${ev.tool.summary} ${JSON.stringify(ev.tool.input).slice(0, 2000)}` : `${ev.kind} ${ev.text || ''} ${ev.subtype || ''}`) + ' ' + tagFor(ev).label;
  return hay.toLowerCase().includes(q);
}
function keepKind(ev) {
  return allKinds() || state.kinds.has(catOf(ev)) || (state.kinds.has('errors') && isErr(ev));
}
/**
 * Turn numbering and per-turn totals, chronological. Also marks each finished
 * turn's last message as its answer, and folds the queue's bookkeeping: a
 * message that was delivered shows as its prompt (with the wait), so only
 * still-waiting and withdrawn messages keep a row of their own (`hidden`).
 */
function turnInfo(events, live) {
  const info = new Map(); let n = 0; let cur = null; let lastText = null;
  const hidden = new Set(); const waiting = []; let wait = null; let lastTs = null;
  for (const ev of events) {
    if (ev.kind !== 'prompt' && ev.ts) lastTs = ev.ts;
    if (ev.kind === 'queue') {
      if (ev.op === 'enqueue') waiting.push(ev);
      else {
        const i = ev.text ? waiting.findIndex(q => q.text === ev.text) : -1;
        const q = i >= 0 ? waiting.splice(i, 1)[0] : waiting.shift();
        if (q) hidden.add(q.id);
        if (ev.op === 'dequeue') { hidden.add(ev.id); wait = q?.ts && ev.ts ? Date.parse(ev.ts) - Date.parse(q.ts) : null; }
      }
      continue;
    }
    if (ev.kind === 'prompt') {
      // A new prompt closes a turn that never logged its end (terminal sessions).
      if (lastText) lastText.answer = true;
      if (cur && !cur.done) cur.done = { count: cur.count, dur: cur.start && lastTs ? Date.parse(lastTs) - Date.parse(cur.start) : null };
      n++; cur = { n, start: ev.ts, count: 0, prompt: ev, queuedMs: wait }; info.set(ev.id, cur); lastText = null; wait = null;
    }
    else if (ev.kind === 'text') { lastText = ev; if (cur) cur.count++; }
    else if (ev.kind === 'turn_end') {
      if (lastText) lastText.answer = true;
      lastText = null;
      if (cur) {
        const dur = cur.start && ev.ts ? Date.parse(ev.ts) - Date.parse(cur.start) : null;
        cur.done = { count: cur.count, dur };
        info.set(ev.id, { text: `Turn ${cur.n} ended · ${cur.count} events${dur != null ? ' · ' + fmtMs(dur) : ''}${ev.text ? ' · ' + ev.text : ''}` });
        cur = null;
      }
    } else if (cur && ev.kind !== 'thinking') cur.count++;
  }
  // An idle session's last message is its answer, logged end or not.
  if (lastText && !live && events.at(-1) === lastText) lastText.answer = true;
  info.hidden = hidden;
  for (const v of info.values()) {
    if (!v.prompt) continue;
    const t = fmtTime(v.prompt.ts);
    v.meta = v.done ? `Turn ${v.n} · ${t} · ${v.done.count} events${v.done.dur != null ? ' · ' + fmtMs(v.done.dur) : ''}` : `Turn ${v.n} · ${t}${live ? ' · live' : ''} · ${v.count} events so far`;
  }
  return info;
}
function buildRows() {
  const c = state.cache.get(state.selected);
  const rows = [];
  if (!c) { state.rows = rows; state.offsets = []; state.total = 0; return; }
  const q = state.filter.toLowerCase();
  const s = state.byId.get(state.selected);
  const turns = turnInfo(c.events, phaseOf(s) === 'working');
  // Under a kind filter a prompt stays as context only for turns with a match
  // (rows run newest first, so a turn's events arrive before its prompt).
  const narrowed = !allKinds() && !state.kinds.has('messages');
  let hits = 0;
  const push = (ev, depth, turn = null) => {
    if (turns.hidden.has(ev.id)) return;
    if (ev.kind === 'turn_end' && !allKinds()) return;
    if (ev.kind === 'prompt' && narrowed) { if (!hits) return; hits = 0; rows.push({ ev, depth, turn }); return; }
    if (ev.kind !== 'prompt' && ev.kind !== 'turn_end' && !keepKind(ev)) return;
    if (!evMatches(ev, q)) return;
    hits++;
    rows.push({ ev, depth, turn });
  };
  // Newest first. Inline subagent events sit directly under their Agent row.
  for (let i = c.events.length - 1; i >= 0; i--) {
    const ev = c.events[i];
    push(ev, 0, turns.get(ev.id) || null);
    if (ev.kind === 'tool' && ev.tool.agentId && state.expanded.has(ev.tool.agentId)) {
      const ac = state.cache.get(ev.tool.agentId);
      if (ac?.loaded) for (let j = ac.events.length - 1; j >= 0; j--) push(ac.events[j], 1);
      else rows.push({ ev: { id: `loading:${ev.tool.agentId}`, kind: 'system', subtype: 'loading', text: 'loading subagent events…', ts: null, sessionId: ev.tool.agentId }, depth: 1 });
    }
  }
  const offsets = new Array(rows.length); let y = 0;
  for (let i = 0; i < rows.length; i++) { offsets[i] = y; y += rowHeight(rows[i].ev); }
  state.rows = rows; state.offsets = offsets; state.total = y;
  $('events-count').textContent = rows.length;
  const counts = { errors: 0 };
  for (const ev of c.events) {
    if (turns.hidden.has(ev.id) || ev.kind === 'turn_end') continue;
    if (isErr(ev)) counts.errors++;
    const k = catOf(ev); counts[k] = (counts[k] || 0) + 1;
  }
  state.kindCounts = counts;
  // The red mark is a "just failed" signal, not a tally: it shows only while
  // the newest event is an error (thinking and turn ends don't count), and
  // goes away on its own once the agent moves on. Errors stay in the filter.
  let fresh = 0;
  for (let i = c.events.length - 1; i >= 0; i--) {
    const ev = c.events[i];
    if (turns.hidden.has(ev.id) || ev.kind === 'turn_end' || ev.kind === 'thinking') continue;
    if (!isErr(ev)) break;
    fresh++;
  }
  $('err-count').textContent = fresh || '';
  $('err-count').title = fresh ? (fresh > 1 ? `The last ${fresh} events failed` : 'The last event failed') : '';
  if ($('kind-pop').matches(':popover-open')) renderKindPop();
}
const vlist = $('vlist'), vspacer = $('vspacer'), vrows = $('vrows');
function rowIndexAt(y) {
  const o = state.offsets; let lo = 0, hi = o.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (o[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function renderRows(jump = false) {
  const n = state.rows.length;
  vspacer.style.height = `${state.total + 12}px`;
  if (jump || state.live) vlist.scrollTop = 0; // newest rows live at the top
  if (!n) {
    vrows.replaceChildren(h('div', { class: 'pad muted' }, state.cache.get(state.selected)?.loaded ? (state.filter || !allKinds() ? 'No events match.' : 'No events yet.') : 'Loading…'));
    return;
  }
  const first = rowIndexAt(Math.max(0, vlist.scrollTop - 200));
  const limit = vlist.scrollTop + vlist.clientHeight + 200;
  vrows.style.transform = `translateY(${state.offsets[first] + 6}px)`;
  const frag = document.createDocumentFragment();
  for (let i = first; i < n && state.offsets[i] < limit; i++) {
    const { ev, depth, turn } = state.rows[i];
    const agentStatus = ev.kind === 'tool' && ev.tool.agentId ? state.byId.get(ev.tool.agentId)?.status : null;
    frag.append(renderRow(ev, { depth, selected: ev.id === state.cursor, agentStatus, expanded: ev.kind === 'tool' && state.expanded.has(ev.tool.agentId), turn }));
  }
  vrows.replaceChildren(frag);
  applyRing();
}
vlist.addEventListener('scroll', () => {
  const atTop = vlist.scrollTop <= 30;
  if (!atTop && state.live) setLive(false);
  else if (atTop && !state.live && !state.picked) setLive(true);
  renderRows();
});
vlist.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const row = e.target.closest('.row');
  if (btn?.classList.contains('agent-open')) { e.stopPropagation(); select(btn.dataset.agent); return; }
  if (btn?.classList.contains('agent-toggle')) {
    e.stopPropagation();
    const id = btn.dataset.agent;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else { state.expanded.add(id); loadSession(id).then(() => scheduleRows()).catch(err => toast(err.message)); }
    scheduleRows(); return;
  }
  if (btn?.classList.contains('task-open')) { e.stopPropagation(); showTaskDetails(row.dataset.sid, btn.dataset.task); return; }
  if (!row || row.classList.contains('k-turn_end')) return;
  const ev = findEvent(row.dataset.sid, row.dataset.id);
  if (!ev) return;
  if (ev.kind === 'system' && ev.subtype === 'task' && taskOf(ev.sessionId, ev.taskId)) { setCursor(ev.id); showTaskDetails(ev.sessionId, ev.taskId); return; }
  pickEvent(); setCursor(ev.id); showEventDetails(ev);
  if (btn?.dataset.askRow) askEvent(ev);
});
function findEvent(sessionId, id) { return state.cache.get(sessionId)?.byId.get(id) || null; }
function setCursor(id) { state.cursor = id; renderRows(); }
/**
 * Live: the event list sits on the newest event and an open details pane shows
 * it. Looking at anything else drops out of live; either Live button (stream
 * toolbar or details pane) brings both back to the newest event.
 */
function setLive(on, quiet = false) {
  state.live = on;
  if (on) state.picked = false;
  for (const b of [$('follow'), $('details-pin')]) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Live: showing the newest event (l to pause)' : 'Go live: jump to the newest event (l)'; }
  if (on && !quiet) { vlist.scrollTop = 0; followLive(); renderRows(); }
}
function pickEvent() { state.picked = true; setLive(false); }
// The kind filter: a glyph button opening a multi-select of glyphs (names in
// tooltips, counts beside them). From "all", picking a glyph shows just that
// kind; after that each pick adds or removes one. Empty means all again.
function initKinds() {
  const ks = FILTERS.map(f => f.k);
  const saved = Array.isArray(prefs.evKinds) ? prefs.evKinds.filter(k => ks.includes(k)) : null;
  return new Set(saved?.length ? saved : prefs.showThinking === false ? ks.filter(k => k !== 'thinking') : ks);
}
const allKinds = () => FILTERS.every(f => state.kinds.has(f.k));
const kindsLabel = () => allKinds() ? FILTER_ALL.label : FILTERS.filter(f => state.kinds.has(f.k)).map(f => f.label).join(', ');
function setKinds(ks) {
  state.kinds = new Set(ks.length ? ks : FILTERS.map(f => f.k));
  prefs.evKinds = allKinds() ? null : [...state.kinds]; savePrefs();
  paintKind();
  if ($('kind-pop').matches(':popover-open')) renderKindPop();
  scheduleRows(true);
}
function pickKind(k) {
  if (k === 'all') return setKinds([]);
  if (allKinds()) return setKinds([k]);
  const ks = new Set(state.kinds); ks.has(k) ? ks.delete(k) : ks.add(k);
  setKinds([...ks]);
}
const glyph = (f) => h('span', { class: `tic f-${f.fam}` }, svgUse(f.icon, 15));
function paintKind() {
  const on = FILTERS.filter(f => state.kinds.has(f.k));
  const all = allKinds();
  const more = !all && on.length > 3 ? [h('span', { class: 'kb-more' }, `+${on.length - 3}`)] : [];
  $('kind-ico').replaceChildren(...(all ? [glyph(FILTER_ALL)] : on.slice(0, 3).map(glyph)), ...more);
  const btn = $('kind-btn'); btn.classList.toggle('on', !all);
  btn.title = `Showing: ${kindsLabel()}`; btn.setAttribute('aria-label', btn.title);
}
function renderKindPop() {
  const n = state.kindCounts || {};
  const all = allKinds();
  const item = (f, k, checked, count) => h('button', {
    type: 'button', role: 'menuitemcheckbox', class: `kp-item${k === 'all' ? ' kp-all' : ''}`, 'aria-checked': String(checked), dataset: { k },
    title: f.label, 'aria-label': `${f.label}${count ? ', ' + count : ''}`,
  }, glyph(f), h('span', { class: 'kp-n' }, count ? fmtTokens(count) : ''));
  const total = FILTERS.reduce((t, f) => t + (f.k === 'errors' ? 0 : n[f.k] || 0), 0);
  $('kind-pop').classList.toggle('some', !all);
  $('kind-pop').replaceChildren(item(FILTER_ALL, 'all', all, total), h('span', { class: 'kp-sep', role: 'separator' }),
    ...FILTERS.filter(f => n[f.k] || state.kinds.has(f.k) && !all).map(f => item(f, f.k, !all && state.kinds.has(f.k), n[f.k])));
  return $('kind-pop');
}
$('kind-pop').addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  const r = $('kind-btn').getBoundingClientRect();
  const pop = renderKindPop();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, r.left + r.width / 2 - pop.offsetWidth / 2)}px`;
  pop.querySelector('.kp-item')?.focus();
});
$('kind-pop').addEventListener('click', (e) => {
  const b = e.target.closest('.kp-item'); if (!b) return;
  pickKind(b.dataset.k);
  $('kind-pop').querySelector(`[data-k="${b.dataset.k}"]`)?.focus();
});
$('kind-pop').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...$('kind-pop').querySelectorAll('.kp-item')];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});
paintKind();
$('follow').onclick = () => setLive(true);
$('ev-filter').oninput = (e) => { state.filter = e.target.value; scheduleRows(); };

function scrollToRow(i) {
  const top = state.offsets[i]; const hgt = rowHeight(state.rows[i].ev);
  if (top < vlist.scrollTop) vlist.scrollTop = Math.max(0, top - 8);
  else if (top + hgt > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = top + hgt - vlist.clientHeight + 8;
}
function moveCursor(delta) {
  if (!state.rows.length) return;
  let i = state.rows.findIndex(r => r.ev.id === state.cursor);
  do {
    i = i < 0 ? (delta > 0 ? 0 : state.rows.length - 1) : Math.max(0, Math.min(state.rows.length - 1, i + delta));
  } while (state.rows[i].ev.kind === 'turn_end' && i > 0 && i < state.rows.length - 1);
  const ev = state.rows[i].ev;
  pickEvent();
  state.cursor = ev.id;
  scrollToRow(i);
  renderRows();
  showEventDetails(ev);
}
function jumpToSeq(seq) {
  const c = state.cache.get(state.selected); if (!c) return;
  const ev = c.events.find(e => e.seq === seq); if (!ev) { toast('That event is not loaded'); return; }
  if (!allKinds() || state.filter) { state.filter = ''; $('ev-filter').value = ''; setKinds([]); buildRows(); }
  setTab('events'); pickEvent();
  const i = state.rows.findIndex(r => r.ev.id === ev.id);
  state.cursor = ev.id;
  if (i >= 0) scrollToRow(i);
  renderRows(); showEventDetails(ev);
}

document.addEventListener('keydown', (e) => {
  if (e.key === '.' && (e.metaKey || e.ctrlKey) && state.selected && !$('stop').hidden && !$('stop').disabled) { e.preventDefault(); interruptSession(); return; }
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]') || document.querySelector('[popover]:popover-open')) return;
  // Read aloud works everywhere, the overview included.
  if (e.key === ' ') { e.preventDefault(); narration.toggle(); return; }
  if (e.key === ']') { e.preventDefault(); narration.skip(); return; }
  if (e.key === 'j') { e.preventDefault(); jumpToNarration(); return; }
  if (e.key === 'b') { e.preventDefault(); $('bell-pop').showPopover(); return; }
  if (e.key === 'Escape') { if (state.ask) closeAsk(); else if (state.selected) goOverview(); return; }
  if (e.key === 'n') { e.preventDefault(); openLaunch(); return; }
  if (e.key === 'h') { e.preventDefault(); openHistory(); return; }
  if (e.key === '[') { e.preventDefault(); setRailMin(!prefs.railMin); return; }
  if (!state.selected) { if (e.key === '/') { e.preventDefault(); $('tree-filter').focus(); } else if (e.key === '?') $('keys').showModal(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter') { const ev = state.cursor && findEvent(state.selected, state.cursor); if (ev) showEventDetails(ev); }
  else if (e.key === 'l') { e.preventDefault(); state.live ? pickEvent() : setLive(true); }
  else if (e.key === 'r') { e.preventDefault(); if (!readEvent(state.cursor && findEvent(state.selected, state.cursor))) readBrief(state.selected); }
  else if (e.key === '/') { e.preventDefault(); $('ev-filter').focus(); }
  else if (e.key === 'a') { e.preventDefault(); const ev = state.cursor && findEvent(state.selected, state.cursor); ev ? askEvent(ev) : openAsk({ kind: 'brief', sessionId: state.selected, label: 'Session brief', what: 'this session' }, { type: 'brief' }); }
  else if (e.key === '?') $('keys').showModal();
  else if (['1', '2', '3', '4', '5'].includes(e.key)) setTab(['events', 'files', 'changes', 'shell', 'bg'][+e.key - 1]);
});
$('keys-btn').onclick = () => $('keys').showModal();

// ------------------------------------------------------------ details
const detailCtx = (ev) => {
  let position = null;
  if (ev) {
    const c = state.cache.get(ev.sessionId);
    if (c) {
      const i = c.events.indexOf(c.byId.get(ev.id));
      let a = i; while (a > 0 && c.events[a].kind !== 'prompt') a--;
      let n = 0; for (const x of c.events) if (x.kind === 'prompt') { n++; if (x === c.events[a]) break; }
      if (i >= 0 && c.events[a]?.kind === 'prompt') position = `Turn ${n} · step ${i - a}`;
    }
  }
  return {
    cwd: state.byId.get(state.selected)?.cwd || state.cache.get(state.selected)?.meta?.cwd || null,
    root: state.changes?.root || null,
    api, selectSession: select, position,
    agentStatus: (id) => state.byId.get(id)?.status || null,
    runInShell: (cmd) => { setTab('shell'); $('sh-cmd').value = cmd; $('sh-cmd').focus(); },
    readAloud: readEvent,
    openTask: (taskId) => { const tk = ev && taskOf(ev.sessionId, taskId); return tk ? { task: tk, state: taskState(tk, aliveOf(ev.sessionId)), open: () => showTaskDetails(ev.sessionId, taskId) } : null; },
  };
};
function syncDetailsPane() { $('deck').classList.toggle('no-details', !state.detailsKey && !state.ask); }
function closeDetails() {
  if (state.ask) closeAsk();
  showDetailsEmpty();
  if (state.cursor) { state.cursor = null; renderRows(); }
  document.querySelectorAll('#files tr.selected, #changes tr.selected').forEach(r => r.classList.remove('selected'));
}
$('details-close').onclick = closeDetails;

// While live, an open details pane tracks the newest event in the stream.
function followLive() {
  if (!state.live || !state.selected || !state.detailsKey || state.ask) return false;
  const ev = state.rows.find(r => r.ev.kind !== 'turn_end' && !r.ev.id.startsWith('loading:'))?.ev;
  if (!ev || state.detailsKey === `${ev.sessionId}:${ev.id}`) return false;
  state.cursor = ev.id; showEventDetails(ev);
  return true;
}
$('details-pin').onclick = () => setLive(true);
setLive(true, true);
function showDetailsEmpty() {
  state.detailsKey = null;
  syncDetailsPane();
  $('details-body').replaceChildren();
}
async function showEventDetails(ev, refreshOnly = false) {
  const key = `${ev.sessionId}:${ev.id}`;
  const body = $('details-body');
  const needsFull = ev.kind === 'tool' && (ev.tool.result?.truncated || ev.tool.result?.images?.length || !ev.tool.pending);
  if (!refreshOnly || state.detailsKey !== key) { state.detailsKey = key; syncDetailsPane(); body.replaceChildren(renderDetails(ev, needsFull ? null : undefined, detailCtx(ev))); body.scrollTop = 0; applyRing(); }
  if (!needsFull && !refreshOnly) return;
  try {
    const d = await api.get(`/api/sessions/${sid(ev.sessionId)}/events/${sid(ev.id)}`);
    if (state.detailsKey !== key) return;
    const scroll = body.scrollTop;
    body.replaceChildren(renderDetails(d.event || ev, d, detailCtx(ev))); body.scrollTop = scroll;
    applyRing();
  } catch (e) { console.warn(e); }
}
$('details-body').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.nav) { moveCursor(Number(b.dataset.nav)); return; }
  if (b.dataset.ask) {
    const spec = JSON.parse(b.dataset.ask);
    const sec = b.closest('.dsec');
    if (spec.fromSection) spec.text = sec?.querySelector('pre, .md, .sbs-wrap')?.innerText.slice(0, 60_000) || '';
    openAsk(spec, { type: 'sec', key: sec?.querySelector('.dsec-t')?.textContent || '' });
  }
});

// ------------------------------------------------------------ Ask about this
function suggestionsFor(spec) {
  if (spec.kind === 'brief') return ['What should I worry about right now?', 'What happened in the last ten minutes?'];
  if (spec.kind === 'text') {
    const l = spec.label.toLowerCase();
    if (l.startsWith('file')) return ['What is this file for?', 'What did the agent change or rely on here?'];
    if (l.startsWith('diff')) return ['What does this change do?', 'Could this break anything?'];
    if (l.includes('changes')) return ['Summarize these changes', 'Is anything here risky or unfinished?'];
    if (l.includes('files')) return ['Which of these files matter most?', 'What was the agent doing with them?'];
    if (l.includes('events')) return ['What happened in these events?', 'Are there errors I should look at?'];
    if (l.includes('shell')) return ['Explain this output', 'Did this succeed?'];
    if (l.includes('queue')) return ['What will these prompts do?', 'Is anything here redundant?'];
    return ['Which of these needs me first?', 'What is each one doing?'];
  }
  if (spec.kind === 'event') {
    const ev = findEvent(spec.sessionId, spec.eventId);
    if (!ev) return ['Explain this'];
    if (ev.kind === 'tool') {
      const t = ev.tool;
      if (t.isError) return ['Why did this fail?', 'What would fix it?'];
      if (t.name === 'Bash') return spec.label.startsWith('Command') ? ['What does this command do?', 'Is it safe?'] : ['Summarize this output', 'Did this do what the agent intended?'];
      if (/Edit|Write/.test(t.name)) return ['What does this change do?', 'Could this break anything?'];
      if (t.name === 'Read') return ['Why did the agent read this?', 'What is this file for?'];
      if (t.name === 'Agent') return ['What did this subagent accomplish?', 'Is it stuck or done?'];
      return ['What did this call do?', 'What came back?'];
    }
    if (ev.kind === 'prompt') return ['How far has the agent got with this?', 'Did it do what was asked?'];
    if (ev.kind === 'thinking') return ['Summarize this reasoning', 'What did it decide?'];
    return ['What is it claiming here, and is it supported?', 'What should I check?'];
  }
  return ['Explain this'];
}
function scopeOf(spec) {
  if (spec.kind === 'event') return { kind: 'event', sessionId: spec.sessionId, eventId: spec.eventId, label: spec.label };
  if (spec.kind === 'brief') return { kind: 'brief', sessionId: spec.sessionId, label: spec.label };
  if (spec.kind === 'session') return { kind: 'session', sessionId: spec.sessionId, label: spec.label };
  return { kind: 'text', label: spec.label, text: spec.text || '' };
}
function openAsk(spec, ring) {
  const sessionId = spec.sessionId || state.selected || null;
  const extras = [];
  if (spec.kind === 'event') extras.push({ label: 'its turn', item: { kind: 'turn', sessionId: spec.sessionId, eventId: spec.eventId }, on: false });
  if (spec.kind === 'brief') extras.push({ label: 'recent events', item: { kind: 'session', sessionId }, on: true });
  else if (sessionId) extras.push({ label: 'session brief', item: { kind: 'brief', sessionId }, on: false });
  state.ask = { spec, primary: scopeOf(spec), extras, thread: [], sessionId, ring };
  renderAsk();
  applyRing();
  $('ask').querySelector('input')?.focus();
}
function askEvent(ev) {
  const what = ev.kind === 'tool' ? `this ${ev.tool.display} call` : ev.kind === 'prompt' ? 'this prompt' : ev.kind === 'text' ? 'this message' : 'this event';
  openAsk({ kind: 'event', sessionId: ev.sessionId, eventId: ev.id, label: `${tagFor(ev).label} ${fmtTime(ev.ts)}`, what }, { type: 'row', id: ev.id });
}
function closeAsk() { state.ask = null; $('ask').hidden = true; applyRing(); syncDetailsPane(); }
function renderAsk() {
  const a = state.ask; const el = $('ask');
  syncDetailsPane();
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const chips = h('div', { class: 'ask-chips' }, h('span', { class: 'ask-chip primary', title: 'always included' }, a.primary.label || 'This item'));
  a.extras.forEach((x) => chips.append(h('button', { type: 'button', class: 'ask-chip', 'aria-pressed': String(x.on), onclick: () => { x.on = !x.on; renderAsk(); } }, `${x.on ? '✓' : '+'} ${x.label}`)));
  const thread = h('div', { class: 'ask-thread' });
  for (const m of a.thread) {
    thread.append(h('div', { class: 'qa-q' }, m.q));
    if (m.pending) thread.append(h('div', { class: 'qa-a' }, h('span', { class: 'spin' })));
    else if (m.err) thread.append(h('div', { class: 'qa-a err' }, m.err));
    else thread.append(h('div', { class: 'qa-a' }, h('div', { class: 'md', html: markdown(m.a) }), h('div', { class: 'qa-meta' }, [fmtMs(m.ms), m.cost ? fmtUsd(m.cost) : null].filter(Boolean).join(' · '), ib('i-speaker', 'Read this answer aloud', () => narration.read({ sessionId: a.sessionId, kind: 'said', markdown: m.a }), { size: 12 }))));
  }
  const input = h('input', { type: 'text', placeholder: `Ask anything about ${a.spec.what || 'this'}…`, 'aria-label': 'Your question' });
  const send = h('button', { type: 'submit', 'aria-label': 'Send question' }, svgUse('i-send', 12));
  const form = h('form', { class: 'ask-in', onsubmit: (e) => { e.preventDefault(); sendAsk(input.value); } }, input, send);
  const parts = [
    h('div', { class: 'ask-h' }, starIcon(13), h('h3', { id: 'ask-h' }, `Ask about ${a.spec.what || 'this'}`), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon-btn sm ghost', 'aria-label': 'Close Ask', onclick: closeAsk }, svgUse('i-x', 12))),
    chips, thread,
  ];
  if (!a.thread.length) parts.push(h('div', { class: 'ask-sugg' }, ...suggestionsFor(a.spec).map(q => h('button', { type: 'button', onclick: () => sendAsk(q) }, q))));
  parts.push(form, h('p', { class: 'ask-foot' }, state.narrator.enabled
    ? `Answered by a separate read-only call (${state.narrator.askModel || 'model'}). The session is not interrupted.`
    : 'Model calls are off (server started with --no-narrator).'));
  el.replaceChildren(...parts);
  thread.scrollTop = thread.scrollHeight;
}
async function sendAsk(q) {
  const a = state.ask; q = String(q || '').trim();
  if (!a || !q) return;
  const msg = { q, pending: true };
  narration.hold(false);
  a.thread.push(msg); renderAsk();
  const scope = [a.primary, ...a.extras.filter(x => x.on).map(x => x.item)];
  try {
    const r = await api.post('/api/ask', { question: q, scope, sessionId: a.sessionId });
    Object.assign(msg, { pending: false, a: r.answer, ms: r.durationMs, cost: r.costUsd });
  } catch (e) {
    const auth = /authenticat|login|oauth/i.test(e.message);
    Object.assign(msg, { pending: false, err: `${e.message}${auth ? '. Run claude in a terminal and sign in (/login).' : ''}` });
  }
  if (state.ask === a) { renderAsk(); $('ask').querySelector('input')?.focus(); }
}

/** Ask about a whole list: the text sent is what the list shows. */
function askList(key, btn) {
  const sessLines = (list) => list.map(s => `- ${s.title} | ${tilde(s.cwd)} | ${SIG_LABEL[sigOf(s)]}${s.gitBranch ? ' | ' + s.gitBranch : ''}${s.glance?.errors ? ` | ${s.glance.errors} errors` : ''} | last said: ${oneLine(s.glance?.lastText || '', 160)}${briefLine(s.id) ? ' | brief: ' + oneLine(briefLine(s.id), 300) : ''}`).join('\n');
  let spec, ring;
  switch (key) {
    case 'events': {
      const lines = state.rows.slice(0, 400).map(({ ev }) => `${fmtTime(ev.ts)} ${tagFor(ev).label} ${ev.kind === 'tool' ? ev.tool.summary + (ev.tool.isError ? ' [error]' : '') : oneLine(ev.text || '', 200)}`);
      spec = { kind: 'text', label: `Events (${kindsLabel()}${state.filter ? `, filter "${state.filter}"` : ''})`, text: lines.join('\n'), what: 'these events' }; ring = { type: 'sel', sel: '#vlist' }; break;
    }
    case 'files': {
      const cwd = state.byId.get(state.selected)?.cwd;
      const shown = [...$('files').querySelectorAll('.frow[aria-level]')].map(r => '  '.repeat(+r.getAttribute('aria-level') - 1) + r.querySelector('.fname').textContent + (r.classList.contains('dir') ? '/' : ''));
      spec = { kind: 'text', label: `Files in ${basename(cwd || '')}`, text: `Folder tree as shown:\n${shown.join('\n')}\n\nFiles this session touched:\n${(state.files || []).map(f => `${relPath(f.path, cwd)} reads=${f.reads} writes=${f.writes} last=${f.lastTs || ''}`).join('\n')}`, what: 'these files' }; ring = { type: 'sel', sel: '#files' }; break;
    }
    case 'changes': {
      const c = state.changes;
      if (changesMode() === 'turns') {
        spec = { kind: 'text', label: 'Changes by turn', text: ct.turns.map(t => `Turn ${t.n}: ${oneLine(t.prompt?.text || '', 120)} (+${t.add} -${t.del})\n${t.files.map(f => `  ${f.rel} +${f.add} -${f.del}${f.created ? ' (new)' : ''}${f.edits.length > 1 ? ` x${f.edits.length}` : ''}`).join('\n')}${t.shell.length ? `\n  + ${t.shell.length} edit(s) by shell command` : ''}`).join('\n') || '(no changes)', what: 'these changes' };
        ring = { type: 'sel', sel: '#changes-turns' }; break;
      }
      spec = { kind: 'text', label: 'Git changes', text: c?.repo ? `branch ${c.branch} ahead ${c.ahead ?? '?'} behind ${c.behind ?? '?'}\n${c.files.map(f => `${f.untracked ? '??' : (f.x + f.y).trim()} ${f.path} +${f.added ?? 0} -${f.deleted ?? 0}`).join('\n')}\nrecent commits:\n${c.commits.map(k => `${k.short} ${k.subject}`).join('\n')}` : 'not a git repository', what: 'these changes' };
      ring = { type: 'sel', sel: '#changes' }; break;
    }
    case 'queue': spec = { kind: 'text', label: 'Prompt queue', text: (state.cache.get(state.selected)?.meta?.queue || []).map((x, i) => `${i + 1}. ${x.content}`).join('\n') || '(empty)', what: 'the prompt queue' }; ring = { type: 'sel', sel: '#queue' }; break;
    case 'active': case 'recent': spec = { kind: 'text', label: `${key === 'active' ? 'Active' : 'Recent'} sessions`, text: sessLines(railLists()[key]), what: `${key} sessions` }; ring = { type: 'sel', sel: `.bucket[data-bucket=${key}] ul` }; break;
    case 'ov-needs': spec = { kind: 'text', label: 'Sessions that need you', text: sessLines(state.snapshot.active.filter(s => needsYou(s) || recentErr(s))), what: 'what needs you' }; ring = { type: 'sel', sel: '[data-ov=needs]' }; break;
    case 'ov-working': spec = { kind: 'text', label: 'Working sessions', text: sessLines(state.snapshot.active.filter(s => sigOf(s) === 'working')), what: 'the working sessions' }; ring = { type: 'sel', sel: '[data-ov=working]' }; break;
    case 'ov-recent': spec = { kind: 'text', label: 'Recently finished sessions', text: sessLines(state.snapshot.recent.slice(0, 8)), what: 'recently finished sessions' }; ring = { type: 'sel', sel: '[data-ov=recent]' }; break;
    default: return;
  }
  openAsk(spec, ring);
}
document.querySelector('.tabs').parentElement.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ask-list]');
  if (b && !b.closest('#tree') && !b.closest('#overview')) askList(b.dataset.askList, b);
});

function applyRing() {
  document.querySelectorAll('.asking').forEach(x => x.classList.remove('asking'));
  const r = state.ask?.ring; if (!r) return;
  let el = null;
  if (r.type === 'brief') el = $('brief-box');
  else if (r.type === 'row') el = vrows.querySelector(`.row[data-id="${CSS.escape(r.id)}"]`);
  else if (r.type === 'sec') el = [...$('details-body').querySelectorAll('.dsec')].find(s => s.querySelector('.dsec-t')?.textContent === r.key);
  else if (r.type === 'sel') el = document.querySelector(r.sel);
  el?.classList.add('asking');
}

// ------------------------------------------------------------ tabs
function setTab(name) {
  state.tab = name; prefs.tab = name; savePrefs();
  document.querySelectorAll('.tab-b').forEach(b => { b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'events') renderRows();
  if (name === 'files' && state.selected) loadFiles();
  if (name === 'changes' && state.selected) { loadChanges(); renderTurns(); }
  if (name === 'shell') $('sh-cmd').focus();
  if (name === 'bg') renderBackground();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-b'); if (b) setTab(b.dataset.tab); });

// ------------------------------------------------------------ files tab
// A tree of the session's folder (files.js); folders open and close in place,
// picking a file shows it in the details pane. The session's own reads/writes mark the tree.
const files = createFilesView({
  list: $('files'), crumbs: $('files-crumbs'), find: $('files-find'), api,
  onOpen: ({ rel, abs, entry }) => openFile(abs, null, { rel, git: entry?.git, size: entry?.size, mtime: entry?.mtime }),
  openEditor: (p, line) => api.openEditor(p, line),
  onCount: (n) => { $('files-count').textContent = n || ''; },
});
async function loadFiles() {
  const id = state.selected; if (!id) return;
  const cwd = state.byId.get(id)?.cwd || state.cache.get(id)?.meta?.cwd || null;
  try {
    const r = await api.get(`/api/sessions/${sid(id)}/files`).catch(() => ({ files: [] }));
    if (state.selected !== id) return;
    state.files = r.files;
    await files.show(id, cwd, r.files || []);
    paintFilesToggles();
  } catch (e) { $('files').replaceChildren(h('div', { class: 'pad muted' }, e.message)); }
}
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|mp3|wav|ogg|m4a|flac|mp4|webm|mov)$/i;
async function openFile(path, line = null, info = {}) {
  pickEvent(); state.detailsKey = `file:${path}`; syncDetailsPane();
  const ctx = { ...detailCtx(), root: files.root, openPath: (p) => openPathFromLink(p) };
  const rel = info.rel ?? (files.root && path.startsWith(files.root + '/') ? path.slice(files.root.length + 1) : null);
  try {
    const f = await api.get(`/api/file?path=${encodeURIComponent(path)}${MEDIA_EXT.test(path) ? '&meta=1' : ''}`);
    if (state.detailsKey !== `file:${path}`) return;
    $('details-body').replaceChildren(renderFileView({ ...info, ...f, abs: path, rel }, ctx));
  } catch (e) { $('details-body').replaceChildren(renderFileView({ abs: path, rel, error: e.message }, ctx)); }
  $('details-body').scrollTop = 0;
}
/** A relative link in rendered markdown: reveal it in the tree when it's inside. */
function openPathFromLink(p) {
  if (files.root && p.startsWith(files.root + '/')) { setTab('files'); files.reveal(p.slice(files.root.length + 1), { open: true }); }
  else openFile(p);
}
function paintFilesToggles() {
  $('files-touched').setAttribute('aria-pressed', String(files.mode === 'touched'));
  $('files-ignored').setAttribute('aria-pressed', String(files.ignored));
}
$('files-touched').onclick = () => { files.setMode(files.mode === 'touched' ? 'tree' : 'touched'); paintFilesToggles(); };
$('files-ignored').onclick = () => { files.setIgnored(!files.ignored); paintFilesToggles(); };
$('files-collapse').onclick = () => files.collapseAll();
$('files-refresh').onclick = () => { loadFiles(); files.refresh(); };

// ------------------------------------------------------------ changes tab
async function loadChanges() {
  const id = state.selected; if (!id) return;
  if (!state.changes) $('changes-head').textContent = 'loading git status…';
  try {
    const r = await api.get(`/api/sessions/${sid(id)}/changes`);
    if (state.selected !== id) return;
    state.changes = r; renderChanges();
  } catch (e) { $('changes').replaceChildren(h('div', { class: 'pad muted' }, e.message)); }
}
function chip(label, title, cls = '') { return h('span', { class: `chip ${cls}`, title }, label); }
function renderChanges() {
  const c = state.changes; const root = $('changes');
  if (!c?.repo) { $('changes-head').textContent = c?.cwd ? `${tilde(c.cwd)} is not a git repository` : 'no cwd'; root.replaceChildren(); $('changes-count').textContent = ''; return; }
  $('changes-count').textContent = c.files.length ? `+${c.totals.added} −${c.totals.deleted}` : '';
  const head = $('changes-head'); head.replaceChildren();
  head.append(chip(c.branch || '(detached)', c.root));
  if (c.upstream) head.append(chip(`${c.upstream} ↑${c.ahead} ↓${c.behind}`, 'ahead / behind upstream', c.behind ? 'err' : ''));
  if (c.vsBase) head.append(chip(`${c.vsBase.base} ↑${c.vsBase.ahead} ↓${c.vsBase.behind}`, 'ahead / behind default branch'));
  head.append(chip(`${c.totals.files} files`, 'changed files'), h('span', { class: 'add-n' }, `+${c.totals.added}`), h('span', { class: 'del-n' }, `−${c.totals.deleted}`));
  const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'St'), h('th', {}, 'File'), h('th', {}, '+'), h('th', {}, '−'), h('th', {}, ''))));
  const tb = h('tbody');
  for (const f of c.files) {
    const st = f.untracked ? '??' : `${f.x}${f.y}`.trim();
    tb.append(h('tr', { onclick: (e) => { tb.querySelectorAll('tr').forEach(r => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); openDiff(f.path); } },
      h('td', {}, h('span', { class: 'st-x', title: `index: ${f.x} · worktree: ${f.y}` }, st)),
      h('td', { title: f.from ? `renamed from ${f.from}` : f.path }, f.path),
      h('td', { class: 'num add-n' }, f.added ?? (f.binary ? 'bin' : '')), h('td', { class: 'num del-n' }, f.deleted ?? ''),
      h('td', {}, ib('i-open', 'Open in editor', (e) => { e.stopPropagation(); api.openEditor(`${c.root}/${f.path}`, 1); }, { size: 13 }))));
  }
  table.append(tb);
  const commits = h('div', { class: 'commits' }, h('div', { class: 'sec-t', style: 'padding: 6px 14px 4px' }, 'Recent commits'));
  for (const k of c.commits) commits.append(h('div', { class: 'c', title: k.sha }, h('span', { class: 'sha' }, k.short), h('span', {}, k.subject), h('span', { class: 'who' }, `${k.author} · ${ago(Date.now() - Date.parse(k.date))}`)));
  root.replaceChildren(c.files.length ? table : h('div', { class: 'pad muted' }, 'Working tree clean.'), commits);
}
async function openDiff(file) {
  pickEvent(); const id = state.selected; state.detailsKey = `diff:${file}`; syncDetailsPane();
  try {
    const d = await api.get(`/api/sessions/${sid(id)}/diff?file=${encodeURIComponent(file)}`);
    if (state.detailsKey !== `diff:${file}`) return;
    $('details-body').replaceChildren(renderDiffDetails(d, detailCtx()));
  } catch (e) { toast(e.message); }
}
$('changes-refresh').onclick = () => { loadChanges(); refreshSnap(true); renderTurns(false); };

// ---- by turn: what each turn changed, file by file (changes.js)
const ct = { collapsed: new Set(), sid: null, selected: null, turns: [], snap: null, snapAt: 0, snapping: false };
/** The deck's git snapshots for this session's turns (lib/turnsnap.mjs); throttled. */
async function refreshSnap(force = false) {
  const id = state.selected; if (!id || ct.snapping || (!force && ct.sid === id && Date.now() - ct.snapAt < 4000)) return;
  ct.snapping = true;
  try { const r = await api.get(`/api/sessions/${sid(id)}/turn-changes`); if (state.selected === id) { ct.snap = r; ct.snapAt = Date.now(); renderTurns(false); } }
  catch { /* no folder / not a repo */ } finally { ct.snapping = false; }
}
const changesMode = () => prefs.changesMode || 'turns';
function paintChangesMode() {
  const m = changesMode();
  $('tab-changes').classList.toggle('by-turn', m === 'turns');
  for (const b of $('changes-mode').children) b.setAttribute('aria-pressed', String(b.dataset.m === m));
}
$('changes-mode').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.changesMode = b.dataset.m; savePrefs(); paintChangesMode();
  if (b.dataset.m === 'turns') renderTurns(); else loadChanges();
};
paintChangesMode();
function renderTurns(fetchSnap = true) {
  if (changesMode() !== 'turns' || !state.selected) return;
  const c = state.cache.get(state.selected); if (!c) return;
  if (ct.sid !== state.selected) { ct.sid = state.selected; ct.collapsed = new Set(); ct.selected = null; ct.snap = null; ct.snapAt = 0; }
  if (fetchSnap) refreshSnap();
  const cwd = state.byId.get(state.selected)?.cwd || c.meta?.cwd || null;
  ct.turns = turnChanges(c.events, cwd, ct.snap);
  const root = $('changes-turns'); const top = root.scrollTop;
  renderTurnList(root, ct.turns, {
    selected: ct.selected, collapsed: ct.collapsed,
    onToggle: (n) => { ct.collapsed.has(n) ? ct.collapsed.delete(n) : ct.collapsed.add(n); renderTurns(false); },
    onFile: (t, f) => openTurnFile(t, f),
    onShell: (ev) => { ct.selected = `ev:${ev.id}`; renderTurns(false); pickEvent(); showEventDetails(ev); },
  });
  root.scrollTop = top;
}
async function openTurnFile(turn, file) {
  const id = state.selected; const key = `tdiff:${turn.n}:${file.path}`;
  ct.selected = `${turn.n}:${file.path}`; renderTurns(false);
  pickEvent(); state.detailsKey = key; syncDetailsPane();
  const ctx0 = { ...detailCtx(), jump: (ev) => { setTab('events'); jumpToSeq(ev.seq); } };
  const onMode = (m) => { prefs.diffMode = m; savePrefs(); };
  if (file.git) {
    const r = await api.get(`/api/sessions/${sid(id)}/turn-diff?turn=${encodeURIComponent(turn.prompt.id)}&file=${encodeURIComponent(file.repoPath)}`).catch((e) => ({ error: e.message }));
    if (state.detailsKey !== key) return;
    $('details-body').replaceChildren(r.error ? h('div', { class: 'pad muted' }, r.error) : renderTurnFileDiff({ turn, file, gitDiff: r.diff }, ctx0, prefs.diffMode || 'split', onMode));
    $('details-body').scrollTop = 0;
    return;
  }
  const edits = await Promise.all(file.edits.map(ev => api.get(`/api/sessions/${sid(id)}/events/${sid(ev.id)}`).then(detail => ({ ev, detail })).catch(() => ({ ev, detail: null }))));
  if (state.detailsKey !== key) return;
  const ctx = { ...detailCtx(), jump: (ev) => { setTab('events'); jumpToSeq(ev.seq); } };
  $('details-body').replaceChildren(renderTurnFileDiff({ turn, file, edits }, ctx, prefs.diffMode || 'split', (m) => { prefs.diffMode = m; savePrefs(); }));
  $('details-body').scrollTop = 0;
}
$('changes-collapse').onclick = () => {
  const all = ct.turns.every(t => ct.collapsed.has(t.n));
  ct.collapsed = all ? new Set() : new Set(ct.turns.map(t => t.n)); renderTurns(false);
};
$('changes-turns').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const rows = [...$('changes-turns').querySelectorAll('.ct-file, .ct-turn')];
  let i = rows.findIndex(r => r.classList.contains('sel') || r === document.activeElement);
  if (e.key === 'Enter') { rows[i]?.click(); e.preventDefault(); e.stopPropagation(); return; }
  i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  rows[i]?.focus(); if (rows[i]?.classList.contains('ct-file')) rows[i].click();
  e.preventDefault(); e.stopPropagation();
});
setInterval(() => { if (state.tab === 'changes' && state.selected && document.visibilityState === 'visible') loadChanges(); }, 10_000);

// ------------------------------------------------------------ shell tab
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function shellRunEl(run) {
  const el = h('div', { class: `run${run.running ? ' running' : ''}`, dataset: { run: run.id } });
  const head = h('div', { class: 'run-h' });
  head.append(h('span', { class: 'cmd', title: run.cmd }, `$ ${run.cmd}`));
  head.append(h('span', { class: 'cwd', title: run.cwd }, basename(run.cwd || '')));
  head.append(h('span', { class: 'chip status' }, run.running ? 'running' : ''));
  head.append(ib('i-reuse', 'Reuse this command', () => { $('sh-cmd').value = run.cmd; $('sh-cmd').focus(); }, { size: 13 }));
  head.append(h('button', { class: 'mini kill', type: 'button', onclick: () => api.post('/api/shell/kill', { runId: run.id }) }, 'Kill'));
  head.append(h('button', { class: 'ask-ico', type: 'button', 'aria-label': 'Ask about this run', title: 'Ask about this run', onclick: () => {
    const r = state.shell.runs.get(run.id) || run;
    const out = (r.output || []).map(o => o.chunk).join('').replace(ANSI, '');
    openAsk({ kind: 'text', label: `Shell run: ${oneLine(r.cmd, 60)}`, text: `$ ${r.cmd}\n(cwd ${r.cwd || '~'}, exit ${r.code ?? 'running'})\n${out}`, what: 'this shell run' }, { type: 'sel', sel: `.run[data-run="${run.id}"]` });
  } }, starIcon(11)));
  el.append(head);
  const pre = h('pre');
  for (const o of run.output || []) pre.append(h('span', { class: o.stream === 'stderr' ? 'se' : 'so' }, o.chunk.replace(ANSI, '')));
  el.append(pre);
  if (!run.running) shellFinish(el, run);
  return el;
}
function shellFinish(el, run) {
  el.classList.remove('running');
  const st = el.querySelector('.status');
  st.className = `chip status ${run.code === 0 ? 'exit0' : 'exitN'}`;
  st.textContent = `${run.signal ? run.signal : 'exit ' + run.code}${run.durationMs != null ? ' · ' + fmtMs(run.durationMs) : run.endedAt ? ' · ' + fmtMs(run.endedAt - run.startedAt) : ''}`;
  el.querySelector('.kill')?.remove();
}
function shellOutput({ runId, stream, chunk }) {
  const run = state.shell.runs.get(runId); if (!run) return;
  run.output.push({ stream, chunk });
  const el = document.querySelector(`.run[data-run="${runId}"] pre`);
  if (el) { const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; el.append(h('span', { class: stream === 'stderr' ? 'se' : 'so' }, chunk.replace(ANSI, ''))); if (atBottom) el.scrollTop = el.scrollHeight; }
}
function shellExit({ runId, code, signal, durationMs }) {
  const run = state.shell.runs.get(runId); if (!run) return;
  Object.assign(run, { running: false, code, signal, durationMs });
  const el = document.querySelector(`.run[data-run="${runId}"]`);
  if (el) shellFinish(el, run);
}
async function shellRun() {
  const cmd = $('sh-cmd').value.trim(); const cwd = $('sh-cwd').value.trim();
  if (!cmd) return;
  try {
    const r = await api.post('/api/shell/run', { cmd, cwd });
    const run = { id: r.runId, cmd, cwd, startedAt: r.startedAt, running: true, output: [] };
    state.shell.runs.set(run.id, run); state.shell.order.unshift(run.id);
    $('sh-runs').prepend(shellRunEl(run));
    state.shell.history = [cmd, ...state.shell.history.filter(c => c !== cmd)].slice(0, 100);
    try { localStorage.setItem('deck.shhist', JSON.stringify(state.shell.history)); } catch { /* private mode */ }
    state.shell.hi = -1; $('sh-cmd').value = '';
  } catch (e) { toast(`Run failed: ${e.message}`); }
}
$('sh-run').onclick = shellRun;
$('sh-cmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); shellRun(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.shell.hi = Math.min(state.shell.history.length - 1, state.shell.hi + 1); $('sh-cmd').value = state.shell.history[state.shell.hi] || ''; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); state.shell.hi = Math.max(-1, state.shell.hi - 1); $('sh-cmd').value = state.shell.hi < 0 ? '' : state.shell.history[state.shell.hi]; }
});
$('sh-cwd').addEventListener('input', (e) => { e.target.dataset.user = '1'; });
$('sh-cwd-session').onclick = () => { $('sh-cwd').value = state.byId.get(state.selected)?.cwd || ''; delete $('sh-cwd').dataset.user; };
async function loadShellHistory() {
  try {
    const { runs } = await api.get('/api/shell/history');
    for (const r of runs.slice().reverse()) { state.shell.runs.set(r.id, r); state.shell.order.unshift(r.id); $('sh-runs').prepend(shellRunEl(r)); }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------ layout
function initLayout() {
  const deck = $('deck');
  deck.classList.toggle('rail-min', !!prefs.railMin);
  $('rail-toggle').setAttribute('aria-expanded', String(!prefs.railMin));
  if (prefs.railMin) {
    $('rail-toggle').title = $('rail-toggle').ariaLabel = 'Expand the session list ([)';
    $('rail-toggle').querySelector('use').setAttribute('href', '#i-right');
  }
  if (prefs.left) deck.style.setProperty('--left', prefs.left + 'px');
  if (prefs.right) deck.style.setProperty('--right', prefs.right + 'px');
  document.querySelectorAll('.gutter').forEach(g => {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault(); g.classList.add('active');
      const side = g.dataset.gutter;
      const move = (ev) => {
        if (side === 'left') { const w = Math.max(200, Math.min(600, ev.clientX)); deck.style.setProperty('--left', w + 'px'); prefs.left = w; }
        else { const w = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX)); deck.style.setProperty('--right', w + 'px'); prefs.right = w; }
        renderRows();
      };
      const up = () => { g.classList.remove('active'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); savePrefs(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  });
  $('tree-filter').oninput = (e) => { state.treeFilter = e.target.value; renderTree(); };
  window.addEventListener('resize', () => renderRows());
}

// ------------------------------------------------------------ boot
initLayout();
setTab(prefs.tab || 'events');
showDetailsEmpty();
boot();
setInterval(() => { if (state.selected) renderHeader(); else renderOverview(); renderTree(); }, 5000);
