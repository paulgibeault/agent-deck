// public/background.js — a session's background tasks: commands run (or
// moved) into the background, Monitors, background agents. The records come
// from lib/transcript.mjs (meta.tasks); the output tail from
// /api/sessions/:id/tasks/:taskId/output. Rendering only: app.js wires it.
import { h, ib, svgUse, fmtTime, fmtMs, ago, oneLine, codeBlock, copyBtn, section, headerFor } from './events.js';

const KIND = { command: 'Command', monitor: 'Monitor', agent: 'Agent' };
const DONE = { completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'stopped' };

/**
 * running | completed | failed | killed | stopped | ended. A task the
 * transcript still calls running but whose session process is gone died with
 * it: 'ended'.
 */
export function taskState(t, alive) {
  if (t.status === 'running') return alive ? 'running' : 'ended';
  return DONE[t.status] || t.status || 'ended';
}
export const taskTitle = (t) => t.description || oneLine(t.command || '', 80) || `${KIND[t.kind] || 'Task'} ${t.id}`;
const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
/** Running time so far, or how long it ran. */
export function taskDuration(t, alive, now = Date.now()) {
  const st = taskState(t, alive);
  if (st === 'running') return t.startedTs ? now - Date.parse(t.startedTs) : null;
  return ms(t.startedTs, t.endedTs);
}
const fmtSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;

export function stateChip(t, alive) {
  const st = taskState(t, alive);
  const cls = st === 'running' ? 'st-running' : st === 'completed' && (t.exitCode == null || t.exitCode === 0) ? 'ok' : st === 'failed' || (t.exitCode != null && t.exitCode !== 0) ? 'err' : 'st-ended';
  const label = st === 'ended' ? 'ended with the session' : t.exitCode != null && st !== 'running' ? `${st} · exit ${t.exitCode}` : st;
  return h('span', { class: `chip ${cls}` }, label);
}
/** A clock that app.js's one-second tick keeps current while it runs. */
function clockEl(t, alive) {
  const d = taskDuration(t, alive);
  if (taskState(t, alive) !== 'running' || !t.startedTs) return h('span', { class: 'bg-dur' }, d != null ? fmtMs(d) : '');
  return h('span', { class: 'bg-dur nl-e', dataset: { started: String(Date.parse(t.startedTs)) } }, fmtMs(d));
}

/** The strip under the status line: what is still running, one click from its details. */
export function renderStrip(tasks, alive, { open, openTab }) {
  const running = alive ? tasks.filter(t => t.status === 'running') : [];
  if (!running.length) return [];
  const shown = running.slice(0, 3);
  return [
    h('span', { class: 'bg-k' }, svgUse('i-bg', 12), `${running.length} in background`),
    ...shown.map(t => h('button', { type: 'button', class: 'bg-chip', title: t.command || taskTitle(t), onclick: () => open(t.id) },
      h('span', { class: 'bg-dot' }), h('span', { class: 'bg-t' }, taskTitle(t)), clockEl(t, alive),
      t.lastEventTs ? h('span', { class: 'muted bg-ev', title: t.events.at(-1)?.text || '' }, `· ${oneLine(t.events.at(-1)?.text || '', 40)}`) : null)),
    running.length > shown.length ? h('span', { class: 'muted' }, `+${running.length - shown.length}`) : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'linkish', onclick: openTab }, 'Background tab'),
  ].filter(Boolean);
}

/** The Background tab's list. */
export function renderTable(tasks, alive, { filter = 'all', q = '', selected = null, open }) {
  const query = q.trim().toLowerCase();
  const rows = tasks
    .filter(t => filter === 'all' || (filter === 'running') === (taskState(t, alive) === 'running'))
    .filter(t => !query || `${t.description || ''} ${t.command || ''} ${t.summary || ''} ${t.id}`.toLowerCase().includes(query))
    .sort((a, b) => (taskState(b, alive) === 'running') - (taskState(a, alive) === 'running') || (b.startedTs || '').localeCompare(a.startedTs || ''));
  if (!rows.length) return h('p', { class: 'muted bg-empty' }, tasks.length ? 'Nothing matches.' : 'No background tasks in this session. Commands Claude runs in the background, Monitors and background agents show up here.');
  const now = Date.now();
  const tbody = h('tbody', {}, ...rows.map(t => {
    const last = t.events.at(-1);
    const activity = last ? `${oneLine(last.text, 80)} · ${ago(now - Date.parse(last.ts))} ago` : t.summary ? oneLine(t.summary, 90)
      : t.timedOutAfterMs ? `moved to the background after ${fmtMs(t.timedOutAfterMs)}` : '';
    return h('tr', { class: t.id === selected ? 'selected' : null, dataset: { task: t.id }, onclick: () => open(t.id) },
      h('td', {}, stateChip(t, alive)),
      h('td', { class: 'muted' }, KIND[t.kind] || t.kind),
      h('td', { class: 'bg-what' }, h('div', { class: 'bg-t' }, taskTitle(t)), t.command && t.description ? h('div', { class: 'mono muted bg-cmd' }, oneLine(t.command, 140)) : null),
      h('td', { class: 'num muted', title: t.startedTs ? new Date(t.startedTs).toLocaleString() : '' }, t.startedTs ? `${ago(now - Date.parse(t.startedTs))} ago` : ''),
      h('td', { class: 'num' }, clockEl(t, alive)),
      h('td', { class: 'muted bg-act' }, activity));
  }));
  return h('table', { class: 'list bg-tbl' },
    h('thead', {}, h('tr', {}, ...['State', 'Kind', 'Task', 'Started', 'Ran', 'Latest'].map(x => h('th', {}, x)))), tbody);
}

