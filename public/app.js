// public/app.js — state, SSE wiring, panes. No build step, no dependencies.
import { renderRow, renderDetails, renderFileDetails, renderDiffDetails, h, esc, fmtTokens, fmtMs, fmtUsd, fmtTime, ago, relPath, basename, codeBlock } from './events.js';

const $ = (id) => document.getElementById(id);
const ROW_H = 26;

// ------------------------------------------------------------ api
const api = {
  async get(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); },
  async post(path, body) { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); },
  openEditor(path, line) { return api.post('/api/open-editor', { path, line }).catch(e => toast(`open editor failed: ${e.message}`)); },
};
const sid = (id) => encodeURIComponent(id);

// ------------------------------------------------------------ state
const state = {
  snapshot: { active: [], recent: [], closed: [] },
  byId: new Map(),            // id -> summary (sessions and agents)
  selected: null,
  cache: new Map(),           // id -> { events: [], byId: Map, lastSeq, meta, brief, summary, loaded }
  expanded: new Set(),        // agentIds expanded inline
  tab: 'events',
  follow: true,
  cursor: null,               // selected event id
  rows: [],
  filter: '',
  hideThinking: false,
  hideQueue: false,
  treeFilter: '',
  files: null, changes: null,
  shell: { runs: new Map(), order: [], history: JSON.parse(localStorage.getItem('deck.shhist') || '[]'), hi: -1 },
  detailsKey: null,
};
const prefs = JSON.parse(localStorage.getItem('deck.prefs') || '{}');
function savePrefs() { localStorage.setItem('deck.prefs', JSON.stringify(prefs)); }

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  Object.assign(t.style, { position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg3)', border: '1px solid var(--line)', padding: '6px 10px', borderRadius: '4px', zIndex: 9 });
  document.body.append(t); setTimeout(() => t.remove(), 2500);
}

// ------------------------------------------------------------ SSE
let es = null;
function connect() {
  es = new EventSource('/api/stream');
  es.onopen = () => { $('conn').classList.add('on'); if (state.selected) catchUp(state.selected); for (const id of state.expanded) catchUp(id); };
  es.onerror = () => { $('conn').classList.remove('on'); };
  es.addEventListener('sessions.snapshot', (e) => { applySnapshot(JSON.parse(e.data)); });
  es.addEventListener('event.batch', (e) => { const { sessionId, events } = JSON.parse(e.data); onEvents(sessionId, events); });
  es.addEventListener('event.update', (e) => { const { sessionId, event } = JSON.parse(e.data); onUpdate(sessionId, event); });
  es.addEventListener('session.update', (e) => { const d = JSON.parse(e.data); onSession(d); });
  es.addEventListener('shell.output', (e) => shellOutput(JSON.parse(e.data)));
  es.addEventListener('shell.exit', (e) => shellExit(JSON.parse(e.data)));
}

function applySnapshot(snap) {
  state.snapshot = snap;
  state.byId.clear();
  for (const b of ['active', 'recent', 'closed']) for (const s of snap[b]) { state.byId.set(s.id, s); for (const a of s.subagents || []) state.byId.set(a.id, a); }
  renderTree();
  if (state.selected) { renderBrief(); }
}

function onSession({ id, meta, brief, summary }) {
  const c = ensureCache(id);
  c.meta = meta; c.brief = brief; if (summary) { c.summary = summary; state.byId.set(id, summary); for (const a of summary.subagents || []) state.byId.set(a.id, a); updateTreeRow(summary); }
  if (id === state.selected) { renderBrief(); renderQueue(); }
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
  return c.loading;
}

