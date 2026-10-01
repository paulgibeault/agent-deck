// public/events.js — normalized-event renderers: Events rows + Details pane,
// plus the small markdown / diff / highlight helpers they share.

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
const oneLine = (s, max = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

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

// ------------------------------------------------------------ icons
const ICONS = {
  Bash: '⌘', Read: '📄', Write: '✎', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Glob: '🔍', Grep: '🔍', Agent: '🤖',
  WebFetch: '🌐', WebSearch: '🌐', TodoWrite: '☑', ToolSearch: '🧰', Skill: '✨', AskUserQuestion: '❓', SendUserFile: '📎',
  Artifact: '🖼', text: '💬', thinking: '…', prompt: '▶', turn_end: '■', queue: '⏳', system: 'ℹ', raw: '{}',
};
export function iconFor(ev) {
  if (ev.kind === 'tool') return ICONS[ev.tool.name] || (ev.tool.name.startsWith('mcp__') ? '🔌' : '⚙');
  return ICONS[ev.kind] || '•';
}

// ------------------------------------------------------------ Events rows
/** One dense row for the virtualized Events list. */
export function renderRow(ev, { depth = 0, selected = false, cwd = null, agentStatus = null, expanded = false } = {}) {
  const row = h('div', { class: `row k-${ev.kind}${selected ? ' selected' : ''}${ev.kind === 'tool' && ev.tool.isError ? ' error' : ''}${ev.error ? ' error' : ''}`, dataset: { id: ev.id, seq: ev.seq, sid: ev.sessionId } });
  row.style.setProperty('--depth', depth);
  row.append(h('span', { class: 'ts' }, fmtTime(ev.ts)));
  row.append(h('span', { class: 'ico' }, iconFor(ev)));
  const body = h('span', { class: 'body' });
  row.append(body);
  const chips = h('span', { class: 'chips' });

  switch (ev.kind) {
    case 'tool': {
      const t = ev.tool;
      body.append(h('span', { class: 'tname' }, t.display));
      body.append(' ');
      body.append(h('span', { class: 'tsum', title: t.name === 'Bash' ? (t.input.description || t.input.command || '') : t.summary }, t.summary));
      if (t.name === 'Agent' && t.agentId) {
        chips.append(h('button', { class: 'mini agent-open', dataset: { agent: t.agentId }, title: 'open as session' }, '↗ open'));
        chips.append(h('button', { class: 'mini agent-toggle', dataset: { agent: t.agentId }, title: 'expand subagent events inline' }, expanded ? '▾ inline' : '▸ inline'));
        if (agentStatus) chips.append(h('span', { class: `chip st-${agentStatus}` }, agentStatus));
      }
      if (t.pending) chips.append(h('span', { class: 'chip pending' }, '…'));
      else {
        if (t.durationMs != null) chips.append(h('span', { class: 'chip dur' }, fmtMs(t.durationMs)));
        if (t.isError) chips.append(h('span', { class: 'chip err' }, 'error'));
        else if (t.meta?.interrupted) chips.append(h('span', { class: 'chip err' }, 'interrupted'));
        if (t.result?.images?.length) chips.append(h('span', { class: 'chip' }, `${t.result.images.length} img`));
      }
      break;
    }
    case 'text':
      body.append(h('span', { class: 'txt' }, oneLine(ev.text, 220)));
      break;
    case 'thinking':
      body.append(h('span', { class: 'txt muted' }, ev.redacted ? 'thinking (redacted)' : `thinking · ${fmtTokens(ev.text.length)} chars`));
      break;
    case 'prompt':
      body.append(h('span', { class: 'txt' }, oneLine(ev.text.replace(/<[^>]+>/g, ' '), 220)));
      if (ev.origin && ev.origin !== 'human') chips.append(h('span', { class: 'chip' }, ev.origin));
      break;
    case 'turn_end':
      body.append(h('span', { class: 'txt muted' }, `turn end${ev.text ? ' · ' + ev.text : ''}`));
      break;
    case 'queue':
      body.append(h('span', { class: 'txt muted' }, `${ev.op}${ev.text ? ': ' + oneLine(ev.text, 160) : ''}`));
      if (ev.queueDepth != null) chips.append(h('span', { class: 'chip' }, `q${ev.queueDepth}`));
      break;
    case 'system':
      body.append(h('span', { class: 'txt' + (ev.error ? '' : ' muted') }, `${ev.subtype || 'system'} · ${oneLine(ev.text, 200)}`));
      break;
    default:
      body.append(h('span', { class: 'txt muted' }, `${ev.subtype || 'raw'} · ${oneLine(ev.text, 200)}`));
  }
  if (ev.usage?.output_tokens) chips.append(h('span', { class: 'chip tok', title: `in ${fmtTokens(ev.usage.input_tokens)} · cache read ${fmtTokens(ev.usage.cache_read_input_tokens)} · cache write ${fmtTokens(ev.usage.cache_creation_input_tokens)} · out ${fmtTokens(ev.usage.output_tokens)}` }, `${fmtTokens(ev.usage.output_tokens)}↑`));
  row.append(chips);
  return row;
}

// ------------------------------------------------------------ markdown
export function markdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*```\s*(\w+)?/.exec(l);
    if (fence) {
      const lang = fence[1] || ''; const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code class="hl${lang ? ' language-' + esc(lang) : ''}">${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hm) { out.push(`<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (lm) {
      const ordered = /\d/.test(lm[2]); const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) { if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; } break; }
        items.push(m[3]); i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
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

