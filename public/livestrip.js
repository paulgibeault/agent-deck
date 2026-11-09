// public/livestrip.js — the line above the Events list while a deck-launched
// Claude session is mid-message (lib/live.mjs): the reply as it is written,
// the tool call being filled in, the thinking-token count, or what the CLI is
// waiting on. It goes away when the message ends; the transcript's events
// take over from there. Sessions run in a terminal never show it.
import { h, esc, fmtTokens } from './events.js';

const STATUS = {
  requesting: { icon: 'i-api', label: 'Waiting for the model' },
  compacting: { icon: 'i-collapse', label: 'Compacting the conversation' },
};
const BLOCK = {
  text: { icon: 'i-said', label: 'Writing' },
  thinking: { icon: 'i-think', label: 'Thinking' },
  redacted_thinking: { icon: 'i-think', label: 'Thinking' },
  tool_use: { icon: 'i-code', label: 'Calling' },
  server_tool_use: { icon: 'i-code', label: 'Calling' },
};

const glyph = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '14'); s.setAttribute('height', '14'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<use href="#${esc(id)}"/>`;
  return s;
};

/** What one live view shows: { icon, label, body, mono, count } or null. */
export function liveLine(v) {
  if (!v || v.gone) return null;
  const b = (v.blocks || []).at(-1);
  if (b) {
    const at = { key: `${v.blocks.length - 1}:${b.type}:${b.name || ''}`, chars: b.chars ?? String(b.text || '').length };
    const k = BLOCK[b.type] || { icon: 'i-code', label: b.type };
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const n = v.thinking ?? b.tokens;
      return { ...at, icon: k.icon, label: k.label, body: b.text || '', mono: false, count: n ? `~${fmtTokens(n)} tokens` : null, thinking: true };
    }
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return { ...at, icon: k.icon, label: `${k.label} ${b.name || 'a tool'}`, body: b.text || '', mono: true, head: b.name || null };
    return { ...at, icon: k.icon, label: k.label, body: b.text || '', mono: false };
  }
  const s = STATUS[v.status];
  return s ? { icon: s.icon, label: s.label, body: '', mono: false } : null;
}

// Thinking usually sends no text, only token estimates. In a 6-minute think
// they were never more than 1.8s apart, so 10s without one is out of the ordinary.
export const STALL_MS = 10_000;
const span = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

/** One update for session `id`: starts its clock on a new thinking block, marks it heard from, or drops it. */
export function noteThinking(clocks, id, line, now) {
  if (!line?.thinking) { clocks.delete(id); return; }
  const c = clocks.get(id);
  if (c?.key === line.key) c.last = now; else clocks.set(id, { key: line.key, since: now, last: now });
}

/** What the count shows: tokens, time thinking, and a hint once updates have stopped. */
export function thinkingMeter(line, c, now) {
  const stalled = now - c.last >= STALL_MS;
  const text = [line.count, now - c.since >= 1000 ? span(now - c.since) : null, stalled ? `no updates for ${span(now - c.last)}` : null].filter(Boolean).join(' · ');
  return { text, stalled };
}

/** The end of what is being written: the line shows its newest words. */
export function tail(text, n = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/** What a row reads as: a tool's JSON escapes become plain text, whitespace runs one space. */
export function clean(text, mono = false) {
  let t = String(text || '');
  if (mono) t = t.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * The strip shows a block one full row at a time: the row on screen stays
 * still until the model has written past its end, then the next complete
 * row replaces it whole. Nothing slides; the pace is the model's.
 *
 * st: { key, start, shown } kept between calls (start: where the row being
 * written begins, in the block's characters; shown: the last complete row).
 * line: liveLine()'s { key, chars, body } (body is the block's tail, '…'-led
 * when cut). fit(s): how many leading characters of s fill one row.
 * Returns { text, fresh } (fresh: a new row, so it pulses), or null when the
 * line has no text.
 */
export function nextRow(st, line, fit) {
  if (line.chars == null || !line.body) return null;
  const cut = line.body.startsWith('…') && line.chars > line.body.length - 1;
  const avail = cut ? line.body.slice(1) : line.body;
  const from = line.chars - avail.length;     // where `avail` starts in the block
  if (st.key !== line.key || line.chars < st.start) Object.assign(st, { key: line.key, start: from, shown: null });
  if (st.start < from) st.start = from;       // fell behind the tail: carry on from what there is
  let pos = st.start, last = null;
  for (;;) {
    const rest = avail.slice(pos - from);
    let n = fit(rest);
    if (n >= rest.length) break;              // the row being written isn't full yet
    // End the row on a word when one is near.
    const ws = rest.slice(0, n + 1).search(/\s\S*$/);
    if (ws > n * 0.6) n = ws;
    last = rest.slice(0, n);
    pos += n;
    while (pos < line.chars && /\s/.test(avail[pos - from])) pos++;
    if (n <= 0) break;
  }
  if (last != null) { st.start = pos; st.shown = last; return { text: last, fresh: true }; }
  // Nothing new is complete: keep the row on screen, or, before the first one fills, let it fill in place.
  if (st.shown != null) return { text: st.shown, fresh: false };
  return { text: avail.slice(st.start - from), fresh: false };
}

/**
 * Paces the rows: each one stays at least `hold` ms, then fades out (`out`
 * ms), the newest waiting row is set, and it fades in. Rows that complete
 * while one is showing replace each other in the wait, so the strip never
 * falls behind and never flickers. A row still filling in (fresh: false)
 * is written in place when nothing is waiting.
 *   io: { set(text), fadeOut(), fadeIn(), now(), later(fn, ms) → cancel }
 */
export function createPacer(io, { hold = 1000, out = 180 } = {}) {
  let shown = null, pending = null, fading = false, last = -Infinity, cancel = null;
  function swap() {
    cancel = null; fading = true; io.fadeOut();
    cancel = io.later(() => {
      cancel = null; fading = false;
      shown = pending; pending = null; last = io.now();
      io.set(shown); io.fadeIn();
    }, out);
  }
  function schedule(now = false) {
    if (cancel || fading) return;
    cancel = io.later(swap, now ? 0 : Math.max(0, last + hold - io.now()));
  }
  return {
    /** A row to show. `fresh`: a completed row (or a new block); `now`: skip the hold. */
    show(text, { fresh = false, now = false } = {}) {
      if (text === (pending ?? shown)) return;
      if (!fresh && pending == null && !fading && !cancel) { shown = text; io.set(text); return; }
      pending = text;
      if (now && cancel && !fading) { cancel(); cancel = null; }
      schedule(now);
    },
    reset() { cancel?.(); cancel = null; shown = pending = null; fading = false; last = -Infinity; },
    get shown() { return shown; },
  };
}

/** el: the strip's element; selected(): the session the Events list shows. */
export function createLiveStrip(el, selected) {
  const views = new Map();   // session id -> latest live view
  const clocks = new Map();  // session id -> the thinking block's { key, since, last } (noteThinking)
  let ticking = null;        // the once-a-second redraw, while thinking shows
  const row = { key: null, start: 0, shown: null };
  let ctx = null;
  /** How many leading characters of s fit the body's width, measured in its font. */
  function fitter(body, mono) {
    const width = body.clientWidth - 4;
    if (width <= 0) return (s) => s.length;
    ctx ||= document.createElement('canvas').getContext('2d');
    ctx.font = getComputedStyle(body).font;
    const w = (s) => ctx.measureText(clean(s, mono)).width;
    return (s) => {
      if (w(s) <= width) return s.length;
      let lo = 0, hi = Math.min(s.length, 2000);
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (w(s.slice(0, mid)) <= width) lo = mid; else hi = mid - 1; }
      return lo;
    };
  }
  // The line's parts are made once and kept: an update changes their text,
  // so a fade in progress is never cut short by the next update.
  const ico = h('span', { class: 'lv-ico', role: 'img' });
  const head = h('span', { class: 'lv-head' });
  const body = h('span', { class: 'lv-body' });
  const count = h('span', { class: 'lv-count' });
  let built = false, icon = null, mono = false;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pacer = createPacer({
    set: (t) => { body.textContent = clean(t, mono); },
    fadeOut: () => body.classList.add('lv-out'),
    fadeIn: () => body.classList.remove('lv-out'),
    now: () => performance.now(),
    later: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  }, { out: 180 });
  function drawCount(line, id) {
    const c = line.thinking && clocks.get(id);
    const m = c ? thinkingMeter(line, c, performance.now()) : { text: line.count || '', stalled: false };
    count.textContent = m.text; count.hidden = !m.text;
    count.classList.toggle('lv-stalled', m.stalled);
  }
  function tick(on) {
    if (on && !ticking) ticking = setInterval(() => {
      const id = selected(), line = liveLine(views.get(id));
      if (line) drawCount(line, id);
    }, 1000);
    else if (!on && ticking) { clearInterval(ticking); ticking = null; }
  }
  function render() {
    const id = selected();
    const line = liveLine(views.get(id));
    el.hidden = !line;
    tick(!!line?.thinking);
    if (!line) { el.replaceChildren(); built = false; row.key = null; pacer.reset(); body.textContent = ''; body.classList.remove('lv-out'); return; }
    if (!built) { el.replaceChildren(ico, head, body, count); built = true; }
    const tip = line.count ? `${line.label} · ${line.count}` : line.label;
    if (icon !== line.icon) { ico.replaceChildren(glyph(line.icon)); icon = line.icon; }
    ico.setAttribute('aria-label', tip); ico.title = tip;
    head.textContent = line.head || ''; head.hidden = !line.head;
    drawCount(line, id);
    mono = !!line.mono; body.classList.toggle('mono', mono);
    const key = `${id}|${line.key}`;
    const block = key !== row.key;
    const r = nextRow(row, { ...line, key }, fitter(body, mono));
    if (!r) { if (block) pacer.show('', { fresh: true, now: true }); return; }
    // A new block fades in straight away; a completed row waits its turn; a filling row writes in place.
    pacer.show(r.text, { fresh: r.fresh || (block && pacer.shown != null), now: block || still() });
  }
  return {
    /** One `live` SSE message. */
    update(v) {
      if (!v?.id) return;
      if (v.gone) views.delete(v.id); else views.set(v.id, v);
      noteThinking(clocks, v.id, v.gone ? null : liveLine(v), performance.now());
      if (v.id === selected()) render();
    },
    /** A fresh connection: what is live now replaces what was. */
    reset(list = []) {
      views.clear();
      const known = new Map(clocks);
      clocks.clear();
      for (const v of list) {
        if (!v?.id) continue;
        views.set(v.id, v);
        // A reconnect is not news from the model: a block already on the clock keeps its times.
        const line = liveLine(v), c = known.get(v.id);
        if (line?.thinking && c?.key === line.key) clocks.set(v.id, c); else noteThinking(clocks, v.id, line, performance.now());
      }
      render();
    },
    render,
  };
}
