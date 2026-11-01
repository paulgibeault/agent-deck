// lib/journal.mjs — the deck's own transcript for sessions that have no file.
//
// Claude Code writes an append-only JSONL per session and the deck reads it.
// Agents driven over ACP keep their history somewhere the deck does not read
// (opencode: a database), so the deck writes one itself, in the same shape:
//
//   <state dir>/sessions/<harness>/<cwd slug>/<sessionId>.jsonl
//
// Lines, each one JSON object:
//   { t: 'session', v: 1, id, harness, cwd, title, startedAt }   first line
//   { t: 'event', e: <normalized event> }   a later line for the same e.id replaces it
//   { t: 'meta', m: { …patch } }           session metadata (model, mode, context, cost)
//   { t: 'title', title }
//
// Writes are batched: a streamed message changes many times a second, and
// only its latest version at each flush is written. Files older than the
// retention window are deleted on scan, as Claude Code does with its own
// (cleanupPeriodDays, 30 days by default).
import fs from 'node:fs';
import path from 'node:path';

const FLUSH_MS = 1000;
const PROBE_BYTES = 64 * 1024;
// Rewrite a file on load once most of its lines are stale versions of others.
const COMPACT_MIN_BYTES = 256 * 1024;

const slug = (cwd) => String(cwd || 'unknown').replace(/[^a-zA-Z0-9]/g, '-');
const safe = (s) => String(s || 'agent').replace(/[^\w.-]/g, '_');
const DAY = 86_400_000;

export class Journal {
  constructor({ dir, retentionDays = 30 } = {}) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.open_ = new Map();    // id -> { file, pending: Map(eventId -> event), meta, title }
    this.timer = null;
  }

  pathFor(harness, cwd, id) { return path.join(this.dir, safe(harness), slug(cwd), `${safe(id)}.jsonl`); }

  /** Start (or continue) the journal for a session; returns its file. */
  open(id, { harness, cwd, title = null, file = null } = {}) {
    const cur = this.open_.get(id);
    if (cur) return cur.file;
    file ||= this.pathFor(harness, cwd, id);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ t: 'session', v: 1, id, harness, cwd, title, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    }
    this.open_.set(id, { file, pending: new Map(), meta: null, title: null });
    return file;
  }

  /**
   * Queue what changed: events (their current version is written at flush), a
   * meta patch, a title. `at`: when it happened, if not now (a replayed
   * history); the file's time is set to it, since a scan takes the session's
   * last activity from the file's time, as with Claude Code's transcripts.
   */
  record(id, { events = [], meta = null, title = null, at = null } = {}) {
    const j = this.open_.get(id);
    if (!j) return;
    for (const ev of events) j.pending.set(ev.id, ev);
    if (meta) j.meta = { ...j.meta, ...meta };
    if (title) j.title = title;
    j.at = at;
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), FLUSH_MS); this.timer.unref?.(); }
  }

  /** Write everything queued (also on shutdown). */
  flush() {
    clearTimeout(this.timer); this.timer = null;
    for (const j of this.open_.values()) {
      if (!j.pending.size && !j.meta && !j.title) continue;
      const lines = [];
      if (j.title) lines.push({ t: 'title', title: j.title });
      if (j.meta) lines.push({ t: 'meta', m: j.meta });
      for (const e of j.pending.values()) lines.push({ t: 'event', e });
      const at = j.at;
      j.pending.clear(); j.meta = null; j.title = null; j.at = null;
      try {
        fs.appendFileSync(j.file, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
        if (at) fs.utimesSync(j.file, new Date(at), new Date(at));
      } catch { /* the session still lives in memory */ }
    }
  }

  /** Stop writing a session (flushing it first). */
  close(id) { if (this.open_.has(id)) { this.flush(); this.open_.delete(id); } }

  /**
   * Every journal file: [{ id, file, harness, cwd, title, startedAt, mtime, size }].
   * Files past the retention window are deleted.
   */
  scan(now = Date.now()) {
    const out = [];
    const cutoff = this.retentionDays > 0 ? now - this.retentionDays * DAY : -Infinity;
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (d.isFile() && depth === 2 && d.name.endsWith('.jsonl')) {
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.mtimeMs < cutoff && !this.open_.has(d.name.slice(0, -6))) { try { fs.unlinkSync(p); } catch { /* in use */ } continue; }
          const head = probe(p, st.size);
          if (head) out.push({ ...head, file: p, mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    walk(this.dir, 0);
    return out;
  }

  /** Read a journal: { header, events (first-seen order, latest version), meta, title }. Compacts a bloated file. */
  read(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    let header = null, title = null, lines = 0;
    const events = new Map(); const meta = {};
    for (const l of text.split('\n')) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      lines++;
      if (r.t === 'session') { header = r; title ||= r.title; }
      else if (r.t === 'event' && r.e?.id) events.set(r.e.id, r.e);   // a Map keeps the first-seen order
      else if (r.t === 'meta') Object.assign(meta, r.m);
      else if (r.t === 'title' && r.title) title = r.title;
    }
    if (!header) return null;
    const out = { header, events: [...events.values()], meta, title };
    if (text.length > COMPACT_MIN_BYTES && lines > 2 * (events.size + 3) && !this.open_.has(header.id)) this._compact(file, out);
    return out;
  }

  _compact(file, { header, events, meta, title }) {
    const lines = [{ ...header, title }, Object.keys(meta).length ? { t: 'meta', m: meta } : null, ...events.map(e => ({ t: 'event', e }))].filter(Boolean);
    const tmp = file + '.tmp';
    try { fs.writeFileSync(tmp, lines.map(x => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch { try { fs.unlinkSync(tmp); } catch { /* none */ } }
  }
}

/** The header and latest title of a journal without reading all of it. */
function probe(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, head, 0, head.length, 0);
    const first = head.toString('utf8').split('\n')[0];
    let header; try { header = JSON.parse(first); } catch { return null; }
    if (header?.t !== 'session' || !header.id) return null;
    let title = header.title || null;
    const n = Math.min(size, PROBE_BYTES);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    for (const l of tail.toString('utf8').split('\n')) if (l.startsWith('{"t":"title"')) { try { title = JSON.parse(l).title || title; } catch { /* cut */ } }
    return { id: header.id, harness: header.harness, cwd: header.cwd, title, startedAt: header.startedAt };
  } catch { return null; }
  finally { if (fd != null) fs.closeSync(fd); }
}
