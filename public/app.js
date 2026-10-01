// public/app.js — state, SSE wiring, panes. No build step, no dependencies.
import { renderRow, renderDetails, renderFileDetails, renderDiffDetails, h, fmtTokens, fmtMs, fmtUsd, fmtTime, ago, relPath, basename,
  markdown, oneLine, tagFor, tagEl, rowHeight, svgUse, starIcon } from './events.js';

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
  snapshot: { active: [], recent: [], closed: [], hidden: [] },
  byId: new Map(),            // id -> summary (sessions and agents)
  selected: null,
  cache: new Map(),           // id -> { events, byId, lastSeq, meta, brief, summary, loaded }
  expanded: new Set(),        // agentIds expanded inline in the events list
  tab: 'events',
  follow: true,
  cursor: null,               // selected event id
  rows: [], offsets: [], total: 0,
  filter: '', kind: 'all', showThinking: prefs.showThinking !== false,
  treeFilter: '', ctr: null,
  subsOpen: new Set(), subsAll: new Set(),
  files: null, changes: null,
  shell: { runs: new Map(), order: [], history: (() => { try { return JSON.parse(localStorage.getItem('deck.shhist') || '[]'); } catch { return []; } })(), hi: -1 },
  detailsKey: null,
  briefs: new Map(),          // id -> generated brief (server publicBrief)
  narrator: { enabled: true },
  clientId: null,
  ask: null,                  // { spec, primary, extras, thread, sessionId, ring }
  deck: new Map(),            // id -> deck-launched session state (lib/agent.mjs publicState)
  pendingOpen: null,          // a session just launched, opened once the index lists it
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
const pill = (phase) => h('span', { class: `pill ${phase}` }, h('span', { class: 'pd' }), PHASE_LABEL[phase]);
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
  es.addEventListener('briefs.snapshot', (e) => { const all = JSON.parse(e.data); for (const [id, b] of Object.entries(all)) state.briefs.set(id, b); refreshBriefViews(); });
  es.addEventListener('brief.update', (e) => { const b = JSON.parse(e.data); if (b.narrator) state.narrator = { ...state.narrator, ...b.narrator }; state.briefs.set(b.id, b); refreshBriefViews(b.id); });
  es.addEventListener('event.batch', (e) => { const { sessionId, events } = JSON.parse(e.data); onEvents(sessionId, events); });
  es.addEventListener('event.update', (e) => { const { sessionId, event } = JSON.parse(e.data); onUpdate(sessionId, event); });
  es.addEventListener('session.update', (e) => onSession(JSON.parse(e.data)));
  es.addEventListener('deck.update', (e) => onDeck(JSON.parse(e.data)));
  es.addEventListener('shell.output', (e) => shellOutput(JSON.parse(e.data)));
  es.addEventListener('shell.exit', (e) => shellExit(JSON.parse(e.data)));
}
function setConn(on) {
  $('conn').classList.toggle('on', on);
  $('conn').querySelector('.clbl').textContent = on ? 'Live' : 'Offline';
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
  state.snapshot = { hidden: [], ...snap };
  state.byId.clear();
  for (const b of ['active', 'recent', 'closed', 'hidden']) for (const s of state.snapshot[b]) { state.byId.set(s.id, s); for (const a of s.subagents || []) state.byId.set(a.id, a); if (s.deck) state.deck.set(s.id, s.deck); }
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
    c.summary = summary; state.byId.set(id, summary); for (const a of summary.subagents || []) state.byId.set(a.id, a);
    if (summary.deck) state.deck.set(id, summary.deck);
    for (const b of ['active', 'recent', 'closed', 'hidden']) { const i = state.snapshot[b].findIndex(x => x.id === id); if (i >= 0) state.snapshot[b][i] = summary; }
    scheduleTree();
  }
  if (id === state.selected) { renderHeader(); renderQueue(); }
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

function sessRow(s) {
  const phase = phaseOf(s);
  const isAgent = s.kind === 'agent';
  const meta = isAgent ? [s.agentType, s.worktreeBranch].filter(Boolean).join(' · ')
    : s.bucket === 'active' && !state.snapshot.hidden.includes(s)
      ? [s.gitBranch, s.pr ? `PR #${s.pr.number}` : null, phase === 'turn' ? 'your turn' : null, s.subagents?.length ? `${s.subagents.length} subagent${s.subagents.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
      : [s.project, s.gitBranch, s.pr ? `PR #${s.pr.number}` : null].filter(Boolean).join(' · ');
  const btn = h('button', { type: 'button', class: `sess${isAgent ? ' agent' : ''}${s.id === state.selected ? ' selected' : ''}${phase === 'ended' && !isAgent ? ' dim' : ''}`, dataset: { id: s.id }, title: s.cwd || s.title },
    h('span', { class: `dot ${phase}` }),
    h('span', { class: 't' }, h('span', { class: 'tt' }, s.title || s.id), !isAgent || meta ? h('span', { class: 'sub' }, meta || ' ') : null),
    h('span', { class: 'r', title: new Date(s.mtime).toLocaleString() }, ago(Date.now() - (s.mtime || 0))));
  return h('li', {}, btn);
}

function subsBlock(s, alwaysOpen) {
  const subs = s.subagents || [];
  const done = subs.filter(a => a.status === 'done').length;
  const run = subs.filter(a => a.status === 'running').length;
  const containsSel = subs.some(a => a.id === state.selected);
  const open = state.subsOpen.has(s.id) ? true : state.subsOpen.has('!' + s.id) ? false : (alwaysOpen || containsSel || s.id === state.selected);
  const li = h('li', { class: `subs${open ? '' : ' collapsed'}`, dataset: { parent: s.id } });
  li.append(h('button', { type: 'button', class: 'subs-h', dataset: { subs: s.id }, 'aria-expanded': String(open) },
    svgUse('i-down', 10), h('span', {}, 'Subagents'), h('span', { class: 'muted' }, `${done} of ${subs.length} done${run ? ` · ${run} running` : ''}`)));
  const bar = h('div', { class: 'bar', 'aria-hidden': 'true' });
  if (done) bar.append(h('span', { class: 'b-done', style: `flex-grow:${done}` }));
  if (run) bar.append(h('span', { class: 'b-run', style: `flex-grow:${run}` }));
  if (subs.length - done - run) bar.append(h('span', { class: 'b-other', style: `flex-grow:${subs.length - done - run}` }));
  li.append(bar);
  const out = [li];
  if (open) {
    const order = [...subs].sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.mtime - a.mtime);
    const all = state.subsAll.has(s.id) || containsSel;
    const shown = all ? order : order.slice(0, 4);
    for (const a of shown) out.push(sessRow(a));
    if (order.length > 4 && !containsSel) out.push(h('li', {}, h('button', { type: 'button', class: 'more', dataset: { more: s.id } }, all ? 'Show fewer' : `+ ${order.length - 4} more`)));
  }
  return out;
}

