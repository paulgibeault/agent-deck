// public/events.js — normalized-event renderers: Events rows + Details pane,
// plus the small markdown / diff / highlight helpers they share.
import { modelLabel, priceOf, costOf } from './pricing.js';
import { classify } from './classify.js';

// ------------------------------------------------------------ formatting
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTokens = (n) => n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n);
export const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
export const fmtTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour12: false }); };
export const fmtUsd = (n) => n == null ? '' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
export function ago(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export const basename = (p) => String(p || '').split(/[\\/]/).pop();
export function relPath(p, cwd) {
  if (!p || !cwd) return p || '';
  const c = cwd.endsWith('/') ? cwd : cwd + '/';
  return p.startsWith(c) ? p.slice(c.length) : p;
}
export const oneLine = (s, max = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

// ------------------------------------------------------------ tags
// A bare glyph per kind (see classify.js), tinted by family: the eye finds
// "a push" or "a test run" by shape and color, the tooltip names it.
export function tagFor(ev) {
  const c = classify(ev);
  return { label: c.label, fam: c.fam, icon: c.icon, title: c.label };
}
const isErrEv = (ev) => (ev.kind === 'tool' && (ev.tool.isError || ev.tool.meta?.interrupted)) || !!ev.error;
/** The glyph for an event; `label` adds its name beside it (Details header). */
export function tagEl(ev, { label = false, c = classify(ev) } = {}) {
  const bad = isErrEv(ev) && c.fam !== 'err';
  const name = c.label + (bad ? (ev.tool?.meta?.interrupted && !ev.tool.isError ? ' · interrupted' : ' · failed') : '') + (ev.ts ? ' · ' + fmtTime(ev.ts) : '');
  return h('span', { class: `tic f-${c.fam}${bad ? ' bad' : ''}${label ? ' lab' : ''}`, role: 'img', 'aria-label': name, title: name },
    svgUse(c.icon, 15), label ? h('span', {}, c.label) : null);
}
export const askMini = () => h('button', { class: 'ask-ico ask-mini', type: 'button', dataset: { askRow: '1' }, 'aria-label': 'Ask about this', title: 'Ask about this' }, starIcon(11));
/** Icon-only button: no box, no label; the label is its tooltip and accessible name. */
export function ib(icon, label, onclick, { cls = '', size = 14, ...attrs } = {}) {
  return h('button', { type: 'button', class: `ib${cls ? ' ' + cls : ''}`, 'aria-label': label, title: label, onclick, ...attrs }, svgUse(icon, size));
}
/** Swap an icon button's glyph to a check for a moment, as feedback. */
export function flashDone(btn) {
  const use = btn.querySelector('use'); if (!use) return;
  const was = use.getAttribute('href'); use.setAttribute('href', '#i-check'); btn.classList.add('done');
  setTimeout(() => { use.setAttribute('href', was); btn.classList.remove('done'); }, 900);
}
export function starIcon(n = 11) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', n); svg.setAttribute('height', n); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-star'); svg.append(use);
  return svg;
}

// Row heights for the virtualized list (variable by kind).
export const ROW_HEIGHTS = { prompt: 50, turn_end: 34, default: 30 };
export const rowHeight = (ev) => ROW_HEIGHTS[ev.kind] || ROW_HEIGHTS.default;

// ------------------------------------------------------------ Events rows
/**
 * One row for the virtualized Events list. `turn` carries turn numbering for
 * prompt rows ({ n, meta }) and the summary for turn_end rows ({ text }).
 */
