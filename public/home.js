// public/home.js — Home (#33): a grid of workstream cards, each opening into a
// full view with tabs, an Unaffiliated card for sessions in no workstream, and
// the Home/Sessions toggle beside the status dot (key h). Everything drawn here
// comes from the workstreams store and the deck's live sessions: no model calls.
// app.js registers it with initHome(ctx) and calls the two change hooks.
import { h, ib, svgUse, ago, oneLine, markdown, basename, relPath } from './events.js';
import { registerView, showView, currentView } from './views.js';
import { registerMenuItem } from './menu.js';
import { openFile as vaultFile } from './vault.js';
import { workstreamMap, cardStates, orderCards, unaffiliated, isLive, parseNotes, parseSource, decisionGroups, groupFiles, sessionRows, coalesce, SHOWN } from './homemodel.js';

const $ = (id) => document.getElementById(id);
let ctx = null;
const st = {
  list: [], sync: null, setup: null, loaded: false, stale: true,
  all: false,                // done and archived shown too
  open: null,                // the expanded workstream: { slug, detail, tab }
  scroll: 0,
};
let root = null; let scroller = null; let grid = null; let panel = null;

async function call(path, method = 'GET', body) {
  const r = await fetch(path, body !== undefined ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
  let out = null; try { out = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}
const toast = (msg) => ctx?.toast ? ctx.toast(msg) : console.warn(msg);
const enc = encodeURIComponent;
const since = (t) => t ? ago(Date.now() - t) : '';
const when = (t) => t ? new Date(t).toLocaleString() : '';
const sessions = () => ctx?.sessions() || [];

// ------------------------------------------------------------ hooks for other features
const badges = [];
/**
 * A glyph on a card's title row, from another feature: fn(workstream) → node or
 * null. #37's curation badge (due for compaction) lands here. Returns a remover.
 */
export function registerCardBadge(fn) { badges.push(fn); return () => { const i = badges.indexOf(fn); if (i >= 0) badges.splice(i, 1); }; }

// #30's PR chips (ghchips.js) and #35's workstream picker (wspicker.js), when
// those have landed; plain links and a select of workstreams until then.
let chipsMod;
const chips = () => chipsMod ??= import('./ghchips.js').catch(() => null);
const picker = () => import('./wspicker.js').catch(() => null);

// ------------------------------------------------------------ the view
export function initHome(c) {
  ctx = c;
  registerView('home', { mount, unmount });
  syncToggle();
  $('view-toggle')?.addEventListener('click', toggleHome);
  // Ahead of app.js's keys: on Home, Esc closes the open card (or does nothing),
  // and the session view's keys have nothing to act on.
  document.addEventListener('keydown', onKey, true);
  registerMenuItem({ group: 'views', order: 10, icon: 'i-home', text: 'Home', fn: goHome, kbd: 'h' });
}

export function goHome() { showView('home'); }
/** Home, with one workstream open (#35's header chip calls this). */
export async function openWorkstream(slug) {
  goHome();
  if (!st.loaded || st.stale) await load();
  if (st.open?.slug === slug) return;
  openCard(slug, grid.querySelector(`[data-key="${CSS.escape(slug)}"]`));
}
/** h, and the toggle: Home ↔ the session view as it was left. */
export function toggleHome() { currentView() === 'home' ? ctx.back() : goHome(); }
export const homeShowing = () => { try { return localStorage.getItem('deck.home') === '1'; } catch { return false; } };

function mount(pane) {
  if (!root) build(pane);
  root.hidden = false;
  try { localStorage.setItem('deck.home', '1'); } catch { /* private mode */ }
  syncToggle(true);
  if (st.stale || !st.loaded) load(); else render();
  scroller.scrollTop = st.scroll;
}
function unmount() {
  if (!root) return;
  st.scroll = scroller.scrollTop;
  root.hidden = true;
  try { localStorage.setItem('deck.home', '0'); } catch { /* private mode */ }
  syncToggle(false);
}
// views.js names the new view only after the old one unmounts: say which.
function syncToggle(home = currentView() === 'home') {
  const b = $('view-toggle'); if (!b) return;
  const label = home ? 'Sessions (h)' : 'Home (h)';
  b.replaceChildren(svgUse(home ? 'i-sessions' : 'i-home', 15));
  b.title = label; b.setAttribute('aria-label', label);
}

function build(pane) {
  grid = h('div', { class: 'hm-grid', role: 'list' });
  scroller = h('div', { class: 'hm-scroll' }, h('div', { class: 'hm-bar' }), grid);
  panel = h('div', { class: 'hm-x', hidden: true, role: 'dialog', 'aria-modal': 'false' });
  root = h('section', { id: 'home-view', class: 'home', 'aria-label': 'Home', hidden: true }, scroller, panel);
  // Enter and Space act on what has focus here; app.js would read them as event details and read-aloud.
  root.addEventListener('keydown', stopActivation);
  pane.append(root);
}

function stopActivation(e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }
function onKey(e) {
  if (currentView() !== 'home') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (document.querySelector('dialog[open], :popover-open')) return;   // theirs to close
    e.stopPropagation(); e.preventDefault();
    if (st.open) closeCard();
    return;
  }
  // Keys that act on the open session (events, filters, ask, read aloud of the cursor) have nothing to act on here.
  if (['ArrowDown', 'ArrowUp', 'l', 'r', '/', 'a', 's', 'S', '1', '2', '3', '4', '5'].includes(e.key)) e.stopPropagation();
}

// ------------------------------------------------------------ data
// One fetch at a time; a change that lands during one gets a fetch of its own after it.
const load = coalesce(async () => {
  st.stale = false;
  try {
    const r = await call('/api/workstreams?cards=1');
    st.list = r.workstreams || []; st.sync = r.sync || null;
    if (!st.sync?.ready && !st.setup) st.setup = await call('/api/workstreams/setup').catch(e => ({ suggest: { error: e.message } }));
    st.loaded = true; st.error = null;
  } catch (e) { st.error = e.message; st.loaded = true; }
  if (currentView() === 'home') { render(); if (st.open) await refreshOpen(); }
});

let rerender = 0;
/** The deck's sessions changed (app.js renderTree): redraw from what's here, no fetch. */
export function homeSessionsChanged() {
  if (currentView() !== 'home' || rerender) return;
  rerender = requestAnimationFrame(() => { rerender = 0; render(); if (st.open && st.open.tab === 'sessions') drawTab(); });
}
let reloadT = null;
const changed = new Set();
/** workstreams.changed from the server: fetch again, now if Home shows, else when it next does. */
export function homeWorkstreamsChanged(e) {
  st.stale = true;
  // Which workstreams changed, so the open one keeps its Files and Vault reads unless it is one.
  let d = null; try { d = e?.data ? JSON.parse(e.data) : e; } catch { /* no detail */ }
  for (const slug of [d?.slug, d?.was].filter(Boolean)) changed.add(slug);
  if (!d?.slug && !d?.was) changed.add('*');
  if (currentView() !== 'home') return;
  clearTimeout(reloadT); reloadT = setTimeout(load, 150);
}

// ------------------------------------------------------------ the grid
function render() {
  if (!root) return;
  drawBar();
  if (st.error) { grid.replaceChildren(h('div', { class: 'hm-empty muted' }, `Workstreams: ${st.error}`)); return; }
  if (!st.loaded) return;
  if (!st.sync?.ready) {
    // A session tick must not wipe what is being typed into the setup card.
    const cur = grid.querySelector('.hm-setup');
    if (cur && (cur.contains(document.activeElement) || [...cur.querySelectorAll('input')].some(i => i.value))) return;
    grid.replaceChildren(setupCard()); return;
  }
  const all = sessions();
  const map = workstreamMap(st.list, all);
  const cards = orderCards(cardStates(st.list, all, { sigOf: ctx.sigOf, map }), { all: st.all });
  const un = unaffiliated(all, map, { sigOf: ctx.sigOf });
  const out = cards.map(card);
  if (un.total) out.push(unaffiliatedCard(un));
  out.push(newCard());
  patch(grid, out);
  chips().then(m => m?.watchRefs?.(cards.flatMap(c => prsOf(c))));
}
/** Replace the grid's children, keeping a card that holds an open form, and focus where it was. */
function patch(el, nodes) {
  const keep = el.querySelector('.hm-card.editing');
  if (keep) { const i = nodes.findIndex(n => n.dataset?.key === keep.dataset.key); if (i >= 0) nodes[i] = keep; }
  const f = document.activeElement;
  const was = el.contains(f) ? f.closest('[data-key]') : null;
  const focusables = (c) => [...c.querySelectorAll('button, a[href], [tabindex]')];
  const at = was && was !== f ? focusables(was).indexOf(f) : -1;
  el.replaceChildren(...nodes);
  if (!was || was === keep) return;
  const now = el.querySelector(`[data-key="${CSS.escape(was.dataset.key)}"]`);
  const target = (at >= 0 && now ? focusables(now)[at] : null) || now;
  target?.focus({ preventScroll: true });
}

function drawBar() {
  const bar = scroller.querySelector('.hm-bar');
  const hidden = st.list.filter(w => !SHOWN.includes(w.status || 'active')).length;
  const s = st.sync;
  const trouble = s?.conflict ? `Sync stopped on a conflict in ${[].concat(s.conflict.files || s.conflict).join(', ')}. Fix it in ${s.dir}, then sync.`
    : s?.dirty ? `The workstreams clone has uncommitted changes (${s.dir}).`
      : s?.lastError ? `Last push failed: ${s.lastError}` : null;
  bar.replaceChildren(...[
    h('span', { class: 'hm-bar-t' }, svgUse('i-workstream', 14), h('span', { class: 'sr' }, 'Workstreams')),
    s?.ahead ? h('span', { class: 'hm-q', title: `${s.ahead} change${s.ahead === 1 ? '' : 's'} not pushed yet` }, svgUse('i-push', 12), s.ahead) : null,
    trouble ? ib('i-alert', `${trouble}\nClick to sync now.`, () => call('/api/workstreams/sync', 'POST', {}).then(load).catch(e => toast(`Sync: ${e.message}`)), { cls: 'hm-warn', size: 13 }) : null,
    h('span', { class: 'spacer' }),
    st.sync?.ready && (hidden || st.all) ? h('button', { type: 'button', class: 'ib tg hm-filter', 'aria-pressed': String(st.all), title: st.all ? 'Hide done and archived' : `Show done and archived (${hidden})`, 'aria-label': 'Show done and archived',
      onclick: () => { st.all = !st.all; render(); } }, svgUse('i-filter', 13), hidden && !st.all ? h('span', { class: 'ib-n' }, hidden) : null) : null].filter(Boolean));
}

const SIG_LABEL = { input: 'needs you', error: 'error', working: 'working', done: 'done', ended: 'ended' };
function dot(s, sig, { big = false } = {}) {
  return h('button', { type: 'button', class: `hm-dot${big ? ' big' : ''}`, title: `${s.title} · ${SIG_LABEL[sig] || sig}`, 'aria-label': `Open ${s.title} (${SIG_LABEL[sig] || sig})`,
    onclick: (e) => { e.stopPropagation(); ctx.open(s.id); } }, h('span', { class: `dot sig-${sig}` }));
}

/** Open PRs: the record's links, and the branch PR of any session in it. */
function prsOf(w, ss = w.live?.map(x => x.s) || []) {
  const out = new Map();
  for (const l of w.links || []) if ((l.kind || 'pr') === 'pr' && !/^(closed|merged)$/i.test(l.state || '')) out.set(l.url || `${l.repo}#${l.number}`, { kind: 'pr', ...l });
  for (const s of ss) if (s.pr?.url && !out.has(s.pr.url)) out.set(s.pr.url, { kind: 'pr', repo: s.pr.repo, number: s.pr.number, url: s.pr.url, state: 'open' });
  return [...out.values()];
}
function refChip(ref, mod) {
  const chip = mod?.miniChip?.(ref);
  if (chip) return chip;
  const n = ref.number != null ? `#${ref.number}` : oneLine(ref.title || ref.url || '', 30);
  return h('a', { class: 'hm-pr', href: ref.url || null, target: '_blank', rel: 'noopener', title: [ref.repo, ref.title, ref.state].filter(Boolean).join(' · '), onclick: (e) => e.stopPropagation() },
    svgUse(ref.kind === 'issue' ? 'i-issue' : 'i-pr', 11), n);
}
function refRow(refs) {
  if (!refs.length) return null;
  const row = h('div', { class: 'hm-prs' }, refs.map(r => refChip(r, null)));
  chips().then(m => { if (m?.miniChip) row.replaceChildren(...refs.map(r => refChip(r, m))); });
  return row;
}

const COUNTS = [['decisions', 'i-check', 'decision', 'decisions'], ['notes', 'i-pencil', 'note', 'notes'], ['files', 'i-file', 'starred file', 'files'], ['sessions', 'i-sessions', 'session', 'sessions']];
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

function card(w) {
  const c = { ...(w.counts || {}), sessions: Math.max(w.sessions || 0, w.counts?.records || 0) };
  const shown = COUNTS.filter(([k]) => c[k]);
  const live = [...w.live].sort((a, b) => (b.sig === 'input' || b.sig === 'error') - (a.sig === 'input' || a.sig === 'error'));
  const el = h('article', { class: `hm-card${w.needs ? ' needs' : ''}${w.status !== 'active' ? ` st-${w.status}` : ''}`, role: 'listitem', tabindex: '0', dataset: { key: w.slug },
    'aria-label': `${w.title}${w.needs ? ', needs you' : ''}`,
    onclick: () => openCard(w.slug, el), onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); e.stopPropagation(); openCard(w.slug, el); } } },
    h('div', { class: 'hm-c-h' },
      h('h3', { class: 'hm-t', title: w.title }, w.title),
      h('span', { class: 'hm-badges' }, badges.map(fn => { try { return fn(w); } catch { return null; } })),
      live.length ? h('span', { class: 'hm-dots' }, live.map(x => dot(x.s, x.sig, { big: x.sig === 'input' || x.sig === 'error' }))) : null),
    w.goal ? h('p', { class: 'hm-goal', title: w.goal }, oneLine(w.goal, 300)) : null,
    refRow(prsOf(w)),
    w.next ? h('p', { class: 'hm-next', title: `Next step: ${w.next}` }, svgUse('i-right', 11), h('span', {}, oneLine(w.next, 400))) : null,
    h('footer', { class: 'hm-f' },
      w.status !== 'active' ? h('span', { class: `hm-st st-${w.status}` }, w.status) : null,
      h('span', { class: 'hm-ago', title: w.last ? `Last activity ${when(w.last)}` : null }, since(w.last)),
      h('span', { class: 'spacer' }),
      shown.length ? h('span', { class: 'hm-counts', title: shown.map(([k, , one]) => plural(c[k], one)).join(' · ') },
        shown.map(([k, icon]) => h('span', { class: 'hm-n' }, svgUse(icon, 11), c[k]))) : null));
  return el;
}

