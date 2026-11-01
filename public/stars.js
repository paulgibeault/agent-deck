// public/stars.js — stars and tags on events and files (lib/stars.mjs keeps
// them). A ☆ shows on hover, ★ (or the tag's glyph) once tagged; right-click or
// long-press opens the tag menu; `s` stars the selected row, `S` opens its menu.
// Agent text with decision language gets a faint ☆ as a candidate (said.js).
import { h, svgUse, oneLine, rowHooks } from './events.js';
import { toolCommand } from './classify.js';
import { menuItem } from './menu.js';
import { eventCue } from './said.js';

export const TAGS = {
  star:     { icon: 'i-star-5', label: 'Starred' },
  decision: { icon: 'i-check', label: 'Decision' },
  note:     { icon: 'i-pencil', label: 'Note' },
  question: { icon: 'i-q',     label: 'Open question' },
  vault:    { icon: 'i-vault', label: 'Save to Vault', files: true },
};

const enc = encodeURIComponent;
const EMPTY = Object.freeze(new Map()); // what an unloaded session reads; never written
const RETRY_MS = 5000;

/**
 * The page's copy of the stars. One Map per session for the page's life; the
 * first read loads it, and what changed here meanwhile (a save, a live event)
 * wins over the GET. Saves are optimistic and chained per item, and a reply or
 * a rollback lands only if nothing newer happened to that item since.
 * `request(method, path, body)` resolves to the JSON reply or throws;
 * `onChange(sessionId, keys)` gets null for keys when the whole session changed.
 */
export class StarStore {
  constructor(request, onChange = () => {}) {
    this.request = request; this.onChange = onChange;
    this.maps = new Map();      // sessionId → Map(key → star)
    this.loaded = new Set();
    this.loading = new Map();   // sessionId → keys changed while its GET is out
    this.failedAt = new Map();  // a failed load is retried on a later read, not cached
    this.seq = new Map();       // item → number of its newest local change
    this.confirmed = new Map(); // item → the server's star (or null), for rollbacks
    this.chain = new Map();     // item → its last request, so requests go in order
    this.inflight = new Map();  // item → requests not yet answered
  }

  get(sid, key) {
    if (!sid) return null;
    this.ensure(sid);
    return (this.maps.get(sid) || EMPTY).get(key) || null;
  }
  ensure(sid) {
    if (this.loaded.has(sid) || this.loading.has(sid) || Date.now() - (this.failedAt.get(sid) || 0) < RETRY_MS) return;
    this.load(sid);
  }
  async load(sid) {
    const touched = new Set(); this.loading.set(sid, touched);
    const map = this._map(sid); // from the start, so saves and live events made meanwhile land in it
    let all;
    try { all = (await this.request('GET', `/api/sessions/${enc(sid)}/stars`)).stars || {}; }
    catch { this.loading.delete(sid); this.failedAt.set(sid, Date.now()); return; }
    this.loading.delete(sid); this.failedAt.delete(sid); this.loaded.add(sid);
    for (const key of [...map.keys()]) if (!touched.has(key) && !Object.hasOwn(all, key)) map.delete(key);
    for (const [key, star] of Object.entries(all)) {
      if (!this.inflight.get(this._id(sid, key))) this.confirmed.set(this._id(sid, key), star);
      if (!touched.has(key)) map.set(key, star);
    }
    this.onChange(sid, null);
  }
  /** After a reconnect: what was loaded loads again, in case changes were missed. */
  reset() {
    this.failedAt.clear();
    const sids = [...this.loaded]; this.loaded.clear();
    for (const sid of sids) this.load(sid);
  }

  /** A `stars.changed` from the server. Ignored while our own request for the item is out: its reply decides. */
  applyRemote({ sessionId: sid, key, star }) {
    const map = this.maps.get(sid); if (!map) return; // loads in full when first read
    const id = this._id(sid, key);
    this.confirmed.set(id, star || null);
    if (this.inflight.get(id)) return;
    this.loading.get(sid)?.add(key);
    star ? map.set(key, star) : map.delete(key);
    this.onChange(sid, [key]);
  }

