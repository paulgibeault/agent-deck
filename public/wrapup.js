// public/wrapup.js — wrap-up (#36) in the page: the 🏁 glyph in the session
// header (highlighted once the session's own PR merges, public/ghchips.js), the
// one rich dialog (pre-checks, the editable preview, worktree choices, the
// scrubbed record as it will be written), and the rail's filter that brings
// wrapped sessions back into view. Registers itself; app.js imports it for
// wrappedFilter(). The server side is lib/routes/wrapup.mjs.
//
// Nothing is written until Finish. The model is asked once, only from the
// Draft button; without it (or when it fails) the summary fields stay blank.
import { h, ib, svgUse, markdown } from './events.js';
import { registerHeaderSlot } from './header.js';
import { mergedPr, onGhState } from './ghchips.js';
import { openWorkstreamPicker } from './wspicker.js';

document.head.append(h('link', { rel: 'stylesheet', href: '/wrapup.css' }));

const enc = encodeURIComponent;
async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let out = null; try { out = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t); setTimeout(() => t.remove(), 6000);
}
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const base = (p) => String(p || '').split('/').pop();

// ------------------------------------------------------------ header glyph
// A bare flag before delete and close. Once the session's own PR has merged it
// takes the "done" colour: the cue to wrap up. A wrapped session's flag is solid.
const redraws = new Set();
const redrawAll = () => { for (const fn of redraws) fn(); };
// The first sighting of a merge, and any poll after (a reload knows of it again without the event).
document.addEventListener('deck:pr-merged', redrawAll);
onGhState(redrawAll);
registerHeaderSlot('actions', (ctx) => {
  if (ctx.isAgent) return null;
  if (ctx.act.refresh) redraws.add(ctx.act.refresh);
  const { s } = ctx;
  const pr = mergedPr(ctx.id);
  const w = s.wrapped;
  const tip = pr ? `PR #${pr.number} merged · wrap up: record it in its workstream, end the agent, clean up`
    : w && !w.reopened ? `Wrapped up ${String(w.at).slice(0, 10)} · wrap up again (a follow-up)`
      : w?.reopened ? 'Wrap up: a follow-up record of what happened since the last wrap-up'
        : 'Wrap up: record it in its workstream, end the agent, clean up';
  return ib('i-flag', tip, () => openWrapup(ctx), { cls: `wu-btn${pr ? ' merged' : ''}${w && !w.reopened ? ' done' : ''}`, 'aria-haspopup': 'dialog' });
}, { order: 80 });

// ------------------------------------------------------------ rail filter
// Wrapped sessions leave the rail; this glyph (shown once there are any) brings them back.
let showWrapped = false;
let redrawRail = () => {};
const railBtn = h('button', { type: 'button', class: 'ib rail-wrapped', hidden: true });
function drawRailBtn() {
  railBtn.replaceChildren(svgUse('i-flag', 13));
  railBtn.setAttribute('aria-pressed', String(showWrapped));
  const tip = showWrapped ? 'Showing wrapped-up sessions · click to hide them' : 'Show wrapped-up sessions';
  railBtn.title = tip; railBtn.setAttribute('aria-label', tip);
}
railBtn.onclick = () => { showWrapped = !showWrapped; drawRailBtn(); redrawRail(); };
drawRailBtn();
document.getElementById('tree-filter')?.after(railBtn);
/** app.js: the rail shows a session only if this says so; `redraw` redraws the rail when the filter flips. */
export function wrappedFilter(redraw) {
  if (redraw) redrawRail = redraw;
  return (s) => {
    const out = !s.wrapped || !!s.wrapped.reopened;
    if (!out && railBtn.hidden) railBtn.hidden = false;
    return out || showWrapped;
  };
}

// ------------------------------------------------------------ the dialog
let dlg = null;
let W = null;   // the wrap-up open now