function unaffiliatedCard(un) {
  return h('article', { class: 'hm-card hm-un', role: 'listitem', dataset: { key: '~unaffiliated' } },
    h('div', { class: 'hm-c-h' }, h('h3', { class: 'hm-t muted' }, 'Unaffiliated'), h('span', { class: 'hm-q', title: `${plural(un.total, 'session')} in no workstream` }, un.total)),
    h('ul', { class: 'hm-un-l' }, un.rows.map(({ s, live, sig }) => h('li', {},
      h('span', { class: `dot sig-${sig}`, title: SIG_LABEL[sig] }),
      h('button', { type: 'button', class: 'hm-un-t', title: [s.title, s.project, s.gitBranch].filter(Boolean).join(' · '), onclick: () => ctx.open(s.id) }, s.title),
      h('span', { class: 'hm-ago', title: when(s.statusUpdatedAt || s.mtime) }, live ? '' : since(s.mtime)),
      h('button', { type: 'button', class: 'linkish hm-assign', onclick: (e) => assign(e.currentTarget, s) }, 'Assign')))));
}

function newCard() {
  return h('button', { type: 'button', class: 'hm-card hm-new', dataset: { key: '~new' }, onclick: (e) => newWorkstream(e.currentTarget) },
    svgUse('i-plus', 14), h('span', {}, 'New workstream'));
}