  /** Star or re-tag (`patch` { tag, comment }), or unstar (null). `item` { kind, ts, excerpt() }. */
  save(sid, key, patch, { kind, ts, excerpt } = {}) {
    const id = this._id(sid, key);
    const n = (this.seq.get(id) || 0) + 1; this.seq.set(id, n);
    const map = this._map(sid);
    const cur = map.get(key);
    patch ? map.set(key, { ...cur, ...patch, at: new Date().toISOString() }) : map.delete(key);
    this.loading.get(sid)?.add(key);
    this.onChange(sid, [key]);
    this.ensure(sid);
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1);
    const url = `/api/sessions/${enc(sid)}/stars/${enc(key)}`;
    const send = () => {
      // The excerpt goes only with a first star: a re-tag keeps the one saved.
      const had = this.confirmed.has(id) ? this.confirmed.get(id) : cur;
      return patch ? this.request('PUT', url, { ...patch, kind, ts: ts || undefined, excerpt: had ? undefined : excerpt?.() }) : this.request('DELETE', url);
    };
    const settle = (fn) => { if (this.seq.get(id) === n) { fn(); this.onChange(sid, [key]); } };
    const p = (this.chain.get(id) || Promise.resolve()).then(send).then(
      (r) => { const v = patch ? r.star : null; this.confirmed.set(id, v); settle(() => v ? map.set(key, v) : map.delete(key)); },
      (e) => { const c = this.confirmed.get(id); settle(() => c ? map.set(key, c) : map.delete(key)); console.warn('agent-deck: star not saved:', e.message); },
    ).finally(() => { this.inflight.set(id, this.inflight.get(id) - 1); if (this.chain.get(id) === p) this.chain.delete(id); });
    this.chain.set(id, p);
    return p;
  }

  _id(sid, key) { return `${sid}\n${key}`; }
  _map(sid) { if (!this.maps.has(sid)) this.maps.set(sid, new Map()); return this.maps.get(sid); }
}

async function request(method, path, body) {
  const r = await fetch(path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}

const listeners = new Set();
// One repaint pass and one notice per change or load.
const store = new StarStore(request, (sid, keys) => {
  if (typeof document !== 'undefined') {
    const sel = `.stb[data-sid="${CSS.escape(sid)}"]`;
    const btns = keys ? keys.flatMap(k => [...document.querySelectorAll(`${sel}[data-key="${CSS.escape(k)}"]`)]) : document.querySelectorAll(sel);
    for (const b of btns) paint(b);
  }
  for (const fn of listeners) fn(sid);
});

/** Called once per change (here or elsewhere), or per session load: `fn(sessionId)`. */
export function onStarsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** The star on an item, or null (loading the session's stars if need be). */
export const starOf = (sid, key) => store.get(sid, key);
/** A `stars.changed` event from the server (any tab or device). */
export const applyStarsChanged = (d) => store.applyRemote(d);
/** The event stream (re)connected: reload what was loaded. */
export const starsReconnect = () => store.reset();
const save = (spec, patch) => store.save(spec.sid, spec.key, patch, spec);

function paint(btn) {
  const spec = btn._spec; const star = starOf(spec.sid, spec.key);
  const tag = star && (TAGS[star.tag] || TAGS.star);
  const cue = !star && spec.cue;
  btn.classList.toggle('on', !!star);
  btn.classList.toggle('cand', !!cue);
  btn.querySelector('use').setAttribute('href', '#' + (tag ? tag.icon : 'i-star-5'));
  const tip = star ? `${tag.label}${star.comment ? ': ' + star.comment : ''} (right-click to change)`
    : cue ? `Possible decision: “${cue.sentence}” (click to keep it as a decision)` : 'Star (s) · right-click to tag';
  btn.title = tip; btn.setAttribute('aria-label', tip); btn.setAttribute('aria-pressed', String(!!star));
}

/**
 * The star button for one item. `spec`: { sid, key, kind: 'event' | 'file',
 * excerpt: () => text kept with the star, ts?, cue? }.
 */
export function starBtn(spec) {
  const btn = h('button', { type: 'button', class: 'stb', dataset: { sid: spec.sid, key: spec.key } }, svgUse('i-star-5', 12));
  btn._spec = spec;
  paint(btn);
  let pressed = null, longed = false;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (longed) { longed = false; return; }
    starOf(spec.sid, spec.key) ? save(spec, null) : save(spec, { tag: spec.cue ? 'decision' : 'star' });
  });
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // a file row opens its editor on double-click
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(btn); });
  // Long-press, for touch screens.
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    clearTimeout(pressed); pressed = setTimeout(() => { longed = true; openMenu(btn); }, 480);
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(t, () => clearTimeout(pressed));
  return btn;
}

