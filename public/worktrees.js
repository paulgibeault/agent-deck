// public/worktrees.js — automatic worktrees (lib/worktrees.mjs) in the deck:
// the New session dialog's candidate cards when the folder already has a live
// session, the "shares folder with" glyph in the header with "Restart in
// worktree", and the Worktrees dialog, where removing anything takes a click
// on that one worktree. Registers itself; app.js only imports it.
import { h, ib, svgUse, ago, basename } from './events.js';
import { registerMenuItem } from './menu.js';
import { registerHeaderSlot } from './header.js';
import { registerLaunchSection } from './launch.js';
import { chosenOf, launchFields, resumeMode, latest } from './wtpick.js';

document.head.append(h('link', { rel: 'stylesheet', href: '/worktrees.css' }));

async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let out = null; try { out = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t); setTimeout(() => t.remove(), 5000);
}
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
const quote = (t) => `“${t}”`;

// ------------------------------------------------------------ candidate cards
/**
 * The choices for a new worktree's base, one card each; the model's pick (or
 * the only sensible one) is marked, and preselected when it is confident.
 * `same`: also offer "Use the same folder anyway". `pick(id)` on a click.
 */
function cards(plan, { selected, same = true, pick, thinking = false, modes = {}, setMode = () => {} }) {
  const sug = plan.suggestion;
  const occ = plan.occupied || {};
  const names = plan.with.map(w => quote(w.title || w.id.slice(0, 8))).join(', ');
  // A resume card: continue on the branch itself, or a new deck branch from it.
  const modeToggle = (c) => {
    const m = resumeMode(c, modes);
    const opt = (v, text, disabled, tip) => h('button', { type: 'button', class: 'wt-mode', 'aria-pressed': String(m === v), disabled: disabled || null, title: tip,
      onclick: (e) => { e.preventDefault(); setMode(c.id, v); pick(c.id); } }, text, ' ', h('b', {}, c.branch));
    return h('span', { class: 'wt-modes', role: 'group', 'aria-label': `How to resume ${c.branch}` },
      opt('continue', 'Continue on', !!c.checkedOutAt, c.checkedOutAt ? `${c.branch} is checked out in ${tilde(c.checkedOutAt)}; git allows it in one worktree at a time` : `Check ${c.branch} itself out in the new worktree; removing the worktree later keeps the branch`),
      opt('new', 'New branch from', false, `A new deck/… branch starting at ${c.branch}`));
  };
  const radio = (id, label, sub, extra = {}) => {
    const isSug = sug?.pick === id && !sug.error;
    return h('label', { class: `wt-card${isSug ? ' sug' : ''}${selected === id ? ' on' : ''}${extra.cls ? ' ' + extra.cls : ''}`, title: extra.title || null },
      h('input', { type: 'radio', name: 'wt-base', value: id, checked: selected === id || null, onchange: () => pick(id) }),
      h('span', { class: 'wt-c' },
        h('span', { class: 'wt-l' }, label, sub ? h('span', { class: 'wt-f' }, ` · ${sub}`) : null,
          isSug ? h('span', { class: `wt-sug${sug.preselect ? '' : ' unsure'}`, title: sug.via === 'model' ? `Suggested by the model · confidence ${Math.round(sug.confidence * 100)}%` : null }, 'suggested') : null),
        extra.cand?.kind === 'branch' ? modeToggle(extra.cand) : null,
        isSug && sug.reason && sug.via !== 'collapsed' ? h('span', { class: 'wt-why' }, quote(sug.reason)) : null));
  };
  const emph = (c) => {
    const m = /^(Continue from|Fresh from|Resume) (.+)$/.exec(c.label);
    return m ? [`${m[1]} `, h('b', {}, m[2])] : c.label;
  };
  return h('div', { class: 'wt-pick' },
    h('p', { class: 'wt-head' }, svgUse('i-worktree', 13), ' ',
      `Shares a working tree with ${names}${occ.branch ? ` (${occ.branch})` : ''}. Start ${same ? 'this one' : 'it again'} in a worktree from:`,
      thinking ? h('span', { class: 'wt-thinking', title: 'Asking the model which base fits' }, ' …') : null),
    h('div', { class: 'wt-cards', role: 'radiogroup', 'aria-label': 'Where the new worktree starts' },
      ...plan.candidates.map(c => radio(c.id, emph(c), c.facts, { cand: c, title: c.kind === 'head' && c.dirty ? 'Uncommitted changes stay where they are; pick “Fork the working copy” to bring them' : null })),
      same ? radio('same', 'Use the same folder anyway', null, { cls: 'same', title: 'Both sessions edit the same files' }) : null),
    sug?.error ? h('p', { class: 'note' }, 'No suggestion this time; choose one.') : null);
}