const CHOICE = { remove: 'Remove', keep: 'Keep', stash: 'Stash & remove', 'remove-anyway': 'Remove anyway', 'push-remove': 'Push branch & remove', forget: 'Forget' };
const CHOICE_TIP = {
  remove: 'Remove the worktree folder; nothing in it is lost', keep: 'Leave it as it is', stash: 'Stash its uncommitted changes, then remove it',
  'remove-anyway': 'Remove it with what is not merged or committed: that work is lost', 'push-remove': 'Push its branch to origin, then remove it', forget: 'Its folder is gone already: forget the record',
};
const STATE_TEXT = { merged: 'merged', empty: 'no commits', clean: 'clean', dirty: 'uncommitted changes', unmerged: 'unmerged commits', unknown: 'base not found', gone: 'folder gone', 'in-use': 'in use by another session' };
const ORIGIN = { star: ['i-star-5', 'You starred it'], 'star+model': ['i-star-5', 'You starred it; worded by the model'], model: ['i-star', 'From the model'], candidate: ['i-search', 'Sounds like a decision (heuristic): tick it to keep it'], touched: ['i-file', 'A file it touched'], artifact: ['i-vault', 'A file outside any repo'] };

export async function openWrapup(ctx, { slug } = {}) {
  dlg ||= document.body.appendChild(h('dialog', { class: 'dialog wide wu-dlg', 'aria-labelledby': 'wu-t',
    onclose: () => { clearTimeout(W?.poll); clearTimeout(W?.renderTimer); W = null; } }));
  const me = W = { id: ctx.id, s: ctx.s, ctx, slug, queue: 'drop', work: 'leave', loading: true, rendered: null, busy: false, result: null, err: null };
  draw();
  if (!dlg.open) dlg.showModal();
  try {
    const r = await call(`/api/sessions/${enc(ctx.id)}/wrapup${slug !== undefined ? `?slug=${enc(slug ?? 'loose')}` : ''}`);
    if (W !== me) return;
    Object.assign(me, { pre: r.precheck, preview: r.preview, model: r.model, modelError: r.modelError, loading: false });
  } catch (e) { if (W !== me) return; Object.assign(me, { loading: false, err: e.message }); }
  draw(); renderSoon(0); watch();
}

/** While a turn runs (waiting it out, or the commit the agent was asked for), look again every couple of seconds: git only. */
function watch() {
  const me = W;
  clearTimeout(me?.poll);
  if (!me?.pre || !(me.pre.busy || me.waiting)) return;
  me.poll = setTimeout(async () => {
    try {
      const r = await call(`/api/sessions/${enc(me.id)}/wrapup?precheck=1`);
      if (W !== me) return;
      me.pre = r.precheck;
      if (!me.pre.busy) me.waiting = null;
      // Only the pre-checks: redrawing the preview would take the pilot's cursor out of what they are typing.
      const old = dlg?.querySelector('.wu-pre');
      if (old) { old.replaceWith(prechecks(me) || ''); drawRendered(); } else draw();
    } catch { /* try again */ }
    if (W === me) watch();
  }, 2000);
}

function renderSoon(ms = 350) {
  const me = W;
  clearTimeout(me?.renderTimer);
  if (!me?.preview) return;
  me.renderTimer = setTimeout(async () => {
    try {
      const r = await call(`/api/sessions/${enc(me.id)}/wrapup/render`, { preview: me.preview, queue: me.queue });
      if (W !== me) return;
      me.rendered = r;
      drawRendered();
    } catch (e) { if (W === me) { me.rendered = { error: e.message }; drawRendered(); } }
  }, ms);
}

