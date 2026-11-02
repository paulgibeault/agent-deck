// public/vault.js — the Vault (lib/vault.mjs) in the deck: a menu entry that
// lists what's in it, opens its files and starts sessions inside it, and a save
// glyph beside every file and image in the details pane. Registers itself; app.js only imports it.
import { h, ib, svgUse, flashDone, ago, basename, registerFileAction } from './events.js';
import { registerMenuItem } from './menu.js';
import { fileKind, glyph, renderFileView } from './files.js';

let warning = null;   // set when a remote has appeared on the Vault
let vaultDir = null;
async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let out = null; try { out = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(out?.error || `${r.status} ${path}`);
  return out;
}
function toast(msg, action = null) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  if (action) t.append(h('button', { type: 'button', onclick: () => { action.fn(); t.remove(); } }, action.label));
  document.body.append(t); setTimeout(() => t.remove(), action ? 6000 : 3000);
}
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
const inVault = (p) => vaultDir && String(p || '').startsWith(vaultDir + '/');
call('/api/vault?status=1').then(s => { warning = s.warning; vaultDir = s.dir; }).catch(() => {});

// ------------------------------------------------------------ saving
// Text past this goes by path instead (the file as it is now), to stay under the request limit.
const CONTENT_MAX = 6 << 20;
async function save(target, btn) {
  const { label, ...body } = target;
  if (body.content != null && body.content.length > CONTENT_MAX) delete body.content;
  try {
    const r = await call('/api/vault/save', body);
    flashDone(btn);
    warning = r.warning;
    if (r.warning) toast(r.warning);
    else toast(`Saved to the Vault as ${r.rel}${r.meta?.source?.via === 'disk-now' ? ' (the file as it is now)' : ''}`, { label: 'Show', fn: () => openVault(r.rel) });
  } catch (e) { toast(`Save to Vault failed: ${e.message}`); }
}
// Not on files already in the Vault: saving one again would only copy it.
registerFileAction((target) => inVault(target.path) ? null
  : ib('i-vault', target.image != null ? `Save ${target.label || 'image'} to the Vault` : target.content != null ? 'Save to the Vault (as shown here)' : 'Save to the Vault', (e) => save(target, e.currentTarget), { size: 13 }));

// ------------------------------------------------------------ the Vault dialog
let dlg = null;
function dialog() {
  if (dlg) return dlg;
  dlg = h('dialog', { class: 'dialog wide history vault', 'aria-labelledby': 'vault-t' });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  return dlg;
}

/** Start a session in `dir` through the deck's own launch dialog, without making `dir` the default folder. */
function launchIn(dir) {
  dlg?.close();
  document.getElementById('new-btn')?.click();
  const cwd = document.getElementById('ns-cwd');
  if (!cwd) return;
  cwd.value = dir;
  cwd.dataset.once = '1';   // app.js leaves prefs.launchCwd as it was
  cwd.dispatchEvent(new Event('change'));   // so launch sections (worktrees, workstreams) follow the folder
  document.getElementById('ns-prompt')?.focus();
}
async function scratch() {
  try { launchIn((await call('/api/vault/scratch', {})).dir); } catch (e) { toast(`No scratch folder: ${e.message}`); }
}

// Media goes by URL; anything else needs its text.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|mp3|wav|ogg|m4a|flac|mp4|webm|mov)$/i;
/**
 * A file ({ path, rel }) in the deck's file view, inside the Vault's dialog; ←
 * goes back to the list. Home (home.js) opens its files here too, without ←.
 */
export async function openFile(it, v = null, { back = true } = {}) {
  const d = dialog();
  let f;
  try { f = await call(`/api/file?path=${encodeURIComponent(it.path)}${MEDIA_EXT.test(it.path) ? '&meta=1' : ''}`); } catch (e) { f = { error: e.message }; }
  const ctx = { api: { openEditor: (p, line) => call('/api/open-editor', { path: p, line }).catch(e => toast(`Open in editor failed: ${e.message}`)) } };
  d.classList.add('vf');
  d.replaceChildren(h('div', { class: 'hist-f' },
    h('div', { class: 'hist-h' }, back ? ib('i-left', 'Back to the Vault', () => openVault(it.rel, v), { size: 13 }) : null,
      h('span', { class: 'muted' }, it.rel), h('span', { class: 'spacer' }), ib('i-x', 'Close (Esc)', () => d.close(), { size: 12 })),
    h('div', { class: 'vault-fv' }, renderFileView({ ...f, abs: it.path, rel: it.rel }, ctx))));
  if (!d.open) d.showModal();
}

