// lib/brief.mjs — heuristic brief: free, instant, derived purely from the
// normalized stream plus the registry entry. No model calls.

function ago(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

function firstSentence(text, max = 200) {
  if (!text) return null;
  const t = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const m = /^(.{10,}?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The newest event that says something: the one at the top of the list. */
function topEvent(evs) {
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === 'turn_end' || e.kind === 'queue' || e.kind === 'thinking') continue;
    if (e.kind === 'system' && !e.error) continue;
    return e;
  }
  return null;
}

/** The question itself, when a reply ends on one: its last sentence. */
function lastQuestion(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /([^.!?]*\?)\s*$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * @param {import('./transcript.mjs').SessionState} state
 * @param {object} summary  from SessionIndex.summary()
 * @param {object|null} reg registry entry (live sessions only)
 */
export function computeBrief(state, summary, reg, now = Date.now()) {
  const m = state.meta;
  const evs = state.events;
  const last = evs.at(-1) || null;
  const lastTs = m.lastTs ? Date.parse(m.lastTs) : null;
  const sinceLast = lastTs ? now - lastTs : null;

  const pendingTools = evs.filter(e => e.kind === 'tool' && e.tool.pending && e.tool.name !== 'Agent');
  const runningAgents = (summary?.subagents || []).filter(s => s.status === 'running');
  const alive = summary?.kind === 'agent' ? summary.status === 'running' : !!summary?.alive;
  const busy = reg ? reg.status === 'busy' : (summary?.kind === 'agent' ? summary.status === 'running' : false);
  // `claude -p` transcripts have no turn-end record, so for deck-launched
  // sessions the process state is the only reliable busy/idle signal.
  const inTurn = reg?.kind === 'deck' ? false : m.inTurn;

  let stateLabel; let detail = null; let activeTool = null;
  if (!alive && summary?.kind !== 'agent') {
    stateLabel = 'ended';
    detail = lastTs ? `last activity ${ago(sinceLast)} ago` : null;
  } else if (summary?.kind === 'agent' && summary.status !== 'running') {
    stateLabel = summary.status;
    detail = lastTs ? `${ago(sinceLast)} ago` : null;
  } else if (reg?.waiting === 'permission') {
    stateLabel = 'needs permission';
    const t = pendingTools.at(-1);
    detail = t ? `${t.tool.display} ${t.tool.summary}`.trim() : null;
  } else if (pendingTools.length) {
    const t = pendingTools.at(-1);
    activeTool = { id: t.id, name: t.tool.display, summary: t.tool.summary, startedMs: t.ts ? now - Date.parse(t.ts) : null };
    stateLabel = 'running';
    detail = `${t.tool.display} ${t.tool.summary}`.trim() + (activeTool.startedMs != null ? ` · ${ago(activeTool.startedMs)}` : '');
    if (runningAgents.length) detail += ` · ${runningAgents.length} subagent${runningAgents.length === 1 ? '' : 's'} running`;
  } else if (runningAgents.length) {
    stateLabel = 'waiting on subagents';
    detail = runningAgents.map(a => a.title).slice(0, 3).join(', ') + (runningAgents.length > 3 ? ` +${runningAgents.length - 3}` : '');
  } else if (busy || inTurn) {
    if (last?.kind === 'thinking') { stateLabel = 'thinking'; detail = !last.text ? null : `${last.text.length} chars`; }
    else if (last?.kind === 'text') { stateLabel = 'responding'; }
    else if (last?.kind === 'prompt') { stateLabel = 'starting turn'; }
    else if (last?.kind === 'tool' && !last.tool.pending) { stateLabel = 'working'; detail = `after ${last.tool.display} ${last.tool.summary}`; }
    else { stateLabel = busy ? 'busy' : 'working'; }
    if (sinceLast != null && sinceLast > 20_000) detail = [detail, `${ago(sinceLast)} since last event`].filter(Boolean).join(' · ');
  } else {
    stateLabel = 'idle';
    detail = sinceLast != null ? `${ago(sinceLast)}` : null;
    const queued = m.queue.filter(q => !q.note).length;
    if (queued) detail = `${detail || ''} · ${queued} queued`.replace(/^ · /, '');
  }

  const turnMs = m.lastTurnStart ? ((m.inTurn ? now : (m.lastTurnEnd ? Date.parse(m.lastTurnEnd) : now)) - Date.parse(m.lastTurnStart)) : null;

  // The four states the UI distinguishes: working, turn (waiting on the
  // pilot), done (a finished subagent), ended (process gone).
  let phase;
  if (stateLabel === 'ended' || stateLabel === 'stale') phase = 'ended';
  else if (stateLabel === 'done') phase = 'done';
  else if (stateLabel === 'idle' || stateLabel === 'needs permission') phase = 'turn';
  else phase = 'working';

  // Who the session is waiting on, the one question the supervisor asks first.
  let waitingOn;
  if (phase === 'ended' || phase === 'done') waitingOn = null;
  else if (phase === 'turn') waitingOn = 'you';
  else if (activeTool) waitingOn = 'tool';
  else if (stateLabel === 'waiting on subagents') waitingOn = 'subagents';
  else waitingOn = 'model';
  // A turn that ended on a question is a request for an answer, not just idle.
  const asked = stateLabel === 'idle' && /\?\s*$/.test((m.lastText || '').replace(/[`*_\s]+$/, ''));

  let lastError = null;
  for (let i = evs.length - 1; i >= 0 && !lastError; i--) {
    const e = evs[i];
    if ((e.kind === 'tool' && e.tool.isError) || (e.kind === 'system' && e.error)) lastError = e;
  }

  // The signal: one of five states every view colours by, and the root of
  // "needs you". Highest priority first:
  //   input    paused on the pilot: a permission prompt, or a turn that ended on a question
  //   error    the newest event is an error
  //   working  the agent is busy
  //   done     finished cleanly (a completed turn, a finished subagent)
  //   ended    the process is gone
  const top = topEvent(evs);
  const topError = !!top && ((top.kind === 'tool' && top.tool.isError) || (top.kind === 'system' && top.error));
  let signal, need = null;
  if (summary?.kind === 'agent') signal = summary.status === 'running' ? 'working' : summary.status === 'done' ? 'done' : 'ended';
  else if (phase === 'ended') signal = 'ended';
  else if (stateLabel === 'needs permission') { signal = 'input'; need = { kind: 'permission', text: detail || 'a tool call' }; }
  else if (asked) { signal = 'input'; need = { kind: 'question', text: firstSentence(lastQuestion(m.lastText), 240) }; }
  else if (topError) { signal = 'error'; need = { kind: 'error', text: firstSentence(top.kind === 'tool' ? `${top.tool.display} ${top.tool.summary}: ${top.tool.result?.text || 'failed'}` : top.text, 240), seq: top.seq }; }
  else if (phase === 'working') signal = 'working';
  else signal = 'done';
  if (need) need.since = (signal === 'error' ? top.ts : m.lastTs) || null;

  return {
    state: stateLabel,
    phase,
    signal,
    need,
    waitingOn,
    asked,
    // Quiet time while working: a long one means a slow tool, a long think or a stall.
    quietMs: phase === 'working' ? sinceLast : null,
    lastErrorTs: lastError?.ts || null,
    detail,
    activeTool,
    lastText: firstSentence(m.lastText),
    lastPrompt: m.lastPrompt ? firstSentence(m.lastPrompt, 140) : null,
    turnUsage: m.turnUsage,
    usage: m.usage,
    cost: m.cost,
    turns: m.turns,
    turnMs,
    filesTouched: state.files.size,
    errors: m.errors,
    branch: m.gitBranch,
    pr: m.pr,
    model: m.model,
    effort: m.effort,
    mode: m.mode,
    queueDepth: m.queue.filter(q => !q.note).length,
    subagents: { running: runningAgents.length, total: (summary?.subagents || []).length },
    idleMs: stateLabel === 'idle' ? sinceLast : null,
    lastEventTs: m.lastTs,
    updatedAt: now,
  };
}
