// lib/digest.mjs — turn normalized events into compact text a model can read.
// One line per event, each tagged with its seq (#123) so a reply can point
// back at an event.

function clip(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function hhmmss(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return isNaN(d) ? '--:--:--' : d.toTimeString().slice(0, 8);
}
function secs(ms) { return ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

export function eventLine(ev) {
  const head = `#${ev.seq} ${hhmmss(ev.ts)}`;
  switch (ev.kind) {
    case 'prompt': return `${head} USER: ${clip(ev.text?.replace(/<[^>]+>/g, ' '), 700)}`;
    case 'text': return `${head} ASSISTANT: ${clip(ev.text, 500)}`;
    case 'thinking': return null;
    case 'turn_end': return `${head} --- turn ended ---`;
    case 'queue': return `${head} QUEUE ${ev.op}${ev.text ? ': ' + clip(ev.text, 160) : ''}`;
    case 'system': return ev.error ? `${head} ERROR: ${clip(ev.text, 300)}` : (ev.subtype === 'compact_summary' ? `${head} (context compacted)` : null);
    case 'tool': {
      const t = ev.tool;
      let res;
      if (t.pending) res = 'running';
      else if (t.isError) res = `ERROR: ${clip(t.result?.text, 240)}`;
      else if (t.name === 'Agent') res = 'returned';
      else res = `ok${t.durationMs != null ? ' ' + secs(t.durationMs) : ''}`;
      return `${head} TOOL ${t.display} ${clip(t.summary, 200)} → ${res}`;
    }
    default: return null;
  }
}

/**
 * Digest of events, newest kept when over budget. User prompts are always
 * kept (they carry the goal), so a long session still shows what was asked.
 */
export function digest(events, budget = 40_000) {
  const lines = [];
  for (const ev of events) { const l = eventLine(ev); if (l) lines.push({ l, prompt: ev.kind === 'prompt' }); }
  let total = lines.reduce((n, x) => n + x.l.length + 1, 0);
  if (total <= budget) return lines.map(x => x.l).join('\n');
  // Drop oldest non-prompt lines first.
  const keep = new Array(lines.length).fill(true);
  let dropped = 0;
  for (let i = 0; i < lines.length && total > budget; i++) {
    if (lines[i].prompt) continue;
    keep[i] = false; total -= lines[i].l.length + 1; dropped++;
  }
  const out = lines.filter((_, i) => keep[i]).map(x => x.l);
  if (dropped) out.unshift(`(${dropped} older events omitted)`);
  return out.join('\n').slice(-budget);
}

/** The events of the turn that contains `seq`: from its prompt to its turn end. */
export function turnOf(events, seq) {
  let i = events.findIndex(e => e.seq === seq);
  if (i < 0) return [];
  let a = i; while (a > 0 && events[a].kind !== 'prompt') a--;
  let b = i; while (b < events.length - 1 && events[b].kind !== 'turn_end') b++;
  return events.slice(a, b + 1);
}
