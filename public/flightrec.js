// public/flightrec.js — the flight recorder: a session's whole life in one row.
//
// Every event becomes a chip, oldest on the left. Chips are all one thin
// width and stack up from the left as the session goes; only a chip's height
// says how long it took, and its colour is its family (classify.js). When
// the row is full they squeeze, so a long session reads as a dense barcode. Behind the chips runs the
// context window's fill, and on top sit the milestones: errors, compactions,
// commits and pushes, model switches, each prompt.
//
// buildFlight() and flightDigest() are pure (the tests import them);
// flightStrip() and createFlightPanel() draw.
import { classify } from './classify.js';
import { priceOf } from './pricing.js';
import { h, esc, svgUse, fmtMs, fmtTime, fmtTokens, oneLine } from './events.js';

// ------------------------------------------------------------ model
/** Filter groups for the details panel, in legend order. Families fold into them. */
export const GROUPS = [
  { k: 'you',   fam: 'you',   label: 'Prompts' },
  { k: 'said',  fam: 'said',  label: 'Said' },
  { k: 'muted', fam: 'muted', label: 'Thinking & notes' },
  { k: 'read',  fam: 'read',  label: 'Reading' },
  { k: 'edit',  fam: 'edit',  label: 'Edits' },
  { k: 'bash',  fam: 'bash',  label: 'Commands' },
  { k: 'git',   fam: 'git',   label: 'Git & GitHub' },
  { k: 'agent', fam: 'agent', label: 'Agents & plans' },
  { k: 'web',   fam: 'web',   label: 'Web & MCP' },
  { k: 'err',   fam: 'err',   label: 'API errors' },
];
const GROUP_OF = { shell: 'bash', stop: 'bash' };
export const groupOf = (fam) => GROUP_OF[fam] || (GROUPS.some(g => g.k === fam) ? fam : 'muted');

/** Milestone kinds, most alarming first. */
export const MARKS = {
  error:   { label: 'Error',             fam: 'err' },
  compact: { label: 'Context compacted', fam: 'info' },
  ctx:     { label: 'Context',           fam: 'turn' },
  git:     { label: 'Git',               fam: 'git' },
  model:   { label: 'Model switch',      fam: 'muted' },
  prompt:  { label: 'Prompt',            fam: 'you' },
};
const BADGE = { error: 'error', compact: 'compacted', ctx: 'context', git: 'git', model: 'model' };
const GIT_MILESTONES = new Set(['commit', 'push', 'pr', 'merge']);
const SKIP_KINDS = new Set(['turn_end', 'queue', 'request', 'raw']);
const COMPACT = new Set(['compact_boundary', 'compact_summary']);
const GAP_CAP = 120_000;          // the most model time a message or thought is credited with
const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
const THRESHOLDS = [0.5, 0.8];

// classify() splits shell commands; an event's family never changes, so it is kept.
const classCache = new WeakMap();
function classOf(ev) {
  let c = classCache.get(ev);
  if (!c) { const k = classify(ev); c = { fam: k.fam, label: k.label, text: k.text, intent: k.intent || null }; classCache.set(ev, c); }
  return c;
}
const isErr = (ev) => (ev.kind === 'tool' && (ev.tool.isError || ev.tool.meta?.interrupted)) || !!ev.error;
const tsOf = (ev) => { const t = ev.ts ? Date.parse(ev.ts) : NaN; return isFinite(t) ? t : null; };
/** Tokens in the window when this response was made: everything it was sent. */
export function contextUsed(u) {
  if (!u) return null;
  const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return n > 0 ? n : null;
}

/** Events and time per filter group, for any run of chips. */
export function countsOf(chips) {
  const counts = Object.fromEntries(GROUPS.map(g => [g.k, { n: 0, ms: 0 }]));
  for (const c of chips) { counts[c.group].n++; counts[c.group].ms += c.dur; }
  return counts;
}

/**
 * events: a session's normalized events, oldest first.
 * opts: { now, live, ctxSize (a harness's reported window), ctxUsed (its current fill), model }
 */