// ------------------------------------------------------------ the launch dialog
// The plan is kept per folder: { state: 'loading' | 'ok' | 'failed', plan, error, p }.
// Start waits for a plan still loading and refuses after a failed one, so a
// launch never slips past a shared folder unchosen. The model is asked at most
// once per folder while the dialog is open, after the prompt settles, and never
// when the server says the choice is trivial or named.
const ASK_MIN = 20, ASK_IDLE_MS = 1200;
const L = { el: null, cwd: '', plans: new Map(), sugs: new Map(), picked: null, modes: {}, asked: new Set(), thinking: false, timer: null, promptTimer: null };
const promptText = () => document.getElementById('ns-prompt')?.value || '';
const planOf = (cwd) => L.plans.get(cwd)?.plan || null;

function drawLaunch() {
  if (!L.el) return;
  const e = L.plans.get(L.cwd);
  if (e?.state === 'failed') { L.el.replaceChildren(h('p', { class: 'note err' }, svgUse('i-alert', 12), ` Could not check this folder for other sessions: ${e.error}`)); return; }
  const plan = planOf(L.cwd);
  if (!plan?.conflict) { L.el.replaceChildren(); return; }
  L.el.replaceChildren(cards(plan, { selected: chosenOf(plan, L.picked), thinking: L.thinking, modes: L.modes, setMode: (id, m) => { L.modes[id] = m; },
    pick: (id) => { L.picked = id; drawLaunch(); } }));
}
function planLaunch(cwd, { ask = false } = {}) {
  if (cwd !== L.cwd) L.picked = null;
  L.cwd = cwd;
  if (!cwd) { drawLaunch(); return Promise.resolve(); }
  const prompt = promptText();
  ask = ask && !L.asked.has(cwd) && prompt.trim().length >= ASK_MIN;
  // A sent ask counts even when the server makes no call (model calls off, a named branch).
  if (ask) { L.asked.add(cwd); L.thinking = true; drawLaunch(); }
  const prev = L.plans.get(cwd);
  const entry = { state: prev?.state === 'ok' ? 'ok' : 'loading', plan: prev?.plan || null, error: null };
  entry.p = call('/api/worktrees/plan', { cwd, prompt, ask }).then((p) => {
    // The model's pick is kept per folder, so a later look (git only) or a replaced request keeps it.
    if (p.suggestion?.via === 'model') L.sugs.set(cwd, p.suggestion);
    else if (!p.suggestion && L.sugs.has(cwd)) p.suggestion = L.sugs.get(cwd);
    Object.assign(entry, { state: 'ok', plan: p, error: null });
  }, (e) => Object.assign(entry, { state: 'failed', plan: null, error: e.message })).finally(() => {
    if (ask) L.thinking = false;
    if (L.plans.get(cwd) !== entry) {
      // Replaced while asking: hand the pick to the newer plan, or let the ask happen again.
      const cur = L.plans.get(cwd);
      if (ask && L.sugs.has(cwd) && cur?.plan && !cur.plan.suggestion) cur.plan.suggestion = L.sugs.get(cwd);
      else if (ask && !L.sugs.has(cwd)) L.asked.delete(cwd);
      drawLaunch();
      return;
    }
    drawLaunch();
    const p = entry.plan;
    if (p?.conflict && !L.asked.has(cwd) && promptText().trim().length >= ASK_MIN && !['collapsed', 'named'].includes(p.suggestion?.via)) askSoon();
  });
  L.plans.set(cwd, entry);
  return entry.p;
}
function askSoon() {
  clearTimeout(L.promptTimer);
  // Once the pilot has chosen, a suggestion would change nothing: no call.
  L.promptTimer = setTimeout(() => { if (planOf(L.cwd)?.conflict && !L.picked) planLaunch(L.cwd, { ask: true }); }, ASK_IDLE_MS);
}
document.getElementById('ns-prompt')?.addEventListener('input', () => { if (planOf(L.cwd)?.conflict && L.el?.isConnected) askSoon(); });