// ------------------------------------------------------------ assigning and creating
async function assign(anchor, s) {
  const m = await picker();
  // It assigns before onPick; workstreams.changed redraws, the reload here is for a missed event.
  if (m?.openWorkstreamPicker) return m.openWorkstreamPicker(anchor, { sessionId: s.id, current: null, none: false, onPick: () => homeWorkstreamsChanged() });
  pickFallback(anchor, s);
}
/** Without #35's picker: a select of the open workstreams. */
function pickFallback(anchor, s) {
  document.querySelector('.hm-pick')?.remove();
  const open = st.list.filter(w => SHOWN.includes(w.status || 'active'));
  const sel = h('select', { class: 'field', 'aria-label': `Workstream for ${s.title}` }, open.map(w => h('option', { value: w.slug }, w.title)));
  const pop = h('form', { class: 'hm-pick menu-pop', popover: 'auto', onsubmit: async (e) => {
    e.preventDefault();
    try { await call(`/api/sessions/${enc(s.id)}/workstream`, 'POST', { slug: sel.value }); pop.hidePopover(); }
    catch (err) { toast(`Assign failed: ${err.message}`); }
  } }, open.length ? [sel, h('button', { class: 'btn primary sm' }, 'Assign')] : h('span', { class: 'muted' }, 'No open workstreams yet.'));
  pop.addEventListener('toggle', (e) => { if (e.newState === 'closed') pop.remove(); });
  pop.addEventListener('keydown', stopActivation);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, innerHeight - 80)}px`; pop.style.left = `${Math.max(8, Math.min(r.left - 120, innerWidth - 320))}px`;
  pop.showPopover(); sel.focus();
}

function newWorkstream(btn) {
  // Inline, not #35's picker: that opens on the list of existing ones, a step too many here.
  // The card becomes a short form; Enter creates and opens it, Esc puts the card back.
  const title = h('input', { class: 'field', placeholder: 'Title', 'aria-label': 'Title', required: true, spellcheck: 'false' });
  const goal = h('input', { class: 'field', placeholder: 'Goal, in a line', 'aria-label': 'Goal' });
  const form = h('form', { class: 'hm-card hm-new editing', dataset: { key: '~new' }, onsubmit: async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return title.focus();
    form.classList.add('busy');
    try {
      const r = await call('/api/workstreams', 'POST', { title: title.value.trim(), goal: goal.value.trim() });
      form.classList.remove('editing');
      await load();
      const el = grid.querySelector(`[data-key="${CSS.escape(r.workstream.slug)}"]`);
      openCard(r.workstream.slug, el);
    } catch (err) { form.classList.remove('busy'); toast(`Create failed: ${err.message}`); }
  }, onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); form.replaceWith(newCard()); } } },
  title, goal, h('div', { class: 'hm-new-a' }, h('button', { type: 'button', class: 'btn sm', onclick: () => form.replaceWith(newCard()) }, 'Cancel'), h('button', { class: 'btn primary sm' }, 'Create')));
  btn.replaceWith(form); title.focus();
}

// ------------------------------------------------------------ first use: the repo
function setupCard() {
  const sug = st.setup?.suggest || {};
  const repoIn = h('input', { class: 'field grow', placeholder: 'owner/name, a git URL, or a path', 'aria-label': 'An existing private repo', spellcheck: 'false' });
  const use = async (repo) => {
    try { await call('/api/workstreams/setup', 'POST', { action: 'use', repo }); st.setup = null; await load(); }
    catch (e) { toast(`Use repo: ${e.message}`); }
  };
  return h('div', { class: 'hm-setup', dataset: { key: '~setup' } },
    h('h3', {}, svgUse('i-workstream', 15), 'Workstreams'),
    h('p', { class: 'muted' }, 'Workstreams keep a long effort’s goal, decisions, notes and next step across sessions. They live in one private GitHub repo, cloned to ', h('code', {}, st.setup?.dir || st.sync?.dir || '~/.agent-deck/workstreams'), '.'),
    sug.error ? h('p', { class: 'note err' }, `GitHub: ${sug.error}`) : null,
    sug.repo ? h('div', { class: 'hm-setup-a' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => confirmCreate(sug) }, sug.exists ? `Use ${sug.repo}` : `Create ${sug.repo}…`)) : null,
    h('form', { class: 'hm-setup-a', onsubmit: (e) => { e.preventDefault(); if (repoIn.value.trim()) use(repoIn.value.trim()); } },
      repoIn, h('button', { class: 'btn' }, 'Use this repo')));
}
/** Nothing is created on GitHub without this dialog's yes. */
function confirmCreate(sug) {
  const d = h('dialog', { class: 'dialog hm-confirm', 'aria-labelledby': 'hm-confirm-t' },
    h('form', { method: 'dialog' },
      h('h2', { id: 'hm-confirm-t' }, sug.exists ? 'Use this private repo?' : 'Create a private GitHub repo?'),
      h('p', {}, sug.exists ? `${sug.repo} already exists${sug.visibility ? ` and is ${sug.visibility}` : ''}. The deck clones it and keeps workstreams there.`
        : 'The deck runs this once, then clones the repo and commits each workstream change to it. Only you can see a private repo.'),
      sug.exists ? null : h('pre', { class: 'hm-cmd' }, sug.command || `gh repo create ${sug.repo} --private`),
      h('div', { class: 'dialog-a' }, h('button', { value: 'cancel', class: 'btn' }, 'Cancel'), h('button', { value: 'ok', class: 'btn primary' }, sug.exists ? 'Use it' : 'Create'))));
  d.addEventListener('close', async () => {
    d.remove();
    if (d.returnValue !== 'ok') return;
    try { await call('/api/workstreams/setup', 'POST', { action: 'create', confirm: true }); st.setup = null; await load(); }
    catch (e) { toast(`Setup failed: ${e.message}`); }
  });
  document.body.append(d); d.showModal();
}

// ------------------------------------------------------------ the expanded view
const TABS = [['overview', 'Overview'], ['sessions', 'Sessions'], ['decisions', 'Decisions'], ['files', 'Files'], ['notes', 'Notes'], ['links', 'Links'], ['vault', 'Vault']];
const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

async function openCard(slug, fromEl) {
  st.scroll = scroller.scrollTop;
  st.open = { slug, detail: null, tab: st.open?.slug === slug ? st.open.tab : 'overview', extra: {} };
  panel.hidden = false; scroller.inert = true;
  panel.replaceChildren(h('div', { class: 'hm-x-load muted' }, 'Loading…'));
  grow(fromEl);
  await refreshOpen();
  panel.querySelector('.hm-back')?.focus({ preventScroll: true });
}
/** The animated grow: the panel opens out of the card's rectangle. */
function grow(fromEl, reverse = false) {
  if (!fromEl || !motion()) return Promise.resolve();
  const r = fromEl.getBoundingClientRect(); const b = root.getBoundingClientRect();
  const from = `inset(${r.top - b.top}px ${b.right - r.right}px ${b.bottom - r.bottom}px ${r.left - b.left}px round 10px)`;
  const frames = [{ clipPath: from, opacity: 0.5 }, { clipPath: 'inset(0 0 0 0 round 0)', opacity: 1 }];
  return panel.animate(reverse ? frames.reverse() : frames, { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' }).finished.catch(() => {});
}
async function closeCard() {
  if (!st.open) return;
  const slug = st.open.slug;
  const el = grid.querySelector(`[data-key="${CSS.escape(slug)}"]`);
  st.open = null;
  await grow(el, true);
  panel.hidden = true; panel.replaceChildren(); scroller.inert = false;
  scroller.scrollTop = st.scroll;
  el?.focus({ preventScroll: true });
}

async function refreshOpen() {
  const o = st.open; if (!o) return;
  if (panel.querySelector('.hm-ed.editing')) return;   // an edit in progress; its commit redraws
  try { o.detail = await call(`/api/workstreams/${enc(o.slug)}`); }
  catch (e) { panel.replaceChildren(h('div', { class: 'hm-x-load' }, ib('i-left', 'Back (Esc)', closeCard, { cls: 'hm-back' }), ` ${e.message}`)); return; }
  if (st.open !== o) return;
  if (changed.has(o.slug) || changed.has('*')) o.extra = {};
  changed.clear();
  drawOpen();
}

function drawOpen() {
  const o = st.open; const w = o.detail;
  const live = (w.sessions || []).map(id => ctx.byId(id)).filter(isLive);
  const statusSel = h('select', { class: 'hm-status', 'aria-label': 'Status', title: 'Status', onchange: (e) => commit({ status: e.target.value }, e.target) },
    ['active', 'paused', 'done', 'archived'].map(s => h('option', { value: s, selected: s === (w.status || 'active') }, s)));
  const n = tabCounts(w);
  panel.replaceChildren(
    h('header', { class: 'hm-x-h' },
      ib('i-left', 'Back to Home (Esc)', closeCard, { cls: 'hm-back', size: 14 }),
      editable('title', w.title, { tag: 'h2', single: true, cls: 'hm-x-t' }),
      h('span', { class: 'hm-badges' }, badges.map(fn => { try { return fn(w); } catch { return null; } })),
      live.length ? h('span', { class: 'hm-dots' }, live.map(s => { const sig = ctx.sigOf(s); return dot(s, sig, { big: sig === 'input' || sig === 'error' }); })) : null,
      h('span', { class: 'spacer' }),
      statusSel),
    editable('goal', w.goal, { cls: 'hm-x-goal', placeholder: 'The goal, in a line' }),
    h('nav', { class: 'tabs hm-tabs', role: 'tablist', 'aria-label': 'Workstream' }, TABS.map(([k, label]) =>
      h('button', { type: 'button', class: `tab-b${o.tab === k ? ' active' : ''}`, role: 'tab', 'aria-selected': String(o.tab === k), dataset: { tab: k },
        onclick: () => { o.tab = k; drawOpen(); } }, label, n[k] ? h('span', { class: 'count' }, n[k]) : null))),
    h('div', { class: 'hm-x-b', role: 'tabpanel' }));
  drawTab();
}
function tabCounts(w) {
  const notes = parseNotes(w.notes).length;
  return { sessions: sessionRows(w.sessions, w.records, ctx.byId).count || null, decisions: decisionGroups(w.decisions).active.length || null,
    files: w.files?.length || null, notes: notes || null, links: w.links?.length || null, vault: w.vault?.length || null };
}

function drawTab() {
  const o = st.open; if (!o?.detail) return;
  const body = panel.querySelector('.hm-x-b'); if (!body) return;
  if (body.querySelector('.hm-ed.editing')) return;
  const w = o.detail;
  const draw = { overview, sessions: sessionsTab, decisions: decisionsTab, files: filesTab, notes: notesTab, links: linksTab, vault: vaultTab }[o.tab];
  body.replaceChildren(...[].concat(draw(w, body)).filter(Boolean));
}

// ---- Overview: each field edits in place and commits on its own.
const SECTIONS = [['summary', 'Summary'], ['where', 'Where we are'], ['next', 'Next step'], ['questions', 'Open questions']];
function overview(w) {
  return [
    ...SECTIONS.map(([k, label]) => h('section', { class: 'hm-sec' }, h('h4', {}, label), editable(k, w[k], { md: true, placeholder: `Add ${label.toLowerCase()}` }))),
    h('section', { class: 'hm-sec' }, h('h4', {}, 'Pinned'), editable('pinned', (w.pinned || []).join(', '), { single: true, placeholder: 'Issues, a milestone: #12, v2, …',
      view: () => { const p = st.open?.detail?.pinned || []; return p.length ? h('div', { class: 'hm-prs' }, p.map(pinChip)) : null; } })),
    w.created ? h('p', { class: 'hm-meta muted' }, `Started ${new Date(w.created).toLocaleDateString()} · updated ${since(Date.parse(w.updated))} ago`) : null,
  ];
}
function pinChip(p) {
  const url = /^https?:\/\//.test(p) ? p : null;
  const num = /#(\d+)$/.exec(p)?.[1];
  return h(url ? 'a' : 'span', { class: 'hm-pr', href: url, target: url ? '_blank' : null, rel: url ? 'noopener' : null, title: p },
    svgUse(num || /\/(issues|pull)\//.test(p) ? (/\/pull\//.test(p) ? 'i-pr' : 'i-issue') : 'i-flag', 11), url ? (num ? `#${num}` : oneLine(p.replace(/^https?:\/\/(www\.)?/, ''), 32)) : p);
}

