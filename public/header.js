// public/header.js — the session header: one row, built from named slots so
// each feature fills its own. Left to right: workstream · title · repo · place
// · refs, then the actions on the right. A slot with nothing renders nothing.
// app.js keeps the state and passes what the header needs in a context
// (see headerCtx there); renderers read it and never reach into app.js.
// When the row is too narrow, chips drop their text and keep their glyph, in
// this order: refs (and the backend chip) → repo → place; the title truncates last.
import { h, svgUse, ib, flashDone, ago } from './events.js';
import { menuItem } from './menu.js';
import { repoChip, placeChip } from './place.js';

export const SLOTS = ['workstream', 'title', 'repo', 'place', 'refs', 'actions'];
const slots = new Map(SLOTS.map(n => [n, []]));

/**
 * Add a renderer to a slot: `render(ctx)` returns a node, a list of nodes, or
 * nothing. Renderers in a slot draw by `order` (default 50), then in the order
 * they were added; `replace` drops the ones already there. In `actions` the
 * session's tools sit at 50 and delete and close at 90, so a feature's button
 * lands between them unless it says otherwise. Returns a function that removes it again.
 */
export function registerHeaderSlot(name, render, { replace = false, order = 50 } = {}) {
  const list = slots.get(name);
  if (!list) throw new Error(`unknown header slot: ${name}`);
  if (replace) list.length = 0;
  const r = { render, order };
  list.push(r);
  list.sort((a, b) => a.order - b.order);
  return () => { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); };
}

function fill(name, ctx) {
  return slots.get(name).flatMap(({ render }) => {
    // A feature's renderer that throws loses its own part, not the whole header.
    try { return [render(ctx)].flat(); } catch (e) { console.error(`header slot ${name}:`, e); return []; }
  }).filter(Boolean);
}

/** The header's rows (one, today): each slot in a wrapper of its own, so the narrow-width rules can find it. */
export function headerRows(ctx) {
  const slot = (name) => { const nodes = fill(name, ctx); return nodes.length ? h('div', { class: `sh-s s-${name}` }, ...nodes) : null; };
  return [h('div', { class: 'sh-top' }, ...['workstream', 'title', 'repo', 'place', 'refs'].map(slot), h('span', { class: 'spacer' }), ...fill('actions', ctx))];
}

// ------------------------------------------------------------ narrow widths
// Collapse levels: c1 hides the refs' and backend chip's text, c2 the repo's,
// c3 the place's. Measured with the title at full width; whatever is still
// short after c3 comes out of the title, which truncates; past that, the row wraps.
const LEVELS = ['c1', 'c2', 'c3'];
let watched = null;
let fitted = { key: null, cls: [] };   // the last fit: what the row said and how wide it was, and the classes it got
/**
 * Fit the header row to its width. app.js calls it after each render, which
 * draws a new row: the last fit's classes are reapplied without measuring
 * unless the row's text or width changed. A resize fits again.
 */
export function fitHeader(root, { force = false } = {}) {
  const top = root?.querySelector(':scope > .sh-top');
  if (!top) return;
  const key = `${root.clientWidth}|${[...top.querySelectorAll('.sh-s')].map(n => n.textContent).join('|')}`;
  if (!force && key === fitted.key) { top.classList.remove(...LEVELS, 'wrap'); top.classList.add(...fitted.cls); }
  else {
    top.classList.remove(...LEVELS, 'wrap');
    top.classList.add('measure');
    const over = () => top.scrollWidth > top.clientWidth + 1;
    for (const c of LEVELS) { if (!over()) break; top.classList.add(c); }
    top.classList.remove('measure');
    if (over()) top.classList.add('wrap');
    fitted = { key, cls: [...LEVELS, 'wrap'].filter(c => top.classList.contains(c)) };
  }
  if (watched !== root && typeof ResizeObserver === 'function') {
    watched = root;
    let w = root.clientWidth;
    new ResizeObserver(() => { if (root.clientWidth !== w) { w = root.clientWidth; fitHeader(root, { force: true }); } }).observe(root);
  }
}