// ------------------------------------------------------------ tree
function dotClass(s) {
  if (s.kind === 'agent') return s.status;
  if (!s.alive) return 'dead';
  return s.status || 'idle';
}
function treeRow(s, depth = 0) {
  const li = h('li', { class: `sess${s.kind === 'agent' ? ' agent' : ''}${s.id === state.selected ? ' selected' : ''}`, dataset: { id: s.id }, onclick: () => select(s.id) });
  li.append(h('span', { class: `dot ${dotClass(s)}`, title: s.kind === 'agent' ? s.status : (s.alive ? `${s.status || 'alive'} · pid ${s.pid}` : 'not running') }));
  const t = h('span', { class: 't' });
  t.append(h('span', { class: 'title', title: s.title }, s.title));
  const sub = s.kind === 'agent'
    ? [s.agentType, s.worktreeBranch ? `⎇ ${s.worktreeBranch}` : null].filter(Boolean).join(' · ')
    : [s.project, s.gitBranch ? `⎇ ${s.gitBranch}` : null, s.entrypoint === 'claude-desktop' ? 'desktop' : s.entrypoint].filter(Boolean).join(' · ');
  t.append(h('span', { class: 'sub', title: s.cwd || '' }, sub));
  li.append(t);
  const r = h('span', { class: 'r' });
  if (s.kind === 'session' && s.running) r.append(h('span', { class: 'chip runs', title: 'subagents running' }, `${s.running}⚡`), ' ');
  if (s.pr) r.append(h('a', { href: s.pr.url, target: '_blank', title: s.pr.url, onclick: (e) => e.stopPropagation() }, `#${s.pr.number}`), ' ');
  r.append(h('span', { title: new Date(s.mtime).toLocaleString() }, ago(Date.now() - (s.mtime || 0))));
  li.append(r);
  return li;
}
function matchesTree(s) {
  if (!state.treeFilter) return true;
  const q = state.treeFilter.toLowerCase();
  return [s.title, s.project, s.cwd, s.gitBranch, s.id].some(x => x && String(x).toLowerCase().includes(q))
    || (s.subagents || []).some(a => a.title?.toLowerCase().includes(q));
}
function renderTree() {
  for (const b of ['active', 'recent', 'closed']) {
    const sec = document.querySelector(`.bucket[data-bucket=${b}]`);
    const ul = sec.querySelector('ul'); ul.replaceChildren();
    const list = state.snapshot[b].filter(matchesTree);
    sec.querySelector('.count').textContent = list.length ? `(${list.length})` : '';
    for (const s of list) {
      ul.append(treeRow(s));
      const subs = (s.subagents || []);
      const show = b === 'active' ? subs : subs.filter(a => a.id === state.selected);
      for (const a of show) ul.append(treeRow(a, 1));
      if (b !== 'active' && subs.length && show.length < subs.length) {
        const more = h('li', { class: 'sess agent muted', onclick: () => { s._showAll = !s._showAll; renderTree(); } }, h('span'), h('span', { class: 't' }, s._showAll ? '' : `${subs.length} subagent${subs.length === 1 ? '' : 's'} ▸`));
        if (s._showAll) { more.remove(); for (const a of subs) ul.append(treeRow(a, 1)); } else ul.append(more);
      }
    }
  }
  const total = state.snapshot.active.length + state.snapshot.recent.length + state.snapshot.closed.length;
  $('tree-foot').textContent = `${total} sessions · ${state.snapshot.active.length} live`;
}
function updateTreeRow(s) {
  const li = document.querySelector(`.sess[data-id="${CSS.escape(s.id)}"]`);
  if (!li) return;
  const fresh = treeRow(s);
  li.replaceWith(fresh);
}

// ------------------------------------------------------------ selection
async function select(id) {
  if (!state.byId.has(id) && !state.cache.has(id)) return;
  state.selected = id;
  state.cursor = null;
  state.follow = true; $('follow').classList.add('active');
  prefs.selected = id; savePrefs();
  renderTree();
  const s = state.byId.get(id);
  $('brief').innerHTML = `<div class="brief-top"><span class="title">${esc(s?.title || id)}</span><span class="muted">loading…</span></div>`;
  $('vrows').replaceChildren();
  try {
    await loadSession(id);
  } catch (e) { toast(`load failed: ${e.message}`); return; }
  if (state.selected !== id) return;
  renderBrief(); renderQueue(); scheduleRows(true);
  state.files = null; state.changes = null;
  $('files-count').textContent = ''; $('changes-count').textContent = '';
  $('files').replaceChildren(); $('changes').replaceChildren(); $('changes-head').textContent = '';
  if (state.tab === 'files') loadFiles();
  if (state.tab === 'changes') loadChanges();
  $('sh-cwd').value = $('sh-cwd').value || s?.cwd || '';
  if (!$('sh-cwd').dataset.user) $('sh-cwd').value = s?.cwd || '';
}