/**
 * A field shown as text; click (or Enter) turns it into an editor. Blur or
 * ⌘Enter (Enter on one-line fields) commits a PATCH; Esc puts it back.
 */
function editable(field, value, opts = {}) {
  const { tag = 'div', single = false, md = false, cls = '', placeholder = '', view = null } = opts;
  const text = value ?? '';
  const shown = view?.() || (text ? (md ? h('div', { class: 'md', html: markdown(text) }) : text) : h('span', { class: 'hm-ph' }, placeholder));
  const el = h(tag, { class: `hm-ed ${cls}`, tabindex: '0', role: 'button', title: 'Click to edit', dataset: { field },
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === el) { e.preventDefault(); begin(); } } }, shown);
  el.addEventListener('click', (e) => { if (e.target.closest('a')) return; begin(); });
  function begin() {
    if (el.classList.contains('editing')) return;
    el.classList.add('editing');
    const input = single ? h('input', { class: 'field', value: text, placeholder, 'aria-label': field })
      : h('textarea', { class: 'field', rows: Math.min(12, Math.max(2, text.split('\n').length + 1)), placeholder, 'aria-label': field }, text);
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = input.value;
      if (!save || v === text) { el.classList.remove('editing'); el.replaceChildren(shown); return; }
      input.disabled = true;
      const patchVal = field === 'pinned' ? v.split(',').map(x => x.trim()).filter(Boolean) : v;
      const ok = await commit({ [field]: patchVal }, el);
      el.classList.remove('editing');
      if (!ok) { el.replaceChildren(shown); return; }
      // Only this field redraws: another one may be open for editing.
      const d = st.open?.detail || {};
      const fresh = editable(field, field === 'pinned' ? (d.pinned || []).join(', ') : d[field], opts);
      el.replaceWith(fresh);
      fresh.classList.add('saved');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter' && (single || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(true));
    el.replaceChildren(input);
    input.focus();
    if (!single) input.setSelectionRange(input.value.length, input.value.length);
  }
  return el;
}
/** PATCH one change; the store commits it (one commit per edit). */
async function commit(patchBody, el) {
  const o = st.open; if (!o) return false;
  try {
    const r = await call(`/api/workstreams/${enc(o.slug)}`, 'PATCH', patchBody);
    if (st.open === o) o.detail = { ...o.detail, ...r.workstream, sessions: o.detail.sessions, live: o.detail.live };
    if (r.redactions?.length) toast(`Saved, with ${plural(r.redactions.length, 'secret')} redacted`);
    const i = st.list.findIndex(x => x.slug === o.slug);
    if (i >= 0) st.list[i] = { ...st.list[i], ...pick(r.workstream, ['title', 'status', 'updated', 'goal', 'next', 'pinned']) };
    if (el?.tagName === 'SELECT' && !panel.querySelector('.hm-ed.editing')) drawOpen();
    return true;
  } catch (e) { toast(`Save failed: ${e.message}`); return false; }
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));