// ------------------------------------------------------------ workstream
// A session's workstream, when it has one (#28); #35 replaces this with its
// own renderer, which also offers "Assign workstream" when there is none.
// Subagents show their parent's. `ws` is { id, name } or a name.
registerHeaderSlot('workstream', (ctx) => {
  const { s, isAgent } = ctx;
  const ws = isAgent ? ctx.session(s.parentId)?.workstream : s.workstream;
  if (!ws) return null;
  const name = typeof ws === 'string' ? ws : ws.name || ws.id;
  const open = !isAgent && ctx.act.openWorkstream ? () => ctx.act.openWorkstream(ws) : null;
  return h(open ? 'button' : 'span', { type: open ? 'button' : null, class: 'sh-ws', onclick: open, title: open ? `Workstream ${name} · click to open it` : `Workstream ${name}` },
    svgUse('i-workstream', 13), h('span', {}, name));
});

// ------------------------------------------------------------ title
// Click the title, or focus it and press Enter, to rename the session: Enter
// saves, Esc (or leaving the field) cancels, and an empty title goes back to
// the agent's own. The deck keeps it (lib/titles.mjs); the transcript is untouched.
let edit = null;      // { id, input } while a title is being edited
let pending = null;   // { id, title, at }: saved, until the summary says so
/** True while the title of `id` is being edited; app.js holds off re-rendering the header meanwhile. */
export function headerEditing(id) {
  if (edit && (edit.id !== id || !edit.input.isConnected)) edit = null;
  return !!edit;
}

function titleText(ctx) {
  const { id, s } = ctx;
  if (pending?.id === id && s.title !== pending.title && Date.now() - pending.at < 10_000) return pending.title;
  pending = null;
  return s.title || id;
}

function titleEl(ctx) {
  const text = titleText(ctx);
  if (ctx.isAgent || !ctx.act.rename) return h('h1', { title: text }, text);
  const el = h('h1', { class: 'editable', tabindex: '0', role: 'button', 'aria-label': `${text}. Rename`,
    title: `${text}\nClick to rename${ctx.s.retitled ? ' · renamed in the deck; clear it to use the agent’s title' : ''}`,
    onclick: () => startEdit(ctx, el), onkeydown: (e) => {
      // Enter elsewhere opens the selected event's details (app.js); here it renames.
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); startEdit(ctx, el); }
    } }, text);
  return el;
}

function startEdit(ctx, el) {
  const was = titleText(ctx);
  const input = h('input', { class: 'sh-title-in', type: 'text', value: was, maxlength: '200', 'aria-label': 'Session title', spellcheck: 'false' });
  edit = { id: ctx.id, input };
  const done = (save) => {
    if (edit?.input !== input) return;
    edit = null;
    const t = input.value.replace(/\s+/g, ' ').trim();
    if (save && t !== was) {
      if (t) pending = { id: ctx.id, title: t, at: Date.now() };
      ctx.act.rename(ctx.id, t).catch(() => { pending = null; ctx.act.refresh?.(); });
    }
    const had = document.activeElement === input;
    // Redraw (the title shows the pending one), then keep focus on the title in the new row.
    ctx.act.refresh?.();
    if (had) document.querySelector('#shead .s-title h1.editable')?.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
  });
  input.addEventListener('blur', () => done(false));
  el.replaceWith(input);
  input.focus(); input.select();
}

