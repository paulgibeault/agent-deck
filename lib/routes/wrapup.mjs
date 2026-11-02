// lib/routes/wrapup.mjs — wrap-up (#36, lib/wrapup.mjs): the pre-checks and the
// no-model preview, the one model call (only when the pilot asks), the
// scrubbed record as it would be written, and Finish.
//   GET  /api/sessions/:id/wrapup[?slug=<slug>|loose]   { precheck, preview }; ?precheck=1 the pre-checks alone
//   POST /api/sessions/:id/wrapup/draft    { preview }  the model call, once per wrap-up; its reply merged in
//   POST /api/sessions/:id/wrapup/render   { preview, queue }  → { body, redactions }
//   POST /api/sessions/:id/wrapup/commit   ask the agent to commit (one prompt)
//   POST /api/sessions/:id/wrapup/finish   { preview, queue: drop|keep, work: leave|stash }
//
// Finish, in order: stash (only if the pilot chose it), copy the ticked Vault
// files, one commit to the workstreams repo and a push, end the agent (deny its
// pending permissions, clear its queue, stop it), mark the session wrapped, then
// run the worktree choices the preview showed, each re-checked by #32's act().
// Nothing is removed that the pilot did not choose. A session resumed after
// wrap-up is marked reopened (its removed worktree put back first); its next
// wrap-up writes a follow-up record.
import fs from 'node:fs';
import path from 'node:path';
import { deckStore } from './workstreams.mjs';
import { starsFor, candidates as candidatesOf } from '../stars.mjs';
import { worktreesFor, decide, inside, git } from '../worktrees.mjs';
import { vaultFor, repoOf } from '../vault.mjs';
import { refsFromEvents } from '../ghrefs.mjs';
import * as gitinfo from '../gitinfo.mjs';
import { gather, promptFor, parseReply, draft, mergeReply, plan, textsOf, worktreeRows, workFacts, wrapStateFor, COMMIT_PROMPT } from '../wrapup.mjs';

const PATTERN = /^\/api\/sessions\/([^/]+)\/wrapup(?:\/(draft|render|commit|finish))?$/;
const VAULT_FILE_MAX = 256 << 10;
const VAULT_TOTAL_MAX = 8 << 20;
const VAULT_TTL_MS = 60_000;
// A model draft is kept for the wrap-up in progress: this session into this workstream, for an hour.
const DRAFT_TTL_MS = 60 * 60_000;
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'target']);

/**
 * The Vault's text, for the scrubber (store.setVault): any 12+ char line of it
 * quoted in a write is redacted. Read synchronously (the store asks inside a
 * write), capped, and cached until the Vault commits or a minute passes.
 */
export function vaultText(dirOf) {
  let cache = { key: null, at: 0, texts: [] };
  return () => {
    let dir; try { dir = dirOf(); } catch { return []; }
    if (!dir || !fs.existsSync(dir)) return [];
    let stamp = 0; try { stamp = fs.statSync(path.join(dir, '.git', 'index')).mtimeMs; } catch { /* not committed yet */ }
    const key = `${dir}|${stamp}`;
    if (cache.key === key && Date.now() - cache.at < VAULT_TTL_MS) return cache.texts;
    const texts = []; let total = 0;
    const walk = (d) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (total >= VAULT_TOTAL_MAX) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
        if (!e.isFile() || e.name.endsWith('.meta.json')) continue;
        try {
          const st = fs.statSync(p);
          if (st.size > VAULT_FILE_MAX) continue;
          const buf = fs.readFileSync(p);
          if (buf.subarray(0, 8000).includes(0)) continue;   // binary
          texts.push(buf.toString('utf8')); total += st.size;
        } catch { /* gone or unreadable */ }
      }
    };
    walk(dir);
    cache = { key, at: Date.now(), texts };
    return texts;
  };
}

const err = (msg, code) => Object.assign(new Error(msg), { code });

