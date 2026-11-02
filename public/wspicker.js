// public/wspicker.js — the workstream picker (#35), one popover shared by the
// New session dialog, the header and Home (#33): type to search, active and
// recently updated first, None, and "+ New workstream" (a name and a one-line
// goal) inline.
//   openWorkstreamPicker(anchorEl, {
//     sessionId,       // assign the pick to this session (POST /api/sessions/:id/workstream) before onPick
//     onPick(ws),      // ws = { slug, title } or null for None
//     current,         // the slug to mark; with a sessionId and no current, the session's own is looked up
//     none: true,      // offer None (a string relabels it, e.g. "All sessions" for a filter)
//     create: true,    // offer "+ New workstream"
//   }) → close()
// Enter picks only a highlighted match; None and "+ New" take an arrow or a click.
// rankWorkstreams, the key handling and launchChoice have no DOM, so the tests check them.
import { h, svgUse } from './events.js';

const STATUS_RANK = { active: 0, paused: 1, done: 2, archived: 3 };
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const hay = (w) => `${w.title || ''} ${w.slug || ''}`.toLowerCase();

/**
 * The list as the picker shows it. No query: archived ones are left out, the
 * rest go active first, then paused and done, the most recently updated first
 * within each. A query matches every word against title and slug; titles that
 * start with it come first, then a word that does, then the rest, each in the
 * order above. Archived ones show only when searched for.
 */
