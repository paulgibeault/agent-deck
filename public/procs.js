// public/procs.js — the process view: a task manager for the deck. The list is
// a tree of the processes the deck, its sessions and their tool calls run (or
// every process on the host), from /api/procs (lib/procs.mjs); picking one
// shows what is known about it in tabs, with controls to signal it. It only
// polls while the dialog is open.
import { h, ib, svgUse, ago, fmtMs, oneLine, codeBlock, copyBtn, section } from './events.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const SPARK_N = 60;

export const fmtBytes = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(n < 10 << 20 ? 1 : 0)} MB` : `${(n / (1 << 30)).toFixed(1)} GB`;
const fmtCpu = (c) => c == null ? '' : c < 0.05 ? '0' : c < 10 ? c.toFixed(1) : String(Math.round(c));
const fmtUp = (start, now = Date.now()) => start ? fmtMs(Math.max(0, now - start)).replace(/(\d+)m(\d+)s/, (_, m, s) => +m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${s}s`) : '';

// What each kind of process is, by glyph and words.
const KIND = {
  deck: { icon: 'i-logo', what: 'The agent-deck server' },
  session: { icon: 'i-agent', what: 'A Claude Code session' },
  subagent: { icon: 'i-agent', what: 'A subagent. It runs inside its session’s process, so it has no pid of its own.' },
  task: { icon: 'i-bg', what: 'A background task' },
  tool: { icon: 'i-shell', what: 'A Bash call in progress' },
  bash: { icon: 'i-shell', what: 'A command Claude ran' },
  shell: { icon: 'i-term', what: 'A command from the deck’s Shell tab' },
  model: { icon: 'i-star', what: 'One of the deck’s own claude calls (brief, ask or quota)' },
  mcp: { icon: 'i-plug', what: 'An MCP server the session started' },
};
const STATE = { R: 'running', S: 'sleeping', I: 'idle', T: 'stopped', Z: 'zombie', U: 'waiting on I/O', D: 'waiting on I/O' };
const FLAGS = { '+': 'foreground', s: 'session leader', '<': 'high priority', N: 'low priority', L: 'pages locked', X: 'being traced' };
export const stateText = (s) => [STATE[s?.[0]] || s?.[0] || '?', ...[...(s || '').slice(1)].map(f => FLAGS[f]).filter(Boolean)].join(' · ');
/**
 * Put `nodes` into `parent`, keeping every existing node that is unchanged.
 * The view re-renders every poll; replacing a node the pointer rests on would
 * cancel its tooltip before it shows. Same-tag nodes with the same attributes
 * are patched in place, `depth` levels down.
 */
function patch(parent, nodes, depth = 4) {
  const old = [...parent.childNodes];
  nodes.forEach((n, i) => {
    const o = old[i];
    if (!o) { parent.append(n); return; }
    if (o.isEqualNode(n)) return;
    if (depth > 0 && o.nodeType === 1 && n.nodeType === 1 && o.tagName === n.tagName && sameAttrs(o, n)) { patch(o, [...n.childNodes], depth - 1); return; }
    o.replaceWith(n);
  });
  for (let i = nodes.length; i < old.length; i++) old[i].remove();
}
function sameAttrs(a, b) {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const x of a.attributes) if (b.getAttribute(x.name) !== x.value) return false;
  return true;
}
const SECRET = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|COOKIE|SESSION|PRIVATE|SIGN/i;

const SIG = {
  STOP: { label: 'Pause', desc: 'SIGSTOP: freeze it until resumed', icon: 'i-pause' },
  CONT: { label: 'Resume', desc: 'SIGCONT: continue a paused process', icon: 'i-play' },
  INT: { label: 'Interrupt', desc: 'SIGINT: like Ctrl-C', icon: 'i-hand' },
  HUP: { label: 'Hang up', desc: 'SIGHUP: many daemons reload on it; others end', icon: 'i-refresh' },
  TERM: { label: 'Terminate', desc: 'SIGTERM: ask it to end', icon: 'i-stop' },
  KILL: { label: 'Force kill', desc: 'SIGKILL: end it now, no cleanup', icon: 'i-bolt' },
};

/**
 * ctx: { api, toast, confirm(title, body, ok), openSession(id), openTask(sessionId, taskId),
 *        openCall(sessionId, toolUseId), runInShell(cmd, cwd), openEditor(path) }
 */
