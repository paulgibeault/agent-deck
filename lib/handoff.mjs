// lib/handoff.mjs — the first prompt of a session moved to another backend.
//
// Agents keep their own history, so a session cannot be carried across
// harnesses as is. The new agent gets what a colleague taking over would:
// where the work is, what was asked, the conversation so far (the same
// digest Ask reads, newest kept, every prompt kept), the files it touched,
// what is not committed yet, and how the last test run went. Built from the
// events and git alone: no model call.
//
// Moving back to the backend a session came from resumes the original
// session instead (it still has its history); returnPrompt() tells it only
// what happened while it was away.
import { digest } from './digest.mjs';

// About 8k tokens: room to work even on a 64k local model.
export const HANDOFF_BUDGET = 28_000;

// A test runner where a command starts (not, say, in the body of a `gh issue create`):
// after env assignments, cd, or a launcher like npx / uv run / python -m.
const TEST_RE = /^(?:\w+=\S*\s+)*(?:npx\s+|bunx\s+|uv\s+run\s+|poetry\s+run\s+|python3?\s+-m\s+|\S*\/)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|pytest|go\s+test|cargo\s+(?:test|nextest)|jest|vitest|mocha|rspec|phpunit|make\s+(?:test|check)|swift\s+test|mvn\s+test|gradlew?\s+test|deno\s+test|tox)\b/;
const runsTests = (cmd) => cmd.split(/\n|&&|\|\||[;|(]/).some(part => TEST_RE.test(part.trim()));
const tail = (s, n) => { const t = String(s || '').trim(); return t.length > n ? '…' + t.slice(-(n - 1)) : t; };

/** The newest finished test run in `events`: { command, failed, output } or null. */
export function lastTestRun(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'tool' || ev.tool?.pending) continue;
    const cmd = ev.tool.command || ev.tool.input?.command;
    if (typeof cmd === 'string' && runsTests(cmd)) return { command: cmd.trim(), failed: !!ev.tool.isError, output: tail(ev.tool.result?.text, 1500) };
  }
  return null;
}

/** `work` is lib/gitinfo.mjs changes(): what is not committed yet, one line a file. */
function workSection(work) {
  if (!work?.repo || !work.files?.length) return null;
  const t = work.totals || {};
  const lines = work.files.slice(0, 40).map(f => {
    const st = f.untracked ? '??' : `${f.x}${f.y}`.replace(/ /g, '·');
    const n = f.binary ? ' (binary)' : f.added != null ? ` +${f.added} −${f.deleted || 0}` : '';
    return `${st} ${f.from ? `${f.from} → ` : ''}${f.path}${n}`;
  });
  if (work.files.length > 40) lines.push(`…and ${work.files.length - 40} more`);
  return `## Not committed yet\n${t.files} file${t.files === 1 ? '' : 's'}, +${t.added || 0} −${t.deleted || 0} against HEAD${work.branch ? ` on ${work.branch}` : ''}:\n${lines.join('\n')}`;
}

function testSection(run) {
  if (!run) return null;
  return `## Last test run (${run.failed ? 'failed' : 'passed'})\n$ ${run.command}${run.output ? `\n\`\`\`\n${run.output}\n\`\`\`` : ''}`;
}

const askSection = (note, fallback) => `## What to do now\n${note.trim() || fallback}`;

/** Fit the conversation digest into what the other sections leave of `budget`. */
function assemble(head, events, tailParts, budget) {
  const rest = tailParts.filter(Boolean).join('\n\n');
  const room = Math.max(4000, budget - head.length - rest.length - 40);
  return `${head}\n\n## Conversation so far\n${digest(events, room) || '(nothing recorded)'}\n\n${rest}`;
}

/**
 * `summary`: the session's index summary; `events`: its normalized events;
 * `brief`: its generated brief, if any; `from`/`to`: backend labels;
 * `files`: paths it touched; `work`: gitinfo changes() of its folder;
 * `note`: what the pilot wants next (optional).
 */
export function handoffPrompt({ summary = {}, events = [], brief = null, from, to, files = [], work = null, note = '', budget = HANDOFF_BUDGET }) {
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
    for (const [label, items] of [['Completed', brief.done], ['In progress', brief.doing], ['Planned', brief.planned]])
      if (items?.length) b.push(`${label}:\n${items.map(x => `- ${x}`).join('\n')}`);
    out.push(b.join('\n'));
  }
  if (files.length) out.push(`## Files it touched\n${files.slice(0, 60).map(f => `- ${f}`).join('\n')}${files.length > 60 ? `\n- …and ${files.length - 60} more` : ''}`);
  return assemble(out.join('\n\n'), events, [workSection(work), testSection(lastTestRun(events)),
    askSection(note, 'Pick up where it left off. If the last request is finished, say in a sentence or two where things stand and wait for the next one.')], budget);
}

/**
 * The prompt that resumes the original session after a stay on another
 * backend: `events` are the other session's, from its handoff on; `away` is
 * that backend's label.
 */
export function returnPrompt({ events = [], away, work = null, note = '', budget = HANDOFF_BUDGET }) {
  // The other session began with the handoff this session would only read back.
  const first = events.findIndex(e => e.kind === 'prompt');
  const since = first >= 0 ? events.slice(first + 1) : events;
  const head = `While you were paused, this session moved to ${away || 'another agent'} and carried on there. ` +
    'Here is what happened since. The files on disk are current, so read before changing anything.';
  return assemble(head, since, [workSection(work), testSection(lastTestRun(since)),
    askSection(note, 'Pick up from here. If the last request is finished, say in a sentence or two where things stand and wait for the next one.')], budget);
}