registerLaunchSection({
  slot: 'cwd',
  open(el, ctx) {
    Object.assign(L, { el, plans: new Map(), sugs: new Map(), picked: null, modes: {}, cwd: '', asked: new Set(), thinking: false });
    planLaunch(ctx.cwd());
  },
  cwdChanged(cwd) {
    clearTimeout(L.timer);
    L.timer = setTimeout(() => planLaunch(cwd), 350);
  },
  async collect(body) {
    // The folder may have changed since the last look, or its plan may still be on its way.
    if (body.cwd !== L.cwd || !L.plans.has(body.cwd)) { clearTimeout(L.timer); planLaunch(body.cwd); }
    const e = L.plans.get(body.cwd);
    if (e?.state === 'loading') await e.p;
    return launchFields(L.plans.get(body.cwd), body.cwd === L.cwd ? L.picked : null, L.modes);
  },
  launched(st, body) {
    clearTimeout(L.promptTimer);
    if (!body.worktree?.use) return;
    toast(`Started in its own worktree: ${tilde(st.cwd)}`);
  },
});

/** The server says (SSE worktrees.setup) how a worktree's setup command went; app.js passes it on. */
export function onWorktreeSetup(d) {
  if (d && d.ok === false) toast(`Worktree setup failed (${d.cmd}): ${d.error}. The session runs anyway.`);
}

// ------------------------------------------------------------ the header
// A live session sharing its worktree with another gets a warning glyph; on
// the newer one it opens "Restart in worktree".
const shared = { map: {}, at: 0, inflight: false };
function sharedNow(refresh) {
  if (!shared.inflight && Date.now() - shared.at > 20_000) {
    shared.inflight = true;
    call('/api/worktrees/shared')
      .then((m) => { const was = JSON.stringify(shared.map); shared.map = m || {}; if (was !== JSON.stringify(shared.map)) refresh?.(); })
      .catch(() => {})
      .finally(() => { shared.at = Date.now(); shared.inflight = false; });
  }
  return shared.map;
}
registerHeaderSlot('place', (ctx) => {
  const { id, s, isAgent } = ctx;
  if (isAgent || !s.alive || !s.cwd) return null;
  const others = sharedNow(ctx.act.refresh)[id];
  if (!others?.length) return null;
  const mine = s.startedAt || 0;
  const newer = others.every(o => !o.startedAt || !mine || mine >= o.startedAt);
  const who = others.map(o => `${quote(o.title || o.id.slice(0, 8))}${o.deck ? '' : ' (outside the deck)'}`).join(', ');
  const tip = `Shares its folder with ${who}: both edit the same files.\n${newer ? 'Click to restart this session in its own worktree' : 'The newer session can restart in its own worktree; click to open it'}`;
  return h('button', { type: 'button', class: 'sh-chip wt-warn', title: tip, 'aria-label': `Shares folder with ${who}`,
    onclick: () => newer ? openRestart(ctx) : ctx.act.select(others[0].id) }, svgUse('i-alert', 12));
}, { order: 60 });

