// lib/usage.mjs — plan quota as Claude Code reports it. Every `claude` call
// made with stream or verbose JSON output carries a rate_limit_event:
//
//   { status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt, rateLimitType,
//     overageStatus, overageDisabledReason, isUsingOverage,
//     unifiedWindows: { five_hour: { utilization: 0.23, resetsAt }, seven_day: {...} } }
//
// The deck sees one from each of its own model calls and from each turn of a
// session it launched. Between those, `claude -p /usage` reads the same
// numbers without a model call (free, about a second), plus the per-model
// weekly windows and what is driving usage. This keeps the latest of both,
// merged per window, plus a short history per window so the UI can say how
// fast the window is filling.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { BIN, childEnv } from './narrator.mjs';

const HISTORY_MS = 6 * 3600_000;
const MIN_PACE_SPAN_MS = 10 * 60_000;   // shorter spans make the pace too jumpy to show

const secsToMs = (v) => (typeof v === 'number' && isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null);
const ORDER = ['five_hour', 'seven_day'];
const byOrder = (a, b) => ((ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99)) || a.key.localeCompare(b.key);

export class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.latest = null;     // { status, ..., windows: [{ key, label, utilization, resetsAt, at }], account, contributors, reportAt }
    this.samples = [];      // { key, at, u, resetsAt }
  }

  /** Windows from either source, newest reading per window; ones that have reset drop out. */
  _merge(windows, source, now) {
    const keep = (this.latest?.windows || []).filter(w => !w.resetsAt || w.resetsAt > now);
    const m = new Map(keep.map(w => [w.key, w]));
    for (const w of windows) m.set(w.key, { ...m.get(w.key), ...w, label: w.label || m.get(w.key)?.label || null, at: now, source });
    for (const w of windows) this.samples.push({ key: w.key, at: now, u: w.utilization, resetsAt: w.resetsAt });
    this.samples = this.samples.filter(x => now - x.at < HISTORY_MS).slice(-500);
    return [...m.values()].sort(byOrder);
  }

  /** Record a rate_limit_info object. `source` says where it came from, for the UI. */
  update(info, source, now = Date.now()) {
    if (!info || typeof info !== 'object') return;
    const windows = Object.entries(info.unifiedWindows || {})
      .filter(([, w]) => w && typeof w.utilization === 'number')
      .map(([key, w]) => ({ key, utilization: Math.max(0, w.utilization), resetsAt: secsToMs(w.resetsAt) }));
    if (!windows.length && typeof info.utilization === 'number') {
      windows.push({ key: info.rateLimitType || 'limit', utilization: info.utilization, resetsAt: secsToMs(info.resetsAt) });
    }
    this.latest = {
      ...this.latest,
      status: info.status || null,
      rateLimitType: info.rateLimitType || null,
      resetsAt: secsToMs(info.resetsAt),
      overageStatus: info.overageStatus || null,
      overageDisabledReason: info.overageDisabledReason || null,
      isUsingOverage: !!info.isUsingOverage,
      windows: this._merge(windows, source || null, now), at: now, source: source || null,
    };
    this.emit('usage', this.snapshot(now));
  }

  /** Record a parsed `claude /usage` report (parseUsageReport). */
  report(r, now = Date.now()) {
    if (!r) return;
    this.latest = {
      status: null, rateLimitType: null, resetsAt: null, overageStatus: null, overageDisabledReason: null, isUsingOverage: false,
      ...this.latest,
      windows: this._merge(r.windows, 'claude /usage', now),
      account: r.account, notes: r.notes, contributors: r.contributors, reportAt: now,
      at: now, source: 'claude /usage',
    };
    this.emit('usage', this.snapshot(now));
  }

  /**
   * How fast a window is filling: utilization per hour since the earliest
   * sample in the same window (same reset time), and where that pace lands.
   */
  pace(key, now = Date.now()) {
    const cur = this.latest?.windows.find(w => w.key === key);
    if (!cur) return null;
    // /usage prints resets to the minute; the per-call event has seconds. Same window either way.
    const same = this.samples.filter(x => x.key === key && Math.abs((x.resetsAt || 0) - (cur.resetsAt || 0)) < 2 * 60_000);
    const first = same[0], last = same.at(-1);
    if (!first || last.at - first.at < MIN_PACE_SPAN_MS) return null;
    const perHour = (last.u - first.u) / ((last.at - first.at) / 3600_000);
    if (!(perHour > 0)) return { perHour: Math.max(0, perHour), sinceMs: last.at - first.at, fullInMs: null, atReset: cur.utilization };
    const fullInMs = Math.max(0, (1 - cur.utilization) / perHour * 3600_000);
    const atReset = cur.resetsAt ? cur.utilization + perHour * Math.max(0, cur.resetsAt - now) / 3600_000 : null;
    return { perHour, sinceMs: last.at - first.at, fullInMs, atReset, hitsBeforeReset: cur.resetsAt ? now + fullInMs < cur.resetsAt : null };
  }

  snapshot(now = Date.now()) {
    if (!this.latest) return null;
    return { ...this.latest, ageMs: now - this.latest.at, windows: this.latest.windows.map(w => ({ ...w, pace: this.pace(w.key, now) })) };
  }
}

