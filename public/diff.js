// public/diff.js — line diffs, shared by the page and the server
// (lib/acp-events.mjs counts an ACP edit's lines with it). No DOM, no Node APIs.

/** Line diff via LCS; falls back to replace-all for very large inputs. */
export function lineDiff(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  const ops = [];
  if (a.length * b.length > 2_500_000) {
    for (const l of a) ops.push({ t: 'del', a: l });
    for (const l of b) ops.push({ t: 'add', b: l });
    return ops;
  }
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) ops.push({ t: 'del', a: a[i++] });
    else ops.push({ t: 'add', b: b[j++] });
  }
  while (i < n) ops.push({ t: 'del', a: a[i++] });
  while (j < m) ops.push({ t: 'add', b: b[j++] });
  return ops;
}

/** Lines added and removed between two texts. */
export function diffCounts(aText, bText) {
  let add = 0, del = 0;
  for (const op of lineDiff(aText, bText)) { if (op.t === 'add') add++; else if (op.t === 'del') del++; }
  return { add, del };
}

/**
 * Number a whole-file diff and keep only the changed lines and `context`
 * lines around them, with a hunk header before each run (as in a unified diff).
 */
export function foldDiff(ops, context = 3) {
  let an = 1, bn = 1;
  const at = [];   // [old line, new line] where each op starts, for the hunk headers
  const num = ops.map(op => {
    at.push([an, bn]);
    return op.t === 'eq' ? { ...op, an: an++, bn: bn++ } : op.t === 'del' ? { ...op, an: an++ } : { ...op, bn: bn++ };
  });
  const keep = new Uint8Array(num.length);
  num.forEach((op, i) => { if (op.t !== 'eq') for (let k = Math.max(0, i - context); k <= Math.min(num.length - 1, i + context); k++) keep[k] = 1; });
  const out = [];
  num.forEach((op, i) => {
    if (!keep[i]) return;
    if (!i || !keep[i - 1]) out.push({ t: 'hunk', text: `@@ -${at[i][0]} +${at[i][1]} @@` });
    out.push(op);
  });
  return out;
}
