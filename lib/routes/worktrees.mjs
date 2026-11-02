// lib/routes/worktrees.mjs — automatic worktrees (lib/worktrees.mjs): the
// launch hook that starts a session in its own worktree, the plan the launch
// dialog shows, the "shares folder with" check for the header, "Restart in
// worktree", and the Worktrees dialog's list and actions.
//
// Removing a worktree, deleting a branch or pushing happens only in POST
// /api/worktrees/act, one worktree and one action at a time, from a click.
// The one exception is a launch that fails: the worktree it just made (empty,
// nothing ran in it) is discarded.
import { worktreesFor, discard, git, sharedMap } from '../worktrees.mjs';
import { vaultFor } from '../vault.mjs';
import { GitHubInfo } from '../ghrefs.mjs';
import { githubRepo, changes } from '../gitinfo.mjs';
import { handoffPrompt } from '../handoff.mjs';

const github = new GitHubInfo();
const str = (v, n = 300) => typeof v === 'string' ? v.slice(0, n) : null;
/** Only what a suggestion holds, from the page. */
const cleanSuggestion = (s) => s && typeof s === 'object' && typeof s.pick === 'string'
  ? { pick: str(s.pick, 200), confidence: Number(s.confidence) || 0, reason: str(s.reason), via: str(s.via, 20), chosen: str(s.chosen, 200) } : null;