function matchesTree(s) {
  if (state.ctr) {
    if (s.bucket !== 'active') return false;
    const p = phaseOf(s);
    if (state.ctr === 'errors' ? !recentErr(s) : p !== state.ctr) return false;
  }
  if (!state.treeFilter) return true;
  const q = state.treeFilter.toLowerCase();
  return [s.title, s.project, s.cwd, s.gitBranch, s.id].some(x => x && String(x).toLowerCase().includes(q))
    || (s.subagents || []).some(a => a.title?.toLowerCase().includes(q));
}

function renderTree() {
  const snap = state.snapshot;
  for (const b of ['active', 'recent', 'closed', 'hidden']) {
    const sec = document.querySelector(`.bucket[data-bucket=${b}]`);
    const ul = sec.querySelector('ul');
    const list = (snap[b] || []).filter(matchesTree);
    sec.querySelector('.count').textContent = list.length || '';
    sec.hidden = b === 'hidden' && !snap.hidden.length;
    const frag = document.createDocumentFragment();
    let lastRepo = null;
    const groups = b === 'active' ? groupByRepo(list) : [[null, list]];
    for (const [repo, items] of groups) {
      if (repo && repo !== lastRepo) { frag.append(h('li', { class: 'repo', title: repo }, svgUse('i-folder', 12), tilde(repo))); lastRepo = repo; }
      for (const s of items) {
        frag.append(sessRow(s));
        const subs = s.subagents || [];
        if (subs.length && (b === 'active' || s.id === state.selected || subs.some(a => a.id === state.selected))) frag.append(...subsBlock(s, false));
      }
    }
    ul.replaceChildren(frag);
  }
  const total = snap.active.length + snap.recent.length + snap.closed.length;
  $('tree-foot').textContent = `${total} sessions · ${snap.active.length} live${snap.hidden.length ? ` · ${snap.hidden.length} hidden` : ''}`;
  renderCounters();
}
function groupByRepo(list) {
  const m = new Map();
  for (const s of list) { const k = s.cwd || s.project || '?'; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  return [...m];
}
function renderCounters() {
  const act = state.snapshot.active;
  const n = { working: act.filter(s => phaseOf(s) === 'working').length, turn: act.filter(s => phaseOf(s) === 'turn').length, errors: act.filter(recentErr).length };
  for (const b of $('counters').querySelectorAll('.ctr')) {
    const k = b.dataset.c;
    b.querySelector('b').textContent = n[k];
    b.classList.toggle('lit', n[k] > 0);
    b.setAttribute('aria-pressed', String(state.ctr === k));
    b.disabled = !n[k] && state.ctr !== k;
  }
}

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
  if (t.dataset.id) select(t.dataset.id);
});
$('counters').addEventListener('click', (e) => {
  const b = e.target.closest('.ctr'); if (!b) return;
  state.ctr = state.ctr === b.dataset.c ? null : b.dataset.c;
  if (state.ctr) document.querySelector('.bucket[data-bucket=active]').classList.remove('collapsed');
  renderTree();
});

// ------------------------------------------------------------ overview
let ovTimer = null;
function scheduleOverview() { if (!state.selected && !ovTimer) ovTimer = requestAnimationFrame(() => { ovTimer = null; renderOverview(); }); }