// ------------------------------------------------------------ brief
function chip(label, title, cls = '') { return h('span', { class: `chip ${cls}`, title }, label); }
function renderBrief() {
  const id = state.selected; const c = state.cache.get(id); const s = state.byId.get(id) || c?.summary;
  const el = $('brief');
  if (!c || !s) return;
  const b = c.brief; const m = c.meta;
  el.replaceChildren();
  const top = h('div', { class: 'brief-top' });
  top.append(h('span', { class: 'title', title: s.cwd || '' }, s.title || id));
  if (b) top.append(h('span', { class: `state ${b.state.split(' ')[0]}` }, b.state));
  if (b?.detail) top.append(h('span', { class: 'detail', title: b.detail }, b.detail));
  el.append(top);
  if (b?.lastText) el.append(h('div', { class: 'last', title: m?.lastText || '' }, `“${b.lastText}”`));
  const chips = h('div', { class: 'chips' });
  if (s.kind === 'agent') {
    const parent = state.byId.get(s.parentId);
    chips.append(chip(`↑ ${parent?.title || s.parentId}`, 'parent session', ''), );
    chips.lastChild.style.cursor = 'pointer'; chips.lastChild.onclick = () => select(s.parentId);
    if (s.agentType) chips.append(chip(s.agentType, 'agent type'));
  } else {
    chips.append(chip(s.alive ? `pid ${s.pid}` : 'not running', s.alive ? `${s.entrypoint || ''} · ${s.sessionKind || ''}` : 'process gone; transcript only', s.alive ? 'ok' : ''));
    chips.append(chip('observe-only', 'Launched outside the deck. The deck can read but not drive this session (phase 3).'));
  }
  if (b?.model) chips.append(chip(b.model.replace('claude-', ''), 'model'));
  if (b?.effort) chips.append(chip(`effort ${b.effort}`, 'effort'));
  if (b?.mode && b.mode !== 'normal') chips.append(chip(b.mode, 'permission mode'));
  if (b?.turnUsage) chips.append(chip(`turn ${fmtTokens(b.turnUsage.output)}↑ ${fmtTokens(b.turnUsage.cacheRead + b.turnUsage.input + b.turnUsage.cacheCreate)}↓`, `this turn: ${b.turnUsage.messages} messages · out ${fmtTokens(b.turnUsage.output)} · in ${fmtTokens(b.turnUsage.input)} · cache read ${fmtTokens(b.turnUsage.cacheRead)} · cache write ${fmtTokens(b.turnUsage.cacheCreate)} · thinking ${fmtTokens(b.turnUsage.thinking)}${b.turnMs ? ' · ' + fmtMs(b.turnMs) : ''}`));
  if (b?.usage) chips.append(chip(`session ${fmtTokens(b.usage.output)}↑ ${fmtTokens(b.usage.cacheRead + b.usage.input + b.usage.cacheCreate)}↓`, `session: ${b.usage.messages} messages · ${b.turns} turns · out ${fmtTokens(b.usage.output)} · in ${fmtTokens(b.usage.input)} · cache read ${fmtTokens(b.usage.cacheRead)} · cache write ${fmtTokens(b.usage.cacheCreate)} · thinking ${fmtTokens(b.usage.thinking)}`));
  if (b?.cost?.totalCostUSD != null) chips.append(chip(fmtUsd(b.cost.totalCostUSD), `cost-state from Claude Code · +${b.cost.linesAdded} −${b.cost.linesRemoved} lines · models ${b.cost.models.join(', ')}`));
  if (b) chips.append(chip(`${b.filesTouched} files`, 'files touched'));
  if (b?.errors) chips.append(chip(`${b.errors} errors`, 'tool errors + api errors', 'err'));
  if (b?.branch) chips.append(chip(`⎇ ${b.branch}`, 'git branch (from transcript)'));
  if (b?.pr) { const a = h('a', { href: b.pr.url, target: '_blank' }, `PR #${b.pr.number}`); chips.append(h('span', { class: 'chip', title: b.pr.url }, a)); }
  if (b?.subagents?.total) chips.append(chip(`${b.subagents.running}/${b.subagents.total} subagents`, 'running / total'));
  if (b?.queueDepth) chips.append(chip(`${b.queueDepth} queued`, 'prompts queued', 'ok'));
  if (s.cwd) chips.append(chip(s.cwd.replace(/^\/Users\/[^/]+/, '~'), s.cwd));
  el.append(chips);
}

