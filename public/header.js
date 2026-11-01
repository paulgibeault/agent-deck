// public/header.js — the session header, built from named slots so each
// feature fills its own: workstream · title · … · actions on the top row, and
// repo · place · refs on the row under it. A slot with nothing renders nothing.
// app.js keeps the state and passes what the header needs in a context
// (see headerCtx there); renderers read it and never reach into app.js.
import { h, svgUse, ib, flashDone, ago, basename } from './events.js';

export const SLOTS = ['workstream', 'title', 'repo', 'place', 'refs', 'actions'];
const slots = new Map(SLOTS.map(n => [n, []]));

/**
 * Add a renderer to a slot: `render(ctx)` returns a node, a list of nodes, or
 * nothing. Renderers in a slot draw in the order they were added; `replace`
 * drops the ones already there. Returns a function that removes it again.
 */
export function registerHeaderSlot(name, render, { replace = false } = {}) {
  const list = slots.get(name);
  if (!list) throw new Error(`unknown header slot: ${name}`);
  if (replace) list.length = 0;
  list.push(render);
  return () => { const i = list.indexOf(render); if (i >= 0) list.splice(i, 1); };
}

function fill(name, ctx) {
  return slots.get(name).flatMap(r => {
    // A feature's renderer that throws loses its own part, not the whole header.
    try { return [r(ctx)].flat(); } catch (e) { console.error(`header slot ${name}:`, e); return []; }
  }).filter(Boolean);
}

/** The header's rows: the title bar, and where the session is (absent when no slot there has anything). */
export function headerRows(ctx) {
  const top = h('div', { class: 'sh-top' }, ...fill('workstream', ctx), ...fill('title', ctx), h('span', { class: 'spacer' }), ...fill('actions', ctx));
  const where = [...fill('repo', ctx), ...fill('place', ctx), ...fill('refs', ctx)];
  return [top, where.length ? h('div', { class: 'sh-place' }, ...where) : null];
}

// ------------------------------------------------------------ title
registerHeaderSlot('title', (ctx) => {
  const { id, s, status: st, sig, isAgent, deck: d } = ctx;
  const out = [h('span', { class: `dot sig-${sig}${st.quiet ? ' quiet' : ''}`, title: st.head }), h('h1', { title: s.title }, s.title || id)];
  if (isAgent) {
    const parent = ctx.session(s.parentId);
    out.push(h('button', { type: 'button', class: 'sh-parent', onclick: () => ctx.act.select(s.parentId) }, `subagent of ${parent?.title || s.parentId}`));
  } else if (s.spawnedBy && ctx.session(s.spawnedBy)) {
    out.push(h('button', { type: 'button', class: 'sh-parent', onclick: () => ctx.act.select(s.spawnedBy) }, `sub-task of ${ctx.session(s.spawnedBy).title}`));
  }
  // The permission mode shows only when it is not the default (asks before acting).
  if (d?.alive) { if (d.permissionMode !== 'default') out.push(h('span', { class: 'sh-mode', title: `Launched by the deck · pid ${d.pid} · permissions: ${d.permissionMode}` }, ctx.permLabel(d.permissionMode))); }
  else if (!isAgent && s.alive) out.push(h('span', { class: 'sh-mode', title: 'Observe only: launched outside the deck, so the deck can read it but not drive it' }, svgUse('i-eye', 14)));
  if (!isAgent) out.push(ctx.backendChip());
  return out;
});

// ------------------------------------------------------------ actions
registerHeaderSlot('actions', (ctx) => {
  const { s, isAgent, deck: d } = ctx;
  const win = h('div', { class: 'sh-win' });
  if (s.hidden) win.append(ib('i-reuse', 'Reopen (move it out of Closed)', ctx.act.reopen));
  else win.append(ib('i-x', isAgent ? 'Back to parent session' : 'Close (move it to Closed)', ctx.act.close));
  // Only a session with a transcript file can be deleted; a streamed one (ACP) has none to move.
  if (!isAgent && !s.stream) win.append(ib('i-trash', s.alive ? 'Running sessions cannot be deleted' : 'Delete session…', ctx.act.delete, { cls: 'danger', disabled: s.alive || null }));
  // Where, which model, tokens and cost: one hover away rather than a line of figures under the brief.
  const out = [ctx.contextRing(), ctx.detailsBtn()];
  if (d?.alive) out.push(ib('i-power', `End the ${ctx.actor} session now. It ends by itself after 30 minutes idle, and the next prompt starts it again.`, ctx.act.stop, { cls: 'subtle' }));
  const resume = ctx.resume;
  if (resume) out.push(ib('i-copy', `Copy resume command: ${resume}`, (e) => { navigator.clipboard?.writeText(resume); flashDone(e.currentTarget); }));
  out.push(win);
  return out;
});

// ------------------------------------------------------------ repo, place, refs
// Folder, worktree, branch, and the GitHub issues and PRs the session worked
// on (lib/ghrefs.mjs). ctx.place is what /api/sessions/:id/place last said.
const chip = (icon, text, title, onclick, cls = '') => h(onclick ? 'button' : 'span', { type: onclick ? 'button' : null, class: `sh-chip${cls ? ' ' + cls : ''}`, title, onclick }, svgUse(icon, 12), h('span', {}, text));