registerHeaderSlot('title', (ctx) => {
  const { id, s, status: st, sig, isAgent, deck: d } = ctx;
  const out = [h('span', { class: `dot sig-${sig}${st.quiet ? ' quiet' : ''}`, title: st.head }),
    edit?.id === id ? edit.input : titleEl(ctx)];
  if (isAgent) {
    const parent = ctx.session(s.parentId);
    out.push(h('button', { type: 'button', class: 'sh-parent', onclick: () => ctx.act.select(s.parentId), title: `Open ${parent?.title || s.parentId}` }, `subagent of ${parent?.title || s.parentId}`));
  } else if (s.spawnedBy && ctx.session(s.spawnedBy)) {
    out.push(h('button', { type: 'button', class: 'sh-parent', onclick: () => ctx.act.select(s.spawnedBy), title: `Open ${ctx.session(s.spawnedBy).title}` }, `sub-task of ${ctx.session(s.spawnedBy).title}`));
  }
  // The permission mode shows only when it is not the default (asks before acting).
  if (d?.alive) { if (d.permissionMode !== 'default') out.push(h('span', { class: 'sh-mode', title: `Launched by the deck · pid ${d.pid} · permissions: ${d.permissionMode}` }, ctx.permLabel(d.permissionMode))); }
  else if (!isAgent && s.alive) out.push(h('span', { class: 'sh-mode', title: 'Observe only: launched outside the deck, so the deck can read it but not drive it' }, svgUse('i-eye', 14)));
  if (!isAgent) out.push(ctx.backendChip());
  return out;
});

// ------------------------------------------------------------ actions
// The session's tools (order 50), then delete and close at the far right (90).
registerHeaderSlot('actions', (ctx) => {
  const { deck: d } = ctx;
  // Where, which model, tokens and cost: one hover away rather than a line of figures under the brief.
  const out = [ctx.contextRing(), ctx.detailsBtn()];
  if (d?.alive) out.push(ib('i-power', `End the ${ctx.actor} session now. It ends by itself after 30 minutes idle, and the next prompt starts it again.`, ctx.act.stop, { cls: 'subtle' }));
  const resume = ctx.resume;
  if (resume) out.push(ib('i-copy', `Copy resume command: ${resume}`, (e) => { navigator.clipboard?.writeText(resume); flashDone(e.currentTarget); }));
  return out;
});
registerHeaderSlot('actions', (ctx) => {
  const { s, isAgent } = ctx;
  const win = h('div', { class: 'sh-win' });
  // Only a session with a transcript file can be deleted; a streamed one (ACP) has none to move.
  if (!isAgent && !s.stream) win.append(ib('i-trash', s.alive ? 'Running sessions cannot be deleted' : 'Delete session…', ctx.act.delete, { cls: 'danger', disabled: s.alive || null }));
  if (s.hidden) win.append(ib('i-reuse', 'Reopen (move it out of Closed)', ctx.act.reopen));
  else win.append(ib('i-x', isAgent ? 'Back to parent session' : 'Close (move it to Closed)', ctx.act.close));
  return win;
}, { order: 90 });

// ------------------------------------------------------------ repo and place
// Which repo (place.js repoChip) and where in it: a worktree or a branch
// (placeChip). ctx.place is what /api/sessions/:id/place last said; a
// subagent's is its parent's (or its own worktree's), shown read-only.
const chip = (icon, text, title, onclick, cls = '') => h(onclick ? 'button' : 'span', { type: onclick ? 'button' : null, class: `sh-chip${cls ? ' ' + cls : ''}`, title, onclick }, svgUse(icon, 12), h('span', {}, text));