export function renderRow(ev, { depth = 0, selected = false, agentStatus = null, expanded = false, turn = null } = {}) {
  const isErr = (ev.kind === 'tool' && ev.tool.isError) || ev.error;
  const c = classify(ev);
  const row = h('div', { class: `row k-${ev.kind} f-${c.fam}${ev.answer ? ' answer' : ''}${selected ? ' selected' : ''}${isErr ? ' error' : ''}`, dataset: { id: ev.id, seq: ev.seq, sid: ev.sessionId } });
  row.style.setProperty('--depth', depth);
  row.style.height = rowHeight(ev) + 'px';

  if (ev.kind === 'prompt') {
    const card = h('div', { class: 'turn-card' });
    card.append(tagEl(ev, { c }), h('span', { class: 'body', title: ev.text }, oneLine(ev.text.replace(/<[^>]+>/g, ' '), 300)));
    if (ev.origin && ev.origin !== 'human' && ev.origin !== 'sdk') card.append(h('span', { class: 'chip' }, ev.origin));
    if (turn?.queuedMs >= 1000) card.append(h('span', { class: 'chip', title: 'Sent while the agent was busy; waited in the queue' }, svgUse('i-history', 10), ` ${fmtMs(turn.queuedMs)}`));
    if (ev.attachments?.length) card.append(h('span', { class: 'chip', title: ev.attachments.map(attLabel).join('\n') }, svgUse('i-clip', 10), ` ${ev.attachments.length}`));
    card.append(h('span', { class: 'meta' }, turn?.meta || fmtTime(ev.ts)), askMini());
    row.append(card);
    return row;
  }
  if (ev.kind === 'turn_end') {
    row.append(h('span', { class: 'rule' }), h('span', { class: 'body' }, turn?.text || `Turn ended${ev.text ? ' · ' + ev.text : ''}`), h('span', { class: 'rule' }));
    return row;
  }

  row.append(h('span', { class: 'tg' }, tagEl(ev, { c })));
  const body = h('span', { class: 'body' + (c.sans ? ' sans' : '') });
  row.append(body);
  const chips = h('span', { class: 'chips' });
  let dur = null;
  // An MCP call names its server: the one place a word beats a glyph.
  if (c.server) body.append(h('b', { class: 'srv' }, c.server));
  body.append(oneLine(c.text, 260));
  if (c.sub) body.append(h('span', { class: 'sub' }, c.sub));
  body.title = [c.text, c.sub].filter(Boolean).join('\n');

  switch (ev.kind) {
    case 'tool': {
      const t = ev.tool;
      if (t.name === 'Agent' && t.agentId) {
        chips.append(h('button', { class: 'mini agent-open', dataset: { agent: t.agentId }, title: 'open as session' }, 'open'));
        chips.append(h('button', { class: 'mini agent-toggle', dataset: { agent: t.agentId }, title: 'show subagent events inline' }, expanded ? 'hide inline' : 'inline'));
        if (agentStatus) chips.append(h('span', { class: `chip st-${agentStatus}` }, agentStatus));
      }
      if (t.taskId) chips.append(h('button', { class: 'mini task-open', dataset: { task: t.taskId }, title: 'Open the background task' }, 'background'));
      const f = c.facts;
      if (f?.badge) chips.append(h('span', { class: `chip f-${c.fam}`, title: f.title || null }, f.badge));
      if (f && f.pass != null) {
        if (f.fail) chips.append(h('span', { class: 'chip err', title: `${f.fail} failed, ${f.pass} passed` }, `${f.fail} failed`));
        else chips.append(h('span', { class: 'chip ok', title: `${f.pass} passed` }, svgUse('i-check', 10), ` ${f.pass}`));
      }
      if (t.pending) dur = h('span', { class: 'dur run' }, 'running');
      else {
        if (t.result?.images?.length) chips.append(h('span', { class: 'chip' }, `${t.result.images.length} img`));
        if (t.durationMs != null) dur = h('span', { class: 'dur' + (t.isError ? ' bad' : '') }, fmtMs(t.durationMs));
      }
      break;
    }
    case 'queue':
      if (ev.queueDepth > 1) chips.append(h('span', { class: 'chip', title: 'Messages waiting' }, `${ev.queueDepth} waiting`));
      break;
    case 'system':
      if (ev.subtype === 'task' && ev.status) chips.append(h('span', { class: `chip ${ev.status === 'completed' ? 'ok' : ev.status === 'failed' ? 'err' : 'st-ended'}` }, ev.status));
      break;
  }
  if (chips.childNodes.length) row.append(chips);
  // The model that produced this. The first event of an API response carries
  // its inference details; the rest of that response show the name dimmer.
  // Hovering either opens the inference card (inferenceCard below). Model,
  // tokens and Ask float in on hover; a model that's news (switched, cut off)
  // stays in the row.
  const hov = h('span', { class: 'hov' });
  const inf = ev.inference;
  let mdl = null;
  if (inf) {
    const flag = inf.synthetic ? ' syn' : inf.stopReason === 'max_tokens' || inf.stopReason === 'refusal' ? ' warn' : inf.switchedFrom ? ' sw' : '';
    mdl = h('span', { class: `mdl${flag}`, 'aria-describedby': 'hovercard' },
      inf.switchedFrom ? '↻ ' : '', modelLabel(inf.model), inf.effort ? h('i', {}, ` ${inf.effort}`) : null);
    if (flag === ' sw' || flag === ' warn') { row.append(mdl); mdl = null; }
  } else if (ev.msgId && ev.model) mdl = h('span', { class: 'mdl cont', 'aria-describedby': 'hovercard' }, modelLabel(ev.model));
  hov.append(askMini());
  if (ev.usage?.output_tokens) hov.append(h('span', { class: 'tok', title: `in ${fmtTokens(ev.usage.input_tokens)} · cache read ${fmtTokens(ev.usage.cache_read_input_tokens)} · cache write ${fmtTokens(ev.usage.cache_creation_input_tokens)} · out ${fmtTokens(ev.usage.output_tokens)}` }, fmtTokens(ev.usage.output_tokens) + ' tok'));
  if (mdl) hov.append(mdl);
  row.append(hov);
  // Duration: faint, flush right, right of the model.
  row.append(dur || h('span', { class: 'dur' }));
  return row;
}

// ------------------------------------------------------------ inference card
const STOP = { end_turn: 'finished its reply', tool_use: 'to call a tool', max_tokens: 'hit the output limit', stop_sequence: 'on a stop sequence', pause_turn: 'paused (server tool)', refusal: 'refused' };
const MISS = { model_changed: 'the model changed', messages_changed: 'earlier messages changed', previous_message_not_found: 'the previous request was not found', unavailable: 'no diagnosis available' };

