// public/models.js — Main menu → "Models…": which backend and model each kind
// of model call (request class) runs on, with "Everything → Claude" for when
// the local model is down. Builds its own dialog and styles; the server side
// is lib/routes/models.mjs. Nothing here calls a model unless Test is pressed;
// opening the dialog only checks the local server is reachable.
import { h, ib, svgUse, fmtUsd, fmtMs, ago } from './events.js';
import { registerMenuItem } from './menu.js';

const BACKENDS = [
  { id: 'local', icon: 'i-be-local', name: 'Local model' },
  { id: 'claude', icon: 'i-be-anthropic', name: 'Claude' },
];
// The heal script fixes a dropped tunnel; lib/llm.mjs words its errors so this only matches those.
const TUNNEL_ERR = /open-act tunnel/;

let dlg = null, top = null, grid = null, lists = null, foot = null, view = null, flash = null;
const rows = new Map();    // class -> its row's elements, kept so a model being typed survives a redraw
const tests = new Map();   // class -> last Test result, or 'pending'

async function call(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(j?.error || `${r.status} ${path}`);
  return j;
}
const since = (t) => `${ago(Date.now() - t)} ago`;

function ensureDialog() {
  if (dlg) return dlg;
  document.head.append(h('style', {}, CSS));
  top = h('div');
  grid = h('div', { class: 'md-rows', role: 'table', 'aria-label': 'Request classes' });
  lists = h('div');
  foot = h('div');
  dlg = h('dialog', { class: 'dialog models', 'aria-labelledby': 'md-t' }, top, grid, lists, foot);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  return dlg;
}

async function open() {
  ensureDialog();
  if (!dlg.open) dlg.showModal();
  if (!view) render();
  await load();
}

async function load(probe = true) {
  try { view = await call(`/api/models${probe ? '' : '?probe=0'}`); }
  catch (e) { view = { error: e.message }; }
  render();
}

// Changes go out one at a time, in order, each shown at once; the server's
// answer replaces the view only when nothing else is waiting behind it.
let queue = Promise.resolve(), queued = 0, failed = false;
function change(path, body, optimistic) {
  optimistic?.();
  render();
  queued++;
  queue = queue.then(() => call(path, body)).then((v) => { if (!--queued && !failed) view = v; },
    (e) => { queued--; failed = true; flash = e.message; })
    .then(() => { if (queued) return; if (failed) { failed = false; return load(false); } render(); });
  return queue;
}
function setRoute(cls, patch) {
  change('/api/models/route', { class: cls, ...patch }, () => {
    const r = view.classes.find(c => c.id === cls)?.route;
    if (!r) return;
    if (patch.transport && patch.transport !== r.transport) r.model = null;
    Object.assign(r, patch);
  });
}

async function runTest(cls) {
  tests.set(cls, 'pending'); render();
  await queue;   // run on what the row shows
  try {
    const r = await call('/api/models/test', { class: cls });
    tests.set(cls, r);
    if (r.models && !queued) view = r.models;
  } catch (e) { tests.set(cls, { ok: false, error: e.message }); }
  render();
}

let healing = false;
async function heal() {
  healing = true; render();
  try { const r = await call('/api/tunnel/heal', {}); if (!r.ok) flash = `Tunnel not healed: ${(r.output || '').trim().split('\n').at(-1) || `exit ${r.code}`}`; }
  catch (e) { flash = e.message; }
  healing = false;
  await load();
}

const title = () => h('h2', { id: 'md-t' }, 'Models');
const closeBtn = () => ib('i-x', 'Close', () => dlg.close(), { size: 12 });

