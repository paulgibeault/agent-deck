#!/usr/bin/env node
// Manual check of the GitHub chips' query against real GitHub: runs the one
// batched query (lib/ghstate.mjs) through your signed-in `gh` once and prints
// what the chips would show. Not run by the tests.
//
//   node scripts/gh-check.mjs owner/repo [number ...] [--branch name] [--milestone N]
//
// With no numbers it asks about the repo's most recent PRs and issues (via `gh pr list` / `gh issue list`).
import { execFileSync } from 'node:child_process';
import { GhState, keyOf, buildQuery } from '../lib/ghstate.mjs';

const args = process.argv.slice(2);
const repo = args.shift();
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) { console.error('usage: node scripts/gh-check.mjs owner/repo [number ...] [--branch name] [--milestone N]'); process.exit(2); }
const items = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--branch') items.push({ kind: 'branch', repo, branch: args[++i] });
  else if (args[i] === '--milestone') items.push({ kind: 'milestone', repo, number: Number(args[++i]) });
  else if (/^\d+$/.test(args[i])) items.push({ kind: 'ref', repo, number: Number(args[i]) });
}
if (!items.length) {
  const gh = process.env.DECK_GH_BIN || 'gh';
  for (const what of ['pr', 'issue']) {
    const list = JSON.parse(execFileSync(gh, [what, 'list', '--repo', repo, '--state', 'all', '--limit', '5', '--json', 'number'], { encoding: 'utf8' }));
    for (const { number } of list) items.push({ kind: 'ref', repo, number });
  }
}

const state = new GhState();
// Show what gh said when it refuses the query (a schema error, say).
const run = state._run.bind(state);
state._run = async (a) => { const r = await run(a); if (r.err) console.error(`gh failed: ${r.err.message.split('\n')[0]}\n${r.stdout.slice(-2000)}`); return r; };
console.log(`${buildQuery(items).query.length} characters of query for ${items.length} items`);
const out = await state.fetch(items);
console.log(`gh: ${out.gh ? 'found' : 'missing'}${out.rateLimited ? ` · rate limited for ${out.retryAfter}s` : ''}\n`);
for (const it of items) {
  const i = out.items[keyOf(it)];
  const name = it.kind === 'branch' ? `branch ${it.branch}` : it.kind === 'milestone' ? `milestone ${it.number}` : `#${it.number}`;
  if (i === undefined) { console.log(`${name}: unknown (gh failed)`); continue; }
  if (i === null) { console.log(`${name}: none`); continue; }
  if (i.kind === 'milestone') { console.log(`${name}: ${i.state} · ${i.open} open, ${i.closed} closed · ${i.title}`); continue; }
  const bits = [i.kind, i.st, i.ci && `CI ${i.ci}`, i.review, i.unresolved && `${i.unresolved} unresolved`, i.conflicts && 'conflicts',
    i.fails?.length && `failing: ${i.fails.map(f => f.name).join(', ')}`, i.closes?.length && `closes ${i.closes.map(c => `#${c.number}`).join(' ')}`].filter(Boolean);
  console.log(`${name}: ${bits.join(' · ')} · ${i.title}`);
}
