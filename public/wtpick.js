// public/wtpick.js — what a launch sends about its worktree, from the plan
// for its folder and the card chosen. No DOM here, so the tests can check it;
// worktrees.js draws the cards.

/**
 * For a dialog opened again before an earlier open's answers arrive: each
 * call to the returned function starts an open and gives back a check that
 * stays true only while that open is the latest.
 */
export function latest() {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}

/** The chosen card: the pilot's own pick, else a confident suggestion, else none. */
export const chosenOf = (plan, picked) => picked || (plan?.suggestion?.preselect ? plan.suggestion.pick : null);

/**
 * How a "Resume <branch>" card starts: 'continue' (check the branch itself
 * out) unless another worktree has it, or the pilot chose 'new' (a deck branch
 * from it). Other cards have no mode.
 */
export function resumeMode(c, modes = {}) {
  if (c?.kind !== 'branch') return null;
  if (c.checkedOutAt) return 'new';
  return modes[c.id] === 'new' ? 'new' : 'continue';
}

/**
 * The launch fields for one folder. `entry` is that folder's plan as the page
 * holds it: { state: 'ok', plan } or { state: 'failed', error }. A plan still
 * loading is awaited by the caller first. Throws (the dialog shows it) when
 * the folder's state is unknown, or it is shared and nothing is chosen.
 */
export function launchFields(entry, picked, modes = {}) {
  if (!entry || entry.state === 'loading') throw new Error('Still checking whether another session works in this folder; try again in a moment.');
  if (entry.state === 'failed') throw new Error(`Could not check whether another session works in this folder (${entry.error || 'no answer'}). Try again.`);
  const plan = entry.plan;
  if (!plan?.conflict) return null;
  const sel = chosenOf(plan, picked);
  if (!sel) throw new Error('Another session works in this folder: choose where this one starts.');
  if (sel === 'same') return { worktree: { use: false } };
  const c = plan.candidates.find(x => x.id === sel);
  if (!c) throw new Error('That base is no longer offered; choose again.');
  const sug = plan.suggestion && !plan.suggestion.error ? { ...plan.suggestion, chosen: sel } : null;
  // The card itself goes along, so the server checks it instead of gathering every candidate again.
  const mode = resumeMode(c, modes);
  return { worktree: { use: true, base: sel, cand: { id: c.id, kind: c.kind, ref: c.ref, branch: c.branch || null, ...(mode ? { mode } : {}) }, suggestion: sug } };
}