export function rankWorkstreams(list, q = '') {
  const ws = words(q);
  const t = ws.join(' ');
  const hit = (w) => ws.every(x => hay(w).includes(x));
  const score = (w) => {
    if (!t) return 0;
    if (String(w.title || '').toLowerCase().startsWith(t)) return 0;
    return hay(w).split(/[^\p{L}\p{N}]+/u).some(x => x.startsWith(ws[0])) ? 1 : 2;
  };
  return (list || []).filter(w => ws.length ? hit(w) : w.status !== 'archived')
    .map(w => [score(w), w])
    .sort(([sa, a], [sb, b]) => sa - sb || (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
      || String(b.updated || '').localeCompare(String(a.updated || '')))
    .map(([, w]) => w);
}

// ------------------------------------------------------------ keys
// The highlight lives in the search box (focus stays there). It starts on the
// first real match, or on nothing when there is none (or the list has not
// loaded), so Enter never picks None or "+ New" by default: those take an
// arrow or a click. -1 is "nothing highlighted".
/** Where the highlight starts, given how many real matches show. */
export const initialActive = (matches) => matches > 0 ? 0 : -1;
/** The highlight after an arrow: `dir` is 1 or -1 over `total` rows; up from the first goes back to nothing. */
export function moveActive(active, dir, total) {
  if (total <= 0) return -1;
  if (dir > 0) return active < 0 ? 0 : (active + 1) % total;
  return active <= 0 ? -1 : active - 1;
}

/**
 * The launch dialog's choice: the default (the selected session's workstream)
 * applies only until the pilot picks, so a late default never undoes a pick.
 */
export function launchChoice() {
  let picked = false;
  let ws = null;
  return {
    get: () => ws,
    picked: () => picked,
    default(w) { if (!picked) ws = w || null; return ws; },
    pick(w) { picked = true; ws = w || null; return ws; },
  };
}

// ------------------------------------------------------------ data
async function call(path, method = 'GET', body) {
  const r = await fetch(path, body !== undefined ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
  let out = null; try { out = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}

let cache = null;   // a promise of { sync, workstreams }, until something changes
/** GET /api/workstreams, shared until a workstreams.changed (workstreamsChanged) drops it. */
export function loadWorkstreams() {
  cache ||= call('/api/workstreams').catch((e) => { cache = null; throw e; });
  return cache;
}
const listeners = new Set();
/** app.js calls this on the SSE event; whoever drew from the list redraws. */
export function workstreamsChanged(e) { cache = null; for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } } }
export function onWorkstreamsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Assign (or with null, unassign) a session. */
export const assignWorkstream = (sessionId, slug) => call(`/api/sessions/${encodeURIComponent(sessionId)}/workstream`, 'POST', { slug });
export const createWorkstream = (title, goal) => call('/api/workstreams', 'POST', { title, goal });

// ------------------------------------------------------------ the popover
let pop = null;
export function openWorkstreamPicker(anchor, { sessionId = null, onPick = () => {}, current, none = true, create = true } = {}) {
  pop?.remove();
  // Inside a modal dialog it has to be in the dialog, or the dialog makes it inert.
  const host = anchor.closest('dialog[open]') || document.body;
  const el = h('div', { class: 'menu-pop wsp', popover: '', role: 'dialog', 'aria-label': 'Workstream' });
  pop = el;
  let list = [];
  let marked = current;
  let form = null;   // the "+ New" form, while open
  let active = -1;   // the highlighted row (moveActive)
  let matches = 0;

  const q = h('input', { type: 'search', placeholder: 'Find a workstream', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Find a workstream' });
  const rows = h('div', { class: 'wsp-list', role: 'listbox' });
  const foot = h('div', { class: 'wsp-foot' });
  const note = h('div', { class: 'mm-note crit', hidden: true });
  el.append(h('label', { class: 'search wsp-q' }, svgUse('i-search', 13), q), rows, foot, note);

  const close = () => { if (el.matches(':popover-open')) el.hidePopover(); };
  el.addEventListener('toggle', (e) => { if (e.newState === 'closed') { el.remove(); if (pop === el) pop = null; } });
  const fail = (e) => { note.textContent = e.message; note.hidden = false; };

  async function pick(ws) {
    try {
      if (sessionId) await assignWorkstream(sessionId, ws?.slug ?? null);
      close();
      onPick(ws ? { slug: ws.slug, title: ws.title } : null);
    } catch (e) { fail(e); }
  }

  const row = (label, ws, { icon = 'i-workstream', tip = null, cls = '' } = {}) => {
    const on = (ws?.slug ?? null) === (marked ?? null);
    return h('button', { type: 'button', class: `mm-i wsp-i${cls ? ' ' + cls : ''}`, role: 'option', 'aria-selected': String(on), title: tip, onclick: () => pick(ws) },
      h('span', { class: 'mm-ic' }, svgUse(icon, 13)), h('span', { class: 'mm-t' }, label),
      ws && ws.status && ws.status !== 'active' ? h('span', { class: 'wsp-st muted' }, ws.status) : null,
      on ? h('span', { class: 'mm-chk' }, svgUse('i-check', 12)) : null);
  };
  const tipOf = (w) => [w.title, w.status, w.live ? `${w.live} live` : null, w.sessions ? `${w.sessions} session${w.sessions === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');

  const items = () => [...el.querySelectorAll('.wsp-i, .wsp-new')];
  function highlight() {
    items().forEach((b, i) => b.classList.toggle('hl', i === active));
    items()[active]?.scrollIntoView({ block: 'nearest' });
  }
  function draw() {
    const shown = rankWorkstreams(list, q.value);
    matches = shown.length;
    active = initialActive(matches);
    rows.replaceChildren(...shown.map(w => row(w.title || w.slug, w, { tip: tipOf(w) })));
    if (!shown.length) rows.append(h('div', { class: 'mm-note' }, list.length ? 'No match' : 'No workstreams yet'));
    foot.replaceChildren();
    if (none) foot.append(row(typeof none === 'string' ? none : 'None', null, { icon: 'i-x', cls: 'wsp-none' }));
    if (create) foot.append(form || h('button', { type: 'button', class: 'mm-i wsp-new', onclick: () => openForm() },
      h('span', { class: 'mm-ic' }, svgUse('i-plus', 12)), h('span', { class: 'mm-t' }, 'New workstream')));
    highlight();
  }

  function openForm() {
    const name = h('input', { class: 'field', type: 'text', placeholder: 'Name', value: q.value.trim(), maxlength: '120', 'aria-label': 'Workstream name' });
    const goal = h('input', { class: 'field', type: 'text', placeholder: 'Goal, in one line', maxlength: '300', 'aria-label': 'Goal' });
    const go = h('button', { type: 'submit', class: 'btn primary sm' }, 'Create');
    form = h('form', { class: 'wsp-form', onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      go.disabled = true;
      try {
        const r = await createWorkstream(name.value.trim(), goal.value.trim());
        workstreamsChanged({ reason: 'create', slug: r.workstream.slug });
        await pick({ slug: r.workstream.slug, title: r.workstream.title });
      } catch (err) { go.disabled = false; fail(err); }
    } }, name, goal, h('div', { class: 'wsp-fa' }, h('button', { type: 'button', class: 'btn sm', onclick: () => { form = null; draw(); q.focus(); } }, 'Cancel'), go));
    draw();
    name.focus();
  }

  q.addEventListener('input', () => draw());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus?.(); return; }
    if (e.target.closest('.wsp-form')) return;
    // Enter picks only what is highlighted; with nothing highlighted it does nothing.
    if (e.key === 'Enter' && e.target === q) { e.preventDefault(); if (active >= 0) items()[active]?.click(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    active = moveActive(active, e.key === 'ArrowDown' ? 1 : -1, items().length);
    highlight();
    q.focus();
  });

  host.append(el);
  draw();
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.min(r.bottom + 6, innerHeight - 200)}px`;
  el.showPopover();
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left - 4))}px`;
  q.focus();

  // The list, and the session's own workstream when the caller did not say.
  Promise.all([loadWorkstreams(), sessionId && current === undefined ? call(`/api/sessions/${encodeURIComponent(sessionId)}/workstream`).catch(() => null) : null])
    .then(([d, mine]) => {
      list = d.workstreams || [];
      if (mine) marked = mine.slug;
      if (!d.sync?.ready) { create = false; fail(new Error('Workstreams are not set up yet')); }
      if (pop === el) draw();
    }).catch(fail);
  return close;
}
