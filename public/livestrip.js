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
      return { ...at, icon: k.icon, label: k.label, body: b.text || '', mono: false, count: n ? `~${fmtTokens(n)} tokens` : null };
    }
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return { ...at, icon: k.icon, label: `${k.label} ${b.name || 'a tool'}`, body: b.text || '', mono: true, head: b.name || null };
    return { ...at, icon: k.icon, label: k.label, body: b.text || '', mono: false };
  }
  const s = STATUS[v.status];
  return s ? { icon: s.icon, label: s.label, body: '', mono: false } : null;
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

/** el: the strip's element; selected(): the session the Events list shows. */
export function createLiveStrip(el, selected) {
  const views = new Map();   // session id -> latest live view
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
  function render() {
    const id = selected();
    const line = liveLine(views.get(id));
    el.hidden = !line;
    if (!line) { el.replaceChildren(); row.key = null; return; }
    const tip = line.count ? `${line.label} · ${line.count}` : line.label;
    const body = h('span', { class: `lv-body${line.mono ? ' mono' : ''}` });
    // replaceChildren() would print a null as the text "null": leave the missing parts out.
    el.replaceChildren(...[
      h('span', { class: 'lv-ico', role: 'img', 'aria-label': tip, title: tip }, glyph(line.icon)),
      line.head ? h('span', { class: 'lv-head' }, line.head) : null,
      body,
      line.count ? h('span', { class: 'lv-count' }, line.count) : null,
    ].filter(Boolean));
    const r = nextRow(row, { ...line, key: `${id}|${line.key}` }, fitter(body, line.mono));
    if (!r) return;
    body.textContent = clean(r.text, line.mono);
    if (r.fresh) body.classList.add('lv-new');
  }
  return {
    /** One `live` SSE message. */
    update(v) {
      if (!v?.id) return;
      if (v.gone) views.delete(v.id); else views.set(v.id, v);
      if (v.id === selected()) render();
    },
    /** A fresh connection: what is live now replaces what was. */
    reset(list = []) { views.clear(); for (const v of list) if (v?.id) views.set(v.id, v); render(); },
    render,
  };
}