// ---- Sessions: live ones on top, then the rest of the assigned, then wrap-up records.
function sessionsTab(w) {
  const { known, recordOf, records } = sessionRows(w.sessions, w.records, ctx.byId);
  if (!known.length && !records.length) return h('p', { class: 'hm-empty muted' }, 'No sessions yet. Assign one from the Unaffiliated card, or from a session’s header.');
  return h('ul', { class: 'hm-rows' },
    known.map(s => {
      const sig = isLive(s) ? ctx.sigOf(s) : 'ended'; const rec = recordOf.get(s.id);
      return h('li', { class: 'hm-row link', onclick: () => ctx.open(s.id), title: 'Open the session' },
        h('span', { class: `dot sig-${sig}`, title: SIG_LABEL[sig] }), ctx.backend(s),
        h('span', { class: 'hm-row-t' }, s.title, rec ? h('span', { class: 'hm-tagl', title: rec.file }, 'wrapped up') : null),
        s.pr?.url ? refChip({ kind: 'pr', ...s.pr }, null) : h('span', {}),
        h('span', { class: 'hm-ago', title: [s.startedAt ? `started ${when(s.startedAt)}` : null, `last ${when(s.mtime)}`].filter(Boolean).join('\n') }, isLive(s) ? 'live' : since(s.mtime)));
    }),
    records.map(r => h('li', { class: 'hm-row', title: r.file },
      h('span', { class: 'dot sig-ended' }), h('span', {}), h('span', { class: 'hm-row-t' }, r.title, h('span', { class: 'hm-tagl' }, 'wrap-up')), h('span', {}),
      h('span', { class: 'hm-ago' }, r.date || ''))));
}

