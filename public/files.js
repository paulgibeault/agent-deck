// public/files.js — the Files tab: a lazy, git-aware tree of the session's
// folder with find-as-you-type, and a details view that renders each kind of
// file the way it reads best (images, markdown, JSON, config, CSV, code…).
import { h, svgUse, ib, copyBtn, fmtTokens, ago, basename, markdown, codeBlock, langFor, highlightIn, headerFor, section } from './events.js';

// ------------------------------------------------------------ file kinds
const KINDS = {
  dir:      { icon: 'i-folder',   fam: 'dir',   label: 'Folder' },
  code:     { icon: 'i-code',     fam: 'code',  label: 'Code' },
  markdown: { icon: 'i-md',       fam: 'doc',   label: 'Markdown' },
  text:     { icon: 'i-file',     fam: 'doc',   label: 'Text' },
  json:     { icon: 'i-braces',   fam: 'conf',  label: 'JSON' },
  config:   { icon: 'i-gear',     fam: 'conf',  label: 'Config' },
  env:      { icon: 'i-gear',     fam: 'conf',  label: 'Environment' },
  csv:      { icon: 'i-table',    fam: 'data',  label: 'Table' },
  image:    { icon: 'i-image',    fam: 'media', label: 'Image' },
  svg:      { icon: 'i-image',    fam: 'media', label: 'SVG image' },
  pdf:      { icon: 'i-file',     fam: 'pdf',   label: 'PDF' },
  audio:    { icon: 'i-speaker',  fam: 'media', label: 'Audio' },
  video:    { icon: 'i-play',     fam: 'media', label: 'Video' },
  archive:  { icon: 'i-package',  fam: 'bin',   label: 'Archive' },
  binary:   { icon: 'i-file',     fam: 'bin',   label: 'Binary' },
};
const BY_EXT = {};
const add = (kind, exts) => { for (const e of exts.split(' ')) BY_EXT[e] = kind; };
add('image', 'png jpg jpeg gif webp avif bmp ico');
add('svg', 'svg');
add('pdf', 'pdf');
add('audio', 'mp3 wav ogg m4a flac');
add('video', 'mp4 webm mov');
add('markdown', 'md markdown mdx');
add('text', 'txt log text rst adoc');
add('json', 'json jsonc json5 webmanifest geojson');
add('config', 'yml yaml toml ini cfg conf properties lock plist editorconfig gitignore gitattributes npmrc nvmrc prettierrc eslintrc babelrc browserslistrc dockerignore');
add('csv', 'csv tsv');
add('archive', 'zip tar gz tgz bz2 xz 7z rar dmg jar');
add('binary', 'ttf otf woff woff2 eot exe dll so dylib o a class pyc wasm sqlite db bin dat psd sketch fig key pages numbers xlsx docx pptx');
const NAMES = { dockerfile: 'code', makefile: 'code', license: 'text', licence: 'text', readme: 'text', changelog: 'text', authors: 'text', procfile: 'config', gemfile: 'code', rakefile: 'code', '.env': 'env' };

export function fileKind(name, dir = false) {
  if (dir) return 'dir';
  const b = basename(name).toLowerCase();
  if (b === '.env' || b.startsWith('.env.') || b.endsWith('.env')) return 'env';
  if (NAMES[b]) return NAMES[b];
  const ext = b.includes('.') ? b.split('.').pop() : '';
  return BY_EXT[ext] || (langFor(b) ? 'code' : ext ? 'text' : 'text');
}
const MEDIA = new Set(['image', 'svg', 'pdf', 'audio', 'video']);
const glyph = (kind, open = false) => h('span', { class: `fi fk-${KINDS[kind].fam}` }, svgUse(kind === 'dir' && open ? 'i-folder-open' : KINDS[kind].icon, 15));
const rawUrl = (abs) => `/api/file/raw?path=${encodeURIComponent(abs)}`;
const GIT = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'untracked' };