// ---- pre-checks: only what applies, one line each
function prechecks(me) {
  const p = me.pre; if (!p) return null;
  const rows = [];
  const row = (icon, cls, text, ...acts) => h('li', { class: `wu-pc ${cls}` }, svgUse(icon, 13), h('span', { class: 'wu-pc-t' }, text), h('span', { class: 'wu-pc-a' }, ...acts));
  const opt = (name, value, label, tip) => h('label', { class: 'wu-opt', title: tip || null },
    h('input', { type: 'radio', name, value, checked: me[name] === value || null, onchange: () => { me[name] = value; renderSoon(); } }), label);
  if (p.busy) rows.push(row('i-history', 'warn', me.waiting === 'commit' ? 'The agent is committing…' : 'Mid-turn.',
    p.deckRun ? h('button', { type: 'button', class: 'btn sm', onclick: async () => { try { await call(`/api/sessions/${enc(me.id)}/interrupt`, {}); } catch (e) { toast(e.message); } me.waiting = 'turn'; watch(); } }, 'Interrupt') : null,
    h('span', { class: 'muted' }, 'Finish waits for the turn to end.')));
  if (p.external) rows.push(row('i-eye', 'err', 'Running outside the deck (a terminal or the desktop app): end it there first, then wrap it up.'));
  if (p.queue.length) rows.push(row('i-list', '', h('span', { title: p.queue.map(q => `• ${q.text}`).join('\n') }, `${plural(p.queue.length, 'queued prompt')}, never sent:`),
    opt('queue', 'drop', 'Drop'), opt('queue', 'keep', 'Keep in the record', 'Listed in the session record; the queue itself is cleared')));
  if (p.permissions) rows.push(row('i-alert', 'warn', `${plural(p.permissions, 'permission prompt')} pending: Finish denies ${p.permissions === 1 ? 'it' : 'them'}.`));
  if (p.work) rows.push(row('i-git', 'warn', h('span', { title: p.work.list.join('\n') }, `${plural(p.work.files, 'file')} not committed, +${p.work.added} −${p.work.deleted}:`),
    opt('work', 'leave', 'Leave'), opt('work', 'stash', 'Stash', 'git stash push --include-untracked, at Finish'),
    p.deckRun || !p.alive ? h('button', { type: 'button', class: 'btn sm', title: 'One prompt asking the agent to commit; the wrap-up carries on after its turn',
      disabled: p.busy || null, onclick: async () => { try { await call(`/api/sessions/${enc(me.id)}/wrapup/commit`, {}); me.waiting = 'commit'; me.pre.busy = true; draw(); watch(); } catch (e) { toast(e.message); } } }, 'Ask the agent to commit') : null));
  const ws = me.preview?.slug;
  const pick = (e) => openWorkstreamPicker(e.currentTarget, { current: ws, none: false, onPick: (w) => w && openWrapup(me.ctx, { slug: w.slug }) });
  if (!p.store.ready) rows.push(row('i-alert', 'err', 'The workstreams repo is not set up yet: set it up from Home first.'));
  else if (!ws) rows.push(row('i-workstream', me.preview && !p.workstream ? 'warn' : '', me.preview ? 'Loose: recorded under loose/, in no workstream.' : 'Not in a workstream.',
    h('button', { type: 'button', class: 'btn sm', onclick: pick }, 'Pick one')));
  else rows.push(row('i-workstream', '', ['Into ', h('b', {}, ws)], h('button', { type: 'button', class: 'btn sm', onclick: pick }, 'Change'),
    h('button', { type: 'button', class: 'btn sm', title: 'Record it under loose/, in no workstream', onclick: () => openWrapup(me.ctx, { slug: null }) }, 'Loose')));
  return h('ul', { class: 'wu-pre' }, rows);
}

// ---- the preview's sections
const bindText = (obj, k = 'text', tag = 'input', attrs = {}) => {
  const el = h(tag, { class: `field wu-in${tag === 'textarea' ? ' ta' : ''}`, spellcheck: 'true', ...attrs, oninput: (e) => { obj[k] = e.target.value; renderSoon(); } });
  el.value = obj[k] || '';
  return el;
};
const tick = (obj, label) => h('input', { type: 'checkbox', class: 'wu-ck', 'aria-label': label, checked: obj.on || null, onchange: (e) => { obj.on = e.target.checked; e.target.closest('.wu-item')?.classList.toggle('off', !obj.on); renderSoon(); } });
const originGlyph = (o) => ORIGIN[o] ? h('span', { class: `wu-or or-${o.replace('+', '-')}`, title: ORIGIN[o][1] }, svgUse(ORIGIN[o][0], 11)) : null;
function section(title, items, tip) {
  if (!items || (Array.isArray(items) && !items.length)) return null;
  return h('section', { class: 'wu-sec' }, h('h3', { title: tip || null }, title), ...[items].flat());
}
const item = (obj, ...kids) => h('div', { class: `wu-item${obj.on ? '' : ' off'}` }, tick(obj, 'Include'), h('div', { class: 'wu-item-b' }, ...kids));

