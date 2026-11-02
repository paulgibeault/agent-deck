// lib/wrapup.mjs — wrap-up (#36): turn a finished session into its
// workstream's durable record. Pure steps, so tests drive them without a deck:
//
//   gather()      what the deck knows without a model: stars (the session's and
//                 its subagents'), decision-like candidates, PRs and issues,
//                 files, the diff stat, the last test run, turns, cost, backends
//   promptFor()   the one model call's input, capped like a handoff (lib/handoff.mjs)
//   parseReply()  the model's JSON, normalized; null when it is not usable
//   draft()       the editable preview: every item with a checkbox, starred
//                 items ticked, heuristic candidates not, conflicts unresolved
//   plan()        exactly what Finish writes, from the edited preview
//   recordBody()  the session record's markdown
//
// Nothing here writes: lib/routes/wrapup.mjs runs Finish.
import path from 'node:path';
import { digest } from './digest.mjs';
import { HANDOFF_BUDGET, lastTestRun } from './handoff.mjs';
import { extractJson } from './narrator.mjs';

// The same cap as a handoff: room to work on a 64k local model.
export const WRAPUP_BUDGET = HANDOFF_BUDGET;
const CONFLICT_CHOICES = ['old', 'new', 'both'];
const MAX = { stars: 40, candidates: 20, files: 60, refs: 12, decisions: 30, items: 20 };

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const text = (s, n = 4000) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const firstSentence = (s, n = 100) => clip(String(s ?? '').split(/(?<=[.!?])\s+|\n+/)[0], n);
const tsOf = (t) => typeof t === 'number' ? t : Date.parse(t || '') || 0;
const nnnn = (v) => /^\d{1,4}$/.test(String(v ?? '').trim()) ? String(v).trim().padStart(4, '0') : null;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The events a wrap-up covers: all of them, or (a follow-up) only those after the last wrap-up. */
export function eventsSince(events, since = null) {
  if (!since) return events || [];
  const at = tsOf(since);
  return (events || []).filter(e => tsOf(e.ts) > at);
}

/**
 * What the deck knows about the session, no model. `stars` are the session's
 * own ({ key: star }); `subStars` [{ sessionId, stars }] its subagents'.
 * `since` (ISO) limits it to what happened after the last wrap-up. `files` are
 * paths it touched; `work` is gitinfo changes(); `refs` ghrefs with state.
 */
export function gather({ summary = {}, events = [], since = null, stars = {}, subStars = [], candidates = [], refs = [], files = [], work = null,
  costUsd = null, costBefore = null, backends = [] } = {}) {
  const evs = eventsSince(events, since);
  const at = tsOf(since);
  const keep = (st) => !since || tsOf(st.at) > at || (st.ts && tsOf(st.ts) > at);
  const starList = [];
  for (const [key, st] of Object.entries(stars || {})) if (keep(st)) starList.push({ key, session: summary.id || null, ...st });
  for (const { sessionId, stars: s } of subStars || []) for (const [key, st] of Object.entries(s || {})) if (keep(st)) starList.push({ key, session: sessionId, sub: true, ...st });
  starList.sort((a, b) => tsOf(a.ts || a.at) - tsOf(b.ts || b.at));
  const starred = new Set(starList.map(s => s.key));
  const cands = (candidates || []).filter(c => !starred.has(c.eventId) && (!since || tsOf(c.ts) > at));
  const times = evs.map(e => tsOf(e.ts)).filter(Boolean);
  return {
    session: { id: summary.id || null, title: summary.title || null, cwd: summary.cwd || null, branch: summary.gitBranch || null, harness: summary.harness || null, model: summary.model || null },
    since: since || null,
    stats: {
      turns: evs.filter(e => e.kind === 'prompt').length,
      events: evs.length,
      costUsd: costUsd == null ? null : Math.max(0, costUsd - (since && costBefore != null ? costBefore : 0)),
      durationMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
      backends: [...new Set((backends || []).filter(Boolean))],
    },
    stars: starList,
    candidates: cands,
    refs: (refs || []).map(r => ({ kind: r.kind, repo: r.repo, number: r.number, url: r.url, title: r.title || null, state: r.state || null, ci: r.ci || null, branch: r.branch || undefined })),
    files: [...new Set(files || [])],
    work: workFacts(work),
    lastTest: lastTestRun(evs),
  };
}

