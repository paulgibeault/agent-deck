// lib/ghrefs.mjs — the GitHub issues and pull requests a session worked on.
//
// Found in its events, no model call: github.com links in prompts and in what
// the agent said, `gh pr|issue <verb> N` commands (and the links `gh … create`
// prints), "fixes #N" in commands such as commit messages, and the PR Claude
// Code links to the session. Titles and states come from `gh` when it is
// installed and signed in (lib/ghstate.mjs), cached; without it the chips still link.
import { GhState, keyOf, associate, checksOf } from './ghstate.mjs';

export { checksOf };

const URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g;
const GH_RE = /^(?:\S*\/)?gh\s+(pr|issue)\s+[a-z-]+\s+#?(\d+)\b(.*)/;
// Text fed to a command (a file written with cat <<EOF, an issue body) is not the command itself.
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
/** The commands in a shell line, heredoc bodies left out. */
const commands = (cmd) => cmd.replace(HEREDOC_RE, '').split(/\n|&&|\|\||[;|(]/).map(x => x.trim()).filter(Boolean);
const FIXES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
// Tool results are mostly noise (web pages, listings); only these commands' output names what they made or opened.
const GH_RESULT_RE = /^(?:\S*\/)?gh\s+(?:pr|issue)\s+(?:create|view|merge|edit|comment|close|reopen|ready)\b/;
const MAX_REFS = 12;

/**
 * Refs in `events`, most recently mentioned first: [{ kind: 'pr'|'issue', repo, number, url, lastSeq }].
 * `repo` is the session's own owner/repo (for bare numbers); `pr` is a PR the transcript links.
 */
export function refsFromEvents(events, { repo = null, pr = null } = {}) {
  const refs = new Map();
  const fixes = new Set();   // issues a commit says it fixes: they go with the session's own PR
  const add = (kind, r, n, seq) => {
    if (!r || !n) return;
    const key = `${r.toLowerCase()}#${n}`;
    const cur = refs.get(key);
    // A link says which kind it is; a bare number from `fixes #N` is assumed an issue until a link says otherwise.
    if (cur) { cur.lastSeq = Math.max(cur.lastSeq, seq); if (kind === 'pr') cur.kind = 'pr'; return; }
    refs.set(key, { kind, repo: r, number: Number(n), url: `https://github.com/${r}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`, lastSeq: seq });
  };
  const scanUrls = (text, seq) => { for (const m of String(text || '').matchAll(URL_RE)) add(m[2] === 'pull' ? 'pr' : 'issue', m[1], m[3], seq); };
  if (pr?.number) add('pr', pr.repo || githubRepoOf(pr.url) || repo, pr.number, 0);
  for (const ev of events) {
    const seq = ev.seq || 0;
    if (ev.kind === 'prompt' || ev.kind === 'text') { scanUrls(ev.text, seq); continue; }
    if (ev.kind !== 'tool') continue;
    const cmd = ev.tool?.command || ev.tool?.input?.command;
    if (typeof cmd !== 'string') continue;
    let ghOut = false;
    for (const c of commands(cmd)) {
      if (/^(?:\S*\/)?gh\s+(?:pr|issue)\b/.test(c)) {
        const m = GH_RE.exec(c);
        if (m) {
          const r = /--repo[= ]([\w.-]+\/[\w.-]+)/.exec(m[3])?.[1] || /(?:^|\s)-R\s+([\w.-]+\/[\w.-]+)/.exec(m[3])?.[1] || repo;
          add(m[1] === 'pr' ? 'pr' : 'issue', r, m[2], seq);
        }
        scanUrls(c, seq);
        ghOut ||= GH_RESULT_RE.test(c);
      }
      // A commit message (often a heredoc) closing an issue.
      if (/^git\s+commit\b/.test(c)) for (const m of cmd.matchAll(FIXES_RE)) { add('issue', repo, m[1], seq); if (repo) fixes.add(`${repo.toLowerCase()}#${m[1]}`); }
    }
    if (ghOut && !ev.tool.isError) scanUrls(ev.tool.result?.text, seq);
  }
  for (const [k, r] of refs) if (fixes.has(k) && r.kind === 'issue') r.fixes = true;
  return [...refs.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, MAX_REFS);
}

function githubRepoOf(url) { return /github\.com\/([\w.-]+\/[\w.-]+)\//.exec(String(url || ''))?.[1] || null; }

// ------------------------------------------------------------ gh lookups
// lib/ghstate.mjs does the asking: one batched GraphQL query, briefly cached.

// The header asks for the place every 30s; the chips' own poll keeps the state fresher.
const REF_TTL_MS = 60_000;
// A branch's PR carries its CI, which moves in minutes.
const BRANCH_TTL_MS = 90_000;

/** Titles and states through `gh`, cached; quietly does nothing if gh is missing or signed out. */
export class GitHubInfo {
  constructor({ bin, timeout, state } = {}) {
    this.state = state || new GhState({ bin, timeout });
    this.seen = null;   // { get(key), set(key, n) }: review activity the pilot has looked at (lib/routes/gh.mjs)
  }
  get missing() { return this.state.missing; }

  /** The newest PR whose head is `branch`, with its CI and review state, or null. */
  async branchPr(repo, branch) {
    const it = { kind: 'branch', repo, branch };
    return (await this.state.fetch([it], { maxAge: BRANCH_TTL_MS })).items[keyOf(it)] || null;
  }
  /** The PRs for several { repo, branch } at once (one gh call), in the same order; null where there is none. */
  async branchPrs(list) {
    const items = list.map(({ repo, branch }) => ({ kind: 'branch', repo, branch }));
    const { items: got } = await this.state.fetch(items, { maxAge: BRANCH_TTL_MS });
    return items.map(it => got[keyOf(it)] || null);
  }

  /**
   * What a live session's branch PR asks of the pilot, for the "needs you"
   * signal (lib/sessions.mjs _withCi): red CI, else changes requested or
   * unresolved review comments with activity the pilot has not looked at. Null when nothing.
   */
  needOf(pr) {
    if (!pr || pr.state !== 'open') return null;
    if (pr.ci === 'failure') return { pr: pr.number, url: pr.url, failing: pr.checks?.failing || [] };
    if (pr.review !== 'changes_requested' && !pr.unresolved) return null;
    const what = pr.review === 'changes_requested' ? 'Changes requested' : `${pr.unresolved} unresolved review comment${pr.unresolved === 1 ? '' : 's'}`;
    return { pr: pr.number, url: pr.url, failing: [], kind: 'review', signal: 'input', key: keyOf(pr), activity: pr.activity, text: `${what} on PR #${pr.number}` };
  }
  /** `need` unless it is review activity the pilot has already looked at. */
  current(need) {
    if (need?.kind !== 'review') return need || null;
    return (this.seen?.get(need.key) ?? -1) >= need.activity ? null : need;
  }

  /**
   * `refs` with titles and states filled in (lib/ghstate.mjs normalize), the
   * branch's PR first (marked `branch: true`), and each PR's related issues right after it (`of`).
   */
  async enrich(refs, { repo, branch, defaultBranch } = {}) {
    const items = refs.map(r => ({ kind: 'ref', repo: r.repo, number: r.number }));
    const bItem = repo && branch && branch !== defaultBranch ? { kind: 'branch', repo, branch } : null;
    if (bItem) items.push(bItem);
    const { items: infos } = await this.state.fetch(items, { maxAge: REF_TTL_MS });
    const out = refs.map(r => ({ ...r }));
    const bp = bItem ? infos[keyOf(bItem)] : null;
    if (bp) {
      infos[keyOf(bp)] = bp;
      const cur = out.find(r => keyOf(r) === keyOf(bp));
      if (cur) Object.assign(cur, { kind: 'pr', branch: true });
      else out.unshift({ kind: 'pr', repo, number: bp.number, url: bp.url, lastSeq: Infinity, branch: true });
    }
    // The branch's PR leads; the rest stay most recent first.
    out.sort((a, b) => (b.branch ? 1 : 0) - (a.branch ? 1 : 0));
    const placed = associate(out, infos, { branch });
    // Issues a PR relates to that the session never mentioned: one more batched ask.
    const added = placed.filter(r => !(keyOf(r) in infos)).map(r => ({ kind: 'ref', repo: r.repo, number: r.number }));
    if (added.length) Object.assign(infos, (await this.state.fetch(added, { maxAge: REF_TTL_MS })).items);
    // An issue guessed from a branch name shows only if GitHub says it is one.
    return placed.filter(r => !r.fromBranch || infos[keyOf(r)]?.kind === 'issue').map(({ lastSeq, fixes, fromBranch, ...r }) => {
      const i = infos[keyOf(r)];
      return i ? { ...r, ...i, kind: i.kind, url: i.url || r.url } : r;
    });
  }
}