registerHeaderSlot('repo', ({ s, tilde, act }) => {
  if (!s.cwd) return null;
  return [chip('i-folder', tilde(s.cwd), `Folder: ${s.cwd} · click for its files`, () => act.setTab('files'), 'fld'),
    ib('i-open', 'Open the folder in the editor', () => act.openEditor(s.cwd), { cls: 'sh-ed', size: 12 })];
});

registerHeaderSlot('place', ({ s, brief: b, place: p, tilde, act }) => {
  if (!s.cwd) return null;
  const out = [];
  if (p?.worktree) out.push(chip('i-worktree', `worktree of ${basename(p.worktree.main)}`, `A linked git worktree of ${tilde(p.worktree.main)}`, null));
  // The branch the session recorded; the folder may have moved on since (git's word when it hasn't recorded one).
  const now = p?.branch || (p?.detached ? `detached ${p.detached}` : null);
  const branch = (b?.branch || s.gitBranch || s.worktreeBranch || '').replace(/^HEAD$/, '') || now;
  if (branch) out.push(chip('i-branch', branch, `Branch ${branch}${now && now !== branch ? ` · the folder is now on ${now}` : ''} · click for its changes`, () => act.setTab('changes'), 'br'));
  return out;
});

const GH_ICON = { pr: 'i-pr', issue: 'i-issue' };
const GH_STATE = { open: 'Open', closed: 'Closed', merged: 'Merged' };
const REVIEW = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required' };
/** "5 passed · 1 failed: lint" for a PR's checks. */
function checksText(c) {
  if (!c) return null;
  return [c.passed ? `${c.passed} passed` : null, c.failed ? `${c.failed} failed${c.failing.length ? `: ${c.failing.slice(0, 4).join(', ')}` : ''}` : null, c.pending ? `${c.pending} running` : null].filter(Boolean).join(' · ');
}
function ghChip(r, repo) {
  const num = `${repo && r.repo.toLowerCase() !== repo.toLowerCase() ? r.repo.split('/')[1] : ''}#${r.number}`;
  const what = `${r.kind === 'pr' ? 'Pull request' : 'Issue'} ${num}`;
  // The branch's own PR also says how its CI and review stand; the dot is its CI.
  const ci = r.state === 'open' ? r.checks?.state : null;
  const tip = [[r.branch ? `${what} · this branch` : what, r.draft ? 'Draft' : r.state ? GH_STATE[r.state] || r.state : null].filter(Boolean).join(' · '),
    r.title, r.checks ? `Checks: ${checksText(r.checks)}` : null, r.review ? `Review: ${REVIEW[r.review] || r.review}` : null].filter(Boolean).join('\n');
  return h('a', { class: `sh-chip gh st-${r.state || 'unknown'}${r.branch ? ' cur' : ''}${r.draft ? ' draft' : ''}`, href: r.url, target: '_blank', rel: 'noopener', title: tip },
    svgUse(r.state === 'merged' ? 'i-merge' : GH_ICON[r.kind] || 'i-issue', 12), h('span', {}, num),
    ci ? h('i', { class: `ci ci-${ci}`, 'aria-label': `CI ${ci}` }) : null,
    r.review === 'approved' && r.state === 'open' ? svgUse('i-check', 10) : null);
}
const GH_SHOWN = 6;
registerHeaderSlot('refs', (ctx) => {
  const { s, place: p, act } = ctx;
  if (!s.cwd) return null;
  const out = [];
  // Before gh answers, the PR the transcript links still shows.
  const refs = p?.refs || (s.pr?.url ? [{ kind: 'pr', number: s.pr.number, url: s.pr.url, repo: s.pr.repo || '' }] : []);
  const repo = p?.github?.repo || null;
  out.push(...refs.slice(0, GH_SHOWN).map(r => ghChip(r, repo)));
  // A branch with work on it and no PR yet: GitHub's compare page, ready to open one.
  const prBranch = p?.prBranch ?? p?.branch;
  if (repo && prBranch && !p.pending && prBranch !== p.defaultBranch && !refs.some(r => r.branch))
    out.push(h('a', { class: 'sh-chip new-pr', href: `${p.github.url}/compare/${encodeURIComponent(prBranch)}?expand=1`, target: '_blank', rel: 'noopener',
      title: `Open a pull request for ${prBranch} on GitHub` }, svgUse('i-plus', 11), h('span', {}, 'PR')));
  if (refs.length > GH_SHOWN) out.push(h('span', { class: 'sh-chip more', title: refs.slice(GH_SHOWN).map(r => `${r.kind === 'pr' ? 'PR' : 'Issue'} #${r.number}${r.title ? ` ${r.title}` : ''}`).join('\n') }, `+${refs.length - GH_SHOWN}`));
  const l = s.lineage;
  if (l?.from) out.push(chip('i-move', `from ${ctx.backendLabel(l.from.harness)}`, `Moved here from “${ctx.session(l.from.id)?.title || l.from.id}” ${ago(Date.now() - l.from.at)} ago · click to open it`, () => act.select(l.from.id), 'mv'));
  if (l?.to) out.push(chip('i-move', `moved to ${ctx.backendLabel(l.to.harness)}`, `Continued as “${ctx.session(l.to.id)?.title || l.to.id}” · click to open it`, () => act.select(l.to.id), 'mv'));
  return out;
});