/** The output section: the end of the task's output file. */
export function renderOutput(out, t, alive, ctx) {
  const running = taskState(t, alive) === 'running';
  if (!out) return section('Output', { note: 'loading…' }, h('pre', { class: 'plain out bg-out' }, ''));
  if (out.missing) return section('Output', {}, h('p', { class: 'muted' }, out.reason));
  const note = [fmtSize(out.size), out.truncated ? 'showing the end' : null, out.mtime ? `updated ${ago(Date.now() - out.mtime)} ago` : null, running ? 'live' : null].filter(Boolean).join(' · ');
  return section('Output', { note, actions: [copyBtn(out.text), out.file ? ib('i-open', 'Open the output file in the editor', () => ctx.api.openEditor(out.file), { size: 13 }) : null] },
    h('pre', { class: `plain out bg-out${t.status === 'failed' ? ' err' : ''}` }, out.text || '(no output yet)'));
}

/** The details pane for one task. `out`: the last output read, or null while loading. */
export function renderTaskDetails(t, out, ctx) {
  const alive = ctx.alive;
  const root = h('div', { class: 'details bg-details' });
  const st = taskState(t, alive);
  root.append(headerFor({
    tag: h('span', { class: 'tag f-muted' }, 'Bg'), chips: [stateChip(t, alive), h('span', { class: 'chip' }, KIND[t.kind] || t.kind)], title: taskTitle(t), nav: false,
    meta: [t.startedTs ? `started ${fmtTime(t.startedTs)}` : null, taskDuration(t, alive) != null ? `${st === 'running' ? 'running' : 'ran'} ${fmtMs(taskDuration(t, alive))}` : null,
      t.timedOutAfterMs ? `moved to the background after ${fmtMs(t.timedOutAfterMs)}` : null,
      t.expiresTs && st === 'running' ? `expires ${fmtTime(t.expiresTs)}` : null, `id ${t.id}`],
    actions: [
      t.toolUseId && ctx.openCall ? ib('i-right', 'Jump to the call that started it', () => ctx.openCall(t.toolUseId), { size: 13 }) : null,
      t.agentId && ctx.openAgent ? ib('i-open', 'Open the subagent', () => ctx.openAgent(t.agentId), { size: 13 }) : null,
    ],
  }));
  const body = h('div', { class: 'dbody' });
  root.append(body);
  if (st === 'running' && t.stopRequestedTs) body.append(h('div', { class: 'note' }, `Claude asked to stop it at ${fmtTime(t.stopRequestedTs)}.`));
  if (st === 'ended') body.append(h('div', { class: 'note' }, 'The session’s process is gone, and background tasks end with it.'));
  if (t.summary) body.append(section('Result', {}, h('p', { class: 'bg-sum' }, t.summary)));
  if (t.command) body.append(section('Command', { actions: [copyBtn(t.command), t.kind !== 'agent' && ctx.runInShell ? ib('i-term', 'Run in Shell', () => ctx.runInShell(t.command), { size: 13 }) : null] },
    codeBlock(t.command, 'bash', { numbers: false })));
  if (t.kind === 'monitor' || t.events.length) {
    const evs = t.events.slice().reverse();
    body.append(section('Events', { note: `${t.eventCount ?? t.events.length}${t.eventCount > t.events.length ? `, latest ${t.events.length} shown` : ''}` },
      evs.length ? h('ol', { class: 'bg-events' }, ...evs.map(e => h('li', {}, h('span', { class: 'mono muted' }, fmtTime(e.ts)), h('span', {}, e.text))))
        : h('p', { class: 'muted' }, 'No events yet.')));
  }
  // A Monitor reports through its events; it has no output file of its own.
  if (t.outputFile || t.kind !== 'monitor') body.append(renderOutput(out, t, alive, ctx));
  if (ctx.askStop && st === 'running') {
    body.append(h('div', { class: 'bg-stop' }, h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.askStop(t) }, 'Ask Claude to stop it'),
      h('span', { class: 'muted' }, 'Queues a prompt; the deck cannot stop the task itself.')));
  }
  return root;
}