export function buildFlight(events = [], { now = Date.now(), live = false, ctxSize = null, ctxUsed = null, model = null } = {}) {
  const chips = [], marks = [], samples = [];
  const counts = Object.fromEntries(GROUPS.map(g => [g.k, { n: 0, ms: 0 }]));
  let lastModel = null;
  let prevT = null, lastCtx = null, peak = 0, errors = 0, compactions = 0, turns = 0, turn = null;
  let compactSince = false;         // an explicit compaction since the last context sample
  const turnList = [];
  const mark = (chip, kind, label) => { const m = { i: chip.i, id: chip.id, kind, label, ts: chip.ts }; marks.push(m); (chip.marks ||= []).push(kind); return m; };

  for (const ev of events) {
    const t = tsOf(ev);
    if (SKIP_KINDS.has(ev.kind) || (ev.kind === 'system' && ev.subtype === 'meta') || ev.hidden) { if (t != null) prevT = t; continue; }
    const c = classOf(ev);
    if (ev.model && ev.model !== '<synthetic>') lastModel = ev.model;
    let dur = 0;
    if (ev.kind === 'tool') dur = ev.tool.durationMs ?? (ev.tool.pending && t != null ? Math.max(0, now - t) : 0);
    else if ((ev.kind === 'text' || ev.kind === 'thinking') && t != null && prevT != null) dur = Math.min(GAP_CAP, Math.max(0, t - prevT));
    if (t != null) prevT = t;
    const err = isErr(ev);
    const chip = {
      i: chips.length, id: ev.id, seq: ev.seq, ts: ev.ts || null, t, kind: ev.kind,
      fam: err && ev.kind !== 'tool' ? 'err' : c.fam, group: groupOf(c.fam), label: c.label, text: oneLine(c.text || '', 240),
      tool: ev.kind === 'tool' ? ev.tool.name : null,
      dur, err, pending: ev.kind === 'tool' && !!ev.tool.pending, ctx: null, turn: null, marks: null,
    };
    chips.push(chip);
    counts[chip.group].n++; counts[chip.group].ms += dur;

    if (ev.kind === 'prompt') {
      turns++;
      turn = { n: turns, i: chip.i, ts: chip.ts, t, text: oneLine(ev.text || '', 200), events: 0, errors: 0, ms: 0, ctx: null, end: t };
      turnList.push(turn);
      mark(chip, 'prompt', `Turn ${turns}: ${oneLine(ev.text || '', 80)}`);
    } else if (turn) { turn.events++; turn.ms += dur; if (t != null) turn.end = Math.max(turn.end ?? t, t + (ev.kind === 'tool' ? dur : 0)); }
    chip.turn = turn?.n ?? null;

    if (err) { errors++; if (turn) turn.errors++; mark(chip, 'error', `${c.label} failed${chip.text ? ': ' + oneLine(chip.text, 100) : ''}`); }
    if (ev.kind === 'system' && COMPACT.has(ev.subtype)) {
      // Claude Code writes a boundary and then the summary; they are one compaction.
      const prev = marks.findLast(m => m.kind === 'compact');
      if (!(prev && chip.i - prev.i <= 3)) {
        compactions++; compactSince = true;
        mark(chip, 'compact', `Context compacted${ev.pre ? ` from ${fmtTokens(ev.pre)}` : ''}${ev.trigger ? ` (${ev.trigger})` : ''}`);
      }
    }
    if (GIT_MILESTONES.has(c.intent)) mark(chip, 'git', `${c.label}: ${oneLine(chip.text, 100)}`);
    if (ev.inference?.switchedFrom) mark(chip, 'model', `Model ${ev.inference.switchedFrom} → ${ev.model || ev.inference.model}`);

    const used = contextUsed(ev.usage);
    if (used != null) {
      // A big drop with no compaction logged is still one (or a /clear): show it.
      if (lastCtx != null && !compactSince && used < lastCtx * 0.65 && lastCtx - used > 20_000) {
        compactions++;
        mark(chip, 'compact', `Context dropped ${fmtTokens(lastCtx)} → ${fmtTokens(used)}`);
      }
      compactSince = false;
      samples.push({ i: chip.i, used });
      lastCtx = used; peak = Math.max(peak, used);
      if (turn) turn.ctx = used;
    }
    chip.ctx = lastCtx;
  }
  // A harness that reports its fill (ACP) gives one live point, at the end.
  if (ctxUsed != null && chips.length && (!samples.length || samples.at(-1).used !== ctxUsed)) {
    samples.push({ i: chips.length - 1, used: ctxUsed }); lastCtx = ctxUsed; peak = Math.max(peak, ctxUsed); chips.at(-1).ctx = ctxUsed;
  }
  // The window: what the harness reports, else the model's (pricing.js), else a guess from use.
  const window = ctxSize || (/\[1m\]/i.test(String(model || '')) ? LARGE_WINDOW : null)
    || priceOf(lastModel)?.context || priceOf(String(model || '').split(' ')[0])?.context
    || (peak > SMALL_WINDOW ? LARGE_WINDOW : SMALL_WINDOW);
  // Crossing a threshold is a milestone; ordering stays by chip.
  const crossed = new Set();
  for (const s of samples) for (const th of THRESHOLDS) {
    if (!crossed.has(th) && s.used >= th * window) { crossed.add(th); mark(chips[s.i], 'ctx', `Context passed ${Math.round(th * 100)}% (${fmtTokens(s.used)} of ${fmtTokens(window)})`); }
  }
  marks.sort((a, b) => a.i - b.i);

  const start = chips.find(c => c.t != null)?.t ?? null;
  const lastT = chips.findLast(c => c.t != null);
  // A tool's time runs after its timestamp; a message's ran before it (see dur above).
  const end = lastT ? lastT.t + (lastT.kind === 'tool' && !lastT.pending ? lastT.dur : 0) : null;
  return {
    chips, marks, samples, turns: turnList, counts,
    window, ctxNow: lastCtx, peak, errors, compactions,
    start, end, now, live,
    age: start != null ? (live ? now : Math.max(end ?? start, start)) - start : null,
    active: chips.reduce((s, c) => s + c.dur, 0),
    offset: 0,
  };
}