export default function routes(ctx) {
  const { send, readBody, deck, index, agents, briefs, broadcast, onLaunch } = ctx;
  if (!deck) return [];
  // The branch's PR for the candidate cards, when the repo is on GitHub and gh answers quickly.
  const repos = new Map();   // worktree top -> owner/repo or null
  const prOf = async (branch, top) => {
    if (!top) return null;
    if (!repos.has(top)) repos.set(top, githubRepo((await git(top, ['remote', 'get-url', 'origin'])).stdout));
    const repo = repos.get(top);
    if (!repo) return null;
    return Promise.race([github.branchPr(repo, branch), new Promise(r => setTimeout(r, 1500, null))]);
  };
  const svc = worktreesFor(ctx, { vaultDir: () => { try { return vaultFor(deck).dir; } catch { return null; } } });
  svc.prOf = prOf;
  const fail = (res, e) => send(res, e.status || 400, { error: e.message });
  const changed = () => broadcast?.('worktrees.update', { at: Date.now() });

  /** The repo's setup command, in the background; its outcome lands on the record and the page hears of it. */
  const setupLater = (p) => {
    svc.setup(p).then((r) => {
      if (r) broadcast?.('worktrees.setup', { path: p, ok: r.ok, cmd: r.cmd, error: r.error, sessionId: svc.record(p)?.sessionId || null });
      changed();
    }).catch((e) => console.error(`agent-deck: worktree setup: ${e.message}`));
  };

  // ------------------------------------------------------------ the launch hook
  const made = new Set();   // worktrees made by a launch still in flight
  onLaunch?.({
    async before(body) {
      const w = body.worktree;
      if (!w || w.use !== true) return null;
      const rec = await svc.start({ cwd: body.cwd, base: String(w.base || ''), cand: w.cand || null, title: body.name || body.prompt, prompt: body.prompt, suggestion: cleanSuggestion(w.suggestion) });
      made.add(rec.path);
      return { cwd: rec.cwd || rec.path, worktreeMade: rec.path };
    },
    async failed(body) {
      if (!made.delete(body.worktreeMade)) return;
      const rec = svc.record(body.worktreeMade);
      if (rec) { await discard(rec); svc.forget(rec.path); }
    },
    async after(st, body) {
      if (!made.delete(body.worktreeMade)) return;
      svc.update(body.worktreeMade, { sessionId: st.id, pending: undefined });
      changed();
      setupLater(body.worktreeMade);
    },
  });

  return [
    {
      // { cwd, prompt, ask, except }: whether a launch there shares a worktree, its candidates, and (ask) a pick.
      method: 'POST', path: '/api/worktrees/plan',
      async handler(req, res) {
        try {
          const b = await readBody(req, 1 << 20);
          if (!b.cwd || typeof b.cwd !== 'string') return send(res, 400, { error: 'cwd required' });
          return send(res, 200, await svc.plan({ cwd: b.cwd, prompt: str(b.prompt, 20_000) || '', ask: !!b.ask, except: str(b.except, 200) }));
        } catch (e) { return fail(res, e); }
      },
    },
    {
      // Live sessions that share a worktree: id -> the others.
      method: 'GET', path: '/api/worktrees/shared',
      async handler(req, res) {
        try { return send(res, 200, await sharedMap(svc.live())); } catch (e) { return fail(res, e); }
      },
    },
    {
      // The cleanup plan: every deck-made worktree (or ?session=<id>'s), its state and its choices.
      method: 'GET', path: '/api/worktrees',
      async handler(req, res, { q }) {
        try {
          const items = await svc.planCleanup({ sessionId: q.get('session') || null });
          for (const it of items) it.title = it.record.sessionId ? index?.summary(it.record.sessionId)?.title || null : null;
          const repoList = [...new Set(items.map(it => it.record.repo))];
          return send(res, 200, { items, repos: Object.fromEntries(repoList.map(r => [r, svc.repoConfig(r)])) });
        } catch (e) { return fail(res, e); }
      },
    },
    {
      // One action on one worktree, as the user clicked it: remove, remove-anyway, stash, push-remove, keep, forget.
      method: 'POST', path: '/api/worktrees/act',
      async handler(req, res) {
        try {
          const b = await readBody(req);
          const r = await svc.act(String(b.path || ''), String(b.action || ''));
          changed();
          return send(res, 200, r);
        } catch (e) { return fail(res, e); }
      },
    },
    {
      method: 'POST', path: '/api/worktrees/prune',
      async handler(req, res) {
        try { return send(res, 200, { repos: await svc.prune() }); } catch (e) { return fail(res, e); }
      },
    },
    {
      // A repo's setup: { repo, setup: 'npm ci', copy: ['.env*', …] }.
      method: 'POST', path: '/api/worktrees/config',
      async handler(req, res) {
        try {
          const b = await readBody(req);
          if (!b.repo || typeof b.repo !== 'string') return send(res, 400, { error: 'repo required' });
          return send(res, 200, svc.setRepoConfig(b.repo, { setup: str(b.setup, 2000), copy: Array.isArray(b.copy) ? b.copy.slice(0, 40).map(x => String(x).slice(0, 200)) : undefined }));
        } catch (e) { return fail(res, e); }
      },
    },
    {
      // "Restart in worktree": { sessionId, base, suggestion }. The session continues, with a
      // handoff, as a new deck session in a fresh worktree; the old one ends if the deck runs it.
      method: 'POST', path: '/api/worktrees/restart',
      async handler(req, res) {
        let rec = null;
        try {
          const b = await readBody(req);
          const id = String(b.sessionId || '');
          const summary = index?.summary(id);
          if (!summary?.cwd) return send(res, 404, { error: 'unknown session, or its folder is not known' });
          if (agents.publicState(id)?.status === 'busy') return send(res, 409, { error: 'the session is mid-turn; stop it or wait for the turn to end' });
          rec = await svc.start({ cwd: summary.cwd, base: String(b.base || ''), cand: b.cand || null, title: summary.title, suggestion: cleanSuggestion(b.suggestion) });
          const harness = summary.harness || agents.recordedHarness?.(id) || undefined;
          const label = agents.harnessList().find(x => x.name === harness)?.label || 'the agent';
          const entry = index.load(id);
          const prompt = handoffPrompt({
            summary, events: entry?.state.events || [], brief: briefs?.publicBrief(id)?.brief, from: label, to: null,
            files: entry?.state.filesList?.().map(f => f.path) || [], work: await changes(summary.cwd).catch(() => null),
            note: `You now work in your own git worktree, ${rec.cwd || rec.path}, on branch ${rec.branch} (from ${rec.base.branch || rec.base.ref}). `
              + `The folder above is shared with another session: do not edit files there. What was uncommitted there is ${rec.base.kind === 'fork' ? 'copied here' : 'not here'}.`,
          });
          // It keeps its model and permission mode; a session the deck did not launch has a recorded model at most.
          const was = agents.publicState(id);
          const model = was?.model || summary.model || undefined;
          const st = await agents.launch({ cwd: rec.cwd || rec.path, prompt, harness, model, name: summary.title || undefined, permissionMode: was?.permissionMode || 'default' });
          svc.update(rec.path, { sessionId: st.id, restartedFrom: id, pending: undefined });
          // The old process ends only if the deck runs it; one started elsewhere has to be quit there.
          const stopped = agents.running(id) ? agents.stop(id) : false;
          changed();
          setupLater(rec.path);
          return send(res, 200, { state: st, record: svc.record(rec.path), stopped: !!stopped });
        } catch (e) {
          // Its own new worktree, empty: undone like a failed launch.
          if (rec && !svc.record(rec.path)?.sessionId) { await discard(rec).catch(() => {}); svc.forget(rec.path); }
          return fail(res, e);
        }
      },
    },
  ];
}
