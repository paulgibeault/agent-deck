#!/usr/bin/env node
// Stand-in for the `gh` CLI, so GitHub chips can be exercised without the
// network: DECK_GH_BIN=<this file>. Answers the two calls the deck makes:
//   gh api graphql -i -f query=…              from the GraphQL nodes in a JSON file
//   gh run view <id> --repo R --log-failed    from that file's logs
// The file is FAKE_GH_DATA (default: gh-data.json beside this script):
//   { nodes: { "owner/repo#12": <PullRequest or Issue node> }, branches: { "owner/repo@branch": 12 },
//     milestones: { "owner/repo%3": <Milestone node> }, logs: { "<runId>": "text" },
//     rateLimit: { remaining, resetAt }, limited: <seconds to wait, answers 403>,
//     delay: <ms before answering>, fail: <true: no answer at all, as when offline> }
// Like GitHub, it refuses a query whose Issue and PullRequest fragments ask for
// the same response name with different types (`state`), and answers aliases.
// Each call is appended to FAKE_GH_LOG when set, so tests can count them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STR = '"((?:[^"\\\\]|\\\\.)*)"';

/** A named fragment's type and body. */
function fragment(q, name) {
  const m = new RegExp(`fragment ${name} on (\\w+) \\{`).exec(q);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  for (; i < q.length && depth; i++) depth += q[i] === '{' ? 1 : q[i] === '}' ? -1 : 0;
  return { type: m[1], body: q.slice(m.index + m[0].length, i - 1) };
}
/** The top-level selections of a selection set: [{ name (the response key), field }]. */
export function topFields(body) {
  let depth = 0, paren = 0, top = '';
  for (const ch of body) {
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (paren) continue;
    else if (ch === '{') { depth++; top += ' '; }
    else if (ch === '}') depth--;
    else if (!depth) top += ch;
  }
  return [...top.matchAll(/(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)/g)].map(m => ({ name: m[1] || m[2], field: m[2] }));
}
// Fields of the same name whose types differ between the two (GitHub's schema).
const TYPES = { 'Issue.state': 'IssueState', 'PullRequest.state': 'PullRequestState' };
const typeOf = (type, field) => TYPES[`${type}.${field}`] || `any:${field}`;
/** Response names the Issue and PullRequest fragments both use with different types: GitHub refuses those. */
export function conflicts(q) {
  const I = fragment(q, 'I'), P = fragment(q, 'P');
  if (!I || !P) return [];
  const out = [];
  for (const a of topFields(I.body)) for (const b of topFields(P.body))
    if (a.name === b.name && typeOf(I.type, a.field) !== typeOf(P.type, b.field)) out.push(a.name);
  return out;
}
/** A fixture node shaped as fragment `name` asks for it: aliased fields renamed. */
function shaped(node, q, name) {
  const f = node && fragment(q, name);
  if (!f) return node;
  const out = { ...node };
  const fields = topFields(f.body);
  for (const { name: n, field } of fields) if (n !== field) out[n] = node[field];
  for (const { field } of fields) if (!fields.some(x => x.name === field)) delete out[field];
  return out;
}
const shapeAny = (node, q) => node ? shaped(node, q, node.__typename === 'PullRequest' ? 'P' : 'I') : node;

/** The repositories and aliased items in a query the deck built (lib/ghstate.mjs buildQuery). */
export function parseQuery(q) {
  const repos = [];
  const head = new RegExp(`(\\w+): repository\\(owner: ${STR}, name: ${STR}\\) \\{`, 'g');
  for (const m of q.matchAll(head)) {
    // The block runs to its matching brace.
    let depth = 1, i = m.index + m[0].length;
    for (; i < q.length && depth; i++) depth += q[i] === '{' ? 1 : q[i] === '}' ? -1 : 0;
    const body = q.slice(m.index + m[0].length, i - 1);
    const items = [];
    for (const x of body.matchAll(/(\w+): issueOrPullRequest\(number: (\d+)\)/g)) items.push({ alias: x[1], kind: 'ref', number: Number(x[2]) });
    for (const x of body.matchAll(new RegExp(`(\\w+): pullRequests\\(headRefName: ${STR}`, 'g'))) items.push({ alias: x[1], kind: 'branch', branch: JSON.parse(`"${x[2]}"`) });
    for (const x of body.matchAll(/(\w+): milestone\(number: (\d+)\)/g)) items.push({ alias: x[1], kind: 'milestone', number: Number(x[2]) });
    repos.push({ alias: m[1], repo: `${JSON.parse(`"${m[2]}"`)}/${JSON.parse(`"${m[3]}"`)}`, items });
  }
  return { repos, rateLimit: /\brateLimit\s*\{/.test(q) };
}

/** The `data` GitHub would answer `q` with, from the fixture `db`. */
export function answer(q, db) {
  const find = (map, key) => Object.entries(map || {}).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
  const { repos, rateLimit } = parseQuery(q);
  const data = {};
  if (rateLimit) data.rateLimit = db.rateLimit || { remaining: 4999, resetAt: new Date(Date.now() + 3600_000).toISOString() };
  for (const r of repos) {
    const out = {};
    for (const it of r.items) {
      if (it.kind === 'ref') out[it.alias] = shapeAny(find(db.nodes, `${r.repo}#${it.number}`), q) || null;
      else if (it.kind === 'milestone') out[it.alias] = find(db.milestones, `${r.repo}%${it.number}`) || null;
      else { const n = find(db.branches, `${r.repo}@${it.branch}`); const node = n && find(db.nodes, `${r.repo}#${n}`); out[it.alias] = { nodes: node ? [shapeAny(node, q)] : [] }; }
    }
    data[r.alias] = out;
  }
  return data;
}

function main(args) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = process.env.FAKE_GH_DATA || path.join(here, 'gh-data.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
  if (db.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(db.delay));
  if (db.fail) { process.stderr.write('error connecting to api.github.com\n'); process.exit(1); }
  if (args[0] === 'api' && args[1] === 'graphql') {
    const q = (args.find(a => a.startsWith('query=')) || '').slice(6);
    const head = args.includes('-i');
    if (db.limited) {
      const reset = Math.floor(Date.now() / 1000) + Number(db.limited);
      if (head) process.stdout.write(`HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\nRetry-After: ${db.limited}\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${reset}\r\n\r\n`);
      process.stdout.write(JSON.stringify({ message: 'API rate limit exceeded' }));
      process.stderr.write('gh: API rate limit exceeded (HTTP 403)\n');
      process.exit(1);
    }
    const bad = conflicts(q);
    if (bad.length) {
      if (head) process.stdout.write('HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\r\n');
      process.stdout.write(JSON.stringify({ errors: bad.map(n => ({ message: `Fields '${n}' conflict because they return conflicting types. Use different aliases on the fields to fetch both if this was intentional.` })) }));
      process.stderr.write(`gh: Fields '${bad[0]}' conflict\n`);
      process.exit(1);
    }
    if (head) process.stdout.write('HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nX-Ratelimit-Remaining: 4999\r\n\r\n');
    process.stdout.write(JSON.stringify({ data: answer(q, db) }));
    return;
  }
  if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) {
    const log = db.logs?.[args[2]];
    if (log == null) { process.stderr.write(`run ${args[2]} not found\n`); process.exit(1); }
    process.stdout.write(log);
    return;
  }
  process.stderr.write(`fake gh: unsupported: ${args.join(' ')}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main(process.argv.slice(2));