/**
 * The chips from..to (inclusive) as a flight of their own, for a zoomed view.
 * Indexes are re-based; `offset` keeps where it sits in the whole session.
 * The context line starts at the level it had coming in.
 */
export function sliceFlight(f, from, to) {
  const a = Math.max(0, Math.min(from, to)), b = Math.min(f.chips.length - 1, Math.max(from, to));
  const chips = f.chips.slice(a, b + 1).map(c => ({ ...c, i: c.i - a }));
  const marks = f.marks.filter(m => m.i >= a && m.i <= b).map(m => ({ ...m, i: m.i - a }));
  const samples = f.samples.filter(x => x.i >= a && x.i <= b).map(x => ({ ...x, i: x.i - a }));
  if (chips.length && chips[0].ctx != null && samples[0]?.i !== 0) samples.unshift({ i: 0, used: chips[0].ctx });
  const ts = chips.filter(c => c.t != null);
  const last = ts.at(-1);
  return {
    ...f, chips, marks, samples,
    start: ts[0]?.t ?? null,
    end: last ? last.t + (last.kind === 'tool' && !last.pending ? last.dur : 0) : null,
    live: f.live && b === f.chips.length - 1,
    active: chips.reduce((s, c) => s + c.dur, 0),
    errors: chips.filter(c => c.err).length,
    offset: (f.offset || 0) + a,
  };
}

/**
 * Every chip gets the same slot: at most `maxSlot` pixels, so a young session
 * is a short stack on the left; squeezed to fit once the row is full.
 * Returns { slot, x(i) (slot start), end (right edge of the last slot) }.
 */
export function layoutFlight(f, width, maxSlot = Infinity) {
  const n = f.chips.length;
  const slot = n && width > 0 ? Math.min(maxSlot, width / n) : 0;
  return { slot, x: (i) => i * slot, end: n * slot };
}

/**
 * A chip's height, minH..maxH, from its duration on a log scale. `longest`
 * (ms) is the duration that reaches full height: fixed for the strip, the
 * longest in view for the details chart, so a zoom shows more variety.
 */
export function chipHeight(ms, { minH, maxH, longest }) {
  const k = Math.log2(1 + Math.max(0, ms || 0) / 1000) / Math.log2(1 + Math.max(1000, longest) / 1000);
  return minH + (maxH - minH) * Math.min(1, k);
}

/** "2h 14m", "6m", "40s", "3d 2h". */
export function fmtAge(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60); if (hr < 24) return m % 60 ? `${hr}h ${m % 60}m` : `${hr}h`;
  const d = Math.floor(hr / 24); return hr % 24 ? `${d}d ${hr % 24}h` : `${d}d`;
}
const pct = (f, used) => used == null ? null : Math.round((used / f.window) * 100);

