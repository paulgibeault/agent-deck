// lib/ghstate.mjs — live state of the GitHub PRs, issues and milestones on
// screen: one batched `gh api graphql` query for all of them, cached briefly,
// backing off when GitHub says the rate limit is near. No model calls. Without
// gh (or a login) every item comes back unknown and the chips still link.
//
// GitHub's GraphQL API has no conditional requests, so there is no ETag to
// send it; the deck's own route (lib/routes/gh.mjs) puts one between the
// server and the page instead, and the query asks for its rateLimit to pace itself.
import { execFile } from 'node:child_process';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const MAX_PER_QUERY = 40;

// ------------------------------------------------------------ keys
/** The cache key of a ref: `owner/repo#12`, `owner/repo@branch` or `owner/repo%3` (a milestone). Repos compare case-blind. */
export function keyOf(it) {
  const r = String(it.repo || '').toLowerCase();
  if (it.kind === 'branch') return `${r}@${it.branch}`;
  if (it.kind === 'milestone') return `${r}%${it.number}`;
  return `${r}#${it.number}`;
}
/** The item a key stands for (the inverse of keyOf), or null for a malformed one. */
export function parseKey(key) {
  const m = /^([\w.-]+\/[\w.-]+)(?:#(\d+)|%(\d+)|@(.+))$/.exec(String(key || ''));
  if (!m) return null;
  if (m[4]) return { kind: 'branch', repo: m[1], branch: m[4] };
  return m[3] ? { kind: 'milestone', repo: m[1], number: Number(m[3]) } : { kind: 'ref', repo: m[1], number: Number(m[2]) };
}

// ------------------------------------------------------------ state
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const checkState = (c) => c.__typename === 'StatusContext' || c.state ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING';
/**
 * A PR's checks (check runs and commit statuses) in one line:
 * { state: failure | pending | success, passed, failed, pending, failing: [names] }, or null with no checks.
 */
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  const out = { state: 'success', passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of rollup) {
    const v = checkState(c);
    if (FAILED.has(v)) { out.failed++; out.failing.push(c.name || c.context || 'a check'); }
    else if (PASSED.has(v)) out.passed++;
    else out.pending++;
  }
  out.state = out.failed ? 'failure' : out.pending ? 'pending' : 'success';
  return out;
}
/** The failing checks with where to read them: [{ name, url, runId }]. runId is the Actions run, when it is one. */
export function failingChecks(rollup) {
  return (Array.isArray(rollup) ? rollup : []).filter(c => FAILED.has(checkState(c)))
    .map(c => ({ name: c.name || c.context || 'a check', url: c.detailsUrl || c.targetUrl || null, runId: c.checkSuite?.workflowRun?.databaseId || null }));
}

/**
 * The chip state of a PR or issue node, GitHub's own: a PR is open, draft,
 * merged or closed; an issue open, closed (done) or not-planned.
 */
export function stateOf(node) {
  if (!node) return null;
  const s = String(node.prState || node.state || '').toUpperCase();
  if (node.__typename === 'PullRequest' || node.kind === 'pr') {
    if (s === 'MERGED' || node.merged) return 'merged';
    if (s === 'CLOSED') return 'closed';
    return node.isDraft || node.draft ? 'draft' : 'open';
  }
  if (s === 'CLOSED') return /NOT_PLANNED|DUPLICATE/i.test(node.stateReason || node.reason || '') ? 'not-planned' : 'closed';
  return 'open';
}

/**
 * An issue number in a branch name: `123-foo`, `fix/123-foo`, `issue-123`, `gh-7`.
 * A bare leading number must look like an issue: not a year (`2024-cleanup`) and
 * not a single digit (`1-click-login`). Callers still check that the issue exists.
 */
export function issueFromBranch(branch) {
  const leaf = String(branch || '').split('/').pop();
  const tagged = /^(?:issue|issues|gh|bug|fix)[-_]?(\d+)(?:[-_]|$)/i.exec(leaf);
  if (tagged) return Number(tagged[1]);
  const m = /^(\d+)(?:[-_]|$)/.exec(leaf);
  if (!m || /^(?:19|20)\d\d$/.test(m[1]) && /^\d{4}[-_]/.test(leaf) || Number(m[1]) < 10) return null;
  return Number(m[1]);
}

// ------------------------------------------------------------ the query
const PR = `fragment P on PullRequest { __typename number title url prState: state isDraft merged headRefName mergeable reviewDecision author { login }
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
  reviews { totalCount }
  reviewThreads(first: 100) { nodes { isResolved comments { totalCount } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 60) { nodes { __typename
    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
    ... on StatusContext { context state targetUrl } } } } } } } }`;
const ISSUE = 'fragment I on Issue { __typename number title url state stateReason author { login } }';
const MILESTONE = 'fragment M on Milestone { title url state number open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }';
const str = (s) => JSON.stringify(String(s));

