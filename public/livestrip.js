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
    const k = BLOCK[b.type] || { icon: 'i-code', label: b.type };
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const n = v.thinking ?? b.tokens;
      return { icon: k.icon, label: k.label, body: b.text?.trim() || '', mono: false, count: n ? `~${fmtTokens(n)} tokens` : null };
    }
    if (b.type === 'tool_use' || b.type === 'server_tool_use') return { icon: k.icon, label: `${k.label} ${b.name || 'a tool'}`, body: b.text || '', mono: true, head: b.name || null };
    return { icon: k.icon, label: k.label, body: b.text || '', mono: false };
  }
  const s = STATUS[v.status];
  return s ? { icon: s.icon, label: s.label, body: '', mono: false } : null;
}

/** The end of what is being written: the line shows its newest words. */
export function tail(text, n = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/** el: the strip's element; selected(): the session the Events list shows. */
export function createLiveStrip(el, selected) {
  const views = new Map();   // session id -> latest live view
  function render() {
    const line = liveLine(views.get(selected()));
    el.hidden = !line;
    if (!line) { el.replaceChildren(); return; }
    const tip = line.count ? `${line.label} · ${line.count}` : line.label;
    el.replaceChildren(
      h('span', { class: 'lv-ico', role: 'img', 'aria-label': tip, title: tip }, glyph(line.icon)),
      line.head ? h('span', { class: 'lv-head' }, line.head) : null,
      h('span', { class: `lv-body${line.mono ? ' mono' : ''}` }, tail(line.body)),
      line.count ? h('span', { class: 'lv-count' }, line.count) : null,
    );
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