/** Side-by-side table from ops. Pairs runs of del/add. */
export function renderSideBySide(ops, { lang = null, startA = 1, startB = 1 } = {}) {
  const table = h('table', { class: 'sbs' });
  let an = startA, bn = startB;
  const cell = (cls, num, text) => h('td', { class: cls }, num != null ? h('span', { class: 'ln' }, String(num)) : null, h('span', { class: 'lt' }, text ?? ''));
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.t === 'hunk') { table.append(h('tr', { class: 'hunk' }, h('td', { colspan: 2 }, op.text))); an = op.an ?? an; bn = op.bn ?? bn; k++; continue; }
    if (op.t === 'eq') {
      const a = op.an ?? an++, b = op.bn ?? bn++; if (op.an != null) { an = op.an + 1; bn = op.bn + 1; }
      table.append(h('tr', {}, cell('eq', a, op.a), cell('eq', b, op.b))); k++; continue;
    }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].t === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].t === 'add') adds.push(ops[k++]);
    const n = Math.max(dels.length, adds.length);
    for (let x = 0; x < n; x++) {
      const d = dels[x], a = adds[x];
      let dn = null, bnn = null;
      if (d) { dn = d.an ?? an++; if (d.an != null) an = d.an + 1; }
      if (a) { bnn = a.bn ?? bn++; if (a.bn != null) bn = a.bn + 1; }
      table.append(h('tr', {}, d ? cell('del', dn, d.a) : cell('empty'), a ? cell('add', bnn, a.b) : cell('empty')));
    }
  }
  if (lang && window.hljs) {
    table.querySelectorAll('td .lt').forEach(el => { try { if (el.textContent.length < 2000) el.innerHTML = window.hljs.highlight(el.textContent, { language: lang }).value; } catch { /* ignore */ } });
  }
  return h('div', { class: 'sbs-wrap' }, table);
}

// ------------------------------------------------------------ details
const copyBtn = (text, label = 'copy') => h('button', { class: 'mini', onclick: (e) => { navigator.clipboard?.writeText(typeof text === 'function' ? text() : text); e.target.textContent = 'copied'; setTimeout(() => e.target.textContent = label, 900); } }, label);
const openBtn = (path, line, api) => path ? h('button', { class: 'mini', title: 'open in editor', onclick: () => api.openEditor(path, line) }, '↗ editor') : null;

function stripReadNumbers(text) {
  // Read tool output is "   12\tline"; keep content, remember the start line.
  const lines = String(text).split('\n');
  const m = /^\s*(\d+)\t/.exec(lines[0] || '');
  if (!m) return { text, start: 1 };
  return { text: lines.map(l => l.replace(/^\s*\d+\t/, '')).join('\n'), start: +m[1] };
}

function section(title, ...children) {
  return h('section', { class: 'dsec' }, h('div', { class: 'dsec-h' }, title), ...children);
}

/**
 * Details pane content for one event. `detail` is the server's full record
 * (may be null while loading); `ctx` carries cwd, api helpers, session ids.
 */
