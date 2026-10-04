// public/activity.js — what has happened in a session since a given event,
// weighed by how much it would change a brief. Shared: the server's brief
// scheduler decides when to refresh with it, and the page shows the same
// counts under the brief. No DOM, no Node APIs.

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT = new Set(['Agent', 'Task']);
// Commands that close a chunk of work: worth a refresh on their own.
const MILESTONE = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|tag)\b|\bgh\s+pr\s+(?:create|merge)\b|\bnpm\s+publish\b/;

// Reads and searches are how an agent looks around; they rarely change what
// a brief says, so it takes many of them to count.
export const WEIGHT = { prompt: 6, edit: 2, agent: 2, error: 2, said: 1, command: 1, look: 0.25 };

// When the brief scheduler (lib/briefs.mjs) refreshes; the page explains it with the same numbers.
export const CADENCE = {
  minGapMs: 20_000,                // between any two briefs of a session
  triggerGapMs: 45_000,            // a milestone or subagent soon after a brief waits (commit, then push)
  driftScore: 15,                  // e.g. 5 edits and 5 commands
  driftMs: 3 * 60_000,
  heartbeatScore: 3,
  heartbeatMs: 10 * 60_000,
  backgroundDriftMs: 10 * 60_000,
};

/** The milestone a tool event marks ('commit', 'push', 'PR', …), or null. */
export function milestoneOf(ev) {
  if (ev.kind !== 'tool' || ev.tool.pending || ev.tool.isError || ev.tool.name !== 'Bash') return null;
  const m = MILESTONE.exec(String(ev.tool.input?.command || ev.tool.summary || ''));
  if (!m) return null;
  const w = m[0];
  return /gh\s+pr\s+create/.test(w) ? 'PR opened' : /gh\s+pr\s+merge/.test(w) ? 'PR merged' : /publish/.test(w) ? 'publish' : w.split(/\s+/).at(-1);
}

/**
 * Tally events with seq > `afterSeq`.
 * @returns {{ events, prompts, edits, commands, looks, said, agents, errors, milestones: string[], score, firstTs }}
 */
export function activitySince(events, afterSeq = 0) {
  const a = { events: 0, prompts: 0, edits: 0, commands: 0, looks: 0, said: 0, agents: 0, errors: 0, milestones: [], score: 0, firstTs: null };
  // Events are in seq order; walk back to the first new one.
  let i = events.length;
  while (i > 0 && events[i - 1].seq > afterSeq) i--;
  for (; i < events.length; i++) {
    const e = events[i];
    let k = null;
    if (e.kind === 'prompt') k = 'prompt';
    else if (e.kind === 'text') k = 'said';
    else if (e.kind === 'system' && e.error) k = 'error';
    else if (e.kind === 'tool') {
      if (e.tool.isError) k = 'error';
      else if (EDIT.has(e.tool.name)) k = 'edit';
      else if (AGENT.has(e.tool.name)) k = 'agent';
      else if (e.tool.name === 'Bash') k = 'command';
      else k = 'look';
      const ms = milestoneOf(e);
      if (ms) a.milestones.push(ms);
    }
    if (!k) continue;   // thinking, turn ends, queue and sideband records
    a.events++;
    a.firstTs ||= e.ts || null;
    a[k === 'prompt' ? 'prompts' : k === 'edit' ? 'edits' : k === 'command' ? 'commands' : k === 'look' ? 'looks' : k === 'agent' ? 'agents' : k === 'error' ? 'errors' : 'said']++;
    a.score += WEIGHT[k];
  }
  return a;
}