/** Hover card for an API response: how it was produced and what it cost. */
export function inferenceCard(ev) {
  const inf = ev.inference;
  const u = inf.usage;
  const rows = [];
  const row = (k, v, cls) => { if (v) rows.push(h('tr', {}, h('th', {}, k), h('td', { class: cls || null }, v))); };
  const ctx = u.input + u.cacheRead + u.cacheWrite;
  const price = priceOf(inf.model);
  const cost = costOf(inf.model, u, inf.speed);

  row('Model', [inf.model, inf.switchedFrom ? `switched from ${modelLabel(inf.switchedFrom)}` : null].filter(Boolean).join(' · '), 'mono');
  if (inf.advisorModel) row('Advisor', inf.advisorModel, 'mono');
  row('Effort', inf.effort ? `${inf.effort}${inf.sessionEffort ? ` (session ${inf.sessionEffort})` : ''}` : null);
  const stop = STOP[inf.stopReason] || inf.stopReason;
  row('Stopped', inf.stopDetails ? `${stop} · ${[inf.stopDetails.category, inf.stopDetails.explanation].filter(Boolean).join(': ')}` : stop,
    inf.stopReason === 'max_tokens' || inf.stopReason === 'refusal' ? 'err' : null);
  if (ctx) {
    const pct = price ? ctx / price.context : null;
    const td = h('td', {}, `${fmtTokens(ctx)}${price ? ` of ${fmtTokens(price.context)} (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}%)` : ''}`);
    if (pct != null) td.append(h('span', { class: 'inf-bar' }, h('span', { style: `width:${Math.min(100, pct * 100)}%` })));
    rows.push(h('tr', {}, h('th', {}, 'Context'), td));
  }
  row('Input', [u.cacheRead ? `${fmtTokens(u.cacheRead)} cached` : null, u.cacheWrite ? `${fmtTokens(u.cacheWrite)} written to cache${u.cacheWrite1h === u.cacheWrite ? ' (1h)' : u.cacheWrite1h ? ` (${fmtTokens(u.cacheWrite1h)} 1h)` : ' (5m)'}` : null, `${fmtTokens(u.input)} new`].filter(Boolean).join(' · '));
  row('Output', `${fmtTokens(u.output)} tokens${u.thinking ? ` · ${fmtTokens(u.thinking)} thinking` : ''}${inf.thinkingMs != null ? ` · thought ${fmtMs(inf.thinkingMs)}` : ''}`);
  if (ctx) {
    const hit = u.cacheRead / ctx;
    row('Cache', inf.cacheMiss
      ? `miss: ${MISS[inf.cacheMiss.reason] || inf.cacheMiss.reason.replace(/_/g, ' ')}${inf.cacheMiss.tokens ? ` · ${fmtTokens(inf.cacheMiss.tokens)} tokens re-read at full price` : ''}`
      : `${(hit * 100).toFixed(hit > 0.99 && hit < 1 ? 1 : 0)}% read from cache`, inf.cacheMiss ? 'err' : null);
  }
  if (inf.thinkingDropped) row('Thinking', `${inf.thinkingDropped.count} earlier block${inf.thinkingDropped.count === 1 ? '' : 's'} dropped (${(inf.thinkingDropped.reason || '').replace(/_/g, ' ')})`);
  if (cost) {
    const parts = [['cached', cost.cacheRead], ['cache writes', cost.cacheWrite], ['new input', cost.input], ['output', cost.output]].filter(([, v]) => v >= 0.0005);
    rows.push(h('tr', {}, h('th', {}, 'Cost'), h('td', { title: `${modelLabel(inf.model)} list prices per million tokens: input $${price.input}, cache read $${price.cacheRead}, output $${price.output}; cache writes 1.25x input (5m) or 2x (1h)${inf.speed === 'fast' ? '; fast mode 2x' : ''}` },
      h('b', {}, `≈ ${fmtUsd4(cost.total)}`), ' at API rates', parts.length > 1 ? h('div', { class: 'muted' }, parts.map(([k, v]) => `${k} ${fmtUsd4(v)}`).join(' · ')) : null)));
  }
  row('Served', [inf.speed ? `${inf.speed} mode` : null, inf.tier ? `${inf.tier} tier` : null, inf.geo ? `in ${inf.geo}` : null, inf.fallbacks ? `${inf.fallbacks} fallback${inf.fallbacks === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '));
  if (inf.web) row('Web', [inf.web.searches ? `${inf.web.searches} search${inf.web.searches === 1 ? '' : 'es'}` : null, inf.web.fetches ? `${inf.web.fetches} fetch${inf.web.fetches === 1 ? '' : 'es'}` : null].filter(Boolean).join(' · '));
  if (inf.synthetic) row('Note', 'Written by Claude Code, not the model (an API error or interruption)');
  row('Request', inf.requestId, 'mono');
  return [
    h('div', { class: 'hc-h' }, h('b', {}, `${modelLabel(inf.model)} · one API response`)),
    h('table', { class: 'hc-tbl' }, h('tbody', {}, ...rows)),
    h('div', { class: 'hc-foot' }, [inf.cli ? `Claude Code ${inf.cli}` : null, inf.entrypoint].filter(Boolean).join(' · ')),
  ];
}
const fmtUsd4 = (n) => n >= 0.1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(3)}` : '<$0.001';

// ------------------------------------------------------------ markdown
/**
 * Markdown to HTML. Chat text calls it bare. Files pass options:
 * `soft` joins wrapped lines and keeps real heading levels (with ids);
 * `img(src)` maps an image path to a URL; `link(href)` maps a relative link
 * to an absolute path (rendered as data-abs) or null; `html` lets a small,
 * attribute-stripped subset of inline HTML through (img, kbd, details…).
 */
const CALLOUT = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
export const slug = (t) => String(t).toLowerCase().replace(/<[^>]+>/g, '').replace(/&\w+;/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
export function markdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const imgUrl = (u) => /^(https?:|data:image\/)/.test(u) ? u : opts.img ? opts.img(u) : null;
  const inline = (s) => {
    // Code spans first, parked so nothing below rewrites their insides.
    const parked = [];
    let t = esc(s).replace(/(`+)([\s\S]+?)\1/g, (_, __, c) => { parked.push(`<code>${c.trim()}</code>`); return `\u0000${parked.length - 1}\u0000`; });
    if (opts.html) {
      t = t.replace(/&lt;!--[\s\S]*?--&gt;/g, '')
        .replace(/&lt;img\b([\s\S]*?)\/?&gt;/gi, (_, attrs) => {
          const get = (n) => new RegExp(`\\b${n}=&quot;([^&]*(?:&amp;[^&]*)*)&quot;`, 'i').exec(attrs)?.[1];
          const url = get('src') && imgUrl(unesc(get('src'))); if (!url) return '';
          const w = /^\d+%?$/.test(get('width') || '') ? ` width="${get('width')}"` : '';
          return `<img src="${esc(url)}" alt="${get('alt') || ''}"${w} loading="lazy">`;
        })
        .replace(/&lt;a\s[^&]*?href=&quot;(https?:[^&]*)&quot;[\s\S]*?&gt;([\s\S]*?)&lt;\/a&gt;/gi, '<a href="$1" target="_blank" rel="noopener">$2</a>')
        .replace(/&lt;(\/?)(br|kbd|sub|sup|b|i|u|em|strong|details|summary|p|div|span|center|small|mark|ins|picture|source|h[1-6])\b((?:[^&]|&quot;|&amp;|&#39;)*?)\/?&gt;/gi, (_, c, tag, attrs) => {
          // Attributes are dropped, except a plain alignment.
          tag = tag.toLowerCase(); if (tag === 'source') return '';
          const al = !c && /\balign=&quot;(left|center|right)&quot;/i.exec(attrs)?.[1];
          return `<${c}${tag}${al ? ` align="${al.toLowerCase()}"` : ''}>`;
        });
    }
    t = t
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, alt, u) => { const url = imgUrl(unesc(u)); return url ? `<img src="${esc(url)}" alt="${alt}" loading="lazy">` : alt; })
      .replace(/\[([^\]]+)\]\(#([^)\s]+)\)/g, (_, txt, a) => opts.soft ? `<a href="#" data-anchor="${esc(slug(unesc(a)))}">${txt}</a>` : txt)
      .replace(/\[([^\]]+)\]\((?!https?:)([^)\s]+)\)/g, (m, txt, u) => { const abs = opts.link ? opts.link(unesc(u)) : null; return abs ? `<a href="#" data-abs="${esc(abs)}" title="${esc(unesc(u))}">${txt}</a>` : txt; })
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, n) => parked[+n]);
  };
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const indent = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
  const li = (t, sub) => {
    const tm = /^\[([ xX])\]\s+(.*)$/.exec(t);
    return tm ? `<li class="task"><input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> ${inline(tm[2])}${sub}</li>` : `<li>${inline(t)}${sub}</li>`;
  };
  // A list and anything nested under it, by indentation.
  const list = (start) => {
    const m0 = LI.exec(lines[start]); const ind = indent(lines[start]);
    const ordered = /\d/.test(m0[2]); const first = ordered ? parseInt(m0[2], 10) : 1;
    const items = []; let j = start;
    while (j < lines.length) {
      const m = LI.exec(lines[j]); const d = indent(lines[j]);
      if (m && d === ind) { items.push({ text: m[3], sub: '' }); j++; continue; }
      if (m && d > ind && items.length) { const r = list(j); items[items.length - 1].sub += r.html; j = r.next; continue; }
      if (!m && d > ind && items.length && /^\s*(```|~~~)/.test(lines[j])) {
        // A fenced block inside an item.
        const fm = /^\s*(```+|~~~+)\s*([\w+#.-]+)?/.exec(lines[j]); const buf = []; j++;
        while (j < lines.length && !lines[j].trim().startsWith(fm[1])) buf.push(lines[j++].slice(Math.min(d, indent(lines[j - 1]))));
        j++;
        items[items.length - 1].sub += `<pre><code class="hl${fm[2] ? ' language-' + esc(fm[2].toLowerCase()) : ''}">${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      if (!m && lines[j].trim() && d > ind && items.length) { items[items.length - 1].text += ' ' + lines[j].trim(); j++; continue; }
      if (!lines[j].trim()) {
        let k = j; while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && LI.test(lines[k]) && indent(lines[k]) >= ind) { j = k; continue; }
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}${ordered && first !== 1 ? ` start="${first}"` : ''}>${items.map(it => li(it.text, it.sub)).join('')}</${tag}>`, next: j };
  };
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]+)?/.exec(l);
    if (fence) {
      const lang = fence[2] || ''; const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code class="hl${lang ? ' language-' + esc(lang.toLowerCase()) : ''}">${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (hm) {
      const n = opts.soft ? hm[1].length : Math.min(6, hm[1].length + 1); const body = inline(hm[2]);
      out.push(opts.soft ? `<h${n} id="${esc(slug(hm[2]))}">${body}</h${n}>` : `<h${n}>${body}</h${n}>`); i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const cm = /^\[!(\w+)\]\s*$/.exec(buf[0] || '');
      if (cm && CALLOUT[cm[1].toLowerCase()]) {
        const k = cm[1].toLowerCase();
        out.push(`<div class="callout c-${k}"><div class="callout-t">${CALLOUT[k]}</div>${markdown(buf.slice(1).join('\n'), opts)}</div>`);
      } else out.push(`<blockquote>${markdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-+:?\s*(\||$)/.test(lines[i + 1] || '')) {
      // Cells split on |, but not on \| or a | inside `code`.
      const split = (r) => {
        const cells = []; let cur = '', tick = false; const t = r.trim().replace(/^\|/, '').replace(/\|$/, '');
        for (let k = 0; k < t.length; k++) {
          const ch = t[k];
          if (ch === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
          if (ch === '`') tick = !tick;
          if (ch === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
          cur += ch;
        }
        cells.push(cur.trim());
        return cells;
      };
      const align = split(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : null);
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      const head = split(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(split(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => cell('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LI.test(l)) { const r = list(i); out.push(r.html); i = r.next; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    // Files wrap prose at a column (soft breaks); chat text means its newlines.
    // A paragraph that is itself an HTML block (<p align>, <div>…) isn't wrapped again.
    if (opts.html && /^\s*<(p|div|center|details|picture|h[1-6])\b/i.test(buf[0])) { out.push(inline(buf.join(' '))); continue; }
    out.push(`<p>${opts.soft ? inline(buf.join(' ')) : inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------ highlight
const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', kt: 'kotlin', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', diff: 'diff', patch: 'diff', mk: 'makefile', dockerfile: 'dockerfile' };
export function langFor(path) {
  const b = basename(path).toLowerCase();
  if (b === 'makefile') return 'makefile'; if (b === 'dockerfile') return 'dockerfile';
  return LANG[b.split('.').pop()] || null;
}
export function highlightIn(root) {
  if (!window.hljs) return;
  root.querySelectorAll('code.hl').forEach(el => {
    if (el.dataset.highlighted) return;
    if (el.textContent.length > 200_000) return;
    try { window.hljs.highlightElement(el); } catch { /* ignore */ }
  });
}
export function codeBlock(text, lang, { numbers = true, start = 1 } = {}) {
  const pre = h('pre', { class: 'code' + (numbers ? ' numbered' : '') });
  if (numbers) {
    const n = String(text).split('\n').length;
    const nums = []; for (let i = 0; i < n; i++) nums.push(start + i);
    pre.append(h('span', { class: 'lnums', 'aria-hidden': 'true' }, nums.join('\n')));
  }
  const code = h('code', { class: 'hl' + (lang ? ' language-' + lang : ' nohighlight') }, text);
  pre.append(code);
  return pre;
}

// ------------------------------------------------------------ diffs
/** Line diff via LCS; falls back to replace-all for very large inputs. */
export function lineDiff(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  const ops = [];
  if (a.length * b.length > 2_500_000) {
    for (const l of a) ops.push({ t: 'del', a: l });
    for (const l of b) ops.push({ t: 'add', b: l });
    return ops;
  }
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) ops.push({ t: 'del', a: a[i++] });
    else ops.push({ t: 'add', b: b[j++] });
  }
  while (i < n) ops.push({ t: 'del', a: a[i++] });
  while (j < m) ops.push({ t: 'add', b: b[j++] });
  return ops;
}

/** Parse a unified diff into ops (with hunk separators). */
export function parseUnified(text) {
  const ops = []; let an = 0, bn = 0;
  for (const l of String(text).split('\n')) {
    if (/^(diff |index |--- |\+\+\+ )/.test(l)) continue;
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (hm) { an = +hm[1]; bn = +hm[2]; ops.push({ t: 'hunk', text: l }); continue; }
    if (l.startsWith('+')) ops.push({ t: 'add', b: l.slice(1), bn: bn++ });
    else if (l.startsWith('-')) ops.push({ t: 'del', a: l.slice(1), an: an++ });
    else if (l.startsWith('\\')) continue;
    else if (l === '' && ops.length === 0) continue;
    else ops.push({ t: 'eq', a: l.slice(1), b: l.slice(1), an: an++, bn: bn++ });
  }
  return ops;
}

// Word-level changes within a paired removed/added line: char ranges on each
// side, or null when the line changed wholesale (then marks add nothing).
const TOK = /\w+|\s+|[^\w\s]/g;
export function wordRanges(a, b) {
  const ta = a.match(TOK) || [], tb = b.match(TOK) || [];
  const n = ta.length, m = tb.length;
  if (!n || !m || n * m > 120_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra = [], rb = []; let i = 0, j = 0, pa = 0, pb = 0;
  const push = (arr, s, e) => { const last = arr[arr.length - 1]; if (last && last[1] === s) last[1] = e; else arr.push([s, e]); };
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) { pa += ta[i++].length; pb += tb[j++].length; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { push(rb, pb, pb + tb[j].length); pb += tb[j++].length; }
    else { push(ra, pa, pa + ta[i].length); pa += ta[i++].length; }
  }
  const changed = (rs, len) => rs.reduce((t, [x, y]) => t + y - x, 0) / Math.max(1, len);
  if (changed(ra, a.length) > 0.7 && changed(rb, b.length) > 0.7) return null;
  return [ra, rb];
}
/** Wrap char ranges of an element's text in <mark>, across highlight spans. */
function markRanges(el, ranges) {
  if (!ranges?.length) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  let off = 0;
  for (const node of nodes) {
    const t = node.nodeValue, start = off, end = off + t.length; off = end;
    const cuts = ranges.filter(([x, y]) => y > start && x < end).map(([x, y]) => [Math.max(x, start) - start, Math.min(y, end) - start]);
    if (!cuts.length) continue;
    const frag = document.createDocumentFragment(); let p = 0;
    for (const [x, y] of cuts) { if (x > p) frag.append(t.slice(p, x)); frag.append(h('mark', { class: 'wd' }, t.slice(x, y))); p = y; }
    if (p < t.length) frag.append(t.slice(p));
    node.replaceWith(frag);
  }
}
function diffLine(text, lang, ranges) {
  const el = h('span', { class: 'lt' });
  if (lang && window.hljs?.getLanguage?.(lang) && text.length < 2000) {
    try { el.innerHTML = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { el.textContent = text; }
  } else el.textContent = text;
  markRanges(el, ranges);
  return el;
}

/**
 * A rich diff from ops: `split` (side by side) or `unified`, syntax
 * highlighted, with the changed words marked inside each changed line.
 */
export function renderDiff(ops, { lang = null, mode = 'split', startA = 1, startB = 1 } = {}) {
  const uni = mode === 'unified';
  const table = h('table', { class: uni ? 'udiff' : 'sbs' });
  let an = startA, bn = startB;
  const num = (n) => h('span', { class: 'ln' }, n == null ? '' : String(n));
  const sbsCell = (cls, n, text, r) => h('td', { class: cls }, num(n), cls === 'empty' ? null : diffLine(text ?? '', lang, r));
  const uniRow = (cls, a, b, text, r) => h('tr', { class: cls }, h('td', { class: 'ln' }, a ?? ''), h('td', { class: 'ln' }, b ?? ''),
    h('td', { class: 'sg' }, cls === 'add' ? '+' : cls === 'del' ? '−' : ''), h('td', { class: 'tx' }, diffLine(text ?? '', lang, r)));
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.t === 'hunk') {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/.exec(op.text);
      const label = hm ? `Line ${hm[3]}${hm[5] ? ' · ' + hm[5] : ''}` : op.text;
      table.append(h('tr', { class: 'hunk' }, h('td', { colspan: uni ? 4 : 2 }, label))); k++; continue;
    }
    if (op.t === 'eq') {
      const a = op.an ?? an, b = op.bn ?? bn; an = a + 1; bn = b + 1;
      table.append(uni ? uniRow('eq', a, b, op.a) : h('tr', {}, sbsCell('eq', a, op.a), sbsCell('eq', b, op.b))); k++; continue;
    }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].t === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].t === 'add') adds.push(ops[k++]);
    const pairs = Math.min(dels.length, adds.length);
    const wr = []; for (let x = 0; x < pairs; x++) wr.push(wordRanges(dels[x].a, adds[x].b));
    const dn = dels.map(d => { const v = d.an ?? an; an = v + 1; return v; });
    const bnn = adds.map(a => { const v = a.bn ?? bn; bn = v + 1; return v; });
    if (uni) {
      dels.forEach((d, x) => table.append(uniRow('del', dn[x], null, d.a, wr[x]?.[0])));
      adds.forEach((a, x) => table.append(uniRow('add', null, bnn[x], a.b, wr[x]?.[1])));
    } else {
      for (let x = 0; x < Math.max(dels.length, adds.length); x++) {
        const d = dels[x], a = adds[x];
        table.append(h('tr', {}, d ? sbsCell('del', dn[x], d.a, wr[x]?.[0]) : sbsCell('empty'), a ? sbsCell('add', bnn[x], a.b, wr[x]?.[1]) : sbsCell('empty')));
      }
    }
  }
  return h('div', { class: 'sbs-wrap' }, table);
}
/** Side-by-side table from ops (kept for existing callers). */
export const renderSideBySide = (ops, opts = {}) => renderDiff(ops, { ...opts, mode: 'split' });

// ------------------------------------------------------------ details
export const copyBtn = (text, label = 'Copy') => ib('i-copy', label, (e) => { navigator.clipboard?.writeText(typeof text === 'function' ? text() : text); flashDone(e.currentTarget); }, { size: 13 });
const editorBtn = (path, line, api) => path ? ib('i-open', 'Open in editor', () => api.openEditor(path, line)) : null;
const openBtn = (path, line, api) => path ? ib('i-open', 'Open in editor', () => api.openEditor(path, line), { size: 13 }) : null;

/** Icon-only Ask button; `spec` is the scope item app.js resolves. */
export function askIco(spec, label = 'Ask about this') {
  return h('button', { class: 'ask-ico', type: 'button', 'aria-label': label, title: label, dataset: { ask: JSON.stringify(spec) } }, starIcon(11));
}

function stripReadNumbers(text) {
  // Read tool output is "   12\tline"; keep content, remember the start line.
  const lines = String(text).split('\n');
  const m = /^\s*(\d+)\t/.exec(lines[0] || '');
  if (!m) return { text, start: 1 };
  return { text: lines.map(l => l.replace(/^\s*\d+\t/, '')).join('\n'), start: +m[1] };
}

/**
 * A details section: title, action buttons, an Ask button scoped to it.
 * `ask` is a scope spec ({ kind: 'event', ..., label }) or null.
 */
export function section(title, { actions = [], ask = null, note = null } = {}, ...children) {
  const head = h('div', { class: 'dsec-h' }, h('span', { class: 'dsec-t', title }, title));
  if (note) head.append(h('span', { class: 'note' }, note));
  head.append(h('span', { class: 'dsec-sp' }), ...actions.filter(Boolean));
  if (ask) head.append(askIco(ask, `Ask about ${ask.what || 'this'}`));
  return h('section', { class: 'dsec' }, head, ...children);
}

export function headerFor({ tag, chips = [], title, meta = [], nav = true, raw = null, actions = [] }) {
  const head = h('div', { class: 'dhead' });
  const row = h('div', { class: 'dh-row' }, tag, ...chips.filter(Boolean), h('span', { class: 'spacer' }));
  if (nav) {
    row.append(h('button', { class: 'icon-btn sm', type: 'button', dataset: { nav: '-1' }, 'aria-label': 'Previous event (↑)', title: 'Previous event (↑)' }, svgUse('i-up', 12)));
    row.append(h('button', { class: 'icon-btn sm', type: 'button', dataset: { nav: '1' }, 'aria-label': 'Next event (↓)', title: 'Next event (↓)' }, svgUse('i-down', 12)));
  }
  if (raw) row.append(raw);
  row.append(...actions.filter(Boolean));
  head.append(row, h('h2', { class: 'dtitle' }, title));
  const m = meta.filter(Boolean);
  if (m.length) head.append(h('div', { class: 'dmeta' }, ...m.map(x => h('span', {}, x))));
  return head;
}
export function svgUse(id, n = 12) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', n); svg.setAttribute('height', n); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id); svg.append(use);
  return svg;
}

function titleOf(ev) {
  if (ev.kind === 'tool') {
    const t = ev.tool;
    if (t.name === 'Bash' && t.input.description) return t.input.description;
    if (t.name === 'Agent') return t.input.description || 'Subagent';
    return `${t.display} ${t.summary}`.trim();
  }
  if (ev.kind === 'text') return 'Assistant message';
  if (ev.kind === 'prompt') return oneLine(ev.text.replace(/<[^>]+>/g, ' '), 140);
  if (ev.kind === 'thinking') return 'Thinking';
  return ev.subtype || ev.kind;
}

/**
 * Details pane content for one event. `detail` is the server's full record
 * (may be null while loading); `ctx` carries cwd, api helpers, session ids,
 * and `position` ("step 18 of 22 in turn 13").
 */
export function renderDetails(ev, detail, ctx) {
  const root = h('div', { class: 'details' });
  const t = ev.tool;
  const when = fmtTime(ev.ts);
  const at = `${tagFor(ev).label} ${when}`;
  const evSpec = (part, what) => ({ kind: 'event', sessionId: ev.sessionId, eventId: ev.id, label: part ? `${part} of ${at}` : at, what });
  const statusChip = ev.kind !== 'tool' ? null
    : t.pending ? h('span', { class: 'chip st-running' }, 'running')
    : t.isError ? h('span', { class: 'chip err' }, t.name === 'Bash' && detail?.toolUseResult?.returnCodeInterpretation ? detail.toolUseResult.returnCodeInterpretation : 'error')
    : h('span', { class: 'chip ok' }, t.name === 'Bash' ? 'exit 0' : 'ok');
  const rawToggle = ib('i-code', 'Raw record', () => root.classList.toggle('show-raw'));
  const tokens = ev.usage?.output_tokens ? `${fmtTokens(ev.usage.output_tokens)} tokens` : null;
  root.append(headerFor({
    tag: tagEl(ev, { label: true }), chips: [statusChip], title: titleOf(ev), raw: rawToggle,
    meta: [when, ev.kind === 'tool' && t.durationMs != null ? fmtMs(t.durationMs) : null, tokens, ev.model ? ev.model.replace('claude-', '') : null, ctx.position],
  }));

  const body = h('div', { class: 'dbody' });
  root.append(body);
  const resultText = detail?.resultText ?? ev.tool?.result?.text ?? '';
  const truncated = !detail && ev.tool?.result?.truncated;
  const loading = truncated ? h('span', { class: 'chip' }, 'loading full…') : null;

  if (ev.kind === 'text') {
    body.append(section('Assistant', { actions: [ctx.readAloud ? ib('i-speaker', 'Read aloud (r)', () => ctx.readAloud(ev), { size: 13 }) : null, copyBtn(ev.text)], ask: evSpec(null, 'this message') }, h('div', { class: 'md', html: markdown(ev.text) })));
  } else if (ev.kind === 'thinking') {
    body.append(section('Thinking', { actions: [ev.text ? copyBtn(ev.text) : null], ask: ev.text ? evSpec(null, 'this reasoning') : null }, h('pre', { class: 'plain muted' }, ev.redacted ? '(redacted by the API)' : ev.text || '(not recorded: the transcript keeps only the signature for this block)')));
  } else if (ev.kind === 'prompt') {
    body.append(section('Prompt', { actions: [copyBtn(ev.text)], ask: evSpec('Prompt', 'this prompt') }, h('pre', { class: 'plain' }, ev.text)));
    if (ev.attachments?.length) body.append(section('Attachments', {}, renderPromptAttachments(ev)));
  } else if (ev.kind === 'tool') {
    const path = t.input.file_path || t.input.notebook_path || null;
    switch (t.name) {
      case 'Edit': {
        const ops = lineDiff(t.input.old_string ?? '', t.input.new_string ?? '');
        const start = detail?.toolUseResult?.structuredPatch?.[0]?.oldStart ?? t.meta?.structuredPatch?.[0]?.oldStart ?? 1;
        body.append(section(relPath(path, ctx.cwd), { actions: [openBtn(path, start, ctx.api), copyBtn(t.input.new_string ?? '', 'Copy the new text')], ask: evSpec('Edit', 'this change') },
          renderSideBySide(ops, { lang: langFor(path), startA: start, startB: detail?.toolUseResult?.structuredPatch?.[0]?.newStart ?? start })));
        if (t.input.replace_all) body.append(h('div', { class: 'note' }, 'replace_all'));
        break;
      }
      case 'MultiEdit': {
        for (const e of t.input.edits || []) body.append(section(relPath(path, ctx.cwd), { ask: evSpec('Edit', 'these edits') }, renderSideBySide(lineDiff(e.old_string ?? '', e.new_string ?? ''), { lang: langFor(path) })));
        break;
      }
      case 'Write': {
        body.append(section(relPath(path, ctx.cwd), { actions: [openBtn(path, 1, ctx.api), copyBtn(t.input.content ?? '')], ask: evSpec('Written file', 'this file') }, codeBlock(t.input.content ?? '', langFor(path))));
        break;
      }
      case 'Read': {
        const { text, start } = stripReadNumbers(resultText);
        body.append(section(relPath(path, ctx.cwd), { actions: [loading, openBtn(path, start, ctx.api), copyBtn(text)], ask: evSpec('Read', 'this file') },
          t.result?.images?.length ? renderImages(ev, ctx) : codeBlock(text, langFor(path), { start })));
        break;
      }
      case 'Bash': {
        body.append(section('Command', { actions: [copyBtn(t.input.command ?? ''), ib('i-term', 'Run in Shell', () => ctx.runInShell?.(t.input.command ?? ''), { size: 13 })], ask: evSpec('Command', 'this command') },
          codeBlock(t.input.command ?? '', 'bash', { numbers: false })));
        const r = detail?.toolUseResult;
        const stdout = r?.stdout ?? resultText; const stderr = r?.stderr ?? '';
        const lines = stdout ? stdout.split('\n').length : 0;
        body.append(section(t.isError ? 'Output (error)' : 'Output', { note: t.pending ? 'running…' : `stdout · ${lines} line${lines === 1 ? '' : 's'}`, actions: [loading, copyBtn(stdout)], ask: evSpec('Output', 'this output') },
          h('pre', { class: 'plain out' + (t.isError ? ' err' : '') }, stdout || '(no output)')));
        if (stderr) body.append(section('stderr', { ask: evSpec('stderr', 'stderr') }, h('pre', { class: 'plain out err' }, stderr)));
        if (r?.interrupted) body.append(h('div', { class: 'note err' }, 'interrupted'));
        break;
      }
      case 'Agent': {
        const card = h('div', { class: 'agent-card' });
        card.append(h('div', { class: 'card-t' }, t.input.description || '(no description)'));
        card.append(h('div', { class: 'muted' }, [t.input.subagent_type || 'general-purpose', t.input.model, t.input.isolation ? `isolation: ${t.input.isolation}` : null, t.meta?.resolvedModel].filter(Boolean).join(' · ')));
        if (t.agentId) {
          const st = ctx.agentStatus?.(t.agentId) || 'unknown';
          card.append(h('div', { class: 'card-row' }, h('span', { class: `chip st-${st}` }, st), ib('i-open', 'Open as session', () => ctx.selectSession(t.agentId), { size: 13 })));
        }
        body.append(section('Subagent', { ask: evSpec('Subagent', 'this subagent') }, card));
        body.append(section('Prompt', { actions: [copyBtn(t.input.prompt ?? '')] }, h('details', {}, h('summary', {}, `${fmtTokens((t.input.prompt || '').length)} chars`), h('pre', { class: 'plain' }, t.input.prompt ?? ''))));
        body.append(section('Result', { ask: evSpec('Result', 'this result') }, h('pre', { class: 'plain' }, resultText || (t.pending ? '(running)' : '(none)'))));
        break;
      }
      default: {
        body.append(section('Input', { actions: [copyBtn(() => JSON.stringify(t.input, null, 2))], ask: evSpec('Input', 'this input') }, h('pre', { class: 'plain' }, JSON.stringify(t.input, null, 2))));
        if (t.result?.images?.length) body.append(section('Images', {}, renderImages(ev, ctx)));
        if (resultText || !t.pending) body.append(section(t.isError ? 'Result (error)' : 'Result', { actions: [loading, copyBtn(resultText)], ask: evSpec('Result', 'this result') },
          h('pre', { class: 'plain out' + (t.isError ? ' err' : '') }, resultText || '(empty)')));
        if (t.pending) body.append(h('div', { class: 'note' }, 'running…'));
      }
    }
    const bgt = t.taskId && ctx.openTask?.(t.taskId);
    if (bgt) body.prepend(section('Background', {}, h('div', { class: 'card-row' }, h('span', { class: `chip ${bgt.state === 'running' ? 'st-running' : bgt.state === 'failed' ? 'err' : 'st-ended'}` }, bgt.state),
      h('span', { class: 'muted' }, bgt.state === 'running' ? 'still running in the background' : bgt.task.summary || ''), h('button', { type: 'button', class: 'btn sm', onclick: bgt.open }, 'Open task'))));
    if (t.meta && Object.keys(t.meta).length) body.append(section('Result metadata', {}, h('details', {}, h('summary', {}, 'toolUseResult (slim)'), h('pre', { class: 'plain' }, JSON.stringify(t.meta, null, 2)))));
  } else {
    body.append(section(ev.subtype || ev.kind, { actions: [copyBtn(ev.text ?? '')], ask: evSpec(null, 'this') }, h('pre', { class: 'plain' + (ev.error ? ' err' : '') }, ev.text ?? '')));
  }

  const rawPane = h('div', { class: 'raw' });
  rawPane.append(section('Raw records', { actions: [copyBtn(() => JSON.stringify(detail?.raw ?? ev, null, 2))] },
    h('pre', { class: 'plain' }, detail ? JSON.stringify(detail.raw, (k, v) => typeof v === 'string' && v.length > 20000 ? v.slice(0, 20000) + `…[${v.length}]` : v, 2) : JSON.stringify(ev, null, 2) + (detail === null ? '\n\n(loading full record…)' : ''))));
  root.append(rawPane);
  highlightIn(root);
  return root;
}

const attLabel = (a) => a.kind === 'image' ? `image (${a.mediaType || '?'})` : a.name;
function renderPromptAttachments(ev) {
  const wrap = h('div', { class: 'prompt-att' });
  for (const a of ev.attachments) {
    if (a.kind === 'image') {
      const src = `/api/sessions/${encodeURIComponent(ev.sessionId)}/events/${encodeURIComponent(ev.id)}/image/${a.index}`;
      wrap.append(h('a', { href: src, target: '_blank' }, h('img', { src, alt: a.mediaType || 'image', title: `${a.mediaType} · ${fmtTokens(a.bytes)} b64 chars` })));
    } else wrap.append(h('span', { class: 'chip', title: a.kind === 'pdf' ? 'PDF document' : 'inlined as text' }, svgUse('i-clip', 10), ` ${a.name}`));
  }
  return wrap;
}

function renderImages(ev, ctx) {
  const wrap = h('div', { class: 'images' });
  for (const im of ev.tool.result.images) {
    const src = `/api/sessions/${encodeURIComponent(ev.sessionId)}/events/${encodeURIComponent(ev.id)}/image/${im.index}`;
    wrap.append(h('a', { href: src, target: '_blank' }, h('img', { src, alt: im.mediaType, title: `${im.mediaType} · ${fmtTokens(im.bytes)} b64 chars` })));
  }
  return wrap;
}

/** Details content for a git diff from the Changes tab. */
export function renderDiffDetails(diff, ctx) {
  const root = h('div', { class: 'details' });
  const full = ctx.cwd && diff.file ? `${ctx.root || ctx.cwd}/${diff.file}` : diff.file;
  root.append(headerFor({ tag: h('span', { class: 'tag f-edit' }, 'Diff'), title: diff.file || '', nav: false, actions: [editorBtn(full, 1, ctx.api)], meta: [diff.untracked ? 'untracked' : 'vs HEAD'] }));
  const body = h('div', { class: 'dbody' });
  body.append(section('Changes', { actions: [copyBtn(diff.diff ?? '')], ask: diff.diff ? { kind: 'text', label: `Diff of ${diff.file}`, text: diff.diff, what: 'this diff' } : null },
    diff.diff ? renderSideBySide(parseUnified(diff.diff), { lang: langFor(diff.file) }) : h('div', { class: 'note' }, 'no diff')));
  root.append(body);
  return root;
}