export function renderDetails(ev, detail, ctx) {
  const root = h('div', { class: 'details' });
  const head = h('div', { class: 'dhead' });
  head.append(h('span', { class: 'ico' }, iconFor(ev)));
  head.append(h('span', { class: 'dtitle' }, ev.kind === 'tool' ? `${ev.tool.display} ${ev.tool.summary}` : ev.kind));
  head.append(h('span', { class: 'dmeta' }, [fmtTime(ev.ts), ev.model, ev.kind === 'tool' && ev.tool.durationMs != null ? fmtMs(ev.tool.durationMs) : null].filter(Boolean).join(' · ')));
  const rawToggle = h('button', { class: 'mini', onclick: () => root.classList.toggle('show-raw') }, '{ } raw');
  head.append(h('span', { class: 'dactions' }, rawToggle));
  root.append(head);

  const body = h('div', { class: 'dbody' });
  root.append(body);
  const t = ev.tool;
  const resultText = detail?.resultText ?? ev.tool?.result?.text ?? '';
  const truncated = !detail && ev.tool?.result?.truncated;

  if (ev.kind === 'text') {
    body.append(section(['assistant', copyBtn(ev.text)], h('div', { class: 'md', html: markdown(ev.text) })));
  } else if (ev.kind === 'thinking') {
    body.append(section(['thinking', copyBtn(ev.text)], h('pre', { class: 'plain muted' }, ev.redacted ? '(redacted by the API)' : ev.text)));
  } else if (ev.kind === 'prompt') {
    body.append(section(['prompt', copyBtn(ev.text)], h('pre', { class: 'plain' }, ev.text)));
  } else if (ev.kind === 'tool') {
    const path = t.input.file_path || t.input.notebook_path || null;
    switch (t.name) {
      case 'Edit': {
        const ops = lineDiff(t.input.old_string ?? '', t.input.new_string ?? '');
        const start = detail?.toolUseResult?.structuredPatch?.[0]?.oldStart ?? t.meta?.structuredPatch?.[0]?.oldStart ?? 1;
        body.append(section([relPath(path, ctx.cwd), openBtn(path, start, ctx.api), copyBtn(t.input.new_string ?? '', 'copy new')],
          renderSideBySide(ops, { lang: langFor(path), startA: start, startB: detail?.toolUseResult?.structuredPatch?.[0]?.newStart ?? start })));
        if (t.input.replace_all) body.append(h('div', { class: 'note' }, 'replace_all'));
        break;
      }
      case 'MultiEdit': {
        for (const e of t.input.edits || []) body.append(section([relPath(path, ctx.cwd)], renderSideBySide(lineDiff(e.old_string ?? '', e.new_string ?? ''), { lang: langFor(path) })));
        break;
      }
      case 'Write': {
        body.append(section([relPath(path, ctx.cwd), openBtn(path, 1, ctx.api), copyBtn(t.input.content ?? '')], codeBlock(t.input.content ?? '', langFor(path))));
        break;
      }
      case 'Read': {
        const { text, start } = stripReadNumbers(resultText);
        body.append(section([relPath(path, ctx.cwd), openBtn(path, start, ctx.api), copyBtn(text), truncated ? h('span', { class: 'chip' }, 'loading full…') : null],
          t.result?.images?.length ? renderImages(ev, ctx) : codeBlock(text, langFor(path), { start })));
        break;
      }
      case 'Bash': {
        body.append(section(['command', copyBtn(t.input.command ?? '')], codeBlock(t.input.command ?? '', 'bash', { numbers: false })));
        if (t.input.description) body.append(h('div', { class: 'note' }, t.input.description));
        const r = detail?.toolUseResult;
        const stdout = r?.stdout ?? resultText; const stderr = r?.stderr ?? '';
        body.append(section([t.isError ? 'output (error)' : 'output', copyBtn(stdout), t.pending ? h('span', { class: 'chip pending' }, 'running…') : null, truncated ? h('span', { class: 'chip' }, 'loading full…') : null],
          h('pre', { class: 'plain out' + (t.isError ? ' err' : '') }, stdout || '(no output)')));
        if (stderr) body.append(section(['stderr'], h('pre', { class: 'plain out err' }, stderr)));
        if (r?.interrupted) body.append(h('div', { class: 'note err' }, 'interrupted'));
        break;
      }
      case 'Agent': {
        const card = h('div', { class: 'card' });
        card.append(h('div', { class: 'card-t' }, t.input.description || '(no description)'));
        card.append(h('div', { class: 'muted' }, [t.input.subagent_type || 'general-purpose', t.input.model, t.input.isolation ? `isolation: ${t.input.isolation}` : null, t.meta?.resolvedModel].filter(Boolean).join(' · ')));
        if (t.agentId) {
          card.append(h('div', { class: 'card-row' }, h('span', { class: `chip st-${ctx.agentStatus?.(t.agentId) || 'unknown'}` }, ctx.agentStatus?.(t.agentId) || 'unknown'),
            h('button', { class: 'mini', onclick: () => ctx.selectSession(t.agentId) }, '↗ open as session')));
        }
        body.append(section(['subagent'], card));
        body.append(section(['prompt', copyBtn(t.input.prompt ?? '')], h('details', {}, h('summary', {}, `${fmtTokens((t.input.prompt || '').length)} chars`), h('pre', { class: 'plain' }, t.input.prompt ?? ''))));
        body.append(section(['result'], h('pre', { class: 'plain' }, resultText || (t.pending ? '(running)' : '(none)'))));
        break;
      }
      default: {
        body.append(section(['input', copyBtn(() => JSON.stringify(t.input, null, 2))], h('pre', { class: 'plain' }, JSON.stringify(t.input, null, 2))));
        if (t.result?.images?.length) body.append(section(['images'], renderImages(ev, ctx)));
        if (resultText || !t.pending) body.append(section([t.isError ? 'result (error)' : 'result', copyBtn(resultText), truncated ? h('span', { class: 'chip' }, 'loading full…') : null],
          h('pre', { class: 'plain out' + (t.isError ? ' err' : '') }, resultText || '(empty)')));
        if (t.pending) body.append(h('div', { class: 'note' }, 'running…'));
      }
    }
    if (t.meta && Object.keys(t.meta).length) body.append(section(['result metadata'], h('details', {}, h('summary', {}, 'toolUseResult (slim)'), h('pre', { class: 'plain' }, JSON.stringify(t.meta, null, 2)))));
  } else {
    body.append(section([ev.subtype || ev.kind, copyBtn(ev.text ?? '')], h('pre', { class: 'plain' + (ev.error ? ' err' : '') }, ev.text ?? '')));
  }

  const rawPane = h('div', { class: 'raw' });
  rawPane.append(section(['raw records', copyBtn(() => JSON.stringify(detail?.raw ?? ev, null, 2))],
    h('pre', { class: 'plain' }, detail ? JSON.stringify(detail.raw, (k, v) => typeof v === 'string' && v.length > 20000 ? v.slice(0, 20000) + `…[${v.length}]` : v, 2) : JSON.stringify(ev, null, 2) + (detail === null ? '\n\n(loading full record…)' : ''))));
  root.append(rawPane);
  highlightIn(root);
  return root;
}