function render() {
  if (!dlg) return;
  if (!view || view.error) {
    top.replaceChildren(h('header', { class: 'md-h' }, title(), h('span', { class: 'grow' }), closeBtn()),
      view ? h('p', { class: 'md-err' }, view.error) : h('p', { class: 'muted' }, 'Checking the backends…'));
    return;
  }
  const on = view.allClaude;
  const sw = h('button', { type: 'button', class: 'md-sw', role: 'switch', 'aria-checked': String(on), disabled: !view.transports.some(t => t.id === 'claude') || null,
    title: on ? 'Every class runs on Claude. Turn off to go back to each row’s own settings.' : 'Send every class to Claude, e.g. while the local model is down. Rows are kept.',
    onclick: () => change('/api/models/everything-claude', { on: !on }, () => { view.allClaude = !on; }) },
  h('span', { class: 'md-track' }, h('span', { class: 'md-knob' })), 'Everything → ', svgUse('i-be-anthropic', 12), 'Claude');
  const head = h('header', { class: 'md-h' }, title(), sw, h('span', { class: 'grow' }),
    ib('i-refresh', 'Check the backends again', () => load(), { size: 12 }), closeBtn());

  // Health: the newest outcome wins, a real call's or the reachability check's.
  const health = h('div', { class: 'md-health' });
  const notes = [];
  for (const t of view.transports) {
    const b = BACKENDS.find(x => x.id === t.id);
    const hl = t.health, pr = hl.probe;
    const last = [hl.at && { at: hl.at, ok: hl.ok, ms: hl.ms, error: hl.error?.message }, pr && { at: pr.at, ok: pr.ok, ms: pr.ms, error: pr.error }]
      .filter(Boolean).sort((x, y) => y.at - x.at)[0] || null;
    const tip = [`${b.name} · ${t.label}`,
      t.id === 'local' ? (t.models.length ? `serves ${t.models.join(', ')}` : 'models unknown') : null,
      pr ? `reachable: ${pr.ok ? `yes (${fmtMs(pr.ms)}, ${since(pr.at)})` : `no (${since(pr.at)})`}` : null,
      hl.at ? `last call ${since(hl.at)}: ${hl.ok ? `ok, ${fmtMs(hl.ms)}` : 'failed'}` : 'no calls yet',
      t.skipUntil ? `skipped by classes that fall back, for ${ago(t.skipUntil - Date.now())} more` : null,
      `${t.limit} at a time${t.active ? ` · ${t.active} running` : ''}`,
      hl.error ? `last error: ${hl.error.message}` : null].filter(Boolean).join('\n');
    health.append(h('span', { class: 'md-be', title: tip }, svgUse(b.icon, 14), h('span', { class: `md-dot ${!last ? '' : last.ok ? 'ok' : 'bad'}` }),
      last?.ms != null ? h('span', { class: 'md-ms' }, fmtMs(last.ms)) : null));
    if (last && !last.ok) notes.push(h('div', { class: 'md-err' }, last.error || 'failed',
      t.id === 'local' && TUNNEL_ERR.test(last.error || '') ? ib('i-plug', 'Heal the SSH tunnel to the model host', heal, { size: 12, cls: 'err', disabled: healing || null }) : null));
    // A default the server does not list may still work (llama-server answers with whatever it loaded), so only a note.
    if (t.id === 'local' && pr?.ok && t.models.length && t.defaultModel && !t.models.includes(t.defaultModel)) {
      notes.push(h('div', { class: 'md-note' }, `Default model ${t.defaultModel} is not among the server’s (${t.models.join(', ')}).`));
    }
  }
  if (flash) { notes.push(h('div', { class: 'md-err' }, flash)); flash = null; }
  top.replaceChildren(head, health, ...notes);

  lists.replaceChildren(...view.transports.map(t => h('datalist', { id: `md-ml-${t.id}` }, ...t.models.map(m => h('option', { value: m })))));
  grid.classList.toggle('forced', on);
  for (const c of view.classes) updateRow(c);
  foot.replaceChildren(...(view.enabled ? [] : [h('p', { class: 'muted md-foot' }, 'Model calls are off (server started with --no-narrator).')]));
}

