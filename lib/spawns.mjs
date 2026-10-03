// lib/spawns.mjs — sessions started by other sessions.
//
// A session that runs `claude -p ...` through its Bash tool starts a whole new
// headless session with its own transcript, and nothing in that transcript
// names the parent. The parent's transcript does, by time: the child started
// while one of the parent's Bash calls that runs `claude` was in flight. This
// keeps those windows per transcript, read incrementally, and matches
// headless sessions (entrypoint sdk-cli) to them.
import fs from 'node:fs';

// `claude` as a command word, not as part of a path like ~/.claude/.
const RUNS_CLAUDE = /(?:^|[\s;&|(`'"])(?:\S*\/)?claude(?=\s|$|[;&|)`'"])/m;
const SLACK_BEFORE_MS = 2_000;
const SLACK_AFTER_MS = 5_000;    // the child's first record can land just after a fast call returns
const CHUNK = 4 * 1024 * 1024;

export const runsClaude = (command) => RUNS_CLAUDE.test(String(command || '').replace(/(^|\/)\.claude\b/g, ''));

export class SpawnWindows {
  constructor() {
    this.byFile = new Map();   // file -> { offset, partial, pending: Map(toolUseId -> start), windows: [{ start, end }] }
  }

  /** Bash-runs-claude windows in `file`, reading only what was appended since last time. */
  windows(file) {
    let st = this.byFile.get(file);
    if (!st) { st = { offset: 0, partial: '', pending: new Map(), windows: [] }; this.byFile.set(file, st); }
    let size;
    try { size = fs.statSync(file).size; } catch { return []; }
    if (size < st.offset) { st.offset = 0; st.partial = ''; st.pending.clear(); st.windows = []; }   // rewritten
    if (size > st.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - st.offset));
        while (st.offset < size) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - st.offset), st.offset);
          if (!n) break;
          st.offset += n;
          const lines = (st.partial + buf.toString('utf8', 0, n)).split('\n');
          st.partial = lines.pop();
          for (const line of lines) this._line(st, line);
        }
      } finally { fs.closeSync(fd); }
    }
    return [...st.windows, ...[...st.pending.values()].map(start => ({ start, end: null }))];
  }

  _line(st, line) {
    // Most lines are neither; skip the JSON parse for them.
    const use = line.includes('"tool_use"') && line.includes('"Bash"');
    const result = st.pending.size && line.includes('"tool_result"');
    if (!use && !result) return;
    let rec; try { rec = JSON.parse(line); } catch { return; }
    const ts = Date.parse(rec.timestamp);
    const content = rec.message?.content;
    if (!Array.isArray(content) || !ts) return;
    for (const c of content) {
      if (c?.type === 'tool_use' && c.name === 'Bash' && runsClaude(c.input?.command)) st.pending.set(c.id, ts);
      else if (c?.type === 'tool_result' && st.pending.has(c.tool_use_id)) {
        st.windows.push({ start: st.pending.get(c.tool_use_id), end: ts });
        st.pending.delete(c.tool_use_id);
      }
    }
  }

  /**
   * Which of `candidates` ({ id, file }) started the session that began at
   * `startMs`? The latest window that covers it wins. Null if none.
   */
  parentOf(startMs, candidates, now = Date.now()) {
    let best = null;
    for (const c of candidates) {
      for (const w of this.windows(c.file)) {
        const end = w.end ?? now;
        if (startMs >= w.start - SLACK_BEFORE_MS && startMs <= end + SLACK_AFTER_MS && (!best || w.start > best.start)) best = { id: c.id, start: w.start };
      }
    }
    return best?.id || null;
  }
}