/** The flight as text, for Ask about this: the shape first, then milestones, turns, the latest events. */
export function flightDigest(f, { recent = 120 } = {}) {
  const t = (ts) => ts ? new Date(ts).toISOString().slice(11, 19) : '--:--:--';
  const lines = [
    `Flight recorder for one coding-agent session. ${f.chips.length} events over ${fmtAge(f.age) || 'no time'}${f.live ? ' (still running)' : ''}, ${f.turns.length} turns, ${fmtMs(f.active) || '0s'} of tool and model time.`,
    `Errors: ${f.errors}. Compactions: ${f.compactions}. Context now ${f.ctxNow != null ? `${fmtTokens(f.ctxNow)} (${pct(f, f.ctxNow)}%)` : 'unknown'}, peak ${fmtTokens(f.peak) || '?'} of a ${fmtTokens(f.window)} window.`,
    `Time by kind: ${GROUPS.filter(g => f.counts[g.k].n).map(g => `${g.label} ${f.counts[g.k].n} events / ${fmtMs(f.counts[g.k].ms) || '0s'}`).join('; ')}.`,
    '', 'Milestones (UTC time, event #, what):',
    ...f.marks.filter(m => m.kind !== 'prompt').slice(-200).map(m => `${t(m.ts)} #${m.i + 1} [${m.kind}] ${m.label}`),
    '', 'Turns:',
    ...f.turns.slice(-60).map(x => `Turn ${x.n} ${t(x.ts)}: "${oneLine(x.text, 140)}" · ${x.events} events · ${fmtMs(x.ms) || '0s'}${x.errors ? ` · ${x.errors} errors` : ''}${x.ctx != null ? ` · ctx ${pct(f, x.ctx)}%` : ''}`),
    '', `Latest ${Math.min(recent, f.chips.length)} events:`,
    ...f.chips.slice(-recent).map(c => `${t(c.ts)} #${c.i + 1} ${c.label}${c.err ? ' [failed]' : ''}${c.dur >= 1000 ? ` (${fmtMs(c.dur)})` : ''}: ${oneLine(c.text, 140)}`),
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------ drawing
const NS = 'http://www.w3.org/2000/svg';
/**
 * The chart as one SVG: context fill behind, chips, milestones on top.
 * opts: { width, height, cursor (event id), chipH (max chip height), dense (draw prompts) }
 */
export function flightSvg(f, { width, height, cursor = null, maxSlot = Infinity, minH = 3, maxH = null, longest = null, axis = false } = {}) {
  const W = Math.max(1, Math.floor(width)), H = height;
  const L = layoutFlight(f, W, maxSlot);
  const cx = (i) => L.x(i) + L.slot / 2;
  const pad = 3, mid = H / 2;
  const top = maxH ?? Math.round(H * 0.6);
  const span = longest ?? Math.max(10_000, ...f.chips.map(c => c.dur));
  const yOf = (used) => H - pad - Math.min(1, used / f.window) * (H - 2 * pad);
  const parts = [];
  // Guides at the thresholds.
  for (const th of THRESHOLDS) parts.push(`<line class="fr-guide" x1="0" x2="${W}" y1="${yOf(th * f.window).toFixed(1)}" y2="${yOf(th * f.window).toFixed(1)}"/>`);
  // Context: a line through each sample, carried on to the newest chip.
  if (f.samples.length && L.slot) {
    const pts = f.samples.map(x => [cx(x.i), yOf(x.used)]);
    pts.unshift([0, pts[0][1]]);
    pts.push([L.end, pts.at(-1)[1]]);
    const line = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
    parts.push(`<path class="fr-area" d="${line}L${L.end.toFixed(1)} ${H}L0 ${H}Z"/>`, `<path class="fr-line" d="${line}"/>`);
  }
  // Chips: one thin width, centred in their slots; height is duration.
  // Always thin: 2-3px with a gap, thinner only when the row is packed.
  const w = Math.max(0.6, L.slot >= 4 ? 3 : L.slot >= 2 ? L.slot - 1 : L.slot);
  for (let i = 0; i < f.chips.length; i++) {
    const c = f.chips[i];
    const ch = chipHeight(c.dur, { minH, maxH: top, longest: span });
    const tip = `${c.label}${c.err ? ' · failed' : ''}${c.dur >= 1000 || c.pending ? ' · ' + fmtMs(c.dur) : ''}${c.ts ? ' · ' + fmtTime(c.ts) : ''}${c.text ? '\n' + oneLine(c.text, 120) : ''}${c.ctx != null ? `\ncontext ${pct(f, c.ctx)}%` : ''}`;
    parts.push(`<rect class="fr-c f-${c.fam}${c.err ? ' bad' : ''}${c.pending ? ' run' : ''}${c.id === cursor ? ' cur' : ''}" data-id="${esc(c.id)}" x="${(cx(i) - w / 2).toFixed(2)}" y="${(mid - ch / 2).toFixed(1)}" width="${w.toFixed(2)}" height="${ch.toFixed(1)}" rx="${Math.min(1.5, w / 2).toFixed(2)}"><title>${esc(tip)}</title></rect>`);
  }
  // Milestones.
  for (const m of f.marks) {
    const x = cx(m.i).toFixed(1);
    const tip = `<title>${esc(`${fmtTime(m.ts)} · ${m.label}`)}</title>`;
    if (m.kind === 'error') parts.push(`<g class="fr-m m-error" data-id="${esc(m.id)}"><line x1="${x}" x2="${x}" y1="3" y2="${H}"/><circle cx="${x}" cy="3.5" r="2.5"/>${tip}</g>`);
    else if (m.kind === 'compact') parts.push(`<g class="fr-m m-compact" data-id="${esc(m.id)}"><line x1="${x}" x2="${x}" y1="0" y2="${H}"/><path d="M${+x - 4} 0h8l-4 5z"/>${tip}</g>`);
    else if (m.kind === 'git') parts.push(`<g class="fr-m m-git" data-id="${esc(m.id)}"><path d="M${x} 1l3.2 3.2L${x} 7.4l-3.2-3.2z"/>${tip}</g>`);
    else if (m.kind === 'model') parts.push(`<g class="fr-m m-model" data-id="${esc(m.id)}"><line x1="${x}" x2="${x}" y1="0" y2="6"/>${tip}</g>`);
    else if (m.kind === 'prompt') parts.push(`<g class="fr-m m-prompt" data-id="${esc(m.id)}"><line x1="${x}" x2="${x}" y1="${H - 5}" y2="${H}"/>${tip}</g>`);
  }
  if (cursor) { const i = f.chips.findIndex(c => c.id === cursor); if (i >= 0) { const x = cx(i).toFixed(1); parts.push(`<line class="fr-cursor" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`); } }
  if (axis) {
    parts.push(`<text class="fr-ax" x="${W - 2}" y="${(yOf(0.8 * f.window) - 2).toFixed(1)}" text-anchor="end">80%</text>`, `<text class="fr-ax" x="${W - 2}" y="${(yOf(0.5 * f.window) - 2).toFixed(1)}" text-anchor="end">50%</text>`);
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'fr-svg'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', flightSummary(f));
  svg.innerHTML = parts.join('');
  return svg;
}

/** One sentence for screen readers and tooltips. */
export function flightSummary(f) {
  if (!f.chips.length) return 'Flight recorder: no events yet';
  return [`${fmtAge(f.age)} old`, `${f.turns.length} turn${f.turns.length === 1 ? '' : 's'}`, `${f.chips.length} events`,
    f.errors ? `${f.errors} error${f.errors === 1 ? '' : 's'}` : null, f.compactions ? `${f.compactions} compaction${f.compactions === 1 ? '' : 's'}` : null,
    f.ctxNow != null ? `context ${pct(f, f.ctxNow)}%` : null].filter(Boolean).join(' · ');
}

/** The row above the event list: chart, then age and context at a glance, then Ask. */
export function flightStrip(el, f, { cursor = null } = {}) {
  if (!f?.chips.length) { el.hidden = true; el.replaceChildren(); return; }
  el.hidden = false;
  let chart = el.querySelector('.fr-chart');
  if (!chart) {
    chart = h('button', { type: 'button', class: 'fr-chart', title: 'Flight recorder: open it in the details pane' });
    // Ask about the flight lives in its details panel; the toolbar's Ask is about the events.
    el.replaceChildren(chart, h('span', { class: 'fr-sum' }));
  }
  const width = chart.clientWidth || el.clientWidth - 110;
  chart.replaceChildren(flightSvg(f, { width, height: 30, cursor, maxSlot: 3, minH: 3, maxH: 18, longest: 600_000 }));
  chart.setAttribute('aria-label', `Flight recorder: ${flightSummary(f)}. Open details`);
  const ctxP = pct(f, f.ctxNow);
  const tone = ctxP == null ? '' : ctxP >= 80 ? ' crit' : ctxP >= 50 ? ' warn' : '';
  el.querySelector('.fr-sum').replaceChildren(...[
    h('b', { title: f.start ? `Started ${new Date(f.start).toLocaleString()}` : null }, fmtAge(f.age)),
    f.errors ? h('span', { class: 'fr-err', title: `${f.errors} error${f.errors === 1 ? '' : 's'}` }, svgUse('i-alert', 11), String(f.errors)) : null,
    f.compactions ? h('span', { class: 'fr-cmp', title: `${f.compactions} compaction${f.compactions === 1 ? '' : 's'}` }, svgUse('i-compact', 11), String(f.compactions)) : null,
    ctxP != null ? h('span', { class: `fr-ctx${tone}`, title: `Context: ${fmtTokens(f.ctxNow)} of ${fmtTokens(f.window)} (peak ${fmtTokens(f.peak)})` }, `${ctxP}%`) : null,
  ].filter(Boolean));  // replaceChildren() would print a null as "null"
}

// ------------------------------------------------------------ details panel
/**
 * The flight recorder in the details pane: totals, a taller chart, a legend
 * that filters, search, and every event as a row. Dragging across the chart
 * zooms to those events (chart, breakdown and list all follow); double-click
 * or Zoom out steps back. The controls are built once and kept, so live
 * updates never take focus from the search box.
 *   cb: { onSelect(id), onOpen(id), onAsk() }
 */
export function createFlightPanel(cb) {
  const st = { groups: new Set(), marksOnly: false, errorsOnly: false, q: '', limit: 300, f: null, cursor: null, sig: '', zooms: [] };
  const tag = h('span', { class: 'tic f-info lab' }, svgUse('i-flight', 15), h('span', {}, 'Flight recorder'));
  const meta = h('div', { class: 'dmeta' });
  const askB = h('button', { type: 'button', class: 'ask-ico', 'aria-label': 'Ask about this session\'s flight', title: 'Ask about this session\'s flight', onclick: () => cb.onAsk() }, svgUse('i-star', 12));
  const head = h('div', { class: 'dhead' }, h('div', { class: 'dh-row' }, tag, h('span', { class: 'spacer' }), askB), meta);
  const stats = h('div', { class: 'fr-stats' });
  const chart = h('div', { class: 'fr-big', title: 'Drag to zoom in · double-click to zoom out' });
  const brush = h('div', { class: 'fr-brush', hidden: true });
  const zoomBar = h('div', { class: 'fr-zoom', hidden: true });
  const axis = h('div', { class: 'fr-axis' });
  const comp = h('div', { class: 'fr-comp', role: 'img' });
  const legend = h('div', { class: 'fr-legend', role: 'group', 'aria-label': 'Show kinds' });
  const marksB = h('button', { type: 'button', class: 'fr-tg', 'aria-pressed': 'false', title: 'Only milestones: errors, compactions, git, prompts' }, svgUse('i-flag', 12), 'Milestones');
  const errB = h('button', { type: 'button', class: 'fr-tg err', 'aria-pressed': 'false', title: 'Only failed events' }, svgUse('i-alert', 12), 'Errors');
  const q = h('input', { type: 'search', placeholder: 'Search events', spellcheck: 'false', autocomplete: 'off' });
  const search = h('label', { class: 'search grow' }, svgUse('i-search', 13), h('span', { class: 'sr' }, 'Search the flight'), q);
  const count = h('span', { class: 'fr-n muted' });
  const list = h('div', { class: 'fr-list', role: 'list' });
  const more = h('button', { type: 'button', class: 'linkish fr-more', hidden: true }, '');
  const body = h('div', { class: 'dbody' },
    stats,
    h('section', { class: 'dsec' }, h('div', { class: 'dsec-h' }, h('span', { class: 'dsec-t' }, 'Timeline'), h('span', { class: 'dsec-sp' }), h('span', { class: 'note' }, 'height is duration · line is context · drag to zoom')), zoomBar, chart, axis),
    h('section', { class: 'dsec' }, h('div', { class: 'dsec-h' }, h('span', { class: 'dsec-t' }, 'Where the time went')), comp, legend),
    h('section', { class: 'dsec' }, h('div', { class: 'fr-tools' }, search, marksB, errB, count), list, more));
  const el = h('div', { class: 'details fr-panel' }, head, body);

  const refresh = () => { st.sig = ''; draw(); };
  marksB.onclick = () => { st.marksOnly = !st.marksOnly; marksB.setAttribute('aria-pressed', String(st.marksOnly)); refresh(); };
  errB.onclick = () => { st.errorsOnly = !st.errorsOnly; errB.setAttribute('aria-pressed', String(st.errorsOnly)); refresh(); };
  q.oninput = () => { st.q = q.value.trim().toLowerCase(); st.limit = 300; refresh(); };
  more.onclick = () => { st.limit += 1000; refresh(); };
  legend.onclick = (e) => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    const k = b.dataset.g;
    // From "all", a pick shows just that kind; after that each pick adds or removes one.
    if (!st.groups.size) st.groups.add(k); else if (st.groups.has(k)) st.groups.delete(k); else st.groups.add(k);
    if (st.groups.size === GROUPS.length) st.groups.clear();
    refresh();
  };
  // The chart: a click picks a chip; a drag zooms to the chips under it.
  let drag = null;
  chart.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const r = chart.getBoundingClientRect();
    drag = { x0: e.clientX - r.left, x1: e.clientX - r.left, id: e.target.closest('[data-id]')?.dataset.id || null, w: r.width };
    chart.setPointerCapture(e.pointerId);
  };
  chart.onpointermove = (e) => {
    if (!drag) return;
    drag.x1 = Math.max(0, Math.min(drag.w, e.clientX - chart.getBoundingClientRect().left));
    const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
    brush.hidden = b - a < 4;
    brush.style.left = `${a}px`; brush.style.width = `${b - a}px`;
  };
  chart.onpointerup = () => {
    const d = drag; drag = null; brush.hidden = true;
    if (!d) return;
    const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
    if (b - a < 4) { if (d.id) { cb.onSelect(d.id); focus(d.id); } return; }
    const v = view(); const n = v.chips.length; if (n < 2) return;
    const slot = d.w / n;
    const i0 = Math.max(0, Math.floor(a / slot)), i1 = Math.min(n - 1, Math.floor((b - 1) / slot));
    if (i1 <= i0 || (i0 === 0 && i1 === n - 1)) return;
    st.zooms.push({ from: v.offset + i0, to: v.offset + i1 });
    st.limit = 300; refresh();
  };
  chart.onpointercancel = () => { drag = null; brush.hidden = true; };
  chart.ondblclick = () => { if (st.zooms.length) { st.zooms.pop(); refresh(); } };
  zoomBar.onclick = (e) => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    if (b.dataset.z === 'out') st.zooms.pop(); else st.zooms = [];
    refresh();
  };
  /** What the panel shows: the whole flight, or the zoomed slice of it. */
  const view = () => { const z = st.zooms.at(-1); return z && st.f ? sliceFlight(st.f, z.from, Math.min(z.to, st.f.chips.length - 1)) : st.f; };
  list.onclick = (e) => {
    const r = e.target.closest('.fr-row'); if (!r) return;
    if (e.target.closest('.fr-open')) { cb.onOpen(r.dataset.id); return; }
    cb.onSelect(r.dataset.id);
  };
  list.ondblclick = (e) => { const r = e.target.closest('.fr-row'); if (r) cb.onOpen(r.dataset.id); };

  const matches = (c) => {
    if (st.groups.size && !st.groups.has(c.group) && !(c.err && st.groups.has('err'))) return false;
    if (st.errorsOnly && !c.err) return false;
    if (st.marksOnly && !c.marks) return false;
    if (st.q && !`${c.label} ${c.tool || ''} ${c.text} ${c.marks?.join(' ') || ''}`.toLowerCase().includes(st.q)) return false;
    return true;
  };
  function stat(k, v, cls = '') { return h('div', { class: `fr-stat${cls ? ' ' + cls : ''}` }, h('span', { class: 'fr-k' }, k), h('span', { class: 'fr-v' }, v)); }
  function draw() {
    const f = st.f; if (!f) return;
    const sig = `${f.chips.length}|${f.chips.at(-1)?.dur}|${f.chips.at(-1)?.pending}|${f.marks.length}|${f.ctxNow}|${st.cursor}|${chart.clientWidth}|${JSON.stringify(st.zooms.at(-1) || null)}`;
    if (sig === st.sig) return;
    st.sig = sig;
    meta.replaceChildren(...[f.start ? `Started ${new Date(f.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : null, f.live ? 'running' : f.end ? `last event ${fmtTime(new Date(f.end).toISOString())}` : null]
      .filter(Boolean).map(x => h('span', {}, x)));
    const ctxP = pct(f, f.ctxNow);
    stats.replaceChildren(
      stat('Age', fmtAge(f.age) || '—'),
      stat('Busy', fmtMs(f.active) || '—'),
      stat('Turns', String(f.turns.length)),
      stat('Events', String(f.chips.length)),
      stat('Errors', String(f.errors), f.errors ? 'err' : ''),
      stat('Compactions', String(f.compactions), f.compactions ? 'info' : ''),
      stat('Context', ctxP != null ? `${ctxP}% · ${fmtTokens(f.ctxNow)}` : '—', ctxP >= 80 ? 'err' : ctxP >= 50 ? 'warn' : ''),
      stat(`Peak of ${fmtTokens(f.window)}`, f.peak ? fmtTokens(f.peak) : '—'));
    const v = view();
    const z = st.zooms.at(-1);
    zoomBar.hidden = !z;
    if (z) zoomBar.replaceChildren(...[svgUse('i-search', 12),
      h('span', {}, `Events ${v.offset + 1}–${v.offset + v.chips.length} of ${f.chips.length}`),
      h('span', { class: 'muted' }, [v.start && v.end ? `${fmtAge(v.end - v.start)}` : null, v.active ? `${fmtMs(v.active)} busy` : null, v.errors ? `${v.errors} error${v.errors === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'spacer' }),
      st.zooms.length > 1 ? h('button', { type: 'button', class: 'linkish', dataset: { z: 'out' } }, 'Zoom out') : null,
      h('button', { type: 'button', class: 'linkish', dataset: { z: 'all' } }, 'Show all')].filter(Boolean));
    // Heights scale to the longest event in view, so the details (and a zoom) show more variety than the strip.
    chart.replaceChildren(flightSvg(v, { width: chart.clientWidth || 320, height: 110, cursor: st.cursor, minH: 2, maxH: 96, axis: true }), brush);
    axis.replaceChildren(h('span', {}, v.start ? fmtTime(new Date(v.start).toISOString()) : ''), h('span', {}, v.live ? 'now' : v.end ? fmtTime(new Date(v.end).toISOString()) : ''));
    // Composition: time share per kind (count share when nothing took time), for what is in view.
    const counts = z ? countsOf(v.chips) : f.counts;
    const total = GROUPS.reduce((s, g) => s + counts[g.k].ms, 0);
    const share = (g) => total ? counts[g.k].ms / total : counts[g.k].n / Math.max(1, v.chips.length);
    comp.replaceChildren(...GROUPS.filter(g => share(g) > 0).map(g => h('span', { class: `fr-seg f-${g.fam}`, style: `flex-grow:${share(g).toFixed(4)}`, title: `${g.label}: ${fmtMs(counts[g.k].ms) || '0s'} · ${counts[g.k].n} events` })));
    comp.setAttribute('aria-label', `Time by kind: ${GROUPS.filter(g => counts[g.k].n).map(g => `${g.label} ${Math.round(share(g) * 100)}%`).join(', ')}`);
    legend.replaceChildren(...GROUPS.filter(g => counts[g.k].n || st.groups.has(g.k)).map(g => h('button', {
      type: 'button', class: 'fr-lg', dataset: { g: g.k }, 'aria-pressed': String(st.groups.has(g.k)), title: `${g.label}: ${counts[g.k].n} events, ${fmtMs(counts[g.k].ms) || '0s'}`,
    }, h('span', { class: `fr-dot f-${g.fam}` }), g.label, h('span', { class: 'fr-lgn' }, String(counts[g.k].n)))));
    legend.classList.toggle('some', st.groups.size > 0);
    // Rows, newest first.
    const hits = [];
    for (let i = v.chips.length - 1; i >= 0; i--) if (matches(v.chips[i])) hits.push(v.chips[i]);
    count.textContent = hits.length === v.chips.length ? `${hits.length}` : `${hits.length} of ${v.chips.length}`;
    const shown = hits.slice(0, st.limit);
    list.replaceChildren(...shown.map(c => row(f, c)));
    if (!shown.length) list.append(h('div', { class: 'pad muted' }, 'Nothing matches.'));
    more.hidden = hits.length <= shown.length;
    more.textContent = `Show ${Math.min(1000, hits.length - shown.length)} more`;
  }
  function row(f, c) {
    const kinds = c.marks?.filter(k => k !== 'prompt') || [];
    return h('div', { class: `fr-row${c.err ? ' error' : ''}${c.id === st.cursor ? ' selected' : ''}${kinds.length ? ' mile' : ''}`, role: 'listitem', dataset: { id: c.id }, tabindex: '-1' },
      h('span', { class: 'fr-t' }, c.ts ? fmtTime(c.ts) : ''),
      h('span', { class: `fr-dot f-${c.fam}`, title: c.label }),
      h('span', { class: 'fr-lb' }, c.label),
      h('span', { class: 'fr-tx' }, c.text),
      ...kinds.map(k => h('span', { class: `fr-badge m-${k}` }, BADGE[k])),
      h('span', { class: 'fr-d' }, c.pending ? 'running' : c.dur >= 1000 ? fmtMs(c.dur) : ''),
      h('span', { class: 'fr-cx', title: 'Context at this point' }, c.ctx != null ? `${pct(f, c.ctx)}%` : ''),
      h('button', { type: 'button', class: 'icon-btn sm ghost fr-open', 'aria-label': 'Open this event', title: 'Open this event (double-click)' }, svgUse('i-right', 11)));
  }
  function focus(id) {
    const at = st.f ? st.f.chips.findIndex(c => c.id === id) : -1;
    const z = st.zooms.at(-1);
    if (z && at >= 0 && (at < z.from || at > z.to)) st.zooms = [];
    st.cursor = id; st.sig = ''; draw();
    let r = list.querySelector(`.fr-row[data-id="${CSS.escape(id)}"]`);
    if (!r && (st.groups.size || st.marksOnly || st.errorsOnly || st.q)) {
      // Filtered out: clear the filters so the pick is visible.
      st.groups.clear(); st.marksOnly = st.errorsOnly = false; st.q = ''; q.value = '';
      marksB.setAttribute('aria-pressed', 'false'); errB.setAttribute('aria-pressed', 'false');
      st.sig = ''; draw(); r = list.querySelector(`.fr-row[data-id="${CSS.escape(id)}"]`);
    }
    if (!r && st.f) { const v = view(); const i = v.chips.length - 1 - v.chips.findIndex(c => c.id === id); if (i >= st.limit) { st.limit = i + 50; st.sig = ''; draw(); r = list.querySelector(`.fr-row[data-id="${CSS.escape(id)}"]`); } }
    r?.scrollIntoView({ block: 'nearest' });
  }
  return {
    el,
    update(f, { cursor = st.cursor } = {}) { st.f = f; st.cursor = cursor; draw(); },
    focus,
    reset() { st.zooms = []; st.groups.clear(); st.marksOnly = st.errorsOnly = false; st.q = ''; q.value = ''; st.limit = 300; st.sig = ''; marksB.setAttribute('aria-pressed', 'false'); errB.setAttribute('aria-pressed', 'false'); },
    redraw() { st.sig = ''; draw(); },
  };
}