function row(it, flash, v) {
  const depth = it.rel.split('/').length - 1;
  const name = basename(it.rel);
  if (it.dir) {
    return h('li', { class: `hist-row vault-row dir${it.heavy ? ' heavy' : ''}`, style: `--d:${depth}`, title: it.heavy ? `${tilde(it.path)}\nnot listed: build output or dependencies` : tilde(it.path) },
      glyph('dir', !it.heavy), h('span', { class: 't' }, h('span', { class: 'tt' }, name)), h('span', {}),
      it.heavy ? h('span', {}) : ib('i-play', `Start a session in ${it.rel}`, () => launchIn(it.path), { size: 12 }));
  }
  const m = it.meta;
  const src = m?.source || {};
  const tip = [it.rel, m?.title && m.title !== name ? m.title : null, src.path ? `from ${tilde(src.path)}` : null, src.via === 'disk-now' ? 'as the file was when saved, not as the event showed it' : null,
    src.sessionId ? `session ${src.sessionId}` : null, m?.savedAt ? `saved ${new Date(m.savedAt).toLocaleString()}` : 'made in the Vault', m?.sha256 ? `sha256 ${m.sha256.slice(0, 12)}` : null].filter(Boolean).join('\n');
  const when = m?.savedAt ? Date.parse(m.savedAt) : it.mtime;
  return h('li', { class: `hist-row vault-row file${it.rel === flash ? ' cur' : ''}`, style: `--d:${depth}`, title: tip, onclick: () => openFile(it, v) },
    glyph(fileKind(name)),
    h('span', { class: 't' }, h('span', { class: 'tt' }, name)),
    m ? h('span', { class: 'vault-src', title: 'saved with a note of where it came from' }, svgUse('i-link', 11)) : h('span', {}),
    h('span', { class: 'r' }, when ? ago(Date.now() - when) : ''));
}

async function openVault(flash = null, cached = null) {
  const d = dialog();
  d.classList.remove('vf');
  let v = cached;
  if (!v) { try { v = await call('/api/vault'); } catch (e) { toast(`Vault: ${e.message}`); return; } }
  warning = v.warning; vaultDir = v.dir;
  const files = v.items.filter(x => !x.dir).length;
  d.replaceChildren(h('div', { class: 'hist-f' },
    h('div', { class: 'hist-h' },
      h('h2', { id: 'vault-t', title: `${tilde(v.dir)}\nLocal only: a git repo with no remote` }, svgUse('i-vault', 15), ' Vault'),
      h('span', { class: 'muted', title: v.log.map(c => `${c.sha} ${c.subject}`).join('\n') || null }, files ? `${files}${v.truncated ? '+' : ''}` : ''),
      h('span', { class: 'spacer' }),
      ib('i-plus', 'New scratch session in the Vault', scratch, { size: 13 }),
      ib('i-play', 'Start a session in the Vault', () => launchIn(v.dir), { size: 12 }),
      ib('i-x', 'Close (Esc)', () => d.close(), { size: 12 })),
    v.warning ? h('div', { class: 'note err vault-warn' }, svgUse('i-alert', 12), ' ', v.warning) : null,
    h('ul', { class: 'hist-list vault-list', 'aria-label': 'Vault contents' },
      v.items.length ? v.items.map(it => row(it, flash, v))
        : h('li', { class: 'hist-empty muted' }, 'Nothing here yet. Save a file with the vault glyph in the details pane, or start a scratch session.'),
      v.truncated ? h('li', { class: 'hist-empty muted vault-trunc' }, `Showing the first ${v.items.length} entries. Start a session in the Vault, or open its folder, to see the rest.`) : null)));
  if (!d.open) d.showModal();
  d.querySelector('.vault-row.cur')?.scrollIntoView({ block: 'nearest' });
}

registerMenuItem({ group: 'vault', order: 60, text: 'Vault', fn: () => openVault(),
  icon: () => h('span', { class: warning ? 'vault-ic warn' : 'vault-ic', title: warning || null }, svgUse(warning ? 'i-alert' : 'i-vault', 13)) });