// ------------------------------------------------------------ claude /usage
// The report is text meant for people, so the parse is forgiving: lines it
// does not recognise are kept as notes rather than dropped.
//
//   You are currently using your subscription to power your Claude Code usage
//
//   Current session: 44% used · resets Oct 3 at 2:09pm (America/Boise)
//   Current week (all models): 13% used · resets Oct 7 at 4:59pm (America/Boise)
//   Current week (Fable): 5% used · resets Oct 7 at 4:59pm (America/Boise)
//
//   What's contributing to your limits usage?
//   Approximate, based on local sessions on this machine — ...
//
//   Last 24h · 488 requests · 5 sessions
//     79% of your usage was at >150k context
//     Top subagents: Explore 3%

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function tzOffset(t, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  } catch { return -new Date(t).getTimezoneOffset() * 60_000; }   // unknown zone: assume this machine's
}
/** A wall-clock time in `tz` as epoch ms. */
function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const t = guess - tzOffset(guess, tz);
  return guess - tzOffset(t, tz);   // second pass settles DST edges
}

/** "Oct 3 at 2:09pm (America/Boise)" (date, time and zone each optional) -> epoch ms, the next such moment after `now`. */
export function parseReset(text, now = Date.now()) {
  const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?)?(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s*(?:\(([^)]+)\))?\s*$/i.exec(String(text || '').trim());
  if (!m || (!m[1] && !m[4])) return null;
  const tz = m[7] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let h = m[4] ? +m[4] % 12 + (/pm/i.test(m[6] || '') ? 12 : 0) : 0;
  if (m[4] && !m[6]) h = +m[4];   // 24-hour clock
  const mi = m[5] ? +m[5] : 0;
  const local = new Date(now + tzOffset(now, tz));   // "today" in that zone, read with UTC getters
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return null;
    let y = m[3] ? +m[3] : local.getUTCFullYear();
    let t = zoned(y, mo, +m[2], h, mi, tz);
    if (!m[3] && t < now - 86400_000) t = zoned(++y, mo, +m[2], h, mi, tz);
    return t;
  }
  let t = zoned(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, mi, tz);
  if (t < now - 60_000) t += 86400_000;
  return t;
}

function windowKey(label) {
  const l = label.toLowerCase();
  if (/^current session$/.test(l)) return 'five_hour';
  if (/^current week( \(all models\))?$/.test(l)) return 'seven_day';
  const model = /^current week \((.+)\)$/.exec(l);
  if (model) return `seven_day_${model[1].replace(/[^a-z0-9]+/g, '_')}`;
  return l.replace(/^current /, '').replace(/[^a-z0-9]+/g, '_');
}

/** Parse the text `claude -p /usage` prints. Null when it holds no usage at all. */
export function parseUsageReport(text, now = Date.now()) {
  const lines = String(text || '').split('\n');
  const out = { account: null, windows: [], notes: [], contributors: null };
  let contrib = null, section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^what.s contributing/i.test(line)) { contrib = out.contributors = { note: null, sections: [] }; continue; }
    if (contrib) {
      if (/^\s/.test(raw) && section) section.items.push(line);
      else if (/^last\b/i.test(line)) { section = { title: line, items: [] }; contrib.sections.push(section); }
      else if (!section && !contrib.note) contrib.note = line;
      else if (section) section.items.push(line);
      continue;
    }
    const w = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used\b(?:\s*[·•-]\s*resets\s+(.+))?$/i.exec(line);
    if (w) { out.windows.push({ key: windowKey(w[1]), label: w[1].replace(/^Current /, '').replace(/^./, c => c.toUpperCase()), utilization: +w[2] / 100, resetsAt: w[3] ? parseReset(w[3], now) : null }); continue; }
    if (!out.account && /\b(using|plan|subscription|api)\b/i.test(line) && !out.windows.length) { out.account = line; continue; }
    out.notes.push(line);
  }
  return out.windows.length || out.account ? out : null;
}

/** Run `claude -p /usage`: no model call, so it costs nothing. Resolves to its text. */
export function readUsageReport({ timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(BIN, ['-p', '/usage', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json'], { cwd: os.tmpdir(), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(new Error(`cannot start ${BIN}: ${e.message}`)); }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude /usage timed out')); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `${BIN} CLI not found on PATH (set DECK_CLAUDE_BIN)` : e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let d; try { d = JSON.parse(stdout); } catch { return reject(new Error(`claude /usage exited ${code}: ${(stderr || stdout).trim().slice(0, 300) || 'no output'}`)); }
      const r = Array.isArray(d) ? d.findLast(x => x?.type === 'result') : d;
      if (!r || r.is_error) return reject(new Error(String(r?.result || 'claude /usage failed')));
      resolve(String(r.result ?? ''));
    });
  });
}