function decisionRow(d) {
  const c = d.conflict;
  const pick = (v) => h('label', { class: 'wu-opt', title: { old: `Keep ${c.with} and drop this one`, new: `This one supersedes ${c.with}`, both: 'Record this one and keep both active' }[v] },
    h('input', { type: 'radio', name: `wu-c-${d.key}`, value: v, checked: c.choice === v || null, onchange: () => { c.choice = v; renderSoon(); dlg.querySelector(`[data-k="${d.key}"]`)?.classList.add('resolved'); } }),
    { old: 'Keep old', new: 'Take new', both: 'Keep both' }[v]);
  return h('div', { class: `wu-item${d.on ? '' : ' off'}${c ? ' conflict' : ''}${c?.choice ? ' resolved' : ''}`, dataset: { k: d.key } }, tick(d, 'Include this decision'),
    h('div', { class: 'wu-item-b' },
      h('div', { class: 'wu-row' }, originGlyph(d.origin), bindText(d, 'title', 'input', { 'aria-label': 'Decision' }),
        d.supersedes && !c ? h('button', { type: 'button', class: 'wu-sup', title: `Supersedes decision ${d.supersedes} · click to record it as new instead`, onclick: (e) => { d.supersedes = null; e.currentTarget.remove(); renderSoon(); } }, `↺ ${d.supersedes}`) : null),
      d.body || d.origin !== 'candidate' ? bindText(d, 'body', 'textarea', { rows: '2', 'aria-label': 'Why', placeholder: 'Why (optional)' }) : null,
      c ? h('div', { class: 'wu-conf', role: 'group', 'aria-label': `Conflicts with decision ${c.with}` },
        h('div', {}, svgUse('i-alert', 12), ' Conflicts with ', h('b', {}, `${c.with}${c.title ? ` ${c.title}` : ''}`), c.why ? h('span', { class: 'muted' }, ` · ${c.why}`) : null),
        h('div', { class: 'wu-opts' }, pick('old'), pick('new'), pick('both'))) : null));
}

function worktreeRow(w) {
  const name = `wu-w-${w.path}`;
  const facts = [STATE_TEXT[w.state] || w.state, w.dirty ? plural(w.dirty, 'file') + ' changed' : null, w.unmerged ? plural(w.unmerged, 'commit') + ' unmerged' : null].filter(Boolean).join(' · ');
  return h('div', { class: `wu-wt st-${w.state}` },
    h('div', { class: 'wu-row' }, svgUse('i-worktree', 13), h('span', { class: 'mono wu-wt-b', title: tilde(w.path) }, w.branch || base(w.path)), h('span', { class: 'muted' }, facts)),
    w.warning ? h('p', { class: 'wu-warn' }, w.warning) : null,
    w.choices.length ? h('div', { class: 'wu-opts', role: 'radiogroup', 'aria-label': `What to do with ${w.branch || base(w.path)}` },
      ...w.choices.map(ch => h('label', { class: `wu-opt${ch === w.safe ? ' safe' : ''}${ch === 'remove-anyway' ? ' risky' : ''}`, title: CHOICE_TIP[ch] + (ch === 'remove' && w.deleteBranch ? ', and its branch' : '') },
        h('input', { type: 'radio', name, value: ch, checked: w.choice === ch || null, onchange: (e) => { w.choice = ch; e.target.closest('.wu-wt')?.querySelector('.wu-unch')?.remove(); renderSoon(); } }), CHOICE[ch] || ch)),
      w.choice ? null : h('span', { class: 'muted wu-unch' }, 'Unchosen: left as it is'))
      : h('p', { class: 'muted' }, 'Nothing to choose now.'));
}