function renderImages(ev, ctx) {
  const wrap = h('div', { class: 'images' });
  for (const im of ev.tool.result.images) {
    const src = `/api/sessions/${encodeURIComponent(ev.sessionId)}/events/${encodeURIComponent(ev.id)}/image/${im.index}`;
    wrap.append(h('a', { href: src, target: '_blank' }, h('img', { src, alt: im.mediaType, title: `${im.mediaType} · ${fmtTokens(im.bytes)} b64 chars` })));
  }
  return wrap;
}

/** Details content for a file from the Files tab. */
export function renderFileDetails(file, ctx, highlightLine = null) {
  const root = h('div', { class: 'details' });
  root.append(h('div', { class: 'dhead' }, h('span', { class: 'ico' }, '📄'), h('span', { class: 'dtitle' }, relPath(file.path, ctx.cwd)),
    h('span', { class: 'dmeta' }, `${fmtTokens(file.size)} B${file.truncated ? ' · truncated' : ''}`),
    h('span', { class: 'dactions' }, openBtn(file.path, highlightLine || 1, ctx.api), copyBtn(file.content ?? ''))));
  const body = h('div', { class: 'dbody' });
  body.append(file.binary ? h('div', { class: 'note' }, 'binary file') : file.error ? h('div', { class: 'note err' }, file.error) : codeBlock(file.content ?? '', langFor(file.path)));
  root.append(body);
  highlightIn(root);
  return root;
}

/** Details content for a git diff from the Changes tab. */
export function renderDiffDetails(diff, ctx) {
  const root = h('div', { class: 'details' });
  const full = ctx.cwd && diff.file ? `${ctx.root || ctx.cwd}/${diff.file}` : diff.file;
  root.append(h('div', { class: 'dhead' }, h('span', { class: 'ico' }, '±'), h('span', { class: 'dtitle' }, diff.file || ''),
    h('span', { class: 'dmeta' }, diff.untracked ? 'untracked' : 'vs HEAD'), h('span', { class: 'dactions' }, openBtn(full, 1, ctx.api), copyBtn(diff.diff ?? ''))));
  const body = h('div', { class: 'dbody' });
  body.append(diff.diff ? renderSideBySide(parseUnified(diff.diff), { lang: langFor(diff.file) }) : h('div', { class: 'note' }, 'no diff'));
  root.append(body);
  return root;
}