let repoPop = null;
/** The repo menu: GitHub, the editor, the path, the files. */
function openRepoMenu(anchor, ctx, c) {
  const dir = ctx.place?.root || ctx.place?.cwd || ctx.s.cwd;
  if (!repoPop) {
    repoPop = h('div', { class: 'menu-pop repo-pop', popover: '', role: 'menu', 'aria-label': 'Repo' });
    repoPop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...repoPop.querySelectorAll('.mm-i:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });
    document.body.append(repoPop);
  }
  repoPop.replaceChildren(
    h('div', { class: 'mm-h' }, svgUse(c.icon, 16), h('div', {}, h('b', {}, c.text), h('div', { class: 'muted mm-path' }, ctx.tilde(dir)))),
    c.url ? menuItem(svgUse('i-git', 13), 'Open on GitHub', () => window.open(c.url, '_blank', 'noopener')) : null,
    menuItem(svgUse('i-open', 13), 'Open in editor', () => ctx.act.openEditor(dir)),
    c.url ? menuItem(svgUse('i-git', 13), 'Open in GitHub Desktop', () => { location.href = `x-github-client://openLocalRepo/${encodeURIComponent(dir)}`; }) : null,
    menuItem(svgUse('i-copy', 13), 'Copy path', () => navigator.clipboard?.writeText(dir)),
    ctx.isAgent ? null : menuItem(svgUse('i-folder', 13), 'Show its files', () => ctx.act.setTab('files')));
  const r = anchor.getBoundingClientRect();
  repoPop.style.top = `${r.bottom + 6}px`;
  if (!repoPop.matches(':popover-open')) repoPop.showPopover();
  repoPop.style.left = `${Math.max(8, Math.min(innerWidth - repoPop.offsetWidth - 8, r.left - 4))}px`;
  repoPop.querySelector('.mm-i')?.focus();
}

registerHeaderSlot('repo', (ctx) => {
  const c = repoChip(ctx.place, { cwd: ctx.s.cwd, tilde: ctx.tilde });
  if (!c) return null;
  const menu = (e) => { e.preventDefault(); openRepoMenu(e.currentTarget, ctx, c); };
  // GitHub: the chip opens the repo there, and its menu is a right-click or the chevron away.
  if (c.url) {
    return [h('a', { class: `sh-chip repo ${c.kind}`, href: c.url, target: '_blank', rel: 'noopener', title: `${c.title}\nClick to open it on GitHub · right-click for more`, oncontextmenu: menu },
      svgUse(c.icon, 12), h('span', {}, c.text)),
    ib('i-down', 'More: open in editor, copy path', menu, { cls: 'sh-more', size: 10, 'aria-haspopup': 'menu' })];
  }
  return h('button', { type: 'button', class: `sh-chip repo ${c.kind}`, 'aria-haspopup': 'menu', title: `${c.title}\nClick for more`, onclick: menu, oncontextmenu: menu },
    svgUse(c.icon, 12), h('span', {}, c.text));
});

registerHeaderSlot('place', (ctx) => {
  const { s, brief: b, isAgent, act } = ctx;
  const c = placeChip(ctx.place, { recorded: b?.branch || s.gitBranch || s.worktreeBranch, live: isAgent ? ctx.session(s.parentId)?.alive : s.alive, tilde: ctx.tilde });
  if (!c) return null;
  return chip(c.icon, c.text, isAgent ? c.title.replace(/\nClick for its changes$/, '') : c.title, isAgent ? null : () => act.setTab('changes'), `pl ${c.kind}`);
});

// ------------------------------------------------------------ refs
// The GitHub issues and PRs are public/ghchips.js's (order 50); here, where
// the session moved from or to, after them.
registerHeaderSlot('refs', (ctx) => {
  const { s, act } = ctx;
  if (!s.cwd || ctx.isAgent) return null;
  const out = [];
  const l = s.lineage;
  if (l?.from) out.push(chip('i-move', `from ${ctx.backendLabel(l.from.harness)}`, `Moved here from “${ctx.session(l.from.id)?.title || l.from.id}” ${ago(Date.now() - l.from.at)} ago · click to open it`, () => act.select(l.from.id), 'mv'));
  if (l?.to) out.push(chip('i-move', `moved to ${ctx.backendLabel(l.to.harness)}`, `Continued as “${ctx.session(l.to.id)?.title || l.to.id}” · click to open it`, () => act.select(l.to.id), 'mv'));
  return out;
}, { order: 80 });
