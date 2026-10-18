// lib/ghrefs.mjs — the GitHub issues and pull requests a session worked on.
//
// Found in its events, no model call: github.com links in prompts and in what
// the agent said, `gh pr|issue <verb> N` commands (and the links `gh … create`
// prints), "fixes #N" in commands such as commit messages, and the PR Claude
// Code links to the session. Titles and states come from `gh` when it is
// installed and signed in, cached; without it the chips still link.
import { execFile } from 'node:child_process';

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
      if (/^git\s+commit\b/.test(c)) for (const m of cmd.matchAll(FIXES_RE)) add('issue', repo, m[1], seq);
    }
    if (ghOut && !ev.tool.isError) scanUrls(ev.tool.result?.text, seq);
  }
  return [...refs.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, MAX_REFS);
}

function githubRepoOf(url) { return /github\.com\/([\w.-]+\/[\w.-]+)\//.exec(String(url || ''))?.[1] || null; }

// ------------------------------------------------------------ gh lookups

const REF_TTL_MS = 10 * 60_000;
// A branch's PR carries its CI, which moves in minutes.
const BRANCH_TTL_MS = 90_000;

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
/**
 * gh's statusCheckRollup (check runs and commit statuses) in one line:
 * { state: failure | pending | success, passed, failed, pending, failing: [names] }, or null with no checks.
 */
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  const out = { state: 'success', passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of rollup) {
    const v = c.__typename === 'StatusContext' || c.state ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING';
    if (FAILED.has(v)) { out.failed++; out.failing.push(c.name || c.context || 'a check'); }
    else if (PASSED.has(v)) out.passed++;
    else out.pending++;
  }
  out.state = out.failed ? 'failure' : out.pending ? 'pending' : 'success';
  return out;
}

/** Titles and states from the `gh` CLI, cached; quietly does nothing if gh is missing or signed out. */
export class GitHubInfo {
  constructor({ bin = process.env.DECK_GH_BIN || 'gh', timeout = 8000 } = {}) {
    this.bin = bin; this.timeout = timeout;
    this.cache = new Map();     // key -> { at, value, pending }
    this.missing = false;
  }

  _gh(args) {
    if (this.missing) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(this.bin, args, { timeout: this.timeout, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout) => {
        if (err?.code === 'ENOENT') this.missing = true;
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
  }

  /** The cached value for `key`. A stale one comes back at once while it refreshes; the first waits for gh. */
  async _cached(key, ttl, load) {
    let c = this.cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.value;
    if (!c?.pending) {
      c = { ...c, pending: load().then((value) => { this.cache.set(key, { at: Date.now(), value }); return value; }) };
      this.cache.set(key, c);
    }
    return 'value' in c ? c.value : c.pending;
  }

  /** { title, state: open|closed|merged, kind } for one issue or PR (the issues API answers for both). */
  ref(repo, number) {
    return this._cached(`ref:${repo}#${number}`, REF_TTL_MS, async () => {
      const r = await this._gh(['api', `repos/${repo}/issues/${number}`]);
      if (!r) return null;
      return { title: r.title, kind: r.pull_request ? 'pr' : 'issue', state: r.pull_request?.merged_at ? 'merged' : r.state, url: r.html_url };
    });
  }

  /** The newest PR whose head is `branch`, with its CI and review state, or null. */
  branchPr(repo, branch) {
    return this._cached(`branch:${repo}:${branch}`, BRANCH_TTL_MS, async () => {
      const r = await this._gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '1',
        '--json', 'number,title,state,url,isDraft,reviewDecision,statusCheckRollup']);
      const p = Array.isArray(r) ? r[0] : null;
      return p ? { number: p.number, title: p.title, state: String(p.state).toLowerCase(), url: p.url, draft: !!p.isDraft,
        review: p.reviewDecision ? String(p.reviewDecision).toLowerCase() : null, checks: checksOf(p.statusCheckRollup) } : null;
    });
  }

  /** `refs` with titles and states filled in, plus the branch's PR first (marked `branch: true`, with its checks and review). */
  async enrich(refs, { repo, branch, defaultBranch } = {}) {
    const out = refs.map(r => ({ ...r }));
    if (repo && branch && branch !== defaultBranch) {
      const p = await this.branchPr(repo, branch);
      if (p) {
        const cur = out.find(r => r.repo.toLowerCase() === repo.toLowerCase() && r.number === p.number);
        const ci = { kind: 'pr', branch: true, draft: p.draft, review: p.review, checks: p.checks };
        if (cur) Object.assign(cur, ci);
        else out.unshift({ repo, number: p.number, url: p.url, lastSeq: Infinity, ...ci });
      }
    }
    await Promise.all(out.map(async (r) => {
      const info = await this.ref(r.repo, r.number);
      if (info) Object.assign(r, { title: info.title, state: info.state, kind: info.kind, url: info.url || r.url });
    }));
    // The branch's PR leads; the rest stay most recent first.
    return out.sort((a, b) => (b.branch ? 1 : 0) - (a.branch ? 1 : 0)).map(({ lastSeq, ...r }) => r);
  }
}