// ------------------------------------------------------------ fuzzy find
/** Subsequence match, favouring the file name, segment starts and runs. */
export function fuzzy(q, path) {
  const s = path.toLowerCase(); const base = s.lastIndexOf('/') + 1;
  let qi = 0, score = 0, run = 0; const hits = [];
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) { run = 0; continue; }
    hits.push(i); qi++; run++;
    score += 1 + run * 2 + (i >= base ? 3 : 0) + (i === 0 || '/._-'.includes(s[i - 1]) ? 4 : 0);
  }
  if (qi < q.length) return null;
  return { score: score - s.length * 0.05, hits };
}
function marked(text, hits, offset) {
  const out = []; let last = 0;
  for (const i of hits) {
    const j = i - offset; if (j < 0 || j >= text.length) continue;
    if (j > last) out.push(text.slice(last, j));
    out.push(h('mark', {}, text[j])); last = j + 1;
  }
  out.push(text.slice(last));
  return out;
}

// ------------------------------------------------------------ the tree
/**
 * The Files tab. `api` fetches; `onOpen({ rel, abs, entry })` shows a file;
 * folders only open and close in place. `openEditor(abs, line)`.
 */
export function createFilesView({ list, crumbs, find, api, onOpen, openEditor, onCount }) {
  const st = {
    sid: null, root: null, cwd: null, expanded: new Set(), cache: new Map(), loading: new Map(),
    selected: null, rows: [], all: null, query: '', mode: 'tree', ignored: false,
    touched: new Map(), touchedDirs: new Set(), outside: [], results: [],
  };
  const key = () => `deck.files:${st.cwd}`;
  const save = () => { try { localStorage.setItem(key(), JSON.stringify({ expanded: [...st.expanded], selected: st.selected, mode: st.mode, ignored: st.ignored })); } catch { /* full */ } };
  const abs = (rel) => rel ? `${st.root || st.cwd}/${rel}` : (st.root || st.cwd);

  async function loadDir(rel) {
    if (st.cache.has(rel)) return st.cache.get(rel);
    if (st.loading.has(rel)) return st.loading.get(rel);
    const sid = st.sid;
    const p = api.get(`/api/sessions/${encodeURIComponent(sid)}/tree?dir=${encodeURIComponent(rel)}`).then((r) => {
      if (st.sid !== sid) return null;
      st.root = r.root; st.cache.set(rel, r.entries); st.loading.delete(rel);
      return r.entries;
    }).catch((e) => { st.loading.delete(rel); st.cache.set(rel, { error: e.message }); return null; });
    st.loading.set(rel, p);
    return p;
  }

  /** Point the view at a session; keeps state when it's the same one. */
  async function show(sid, cwd, touchedList = []) {
    if (st.sid !== sid) {
      Object.assign(st, { sid, cwd, root: null, cache: new Map(), loading: new Map(), all: null, query: '', results: [] });
      find.value = '';
      let saved = {}; try { saved = JSON.parse(localStorage.getItem(key()) || '{}'); } catch { /* ignore */ }
      st.expanded = new Set(saved.expanded || []); st.selected = saved.selected || null;
      st.mode = saved.mode || 'tree'; st.ignored = !!saved.ignored;
    }
    if (!cwd) { setTouched(touchedList); list.replaceChildren(h('div', { class: 'pad muted' }, 'This session has no folder.')); crumbs.replaceChildren(); return; }
    await loadDir('');
    setTouched(touchedList); // after the first listing: it knows the real root
    render();
  }
  function refresh() {
    st.cache = new Map(); st.loading = new Map(); st.all = null;
    return loadDir('').then(() => Promise.all([...st.expanded].map(loadDir))).then(render);
  }
  function setTouched(files) {
    st.touched = new Map(); st.touchedDirs = new Set(); st.outside = [];
    const base = (st.root || st.cwd || '') + '/';
    for (const f of files) {
      if (st.cwd && f.path.startsWith(base)) {
        const rel = f.path.slice(base.length);
        st.touched.set(rel, f);
        for (let d = rel.lastIndexOf('/'); d > 0; d = rel.lastIndexOf('/', d - 1)) st.touchedDirs.add(rel.slice(0, d));
      } else st.outside.push(f);
    }
    onCount?.(files.length);
  }

  // ---- flatten to visible rows
  function flatten() {
    const rows = [];
    if (st.mode === 'touched') {
      // A tree built from just the files this session read or wrote, all open.
      const kids = new Map([['', new Map()]]);
      for (const rel of st.touched.keys()) {
        const parts = rel.split('/'); let dir = '';
        parts.forEach((name, i) => {
          const path = dir ? `${dir}/${name}` : name; const isDir = i < parts.length - 1;
          if (!kids.get(dir).has(name)) kids.get(dir).set(name, { name, path, dir: isDir });
          if (isDir && !kids.has(path)) kids.set(path, new Map());
          dir = path;
        });
      }
      const walk = (dir, depth) => {
        const es = [...kids.get(dir).values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const e of es) { rows.push({ e, depth, open: e.dir }); if (e.dir) walk(e.path, depth + 1); }
      };
      walk('', 0);
      if (st.outside.length) {
        rows.push({ group: 'Outside this folder', depth: 0 });
        for (const f of st.outside) rows.push({ e: { name: f.path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~'), path: f.path, dir: false, outside: true }, depth: 0 });
      }
      return rows;
    }
    const walk = (rel, depth) => {
      const es = st.cache.get(rel);
      if (!es) { rows.push({ loading: true, depth }); loadDir(rel).then(render); return; }
      if (es.error) { rows.push({ error: es.error, depth }); return; }
      for (const e of es) {
        if (e.ignored && !st.ignored) continue;
        const open = e.dir && st.expanded.has(e.path);
        rows.push({ e, depth, open });
        if (open) walk(e.path, depth + 1);
      }
      if (!es.length && depth) rows.push({ empty: true, depth });
    };
    walk('', 0);
    return rows;
  }

  // ---- render
  function rowEl(r, i) {
    if (r.loading || r.error || r.empty || r.group) {
      return h('div', { class: `frow note${r.group ? ' grp' : ''}`, style: `--d:${r.depth}` }, h('span', { class: 'ind' }),
        r.group || (r.loading ? 'loading…' : r.error ? r.error : 'empty'));
    }
    const e = r.e; const kind = fileKind(e.name, e.dir);
    const t = e.dir ? null : st.touched.get(e.path) || (e.outside ? st.outside.find(f => f.path === e.path) : null);
    const sel = st.selected === e.path;
    const row = h('div', {
      class: `frow${sel ? ' sel' : ''}${e.ignored ? ' ign' : ''}${e.dir ? ' dir' : ''}`, role: 'treeitem', id: `fr-${i}`,
      'aria-level': r.depth + 1, 'aria-selected': String(sel), 'aria-expanded': e.dir ? String(!!r.open) : null,
      style: `--d:${r.depth}`, dataset: { i },
      title: e.dir ? e.path || e.name : [e.path, e.size != null ? fmtTokens(e.size) + 'B' : '', e.mtime ? 'modified ' + ago(Date.now() - e.mtime) + ' ago' : ''].filter(Boolean).join(' · '),
    });
    row.append(h('span', { class: 'ind' }), h('span', { class: 'twist' }, e.dir ? svgUse('i-right', 9) : null), glyph(kind, r.open));
    const name = h('span', { class: 'fname' }, e.name);
    if (e.link) name.append(h('span', { class: 'flink', title: 'symbolic link' }, ' ↪'));
    row.append(name, h('span', { class: 'fsp' }));
    if (!e.dir && e.size != null) row.append(h('span', { class: 'fsz' }, fmtTokens(e.size) + 'B'));
    if (t) row.append(h('span', { class: `ftouch ${t.writes ? 'w' : 'r'}`, title: [t.reads ? `read ${t.reads}×` : '', t.writes ? `wrote ${t.writes}×` : '', t.lastTs ? ago(Date.now() - Date.parse(t.lastTs)) + ' ago' : ''].filter(Boolean).join(' · ') }));
    else if (e.dir && st.touchedDirs.has(e.path) && !r.open) row.append(h('span', { class: 'ftouch dimr', title: 'this session touched files in here' }));
    if (e.git) row.append(h('span', { class: `fgit g-${e.git}`, title: e.dir ? 'has changes' : GIT[e.git] }, e.dir ? '•' : e.git));
    return row;
  }
  function render() {
    renderCrumbs();
    if (st.query) return renderResults();
    st.rows = flatten();
    list.setAttribute('role', 'tree');
    list.replaceChildren(...st.rows.map(rowEl));
    if (!st.rows.length) list.append(h('div', { class: 'pad muted' }, st.mode === 'touched' ? 'This session hasn’t read or written any files yet.' : 'Empty folder.'));
    const i = st.rows.findIndex(r => r.e?.path === st.selected);
    if (i >= 0) list.setAttribute('aria-activedescendant', `fr-${i}`);
  }
  function renderCrumbs() {
    const name = basename(st.root || st.cwd || '');
    const parts = st.selected && st.mode === 'tree' && !st.selected.startsWith('/') ? st.selected.split('/') : [];
    const out = [h('button', { type: 'button', class: 'crumb root', title: st.root || st.cwd, onclick: () => { st.selected = null; collapseAll(); } }, svgUse('i-folder', 12), h('span', {}, name))];
    parts.forEach((p, i) => {
      const rel = parts.slice(0, i + 1).join('/');
      out.push(h('span', { class: 'csep' }, '›'), h('button', { type: 'button', class: 'crumb', title: rel, onclick: () => reveal(rel, { open: true }) }, p));
    });
    crumbs.replaceChildren(...out);
  }
  function renderResults() {
    const q = st.query.toLowerCase().replace(/\s+/g, '');
    const scored = [];
    for (const p of st.all || []) { const m = fuzzy(q, p); if (m) scored.push({ p, ...m }); }
    scored.sort((a, b) => b.score - a.score);
    st.results = scored.slice(0, 200);
    list.setAttribute('role', 'listbox');
    if (!st.all) { list.replaceChildren(h('div', { class: 'pad muted' }, 'indexing…')); return; }
    if (!st.results.length) { list.replaceChildren(h('div', { class: 'pad muted' }, 'No files match.')); return; }
    st.rsel = Math.min(st.rsel || 0, st.results.length - 1);
    list.replaceChildren(...st.results.map((r, i) => {
      const cut = r.p.lastIndexOf('/') + 1; const dir = r.p.slice(0, cut);
      return h('div', { class: `frow res${i === st.rsel ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === st.rsel), dataset: { r: i }, title: r.p },
        glyph(fileKind(r.p)), h('span', { class: 'fname' }, ...marked(r.p.slice(cut), r.hits, cut)), h('span', { class: 'fdir' }, ...marked(dir.replace(/\/$/, ''), r.hits, 0)));
    }));
    list.querySelector('.res.sel')?.scrollIntoView({ block: 'nearest' });
  }

  // ---- actions
  let openTimer = null;
  function select(path, { open = false, now = false } = {}) {
    st.selected = path; save();
    render();
    list.querySelector('.frow.sel')?.scrollIntoView({ block: 'nearest' });
    if (!open) return;
    clearTimeout(openTimer);
    const go = () => openSelected();
    now ? go() : (openTimer = setTimeout(go, 140));
  }
  function openSelected() {
    const r = st.rows.find(x => x.e?.path === st.selected); if (!r) return;
    const e = r.e;
    if (!e.dir) onOpen?.({ rel: e.outside ? null : e.path, abs: e.outside ? e.path : abs(e.path), entry: e });
  }
  async function toggle(path, force) {
    const open = force ?? !st.expanded.has(path);
    if (open) { st.expanded.add(path); await loadDir(path); } else st.expanded.delete(path);
    save(); render();
  }
  function collapseAll() { st.expanded.clear(); save(); render(); }
  /** Expand down to `rel`, select it, show it. */
  async function reveal(rel, { open = false } = {}) {
    if (st.mode !== 'tree') { st.mode = 'tree'; }
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); st.expanded.add(d); await loadDir(d); }
    st.query = ''; find.value = '';
    await loadDir(parts.length > 1 ? parts.slice(0, -1).join('/') : '');
    select(rel, { open, now: true });
    list.focus();
  }
  function setMode(m) { st.mode = m; save(); render(); list.scrollTop = 0; }
  function setIgnored(on) { st.ignored = on; save(); render(); }
  async function setQuery(q) {
    st.query = q.trim(); st.rsel = 0;
    if (st.query && !st.all) {
      render();
      const sid = st.sid;
      const r = await api.get(`/api/sessions/${encodeURIComponent(sid)}/tree?all=1`).catch(() => ({ files: [] }));
      if (st.sid !== sid) return;
      st.all = r.files || [];
    }
    render();
  }

  // ---- input
  list.addEventListener('click', (ev) => {
    const res = ev.target.closest('.res');
    if (res) return reveal(st.results[+res.dataset.r].p, { open: true });
    const row = ev.target.closest('.frow[data-i]'); if (!row) return;
    const r = st.rows[+row.dataset.i];
    // A folder click opens or closes it in place; a file shows in Details.
    if (r.e.dir) { if (st.mode === 'tree') toggle(r.e.path); select(r.e.path); }
    else select(r.e.path, { open: true, now: true });
  });
  list.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('.frow[data-i]'); if (!row) return;
    const e = st.rows[+row.dataset.i].e; if (!e.dir) openEditor(abs(e.path), 1);
  });
  function onKey(ev) {
    if (st.query) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); st.rsel = Math.max(0, Math.min(st.results.length - 1, (st.rsel || 0) + (ev.key === 'ArrowDown' ? 1 : -1))); renderResults(); }
      else if (ev.key === 'Enter' && st.results[st.rsel || 0]) { ev.preventDefault(); reveal(st.results[st.rsel || 0].p, { open: true }); }
      else if (ev.key === 'Escape') { ev.preventDefault(); find.value = ''; setQuery(''); list.focus(); }
      return;
    }
    const items = st.rows.map((r, i) => [r, i]).filter(([r]) => r.e);
    let k = items.findIndex(([r]) => r.e.path === st.selected);
    const cur = k >= 0 ? items[k][0] : null;
    const move = (to) => { const it = items[Math.max(0, Math.min(items.length - 1, to))]; if (it) select(it[0].e.path, { open: true }); };
    switch (ev.key) {
      case 'ArrowDown': move(k + 1); break;
      case 'ArrowUp': move(k < 0 ? items.length - 1 : k - 1); break;
      case 'Home': move(0); break;
      case 'End': move(items.length - 1); break;
      case 'ArrowRight':
        if (cur?.e.dir && !cur.open && st.mode === 'tree') toggle(cur.e.path, true);
        else if (cur?.e.dir) move(k + 1);
        break;
      case 'ArrowLeft':
        if (cur?.e.dir && cur.open && st.mode === 'tree') toggle(cur.e.path, false);
        else if (cur) { const parent = cur.e.path.includes('/') ? cur.e.path.slice(0, cur.e.path.lastIndexOf('/')) : null; if (parent) select(parent, { open: true }); }
        break;
      case 'Enter':
        if (cur?.e.dir) toggle(cur.e.path); else if (cur) openSelected();
        break;
      case 'e': if (cur && !cur.e.dir) openEditor(abs(cur.e.path), 1); break;
      default: return;
    }
    ev.preventDefault(); ev.stopPropagation();
  }
  list.addEventListener('keydown', onKey);
  find.addEventListener('input', () => setQuery(find.value));
  find.addEventListener('keydown', (ev) => { if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(ev.key)) { onKey(ev); ev.stopPropagation(); } });

  return { show, refresh, reveal, setMode, setIgnored, collapseAll, get mode() { return st.mode; }, get ignored() { return st.ignored; }, get root() { return st.root || st.cwd; }, get touched() { return st.touched; } };
}

// ------------------------------------------------------------ file details
const trimNl = (s) => s.endsWith('\n') ? s.slice(0, -1) : s;
const lineCount = (s) => s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;

/** A two-way view switch (Rendered / Source …) for the details header. */
function viewSwitch(views, initial, onPick) {
  const seg = h('div', { class: 'seg sm', role: 'group', 'aria-label': 'View' });
  for (const [k, label] of views) seg.append(h('button', { type: 'button', 'aria-pressed': String(k === initial), dataset: { v: k }, onclick: () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === k)); onPick(k); } }, label));
  return seg;
}

function parseCsv(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; if (rows.length > 2000) break; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Markdown with images and relative links resolved against the file's folder. */
function markdownView(text, file, ctx, { outline = true } = {}) {
  const dir = file.abs.slice(0, file.abs.lastIndexOf('/'));
  const resolve = (href) => {
    if (/^(https?:|data:|mailto:|#)/.test(href)) return null;
    const parts = (href.startsWith('/') ? (ctx.root || dir) + href : `${dir}/${href}`).split('/');
    const out = []; for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
    return out.join('/').split('#')[0];
  };
  const doc = h('div', { class: 'md fileview', html: markdown(text, { soft: true, html: true, img: (src) => { const a = resolve(src); return a ? rawUrl(a) : null; }, link: resolve }) });
  const wrap = h('div', { class: 'md-wrap' });
  // An outline for longer documents: the headings, as a jump list.
  const heads = [...doc.querySelectorAll('h1[id], h2[id], h3[id]')];
  if (outline && heads.length >= 4) {
    const top = Math.min(...heads.map(x => +x.tagName[1]));
    wrap.append(h('details', { class: 'md-outline' }, h('summary', {}, svgUse('i-list', 12), h('span', {}, 'Outline'), h('span', { class: 'n' }, heads.length)),
      h('nav', {}, ...heads.map(x => h('a', { href: '#', dataset: { anchor: x.id }, class: `lv${+x.tagName[1] - top}` }, x.textContent)))));
  }
  wrap.append(doc);
  wrap.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-abs], a[data-anchor]'); if (!a) return;
    e.preventDefault();
    if (a.dataset.abs) return ctx.openPath?.(a.dataset.abs);
    const target = doc.querySelector(`[id="${CSS.escape(a.dataset.anchor)}"]`);
    if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  });
  return wrap;
}

/** The Details pane for a file from the Files tab. */
export function renderFileView(file, ctx) {
  const kind = fileKind(file.abs);
  const k = KINDS[kind];
  const root = h('div', { class: 'details fileview-d' });
  const text = file.content ?? '';
  const meta = [file.size != null ? fmtTokens(file.size) + 'B' : null, !MEDIA.has(kind) && text ? `${lineCount(text)} lines` : null,
    file.mtime ? `modified ${ago(Date.now() - file.mtime)} ago` : null, file.git ? GIT[file.git] : null, file.truncated ? 'first 2 MB' : null];
  const body = h('div', { class: 'dbody' });
  const lang = langFor(file.abs);
  const label = kind === 'code' && lang ? lang[0].toUpperCase() + lang.slice(1) : k.label;
  let views = null; let current = null;
  const views$ = {};
  const pane = h('div', { class: 'fv-pane' });
  const show = (v) => { current = v; pane.replaceChildren(views$[v]()); highlightIn(pane); };

  if (file.error) views$.main = () => h('div', { class: 'note err' }, file.error);
  else if (kind === 'image' || kind === 'svg') {
    views$.main = () => {
      const img = h('img', { src: rawUrl(file.abs), alt: basename(file.abs), class: `fit${kind === 'svg' ? ' vec' : ''}`, loading: 'lazy' });
      img.onload = () => { const d = root.querySelector('.dmeta'); if (d && img.naturalWidth) d.prepend(h('span', {}, `${img.naturalWidth}×${img.naturalHeight}`)); };
      img.onclick = () => img.classList.toggle('fit');
      return h('div', { class: 'fv-img', title: 'Click to toggle actual size' }, img);
    };
    if (kind === 'svg' && file.content != null) { views = [['main', 'Image'], ['src', 'Source']]; views$.src = () => codeBlock(trimNl(text), 'xml'); }
  } else if (kind === 'pdf') views$.main = () => h('iframe', { class: 'fv-pdf', src: rawUrl(file.abs), title: basename(file.abs) });
  else if (kind === 'audio') views$.main = () => h('audio', { controls: true, src: rawUrl(file.abs), class: 'fv-media' });
  else if (kind === 'video') views$.main = () => h('video', { controls: true, src: rawUrl(file.abs), class: 'fv-media' });
  else if (file.binary || kind === 'archive' || kind === 'binary') views$.main = () => h('div', { class: 'fv-bin' }, glyph(kind), h('div', {}, h('b', {}, `${k.label} file`), h('div', { class: 'muted' }, 'Not shown here. Open it in its own app.')));
  else if (kind === 'markdown') { views = [['main', 'Rendered'], ['src', 'Source']]; views$.main = () => markdownView(text, file, ctx); views$.src = () => codeBlock(trimNl(text), 'markdown'); }
  else if (kind === 'json') {
    let pretty = null, err = null;
    try { pretty = JSON.stringify(JSON.parse(text.replace(/^﻿/, '')), null, 2); } catch (e) { err = e.message; }
    if (pretty && pretty !== text.trimEnd()) { views = [['main', 'Formatted'], ['src', 'Raw']]; views$.src = () => codeBlock(trimNl(text), 'json'); }
    views$.main = () => h('div', {}, err ? h('div', { class: 'note' }, `Not strict JSON (${err}); shown as written.`) : null, codeBlock(pretty ?? text, 'json'));
  } else if (kind === 'csv') {
    const sep = /\.tsv$/i.test(file.abs) ? '\t' : ',';
    views = [['main', 'Table'], ['src', 'Source']];
    views$.main = () => {
      const rows = parseCsv(text, sep); const [head = [], ...rest] = rows;
      return h('div', { class: 'fv-table' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'n' }, ''), ...head.map(c => h('th', {}, c)))),
        h('tbody', {}, ...rest.slice(0, 1000).map((r, i) => h('tr', {}, h('td', { class: 'n' }, i + 1), ...r.map(c => h('td', { title: c.length > 40 ? c : null }, c)))))),
        rest.length > 1000 ? h('div', { class: 'note' }, `First 1,000 of ${rest.length} rows`) : null);
    };
    views$.src = () => codeBlock(trimNl(text), null);
  } else if (kind === 'env') {
    // Secrets stay masked until asked for.
    views = [['main', 'Masked'], ['src', 'Revealed']];
    views$.main = () => codeBlock(trimNl(text).replace(/^(\s*(?:export\s+)?[\w.-]+\s*=\s*)(.+)$/gm, (_, k2, v) => k2 + '•'.repeat(Math.min(12, Math.max(4, v.length)))), 'bash');
    views$.src = () => codeBlock(trimNl(text), 'bash');
  } else {
    const cl = kind === 'config' ? (/\.(ya?ml|lock)$/i.test(file.abs) ? 'yaml' : /\.(toml|ini|cfg|conf|properties|editorconfig)$/i.test(file.abs) ? 'ini' : /\.plist$/i.test(file.abs) ? 'xml' : 'bash') : lang;
    views$.main = () => codeBlock(trimNl(text), cl, { numbers: kind !== 'text' || lineCount(text) > 1 });
  }

  const actions = [
    views ? viewSwitch(views, 'main', show) : null,
    ib('i-link', 'Copy path', (e) => { navigator.clipboard?.writeText(file.abs); e.currentTarget.classList.add('done'); }, { size: 14 }),
    !MEDIA.has(kind) && file.content != null ? copyBtn(() => text, 'Copy contents') : null,
    ctx.api ? ib('i-open', 'Open in editor', () => ctx.api.openEditor(file.abs, 1), { size: 14 }) : null,
  ];
  const tag = h('span', { class: 'tic lab' }, glyph(kind), h('span', {}, label));
  root.append(headerFor({ tag, title: file.rel || file.abs.replace(/^\/Users\/[^/]+/, '~'), nav: false, meta, actions }));
  body.append(section('Contents', { ask: file.content ? { kind: 'text', label: `File ${file.rel || basename(file.abs)}`, text: text.slice(0, 200_000), what: 'this file' } : null }, pane));
  root.append(body);
  show('main');
  return root;
}