// ------------------------------------------------------------ prompt / queue
function renderQueue() {
  const c = state.cache.get(state.selected);
  const q = c?.meta?.queue || [];
  const ul = $('queue'); ul.replaceChildren();
  $('queue-count').textContent = q.length ? `(${q.length})` : '';
  $('prompt-note').textContent = q.length ? 'read-only mirror of the session queue' : 'queue empty';
  q.forEach((item, i) => {
    ul.append(h('li', {}, h('span', { class: 'n' }, `${i + 1}.`), h('span', { class: 'q', title: item.content }, item.content.replace(/\s+/g, ' ')),
      h('button', { class: 'mini', onclick: () => navigator.clipboard?.writeText(item.content) }, 'copy')));
  });
}
$('prompt-toggle').onclick = () => $('prompt').classList.toggle('collapsed');
$('copy-last').onclick = () => { const p = state.cache.get(state.selected)?.meta?.lastPrompt; if (p) { navigator.clipboard?.writeText(p); toast('copied last prompt'); } };

// ------------------------------------------------------------ events list
let rowsTimer = null;
function scheduleRows(jump = false) {
  if (rowsTimer) return;
  rowsTimer = requestAnimationFrame(() => { rowsTimer = null; buildRows(); renderRows(jump); });
}
function evMatches(ev, q) {
  if (!q) return true;
  const hay = ev.kind === 'tool' ? `${ev.tool.display} ${ev.tool.summary} ${JSON.stringify(ev.tool.input).slice(0, 2000)}` : `${ev.kind} ${ev.text || ''} ${ev.subtype || ''}`;
  return hay.toLowerCase().includes(q);
}
function buildRows() {
  const c = state.cache.get(state.selected);
  const rows = [];
  if (!c) { state.rows = rows; return; }
  const q = state.filter.toLowerCase();
  const push = (ev, depth) => {
    if (state.hideThinking && ev.kind === 'thinking') return;
    if (state.hideQueue && ev.kind === 'queue') return;
    if (!evMatches(ev, q)) return;
    rows.push({ ev, depth });
  };
  // Newest first. Inline subagent events sit directly under their Agent
  // row, also newest first.
  for (let i = c.events.length - 1; i >= 0; i--) {
    const ev = c.events[i];
    push(ev, 0);
    if (ev.kind === 'tool' && ev.tool.agentId && state.expanded.has(ev.tool.agentId)) {
      const ac = state.cache.get(ev.tool.agentId);
      if (ac?.loaded) for (let j = ac.events.length - 1; j >= 0; j--) push(ac.events[j], 1);
      else rows.push({ ev: { id: `loading:${ev.tool.agentId}`, kind: 'system', subtype: 'loading', text: 'loading subagent events…', ts: null, sessionId: ev.tool.agentId }, depth: 1 });
    }
  }
  state.rows = rows;
  $('events-count').textContent = `(${rows.length})`;
}
const vlist = $('vlist'), vspacer = $('vspacer'), vrows = $('vrows');
function renderRows(jump = false) {
  const n = state.rows.length;
  vspacer.style.height = `${n * ROW_H}px`;
  if (jump || state.follow) vlist.scrollTop = 0; // newest rows live at the top
  const first = Math.max(0, Math.floor(vlist.scrollTop / ROW_H) - 8);
  const last = Math.min(n, Math.ceil((vlist.scrollTop + vlist.clientHeight) / ROW_H) + 8);
  vrows.style.transform = `translateY(${first * ROW_H}px)`;
  const frag = document.createDocumentFragment();
  const cwd = state.byId.get(state.selected)?.cwd;
  for (let i = first; i < last; i++) {
    const { ev, depth } = state.rows[i];
    const agentStatus = ev.kind === 'tool' && ev.tool.agentId ? state.byId.get(ev.tool.agentId)?.status : null;
    frag.append(renderRow(ev, { depth, selected: ev.id === state.cursor, cwd, agentStatus, expanded: ev.kind === 'tool' && state.expanded.has(ev.tool.agentId) }));
  }
  vrows.replaceChildren(frag);
}
vlist.addEventListener('scroll', () => {
  const atTop = vlist.scrollTop <= ROW_H;
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
  if (!row) return;
  const ev = findEvent(row.dataset.sid, row.dataset.id);
  if (ev) { setCursor(ev.id); showEventDetails(ev); }
});
function findEvent(sessionId, id) { return state.cache.get(sessionId)?.byId.get(id) || null; }
function setCursor(id) { state.cursor = id; renderRows(); }
function setFollow(on, quiet = false) {
  state.follow = on; $('follow').classList.toggle('active', on);
  if (on && !quiet) { vlist.scrollTop = 0; renderRows(); }
}
$('follow').onclick = () => setFollow(!state.follow);
$('ev-filter').oninput = (e) => { state.filter = e.target.value; scheduleRows(); };
$('hide-thinking').onchange = (e) => { state.hideThinking = e.target.checked; prefs.hideThinking = state.hideThinking; savePrefs(); scheduleRows(); };
$('hide-queue').onchange = (e) => { state.hideQueue = e.target.checked; prefs.hideQueue = state.hideQueue; savePrefs(); scheduleRows(); };

