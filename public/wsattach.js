// public/wsattach.js — sessions in workstreams (#35), in the page: the
// Workstream section of the New session dialog (with the briefing preview),
// the header's workstream chip (or the Assign glyph), and the rail's filter by
// workstream. Registers itself; app.js imports it, forwards workstreams.changed
// and asks railFilter() which sessions to show. The picker is wspicker.js.
import { h, svgUse, ib } from './events.js';
import { registerLaunchSection } from './launch.js';
import { registerHeaderSlot } from './header.js';
import { openWorkstreamPicker, loadWorkstreams, onWorkstreamsChange, launchChoice } from './wspicker.js';

const nameOf = (ws) => typeof ws === 'string' ? ws : ws?.title || ws?.slug || ws?.name || ws?.id || '';
// Whether any workstream exists, so nothing here shows before workstreams are set up.
let known = { ready: false, any: false };
const redraws = new Set();
function refresh() {
  return loadWorkstreams().then(d => {
    const was = `${known.ready}|${known.any}`;
    known = { ready: !!d.sync?.ready, any: !!d.workstreams?.length };
    if (was !== `${known.ready}|${known.any}`) for (const fn of redraws) fn();
  }).catch(() => {});
}
refresh();
onWorkstreamsChange(() => refresh());

async function getJson(path) {
  const r = await fetch(path);
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}

// ------------------------------------------------------------ New session dialog
// A Workstream row above the prompt; once one is picked, "Brief the agent"
// (on when the workstream has a summary) and the briefing itself, folded,
// editable, with its size: exactly what goes after the first prompt.
let launch = null;   // this dialog's choice, while it is open
registerLaunchSection({
  slot: 'prompt',
  async open(el, ctx) {
    launch = null;
    // The selected session's workstream, from its summary (app.js passes it), otherwise None.
    const dflt = ctx.workstream?.slug ? { slug: ctx.workstream.slug, title: nameOf(ctx.workstream) } : null;
    if (!known.ready) await refresh();
    if (!known.ready) return;   // renders nothing: no space taken
    const choice = launchChoice();
    const sec = launch = { choice, max: null };
    const btn = h('button', { type: 'button', class: 'ns-ws-b', 'aria-haspopup': 'dialog' });
    const brief = h('input', { type: 'checkbox', id: 'ns-ws-brief' });
    const size = h('span', { class: 'muted ns-ws-n' });
    const text = h('textarea', { class: 'field ns-ws-t', rows: '9', spellcheck: 'false', 'aria-label': 'Briefing (sent after your prompt)' });
    const fold = h('details', { class: 'ns-ws-p' }, h('summary', { title: 'What the agent gets after your prompt, as context; edit it here' }, 'Briefing, after your prompt', size), text);
    const opts = h('span', { class: 'ns-ws-o' }, h('label', { class: 'ns-ws-c', title: 'Put the workstream’s goal, where it stands, the next step, active decisions and pinned items after your first prompt, as context' }, brief, 'Brief the agent'));
    const row = h('div', { class: 'ns-ws' }, h('span', { class: 'ns-ws-l' }, 'Workstream'), btn, opts);
    el.replaceChildren(row, fold);
    sec.brief = brief; sec.text = text;

    const tokens = (n) => Math.ceil(n / 4);
    const showSize = () => {
      size.textContent = `≈${tokens(text.value.length)} tokens`;
      size.title = sec.max ? `about ${tokens(text.value.length)} of ${tokens(sec.max)} tokens (4 characters each)` : '';
      size.classList.toggle('over', !!sec.max && text.value.length > sec.max);
    };
    const showBrief = () => { const ws = choice.get(); opts.hidden = !ws; fold.hidden = !ws || !brief.checked; };
    text.addEventListener('input', showSize);
    brief.addEventListener('change', showBrief);

    let seq = 0;   // only the latest choice fills the briefing
    async function show(ws) {
      const my = ++seq;
      btn.replaceChildren(svgUse('i-workstream', 13), h('span', {}, ws ? nameOf(ws) : 'None'));
      btn.title = ws ? `${nameOf(ws)} · click to change` : 'Not in a workstream · click to pick one';
      btn.classList.toggle('none', !ws);
      text.value = ''; brief.checked = false; sec.max = null;
      showBrief();
      if (!ws) return;
      try {
        const b = await getJson(`/api/workstreams/${encodeURIComponent(ws.slug)}/briefing`);
        if (my !== seq) return;   // picked another meanwhile
        sec.max = b.max || null;
        if (sec.max) text.maxLength = sec.max;
        text.value = b.text;
        brief.checked = !!b.summary;
        showSize();
      } catch (e) { console.error('briefing:', e); }
      showBrief();
    }
    btn.onclick = () => openWorkstreamPicker(btn, { current: choice.get()?.slug ?? null, onPick: (ws) => show(choice.pick(ws)) });
    show(choice.default(dflt));
  },
  collect() {
    const sec = launch;
    const ws = sec?.choice.get();
    if (!ws) return null;
    const text = sec.brief.checked ? sec.text.value.trim() : '';
    if (sec.max && text.length > sec.max) throw new Error('The briefing is over its size cap; shorten it or leave it out.');
    return { workstream: ws.slug, brief: text || false };
  },
});

