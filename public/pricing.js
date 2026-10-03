// public/pricing.js — Claude API list prices, to estimate what one inference
// would cost at API rates. Plan subscriptions are not billed per token, so
// the page always labels these as estimates. Dollars per million tokens;
// cache reads per model, cache writes 1.25x input (5-minute TTL) or 2x
// (1-hour TTL). Fast mode doubles input and output on the Opus models.
// Source: the Claude API model and pricing reference, 2026-09.

const P = (input, output, cacheRead, context = 1_000_000) => ({ input, output, cacheRead, context });
export const PRICES = {
  'claude-fable-5-1': P(10, 50, 0.25),
  'claude-mythos-5-1': P(10, 50, 0.25),
  'claude-fable-5': P(10, 50, 1),
  'claude-opus-5-5': P(4, 20, 0.2),
  'claude-opus-5': P(5, 25, 0.5),
  'claude-opus-4-8': P(5, 25, 0.5),
  'claude-opus-4-7': P(5, 25, 0.5),
  'claude-opus-4-6': P(5, 25, 0.5),
  'claude-sonnet-5-5': P(2, 10, 0.2),
  'claude-sonnet-5': P(2, 10, 0.2),
  'claude-sonnet-4-6': P(3, 15, 0.3),
  'claude-haiku-4-5': P(1, 5, 0.1, 200_000),
};

/** Price entry for a model id, ignoring date suffixes (claude-haiku-4-5-20251001). */
export function priceOf(model) {
  if (!model) return null;
  const m = String(model).replace(/\[1m\]$/, '');
  return PRICES[m] || PRICES[m.replace(/-\d{8}$/, '')] || null;
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelLabel(model) {
  if (!model) return '';
  if (model === '<synthetic>') return 'synthetic';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : model.replace(/^claude-/, '');
}

/**
 * Estimated API cost of one inference, split by part, or null for an
 * unknown model. `usage` is the normalized inference usage from
 * lib/transcript.mjs (input, cacheRead, cacheWrite, cacheWrite1h, output).
 */
export function costOf(model, usage, speed) {
  const p = priceOf(model);
  if (!p || !usage) return null;
  const fast = speed === 'fast' ? 2 : 1;
  const per = (n, rate) => n * rate / 1e6;
  const w1h = usage.cacheWrite1h || 0;
  const w5m = Math.max(0, (usage.cacheWrite || 0) - w1h);
  const parts = {
    input: per(usage.input || 0, p.input * fast),
    cacheRead: per(usage.cacheRead || 0, p.cacheRead * fast),
    cacheWrite: per(w5m, p.input * 1.25 * fast) + per(w1h, p.input * 2 * fast),
    output: per(usage.output || 0, p.output * fast),
  };
  return { ...parts, total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output };
}