/**
 * One GraphQL query for `items` ({ kind: 'ref'|'pr'|'issue'|'branch'|'milestone', repo, number|branch }),
 * grouped by repository with an alias per item, plus the rate limit.
 * Returns { query, plan: [{ key, path: [repoAlias, itemAlias], kind }] }; items with a bad repo are left out.
 */
export function buildQuery(items) {
  const repos = new Map();
  const plan = [];
  for (const it of items) {
    if (!REPO_RE.test(it.repo || '')) continue;
    const key = keyOf(it);
    if (plan.some(p => p.key === key)) continue;
    const [owner, name] = it.repo.split('/');
    const r = repos.get(it.repo.toLowerCase()) || { alias: `r${repos.size}`, owner, name, fields: [] };
    repos.set(it.repo.toLowerCase(), r);
    const alias = `i${r.fields.length}`;
    if (it.kind === 'branch') r.fields.push(`${alias}: pullRequests(headRefName: ${str(it.branch)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...P } }`);
    else if (it.kind === 'milestone') r.fields.push(`${alias}: milestone(number: ${Number(it.number)}) { ...M }`);
    else r.fields.push(`${alias}: issueOrPullRequest(number: ${Number(it.number)}) { ...I ...P }`);
    plan.push({ key, path: [r.alias, alias], kind: it.kind === 'branch' || it.kind === 'milestone' ? it.kind : 'ref', repo: it.repo });
  }
  const body = [...repos.values()].map(r => `${r.alias}: repository(owner: ${str(r.owner)}, name: ${str(r.name)}) { ${r.fields.join(' ')} }`).join('\n  ');
  const kinds = new Set(plan.map(p => p.kind));
  const frags = [kinds.has('ref') || kinds.has('branch') ? PR : null, kinds.has('ref') ? ISSUE : null, kinds.has('milestone') ? MILESTONE : null].filter(Boolean);
  return { query: `query {\n  rateLimit { remaining resetAt }\n  ${body}\n}\n${frags.join('\n')}`, plan };
}

/** A PR, issue or milestone node as the chips want it. */
export function normalize(node, repo) {
  if (!node) return null;
  if (node.__typename === 'PullRequest') {
    const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
    const checks = checksOf(rollup);
    const threads = node.reviewThreads?.nodes || [];
    const st = stateOf(node);
    return {
      kind: 'pr', repo, number: node.number, title: node.title, url: node.url, author: node.author?.login || null,
      state: st === 'draft' ? 'open' : st, draft: !!node.isDraft, st,
      ci: checks?.state || null, checks, fails: failingChecks(rollup),
      review: node.reviewDecision ? String(node.reviewDecision).toLowerCase() : null,
      unresolved: threads.filter(t => !t.isResolved).length,
      // Reviews plus review comments: what "new since you last looked" counts.
      activity: (node.reviews?.totalCount || 0) + threads.reduce((n, t) => n + (t.comments?.totalCount || 0), 0),
      conflicts: node.mergeable === 'CONFLICTING',
      head: node.headRefName || null,
      closes: (node.closingIssuesReferences?.nodes || []).map(n => ({ repo: n.repository?.nameWithOwner || repo, number: n.number })),
    };
  }
  if (node.__typename === 'Issue') {
    const st = stateOf(node);
    return { kind: 'issue', repo, number: node.number, title: node.title, url: node.url, author: node.author?.login || null,
      state: String(node.state || '').toLowerCase(), reason: node.stateReason ? String(node.stateReason).toLowerCase() : null, st };
  }
  if ('open' in node && 'closed' in node) {
    return { kind: 'milestone', repo, number: node.number, title: node.title, url: node.url, state: String(node.state || '').toLowerCase(),
      open: node.open?.totalCount || 0, closed: node.closed?.totalCount || 0 };
  }
  return null;
}

/** The query's answer as { key: info | null } along the plan; a branch with no PR is null. */
export function parseData(data, plan) {
  const out = {};
  for (const p of plan) {
    const v = data?.[p.path[0]]?.[p.path[1]];
    out[p.key] = normalize(p.kind === 'branch' ? v?.nodes?.[0] : v, p.repo);
  }
  return out;
}

/** `gh api -i` output: the status line and headers, then the body. */
export function parseHttp(text) {
  const s = String(text || '');
  if (!/^HTTP\/[\d.]+ \d+/.test(s)) return { status: null, headers: {}, body: s };
  const cut = s.search(/\r?\n\r?\n/);
  const head = cut < 0 ? s : s.slice(0, cut);
  const body = cut < 0 ? '' : s.slice(cut).replace(/^\r?\n\r?\n/, '');
  const [status, ...lines] = head.split(/\r?\n/);
  const headers = {};
  for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(status)[1]), headers, body };
}