// ------------------------------------------------------------ the tag menu
let pop = null;
function openMenu(btn) {
  const spec = btn._spec; const star = starOf(spec.sid, spec.key);
  if (!pop) { pop = h('div', { class: 'menu-pop star-pop', popover: '', role: 'menu', 'aria-label': 'Tag' }); document.body.append(pop); }
  const why = h('input', { type: 'text', class: 'star-why', placeholder: 'Why (optional)', maxlength: '300', spellcheck: 'false', 'aria-label': 'Why (optional)' });
  why.value = star?.comment || '';
  const tagAs = (tag) => save(spec, { tag, comment: why.value.trim() });
  why.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tagAs(star?.tag || (spec.cue ? 'decision' : 'star')); pop.hidePopover(); }
  });
  const excerpt = star?.excerpt || spec.excerpt?.() || spec.key;
  pop.replaceChildren(...[
    h('div', { class: 'mm-note star-ex', title: excerpt }, oneLine(excerpt, 90)),
    ...Object.entries(TAGS).filter(([, t]) => !t.files || spec.kind === 'file')
      .map(([k, t]) => menuItem(svgUse(t.icon, 13), t.label, () => tagAs(k), { checked: star?.tag === k })),
    h('div', { class: 'star-why-w' }, why),
    star ? h('hr') : null,
    star ? menuItem(svgUse('i-x', 13), 'Unstar', () => save(spec, null), { cls: 'danger' }) : null,
  ].filter(Boolean));
  pop.showPopover();
  const r = btn.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - 8, innerWidth - pop.offsetWidth - 8))}px`;
  pop.querySelector('.mm-i')?.focus();
}

// ------------------------------------------------------------ hooks
/** What a star keeps of an event: its text, or a tool call's name, command and some output. */
export function eventExcerpt(ev) {
  if (ev.kind === 'tool') {
    const t = ev.tool; const cmd = toolCommand(t);
    return [`${t.display || t.name} ${t.summary || ''}`.trim(), cmd != null && cmd !== t.summary ? cmd : null, t.result?.text ? String(t.result.text).slice(0, 1200) : null].filter(Boolean).join('\n');
  }
  return [ev.text, ev.error].filter(Boolean).join('\n') || ev.subtype || ev.kind;
}

// Every event row (events.js renderRow) gets a star in front of it.
rowHooks.push((row, ev) => {
  if (ev.kind === 'turn_end' || String(ev.id).startsWith('loading:') || !ev.sessionId) return;
  row.append(starBtn({ sid: ev.sessionId, key: ev.id, kind: 'event', ts: ev.ts, cue: eventCue(ev), excerpt: () => eventExcerpt(ev) }));
});

/** The star for a file row (Files, Changes); `path` is absolute, `label` what the excerpt keeps. */
export const fileStar = (sid, path, label = path) => sid && path ? starBtn({ sid, key: path, kind: 'file', excerpt: () => label }) : null;

// `s` stars the selected row in the open tab; `S` opens its tag menu.
if (typeof document !== 'undefined') document.addEventListener('keydown', (e) => {
  if ((e.key !== 's' && e.key !== 'S') || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (document.querySelector('dialog[open], [popover]:popover-open')) return;
  const btn = document.querySelector('.tab.active')?.querySelector('.row.selected .stb, .frow.sel .stb, .ct-file.sel .stb, tr.selected .stb');
  if (!btn) return;
  e.preventDefault();
  e.key === 'S' ? openMenu(btn) : btn.click();
});