/** gitinfo changes() as the record's "not committed" facts, or null when there is nothing uncommitted. */
export function workFacts(work) {
  if (!work?.repo || !work.files?.length) return null;
  const t = work.totals || {};
  return { files: t.files ?? work.files.length, added: t.added || 0, deleted: t.deleted || 0, branch: work.branch || null,
    list: work.files.slice(0, 40).map(f => ({ path: f.path, status: f.untracked ? '??' : `${f.x || ''}${f.y || ''}`.trim(), added: f.added ?? null, deleted: f.deleted ?? null })) };
}

// ------------------------------------------------------------ the model call
export const SYSTEM = [
  'You wrap up a finished coding session for the durable record of the workstream (a long effort) it belongs to.',
  'Read what the pilot starred first: that is their judgement. Decision-like sentences found by a heuristic may be noise.',
  'Reply with ONE JSON object and nothing else:',
  '{"summary": "2-5 sentences: what the session did and where it ended",',
  ' "decisions": [{"title": "short imperative", "body": "why, in a sentence or two", "supersedes": "NNNN of an existing decision it replaces, or null", "source": "the event id it came from, or null"}],',
  ' "notes": ["things learned worth keeping"],',
  ' "questions": ["open questions"],',
  ' "next": "the next step",',
  ' "workstreamSummary": "the workstream summary rewritten to take this session in, or null to leave it as is",',
  ' "conflicts": [{"existing": "NNNN", "decision": 0, "why": "how decision #0 above contradicts it"}]}',
  'Only real decisions (a choice between alternatives that was made). Keep it short. No secrets, tokens or passwords.',
].join('\n');

/**
 * The model's input: the gathered material, the workstream's summary and
 * active decisions, and the session's text fitted into what is left of
 * `budget` (newest kept, every prompt kept). Never longer than `budget`.
 */