// ---- Decisions: active first; superseded and reverted collapsed, kept.
function decisionsTab(w) {
  const g = decisionGroups(w.decisions);
  if (!g.active.length && !g.past.length) return h('p', { class: 'hm-empty muted' }, 'No decisions recorded yet. Star an event as a decision in a session; wrap-up collects them.');
  const row = (d) => h('li', { class: `hm-dec st-${d.status || 'active'}` },
    h('div', { class: 'hm-dec-h' }, h('span', { class: 'hm-num' }, String(d.n).padStart(4, '0')), h('b', {}, d.title),
      d.supersedes ? h('span', { class: 'muted', title: `Supersedes ${d.supersedes}` }, `↺ ${d.supersedes}`) : null,
      h('span', { class: 'spacer' }), sourceLink(d.source), h('span', { class: 'hm-ago' }, d.date || '')),
    d.body ? h('div', { class: 'md hm-dec-b', html: markdown(d.body) }) : null);
  return [h('ul', { class: 'hm-decs' }, g.active.map(row)),
    g.past.length ? h('details', { class: 'hm-past' }, h('summary', { class: 'muted' }, `${g.past.length} superseded or reverted`), h('ul', { class: 'hm-decs' }, g.past.map(row))) : null];
}
function sourceLink(src) {
  const s = parseSource(src);
  if (!s) return null;
  if (s.text) return h('span', { class: 'muted hm-src', title: s.text }, oneLine(s.text, 40));
  if (!s.session) return null;
  const known = ctx.byId(s.session);
  return h('button', { type: 'button', class: 'ib hm-src', title: `${known ? known.title : `Session ${s.session}`}${s.event ? ' · open the event' : ''}`, 'aria-label': 'Open the source',
    onclick: (e) => { e.stopPropagation(); ctx.open(s.session, s.event); } }, svgUse('i-link', 12));
}

