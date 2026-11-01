// public/ghchips.js — GitHub chips with live state: the header's refs slot,
// a hover card, "Ask the agent to fix CI", and a small API for other views
// (Home cards). One poll for everything on screen (lib/routes/gh.mjs): 60s
// while visible, 15s while CI runs, paused while hidden, backing off on rate
// limits (ghpoll.js). Without gh the chips still link, just without state.
//
// For other modules:
//   watchRefs(refs, { sessionId }) → unwatch   add refs ({ kind, repo, number }) to the poll
//   onGhState(fn) → off                         fn() after each poll that changed something
//   ghInfo(ref)                                 the live state of a ref, or undefined
//   miniChip(ref)                               a small chip: state colour, CI glyph, link
//   linkCounts(links) / fetchLinkCounts(links)  open/closed counts for issues, PRs and milestones
//   mergedPr(sessionId)                         the session's own PR once it has merged, else null
// and a `deck:pr-merged` event on document ({ detail: { sessionId, pr } }) the
// first time a session's own PR is seen merged (the server remembers, so a reload does not repeat it).
import { h, svgUse } from './events.js';
import { registerHeaderSlot } from './header.js';
import { PollScheduler, coalesce, keyOf, chipState, chipClass, chipLabel, countLinks, ST_LABEL, CI_LABEL, REVIEW_LABEL } from './ghpoll.js';

// ------------------------------------------------------------ the poll
const info = new Map();      // key -> live state from the last poll (null: GitHub says there is no such thing)
const watchers = new Set();  // { keys: Map(key -> ref), sessionId }
const listeners = new Set();
const sched = new PollScheduler();
const merged = new Map();    // sessionId -> pr, once its own PR is seen merged
const asked = new Set();     // `${sessionId}|${key}` merges already reported to the server
let timer = null, soon = null, etag = null, etagKeys = '', haveGh = true;

const watchedKeys = () => { const m = new Map(); for (const w of watchers) for (const [k, r] of w.keys) m.set(k, r); return m; };

/** Add `refs` to the poll; returns the function that takes them off again. `sessionId` ties a PR marked `branch` to its session. */
export function watchRefs(refs, { sessionId = null } = {}) {
  const w = { keys: new Map((refs || []).filter(r => r?.repo && r.number).map(r => [keyOf(r), r])), sessionId };
  watchers.add(w);
  if ([...w.keys.keys()].some(k => !info.has(k))) pollSoon();
  else if (!timer) plan();
  return () => { watchers.delete(w); };
}
/** fn() after a poll changed what is known. Returns the remover. */
export function onGhState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** The live state of a ref, or undefined when not known (yet). */
export function ghInfo(ref) { return info.get(keyOf(ref)) ?? undefined; }
/** The session's own PR once it has merged, else null (for the wrap-up button, #36). */
export function mergedPr(sessionId) { return merged.get(sessionId) || null; }

// One poll at a time; asking during one polls again as soon as it is done.
const pollNow = coalesce(poll);
function pollSoon() { clearTimeout(soon); soon = setTimeout(pollNow, 60); }
function plan() {
  clearTimeout(timer); timer = null;
  const keys = watchedKeys();
  const running = [...keys.keys()].some(k => info.get(k)?.ci === 'pending');
  const wait = haveGh ? sched.next({ hidden: document.hidden, watching: keys.size > 0, running }) : null;
  if (wait != null) timer = setTimeout(pollNow, wait);
}