// ------------------------------------------------------------ header
// The chip names the session's workstream and opens it on Home (#33), or the
// picker when there is no Home; the chevron beside it (on hover) or a
// right-click changes it. A session in none gets a bare glyph to assign one.
// A subagent shows its parent's, read-only.
let home;   // home.js, looked for once: the module, or null when there is none
const homeModule = () => (home ??= import('./home.js').catch(() => null));

registerHeaderSlot('workstream', (ctx) => {
  const { s, isAgent } = ctx;
  if (ctx.act.refresh) redraws.add(ctx.act.refresh);   // the same function each time (app.js renderHeader)
  if (isAgent) {
    const ws = s.workstream || ctx.session(s.parentId)?.workstream;
    return ws ? h('span', { class: 'sh-ws', title: `Workstream ${nameOf(ws)} (its parent session’s)` }, svgUse('i-workstream', 13), h('span', {}, nameOf(ws))) : null;
  }
  const ws = s.workstream;
  const pick = (anchor) => openWorkstreamPicker(anchor, {
    sessionId: ctx.id, current: ws?.slug ?? null,
    // Shown at once; the next snapshot says the same.
    onPick: (w) => { s.workstream = w; ctx.act.refresh?.(); },
  });
  if (!ws) return known.ready ? ib('i-workstream', 'Assign workstream', (e) => pick(e.currentTarget), { cls: 'sh-ws-add', size: 13, 'aria-haspopup': 'dialog' }) : null;
  const open = async (e) => {
    const anchor = e.currentTarget;
    const m = await homeModule();
    if (m?.openWorkstream) m.openWorkstream(ws.slug); else pick(anchor);
  };
  const change = (e) => { e.preventDefault(); pick(e.currentTarget.closest('.sh-ws-w') || e.currentTarget); };
  return h('span', { class: 'sh-ws-w' },
    h('button', { type: 'button', class: 'sh-ws', title: `Workstream ${nameOf(ws)}\nClick to open it · right-click to change`, onclick: open, oncontextmenu: change },
      svgUse('i-workstream', 13), h('span', {}, nameOf(ws))),
    ib('i-down', 'Change workstream', change, { cls: 'sh-ws-more', size: 10, 'aria-haspopup': 'dialog' }));
}, { replace: true });

// ------------------------------------------------------------ rail filter
// A glyph in the rail's search field: show only the sessions in one workstream.
// Filtering, not grouping; it lasts until changed (or the page reloads).
let filter = null;   // { slug, title } or null
let redrawRail = () => {};
const railBtn = h('button', { type: 'button', class: 'ib rail-ws', 'aria-haspopup': 'dialog', hidden: true });
function drawRailBtn() {
  railBtn.hidden = !known.any && !filter;
  railBtn.replaceChildren(svgUse('i-workstream', 13));
  railBtn.setAttribute('aria-pressed', String(!!filter));
  const tip = filter ? `Showing only workstream ${filter.title} · click to change` : 'Filter by workstream';
  railBtn.title = tip; railBtn.setAttribute('aria-label', tip);
}
railBtn.onclick = () => openWorkstreamPicker(railBtn, { current: filter?.slug ?? null, none: 'All sessions', create: false,
  onPick: (ws) => { filter = ws; drawRailBtn(); redrawRail(); } });
redraws.add(drawRailBtn);
drawRailBtn();
document.getElementById('tree-filter')?.after(railBtn);

/** app.js: the rail shows a session only if this says so; `redraw` redraws the rail when the filter changes. */
export function railFilter(redraw) {
  if (redraw) redrawRail = redraw;
  return (s) => !filter || s.workstream?.slug === filter.slug;
}