export function promptFor({ material, events = [], workstream = null, budget = WRAPUP_BUDGET }) {
  const m = material;
  const head = [];
  if (workstream) {
    const active = (workstream.decisions || []).filter(d => (d.status || 'active') === 'active').slice(-MAX.decisions);
    head.push(`## Workstream: ${clip(workstream.title, 120)}${workstream.goal ? `\nGoal: ${clip(workstream.goal, 400)}` : ''}\n` +
      `Current summary: ${text(workstream.summary, 1500) || '(none yet)'}\n` +
      `Active decisions:\n${active.length ? active.map(d => `- ${String(d.n).padStart(4, '0')} ${clip(d.title, 120)}`).join('\n') : '(none)'}`);
  } else head.push('## Workstream: none (a loose session)');
  const s = m.stats;
  head.push(`## Session: ${clip(m.session.title, 120) || m.session.id}\n` + [
    m.session.branch ? `Branch: ${m.session.branch}` : null,
    s.backends.length ? `Ran on: ${s.backends.join(', ')}` : null,
    `${plural(s.turns, 'turn')}${s.costUsd != null ? `, $${s.costUsd.toFixed(2)}` : ''}${s.durationMs ? `, ${Math.round(s.durationMs / 60000)} min` : ''}`,
    m.since ? `This is a follow-up: only what happened since ${m.since}.` : null,
  ].filter(Boolean).join('\n'));
  if (m.stars.length) head.push(`## Starred by the pilot\n${m.stars.slice(-MAX.stars).map(st =>
    `- [${st.tag}]${st.kind === 'file' ? ` file ${st.key}` : ` (event ${st.key})`}${st.comment ? ` "${clip(st.comment, 200)}"` : ''}: ${clip(st.excerpt, 300)}`).join('\n')}`);
  if (m.candidates.length) head.push(`## Decision-like sentences (heuristic)\n${m.candidates.slice(-MAX.candidates).map(c => `- (event ${c.eventId}) ${clip(c.sentence, 240)}`).join('\n')}`);
  if (m.refs.length) head.push(`## PRs and issues\n${m.refs.slice(0, MAX.refs).map(r => `- ${r.kind === 'pr' ? 'PR' : 'issue'} ${r.repo}#${r.number}${r.title ? ` ${clip(r.title, 100)}` : ''}${r.state ? ` (${r.state}${r.ci ? `, CI ${r.ci}` : ''})` : ''}`).join('\n')}`);
  if (m.files.length) head.push(`## Files touched\n${m.files.slice(0, MAX.files).map(f => `- ${f}`).join('\n')}${m.files.length > MAX.files ? `\n- …and ${m.files.length - MAX.files} more` : ''}`);
  if (m.work) head.push(`## Not committed\n${plural(m.work.files, 'file')}, +${m.work.added} −${m.work.deleted}`);
  if (m.lastTest) head.push(`## Last test run (${m.lastTest.failed ? 'failed' : 'passed'})\n$ ${clip(m.lastTest.command, 200)}`);
  const tail = '\n\nReply with the JSON object only.';
  // The material is capped to leave the conversation at least a quarter.
  let top = head.join('\n\n');
  const most = Math.floor(budget * 0.75);
  if (top.length > most) top = top.slice(0, most - 1) + '…';
  const room = budget - top.length - tail.length - 40;
  const conv = room > 200 ? digest(eventsSince(events, m.since), room) : '';
  const prompt = `${top}\n\n## Conversation\n${conv || '(nothing recorded)'}${tail}`;
  return { system: SYSTEM, prompt: prompt.length > budget ? prompt.slice(0, budget) : prompt, budget };
}

/**
 * The model's reply as { summary, decisions, notes, questions, next,
 * workstreamSummary, conflicts }, cleaned; null when it is not that JSON.
 * `decisions` are the workstream's (for supersedes and conflicts to name real ones).
 */
export function parseReply(raw, { decisions = [] } = {}) {
  const j = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const keys = ['summary', 'decisions', 'notes', 'questions', 'next', 'workstreamSummary', 'conflicts'];
  if (!keys.some(k => k in j)) return null;
  const known = new Set((decisions || []).filter(d => (d.status || 'active') === 'active').map(d => String(d.n).padStart(4, '0')));
  const strs = (v) => (Array.isArray(v) ? v : []).map(x => typeof x === 'string' ? text(x, 600) : typeof x?.text === 'string' ? text(x.text, 600) : '').filter(Boolean).slice(0, MAX.items);
  const decs = (Array.isArray(j.decisions) ? j.decisions : []).filter(d => d && typeof d.title === 'string' && d.title.trim()).slice(0, MAX.items)
    .map(d => ({ title: clip(d.title, 160), body: text(d.body, 1500), supersedes: known.has(nnnn(d.supersedes)) ? nnnn(d.supersedes) : null, source: typeof d.source === 'string' ? clip(d.source, 80) || null : null }));
  const conflicts = (Array.isArray(j.conflicts) ? j.conflicts : []).map(c => {
    const existing = nnnn(c?.existing);
    let i = Number.isInteger(c?.decision) ? c.decision : typeof c?.decision === 'string' ? decs.findIndex(d => d.title.toLowerCase() === c.decision.trim().toLowerCase()) : -1;
    if (!(i >= 0 && i < decs.length)) i = -1;
    return existing && known.has(existing) && i >= 0 ? { existing, decision: i, why: text(c.why, 600) } : null;
  }).filter(Boolean);
  const ws = typeof j.workstreamSummary === 'string' ? text(j.workstreamSummary, 4000) : '';
  return { summary: typeof j.summary === 'string' ? text(j.summary, 3000) : '', decisions: decs, notes: strs(j.notes), questions: strs(j.questions),
    next: typeof j.next === 'string' ? text(j.next, 1000) : '', workstreamSummary: ws || null, conflicts };
}

// ------------------------------------------------------------ the preview
/**
 * The editable preview. Starred items come ticked, heuristic candidates and
 * touched files unticked, the summary fields blank to fill by hand; a model
 * `reply` (parseReply) is merged in by mergeReply(). `workstream` is the
 * store's detail (null for a loose session); `artifacts` are files outside any
 * repo, offered for the Vault; `repoOf(path)` a file's repo.
 */
export function draft({ material, reply = null, workstream = null, artifacts = [], repoOf = () => null, followup = null, date, title, worktrees = [] } = {}) {
  const m = material;
  let n = 0;
  const key = (p) => `${p}${++n}`;
  const src = (st) => ({ session: st.session, ...(st.kind === 'event' ? { event: st.key } : {}) });
  const decisions = [], notes = [], questions = [], files = [], vault = [];
  for (const st of m.stars) {
    if (st.kind === 'file') {
      if (st.tag === 'vault') vault.push({ key: key('v'), on: true, path: st.key, why: st.comment || '', origin: 'star' });
      else files.push({ key: key('f'), on: true, path: st.key, repo: repoOf(st.key), why: st.comment || '', origin: 'star', source: { session: st.session } });
      continue;
    }
    const said = st.comment ? `${st.comment}: ${firstSentence(st.excerpt, 200)}` : firstSentence(st.excerpt, 300);
    if (st.tag === 'decision') decisions.push({ key: key('d'), on: true, title: clip(st.comment, 160) || firstSentence(st.excerpt), body: text(st.excerpt, 1500), supersedes: null, source: src(st), origin: 'star', conflict: null });
    else if (st.tag === 'question') questions.push({ key: key('q'), on: true, text: said, source: src(st), origin: 'star' });
    else notes.push({ key: key('n'), on: true, text: said, source: src(st), origin: 'star' });
  }
  for (const c of m.candidates) decisions.push({ key: key('d'), on: false, title: clip(c.sentence, 160), body: '', supersedes: null, source: { session: m.session.id, event: c.eventId }, origin: 'candidate', conflict: null });
  const starredFiles = new Set(files.map(f => f.path));
  for (const p of m.files) if (!starredFiles.has(p) && !vault.some(v => v.path === p)) files.push({ key: key('f'), on: false, path: p, repo: repoOf(p), why: '', origin: 'touched', source: { session: m.session.id } });
  for (const p of artifacts) if (!vault.some(v => v.path === p)) vault.push({ key: key('v'), on: false, path: p, why: '', origin: 'artifact' });
  const preview = {
    sessionId: m.session.id, title: title || m.session.title || m.session.id, date, slug: workstream?.slug || null, followup,
    model: null,
    summary: { on: true, text: '' },
    next: { on: !!workstream, text: '' },
    wsSummary: workstream ? { on: false, text: '', was: workstream.summary || '' } : null,
    decisions, notes, questions, files,
    links: m.refs.map(r => ({ key: key('l'), on: true, ...r })),
    vault,
    worktrees,
    facts: { stats: m.stats, work: m.work, lastTest: m.lastTest ? { command: m.lastTest.command, failed: m.lastTest.failed } : null, since: m.since },
  };
  return reply ? mergeReply(preview, reply, workstream) : preview;
}

/**
 * The model's reply merged into a preview the pilot may have edited already:
 * blank summary fields filled, nothing typed overwritten; each of its decisions
 * merged into the starred or candidate one from the same event (and ticked),
 * else added ticked; a conflict rides on its decision, unresolved. A new preview.
 */
export function mergeReply(p, reply, workstream = null) {
  const out = structuredClone(p);
  let n = 0;
  const key = (x) => `m${x}${++n}`;
  const blank = (f) => f && !String(f.text || '').trim();
  if (blank(out.summary)) out.summary.text = reply.summary || '';
  if (blank(out.next)) out.next.text = reply.next || '';
  if (out.wsSummary && blank(out.wsSummary) && reply.workstreamSummary) Object.assign(out.wsSummary, { text: reply.workstreamSummary, on: true });
  // The reply may have been drafted against another workstream: only ids of this one's active decisions stand.
  const active = (workstream?.decisions || []).filter(d => (d.status || 'active') === 'active');
  const titles = new Map(active.map(d => [String(d.n).padStart(4, '0'), d.title]));
  for (const [i, d0] of (reply.decisions || []).entries()) {
    const d = { ...d0, supersedes: titles.has(nnnn(d0.supersedes)) ? nnnn(d0.supersedes) : null };
    const c = (reply.conflicts || []).find(x => x.decision === i && titles.has(nnnn(x.existing)));
    const conflict = c ? { with: c.existing, title: titles.get(c.existing) || '', why: c.why, choice: null } : null;
    const same = d.source && out.decisions.find(x => x.source?.event === d.source && x.origin !== 'model');
    if (same) { Object.assign(same, { on: true, title: d.title, body: d.body || same.body, supersedes: d.supersedes, conflict, origin: same.origin === 'candidate' ? 'model' : 'star+model' }); continue; }
    out.decisions.push({ key: key('d'), on: true, title: d.title, body: d.body, supersedes: d.supersedes, source: { session: out.sessionId, ...(d.source ? { event: d.source } : {}) }, origin: 'model', conflict });
  }
  for (const t of reply.notes || []) out.notes.push({ key: key('n'), on: true, text: t, source: { session: out.sessionId }, origin: 'model' });
  for (const t of reply.questions || []) out.questions.push({ key: key('q'), on: true, text: t, origin: 'model' });
  out.model = { ok: true };
  return out;
}

// ------------------------------------------------------------ Finish
/**
 * What Finish writes, from the edited preview: only ticked items, conflicts
 * resolved (old: the new decision is dropped; new: it supersedes the old;
 * both: both stay active). A loose session (no slug) writes its record only;
 * the rest goes into the record's body. Throws (code 400) on an unresolved conflict,
 * unless `draft` (the record's preview): then it counts as keep both.
 */
export function plan(p, { queued = [], draft = false, facts = null, followup } = {}) {
  if (!p || typeof p !== 'object' || !p.sessionId) throw Object.assign(new Error('a wrap-up preview is required'), { code: 400 });
  const on = (xs) => (Array.isArray(xs) ? xs : []).filter(x => x && x.on);
  const decisions = [], unresolved = [];
  for (const d of on(p.decisions)) {
    if (!String(d.title || '').trim()) continue;
    let supersedes = nnnn(d.supersedes);
    if (d.conflict) {
      let choice = CONFLICT_CHOICES.includes(d.conflict.choice) ? d.conflict.choice : null;
      if (!choice) {
        const msg = `decision “${clip(d.title, 60)}” conflicts with ${d.conflict.with}: keep old, take new, or keep both?`;
        if (!draft) throw Object.assign(new Error(msg), { code: 400 });
        unresolved.push(msg); choice = 'both';
      }
      if (choice === 'old') continue;
      supersedes = choice === 'new' ? nnnn(d.conflict.with) : supersedes === nnnn(d.conflict.with) ? null : supersedes;
    }
    decisions.push({ title: clip(d.title, 160), body: text(d.body, 4000), supersedes, source: d.source && typeof d.source === 'object' ? { session: d.source.session || null, event: d.source.event || null } : null });
  }
  const notes = on(p.notes).map(x => ({ text: text(x.text, 1000), source: x.source?.session ? { session: x.source.session, ...(x.source.event ? { event: x.source.event } : {}) } : null })).filter(x => x.text);
  const questions = on(p.questions).map(x => text(x.text, 1000)).filter(Boolean);
  const files = on(p.files).filter(f => f.path).map(f => {
    const repo = f.repo || null;
    const rel = repo && path.isAbsolute(f.path) && !path.relative(repo, f.path).startsWith('..') ? path.relative(repo, f.path).split(path.sep).join('/') : f.path;
    return { repo, path: rel, sha: f.sha || null, why: clip(f.why, 300), source: { session: p.sessionId } };
  });
  const links = on(p.links).filter(l => l.repo && l.number).map(l => ({ kind: l.kind === 'pr' ? 'pr' : 'issue', repo: l.repo, number: Number(l.number), url: l.url || null, title: l.title || null, state: l.state || null, ci: l.ci || null }));
  const vault = on(p.vault).map(v => String(v.path)).filter(Boolean);
  const summary = p.summary?.on ? text(p.summary.text, 4000) : '';
  const next = p.next?.on ? text(p.next.text, 1000) : '';
  const patch = {};
  if (p.slug) {
    if (p.wsSummary?.on && String(p.wsSummary.text || '').trim()) patch.summary = text(p.wsSummary.text, 6000);
    if (next) patch.next = next;
    if (questions.length) patch.questions = questions.map(q => `- ${q}`).join('\n');
  }
  const worktrees = (Array.isArray(p.worktrees) ? p.worktrees : []).filter(w => w?.path && w.choice && w.choice !== 'keep' && (w.choices || []).includes(w.choice))
    .map(w => ({ path: String(w.path), action: String(w.choice) }));
  const fu = followup !== undefined ? followup : p.followup || null;
  const out = { slug: p.slug || null, title: clip(p.title, 200) || p.sessionId, date: p.date, decisions, notes, questions, files, links, vault, summary, next, patch, worktrees, followup: fu, unresolved };
  out.body = recordBody({ ...out, sessionId: p.sessionId, facts: facts || p.facts || {}, queued });
  // Loose: nothing outside the record, which carries it all.
  if (!out.slug) Object.assign(out, { decisions: [], notes: [], files: [], links: [], patch: {} });
  return out;
}

const WT_DONE = { remove: 'removed', keep: 'kept', stash: 'stashed and removed', 'remove-anyway': 'removed with its unmerged work', 'push-remove': 'pushed and removed', forget: 'forgotten' };
const fmtMin = (ms) => !ms ? null : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;

/** The session record's markdown body (its frontmatter is the store's). */
export function recordBody({ sessionId, title, decisions = [], notes = [], questions = [], files = [], links = [], vault = [], summary = '', next = '', facts = {}, followup = null, queued = [] }) {
  const s = facts.stats || {};
  const out = [`# ${title}`];
  out.push([`Session \`${sessionId}\``, s.backends?.length ? s.backends.join(' → ') : null, s.turns != null ? plural(s.turns, 'turn') : null,
    s.costUsd != null ? `$${Number(s.costUsd).toFixed(2)}` : null, fmtMin(s.durationMs)].filter(Boolean).join(' · '));
  if (followup?.href) out.push(`Follow-up to [the first wrap-up](${followup.href}), covering what happened since.`);
  out.push(`## Summary\n\n${summary || '_No summary._'}`);
  if (decisions.length) out.push(`## Decisions\n\n${decisions.map(d => `- ${d.title}${d.supersedes ? ` (supersedes ${d.supersedes})` : ''}${d.body ? `: ${clip(d.body, 400)}` : ''}`).join('\n')}`);
  if (notes.length) out.push(`## Notes\n\n${notes.map(x => `- ${x.text}`).join('\n')}`);
  if (questions.length) out.push(`## Open questions\n\n${questions.map(q => `- ${q}`).join('\n')}`);
  if (next) out.push(`## Next step\n\n${next}`);
  if (links.length) out.push(`## PRs and issues\n\n${links.map(l => `- [${l.kind === 'pr' ? 'PR' : 'Issue'} ${l.repo}#${l.number}](${l.url || `https://github.com/${l.repo}/${l.kind === 'pr' ? 'pull' : 'issues'}/${l.number}`})${l.title ? ` ${l.title}` : ''}${l.state ? ` (${[l.state, l.ci ? `CI ${l.ci}` : null].filter(Boolean).join(', ')})` : ''}`).join('\n')}`);
  if (files.length) out.push(`## Files\n\n${files.map(f => `- \`${f.path}\`${f.why ? `: ${f.why}` : ''}`).join('\n')}`);
  const w = facts.work;
  if (w) out.push(`## Not committed at wrap-up\n\n${plural(w.files, 'file')}, +${w.added} −${w.deleted}${w.branch ? ` on ${w.branch}` : ''}${w.stashed ? '; stashed at Finish' : ''}`);
  const wts = facts.worktrees || [];
  if (wts.length) out.push(`## Worktrees\n\n${wts.map(x => `- \`${x.branch || path.posix.basename(String(x.path))}\` (${x.state}): ${x.action ? WT_DONE[x.action] || x.action : 'left as it is'}`).join('\n')}`);
  if (facts.lastTest) out.push(`## Last test run\n\n${facts.lastTest.failed ? 'Failed' : 'Passed'}: \`${clip(facts.lastTest.command, 200)}\``);
  if (vault.length) out.push(`## Saved to the Vault\n\n${plural(vault.length, 'file')} (local only; pointers in vault.json)`);
  if (queued.length) out.push(`## Queued, not sent\n\n${queued.map(q => `- ${clip(q, 500)}`).join('\n')}`);
  return out.join('\n\n') + '\n';
}

/** Every text Finish would write, for the scrubber's preview. */
export function textsOf(pl) {
  return [pl.body, pl.title, ...pl.decisions.flatMap(d => [d.title, d.body]), ...pl.notes.map(x => x.text), ...Object.values(pl.patch || {}),
    ...pl.files.map(f => f.why), ...pl.links.map(l => l.title)].filter(Boolean).join('\n');
}

// ------------------------------------------------------------ worktree choices
/**
 * The preview's worktree rows, from #32's planner: the choices its decision
 * table gives once this session has ended, the safe one (merged or empty →
 * remove) preselected. Unmerged or dirty work has nothing preselected, not
 * even keep: left unchosen, Finish leaves it as it is.
 */
export function worktreeRows(items) {
  return (items || []).map(({ record: r, decision: d }) => ({
    path: r.path, branch: r.branch || null, state: d.state, choices: d.choices, safe: d.safe || null,
    choice: d.safe || null, warning: d.warning || null, dirty: d.dirty || 0, unmerged: d.unmerged ?? null, deleteBranch: !!d.deleteBranch,
  }));
}

// ------------------------------------------------------------ deck state
/**
 * Which sessions were wrapped up: deck.ns('wrapup'), id → { at, slug, record,
 * count, costUsd, reopened }. A wrapped session leaves the rail; resuming it
 * marks it reopened, and its next wrap-up is a follow-up covering what came since.
 */
export class WrapState {
  constructor(space) { this.space = space; }
  get(id) { return this.space.get(id, null); }
  isWrapped(id) { const w = this.get(id); return !!w && !w.reopened; }
  mark(id, { slug, record, costUsd = null, at = new Date().toISOString() }) {
    const was = this.get(id);
    const w = { at, slug: slug || null, record, first: was?.first || record, count: (was?.count || 0) + 1, costUsd, ...(was?.removed?.length ? { removed: was.removed } : {}) };
    this.space.set(id, w);
    return w;
  }
  /** Worktrees Finish removed ({ record, head }), so a resume can put them back where the agent left them. */
  removed(id, list) {
    const w = this.get(id); if (!w) return;
    if (list === undefined) return w.removed || [];
    if (list.length) w.removed = list; else delete w.removed;
    this.space.set(id, w);
  }
  reopen(id, at = new Date().toISOString()) {
    const w = this.get(id);
    if (!w || w.reopened) return null;
    w.reopened = at;
    this.space.set(id, w);
    return w;
  }
  /** What a summary carries: { at, slug, reopened? } or null. */
  public(id) { const w = this.get(id); return w ? { at: w.at, slug: w.slug, count: w.count, ...(w.reopened ? { reopened: w.reopened } : {}) } : null; }
}

const states = new WeakMap();
export function wrapStateFor(deck) {
  if (!states.has(deck)) states.set(deck, new WrapState(deck.ns('wrapup')));
  return states.get(deck);
}

export const COMMIT_PROMPT = 'Before this session is wrapped up: commit your uncommitted work on the current branch with a clear message. '
  + 'Only commit; do not push, open a PR, or start anything new. Say in one line what you committed.';