export function createProcView(ctx) {
  const dlg = $('procs');
  const pm = {
    scope: 'agents', q: '', live: true, timer: null,
    data: null, nodes: new Map(), kids: new Map(), rows: [],
    sel: null, detail: null, detailFor: null, tab: 'overview',
    open: new Set(), shut: new Set(), hist: new Map(), tree: false, reveal: false, fq: '',
    busy: false,
  };

  // ---------------------------------------------------------- data
  async function load() {
    try {
      const d = await ctx.api.get(`/api/procs?scope=${pm.scope}`);
      pm.data = d; pm.err = null;
      for (const n of d.nodes) {
        const hs = pm.hist.get(n.pid) || []; hs.push({ cpu: n.cpu, rss: n.rss });
        if (hs.length > SPARK_N) hs.shift();
        pm.hist.set(n.pid, hs);
      }
    } catch (e) { pm.err = e.message; }
    index(); renderList();
    if (pm.sel != null && !String(pm.sel).startsWith('agent:')) await loadDetail();
    else renderDetail();
  }
  async function loadDetail() {
    const pid = pm.sel;
    try {
      const d = await ctx.api.get(`/api/procs/${pid}`);
      if (pm.sel !== pid) return;
      pm.detail = d; pm.detailFor = pid; pm.gone = false;
    } catch (e) { if (pm.sel === pid) { pm.gone = true; pm.detailErr = e.message; } }
    renderDetail();
  }
  function schedule() {
    clearTimeout(pm.timer);
    if (!dlg.open || !pm.live) return;
    pm.timer = setTimeout(async () => { if (document.visibilityState === 'visible') await load(); schedule(); }, POLL_MS);
  }

  // ---------------------------------------------------------- tree
  const keyOf = (n) => n.virtual ? n.id : n.pid;
  function index() {
    pm.nodes = new Map(); pm.kids = new Map();
    if (!pm.data) return;
    for (const n of [...pm.data.nodes, ...pm.data.virtual]) pm.nodes.set(keyOf(n), n);
    for (const n of pm.nodes.values()) {
      const parent = pm.nodes.has(n.ppid) && n.ppid !== n.pid ? n.ppid : 'root';
      if (!pm.kids.has(parent)) pm.kids.set(parent, []);
      pm.kids.get(parent).push(keyOf(n));
    }
    const rank = (n) => ({ deck: 0, session: 1, shell: 2, task: 3, tool: 4, subagent: 5 }[n.tag?.kind] ?? 9);
    for (const list of pm.kids.values()) list.sort((a, b) => { const x = pm.nodes.get(a), y = pm.nodes.get(b); return rank(x) - rank(y) || (x.start || 0) - (y.start || 0) || String(a).localeCompare(String(b)); });
  }
  const hasScopeBelow = (k, n = 0) => n < 64 && (pm.kids.get(k) || []).some(c => pm.nodes.get(c)?.scope || pm.nodes.get(c)?.virtual || hasScopeBelow(c, n + 1));
  function isOpen(k) {
    if (pm.open.has(k)) return true;
    if (pm.shut.has(k)) return false;
    if (pm.scope === 'agents') return true;
    const n = pm.nodes.get(k);
    return n?.pid <= 1 || !!n?.scope || hasScopeBelow(k);
  }
  const textOf = (n) => `${n.pid ?? ''} ${n.name || ''} ${n.args || ''} ${n.tag?.label || ''} ${n.user || ''}`.toLowerCase();
  function visibleRows() {
    const rows = [];
    const q = pm.q.trim().toLowerCase();
    let keep = null;
    if (q) {
      keep = new Set();
      for (const [k, n] of pm.nodes) {
        if (!textOf(n).includes(q)) continue;
        keep.add(k);
        for (let p = n.ppid, i = 0; pm.nodes.has(p) && i < 64; p = pm.nodes.get(p).ppid, i++) keep.add(p);
      }
    }
    const walk = (k, depth) => {
      const n = pm.nodes.get(k);
      if (keep && !keep.has(k)) return;
      const kids = (pm.kids.get(k) || []).filter(c => !keep || keep.has(c));
      const open = q ? true : isOpen(k);
      rows.push({ k, n, depth, kids: kids.length, open, hit: q ? textOf(n).includes(q) : true });
      if (open) for (const c of kids) walk(c, depth + 1);
    };
    for (const k of pm.kids.get('root') || []) walk(k, 0);
    return rows;
  }

  // ---------------------------------------------------------- list
  function nodeTitle(n) { return n.tag && n.tag.kind !== 'deck' ? n.tag.label : n.name; }
  function glyph(n) {
    const k = KIND[n.tag?.kind];
    return h('span', { class: `pm-g k-${n.tag?.kind || 'none'}${n.tag?.detached ? ' detached' : ''}`, title: k?.what || '' }, k ? svgUse(k.icon, 13) : null);
  }
  function renderList() {
    const list = $('pm-list');
    const scrollTop = list.scrollTop;
    if (pm.err && !pm.data) {
      // The page is newer than the server it talks to: the route is not there yet.
      const stale = pm.err === 'not found';
      list.replaceChildren(h('div', { class: 'muted pm-empty' },
        h('p', {}, stale ? 'The running backend started before the process view existed. Restart it to load it.' : pm.err),
        stale && ctx.restart ? h('button', { type: 'button', class: 'btn sm', onclick: () => { dlg.close(); ctx.restart(); } }, 'Restart the backend…') : null));
      return;
    }
    pm.rows = visibleRows();
    const d = pm.data;
    $('pm-n').textContent = d ? (pm.scope === 'all' ? `${d.nodes.length}` : `${d.nodes.length} of ${d.total}`) : '';
    $('pm-n').title = d ? `${d.nodes.length} processes${pm.scope === 'all' ? ' on this host' : ` belong to the deck and its sessions, of ${d.total} on this host`} · updated ${new Date(d.at).toLocaleTimeString()}` : '';
    const now = Date.now();
    const out = pm.rows.map(({ k, n, depth, kids, open, hit }) => {
      const stopped = n.state?.[0] === 'T';
      const label = nodeTitle(n);
      const sub = n.virtual ? n.name : n.tag && n.tag.kind !== 'deck' ? n.name : oneLine(n.args.replace(/^\S*\//, ''), 120);
      return h('div', {
        class: `pm-row${k === pm.sel ? ' sel' : ''}${hit ? '' : ' ctx'}${n.virtual ? ' virt' : ''}${pm.scope === 'all' && n.scope ? ' ours' : ''}${n.pid === d.self ? ' self' : ''}`,
        role: 'treeitem', 'aria-level': String(depth + 1), 'aria-selected': String(k === pm.sel), 'aria-expanded': kids ? String(open) : null,
        dataset: { k: String(k) }, title: n.args || n.tag?.label || '',
      },
      h('span', { class: 'pm-name', style: `padding-left:${depth * 14}px` },
        kids ? h('button', { type: 'button', class: `pm-tw${open ? ' open' : ''}`, tabindex: '-1', 'aria-label': open ? 'Collapse' : 'Expand', title: open ? 'Hide what runs below it (←)' : 'Show what runs below it (→)', dataset: { tw: String(k) } }, svgUse('i-right', 9)) : h('span', { class: 'pm-tw' }),
        glyph(n),
        h('span', { class: 'pm-t' }, label), sub && sub !== label ? h('span', { class: 'pm-sub' }, sub) : null,
        stopped ? h('span', { class: 'pm-flag', title: 'Paused (stopped)' }, svgUse('i-pause', 10)) : null,
        !open && kids ? h('span', { class: 'pm-kc', title: `${kids} hidden` }, String(kids)) : null),
      h('span', { class: 'num' }, n.virtual ? '' : String(n.pid)),
      h('span', { class: `num${n.cpu >= 50 ? ' hot' : n.cpu >= 5 ? ' warm' : ''}` }, n.virtual ? '' : fmtCpu(n.cpu)),
      h('span', { class: 'num' }, n.virtual ? '' : fmtBytes(n.rss)),
      h('span', { class: 'num' }, n.virtual ? '' : fmtUp(n.start, now)));
    });
    if (!out.length) out.push(h('p', { class: 'muted pm-empty' }, pm.q ? `No process matches “${pm.q}”.` : pm.err || 'Nothing running.'));
    patch(list, out);
    list.scrollTop = scrollTop;
  }
  function select(k, { scroll = true } = {}) {
    if (k == null) return;
    pm.sel = k; pm.tab = pm.nodes.get(k)?.virtual ? 'agent' : pm.tab;
    if (pm.detailFor !== k) { pm.detail = null; pm.gone = false; pm.fq = ''; }
    for (const r of $('pm-list').querySelectorAll('.pm-row')) {
      const on = r.dataset.k === String(k);
      r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on));
      if (on && scroll) r.scrollIntoView({ block: 'nearest' });
    }
    if (String(k).startsWith('agent:')) renderDetail(); else { renderDetail(); loadDetail(); }
  }
  /** Make k visible: open its ancestors. */
  function reveal(k) {
    for (let p = pm.nodes.get(k)?.ppid, i = 0; pm.nodes.has(p) && i < 64; p = pm.nodes.get(p).ppid, i++) { pm.open.add(p); pm.shut.delete(p); }
  }
  function toggle(k, open = !isOpen(k)) {
    if (open) { pm.open.add(k); pm.shut.delete(k); } else { pm.shut.add(k); pm.open.delete(k); }
    renderList();
  }

  // ---------------------------------------------------------- detail
  function spark(values, { fmt, max = null, cls = '' }) {
    const v = values.filter(x => x != null);
    if (v.length < 5) return null;   // a trend needs a few samples
    const W = 120, H = 24, top = Math.max(max ?? 0, ...v) || 1;
    const pts = v.map((x, i) => `${(i / (SPARK_N - 1)) * W + (W - ((v.length - 1) / (SPARK_N - 1)) * W)},${H - 1 - (x / top) * (H - 2)}`).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('class', `pm-spark ${cls}`);
    svg.innerHTML = `<polyline fill="none" stroke="currentColor" stroke-width="1.4" points="${pts}"/>`;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = `last ${v.length} samples · peak ${fmt(Math.max(...v))}`; svg.append(t);
    return svg;
  }
  const pidLink = (pid, label = String(pid)) => h('button', { type: 'button', class: 'linkish mono', onclick: () => jump(pid) }, label);
  function jump(pid) {
    if (!pm.nodes.has(pid) && pm.scope !== 'all') { setScope('all', pid); return; }
    reveal(pid); renderList(); select(pid);
  }

  async function signal(sig, n) {
    const tree = pm.tree;
    const s = SIG[sig];
    const destructive = ['TERM', 'KILL', 'INT', 'HUP'].includes(sig);
    if (destructive || !n.scope) {
      const what = `${nodeTitle(n)} (pid ${n.pid})`;
      const kids = tree ? (pm.detail?.descendants || 0) : 0;
      const warn = [
        !n.scope ? 'This process does not belong to the deck or its sessions.' : null,
        n.tag?.kind === 'session' ? 'This is a Claude Code session; ending it stops the agent mid-turn.' : null,
        n.tag?.kind === 'session' && n.tag.deck && sig === 'TERM' && !tree ? 'The deck ends it the way the power button does.' : null,
        kids ? `${kids} process${kids === 1 ? '' : 'es'} below it get the signal too, deepest first.` : null,
      ].filter(Boolean).join(' ');
      const ok = await ctx.confirm(`${s.label} ${oneLine(what, 60)}?`, `${s.desc}.${warn ? ' ' + warn : ''}`, `${s.label}${kids ? ' all' : ''}`);
      if (!ok) return;
    }
    pm.busy = true; renderDetail();
    try {
      const r = await ctx.api.post(`/api/procs/${n.pid}/signal`, { signal: sig, tree, start: n.start });
      const failed = r.failed?.length ? ` · ${r.failed.length} refused (${r.failed[0].error})` : '';
      ctx.toast(`${s.label}: sent to ${r.sent.length} process${r.sent.length === 1 ? '' : 'es'}${failed}`);
    } catch (e) { ctx.toast(`${s.label} failed: ${e.message}`); }
    pm.busy = false;
    setTimeout(load, 300);
  }

  // One menu for the dialog's life: the detail re-renders every poll, and an open popover must survive that.
  const menu = h('div', { class: 'pm-menu', popover: '', role: 'menu', 'aria-label': 'Signals' });
  dlg.append(menu);
  function openMenu(btn, n) {
    menu.replaceChildren(...Object.entries(SIG).map(([k, s]) => h('button', { type: 'button', role: 'menuitem', title: s.desc, class: `pm-mi${k === 'KILL' || k === 'TERM' ? ' danger' : ''}`, onclick: () => { menu.hidePopover(); signal(k, n); } },
      svgUse(s.icon, 13), h('span', {}, s.label), h('span', { class: 'muted' }, s.desc.replace(/^SIG\w+: /, '')), h('span', { class: 'mono muted' }, `SIG${k}`))));
    menu.showPopover();
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
    menu.querySelector('button')?.focus();
  }
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('button')]; const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });

  function controls(n) {
    const paused = n.state?.[0] === 'T';
    const dis = pm.busy || pm.gone || n.pid === pm.data?.self || null;
    return [
      ib(paused ? 'i-play' : 'i-pause', paused ? 'Resume (SIGCONT)' : 'Pause (SIGSTOP)', () => signal(paused ? 'CONT' : 'STOP', n), { disabled: dis }),
      ib('i-stop', 'Terminate (SIGTERM)', () => signal('TERM', n), { cls: 'danger', disabled: dis }),
      ib('i-bolt', 'Force kill (SIGKILL)', () => signal('KILL', n), { cls: 'danger', disabled: dis }),
      h('button', { type: 'button', class: 'ib', 'aria-haspopup': 'menu', 'aria-label': 'More signals', title: 'More signals', disabled: dis, onclick: (e) => openMenu(e.currentTarget, n) }, svgUse('i-down', 12)),
      h('button', { type: 'button', class: 'ib tg', 'aria-pressed': String(pm.tree), 'aria-label': 'Include everything below it', title: pm.tree ? 'Signals go to it and everything below it' : 'Signals go to this process only (click to include everything below it)', onclick: () => { pm.tree = !pm.tree; renderDetail(); } }, svgUse('i-branch', 14)),
      h('span', { class: 'pm-sep' }),
      copyBtn(String(n.pid), 'Copy pid'),
      n.tag?.sessionId && n.tag.kind !== 'model' ? ib('i-right', 'Open its session', () => { dlg.close(); ctx.openSession(n.tag.sessionId); }) : null,
    ];
  }

  function tabs(n, d) {
    const net = (d?.files || []).filter(f => /^IPv[46]$|^unix$/.test(f.type));
    const files = (d?.files || []).filter(f => !/^IPv[46]$|^unix$/.test(f.type));
    const list = [
      ['overview', 'Overview', null],
      n.tag ? ['agent', 'Agent', null] : null,
      ['files', 'Files', d ? files.length : null],
      ['net', 'Network', d ? net.filter(f => f.type !== 'unix').length || null : null],
      ['env', 'Environment', d?.env?.vars?.length || null],
    ].filter(Boolean);
    if (!list.some(t => t[0] === pm.tab)) pm.tab = 'overview';
    return { list, files, net };
  }

  function renderDetail() {
    const box = $('pm-detail');
    const k = pm.sel;
    const n = k != null ? pm.nodes.get(k) || (pm.detail?.pid === k ? pm.detail : null) : null;
    if (!n) { patch(box, [h('div', { class: 'pm-blank muted' }, k != null ? 'That process is gone.' : 'Pick a process to see what is known about it.')]); return; }
    if (n.virtual) { patch(box, [virtualDetail(n)]); return; }
    const d = pm.detailFor === k ? pm.detail : null;
    const full = d ? { ...n, ...d } : n;
    const { list, files, net } = tabs(full, d);
    const head = h('div', { class: 'pm-dh' },
      h('div', { class: 'pm-dh-row' }, glyph(full), h('h3', { title: full.args }, nodeTitle(full)),
        h('span', { class: `chip st-${full.state?.[0]}` }, stateText(full.state).split(' · ')[0]),
        pm.gone ? h('span', { class: 'chip err' }, 'gone') : null,
        full.tag?.detached ? h('span', { class: 'chip warn', title: 'Its session’s process is gone; init adopted it' }, 'detached') : null,
        h('span', { class: 'spacer' }), ...controls(full)),
      h('div', { class: 'dmeta' }, h('span', {}, `pid ${full.pid}`), full.ppid ? h('span', {}, 'parent ', pidLink(full.ppid)) : null,
        h('span', {}, full.user), full.start ? h('span', { title: new Date(full.start).toLocaleString() }, `up ${fmtUp(full.start)}`) : null));
    const nav = h('nav', { class: 'pm-tabs', role: 'tablist' }, ...list.map(([id, label, count]) => h('button', {
      type: 'button', role: 'tab', class: `tab-b${pm.tab === id ? ' active' : ''}`, 'aria-selected': String(pm.tab === id), onclick: () => { pm.tab = id; renderDetail(); },
    }, label, count ? h('span', { class: 'count' }, String(count)) : null)));
    const body = h('div', { class: 'pm-db' });
    if (pm.tab === 'overview') body.append(...overview(full, d));
    else if (pm.tab === 'agent') body.append(...agentTab(full));
    else if (pm.tab === 'files') body.append(...filesTab(files, d));
    else if (pm.tab === 'net') body.append(...netTab(net, d));
    else if (pm.tab === 'env') body.append(...envTab(d));
    const keep = box.querySelector('.pm-db')?.scrollTop || 0;
    const focusQ = document.activeElement?.id === 'pm-fq' ? document.activeElement.selectionStart : null;
    const same = box.dataset.k === String(k) && box.dataset.tab === pm.tab;
    if (same) patch(box, [head, nav, body]); else box.replaceChildren(head, nav, body);
    box.dataset.k = String(k); box.dataset.tab = pm.tab;
    if (pm.detailFor === k) box.querySelector('.pm-db').scrollTop = keep;
    if (focusQ != null) { const q = $('pm-fq'); q?.focus(); q?.setSelectionRange(focusQ, focusQ); }
  }

  function facts(rows) {
    return h('table', { class: 'hc-tbl pm-facts' }, h('tbody', {}, ...rows.filter(r => r && r[1] != null && r[1] !== '').map(([k, v, cls]) => h('tr', {}, h('th', {}, k), h('td', { class: cls || null }, v)))));
  }
  function overview(n, d) {
    const hs = pm.hist.get(n.pid) || [];
    const out = [];
    out.push(section('Command', { actions: [copyBtn(n.args, 'Copy the command'), ib('i-term', 'Inspect it in the Shell tab (lsof)', () => { dlg.close(); ctx.runInShell(`lsof -p ${n.pid}`, d?.cwd); }, { size: 13 })] },
      h('pre', { class: 'plain pm-cmd' }, n.args || n.comm)));
    out.push(facts([
      ['State', stateText(n.state)],
      ['CPU', h('span', { class: 'pm-fig' }, `${fmtCpu(n.cpu)}%`, spark(hs.map(x => x.cpu), { fmt: (x) => `${fmtCpu(x)}%`, max: 5, cls: 'cpu' }))],
      ['Memory', h('span', { class: 'pm-fig' }, `${fmtBytes(n.rss)}${n.mem ? ` · ${n.mem}%` : ''}`, spark(hs.map(x => x.rss), { fmt: fmtBytes, cls: 'mem' }))],
      ['CPU time', n.cputime != null ? fmtMs(n.cputime * 1000) : null],
      ['Virtual', fmtBytes(n.vsz)],
      ['Started', n.start ? `${new Date(n.start).toLocaleString()} · ${ago(Date.now() - n.start)} ago` : null],
      ['Folder', d?.cwd ? h('span', { class: 'pm-path' }, h('span', { class: 'mono' }, d.cwd), ib('i-folder-open', 'Open the folder in the editor', () => ctx.openEditor(d.cwd), { size: 12 })) : null],
      ['Executable', n.comm, 'mono'],
      ['User', `${n.user} (uid ${n.uid})`],
      ['Group', d ? `pgid ${n.pgid} · ${d.group} process${d.group === 1 ? '' : 'es'}` : `pgid ${n.pgid}`],
      ['Below it', d ? `${d.children.length} child${d.children.length === 1 ? '' : 'ren'}${d.descendants > d.children.length ? ` · ${d.descendants} in all` : ''}` : null],
    ]));
    if (d?.ancestors?.length) {
      out.push(section('Lineage', {}, h('div', { class: 'pm-crumbs' }, ...d.ancestors.flatMap((a, i) => [i ? h('span', { class: 'muted' }, '›') : null,
        h('button', { type: 'button', class: 'pm-crumb', title: `pid ${a.pid}`, onclick: () => jump(a.pid) }, a.tag && a.tag.kind !== 'deck' ? oneLine(a.tag.label, 30) : a.name)]), h('span', { class: 'muted' }, '›'), h('b', {}, n.name))));
    }
    if (d?.children?.length || d?.virtual?.length) {
      out.push(section('Children', { note: String(d.children.length + d.virtual.length) }, h('div', { class: 'pm-kids' },
        ...d.virtual.map(v => h('button', { type: 'button', class: 'pm-kid', onclick: () => select(v.id) }, glyph(v), h('span', { class: 'pm-t' }, v.tag.label), h('span', { class: 'muted' }, 'in-process'))),
        ...d.children.map(c => h('button', { type: 'button', class: 'pm-kid', title: c.args, onclick: () => jump(c.pid) }, glyph(c),
          h('span', { class: 'pm-t' }, c.tag && c.tag.kind !== 'deck' ? c.tag.label : c.name), h('span', { class: 'mono muted' }, String(c.pid)), h('span', { class: 'num muted' }, `${fmtCpu(c.cpu)}% · ${fmtBytes(c.rss)}`))))));
    }
    return out;
  }

  function agentTab(n) {
    const t = n.tag; if (!t) return [];
    const k = KIND[t.kind];
    const out = [h('p', { class: 'pm-what' }, k?.what || t.kind, t.detached ? '. Its session’s process is gone, so init adopted it; it keeps running until it ends or is stopped.' : '.')];
    const links = [];
    if (t.sessionId && t.kind !== 'model') links.push(['Session', h('button', { type: 'button', class: 'linkish', onclick: () => { dlg.close(); ctx.openSession(t.kind === 'subagent' ? t.parentId : t.sessionId); } }, ctx.titleOf(t.kind === 'subagent' ? t.parentId : t.sessionId) || t.sessionId)]);
    if (t.kind === 'session') links.push(['Control', t.deck ? 'launched by the deck' : 'launched outside the deck (observe only)']);
    if (t.taskId) links.push(['Task', h('button', { type: 'button', class: 'linkish', onclick: () => { dlg.close(); ctx.openTask(t.sessionId, t.taskId); } }, t.label || t.taskId)]);
    if (t.toolUseId) links.push(['Call', h('button', { type: 'button', class: 'linkish', onclick: () => { dlg.close(); ctx.openCall(t.sessionId, t.toolUseId); } }, t.label || 'Bash call')]);
    if (t.runId) links.push(['Shell run', t.label]);
    out.push(facts(links));
    if (t.command) out.push(section('Command Claude ran', { actions: [copyBtn(t.command)] }, codeBlock(t.command, 'bash', { numbers: false })));
    return out;
  }

  function virtualDetail(n) {
    const t = n.tag;
    return h('div', { class: 'pm-vd' },
      h('div', { class: 'pm-dh' }, h('div', { class: 'pm-dh-row' }, glyph(n), h('h3', {}, t.label), h('span', { class: 'chip' }, n.name), h('span', { class: 'spacer' }),
        ib('i-right', 'Open the subagent', () => { dlg.close(); ctx.openSession(t.sessionId); }))),
      h('div', { class: 'pm-db' }, h('p', { class: 'pm-what' }, KIND.subagent.what), facts([
        ['Session', h('button', { type: 'button', class: 'linkish', onclick: () => { dlg.close(); ctx.openSession(t.parentId); } }, ctx.titleOf(t.parentId) || t.parentId)],
        ['Process', pidLink(n.ppid, `pid ${n.ppid} (its session)`)],
      ])));
  }

  function filterBox(placeholder) {
    return h('label', { class: 'search pm-fs' }, svgUse('i-search', 12, 'Filter'), h('input', { id: 'pm-fq', type: 'search', placeholder, spellcheck: 'false', value: pm.fq, oninput: (e) => { pm.fq = e.target.value; renderDetail(); } }));
  }
  const fmatch = (...xs) => { const q = pm.fq.trim().toLowerCase(); return !q || xs.join(' ').toLowerCase().includes(q); };
  function filesTab(files, d) {
    if (!d) return [h('p', { class: 'muted' }, 'Loading…')];
    if (d.filesError) return [h('p', { class: 'muted' }, d.filesError)];
    const ORDER = { cwd: 0, txt: 1, rtd: 2 };
    const rows = files.filter(f => fmatch(f.fd, f.type, f.name))
      .sort((a, b) => (ORDER[a.fd] ?? 9) - (ORDER[b.fd] ?? 9) || (parseInt(a.fd) || 0) - (parseInt(b.fd) || 0));
    const ACCESS = { r: 'read', w: 'write', u: 'read/write' };
    return [h('div', { class: 'pm-tb' }, filterBox('Filter open files'), h('span', { class: 'muted' }, d.filesTotal > d.files.length ? `first ${d.files.length} of ${d.filesTotal}` : `${files.length} open`)),
      h('table', { class: 'list pm-ft' }, h('thead', {}, h('tr', {}, ...['FD', 'Type', 'Mode', 'Name'].map(x => h('th', {}, x)))),
        h('tbody', {}, ...rows.map(f => h('tr', { class: f.type === 'REG' ? 'click' : null, title: f.type === 'REG' ? 'Open in the editor' : f.name, onclick: f.type === 'REG' && f.name?.startsWith('/') ? () => ctx.openEditor(f.name) : null },
          h('td', { class: 'muted' }, f.fd), h('td', { class: 'muted' }, f.type || ''), h('td', { class: 'muted' }, ACCESS[f.access] || ''), h('td', { class: 'pm-fn' }, f.name || ''))))),
    ];
  }
  function netTab(net, d) {
    if (!d) return [h('p', { class: 'muted' }, 'Loading…')];
    const ip = net.filter(f => f.type !== 'unix' && fmatch(f.proto, f.name, f.tcpState));
    const unix = net.filter(f => f.type === 'unix' && fmatch(f.name));
    const split = (name) => { const [l, r] = String(name || '').split('->'); return [l, r || '']; };
    const listening = ip.filter(f => f.tcpState === 'LISTEN');
    const out = [h('div', { class: 'pm-tb' }, filterBox('Filter connections'), h('span', { class: 'muted' }, [listening.length ? `${listening.length} listening` : null, `${ip.length - listening.length} connection${ip.length - listening.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')))];
    if (!ip.length && !unix.length) out.push(h('p', { class: 'muted' }, 'No sockets open.'));
    if (ip.length) out.push(h('table', { class: 'list pm-ft' }, h('thead', {}, h('tr', {}, ...['Proto', 'Local', 'Remote', 'State'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...ip.sort((a, b) => (b.tcpState === 'LISTEN') - (a.tcpState === 'LISTEN')).map(f => { const [l, r] = split(f.name); return h('tr', {},
        h('td', { class: 'muted' }, `${f.proto || ''}${f.type === 'IPv6' ? '6' : ''}`), h('td', {}, l), h('td', {}, r),
        h('td', { class: f.tcpState === 'LISTEN' ? 'hot' : 'muted' }, f.tcpState || '')); }))));
    if (unix.length) out.push(section('Unix sockets', { note: String(unix.length) }, h('div', { class: 'pm-unix mono muted' }, ...unix.slice(0, 200).map(f => h('div', {}, `${f.fd}  ${f.name || ''}`)))));
    return out;
  }
  function envTab(d) {
    if (!d) return [h('p', { class: 'muted' }, 'Loading…')];
    const vars = (d.env?.vars || []).filter(([k, v]) => fmatch(k, pm.reveal || !SECRET.test(k) ? v : ''));
    if (!d.env?.vars?.length) return [h('p', { class: 'muted' }, d.env?.note || 'No environment visible.')];
    const secret = d.env.vars.filter(([k]) => SECRET.test(k)).length;
    return [h('div', { class: 'pm-tb' }, filterBox('Filter variables'),
      secret ? h('button', { type: 'button', class: 'ib tg', 'aria-pressed': String(pm.reveal), 'aria-label': pm.reveal ? 'Hide secret-looking values' : `Show ${secret} secret-looking value${secret === 1 ? '' : 's'}`, title: pm.reveal ? 'Hide secret-looking values' : `Show ${secret} secret-looking value${secret === 1 ? '' : 's'}`, onclick: () => { pm.reveal = !pm.reveal; renderDetail(); } }, svgUse('i-eye', 14)) : null,
      copyBtn(() => d.env.vars.map(([k, v]) => `${k}=${v}`).join('\n'), 'Copy all (secrets included)')),
      h('table', { class: 'list pm-ft pm-env' }, h('tbody', {}, ...vars.sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => {
        const masked = !pm.reveal && SECRET.test(k);
        return h('tr', {}, h('td', { class: 'pm-ek' }, k), h('td', { class: `pm-fn${masked ? ' muted' : ''}` }, masked ? '••••••••' : v));
      })))];
  }

  // ---------------------------------------------------------- dialog
  function setScope(s, then = null) {
    pm.scope = s;
    for (const b of $('pm-scope').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.s === s));
    load().then(() => { if (then != null) jump(then); });
  }
  async function open({ pid = null, start = null } = {}) {
    if (!dlg.open) { dlg.showModal(); }
    pm.live = true; $('pm-live').setAttribute('aria-pressed', 'true');
    if (pid != null) { pm.sel = pid; pm.tab = 'overview'; pm.detail = null; pm.detailFor = null; }
    await load();
    if (pid != null) {
      const n = pm.nodes.get(pid);
      if (start && n?.start && Math.abs(n.start - start) > 3000) ctx.toast(`That process ended; pid ${pid} now belongs to another one`);
      if (!n) { if (pm.scope !== 'all') { setScope('all', pid); schedule(); return; } }
      else { reveal(pid); renderList(); select(pid); }
    } else if (pm.sel == null && pm.rows[0]) select(pm.rows[0].k);
    if (!pid) $('pm-q').focus();
    else $('pm-list').focus({ preventScroll: true });
    schedule();
  }

  $('pm-scope').onclick = (e) => { const b = e.target.closest('button'); if (b && b.dataset.s !== pm.scope) setScope(b.dataset.s); };
  $('pm-q').oninput = (e) => { pm.q = e.target.value; renderList(); };
  $('pm-q').onkeydown = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); $('pm-list').focus(); move(pm.sel == null ? 0 : 1); } };
  $('pm-live').onclick = () => { pm.live = !pm.live; $('pm-live').setAttribute('aria-pressed', String(pm.live)); if (pm.live) load(); schedule(); };
  $('pm-close').onclick = () => dlg.close();
  dlg.addEventListener('close', () => { clearTimeout(pm.timer); pm.hist.clear(); });
  $('pm-list').addEventListener('click', (e) => {
    const tw = e.target.closest('[data-tw]');
    if (tw) { const k = pm.nodes.has(+tw.dataset.tw) ? +tw.dataset.tw : tw.dataset.tw; toggle(k); return; }
    const r = e.target.closest('.pm-row'); if (!r) return;
    select(pm.nodes.has(+r.dataset.k) ? +r.dataset.k : r.dataset.k, { scroll: false });
  });
  $('pm-list').addEventListener('dblclick', (e) => { const r = e.target.closest('.pm-row'); if (r) { const k = pm.nodes.has(+r.dataset.k) ? +r.dataset.k : r.dataset.k; toggle(k); } });
  function move(delta) {
    if (!pm.rows.length) return;
    const i = pm.rows.findIndex(r => r.k === pm.sel);
    const j = Math.max(0, Math.min(pm.rows.length - 1, i < 0 ? 0 : i + delta));
    select(pm.rows[j].k);
  }
  $('pm-list').addEventListener('keydown', (e) => {
    const row = pm.rows.find(r => r.k === pm.sel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); move(e.key === 'PageDown' ? 15 : -15); }
    else if (e.key === 'ArrowRight' && row) { e.preventDefault(); if (row.kids && !row.open) toggle(row.k, true); else if (row.kids) move(1); }
    else if (e.key === 'ArrowLeft' && row) { e.preventDefault(); if (row.kids && row.open) toggle(row.k, false); else if (pm.nodes.has(row.n.ppid)) select(row.n.ppid); }
    else if (e.key === '/') { e.preventDefault(); $('pm-q').focus(); }
  });

  return { open, close: () => dlg.close(), get isOpen() { return dlg.open; } };
}

/** A pid as a link into the process view. `start` (ms) guards against the pid being reused. */
export function pidLinkEl(pid, open, { start = null, label = null, cls = '' } = {}) {
  return h('button', { type: 'button', class: `pidlink mono${cls ? ' ' + cls : ''}`, title: 'Show in the process view', onclick: (e) => { e.stopPropagation(); open({ pid, start }); } }, label || `pid ${pid}`);
}