function body(me) {
  const p = me.preview; if (!p) return null;
  const f = p.facts || {}; const st = f.stats || {};
  const facts = [st.backends?.join(' → '), st.turns != null ? plural(st.turns, 'turn') : null, st.costUsd != null ? `$${Number(st.costUsd).toFixed(2)}` : null,
    st.durationMs ? `${Math.max(1, Math.round(st.durationMs / 60000))} min` : null, f.lastTest ? `tests ${f.lastTest.failed ? 'failed' : 'passed'}` : null].filter(Boolean).join(' · ');
  const modelBar = h('div', { class: 'wu-model' },
    h('button', { type: 'button', class: 'btn sm', disabled: me.drafting || p.model?.ok || me.pre?.narrator === false || null,
      title: me.pre?.narrator === false ? 'Model calls are off' : 'One model call: a summary, decisions, notes and questions from the session, its stars and the workstream', onclick: () => draftWithModel() },
      svgUse('i-star', 12), me.drafting ? 'Drafting…' : p.model?.ok ? 'Drafted' : me.modelError ? 'Try again' : 'Draft with model'),
    h('span', { class: `muted wu-model-s${me.modelError ? ' err' : ''}` }, me.modelError ? `The model call failed (${me.modelError}). The sections below are what the deck knows; fill in the summary by hand.`
      : me.model ? [me.model.model, me.model.costUsd ? `$${me.model.costUsd.toFixed(3)}` : null, me.model.fellBack ? 'fell back to Claude' : null].filter(Boolean).join(' · ')
        : p.model?.ok ? '' : 'Or fill it in by hand.'));
  return h('div', { class: 'wu-body' },
    h('p', { class: 'wu-facts muted' }, facts || ' ', p.followup ? h('span', { class: 'wu-fu', title: `Covers only what happened since the wrap-up of ${String(p.followup.at || '').slice(0, 10)}` }, 'follow-up') : null),
    modelBar,
    section('Summary', [item(p.summary, bindText(p.summary, 'text', 'textarea', { rows: '3', placeholder: 'What the session did and where it ended' }))]),
    p.wsSummary ? section('Workstream summary', [item(p.wsSummary, bindText(p.wsSummary, 'text', 'textarea', { rows: '3', placeholder: p.wsSummary.was || 'The workstream’s summary, updated' }))], p.wsSummary.was ? `Now: ${p.wsSummary.was}` : 'A proposed edit; unticked leaves it as it is') : null,
    p.slug ? section('Next step', [item(p.next, bindText(p.next))]) : null,
    section('Decisions', p.decisions.map(decisionRow), 'Starred decisions come ticked; sentences that only sound like decisions do not'),
    section('Notes', p.notes.map(n => item(n, h('div', { class: 'wu-row' }, originGlyph(n.origin), bindText(n))))),
    section('Open questions', p.questions.map(q => item(q, h('div', { class: 'wu-row' }, originGlyph(q.origin), bindText(q))))),
    section('Files', p.files.map(x => item(x, h('div', { class: 'wu-row' }, originGlyph(x.origin), h('span', { class: 'mono wu-path', title: x.path }, tilde(x.path)), bindText(x, 'why', 'input', { placeholder: 'why', class: 'field wu-in wu-why' })))), 'Starred files come ticked; files it only touched do not'),
    section('PRs and issues', p.links.map(l => item(l, h('a', { href: l.url, target: '_blank', rel: 'noopener', class: 'wu-link' }, `${l.kind === 'pr' ? 'PR' : 'Issue'} ${l.repo}#${l.number}`),
      l.title ? h('span', {}, ` ${l.title}`) : null, l.state ? h('span', { class: `wu-st st-${l.state}` }, ` ${l.state}${l.ci ? ` · CI ${l.ci}` : ''}`) : null))),
    section('Vault', p.vault.map(v => item(v, h('div', { class: 'wu-row' }, originGlyph(v.origin), h('span', { class: 'mono wu-path', title: v.path }, tilde(v.path))))), 'Copied into the local-only Vault; the workstream keeps a pointer, never the content'),
    section('Worktrees', p.worktrees.map(worktreeRow), 'Only what is chosen here runs at Finish, and git is checked again first'),
    h('section', { class: 'wu-sec wu-red', hidden: true }, h('h3', {}, 'Redacted before it is written')),
    h('details', { class: 'wu-rec' }, h('summary', {}, 'The record as it will be written'), h('div', { class: 'md wu-md' })));
}

function drawRendered() {
  const me = W; if (!me || !dlg) return;
  const r = me.rendered || {};
  const red = dlg.querySelector('.wu-red');
  if (red) {
    const list = r.redactions || [];
    red.hidden = !list.length;
    red.replaceChildren(h('h3', { title: 'The secret scrubber takes these out of everything sent to the workstreams repo' }, `Redacted before it is written (${list.length})`),
      h('ul', {}, list.map(x => h('li', {}, svgUse('i-alert', 11), h('b', {}, ` ${x.kind}`), h('span', { class: 'mono muted' }, ` ${x.masked}`)))));
  }
  const md = dlg.querySelector('.wu-md');
  if (md && r.body) md.innerHTML = markdown(r.body);
  const fin = dlg.querySelector('.wu-finish');
  const note = dlg.querySelector('.wu-fin-err');
  if (note) note.textContent = r.error || '';
  if (fin) fin.disabled = !!(r.error || me.busy || me.pre?.busy || me.pre?.external || !me.pre?.store.ready) || null;
}