/** A row's elements are made once and updated in place, so focus and typing survive a redraw. */
function rowFor(c) {
  if (rows.has(c.id)) return rows.get(c.id);
  const routeOf = () => view.classes.find(x => x.id === c.id).route;
  const x = {};
  x.name = h('span', { class: 'md-name' });
  x.seg = h('div', { class: 'seg icons md-seg', role: 'group', 'aria-label': `${c.label} backend` },
    ...BACKENDS.map(b => h('button', { type: 'button', 'aria-label': b.name, title: b.name, dataset: { be: b.id },
      onclick: () => routeOf().transport !== b.id && setRoute(c.id, { transport: b.id }) }, svgUse(b.icon, 13))));
  x.model = h('input', { class: 'md-model', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${c.label} model`, title: 'Model (empty: the backend’s default)',
    onchange: (e) => { e.target.dataset.shown = e.target.value; setRoute(c.id, { model: e.target.value.trim() || null }); },
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  x.model.dataset.shown = '';
  x.think = ib('i-think', 'Thinking', () => setRoute(c.id, { thinking: !routeOf().thinking }), { size: 13, cls: 'md-tog' });
  x.fb = ib('i-reuse', 'Fallback', () => setRoute(c.id, { fallback: !routeOf().fallback }), { size: 13, cls: 'md-tog' });
  x.use = h('span', { class: 'md-use' });
  x.test = ib('i-play', 'Test', () => runTest(c.id), { size: 12 });
  x.line = h('div', { class: 'md-test', hidden: true });
  grid.append(h('div', { class: 'md-row', role: 'row' }, x.name, x.seg, x.model, x.think, x.fb, x.use, x.test), x.line);
  rows.set(c.id, x);
  return x;
}

function updateRow(c) {
  const x = rowFor(c), r = c.route, eff = c.effective;
  x.name.replaceChildren(c.label, eff.forced && view.allClaude ? h('span', { class: 'md-via', title: `Everything → Claude: runs on ${eff.model} until the switch is off` }, svgUse('i-be-anthropic', 10)) : '');
  x.name.title = c.description;
  for (const btn of x.seg.children) {
    btn.hidden = !view.transports.some(t => t.id === btn.dataset.be);
    btn.setAttribute('aria-pressed', String(r.transport === btn.dataset.be));
  }
  // Leave alone a model being typed, or typed and not yet sent.
  const inp = x.model;
  if (document.activeElement !== inp && inp.value === inp.dataset.shown) { inp.value = r.model || ''; inp.dataset.shown = inp.value; }
  inp.placeholder = r.transport === 'claude' ? c.claudeModel : view.transports.find(t => t.id === 'local')?.defaultModel || 'server default';
  inp.setAttribute('list', `md-ml-${r.transport}`);
  const tog = (btn, on, label, disabled = false) => {
    btn.classList.toggle('on', on && !disabled); btn.setAttribute('aria-pressed', String(on)); btn.title = label; btn.setAttribute('aria-label', label); btn.disabled = disabled;
  };
  tog(x.think, r.thinking, r.thinking ? 'Thinking on' : 'Thinking off');
  tog(x.fb, !!r.fallback, r.transport === 'claude' ? 'Already on Claude' : r.fallback ? `Falls back to Claude (${c.claudeModel}) if the local model fails` : 'No fallback to Claude', r.transport === 'claude');
  const u = c.usage;
  x.use.textContent = u.calls ? String(u.calls) : '';
  x.use.title = u.calls || u.errors
    ? [`Today: ${u.calls} call${u.calls === 1 ? '' : 's'} · ${fmtUsd(u.costUsd)} · ${u.calls ? fmtMs(Math.round(u.ms / u.calls)) : '–'} avg`,
      u.fallbacks ? `${u.fallbacks} fell back to Claude` : null, u.errors ? `${u.errors} failed` : null,
      Object.keys(u.via).length > 1 ? Object.entries(u.via).map(([k, v]) => `${k} ${v}`).join(' · ') : null].filter(Boolean).join('\n')
    : 'No calls today';
  const tr = tests.get(c.id);
  const tip = `Test: one tiny call on ${eff.transport === 'claude' ? 'Claude' : 'the local model'} (${eff.model || 'default'})`;
  x.test.title = tip; x.test.setAttribute('aria-label', tip);
  x.test.disabled = tr === 'pending' || !view.enabled;
  x.line.hidden = !tr;
  if (tr) testLine(x.line, tr);
}

function testLine(el, r) {
  el.className = `md-test${r === 'pending' ? ' muted' : r.ok ? '' : ' md-err'}`;
  if (r === 'pending') return el.replaceChildren('Testing…');
  if (!r.ok) return el.replaceChildren(`${fmtMs(r.ms)} · ${r.error}`);
  el.replaceChildren(svgUse('i-check', 11), h('span', { class: 'md-ms' }, fmtMs(r.ms)), h('span', { class: 'md-line' }, r.line || '(empty reply)'),
    r.fellBack ? h('span', { class: 'md-via', title: `Fell back to Claude (${r.model}): ${r.fallbackReason}` }, 'via ', svgUse('i-be-anthropic', 10)) : '');
}

registerMenuItem({ group: 'settings', order: 80, icon: 'i-gear', text: 'Models…', fn: open });

const CSS = `
/* ---- Models dialog (public/models.js) ---- */
.dialog.models { width: min(640px, calc(100vw - 32px)); max-width: none; padding: 16px 18px 14px; }
.md-h { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.md-h h2 { margin: 0; }
.md-h .grow { flex: 1; }
.md-sw { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px 0 4px; border: 0; border-radius: 13px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
.md-sw:hover:not(:disabled) { color: var(--fg); }
.md-sw[aria-checked="true"] { color: var(--fg); }
.md-track { position: relative; width: 26px; height: 15px; margin-right: 4px; border-radius: 8px; background: var(--line2); transition: background .15s; }
.md-knob { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 6px; background: var(--bg1); transition: left .15s; }
.md-sw[aria-checked="true"] .md-track { background: var(--info); }
.md-sw[aria-checked="true"] .md-knob { left: 13px; }
.md-health { display: flex; gap: 14px; align-items: center; margin-bottom: 8px; color: var(--muted); }
.md-be { display: inline-flex; align-items: center; gap: 5px; cursor: default; }
.md-dot { width: 7px; height: 7px; border-radius: 4px; background: var(--line2); }
.md-dot.ok { background: var(--ok); }
.md-dot.bad { background: var(--err); }
.md-ms { font: 11px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.md-err { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 12px; color: var(--err-fg); overflow-wrap: anywhere; }
.md-note { margin: 0 0 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.md-rows { display: grid; grid-template-columns: minmax(80px, auto) auto minmax(120px, 1fr) auto auto 28px auto; align-items: center; column-gap: 6px; row-gap: 2px; border-top: 1px solid var(--line); padding-top: 8px; }
.md-row { display: contents; }
.md-rows.forced .md-seg, .md-rows.forced .md-model, .md-rows.forced .md-tog { opacity: .4; }
.md-name { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: default; }
.md-seg button { padding: 0 7px; }
.md-seg button[hidden] { display: none; }
.md-model { height: 26px; min-width: 0; padding: 0 8px; border: 1px solid var(--line2); border-radius: 6px; background: var(--bg0); color: var(--fg); font: 12px var(--mono); }
.md-model::placeholder { color: var(--muted); opacity: .8; }
.ib.md-tog { opacity: .45; }
.ib.md-tog.on { opacity: 1; color: var(--info-fg); }
.md-use { font: 11px var(--mono); color: var(--muted); text-align: right; cursor: default; }
.md-test { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; padding: 0 0 6px 2px; font-size: 12px; color: var(--fg2); min-width: 0; }
.md-test[hidden] { display: none; }
.md-test > svg { color: var(--ok-fg); flex: none; }
.md-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-via { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: var(--muted); flex: none; }
.md-foot { margin: 10px 0 0; font-size: 12px; }
`;