async function poll() {
  clearTimeout(soon); clearTimeout(timer); timer = null;
  if (document.hidden) return;
  const keys = [...watchedKeys().keys()].sort();
  if (!keys.length) return;
  const list = keys.join(',');
  if (list !== etagKeys) etag = null;
  try {
    const r = await fetch(`/api/gh/state?k=${keys.map(encodeURIComponent).join(',')}`, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
    if (r.status === 304) sched.ok();
    else if (!r.ok) sched.fail();
    else {
      etag = r.headers.get('ETag'); etagKeys = list;
      const out = await r.json();
      haveGh = out.gh !== false;
      if (out.rateLimited) sched.fail({ retryAfter: out.retryAfter }); else sched.ok();
      let changed = false;
      for (const [k, v] of Object.entries(out.items || {})) {
        if (v === undefined) continue;   // not known (gh failed): keep what we had
        if (JSON.stringify(info.get(k)) !== JSON.stringify(v)) { info.set(k, v); changed = true; }
      }
      noticeMerged();
      if (changed) for (const fn of listeners) { try { fn(); } catch (e) { console.error('gh state listener:', e); } }
    }
  } catch { sched.fail(); }
  finally { plan(); }
}

// A session's own PR merging is the cue to wrap it up (#36 listens). The
// server remembers which merges were announced, so a reload does not repeat one.
function noticeMerged() {
  for (const w of watchers) {
    if (!w.sessionId) continue;
    for (const [k, r] of w.keys) {
      const i = info.get(k);
      if (!r.branch || i?.state !== 'merged' || asked.has(`${w.sessionId}|${k}`)) continue;
      const pr = { repo: i.repo, number: i.number, url: i.url, title: i.title };
      const sessionId = w.sessionId;
      merged.set(sessionId, pr);
      asked.add(`${sessionId}|${k}`);
      fetch('/api/gh/merged', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, key: k }) })
        .then(res => res.ok ? res.json() : null)
        .then(out => { if (out?.first) document.dispatchEvent(new CustomEvent('deck:pr-merged', { detail: { sessionId, pr } })); })
        .catch(() => asked.delete(`${sessionId}|${k}`));
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); timer = null; return; }
  pollSoon();
});

// ------------------------------------------------------------ counts for workstream links (#33)
/** Open/closed counts for links ({ kind: 'issue'|'pr'|'milestone', repo, number }) from what is known now: { open, closed, known, total }. */
export function linkCounts(links) { return countLinks(links, (l) => info.get(keyOf(l)) || undefined); }
/** The same once the poll has asked about every link (or 10s passed). Keeps them watched until `signal` aborts, if given. */
export function fetchLinkCounts(links, { signal = null } = {}) {
  const off = watchRefs(links);
  signal?.addEventListener('abort', off);
  return new Promise((resolve) => {
    const done = () => { stop(); clearTimeout(t); if (!signal) off(); resolve(linkCounts(links)); };
    const check = () => { if (links.every(l => info.has(keyOf(l)))) done(); };
    const stop = onGhState(check);
    const t = setTimeout(done, 10_000);
    check();
  });
}

// ------------------------------------------------------------ chips
const CI_GLYPH = { success: '✓', failure: '✕', pending: '' };
const icon = (r, st) => r.kind === 'pr' || r.kind === 'milestone' ? (r.kind === 'milestone' ? 'i-flag' : st === 'merged' ? 'i-merge' : 'i-pr') : 'i-issue';
const ciGlyph = (ci) => ci ? h('i', { class: `ci ci-${ci}`, 'aria-hidden': 'true' }, CI_GLYPH[ci]) : null;
const live = (r) => ({ ...r, ...(info.get(keyOf(r)) || {}), branch: r.branch, of: r.of });

/** A small chip for another view (Home cards): state colour, CI glyph, a link. Watch the ref for it to stay current. */
export function miniChip(ref) {
  const r = live(ref);
  const { st, ci } = chipState(r);
  const url = r.url || `https://github.com/${r.repo}/${r.kind === 'pr' ? 'pull' : r.kind === 'milestone' ? 'milestone' : 'issues'}/${r.number}`;
  return h('a', { class: `gh-mini ${chipClass(r)}`, href: url, target: '_blank', rel: 'noopener', 'aria-label': chipLabel(r), title: chipLabel(r) },
    svgUse(icon(r, st), 11), h('span', {}, r.kind === 'milestone' ? r.title || `Milestone ${r.number}` : `#${r.number}`), ciGlyph(ci));
}