export default function routes(ctx) {
  const { send, readBody, deck, index, agents, narrator, broadcast, scheduleSnapshot, github } = ctx;
  if (!deck) return [];
  const store = deckStore(deck);
  const wraps = wrapStateFor(deck);
  store.setVault(vaultText(() => vaultFor(deck).dir));
  // Wrapped sessions count as finished for the Worktrees dialog's orphans.
  const svc = worktreesFor(ctx, { wrapped: (id) => wraps.isWrapped(id) });
  // `${session}|${slug or loose}` -> { reply, model, error, at }: the one model call of the wrap-up in progress.
  const drafts = new Map();
  const draftKey = (id, slug) => `${id}|${slug || 'loose'}`;
  const draftOf = (id, slug) => {
    const k = draftKey(id, slug); const d = drafts.get(k);
    if (d && Date.now() - d.at > DRAFT_TTL_MS) { drafts.delete(k); return null; }
    return d || null;
  };
  const dropDrafts = (id) => { for (const k of drafts.keys()) if (k.startsWith(`${id}|`)) drafts.delete(k); };
  /**
   * The follow-up link for a record of `id` going into `slug`'s area: the first record when it is
   * in the same area (the store decides, as it names the file), else the session's first wrap-up
   * elsewhere by a path that resolves from <area>/sessions/, else none.
   */
  const followupFor = (id, slug) => {
    const w = wraps.get(id);
    const same = store.ready() ? store.firstRecord(slug, id) : null;
    if (same) return { first: `sessions/${same}`, href: same, at: w?.at || null };
    if (w?.first) return { first: w.first, href: `../../${w.first}`, at: w.at, elsewhere: true };
    return null;
  };

  if (index) index.wrappedOf = (id) => {
    const w = wraps.public(id);
    if (!w || w.reopened) return w;
    // Resumed outside the deck (a terminal): its registry entry started after the wrap-up.
    const r = index.registry?.get(id);
    if (r?.alive && Number(r.startedAt) > Date.parse(w.at)) { wraps.reopen(id); return wraps.public(id); }
    return w;
  };
  // Resumed in the deck: a process for it that started after the wrap-up.
  agents?.on?.('change', (st) => {
    if (!st?.alive || !st.startedAt) return;
    const w = wraps.get(st.id);
    if (w && !w.reopened && st.startedAt > Date.parse(w.at)) { wraps.reopen(st.id); broadcast?.('wrapup.changed', { sessionId: st.id, reopened: true }); }
  });
  // Resuming a session whose worktree Finish removed: put the worktree back first, at the
  // same path (the agent's own history is keyed by it), on its branch or, once that is gone,
  // a new one at the commit it was at. Merged or empty work loses nothing either way.
  // wakeable stays synchronous (a move's plan asks it); this runs only when a resume really starts.
  if (agents && typeof agents.wakeable === 'function') {
    const before = agents.beforeWake;
    agents.beforeWake = async (id) => {
      if (before) await before(id);
      const w = agents.wakeable(id);
      if (w?.cwd && !fs.existsSync(w.cwd)) await restoreWorktree(id, w.cwd).catch(() => false);
    };
  }
  async function restoreWorktree(id, cwd) {
    const gone = wraps.removed(id) || [];
    // The folder is gone, so compare through its parent's real path (/tmp is /private/tmp on macOS).
    const realish = (p) => { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } };
    const it = gone.find(x => x.record?.path && realish(x.record.path) === realish(cwd));
    if (!it || fs.existsSync(cwd)) return false;
    const { record: rec, head } = it;
    const has = rec.branch && (await git(rec.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${rec.branch}`])).ok;
    await git(rec.repo, ['worktree', 'prune']);
    const r = has ? await git(rec.repo, ['worktree', 'add', rec.path, rec.branch])
      : rec.branch && head ? await git(rec.repo, ['worktree', 'add', '-b', rec.branch, rec.path, head]) : { ok: false };
    if (!r.ok) return false;
    svc.put({ ...rec, restored: Date.now() });
    wraps.removed(id, gone.filter(x => x !== it));
    broadcast?.('worktrees.update', { at: Date.now() });
    return true;
  }

  const fail = (res, e) => send(res, Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : e.status || 500, { error: e.message, ...(e.conflict ? { conflict: e.conflict } : {}), ...(e.dirty ? { dirty: e.dirty } : {}) });

  function sessionOf(id) {
    const summary = index?.summary(id);
    if (!summary || summary.kind !== 'session') throw err('unknown session', 404);
    const entry = index.load(id);
    return { summary, entry, events: entry?.state.events || [] };
  }
  const harnessLabel = (name) => agents?.harnessList?.().find(x => x.name === name)?.label || name;

  /** Which workstream: ?slug (picked in the dialog; 'loose' for none), else the session's own. */
  function slugFor(summary, asked) {
    if (asked === 'loose') return null;
    const slug = asked || summary.workstream?.slug || null;
    if (slug && !store.exists(slug)) throw err(`no such workstream: ${slug}`, 404);
    return slug;
  }

  /** The no-model material, the workstream and everything the preview needs. */
  async function collect(id, slug) {
    const { summary, entry, events } = sessionOf(id);
    const w = wraps.get(id);
    const since = w ? w.at : null;
    const stars = starsFor(deck);
    const subStars = (summary.subagents || []).map(a => ({ sessionId: a.id, stars: stars.list(a.id) }));
    const cwd = summary.cwd || null;
    const where = cwd ? await gitinfo.place(cwd).catch(() => null) : null;
    let refs = refsFromEvents(events, { repo: where?.github?.repo || null, pr: summary.pr });
    if (github && (refs.length || where?.github?.repo)) {
      const branch = summary.gitBranch && summary.gitBranch !== 'HEAD' ? summary.gitBranch : where?.branch;
      const enriched = github.enrich(refs, { repo: where?.github?.repo || null, branch, defaultBranch: where?.defaultBranch }).catch(() => null);
      refs = (await Promise.race([enriched, new Promise(r => setTimeout(r, 2500, null))])) || refs;
    }
    const sinceMs = since ? Date.parse(since) : 0;
    const files = (entry?.state.filesList?.() || []).filter(f => !sinceMs || Date.parse(f.lastTs || '') > sinceMs).map(f => f.path).filter(Boolean);
    const work = cwd ? await gitinfo.changes(cwd).catch(() => null) : null;
    const lineage = agents?.lineageOf?.(id);
    const costUsd = index.brief(id)?.cost?.totalCostUSD ?? agents?.publicState(id)?.totalCostUsd ?? null;
    const material = gather({ summary, events, since, stars: stars.list(id), subStars, candidates: candidatesOf(events), refs, files, work,
      costUsd, costBefore: w?.costUsd ?? null, backends: [lineage?.from?.harness, summary.harness].filter(Boolean).map(harnessLabel) });
    const workstream = slug ? store.get(slug) : null;
    return { summary, events, material, workstream, work, since, w };
  }

  /** The session's worktrees as they will stand once it ends: #32's decision table, with only other sessions counting as in use. */
  async function worktreesOf(id) {
    const items = await svc.planCleanup({ sessionId: id }).catch(() => []);
    const others = svc.live().filter(s => s.id !== id);
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    return worktreeRows(items.map(it => {
      const busy = others.some(s => s.cwd && inside(real(s.cwd), real(it.record.path)));
      return { ...it, decision: decide(it.facts, { alive: busy, keepsBranch: it.record.ownBranch === false }) };
    }));
  }

  async function precheck(id, summary, work) {
    const st = agents?.publicState(id);
    const deckRun = !!agents?.running(id);
    const external = !!summary.alive && !deckRun;
    const t = work?.totals || {};
    return {
      // A turn held only by a permission prompt is waiting on the pilot: Finish denies it and ends the turn.
      busy: deckRun ? (st?.status === 'busy' || st?.status === 'starting') && !st?.permissions?.length : external && summary.status === 'busy',
      deckRun, external, alive: !!summary.alive,
      queue: (st?.queue || []).map(q => ({ id: q.id, text: String(q.text || '').slice(0, 300) })),
      permissions: (st?.permissions || []).length,
      work: work?.repo && work.files?.length ? { files: t.files ?? work.files.length, added: t.added || 0, deleted: t.deleted || 0, branch: work.branch || null,
        list: work.files.slice(0, 12).map(f => `${f.untracked ? '??' : `${f.x || ''}${f.y || ''}`.trim()} ${f.path}${f.added != null ? ` +${f.added} −${f.deleted || 0}` : ''}`) } : null,
      workstream: summary.workstream || null,
      store: { ready: store.ready() },
      wrapped: wraps.public(id),
      narrator: ctx.narratorEnabled !== false,
    };
  }

  async function preview(id, slug) {
    const c = await collect(id, slug);
    const artifacts = c.material.files.filter(p => path.isAbsolute(p) && fs.existsSync(p) && !repoOf(p));
    const p = draft({ material: c.material, workstream: c.workstream, artifacts, repoOf, date: new Date().toISOString().slice(0, 10), title: c.summary.title,
      followup: c.w ? followupFor(id, slug) : null, worktrees: await worktreesOf(id) });
    const cached = draftOf(id, slug);
    return { c, preview: cached?.reply ? mergeReply(p, cached.reply, c.workstream) : p, cached };
  }

  /** End the agent: deny what it is waiting on, clear its queue, stop its process. */
  function endAgent(id) {
    const st = agents?.publicState(id);
    if (!st) return { stopped: false, denied: 0, cleared: 0 };
    let denied = 0, cleared = 0;
    for (const p of st.permissions || []) { try { agents.answer(id, p.requestId, 'deny', 'The session is being wrapped up.'); denied++; } catch { /* already answered */ } }
    for (const q of st.queue || []) { try { agents.queueOp(id, { op: 'remove', itemId: q.id }); cleared++; } catch { /* already sent */ } }
    let stopped = false;
    try { stopped = agents.stop(id); } catch { /* not the deck's */ }
    return { stopped, denied, cleared };
  }

  async function exited(id, ms = 8000) {
    const end = Date.now() + ms;
    while (agents?.running(id) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    return !agents?.running(id);
  }

  async function finish(id, body) {
    const { summary } = sessionOf(id);
    if (!store.ready()) throw err('set up the workstreams repo first (Home)', 409);
    // Running outside the deck (a terminal, the desktop app): the deck cannot end it, so it is not wrapped behind its back.
    if (summary.alive && !agents?.running(id)) throw err('it is running outside the deck (a terminal or the desktop app): end it there first, then wrap it up', 409);
    const st = agents?.publicState(id);
    if (agents?.running(id) && (st?.status === 'busy' || st?.status === 'starting') && !st?.permissions?.length) throw err('the session is mid-turn: wait for it, or interrupt it', 409);
    const queued = body.queue === 'keep' ? (st?.queue || []).map(q => q.text).filter(Boolean) : [];
    const p = body.preview;
    const slug = p?.slug || null;
    if (slug && !store.exists(slug)) throw err(`no such workstream: ${slug}`, 404);
    // Facts as they stand now, not as the preview saw them: uncommitted work (after any commit the agent was asked for) and worktrees.
    const work = summary.cwd ? await gitinfo.changes(summary.cwd).catch(() => null) : null;
    const wf = workFacts(work);
    const stash = body.work === 'stash' && !!wf;
    const rows = await worktreesOf(id);
    const chosen = new Map((Array.isArray(p?.worktrees) ? p.worktrees : []).filter(w => w?.path && w.choice).map(w => [w.path, w.choice]));
    // Only this session's worktrees, and only a choice #32's table offers now.
    for (const pth of chosen.keys()) if (!rows.some(r => r.path === pth)) throw err(`not this session's worktree: ${pth}`, 400);
    const live = rows.map(r => ({ ...r, choice: chosen.get(r.path) ?? null }));
    const facts = { ...(p?.facts || {}), work: wf ? { ...wf, stashed: stash } : null,
      worktrees: live.map(r => ({ path: r.path, branch: r.branch, state: r.state, action: r.choice && r.choice !== 'keep' && r.choices.includes(r.choice) ? r.choice : null })) };
    const pl = plan({ ...p, worktrees: live }, { queued, facts, followup: followupFor(id, slug) });
    // A claimed choice the table does not offer now is reported, not run (act() would refuse it too).
    const refused = live.filter(r => r.choice && r.choice !== 'keep' && !r.choices.includes(r.choice));
    const out = { record: null, commit: null, pushed: false, redactions: [], stash: null, vault: null,
      worktrees: refused.map(r => ({ path: r.path, action: r.choice, error: `“${r.choice}” is not a choice for this worktree now (${r.state})` })) };

    // Ticked Vault files first, so their pointers go in the same commit.
    let pointers = [];
    if (pl.vault.length) {
      const v = vaultFor(deck);
      const r = await v.copyArtifacts(pl.vault, { workstream: pl.slug || undefined, source: { sessionId: id } });
      out.vault = { copied: r.copied.map(x => x.rel), skipped: r.skipped };
      pointers = await Promise.all(r.copied.map(x => v.pointer(x.path, { source: id })));
    }
    const head = summary.cwd ? (await git(summary.cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || null : null;
    const r = await store.wrapUp(pl.slug, {
      record: { id, title: pl.title, date: pl.date, body: pl.body, fields: { workstream: pl.slug || 'loose', ...(head ? { head } : {}) } },
      decisions: pl.decisions, notes: pl.notes, files: pl.files.map(f => ({ ...f, sha: f.sha || head })), links: pl.links, vault: pointers, patch: pl.patch,
    });
    Object.assign(out, { record: r.record, commit: r.commit, redactions: r.redactions, decisions: r.decisions });
    out.pushed = await store.flush().then(s => !s.ahead).catch(() => false);
    // Uncommitted work, stashed only on the pilot's word, once the record is safe: a failure here loses nothing written.
    if (stash) {
      const s = await git(summary.cwd, ['stash', 'push', '--include-untracked', '-m', `agent-deck wrap-up ${id.slice(0, 8)}`]);
      if (s.ok) out.stash = (await git(summary.cwd, ['rev-parse', '--short', 'refs/stash'])).stdout.trim() || null;
      else out.stashError = `git stash failed, the work is still in the folder: ${String(s.stderr || '').trim()}`;
    }
    // The agent ends here, and only here.
    Object.assign(out, endAgent(id));
    const costUsd = index.brief(id)?.cost?.totalCostUSD ?? st?.totalCostUsd ?? null;
    out.wrapped = wraps.mark(id, { slug: pl.slug, record: r.record, costUsd });
    dropDrafts(id);
    scheduleSnapshot?.();
    broadcast?.('wrapup.changed', { sessionId: id, wrapped: true, slug: pl.slug, record: r.record });
    // Worktrees: exactly the choices shown, once the agent has let go; act() checks again.
    if (pl.worktrees.length) {
      await exited(id);
      const removed = [];
      for (const w of pl.worktrees) {
        const rec = svc.record(w.path);
        const wh = (await git(w.path, ['rev-parse', 'HEAD'])).stdout?.trim() || null;
        try {
          const a = await svc.act(w.path, w.action);
          out.worktrees.push({ path: w.path, action: w.action, ...a });
          if (a.removed && w.action !== 'forget') removed.push({ record: rec, head: wh });
        } catch (e) { out.worktrees.push({ path: w.path, action: w.action, error: e.message }); }
      }
      if (removed.length) wraps.removed(id, [...wraps.removed(id).filter(x => !removed.some(y => y.record.path === x.record?.path)), ...removed]);
      broadcast?.('worktrees.update', { at: Date.now() });
    }
    return out;
  }

  return [{
    pattern: PATTERN,
    async handler(req, res, { q, m }) {
      const id = decodeURIComponent(m[1]);
      const op = m[2] || null;
      try {
        if (!op) {
          if (req.method !== 'GET') return send(res, 405, { error: 'GET' });
          const { summary } = sessionOf(id);
          // The dialog re-asks while it waits on a turn or a commit: git only, edits kept.
          if (q.get('precheck')) return send(res, 200, { precheck: await precheck(id, summary, summary.cwd ? await gitinfo.changes(summary.cwd).catch(() => null) : null) });
          const slug = slugFor(summary, q.get('slug'));
          const { c, preview: p, cached } = await preview(id, slug);
          return send(res, 200, { precheck: await precheck(id, summary, c.work), preview: p, model: cached ? cached.model || null : null, modelError: cached?.error || null });
        }
        if (req.method !== 'POST') return send(res, 405, { error: 'POST' });
        const body = await readBody(req, 4 << 20);
        if (op === 'draft') {
          if (ctx.narratorEnabled === false || !narrator) throw err('model calls are off (started with --no-narrator)', 409);
          const { summary } = sessionOf(id);
          const slug = body.preview ? body.preview.slug || null : slugFor(summary, body.slug);
          const c = await collect(id, slug);
          let cached = draftOf(id, slug);
          // One call per wrap-up: a second ask gets the first answer. Only a failed call may be asked again.
          if (!cached?.reply) {
            const { system, prompt } = promptFor({ material: c.material, events: c.events, workstream: c.workstream });
            try {
              const r = await narrator.run({ system, prompt, purpose: 'wrapup' });
              const reply = parseReply(r.text, { decisions: c.workstream?.decisions });
              const model = { transport: r.transport, model: r.model, costUsd: r.costUsd, ms: r.durationMs, fellBack: !!r.fellBack, chars: prompt.length };
              cached = reply ? { reply, model } : { reply: null, model, error: 'the model’s reply was not the JSON asked for' };
            } catch (e) { cached = { reply: null, model: null, error: e.message }; }
            cached.at = Date.now();
            drafts.set(draftKey(id, slug), cached);
          }
          const base = body.preview && body.preview.sessionId === id ? body.preview : (await preview(id, slug)).preview;
          return send(res, 200, { preview: cached.reply ? mergeReply(base, cached.reply, c.workstream) : base, model: cached.model, error: cached.error || null });
        }
        if (op === 'render') {
          const st = agents?.publicState(id);
          const queued = body.queue === 'keep' ? (st?.queue || []).map(x => x.text) : [];
          // What Finish would refuse is said; the record and its redactions still show, as if kept both.
          const slug = body.preview?.slug || null;
          const pl = plan(body.preview, { queued, draft: true, followup: followupFor(id, slug) });
          const error = pl.unresolved[0] || null;
          // Each text scrubbed once: the body, then what is written besides it.
          const b = store.preview(pl.body);
          const rest = store.preview(textsOf({ ...pl, body: '' }));
          const seen = new Set();
          const redactions = [...b.redactions, ...rest.redactions].filter(x => { const k = `${x.kind}|${x.masked}`; if (seen.has(k)) return false; seen.add(k); return true; });
          return send(res, 200, { error, body: b.text, redactions,
            counts: { decisions: pl.decisions.length, notes: pl.notes.length, files: pl.files.length, links: pl.links.length, vault: pl.vault.length, worktrees: pl.worktrees.length } });
        }
        if (op === 'commit') {
          sessionOf(id);
          const item = await agents.send(id, COMMIT_PROMPT);
          return send(res, 200, { item });
        }
        if (op === 'finish') return send(res, 200, await finish(id, body));
        return send(res, 404, { error: 'not found' });
      } catch (e) { return fail(res, e); }
    },
  }];
}