function moveCursor(delta) {
  if (!state.rows.length) return;
  let i = state.rows.findIndex(r => r.ev.id === state.cursor);
  i = i < 0 ? (delta > 0 ? 0 : state.rows.length - 1) : Math.max(0, Math.min(state.rows.length - 1, i + delta));
  const ev = state.rows[i].ev;
  setFollow(false, true);
  setCursor(ev.id);
  const top = i * ROW_H;
  if (top < vlist.scrollTop) vlist.scrollTop = top;
  else if (top + ROW_H > vlist.scrollTop + vlist.clientHeight) vlist.scrollTop = top + ROW_H - vlist.clientHeight;
  renderRows();
  showEventDetails(ev);
}
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter') { const ev = state.cursor && findEvent(state.selected, state.cursor); if (ev) showEventDetails(ev); }
  else if (e.key === ' ') { e.preventDefault(); setFollow(!state.follow); }
  else if (e.key === '/') { e.preventDefault(); $('ev-filter').focus(); }
  else if (e.key === 'G') { setFollow(true); }
  else if (['1', '2', '3', '4'].includes(e.key)) setTab(['events', 'files', 'changes', 'shell'][+e.key - 1]);
});

// ------------------------------------------------------------ details
const detailCtx = () => ({
  cwd: state.byId.get(state.selected)?.cwd || state.cache.get(state.selected)?.meta?.cwd || null,
  root: state.changes?.root || null,
  api, selectSession: select,
  agentStatus: (id) => state.byId.get(id)?.status || null,
});
async function showEventDetails(ev, refreshOnly = false) {
  const key = `${ev.sessionId}:${ev.id}`;
  const body = $('details-body');
  const needsFull = ev.kind === 'tool' && (ev.tool.result?.truncated || ev.tool.result?.images?.length || !ev.tool.pending);
  if (!refreshOnly || state.detailsKey !== key) { state.detailsKey = key; body.replaceChildren(renderDetails(ev, needsFull ? null : undefined, detailCtx())); body.scrollTop = 0; }
  if (!needsFull && !refreshOnly) return;
  try {
    const d = await api.get(`/api/sessions/${sid(ev.sessionId)}/events/${sid(ev.id)}`);
    if (state.detailsKey !== key) return;
    const scroll = body.scrollTop;
    body.replaceChildren(renderDetails(d.event || ev, d, detailCtx())); body.scrollTop = scroll;
  } catch (e) { console.warn(e); }
}