/**
 * When to try again after this answer, in ms from `now`, or 0 to carry on:
 * a 403/429 with Retry-After or an exhausted X-RateLimit, a RATE_LIMITED
 * GraphQL error, or a rateLimit budget nearly spent (wait for its reset).
 */
export function backoffOf({ status, headers = {}, json = null }, now = Date.now()) {
  const reset = (s) => Math.max(60_000, Number(s) * 1000 - now);
  if (headers['retry-after'] && (status === 403 || status === 429)) return Math.max(60_000, Number(headers['retry-after']) * 1000);
  if ((status === 403 || status === 429) && headers['x-ratelimit-remaining'] === '0') return reset(headers['x-ratelimit-reset']);
  if (status === 429) return 60_000;
  if (json?.errors?.some(e => e.type === 'RATE_LIMITED')) return headers['x-ratelimit-reset'] ? reset(headers['x-ratelimit-reset']) : 5 * 60_000;
  const rl = json?.data?.rateLimit;
  if (rl && rl.remaining < 50 && rl.resetAt) return Math.max(60_000, Date.parse(rl.resetAt) - now);
  return 0;
}

// ------------------------------------------------------------ the service
const FRESH_MS = 10_000;
// After a failed ask (signed out, offline, slow), wait this long before asking about those items again.
const FAIL_MS = 30_000;

/**
 * Batched, cached GitHub state through the gh CLI. A stale value comes back at
 * once while it refreshes in the background; only items never seen wait for gh.
 * An item already being asked about is not asked about twice, so a slow gh
 * holds up only the callers that need its answer.
 */
export class GhState {
  constructor({ bin = process.env.DECK_GH_BIN || 'gh', timeout = 15_000 } = {}) {
    this.bin = bin; this.timeout = timeout;
    this.cache = new Map();      // key -> { at, value } (at: last success), failedAt: last failure
    this.inflight = new Map();   // key -> the query asking about it
    this.missing = false;        // gh is not installed: stop asking
    this.blockedUntil = 0;       // rate limited until then
  }

  _run(args) {
    return new Promise((resolve) => {
      execFile(this.bin, args, { timeout: this.timeout, maxBuffer: 8 << 20, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout) => {
        if (err?.code === 'ENOENT') this.missing = true;
        resolve({ err, stdout: String(stdout || '') });
      });
    });
  }

  /**
   * State for `items`: { items: { key: info | null | undefined }, gh, rateLimited, retryAfter (s) }.
   * Values younger than `maxAge` are served as they are; older ones are served and refreshed.
   * undefined means not known (no gh, or it failed); null that GitHub says there is no such thing.
   */
  async fetch(items, { maxAge = FRESH_MS } = {}) {
    const now = Date.now();
    const waits = [], ask = [];
    for (const it of items) {
      const key = keyOf(it);
      const c = this.cache.get(key);
      const known = c && 'value' in c;
      if (known && now - c.at < maxAge) continue;
      if (c?.failedAt && now - c.failedAt < FAIL_MS) continue;
      if (this.inflight.has(key)) { if (!known) waits.push(this.inflight.get(key)); continue; }
      ask.push(it);
    }
    if (ask.length && !this.missing && this.blockedUntil <= now) {
      for (let i = 0; i < ask.length; i += MAX_PER_QUERY) {
        const chunk = ask.slice(i, i + MAX_PER_QUERY);
        const q = this._query(chunk).catch(() => {}).finally(() => { for (const it of chunk) if (this.inflight.get(keyOf(it)) === q) this.inflight.delete(keyOf(it)); });
        for (const it of chunk) this.inflight.set(keyOf(it), q);
        if (chunk.some(it => !('value' in (this.cache.get(keyOf(it)) || {})))) waits.push(q);
      }
    }
    await Promise.all(waits);
    const out = {};
    for (const it of items) out[keyOf(it)] = this.cache.get(keyOf(it))?.value;
    const wait = this.blockedUntil - Date.now();
    return { items: out, gh: !this.missing, rateLimited: wait > 0, retryAfter: wait > 0 ? Math.ceil(wait / 1000) : 0 };
  }

  async _query(items) {
    const { query, plan } = buildQuery(items);
    if (!plan.length) return;
    const { stdout } = await this._run(['api', 'graphql', '-i', '-f', `query=${query}`]);
    const res = parseHttp(stdout);
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json: gh failed */ }
    const wait = backoffOf({ ...res, json });
    if (wait) this.blockedUntil = Date.now() + wait;
    const at = Date.now();
    if (!json?.data) {
      // Keep any value we had; just do not ask again for a while.
      for (const p of plan) this.cache.set(p.key, { ...this.cache.get(p.key), failedAt: at });
      return;
    }
    const values = parseData(json.data, plan);
    for (const [key, value] of Object.entries(values)) this.cache.set(key, { at, value });
  }

  /** The tail of a failed Actions run's log (`gh run view --log-failed`), or null. */
  async failedLog(repo, runId) {
    if (this.missing || !REPO_RE.test(repo || '') || !/^\d+$/.test(String(runId))) return null;
    const { err, stdout } = await this._run(['run', 'view', String(runId), '--repo', repo, '--log-failed']);
    return err && !stdout ? null : stdout;
  }
}

