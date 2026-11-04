// public/wsdock.js — the selected session's workstream, in the rail's spare
// room under the session list: its next step, open questions, active
// decisions, links, and the other sessions on it. Read from the workstream
// repo (GET /api/workstreams/:slug, a local read, no model call) when the
// selection or the workstream changes; never on a clock.
import { h, svgUse, oneLine } from './events.js';
import { decisionGroups } from './homemodel.js';
import { miniChip } from './ghchips.js';

let ctx = null;          // { api, byId, sigOf, open, openWorkstream }
let el = null;
let want = null;         // slug the dock should show
let shown = null;        // { slug, updated, sel } last drawn
const cache = new Map(); // slug -> workstream

export function initWsDock(c) {
  ctx = c;
  el = document.getElementById('ws-dock');
}

/** The selected session changed, or what is known about its workstream did. */
export function wsDockShow(s, { reload = false } = {}) {
  if (!el) return;
  const ws = s ? (s.parentId ? ctx.byId(s.parentId) : s)?.workstream : null;
  want = ws?.slug || null;
  if (!want) { el.hidden = true; el.replaceChildren(); shown = null; return; }
  const have = cache.get(want);
  if (have && !reload) { draw(have, s); return; }
  const slug = want;
  ctx.api.get(`/api/workstreams/${encodeURIComponent(slug)}`).then(w => {
    cache.set(slug, w);
    if (want === slug) draw(w, s);
  }).catch(() => { if (want === slug && !have) el.hidden = true; });
}

/** A workstream changed on disk: drop its copy so the next look reads it again. */
export function wsDockChanged(e, s) {
  if (e?.slug) cache.delete(e.slug); else cache.clear();
  if (e?.was) cache.delete(e.was);
  wsDockShow(s, { reload: true });
}

const bullets = (md) => String(md || '').split('\n').map(l => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim()).filter(Boolean);

function sec(icon, label, ...body) {
  return h('section', { class: 'wd-s' }, h('h4', {}, svgUse(icon, 11), label), ...body);
}

function draw(w, s) {
  const key = JSON.stringify([w.slug, w.updated, s?.id, (w.sessions || []).map(id => ctx.byId(id)?.status)]);
  if (shown === key) { el.hidden = false; return; }
  shown = key;
  const out = [];
  out.push(h('button', { type: 'button', class: 'wd-h', title: `Open the workstream ${w.title} on Home`, onclick: () => ctx.openWorkstream(w.slug) },
    svgUse('i-workstream', 13), h('span', {}, w.title || w.slug), w.status && w.status !== 'active' ? h('span', { class: 'wd-st' }, w.status) : null));
  if (w.next) out.push(h('p', { class: 'wd-next', title: `Next step: ${w.next}` }, svgUse('i-right', 11), h('span', {}, w.next)));
  const qs = bullets(w.questions);
  if (qs.length) out.push(sec('i-q', 'Open questions', h('ul', {}, ...qs.slice(0, 4).map(q => h('li', { title: q }, oneLine(q, 220)))),
    qs.length > 4 ? h('p', { class: 'wd-more' }, `+${qs.length - 4} more`) : null));
  const { active } = decisionGroups(w.decisions);
  if (active.length) out.push(sec('i-check', 'Decisions', h('ol', {}, ...active.slice(0, 5).map(d =>
    h('li', { title: d.body ? oneLine(d.body, 400) : d.title }, h('span', { class: 'wd-n' }, String(d.n).padStart(4, '0')), h('span', {}, d.title)))),
    active.length > 5 ? h('p', { class: 'wd-more' }, `+${active.length - 5} more`) : null));
  const others = (w.sessions || []).filter(id => id !== s?.id).map(id => ctx.byId(id)).filter(Boolean)
    .sort((a, b) => (b.alive === true) - (a.alive === true) || (b.mtime || 0) - (a.mtime || 0));
  if (others.length) out.push(sec('i-sessions', 'Other sessions', h('ul', { class: 'wd-ss' }, ...others.slice(0, 6).map(o =>
    h('li', {}, h('button', { type: 'button', onclick: () => ctx.open(o.id), title: [o.title, o.project, o.gitBranch].filter(Boolean).join(' · ') },
      h('span', { class: `dot sig-${o.alive ? ctx.sigOf(o) : 'ended'}` }), h('span', {}, o.title || o.id)))))));
  const prs = (w.links || []).filter(l => l.kind === 'pr' || l.kind === 'issue').slice(0, 6);
  if (prs.length) out.push(h('div', { class: 'wd-links' }, ...prs.map(l => miniChip(l))));
  el.replaceChildren(...out);
  el.hidden = false;
}