// ------------------------------------------------------------ restart in worktree
let rdlg = null;
const restartOpens = latest();
async function openRestart(ctx) {
  const { id, s } = ctx;
  rdlg ||= document.body.appendChild(h('dialog', { class: 'dialog wide wt-restart', 'aria-labelledby': 'wtr-t' }));
  const R = { plan: null, picked: null, modes: {}, thinking: true };
  // The dialog is reused: what an earlier open still has on its way must not draw over this one, or restart its session.
  const current = restartOpens();
  const draw = (err = null) => {
    if (!current()) return;
    rdlg.replaceChildren(h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); go(); } },
      h('h2', { id: 'wtr-t' }, 'Restart in worktree'),
      h('p', { class: 'ns-sub' }, `${quote(s.title || id)} continues as a new session in its own worktree, with a handoff of what it did so far.`
        + (ctx.deck?.alive ? ' The deck ends the current one.' : ' It runs outside the deck, so quit it there yourself.')),
      R.plan?.conflict ? cards(R.plan, { selected: chosenOf(R.plan, R.picked), same: false, thinking: R.thinking, modes: R.modes, setMode: (i, m) => { R.modes[i] = m; }, pick: (x) => { R.picked = x; draw(); } })
        : h('p', { class: 'muted' }, R.plan ? 'This folder is no longer shared.' : 'Looking at the repo…'),
      err ? h('p', { class: 'ns-err' }, err) : null,
      h('div', { class: 'dialog-a' },
        h('button', { type: 'button', class: 'btn', onclick: () => rdlg.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary', disabled: !chosenOf(R.plan, R.picked) || null }, 'Restart'))));
  };
  const go = async () => {
    if (!current()) return;
    let fields;
    try { fields = launchFields({ state: 'ok', plan: R.plan }, R.picked, R.modes)?.worktree; } catch (e) { draw(e.message); return; }
    if (!fields?.use) return;
    rdlg.querySelector('.btn.primary').disabled = true;
    try {
      const r = await call('/api/worktrees/restart', { sessionId: id, base: fields.base, cand: fields.cand, suggestion: fields.suggestion });
      rdlg.close();
      shared.at = 0;
      toast(`Restarted in ${tilde(r.record.cwd || r.record.path)}${r.stopped ? '' : '. The old session still runs where it started.'}`);
      ctx.act.select?.(r.state.id);
    } catch (e) { draw(e.message); }
  };
  draw();
  if (!rdlg.open) rdlg.showModal();
  // An explicit ask: the model may weigh in at once (once), with the session's title as the task.
  let plan;
  try { plan = await call('/api/worktrees/plan', { cwd: s.cwd, prompt: s.title || '', ask: true, except: id }); } catch (e) { R.thinking = false; draw(e.message); return; }
  if (!current()) return;
  R.plan = plan;
  R.thinking = false;
  draw();
}

// ------------------------------------------------------------ the Worktrees dialog
const ACTION = {
  remove: { text: 'Remove', tip: 'Remove the worktree; its branch has nothing unmerged, so it goes too' },
  keep: { text: 'Keep', tip: 'Leave it as it is' },
  stash: { text: 'Stash & remove', tip: 'Stash the uncommitted changes (git stash, kept in the repo), then remove the worktree' },
  'push-remove': { text: 'Push & remove', tip: 'Push the branch to origin, then remove the worktree once the remote has it', confirm: 'Push to origin' },
  'remove-anyway': { text: 'Remove anyway', tip: 'Remove the worktree and delete its branch, losing what is not merged or committed', confirm: 'Lose it' },
  forget: { text: 'Forget', tip: 'The folder is already gone; drop the deck’s record of it' },
};
let wdlg = null;
let armed = null;   // the action button waiting for its second click

function stateGlyphs(it) {
  const f = it.facts, d = it.decision;
  const out = [];
  if (d.state === 'gone') out.push(h('span', { class: 'wt-st st-gone', title: 'The folder is gone' }, svgUse('i-x', 11)));
  if (d.state === 'unknown') out.push(h('span', { class: 'wt-st st-unknown', title: d.warning }, svgUse('i-q', 11)));
  if (f.dirty) out.push(h('span', { class: 'wt-st st-dirty', title: `${f.dirty} uncommitted` }, svgUse('i-pencil', 11), h('span', {}, String(f.dirty))));
  if (f.unmerged) out.push(h('span', { class: 'wt-st st-ahead', title: `${f.unmerged} commits not merged into ${it.record.base?.branch || 'its base'}` }, svgUse('i-commit', 11), h('span', {}, String(f.unmerged))));
  if (d.state === 'merged') out.push(h('span', { class: 'wt-st st-merged', title: 'Merged' }, svgUse('i-merge', 11)));
  if (d.state === 'empty') out.push(h('span', { class: 'wt-st st-empty', title: 'No commits, nothing uncommitted' }, svgUse('i-check', 11)));
  const setup = it.record.setup;
  if (setup?.state === 'failed') out.push(h('span', { class: 'wt-st st-dirty', title: `Setup failed: ${setup.cmd}\n${setup.error}${setup.tail ? `\n${setup.tail}` : ''}` }, svgUse('i-alert', 11)));
  return out;
}

function itemRow(it) {
  const r = it.record;
  const tip = [tilde(r.path), `of ${tilde(r.repo)}`, `base ${r.base?.branch || r.base?.ref}${r.base?.sha ? ` @ ${r.base.sha.slice(0, 7)}` : ''} (${r.base?.kind})`,
    r.created ? `made ${new Date(r.created).toLocaleString()}` : null, r.suggestion?.reason ? `why: ${r.suggestion.reason}` : null,
    r.setup ? `setup: ${r.setup.cmd} · ${r.setup.state}` : null, r.kept ? `kept ${ago(Date.now() - r.kept)} ago` : null].filter(Boolean).join('\n');
  const who = it.alive ? h('span', { class: 'wt-live', title: 'In use: a session is running in it, so there is nothing to remove' }, svgUse('i-play', 10))
    : it.orphan ? h('span', { class: 'wt-orphan', title: 'Orphan: no live session, and its session is gone or wrapped up' }, svgUse('i-flag', 11)) : null;
  const acts = it.decision.choices.map(a => {
    const spec = ACTION[a];
    const safe = it.decision.safe === a;
    const kept = it.decision.keepsBranch ? `\nThe branch ${it.record.branch} is yours and stays.` : '';
    const tip = (it.decision.keepsBranch || it.decision.warning) && /remove/.test(a)
      ? spec.tip.replace(/; its branch has nothing unmerged, so it goes too| and delete its branch/, '').replace('merged or committed', 'committed') + kept + (it.decision.warning ? `\n${it.decision.warning}` : '')
      : spec.tip;
    return h('button', { type: 'button', class: `btn sm wt-a${safe ? ' safe' : ''}${spec.confirm ? ' risky' : ''}`, title: tip,
      onclick: (e) => runAction(e.currentTarget, it, a) }, spec.text);
  });
  return h('li', { class: `wt-row${it.orphan ? ' orphan' : ''}`, title: tip },
    svgUse('i-worktree', 13),
    h('span', { class: 't' }, h('span', { class: 'tt mono' }, r.branch), h('span', { class: 'sub' }, [it.title ? quote(it.title) : r.sessionId ? r.sessionId.slice(0, 8) : it.alive ? 'starting' : 'no session', basename(r.repo)].join(' · '))),
    h('span', { class: 'wt-sts' }, who, ...stateGlyphs(it)),
    h('span', { class: 'wt-acts' }, ...(it.decision.state === 'in-use' ? [h('span', { class: 'wt-inuse muted' }, 'in use')] : acts)));
}

async function runAction(btn, it, action) {
  const spec = ACTION[action];
  // Anything that can lose work or reach a remote takes a second click on the same button.
  if (spec.confirm && armed !== btn) {
    armed = btn;
    const n = it.facts.unmerged, d = it.facts.dirty;
    btn.textContent = action === 'push-remove' ? `${spec.confirm}?` : it.decision.state === 'unknown' ? `Base unknown${d ? `, lose ${d} uncommitted` : ''}; remove?` : `Lose ${[d ? `${d} uncommitted` : null, n ? `${n} commit${n > 1 ? 's' : ''}` : null].filter(Boolean).join(', ') || 'it'}?`;
    btn.classList.add('armed');
    setTimeout(() => { if (armed === btn) { armed = null; btn.textContent = spec.text; btn.classList.remove('armed'); } }, 4000);
    return;
  }
  armed = null;
  btn.disabled = true;
  try {
    const r = await call('/api/worktrees/act', { path: it.record.path, action });
    toast(action === 'keep' ? `Keeping ${it.record.branch}` : action === 'stash' ? `Stashed (${r.stash}) and removed ${it.record.branch}`
      : action === 'push-remove' ? `Pushed to ${r.pushed} and removed the worktree` : `Removed ${it.record.branch}${r.branchDeleted ? ' and its branch' : ''}`);
    openWorktrees();
  } catch (e) { toast(`${spec.text} failed: ${e.message}`); btn.disabled = false; }
}

function repoSettings(repo, cfg) {
  const setup = h('input', { class: 'field mono', value: cfg.setup || '', placeholder: 'e.g. npm ci', spellcheck: 'false', 'aria-label': 'Setup command' });
  const copy = h('input', { class: 'field mono', value: (cfg.copy || []).join(' '), spellcheck: 'false', 'aria-label': 'Untracked files to copy' });
  const box = h('form', { class: 'wt-cfg', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    try { await call('/api/worktrees/config', { repo, setup: setup.value, copy: copy.value.split(/\s+/).filter(Boolean) }); toast('Saved'); box.hidden = true; }
    catch (err) { toast(`Not saved: ${err.message}`); }
  } },
  h('label', { class: 'ns-l' }, 'Setup command, run in each new worktree'), setup,
  h('label', { class: 'ns-l' }, 'Untracked files to copy in'), copy,
  h('div', { class: 'dialog-a' }, h('button', { type: 'submit', class: 'btn sm' }, 'Save')));
  return { box, btn: ib('i-gear', `Setup for new worktrees of ${basename(repo)}`, () => { box.hidden = !box.hidden; }, { size: 12 }) };
}