// ---- Files: the record's starred files and live sessions' stars, by repo.
function filesTab(w, body) {
  const o = st.open;
  if (!o.extra.stars) {
    o.extra.stars = [];
    Promise.all((w.sessions || []).map(id => call(`/api/sessions/${enc(id)}/stars`).then(r => Object.entries(r.stars || {})
      .filter(([, v]) => v.kind === 'file').map(([path, v]) => { const cwd = ctx.byId(id)?.cwd || ''; return { path: relPath(path, cwd), repo: cwd, why: v.comment || '', source: { session: id }, live: true }; })).catch(() => [])))
      .then(lists => { if (st.open !== o) return; o.extra.stars = lists.flat(); if (o.tab === 'files') drawTab(); });
  }
  const seen = new Set(); const all = [];
  for (const f of [...(w.files || []), ...o.extra.stars]) { const k = `${f.repo}\0${f.path}`; if (!seen.has(k)) { seen.add(k); all.push(f); } }
  if (!all.length) return h('p', { class: 'hm-empty muted' }, 'No starred files yet. Star a file in a session’s Files tab.');
  return groupFiles(all).map(([repo, files]) => h('section', { class: 'hm-sec' }, h('h4', { title: repo }, repo ? basename(repo) || repo : 'Files'),
    h('ul', { class: 'hm-rows' }, files.map(f => {
      const abs = absPath(f);
      return h('li', { class: `hm-row file${abs ? ' link' : ''}`, onclick: abs ? () => openFile(abs, f.path) : null, title: abs || f.path },
        svgUse('i-file', 13), h('span', { class: 'hm-row-t mono' }, f.path),
        h('span', { class: 'hm-why muted' }, f.why || ''), sourceLink(f.source), h('span', { class: 'hm-ago' }, f.sha ? String(f.sha).slice(0, 7) : ''));
    }))));
}
const absPath = (f) => String(f.path || '').startsWith('/') ? f.path : String(f.repo || '').startsWith('/') ? `${f.repo.replace(/\/$/, '')}/${f.path}` : null;