function briefLine(id) {
  const pb = state.briefs.get(id);
  return pb?.brief?.summary || null;
}
function freshness(id, shownHere) {
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
  const live = s?.kind === 'session' ? !!s.alive : phase === 'working';
  const cad = shownHere
    ? (phase === 'working' ? 'refreshes every 20s while working' : phase === 'turn' ? 'refreshes on new activity' : 'final')
    : (phase === 'working' && live && s?.kind === 'session' ? 'every 2m in background' : 'paused · refreshes when opened');
  if (!pb?.brief) return { text: `No brief yet · ${cad}` };
  return { text: `Session to date · updated ${ago(Date.now() - pb.updatedAt)} ago · ${cad}${pb.error ? ' · last refresh failed' : ''}`, live: phase === 'working' };
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
  const working = act.filter(s => phaseOf(s) === 'working');
  const turn = act.filter(s => phaseOf(s) === 'turn');
  const errs = act.filter(recentErr);
  const runningSubs = act.reduce((n, s) => n + (s.running || 0), 0);
  const spent = act.reduce((n, s) => n + (s.glance?.cost || 0), 0);
  const repos = new Set(act.map(s => s.cwd)).size;
  const askBtn = (key, what) => h('button', { type: 'button', class: 'ask-mini', dataset: { askList: key }, title: `Ask about ${what}` }, starIcon(10), 'Ask');

  const head = h('header', { class: 'ov-h' },
    h('h1', {}, act.length ? `${working.length} agent${working.length === 1 ? '' : 's'} working, ${turn.length} waiting on you` : 'No agents running'),
    h('p', {}, act.length ? [`Live across ${repos} repo${repos === 1 ? '' : 's'}`, runningSubs ? `${runningSubs} subagent${runningSubs === 1 ? '' : 's'} running` : null, spent ? `${fmtUsd(spent)} spent in live sessions` : null].filter(Boolean).join(' · ')
      : 'Start one with New session, or run claude in a terminal or the desktop app and it shows up here.'));
  head.append(h('button', { type: 'button', class: 'btn primary ov-new', onclick: () => openLaunch() }, svgUse('i-plus', 12), 'New session'));
  const out = [head];

  if (turn.length || errs.length) {
    const sec = h('section', { class: 'ov-sec', dataset: { ov: 'needs' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Needs you'), askBtn('ov-needs', 'what needs you')));
    for (const s of turn) {
      sec.append(h('button', { type: 'button', class: 'need turn', dataset: { open: s.id } },
        pill('turn'),
        h('span', { class: 'nt' }, h('b', {}, s.title, h('span', {}, ` · ${s.project}${s.gitBranch ? ' · ' + s.gitBranch : ''}`)), h('span', { class: 'nl' }, permLine(s.id) || briefLine(s.id) || s.glance?.lastText || '')),
        h('span', { class: 'age' }, permLine(s.id) ? 'permission' : s.glance?.idleMs != null ? `idle ${ago(s.glance.idleMs)}` : ''),
        h('span', { class: 'go' }, 'Open')));
    }
    for (const s of errs) {
      if (turn.includes(s)) continue;
      sec.append(h('button', { type: 'button', class: 'need err', dataset: { open: s.id, errors: '1' } },
        h('span', { class: 'pill err' }, `${s.glance.errors} error${s.glance.errors === 1 ? '' : 's'}`),
        h('span', { class: 'nt' }, h('b', {}, s.title, h('span', {}, ` · ${s.project}${s.pr ? ' · PR #' + s.pr.number : ''}`)), h('span', { class: 'nl' }, briefLine(s.id) || s.glance?.lastText || '')),
        h('span', { class: 'age' }, `latest ${ago(Date.now() - Date.parse(s.glance.lastErrorTs))} ago`),
        h('span', { class: 'go' }, 'Review')));
    }
    out.push(sec);
  }

  if (working.length) {
    const cards = h('div', { class: 'cards' });
    for (const s of working) {
      const nt = nowText(s);
      const f = freshness(s.id, false);
      const g = s.glance || {};
      cards.append(h('button', { type: 'button', class: 'card', dataset: { open: s.id } },
        h('span', { class: 'ch' }, h('span', { class: 'dot working' }), h('b', {}, s.title), h('span', { class: 'muted' }, ago(Date.now() - s.mtime))),
        h('span', { class: 'cw' }, [tilde(s.cwd), s.gitBranch, s.pr ? `PR #${s.pr.number}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'nowbox' }, nt.tag ? h('span', { class: `tag f-${tagFor({ kind: 'tool', tool: { name: nt.tag, isError: false, display: nt.tag } }).fam}` }, nt.tag) : null, h('span', { class: 'nb' }, nt.text)),
        h('span', { class: 'fresh' }, h('span', { class: `fdot2${f.live ? ' live' : ''}` }), `Brief · ${f.text.replace(/^Session to date · /, '')}`),
        h('span', { class: 'cs' }, briefLine(s.id) || g.lastText || ''),
        h('span', { class: 'cf' }, h('span', {}, g.turnMs != null ? `turn ${fmtMs(g.turnMs)}` : ''), h('span', {}, s.subagents?.length ? `${s.subagents.filter(a => a.status === 'done').length} / ${s.subagents.length} subagents` : 'no subagents'), h('span', {}, g.cost != null ? fmtUsd(g.cost) : ''))));
    }
    out.push(h('section', { class: 'ov-sec', dataset: { ov: 'working' } }, h('div', { class: 'ov-sec-h' }, h('h2', {}, 'Working'), askBtn('ov-working', 'the working sessions')), cards));
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
  if (b.dataset.open) { const errs = !!b.dataset.errors; select(b.dataset.open).then(() => { if (errs) setKind('errors'); }); }
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
  if (changed) { state.cursor = null; setFollow(true, true); }
  prefs.selected = id; savePrefs();
  $('overview').hidden = true; $('session-view').hidden = false;
  renderTree();
  reportView();
  renderHeader();
  if (changed) { $('vrows').replaceChildren(); showDetailsEmpty(); renderPerms(); }
  try { await loadSession(id); }
  catch (e) { toast(`Load failed: ${e.message}`); return; }
  if (state.selected !== id) return;
  renderHeader(); renderQueue(); renderPerms(); scheduleRows(true);
  if (changed && deckOf(id)?.alive) showPromptPanel(true);
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
  if (!s) { el.replaceChildren(h('div', { class: 'muted' }, 'Loading…')); return; }
  const b = c?.brief; const phase = phaseOf(s);
  const isAgent = s.kind === 'agent';

  const win = h('div', { class: 'sh-win' });
  win.append(h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': isAgent ? 'Back to parent session' : 'Close session (hide it from the deck)', title: isAgent ? 'Back to parent session' : 'Close (hide from the deck)', onclick: closeSession }, svgUse('i-x', 14)));
  if (!isAgent) win.append(h('button', { type: 'button', class: 'icon-btn ghost danger', 'aria-label': 'Delete session', title: s.alive ? 'Running sessions cannot be deleted' : 'Delete session…', disabled: s.alive || null, onclick: deleteSession }, svgUse('i-trash', 14)));
  const top = h('div', { class: 'sh-top' }, win, h('h1', { title: s.title }, s.title || id), pill(phase));
  if (isAgent) {
    const parent = state.byId.get(s.parentId);
    top.append(h('button', { type: 'button', class: 'sh-parent', onclick: () => select(s.parentId) }, `subagent of ${parent?.title || s.parentId}`));
  }
  const d = isAgent ? null : deckOf(id);
  if (d?.alive) top.append(h('span', { class: 'pill outline deck', title: `Launched by the deck · pid ${d.pid} · permissions: ${d.permissionMode}` }, 'Deck', h('span', { class: 'muted' }, ` · ${PERM_LABEL[d.permissionMode] || d.permissionMode}`)));
  else if (!isAgent && s.alive) top.append(h('span', { class: 'pill outline', title: 'Launched outside the deck. The deck can read it but not drive it.' }, 'Observe only'));
  top.append(h('span', { class: 'spacer' }));
  if (d?.alive) {
    top.append(h('button', { type: 'button', class: 'btn', disabled: d.status === 'idle' || d.interrupting || null, title: 'Stop the current turn and hold the queue', onclick: interruptSession }, svgUse('i-stop', 11), d.interrupting ? 'Interrupting…' : 'Interrupt'));
    top.append(h('button', { type: 'button', class: 'btn', title: 'End the claude process. You can resume the session later.', onclick: stopSession }, 'End'));
  } else if (!isAgent && !s.alive) {
    top.append(h('button', { type: 'button', class: 'btn', title: 'Continue this session under the deck', onclick: () => openLaunch({ resumeId: id }) }, svgUse('i-send', 12), 'Resume in deck'));
  }
  if (s.cwd) top.append(h('button', { type: 'button', class: 'btn', onclick: () => api.openEditor(s.cwd) }, svgUse('i-code', 14), 'Open in editor'));
  if (!isAgent) top.append(h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Copy resume command', title: 'Copy resume command', onclick: () => { navigator.clipboard?.writeText(`cd ${JSON.stringify(s.cwd || '.')} && claude --resume ${id}`); toast('Copied resume command'); } }, svgUse('i-copy', 14)));

  const out = [top, renderNow(s, b, phase), renderBriefBox(id, s, b)];

  const meta = h('div', { class: 'metaline' });
  if (s.cwd) meta.append(h('span', { class: 'mono', title: s.cwd }, tilde(s.cwd)));
  if (b?.branch || s.gitBranch) meta.append(h('span', {}, b?.branch || s.gitBranch));
  if (b?.pr) meta.append(h('a', { href: b.pr.url, target: '_blank', rel: 'noopener' }, `PR #${b.pr.number}`));
  if (b?.model) meta.append(h('span', {}, [b.model.replace('claude-', ''), b.effort].filter(Boolean).join(' · ')));
  if (b?.turnUsage?.messages) meta.append(h('span', { title: `cache read ${fmtTokens(b.turnUsage.cacheRead)} · cache write ${fmtTokens(b.turnUsage.cacheCreate)} · thinking ${fmtTokens(b.turnUsage.thinking)}` }, `turn ${fmtTokens(b.turnUsage.input + b.turnUsage.cacheRead + b.turnUsage.cacheCreate)} in / ${fmtTokens(b.turnUsage.output)} out`));
  if (b?.usage?.messages) meta.append(h('span', { title: `${b.usage.messages} messages · ${b.turns} turns` }, `session ${fmtTokens(b.usage.output)} out`));
  if (b?.cost?.totalCostUSD != null) meta.append(h('span', { title: `+${b.cost.linesAdded} −${b.cost.linesRemoved} lines · ${b.cost.models.join(', ')}` }, fmtUsd(b.cost.totalCostUSD)));
  if (b?.subagents?.total) meta.append(h('span', {}, `${b.subagents.running} / ${b.subagents.total} subagents running`));
  if (b?.errors) meta.append(h('button', { type: 'button', onclick: () => setKind('errors') }, `${b.errors} error${b.errors === 1 ? '' : 's'}`));
  out.push(meta);
  el.replaceChildren(...out);
  applyRing();
}

function renderNow(s, b, phase) {
  const box = h('div', { class: `nowline ${phase}` });
  if (b?.activeTool) {
    const t = b.activeTool;
    box.append(h('span', { class: 'nl-k' }, 'NOW'), h('span', { class: `tag f-${tagFor({ kind: 'tool', tool: { name: t.name, isError: false } }).fam}` }, t.name),
      h('span', { class: 'nl-t', title: t.summary }, t.summary || t.name),
      h('span', { class: 'nl-e', dataset: { started: String(Date.now() - (t.startedMs || 0)) } }, fmtClock(t.startedMs || 0)));
  } else if (phase === 'turn' && permLine(s.id)) {
    box.append(h('span', { class: 'nl-k' }, 'NEEDS PERMISSION'), h('span', { class: 'nl-t' }, permLine(s.id)), h('span', { class: 'nl-e' }, 'answer below'));
  } else if (phase === 'turn') {
    box.append(h('span', { class: 'nl-k' }, 'YOUR TURN'), h('span', { class: 'nl-t' }, b?.lastPrompt ? `Finished: ${b.lastPrompt}` : 'Waiting for your next prompt'), h('span', { class: 'nl-e' }, b?.idleMs != null ? `idle ${ago(b.idleMs)}` : ''));
  } else if (phase === 'working') {
    box.append(h('span', { class: 'nl-k' }, 'NOW'), h('span', { class: 'nl-t' }, [b?.state, b?.detail].filter(Boolean).join(' · ') || 'working'));
  } else if (deckOf(s.id)?.exit && phase === 'ended') {
    const x = deckOf(s.id).exit;
    const bad = x.code !== 0 && x.code !== null || (x.signal && x.signal !== 'SIGTERM');
    box.classList.toggle('err', !!bad);
    box.append(h('span', { class: 'nl-k' }, 'ENDED'), h('span', { class: 'nl-t', title: x.stderr || '' }, bad ? `claude exited ${x.signal || `with code ${x.code}`}${x.stderr ? ': ' + x.stderr.split('\n').at(-1) : ''}` : 'Ended from the deck'), h('span', { class: 'nl-e' }, `${ago(Date.now() - x.at)} ago`));
  } else {
    box.append(h('span', { class: 'nl-k' }, phase === 'done' ? 'DONE' : 'ENDED'), h('span', { class: 'nl-t' }, b?.lastEventTs ? `last activity ${ago(Date.now() - Date.parse(b.lastEventTs))} ago` : 'no activity recorded'));
  }
  return box;
}
function fmtClock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
setInterval(() => { for (const e of document.querySelectorAll('.nl-e[data-started]')) e.textContent = fmtClock(Date.now() - Number(e.dataset.started)); }, 1000);

function renderBriefBox(id, s, b) {
  const pb = state.briefs.get(id);
  const nb = pb?.brief;
  const f = freshness(id, true);
  const box = h('section', { id: 'brief-box', class: `brief${prefs.briefCollapsed ? ' collapsed' : ''}`, 'aria-labelledby': 'brief-h' });
  const head = h('div', { class: 'brief-h' }, h('h2', { id: 'brief-h' }, 'Brief'),
    h('span', { class: `fr${f.err ? ' err' : ''}`, title: f.text }, f.spin ? h('span', { class: 'spin' }) : null, f.text),
    h('span', { class: 'spacer' }));
  if (nb) head.append(h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': prefs.briefCollapsed ? 'Expand brief' : 'Collapse brief', title: prefs.briefCollapsed ? 'Expand' : 'Collapse', onclick: () => { prefs.briefCollapsed = !prefs.briefCollapsed; savePrefs(); renderHeader(); } }, svgUse(prefs.briefCollapsed ? 'i-down' : 'i-up', 12)));
  if (state.narrator.enabled) head.append(h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Refresh brief now', title: 'Refresh now', disabled: pb?.pending || null, onclick: refreshBrief }, svgUse('i-refresh', 13)));
  head.append(h('button', { type: 'button', class: 'ask-btn', onclick: () => openAsk({ kind: 'brief', sessionId: id, label: 'Session brief', what: 'this session' }, { type: 'brief' }) }, starIcon(12), 'Ask about this'));
  box.append(head);

  if (nb?.summary) box.append(h('p', { class: 'sum' }, nb.summary));
  else box.append(h('p', { class: 'sum fallback' }, b?.lastText ? [h('span', { class: 'lbl2' }, 'Last said · '), b.lastText] : 'No assistant message yet.'));

  if (nb?.progress) {
    const p = nb.progress;
    const legend = h('div', { class: 'prog-l' }, h('b', {}, `${p.total} ${p.unit}`));
    const bar = h('div', { class: 'prog-b', role: 'img', 'aria-label': p.segments.map(x => `${x.count} ${x.label}`).join(', ') });
    for (const sg of p.segments) {
      legend.append(h('span', {}, h('i', { class: `tone-${sg.tone}` }), `${sg.count} ${sg.label}`));
      bar.append(h('span', { class: `tone-${sg.tone}`, style: `flex-grow:${sg.count}` }));
    }
    box.append(h('div', { class: 'prog' }, legend, bar));
  }
  if (nb && (nb.done.length || nb.now || nb.next)) {
    box.append(h('div', { class: 'dnn' },
      h('div', {}, h('h3', {}, 'Done so far'), nb.done.length ? h('ul', {}, ...nb.done.map(x => h('li', {}, x))) : h('p', { class: 'muted' }, '—')),
      h('div', { class: 'now' }, h('h3', {}, 'Now'), h('p', {}, nb.now || '—')),
      h('div', {}, h('h3', {}, 'Next'), h('p', {}, nb.next || '—'))));
  }
  if (nb?.watch) {
    const w = h('div', { class: 'watch' }, h('span', { class: 'wk' }, 'WATCH'), h('span', { class: 'wt' }, nb.watch.text));
    if (nb.watch.seq) w.append(h('button', { type: 'button', onclick: () => jumpToSeq(nb.watch.seq) }, 'Jump to event'));
    box.append(w);
  }
  return box;
}
async function refreshBrief() {
  try { await api.post(`/api/sessions/${sid(state.selected)}/brief/refresh`); }
  catch (e) { toast(`Refresh failed: ${e.message}`); }
}
function refreshBriefViews(id) {
  if (state.selected && (!id || id === state.selected)) renderHeader();
  if (!state.selected) scheduleOverview();
}

// ------------------------------------------------------------ close / delete
async function closeSession() {
  const s = state.byId.get(state.selected); if (!s) return;
  if (s.kind === 'agent') { select(s.parentId); return; }
  const id = s.id;
  try {
    await api.post(`/api/sessions/${sid(id)}/hide`, { hidden: true });
    goOverview();
    toast(`Hid “${oneLine(s.title, 40)}” from the deck`, { label: 'Undo', fn: () => api.post(`/api/sessions/${sid(id)}/hide`, { hidden: false }).then(() => select(id)) });
  } catch (e) { toast(`Close failed: ${e.message}`); }
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
  const compose = $('compose'), sendBtn = $('send'), intBtn = $('interrupt');
  if (d?.alive) {
    const q = d.queue;
    const idle = d.status === 'idle';
    $('queue-count').textContent = q.length ? `· ${q.length}` : '· empty';
    $('prompt-note').textContent = d.held ? 'held after interrupt' : q.length ? 'sends when the current turn ends' : idle ? 'idle · a prompt goes out at once' : 'prompts wait for the current turn';
    const rows = q.map((item, i) => h('li', {}, h('span', { class: 'muted' }, `${i + 1}.`), h('span', { class: 'q', title: item.text }, item.text.replace(/\s+/g, ' ')),
      h('button', { class: 'mini', type: 'button', title: 'Send this next', disabled: i === 0 && !d.held || null, onclick: () => queueOp('top', item.id) }, 'Next'),
      h('button', { class: 'mini', type: 'button', 'aria-label': 'Move up', disabled: i === 0 || null, onclick: () => queueOp('up', item.id) }, svgUse('i-up', 10)),
      h('button', { class: 'mini', type: 'button', 'aria-label': 'Move down', disabled: i === q.length - 1 || null, onclick: () => queueOp('down', item.id) }, svgUse('i-down', 10)),
      h('button', { class: 'mini', type: 'button', title: 'Remove from the queue', onclick: () => queueOp('remove', item.id) }, 'Remove')));
    if (d.held && q.length) rows.unshift(h('li', { class: 'held' }, h('span', { class: 'q' }, 'Queue held after interrupt. Nothing goes out until you resume or send.'), h('button', { class: 'mini', type: 'button', onclick: () => queueOp('resume') }, 'Resume queue')));
    $('queue').replaceChildren(...rows);
    compose.disabled = false;
    compose.placeholder = idle && !q.length ? 'Prompt (⌘↩ to send)' : 'Queue a prompt (⌘↩)';
    sendBtn.disabled = false; sendBtn.textContent = idle && !q.length ? 'Send' : 'Queue';
    sendBtn.title = idle && !q.length ? 'Send now (⌘↩)' : 'Add to the queue; it goes out when the current turn ends (⌘↩)';
    intBtn.hidden = false; intBtn.disabled = idle || d.interrupting;
    return;
  }
  const q = c?.meta?.queue || [];
  $('queue-count').textContent = q.length ? `· ${q.length}` : '· empty';
  $('prompt-note').textContent = q.length ? 'read-only mirror of the session queue' : 'nothing queued';
  $('queue').replaceChildren(...q.map((item, i) => h('li', {}, h('span', { class: 'muted' }, `${i + 1}.`), h('span', { class: 'q', title: item.content }, item.content.replace(/\s+/g, ' ')),
    h('button', { class: 'mini', type: 'button', onclick: () => navigator.clipboard?.writeText(item.content) }, 'Copy'))));
  compose.disabled = true; sendBtn.disabled = true; sendBtn.textContent = 'Send'; intBtn.hidden = true;
  compose.placeholder = s?.alive ? 'Launched outside the deck, so it is observe-only here.' : 'This session has ended. Resume it in the deck to send prompts.';
  sendBtn.title = s?.alive ? 'This session was launched outside the deck; the deck can only observe it.' : 'Resume the session in the deck first';
}
function showPromptPanel(open) { const p = $('prompt'); p.hidden = !open; $('prompt-toggle').setAttribute('aria-expanded', String(open)); }
$('prompt-toggle').onclick = () => showPromptPanel($('prompt').hidden);
$('copy-last').onclick = () => { const p = state.cache.get(state.selected)?.meta?.lastPrompt; if (p) { navigator.clipboard?.writeText(p); toast('Copied last prompt'); } };

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

async function sendPrompt() {
  const text = $('compose').value;
  if (!text.trim() || $('compose').disabled) return;
  const id = state.selected;
  $('send').disabled = true;
  try { await api.post(`/api/sessions/${sid(id)}/send`, { text }); $('compose').value = ''; setFollow(true, true); }
  catch (e) { toast(`Send failed: ${e.message}`); }
  finally { if (id === state.selected) renderQueue(); }
}
$('send').onclick = sendPrompt;
$('compose').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendPrompt(); } });
$('interrupt').onclick = interruptSession;

async function queueOp(op, itemId) {
  try { await api.post(`/api/sessions/${sid(state.selected)}/queue`, { op, itemId }); }
  catch (e) { toast(`Queue: ${e.message}`); }
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
    const ok = await confirmDialog('End this session?', `${busy ? 'Claude is in the middle of a turn, which will be cut off. ' : ''}${d.queue.length ? `${d.queue.length} queued prompt${d.queue.length === 1 ? '' : 's'} will be dropped. ` : ''}You can resume the session later.`, 'End session');
    if (!ok) return;
  }
  try { await api.post(`/api/sessions/${sid(s.id)}/stop`); toast('Session ended'); }
  catch (e) { toast(`End failed: ${e.message}`); }
}

// The launch dialog: a new session, or an ended one resumed under the deck.
let launchCtx = null;
function openLaunch({ resumeId } = {}) {
  const dlg = $('new-session');
  if (dlg.open) return;
  const resume = resumeId ? state.byId.get(resumeId) : null;
  launchCtx = { resumeId: resume ? resumeId : null };
  const cwds = [...new Set([...state.snapshot.active, ...state.snapshot.recent].map(s => s.cwd).filter(Boolean))].slice(0, 20);
  $('ns-cwds').replaceChildren(...cwds.map(c => h('option', { value: c })));
  $('ns-t').textContent = resume ? 'Resume in the deck' : 'New session';
  $('ns-sub').textContent = resume ? `Continues “${oneLine(resume.title, 60)}” under the deck. Your prompt is the next turn.` : 'Runs claude under the deck, so you can send, queue, interrupt and answer permission prompts from here.';
  $('ns-cwd').value = resume ? resume.cwd : prefs.launchCwd || state.byId.get(state.selected)?.cwd || cwds[0] || '';
  $('ns-cwd').readOnly = !!resume;
  $('ns-name-w').hidden = !!resume;
  $('ns-name').value = '';
  $('ns-model').value = prefs.launchModel || '';
  $('ns-perm').value = prefs.launchPerm || 'default';
  $('ns-err').hidden = true;
  $('ns-go').disabled = false;
  $('ns-go').textContent = resume ? 'Resume' : 'Start session';
  dlg.showModal();
  ($('ns-cwd').value ? $('ns-prompt') : $('ns-cwd')).focus();
}
$('new-btn').onclick = () => openLaunch();
$('ns-cancel').onclick = () => $('new-session').close();
$('ns-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('ns-form').requestSubmit(); } });
$('ns-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { cwd: $('ns-cwd').value.trim(), prompt: $('ns-prompt').value, model: $('ns-model').value, permissionMode: $('ns-perm').value, name: $('ns-name').value.trim() };
  if (!body.prompt.trim()) { $('ns-prompt').focus(); return; }
  $('ns-go').disabled = true; $('ns-err').hidden = true;
  $('ns-go').textContent = 'Starting…';
  try {
    const st = launchCtx?.resumeId
      ? await api.post(`/api/sessions/${sid(launchCtx.resumeId)}/resume`, body)
      : await api.post('/api/launch', body);
    if (!launchCtx?.resumeId) prefs.launchCwd = body.cwd;
    prefs.launchModel = body.model; prefs.launchPerm = body.permissionMode; savePrefs();
    state.deck.set(st.id, st);
    $('ns-prompt').value = '';
    $('new-session').close();
    if (state.byId.has(st.id) && state.selected === st.id) { renderHeader(); renderQueue(); showPromptPanel(true); }
    else if (state.byId.has(st.id)) openLaunched(st.id);
    else { state.pendingOpen = st.id; toast('Session started. Opening it as soon as it writes its transcript…'); }
  } catch (err) {
    $('ns-err').textContent = err.message === 'not found'
      ? 'The deck backend is older than this page and cannot launch sessions. Restart it (stop the server and run npm start, or quit and relaunch the app), then try again.'
      : err.message;
    $('ns-err').hidden = false;
    $('ns-go').disabled = false; $('ns-go').textContent = launchCtx?.resumeId ? 'Resume' : 'Start session';
  }
});
function openLaunched(id) {
  state.pendingOpen = null;
  select(id).then(() => showPromptPanel(true));
}

// ------------------------------------------------------------ events list
let rowsTimer = null;
function scheduleRows(jump = false) {
  if (rowsTimer) { if (jump) rowsTimer.jump = true; return; }
  const t = { jump };
  rowsTimer = t;
  requestAnimationFrame(() => { rowsTimer = null; buildRows(); renderRows(t.jump); });
}
const isErr = (ev) => (ev.kind === 'tool' && ev.tool.isError) || !!ev.error;
function evMatches(ev, q) {
  if (!q) return true;
  const hay = ev.kind === 'tool' ? `${ev.tool.display} ${ev.tool.summary} ${JSON.stringify(ev.tool.input).slice(0, 2000)}` : `${ev.kind} ${ev.text || ''} ${ev.subtype || ''}`;
  return hay.toLowerCase().includes(q);
}
function keepKind(ev) {
  if (!state.showThinking && ev.kind === 'thinking') return false;
  switch (state.kind) {
    case 'tools': return ev.kind === 'tool' || ev.kind === 'prompt';
    case 'messages': return ev.kind === 'text' || ev.kind === 'prompt';
    case 'errors': return isErr(ev);
    default: return true;
  }
}
/** Turn numbering and per-turn totals, chronological. */
function turnInfo(events, live) {
  const info = new Map(); let n = 0; let cur = null;
  for (const ev of events) {
    if (ev.kind === 'prompt') { n++; cur = { n, start: ev.ts, count: 0, prompt: ev }; info.set(ev.id, cur); }
    else if (ev.kind === 'turn_end') {
      if (cur) {
        const dur = cur.start && ev.ts ? Date.parse(ev.ts) - Date.parse(cur.start) : null;
        cur.done = { count: cur.count, dur };
        info.set(ev.id, { text: `Turn ${cur.n} ended · ${cur.count} events${dur != null ? ' · ' + fmtMs(dur) : ''}${ev.text ? ' · ' + ev.text : ''}` });
        cur = null;
      }
    } else if (cur && ev.kind !== 'thinking') cur.count++;
  }
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
  const push = (ev, depth, turn = null) => {
    if (ev.kind === 'turn_end' && state.kind !== 'all' && state.kind !== 'tools') return;
    if (ev.kind !== 'prompt' && ev.kind !== 'turn_end' && !keepKind(ev)) return;
    if (ev.kind === 'prompt' && state.kind === 'errors') return;
    if (!evMatches(ev, q)) return;
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
  const errs = c.events.reduce((n, ev) => n + (isErr(ev) ? 1 : 0), 0);
  $('err-count').textContent = errs || '';
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
  if (jump || state.follow) vlist.scrollTop = 0; // newest rows live at the top
  if (!n) {
    vrows.replaceChildren(h('div', { class: 'pad muted' }, state.cache.get(state.selected)?.loaded ? (state.filter || state.kind !== 'all' ? 'No events match.' : 'No events yet.') : 'Loading…'));
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
  if (!atTop && state.follow) setFollow(false, true);
  else if (atTop && !state.follow) setFollow(true, true);
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
  if (!row || row.classList.contains('k-turn_end')) return;
  const ev = findEvent(row.dataset.sid, row.dataset.id);
  if (!ev) return;
  setCursor(ev.id); showEventDetails(ev);
  if (btn?.dataset.askRow) askEvent(ev);
});
function findEvent(sessionId, id) { return state.cache.get(sessionId)?.byId.get(id) || null; }
function setCursor(id) { state.cursor = id; renderRows(); }
function setFollow(on, quiet = false) {
  state.follow = on; $('follow').setAttribute('aria-pressed', String(on));
  if (on && !quiet) { vlist.scrollTop = 0; renderRows(); }
}
function setKind(k) {
  state.kind = k;
  for (const b of $('kind-seg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.k === k));
  setTab('events');
  scheduleRows(true);
}
$('follow').onclick = () => setFollow(!state.follow);
$('ev-filter').oninput = (e) => { state.filter = e.target.value; scheduleRows(); };
$('kind-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) setKind(b.dataset.k); };
$('show-thinking').setAttribute('aria-pressed', String(state.showThinking));
$('show-thinking').onclick = () => { state.showThinking = !state.showThinking; prefs.showThinking = state.showThinking; savePrefs(); $('show-thinking').setAttribute('aria-pressed', String(state.showThinking)); scheduleRows(); };

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
  setFollow(false, true);
  state.cursor = ev.id;
  scrollToRow(i);
  renderRows();
  showEventDetails(ev);
}
function jumpToSeq(seq) {
  const c = state.cache.get(state.selected); if (!c) return;
  const ev = c.events.find(e => e.seq === seq); if (!ev) { toast('That event is not loaded'); return; }
  if (state.kind !== 'all' || state.filter) { state.filter = ''; $('ev-filter').value = ''; setKind('all'); buildRows(); }
  setTab('events');
  const i = state.rows.findIndex(r => r.ev.id === ev.id);
  setFollow(false, true); state.cursor = ev.id;
  if (i >= 0) scrollToRow(i);
  renderRows(); showEventDetails(ev);
}

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { if (state.ask) closeAsk(); else if (state.selected) goOverview(); return; }
  if (e.key === 'n') { e.preventDefault(); openLaunch(); return; }
  if (!state.selected) { if (e.key === '/') { e.preventDefault(); $('tree-filter').focus(); } else if (e.key === '?') $('keys').showModal(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter') { const ev = state.cursor && findEvent(state.selected, state.cursor); if (ev) showEventDetails(ev); }
  else if (e.key === ' ') { e.preventDefault(); setFollow(!state.follow); }
  else if (e.key === '/') { e.preventDefault(); $('ev-filter').focus(); }
  else if (e.key === 'a') { e.preventDefault(); const ev = state.cursor && findEvent(state.selected, state.cursor); ev ? askEvent(ev) : openAsk({ kind: 'brief', sessionId: state.selected, label: 'Session brief', what: 'this session' }, { type: 'brief' }); }
  else if (e.key === '?') $('keys').showModal();
  else if (['1', '2', '3', '4'].includes(e.key)) setTab(['events', 'files', 'changes', 'shell'][+e.key - 1]);
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
  };
};
function showDetailsEmpty() {
  state.detailsKey = null;
  $('details-body').replaceChildren(h('div', { class: 'd-empty' },
    h('div', {}, state.selected ? 'Select an event, a file or a change to see it here.' : 'Pick a session on the left, or open one from the overview.'),
    h('dl', {}, h('dt', {}, h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k')), h('dd', {}, 'move between events'),
      h('dt', {}, h('kbd', {}, 'a')), h('dd', {}, 'ask about the selected event'),
      h('dt', {}, h('kbd', {}, 'Space')), h('dd', {}, 'follow newest'),
      h('dt', {}, h('kbd', {}, 'Esc')), h('dd', {}, 'back to the overview'))));
}
async function showEventDetails(ev, refreshOnly = false) {
  const key = `${ev.sessionId}:${ev.id}`;
  const body = $('details-body');
  const needsFull = ev.kind === 'tool' && (ev.tool.result?.truncated || ev.tool.result?.images?.length || !ev.tool.pending);
  if (!refreshOnly || state.detailsKey !== key) { state.detailsKey = key; body.replaceChildren(renderDetails(ev, needsFull ? null : undefined, detailCtx(ev))); body.scrollTop = 0; applyRing(); }
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
function closeAsk() { state.ask = null; $('ask').hidden = true; applyRing(); }
function renderAsk() {
  const a = state.ask; const el = $('ask');
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  const chips = h('div', { class: 'ask-chips' }, h('span', { class: 'ask-chip primary', title: 'always included' }, a.primary.label || 'This item'));
  a.extras.forEach((x) => chips.append(h('button', { type: 'button', class: 'ask-chip', 'aria-pressed': String(x.on), onclick: () => { x.on = !x.on; renderAsk(); } }, `${x.on ? '✓' : '+'} ${x.label}`)));
  const thread = h('div', { class: 'ask-thread' });
  for (const m of a.thread) {
    thread.append(h('div', { class: 'qa-q' }, m.q));
    if (m.pending) thread.append(h('div', { class: 'qa-a' }, h('span', { class: 'spin' })));
    else if (m.err) thread.append(h('div', { class: 'qa-a err' }, m.err));
    else thread.append(h('div', { class: 'qa-a' }, h('div', { class: 'md', html: markdown(m.a) }), h('div', { class: 'qa-meta' }, [fmtMs(m.ms), m.cost ? fmtUsd(m.cost) : null].filter(Boolean).join(' · '))));
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
  const sessLines = (list) => list.map(s => `- ${s.title} | ${tilde(s.cwd)} | ${PHASE_LABEL[phaseOf(s)]}${s.gitBranch ? ' | ' + s.gitBranch : ''}${s.glance?.errors ? ` | ${s.glance.errors} errors` : ''} | last said: ${oneLine(s.glance?.lastText || '', 160)}${briefLine(s.id) ? ' | brief: ' + oneLine(briefLine(s.id), 300) : ''}`).join('\n');
  let spec, ring;
  switch (key) {
    case 'events': {
      const lines = state.rows.slice(0, 400).map(({ ev }) => `${fmtTime(ev.ts)} ${tagFor(ev).label} ${ev.kind === 'tool' ? ev.tool.summary + (ev.tool.isError ? ' [error]' : '') : oneLine(ev.text || '', 200)}`);
      spec = { kind: 'text', label: `Events (${state.kind}${state.filter ? `, filter "${state.filter}"` : ''})`, text: lines.join('\n'), what: 'these events' }; ring = { type: 'sel', sel: '#vlist' }; break;
    }
    case 'files': {
      const cwd = state.byId.get(state.selected)?.cwd;
      spec = { kind: 'text', label: 'Files touched', text: (state.files || []).map(f => `${relPath(f.path, cwd)} reads=${f.reads} writes=${f.writes} last=${f.lastTs || ''}`).join('\n'), what: 'these files' }; ring = { type: 'sel', sel: '#files' }; break;
    }
    case 'changes': {
      const c = state.changes;
      spec = { kind: 'text', label: 'Git changes', text: c?.repo ? `branch ${c.branch} ahead ${c.ahead ?? '?'} behind ${c.behind ?? '?'}\n${c.files.map(f => `${f.untracked ? '??' : (f.x + f.y).trim()} ${f.path} +${f.added ?? 0} -${f.deleted ?? 0}`).join('\n')}\nrecent commits:\n${c.commits.map(k => `${k.short} ${k.subject}`).join('\n')}` : 'not a git repository', what: 'these changes' };
      ring = { type: 'sel', sel: '#changes' }; break;
    }
    case 'queue': spec = { kind: 'text', label: 'Prompt queue', text: (state.cache.get(state.selected)?.meta?.queue || []).map((x, i) => `${i + 1}. ${x.content}`).join('\n') || '(empty)', what: 'the prompt queue' }; ring = { type: 'sel', sel: '#queue' }; break;
    case 'active': case 'recent': spec = { kind: 'text', label: `${key === 'active' ? 'Active' : 'Recent'} sessions`, text: sessLines(state.snapshot[key]), what: `${key} sessions` }; ring = { type: 'sel', sel: `.bucket[data-bucket=${key}] ul` }; break;
    case 'ov-needs': spec = { kind: 'text', label: 'Sessions that need you', text: sessLines(state.snapshot.active.filter(s => phaseOf(s) === 'turn' || recentErr(s))), what: 'what needs you' }; ring = { type: 'sel', sel: '[data-ov=needs]' }; break;
    case 'ov-working': spec = { kind: 'text', label: 'Working sessions', text: sessLines(state.snapshot.active.filter(s => phaseOf(s) === 'working')), what: 'the working sessions' }; ring = { type: 'sel', sel: '[data-ov=working]' }; break;
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
  if (name === 'changes' && state.selected) loadChanges();
  if (name === 'shell') $('sh-cmd').focus();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab-b'); if (b) setTab(b.dataset.tab); });

// ------------------------------------------------------------ files tab
async function loadFiles() {
  const id = state.selected; if (!id) return;
  try {
    const r = await api.get(`/api/sessions/${sid(id)}/files`);
    if (state.selected !== id) return;
    state.files = r.files; renderFiles();
  } catch (e) { $('files').replaceChildren(h('div', { class: 'pad muted' }, e.message)); }
}
function renderFiles() {
  const files = state.files || []; const cwd = state.byId.get(state.selected)?.cwd;
  $('files-count').textContent = files.length || '';
  const now = Date.now();
  const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Reads'), h('th', {}, 'Writes'), h('th', {}, 'Last'), h('th', {}, ''))));
  const tb = h('tbody');
  for (const f of files) {
    const age = f.lastTs ? now - Date.parse(f.lastTs) : null;
    const hot = age != null && age < 10 * 60_000;
    tb.append(h('tr', { onclick: (e) => { tb.querySelectorAll('tr').forEach(r => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); openFile(f.path); } },
      h('td', { title: f.path }, hot ? h('span', { class: 'hot', title: 'touched in the last 10 minutes' }, '● ') : null, relPath(f.path, cwd)),
      h('td', { class: 'num' }, f.reads || ''), h('td', { class: 'num' }, f.writes || ''),
      h('td', { class: 'num', title: f.lastTs || '' }, f.lastTs ? ago(age) + ' ago' : ''),
      h('td', {}, h('button', { class: 'mini', type: 'button', onclick: (e) => { e.stopPropagation(); api.openEditor(f.path, 1); } }, 'Open'))));
  }
  table.append(tb);
  $('files').replaceChildren(files.length ? table : h('div', { class: 'pad muted' }, 'No files touched yet.'));
}
async function openFile(path, line = null) {
  state.detailsKey = `file:${path}`;
  try {
    const f = await api.get(`/api/file?path=${encodeURIComponent(path)}`);
    if (state.detailsKey !== `file:${path}`) return;
    $('details-body').replaceChildren(renderFileDetails(f, detailCtx(), line));
  } catch (e) { $('details-body').replaceChildren(renderFileDetails({ path, error: e.message }, detailCtx())); }
}
$('files-refresh').onclick = loadFiles;

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
      h('td', {}, h('button', { class: 'mini', type: 'button', onclick: (e) => { e.stopPropagation(); api.openEditor(`${c.root}/${f.path}`, 1); } }, 'Open'))));
  }
  table.append(tb);
  const commits = h('div', { class: 'commits' }, h('div', { class: 'sec-t', style: 'padding: 6px 14px 4px' }, 'Recent commits'));
  for (const k of c.commits) commits.append(h('div', { class: 'c', title: k.sha }, h('span', { class: 'sha' }, k.short), h('span', {}, k.subject), h('span', { class: 'who' }, `${k.author} · ${ago(Date.now() - Date.parse(k.date))}`)));
  root.replaceChildren(c.files.length ? table : h('div', { class: 'pad muted' }, 'Working tree clean.'), commits);
}
async function openDiff(file) {
  const id = state.selected; state.detailsKey = `diff:${file}`;
  try {
    const d = await api.get(`/api/sessions/${sid(id)}/diff?file=${encodeURIComponent(file)}`);
    if (state.detailsKey !== `diff:${file}`) return;
    $('details-body').replaceChildren(renderDiffDetails(d, detailCtx()));
  } catch (e) { toast(e.message); }
}
$('changes-refresh').onclick = loadChanges;
setInterval(() => { if (state.tab === 'changes' && state.selected && document.visibilityState === 'visible') loadChanges(); }, 10_000);

// ------------------------------------------------------------ shell tab
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function shellRunEl(run) {
  const el = h('div', { class: `run${run.running ? ' running' : ''}`, dataset: { run: run.id } });
  const head = h('div', { class: 'run-h' });
  head.append(h('span', { class: 'cmd', title: run.cmd }, `$ ${run.cmd}`));
  head.append(h('span', { class: 'cwd', title: run.cwd }, basename(run.cwd || '')));
  head.append(h('span', { class: 'chip status' }, run.running ? 'running' : ''));
  head.append(h('button', { class: 'mini', type: 'button', onclick: () => { $('sh-cmd').value = run.cmd; $('sh-cmd').focus(); } }, 'Reuse'));
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