function headerChip(ref, repo, ctx) {
  const r = live(ref);
  const { st, ci } = chipState(r);
  const num = `${repo && r.repo.toLowerCase() !== repo.toLowerCase() ? r.repo.split('/')[1] : ''}#${r.number}`;
  const a = h('a', { class: `sh-chip ${chipClass(r)}${r.branch ? ' cur' : ''}${r.of ? ' rel' : ''}`, href: r.url, target: '_blank', rel: 'noopener', 'aria-label': chipLabel(r, num) },
    svgUse(icon(r, st), 12), h('span', {}, num), ciGlyph(ci));
  hoverCard(a, () => live(ref), num, ctx);
  return a;
}

// ------------------------------------------------------------ the hover card
let card = null, cardFor = null, showT = null, hideT = null;
function cardEl() {
  if (card) return card;
  card = h('div', { class: 'gh-card', popover: 'manual', role: 'dialog' });
  card.addEventListener('pointerenter', () => clearTimeout(hideT));
  card.addEventListener('pointerleave', () => hideSoon());
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCard(); cardFor?.focus(); } });
  card.addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget) && e.relatedTarget !== cardFor) hideSoon(); });
  document.body.append(card);
  return card;
}
function hideSoon() { clearTimeout(hideT); hideT = setTimeout(hideCard, 220); }
function hideCard() { clearTimeout(showT); if (card?.matches(':popover-open')) card.hidePopover(); cardFor = null; }

function hoverCard(anchor, get, num, ctx) {
  const show = () => { clearTimeout(hideT); clearTimeout(showT); showT = setTimeout(() => openCard(anchor, get(), num, ctx), 180); };
  anchor.addEventListener('pointerenter', show);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('pointerleave', () => { clearTimeout(showT); hideSoon(); });
  anchor.addEventListener('blur', (e) => { if (!card?.contains(e.relatedTarget)) hideSoon(); });
  anchor.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(); });
}

function openCard(anchor, r, num, ctx) {
  if (!anchor.isConnected) return;
  const el = cardEl();
  const { kind, st, ci } = chipState(r);
  const what = `${kind === 'pr' ? 'Pull request' : 'Issue'} ${num}`;
  const c = r.checks;
  const checks = c ? [c.passed ? `${c.passed} passed` : null, c.failed ? `${c.failed} failed` : null, c.pending ? `${c.pending} running` : null].filter(Boolean).join(' · ') : null;
  const canFix = ci === 'failure' && !ctx.isAgent;
  el.replaceChildren(...[
    h('div', { class: 'ghc-h' }, h('span', { class: `ghc-st ${chipClass(r)}` }, svgUse(icon(r, st), 12), h('span', {}, ST_LABEL[st] || 'state unknown')),
      h('span', { class: 'muted' }, what), r.branch ? h('span', { class: 'muted' }, '· this branch') : null),
    r.title ? h('div', { class: 'ghc-t' }, r.title) : h('div', { class: 'ghc-t muted' }, haveGh ? 'Loading…' : 'GitHub CLI (gh) not available: no state'),
    h('div', { class: 'ghc-m muted' }, [r.author ? `by ${r.author}` : null, kind === 'pr' && r.review ? REVIEW_LABEL[r.review] : null].filter(Boolean).join(' · ') || null),
    kind === 'pr' && (r.unresolved || (r.conflicts && st === 'open')) ? h('div', { class: 'ghc-m' },
      r.unresolved ? h('span', { class: 'ghc-warn' }, `${r.unresolved} unresolved comment${r.unresolved === 1 ? '' : 's'}`) : null,
      r.conflicts && st === 'open' ? h('span', { class: 'ghc-err' }, 'merge conflicts') : null) : null,
    ci ? h('div', { class: `ghc-ci ci-${ci}` }, h('i', { class: `ci ci-${ci}`, 'aria-hidden': 'true' }, CI_GLYPH[ci]), h('span', {}, `${CI_LABEL[ci]}${checks ? ` · ${checks}` : ''}`)) : null,
    r.fails?.length && ci === 'failure' ? h('ul', { class: 'ghc-fails' }, ...r.fails.slice(0, 8).map(f =>
      h('li', {}, f.url ? h('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.name) : f.name))) : null,
    canFix ? h('button', { type: 'button', class: 'btn ghc-fix', onclick: (e) => fixCi(r, e.currentTarget) }, 'Ask the agent to fix CI') : null].filter(Boolean));   // replaceChildren would print a null
  el.setAttribute('aria-label', `${what} details`);
  cardFor = anchor;
  const rect = anchor.getBoundingClientRect();
  el.style.top = `${rect.bottom + 6}px`;
  if (!el.matches(':popover-open')) el.showPopover();
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, rect.left - 4))}px`;
  // Looking at a PR's reviews counts as having seen them (the "needs you" signal clears).
  if (kind === 'pr' && (r.review === 'changes_requested' || r.unresolved) && Number.isFinite(r.activity)) markSeen(ctx.id, r);
}

const seenSent = new Map();
function markSeen(sessionId, r) {
  const k = keyOf(r);
  if (seenSent.get(k) === r.activity) return;
  seenSent.set(k, r.activity);
  fetch('/api/gh/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, key: k, activity: r.activity }) }).catch(() => {});
}

// ------------------------------------------------------------ "Ask the agent to fix CI"
// The prompt goes into the composer, not straight to the agent: the pilot reads
// and edits it, then sends it through the normal queue.
async function fixCi(r, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/gh/fixci?repo=${encodeURIComponent(r.repo)}&number=${r.number}`, { cache: 'no-store' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `${res.status}`);
    const box = document.getElementById('compose');
    hideCard();
    if (!box || box.disabled) {
      await navigator.clipboard?.writeText(out.prompt);
      toast('This session cannot take prompts here; the fix-CI prompt is on the clipboard');
      return;
    }
    box.value = box.value.trim() ? `${box.value.replace(/\s+$/, '')}\n\n${out.prompt}` : out.prompt;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    // From the top, so the pilot reads it before sending.
    box.focus();
    box.setSelectionRange(0, 0);
    box.scrollTop = 0;
  } catch (e) { toast(`Could not build the fix-CI prompt: ${e.message}`); }
  finally { btn.disabled = false; }
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t); setTimeout(() => t.remove(), 4000);
}