async function draftWithModel() {
  const me = W; if (!me?.preview || me.drafting) return;
  me.drafting = true; draw();
  try {
    const r = await call(`/api/sessions/${enc(me.id)}/wrapup/draft`, { preview: me.preview });
    if (W !== me) return;
    Object.assign(me, { preview: r.preview, model: r.model, modelError: r.error });
  } catch (e) { if (W === me) me.modelError = e.message; }
  if (W !== me) return;
  me.drafting = false; draw(); renderSoon(0);
}

async function finish() {
  const me = W; if (!me?.preview || me.busy) return;
  me.busy = true; draw();
  try {
    const r = await call(`/api/sessions/${enc(me.id)}/wrapup/finish`, { preview: me.preview, queue: me.queue, work: me.work });
    if (W !== me) return;
    me.result = r;
  } catch (e) { if (W === me) me.err = e.message; }
  if (W !== me) return;
  me.busy = false; draw();
}

function resultView(me) {
  const r = me.result;
  const wt = (r.worktrees || []).map(w => w.error ? `${base(w.path)}: ${w.error}` : `${base(w.path)}: ${CHOICE[w.done] || w.done}${w.branchDeleted ? ', branch deleted' : ''}${w.stash ? `, stash ${w.stash}` : ''}`);
  const lines = [
    [`Recorded in ${r.record}`, ` · commit ${r.commit}`, r.pushed ? ', pushed' : ', push pending'],
    r.redactions?.length ? [`${plural(r.redactions.length, 'secret')} redacted`] : null,
    r.vault?.copied?.length ? [`${plural(r.vault.copied.length, 'file')} saved to the Vault`] : null,
    r.stash ? [`Uncommitted work stashed: git stash list shows it (${r.stash})`] : null,
    r.stashError ? [h('span', { class: 'ns-err' }, r.stashError)] : null,
    [r.stopped ? 'The agent was ended' : 'The agent was not running',
      r.denied ? `, ${plural(r.denied, 'permission')} denied` : '', r.cleared ? `, ${plural(r.cleared, 'queued prompt')} cleared` : ''],
    ...wt.map(x => [x]),
  ].filter(Boolean);
  return h('div', { class: 'wu-done' }, h('ul', {}, lines.map(l => h('li', {}, svgUse('i-check', 12), ' ', ...l))),
    h('p', { class: 'muted' }, 'It has left the rail and shows under its workstream on Home. Resume it any time; the next wrap-up adds a follow-up.'));
}

function draw() {
  const me = W; if (!me || !dlg) return;
  const t = me.preview?.title || me.s.title || me.id;
  const done = !!me.result;
  dlg.replaceChildren(h('form', { method: 'dialog', class: 'wu-f',
    // Finish cannot be undone: only its own click runs it, never Enter in a field (the form never submits).
    onsubmit: (e) => e.preventDefault(),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); } },
    h('div', { class: 'wu-h' }, svgUse('i-flag', 15), h('h2', { id: 'wu-t' }, done ? 'Wrapped up' : 'Wrap up'), h('span', { class: 'wu-title', title: t }, t),
      h('span', { class: 'spacer' }), ib('i-x', 'Close (Esc)', () => dlg.close(), { size: 12 })),
    done ? resultView(me) : [
      me.loading ? h('p', { class: 'muted' }, 'Gathering stars, PRs, files and git…') : null,
      me.err ? h('p', { class: 'ns-err' }, me.err) : null,
      prechecks(me),
      body(me),
    ],
    h('div', { class: 'dialog-a' },
      h('span', { class: 'wu-fin-err ns-err' }),
      done ? h('button', { type: 'button', class: 'btn primary', onclick: () => dlg.close() }, 'Close') : [
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary wu-finish', disabled: true, onclick: () => finish(), title: 'Write the ticked items in one commit, end the agent, and run the worktree choices' }, me.busy ? 'Finishing…' : 'Finish')])));
  drawRendered();
}
