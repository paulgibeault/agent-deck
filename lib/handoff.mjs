// lib/handoff.mjs — the first prompt of a session moved to another backend.
//
// Agents keep their own history, so a session cannot be carried across
// harnesses as is. The new agent gets what a colleague taking over would:
// where the work is, what was asked, the conversation so far (the same
// digest Ask reads, newest kept, every prompt kept), and the files it
// touched. Built from the events alone: no model call.
import { digest } from './digest.mjs';

// About 8k tokens: room to work even on a 64k local model.
export const HANDOFF_BUDGET = 28_000;

/**
 * `summary`: the session's index summary; `events`: its normalized events;
 * `brief`: its generated brief, if any; `from`/`to`: backend labels;
 * `files`: paths it touched; `note`: what the pilot wants next (optional).
 */
export function handoffPrompt({ summary = {}, events = [], brief = null, from, to, files = [], note = '', budget = HANDOFF_BUDGET }) {
  const out = [];
  out.push(`You are taking over a coding session that ran on ${from || 'another agent'}${to ? ` and now continues on ${to}` : ''}. ` +
    'Its history is below. The files on disk are current: the earlier agent\'s edits are already there, so read before changing anything.');
  const where = [
    summary.cwd ? `Folder: ${summary.cwd}` : null,
    summary.gitBranch ? `Branch: ${summary.gitBranch}` : null,
    summary.pr?.url ? `Pull request: ${summary.pr.url}` : null,
  ].filter(Boolean);
  if (where.length) out.push(where.join('\n'));
  if (brief?.summary) {
    const b = [`## Where it stands\n${brief.summary}`];
    if (brief.done?.length) b.push(brief.done.map(x => `- ${x}`).join('\n'));
    if (brief.next) b.push(`Next: ${brief.next}`);
    out.push(b.join('\n'));
  }
  if (files.length) out.push(`## Files it touched\n${files.slice(0, 60).map(f => `- ${f}`).join('\n')}${files.length > 60 ? `\n- …and ${files.length - 60} more` : ''}`);
  const head = out.join('\n\n');
  const ask = note.trim()
    ? `## What to do now\n${note.trim()}`
    : '## What to do now\nPick up where it left off. If the last request is finished, say in a sentence or two where things stand and wait for the next one.';
  const room = Math.max(4000, budget - head.length - ask.length - 40);
  return `${head}\n\n## Conversation so far\n${digest(events, room) || '(nothing recorded)'}\n\n${ask}`;
}