// ------------------------------------------------------------ issues beside their PRs
/**
 * The refs in chip order: each PR followed by the issues it relates to (it
 * closes them, its branch is named after one, or a commit on the session's
 * branch says "fixes #N"), the rest in their own order. Related issues not
 * mentioned in the session are added. Each issue placed after a PR gets `of`, the PR's key.
 * `infos` is { key: info } (state lookups); `branch` the session's branch, whose PR is marked `branch: true`.
 */
export function associate(refs, infos = {}, { branch = null } = {}) {
  const info = (r) => infos[keyOf(r)] || null;
  const isPr = (r) => (info(r)?.kind || r.kind) === 'pr';
  const related = new Map();   // pr key -> [{ repo, number }]
  for (const r of refs) {
    if (!isPr(r)) continue;
    const i = info(r);
    const list = [...(i?.closes || [])];
    const n = issueFromBranch(i?.head || (r.branch ? branch : null));
    if (n && n !== r.number) list.push({ repo: r.repo, number: n, fromBranch: true });
    // "fixes #N" in the session's own commits goes with the session's own PR.
    if (r.branch) for (const x of refs) if (x.fixes && !isPr(x)) list.push({ repo: x.repo, number: x.number });
    related.set(keyOf(r), list);
  }
  const byKey = new Map(refs.map(r => [keyOf(r), r]));
  const placed = new Set();
  // An issue a PR here relates to waits for that PR, wherever it was mentioned.
  const later = new Set([...related.values()].flat().map(keyOf).filter(k => !isPr(byKey.get(k) || { kind: 'issue' })));
  const out = [];
  for (const r of refs) {
    const k = keyOf(r);
    if (placed.has(k) || later.has(k)) continue;
    placed.add(k); out.push(r);
    for (const x of related.get(k) || []) {
      const xk = keyOf(x);
      if (placed.has(xk) || isPr(byKey.get(xk) || x)) continue;
      placed.add(xk);
      const known = byKey.get(xk);
      out.push({ ...(known || { kind: 'issue', repo: x.repo, number: x.number, url: `https://github.com/${x.repo}/issues/${x.number}`, fromBranch: x.fromBranch || undefined }), kind: 'issue', of: k });
    }
  }
  return out;
}

// ------------------------------------------------------------ "Ask the agent to fix CI"
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// `gh run view --log-failed` lines: job<TAB>step<TAB>timestamp line.
const LOG_LINE_RE = /^([^\t]*)\t([^\t]*)\t(?:﻿)?(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?(.*)$/;
/** A failed log's last `lines` lines, tab columns and timestamps dropped, each line clipped. */
export function logTail(text, lines = 60) {
  const rows = String(text || '').replace(ANSI_RE, '').split(/\r?\n/).map(l => { const m = LOG_LINE_RE.exec(l); return (m ? m[3] : l).slice(0, 300); });
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.slice(-lines).join('\n');
}

/**
 * The prompt that asks the agent to fix a PR's failing checks: which ones,
 * links to their runs and the tail of each failed log, at most `max` characters.
 * Logs shrink first (oldest lines go), then are dropped; the ask itself always fits.
 */
export function fixCiPrompt({ repo, number, title = null, branch = null, fails = [], logs = [] }, { max = 6000 } = {}) {
  const names = fails.map(f => `- ${f.name}${f.url ? ` (${f.url})` : ''}`).join('\n');
  const head = `CI is failing on PR #${number}${title ? ` "${title}"` : ''} in ${repo}${branch ? ` (branch ${branch})` : ''}.\n\nFailing checks:\n${names || '- (no names reported)'}\n`;
  const ask = '\nPlease find the cause, fix it, and push. If a failure looks unrelated to this change (flaky, infrastructure), say so instead of changing code.';
  let budget = max - head.length - ask.length;
  if (budget < 0) return (head.slice(0, Math.max(0, max - ask.length - 1)) + '…' + ask).slice(0, max);
  const parts = [];
  for (const l of logs) {
    if (!l?.text) continue;
    const label = `\nLog tail, ${l.name || `run ${l.runId}`}:\n`;
    const room = budget - label.length - 9;   // the fences
    if (room < 200) break;
    let t = l.text;
    if (t.length > room) t = '…' + t.slice(t.length - room + 1);
    const part = `${label}\`\`\`\n${t}\n\`\`\`\n`;
    parts.push(part); budget -= part.length;
  }
  return head + parts.join('') + ask;
}
