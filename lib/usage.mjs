// lib/usage.mjs — plan quota as Claude Code reports it. Every `claude` call
// made with stream or verbose JSON output carries a rate_limit_event:
//
//   { status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt, rateLimitType,
//     overageStatus, overageDisabledReason, isUsingOverage,
//     unifiedWindows: { five_hour: { utilization: 0.23, resetsAt }, seven_day: {...} } }
//
// The deck sees one from each of its own model calls and from each turn of a
// session it launched. This keeps the latest, plus a short history per window
// so the UI can say how fast the window is filling.
import { EventEmitter } from 'node:events';

const HISTORY_MS = 6 * 3600_000;
const MIN_PACE_SPAN_MS = 10 * 60_000;   // shorter spans make the pace too jumpy to show

const secsToMs = (v) => (typeof v === 'number' && isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null);

export class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.latest = null;     // normalized rate_limit_info
    this.samples = [];      // { key, at, u, resetsAt }
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
      status: info.status || null,
      rateLimitType: info.rateLimitType || null,
      resetsAt: secsToMs(info.resetsAt),
      overageStatus: info.overageStatus || null,
      overageDisabledReason: info.overageDisabledReason || null,
      isUsingOverage: !!info.isUsingOverage,
      windows, at: now, source: source || null,
    };
    for (const w of windows) this.samples.push({ key: w.key, at: now, u: w.utilization, resetsAt: w.resetsAt });
    this.samples = this.samples.filter(x => now - x.at < HISTORY_MS).slice(-500);
    this.emit('usage', this.snapshot(now));
  }

  /**
   * How fast a window is filling: utilization per hour since the earliest
   * sample in the same window (same reset time), and where that pace lands.
   */
  pace(key, now = Date.now()) {
    const cur = this.latest?.windows.find(w => w.key === key);
    if (!cur) return null;
    const same = this.samples.filter(x => x.key === key && x.resetsAt === cur.resetsAt);
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