async function openWorktrees() {
  wdlg ||= document.body.appendChild(h('dialog', { class: 'dialog wide history wt-dlg', 'aria-labelledby': 'wt-t', onclick: (e) => { if (e.target === wdlg) wdlg.close(); } }));
  let v;
  try { v = await call('/api/worktrees'); } catch (e) { toast(`Worktrees: ${e.message}`); return; }
  const byRepo = new Map();
  for (const it of v.items) byRepo.set(it.record.repo, [...(byRepo.get(it.record.repo) || []), it]);
  const orphans = v.items.filter(it => it.orphan).length;
  const groups = [...byRepo].map(([repo, items]) => {
    const s = repoSettings(repo, v.repos[repo] || {});
    return [h('li', { class: 'wt-repo', title: tilde(repo) }, svgUse('i-git', 12), h('span', {}, basename(repo)), h('span', { class: 'spacer' }), s.btn), h('li', { class: 'wt-cfg-li' }, s.box),
      ...items.sort((a, b) => (b.orphan - a.orphan) || (b.record.created - a.record.created)).map(itemRow)];
  }).flat();
  wdlg.replaceChildren(h('div', { class: 'hist-f' },
    h('div', { class: 'hist-h' },
      h('h2', { id: 'wt-t' }, svgUse('i-worktree', 15), ' Worktrees'),
      h('span', { class: 'muted', title: orphans ? `${orphans} orphaned` : null }, v.items.length ? `${v.items.length}${orphans ? ` · ${orphans} orphaned` : ''}` : ''),
      h('span', { class: 'spacer' }),
      ib('i-refresh', 'Prune: drop git’s records of worktree folders already gone', async () => { try { await call('/api/worktrees/prune', {}); openWorktrees(); } catch (e) { toast(e.message); } }, { size: 12 }),
      ib('i-x', 'Close (Esc)', () => wdlg.close(), { size: 12 })),
    h('ul', { class: 'hist-list wt-list', 'aria-label': 'Worktrees the deck made' },
      groups.length ? groups : h('li', { class: 'hist-empty muted' }, 'None yet. When a new session’s folder already has a live session, the deck starts it in a worktree of its own.'))));
  if (!wdlg.open) wdlg.showModal();
}

registerMenuItem({ group: 'vault', order: 60, icon: 'i-worktree', text: 'Worktrees…', fn: () => openWorktrees() });
