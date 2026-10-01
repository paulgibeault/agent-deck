#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format json` so the Brief and Ask
// flows can be exercised without a model login: DECK_CLAUDE_BIN=<this file>.
// Replies are built from the prompt so they change as the session does.
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
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
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.0012 }));
  }, 600);
});