// ------------------------------------------------------------ the header's refs slot
// The issues and PRs the session worked on (lib/ghrefs.mjs, ordered and
// related by lib/ghstate.mjs associate), with live state from the poll.
const SHOWN = 6;
let header = { off: null, keys: '', refresh: null, sessionId: null };
onGhState(() => header.refresh?.());

registerHeaderSlot('refs', (ctx) => {
  const { s, place: p } = ctx;
  // A subagent's place is its parent's; the parent's refs stay in the parent's header.
  if (!s.cwd || ctx.isAgent) return null;
  // Before gh answers, the PR the transcript links still shows.
  const refs = p?.refs || (s.pr?.url ? [{ kind: 'pr', number: s.pr.number, url: s.pr.url, repo: s.pr.repo || '' }] : []);
  const repo = p?.github?.repo || null;
  const shown = refs.filter(r => r.repo).slice(0, SHOWN);
  const keys = `${ctx.id}|${shown.map(r => `${keyOf(r)}${r.branch ? '*' : ''}`).join(',')}`;
  if (keys !== header.keys) { header.off?.(); header = { off: watchRefs(shown, { sessionId: ctx.id }), keys, sessionId: ctx.id, refresh: null }; }
  header.refresh = ctx.act.refresh;
  const out = shown.map(r => headerChip(r, repo, ctx));
  // A branch with work on it and no PR yet: GitHub's compare page, ready to open one.
  const prBranch = p?.prBranch ?? p?.branch;
  if (repo && prBranch && !p.pending && prBranch !== p.defaultBranch && !refs.some(r => r.branch))
    out.push(h('a', { class: 'sh-chip new-pr', href: `${p.github.url}/compare/${encodeURIComponent(prBranch)}?expand=1`, target: '_blank', rel: 'noopener',
      title: `Open a pull request for ${prBranch} on GitHub` }, svgUse('i-plus', 11), h('span', {}, 'PR')));
  if (refs.length > SHOWN) out.push(h('span', { class: 'sh-chip more', title: refs.slice(SHOWN).map(r => `${r.kind === 'pr' ? 'PR' : 'Issue'} #${r.number}${r.title ? ` ${r.title}` : ''}`).join('\n') }, `+${refs.length - SHOWN}`));
  return out;
});