/** Files open in the Vault's file dialog (vault.js): one file view, media included. */
const openFile = (abs, label) => vaultFile({ path: abs, rel: label }, null, { back: false });

// ---- Notes: dated, newest first, each with its source.
function notesTab(w) {
  const notes = parseNotes(w.notes);
  if (!notes.length) return h('p', { class: 'hm-empty muted' }, 'No notes yet.');
  return h('ul', { class: 'hm-notes' }, notes.map(n => h('li', {},
    h('span', { class: 'hm-ago' }, n.date || ''), h('span', { class: 'md', html: markdown(n.text) }), sourceLink(n.source))));
}

// ---- Links: PRs and issues with their state, and CI where #30's chips know it.
function linksTab(w) {
  const live = (w.sessions || []).map(id => ctx.byId(id)).filter(Boolean);
  const refs = [...(w.links || []).map(l => ({ kind: l.kind || 'pr', ...l })), ...prsOf({ links: [] }, live).filter(p => !(w.links || []).some(l => l.url === p.url))];
  if (!refs.length) return h('p', { class: 'hm-empty muted' }, 'No PRs or issues yet.');
  const ul = h('ul', { class: 'hm-rows' }, refs.map(r => h('li', { class: 'hm-row' }, refChip(r, null),
    h('span', { class: 'hm-row-t' }, r.title || r.repo || ''), h('span', { class: `hm-state st-${String(r.state || '').toLowerCase()}` }, String(r.state || '').toLowerCase()),
    r.ci ? h('span', { class: `hm-ci ci-${String(r.ci).toLowerCase()}`, title: `CI ${r.ci}` }, svgUse('i-ci', 12)) : h('span', {}))));
  chips().then(m => {
    if (!m?.miniChip) return;
    m.watchRefs?.(refs);
    ul.querySelectorAll(':scope > li').forEach((li, i) => li.firstChild.replaceWith(refChip(refs[i], m)));
  });
  return ul;
}

// ---- Vault: this workstream's local items: its <slug>/ area, and the record's pointers, each checked.
function vaultTab(w) {
  const o = st.open;
  if (!o.extra.vault) {
    o.extra.vault = { loading: true };
    call(`/api/home/vault/${enc(w.slug)}`).then(v => { if (st.open !== o) return; o.extra.vault = v; if (o.tab === 'vault') drawTab(); })
      .catch(e => { o.extra.vault = { error: e.message }; if (o.tab === 'vault' && st.open === o) drawTab(); });
  }
  const v = o.extra.vault;
  if (v.loading) return h('p', { class: 'hm-empty muted' }, 'Loading…');
  if (v.error) return h('p', { class: 'note err' }, `Vault: ${v.error}`);
  const pointed = new Set((v.pointers || []).map(p => p.path));
  const items = (v.items || []).filter(it => !pointed.has(it.rel));
  if (!items.length && !v.pointers?.length) return h('p', { class: 'hm-empty muted' }, 'Nothing in the Vault for this workstream.');
  const STATE = { missing: 'Not in this machine’s Vault', changed: 'Changed since it was recorded' };
  return h('ul', { class: 'hm-rows' },
    (v.pointers || []).map(p => h('li', { class: `hm-row file${p.state === 'missing' ? '' : ' link'}`, title: STATE[p.state] || p.path,
      onclick: p.state === 'missing' ? null : () => openFile(p.abs, p.path) },
      svgUse(p.state === 'missing' ? 'i-alert' : 'i-vault', 13), h('span', { class: `hm-row-t mono${p.state === 'missing' ? ' muted' : ''}` }, p.path),
      h('span', { class: 'hm-why muted' }, p.title || ''), h('span', { class: 'hm-ago' }, p.state === 'changed' ? 'changed' : ''), h('span', {}))),
    items.map(it => h('li', { class: 'hm-row file link', onclick: () => openFile(it.path, it.rel), title: it.meta?.title || it.rel },
      svgUse('i-vault', 13), h('span', { class: 'hm-row-t mono' }, it.rel), h('span', { class: 'hm-why muted' }, it.meta?.title || ''), h('span', {}),
      h('span', { class: 'hm-ago' }, since(it.meta?.savedAt ? Date.parse(it.meta.savedAt) : it.mtime)))),
    v.truncated ? h('li', { class: 'hm-empty muted' }, `The first ${items.length} of this workstream’s Vault folder.`) : null);
}