// ------------------------------------------------------------ tabs
function setTab(name) {
  state.tab = name; prefs.tab = name; savePrefs();
  document.querySelectorAll('.tab-b').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
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
  $('files-count').textContent = files.length ? `(${files.length})` : '';
  const now = Date.now();
  const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'file'), h('th', {}, 'reads'), h('th', {}, 'writes'), h('th', {}, 'last'), h('th', {}, ''))));
  const tb = h('tbody');
  for (const f of files) {
    const age = f.lastTs ? now - Date.parse(f.lastTs) : null;
    const heat = age == null ? '' : age < 10 * 60_000 ? 'hot' : age > 6 * 3600_000 ? 'cold' : '';
    tb.append(h('tr', { onclick: (e) => { tb.querySelectorAll('tr').forEach(r => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); openFile(f.path); } },
      h('td', { title: f.path }, h('span', { class: heat }, heat === 'hot' ? '● ' : ''), relPath(f.path, cwd)),
      h('td', { class: 'num' }, f.reads || ''), h('td', { class: 'num' }, f.writes || ''),
      h('td', { class: 'num', title: f.lastTs || '' }, f.lastTs ? ago(age) + ' ago' : ''),
      h('td', {}, h('button', { class: 'mini', onclick: (e) => { e.stopPropagation(); api.openEditor(f.path, 1); } }, '↗ editor'))));
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
  $('changes-head').textContent = 'loading git status…';
  try {
    const r = await api.get(`/api/sessions/${sid(id)}/changes`);
    if (state.selected !== id) return;
    state.changes = r; renderChanges();
  } catch (e) { $('changes').replaceChildren(h('div', { class: 'pad muted' }, e.message)); }
}
function renderChanges() {
  const c = state.changes; const root = $('changes');
  if (!c?.repo) { $('changes-head').textContent = c?.cwd ? `${c.cwd} is not a git repository` : 'no cwd'; root.replaceChildren(); $('changes-count').textContent = ''; return; }
  $('changes-count').textContent = c.files.length ? `(${c.files.length})` : '';
  const head = $('changes-head'); head.replaceChildren();
  head.append(chip(`⎇ ${c.branch || '(detached)'}`, c.root));
  if (c.upstream) head.append(chip(`${c.upstream} ↑${c.ahead} ↓${c.behind}`, 'ahead / behind upstream', c.behind ? 'err' : ''));
  if (c.vsBase) head.append(chip(`${c.vsBase.base} ↑${c.vsBase.ahead} ↓${c.vsBase.behind}`, 'ahead / behind default branch'));
  head.append(chip(`${c.totals.files} files`, 'changed files'), h('span', { class: 'add-n' }, ` +${c.totals.added}`), h('span', { class: 'del-n' }, ` −${c.totals.deleted}`));
  const table = h('table', { class: 'list' }, h('thead', {}, h('tr', {}, h('th', {}, 'st'), h('th', {}, 'file'), h('th', {}, '+'), h('th', {}, '−'), h('th', {}, ''))));
  const tb = h('tbody');
  for (const f of c.files) {
    const st = f.untracked ? '??' : `${f.x}${f.y}`.trim();
    tb.append(h('tr', { onclick: (e) => { tb.querySelectorAll('tr').forEach(r => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); openDiff(f.path); } },
      h('td', {}, h('span', { class: 'st-x', title: `index: ${f.x} · worktree: ${f.y}` }, st)),
      h('td', { title: f.from ? `renamed from ${f.from}` : f.path }, f.path),
      h('td', { class: 'num add-n' }, f.added ?? (f.binary ? 'bin' : '')), h('td', { class: 'num del-n' }, f.deleted ?? ''),
      h('td', {}, h('button', { class: 'mini', onclick: (e) => { e.stopPropagation(); api.openEditor(`${c.root}/${f.path}`, 1); } }, '↗ editor'))));
  }
  table.append(tb);
  const commits = h('div', { class: 'commits' }, h('div', { class: 'dsec-h', style: 'padding: 6px 10px 2px' }, 'recent commits'));
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
  head.append(h('button', { class: 'mini', onclick: () => { $('sh-cmd').value = run.cmd; $('sh-cmd').focus(); } }, '↺ reuse'));
  head.append(h('button', { class: 'mini kill', onclick: () => api.post('/api/shell/kill', { runId: run.id }) }, 'kill'));
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
    localStorage.setItem('deck.shhist', JSON.stringify(state.shell.history));
    state.shell.hi = -1; $('sh-cmd').value = '';
  } catch (e) { toast(`run failed: ${e.message}`); }
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
        if (side === 'left') { const w = Math.max(180, Math.min(600, ev.clientX)); deck.style.setProperty('--left', w + 'px'); prefs.left = w; }
        else { const w = Math.max(260, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX)); deck.style.setProperty('--right', w + 'px'); prefs.right = w; }
        renderRows();
      };
      const up = () => { g.classList.remove('active'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); savePrefs(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  });
  document.querySelectorAll('.bucket h3').forEach(hd => hd.onclick = () => hd.parentElement.classList.toggle('collapsed'));
  $('tree-filter').oninput = (e) => { state.treeFilter = e.target.value; renderTree(); };
  window.addEventListener('resize', () => renderRows());
}

// ------------------------------------------------------------ boot
initLayout();
if (prefs.hideThinking) { state.hideThinking = true; $('hide-thinking').checked = true; }
if (prefs.hideQueue) { state.hideQueue = true; $('hide-queue').checked = true; }
setTab(prefs.tab || 'events');
connect();
loadShellHistory();
setInterval(() => { if (state.selected) renderBrief(); }, 5000);
api.get('/api/sessions').then(snap => {
  applySnapshot(snap);
  const want = prefs.selected && state.byId.has(prefs.selected) ? prefs.selected : snap.active[0]?.id || snap.recent[0]?.id;
  if (want) select(want);
});
