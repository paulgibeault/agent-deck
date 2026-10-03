#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format json` so the Brief and Ask
// flows can be exercised without a model login: DECK_CLAUDE_BIN=<this file>.
// Replies are built from the prompt so they change as the session does.
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  // `claude -p /usage`: the plan report, no model call.
  if (args.includes('/usage')) {
    const pctOf = (v, d) => Math.round(Number(v ?? d) * 100);
    const result = `You are currently using your subscription to power your Claude Code usage\n\nCurrent session: ${pctOf(process.env.FAKE_5H, 0.42)}% used · resets 11:59pm\nCurrent week (all models): ${pctOf(process.env.FAKE_7D, 0.18)}% used · resets Dec 31 at 11:59pm\nCurrent week (Fable): 4% used · resets Dec 31 at 11:59pm\n\nWhat's contributing to your limits usage?\nApproximate, based on local sessions on this machine.\n\nLast 24h · 12 requests · 1 sessions\n  Top subagents: Explore 3%`;
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0 }));
    return;
  }
  const system = args[args.indexOf('--system-prompt') + 1] || '';
  const title = /^Session: (.*)$/m.exec(input)?.[1] || 'this session';
  const prompts = [...input.matchAll(/ USER: (.*)$/gm)].map(m => m[1]);
  const tools = [...input.matchAll(/ TOOL (\S+) /g)].length;
  const errors = [...input.matchAll(/^#(\d+) .*(ERROR)/gm)];
  let result;
  if (/live brief/.test(system)) {
    result = JSON.stringify({
      summary: `Fake brief for "${title}": ${prompts.length} prompts and ${tools} tool calls in this digest. Latest ask: ${prompts.at(-1) || 'none'}.`,
      progress: tools ? { unit: 'tool calls', segments: [{ label: 'ok', count: Math.max(0, tools - errors.length), tone: 'done' }, { label: 'failed', count: errors.length, tone: 'failed' }] } : null,
      done: prompts.slice(-3).map(p => p.slice(0, 60)),
      now: 'Reading the transcript (fake model).',
      next: 'Nothing; this is the fake model.',
      watch: errors.length ? { text: `${errors.length} errors in this digest.`, seq: Number(errors.at(-1)[1]) } : null,
    });
  } else {
    const q = /=== QUESTION ===\n([\s\S]*)$/.exec(input)?.[1]?.trim();
    const labels = [...input.matchAll(/^=== (THE ITEM|CONTEXT): (.*) ===$/gm)].map(m => m[2]);
    result = `**Fake answer** to: ${q}\n\nContext I was given: ${labels.map(l => '`' + l + '`').join(', ')} (${input.length} chars).`;
  }
  const final = { type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.0012 };
  // With --verbose the real CLI prints every message as an array, including
  // the plan quota. FAKE_5H / FAKE_7D / FAKE_QUOTA_STATUS steer the numbers.
  const now = Math.floor(Date.now() / 1000);
  const quota = { type: 'rate_limit_event', rate_limit_info: {
    status: process.env.FAKE_QUOTA_STATUS || 'allowed', resetsAt: now + 2 * 3600 + 780, rateLimitType: 'five_hour',
    overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: Number(process.env.FAKE_5H || 0.42), resetsAt: now + 2 * 3600 + 780 }, seven_day: { utilization: Number(process.env.FAKE_7D || 0.18), resetsAt: now + 3 * 86400 } } } };
  setTimeout(() => {
    process.stdout.write(JSON.stringify(args.includes('--verbose') ? [{ type: 'system', subtype: 'init' }, quota, final] : final));
  }, 600);
});
