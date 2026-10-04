// public/attach.js — files that ride along with a prompt. A prompt box gets a
// paperclip, takes pasted files and dropped ones, and shows what is attached
// in a small tray above the text. Images go as images (big ones are scaled
// down to fit the API's limit), PDFs as documents, anything that reads as
// text is inlined. lib/agent.mjs turns them into content blocks.
import { h, svgUse } from './events.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_B64 = 5 * 1024 * 1024;       // the API's per-image limit, base64
const MAX_IMAGE_SIDE = 2048;                  // the model sees no more than this anyway
const MAX_PDF = 20 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_FILES = 20;
const TEXTISH = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|x-httpd-php|sql|toml|x-toml))/;

const kb = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const b64Len = (bytes) => Math.ceil(bytes / 3) * 4;

function readAs(blob, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('could not read the file'));
    how === 'url' ? r.readAsDataURL(blob) : r.readAsArrayBuffer(blob);
  });
}
const base64Of = async (blob) => { const u = await readAs(blob, 'url'); return u.slice(u.indexOf(',') + 1); };

/** Redraw an image no larger than MAX_IMAGE_SIDE, as PNG if that fits, else JPEG. */
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = (type, q) => new Promise((res) => c.toBlob(res, type, q));
  let out = file.type === 'image/png' ? await blob('image/png') : null;
  for (const q of [0.88, 0.75, 0.6]) {
    if (out && b64Len(out.size) <= MAX_IMAGE_B64) break;
    out = await blob('image/jpeg', q);
  }
  if (!out || b64Len(out.size) > MAX_IMAGE_B64) throw new Error('too large even scaled down');
  return out;
}

/** One file to { name, mediaType, data, size, url? }, or throws why it cannot go. */
async function prepare(file) {
  const name = file.name || (file.type.startsWith('image/') ? `pasted.${file.type.split('/')[1] || 'png'}` : 'pasted');
  if (file.type.startsWith('image/')) {
    let blob = file;
    // Scale down what is too big, and convert what the API does not take (HEIC, BMP, …) if the browser can decode it.
    if (!IMAGE_TYPES.includes(file.type) || b64Len(file.size) > MAX_IMAGE_B64) {
      try { blob = await shrink(file); }
      catch (e) { throw new Error(IMAGE_TYPES.includes(file.type) ? e.message : `${file.type} images cannot be read here`); }
    }
    return { name, mediaType: blob.type, data: await base64Of(blob), size: blob.size, url: URL.createObjectURL(blob) };
  }
  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF) throw new Error(`too large (${kb(file.size)}; PDFs up to ${kb(MAX_PDF)})`);
    return { name, mediaType: 'application/pdf', data: await base64Of(file), size: file.size };
  }
  // Anything else goes in as text if it reads as text: source files often come with no type at all.
  if (file.type && !TEXTISH.test(file.type)) throw new Error(`${file.type} files cannot be attached (images, PDFs and text can)`);
  if (file.size > MAX_TEXT) throw new Error(`too large for a text attachment (${kb(file.size)}; up to ${kb(MAX_TEXT)})`);
  const bytes = new Uint8Array(await readAs(file, 'buffer'));
  if (bytes.subarray(0, 8192).includes(0)) throw new Error('looks binary; only images, PDFs and text can be attached');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('is not UTF-8 text'); }
  return { name, mediaType: 'text/plain', data: await base64Of(file), size: file.size };
}

/**
 * Make a prompt box take attachments.
 *   input   the textarea (paste target, and what `enabled` follows)
 *   tray    element the attached files are listed in
 *   clip    the paperclip button; file the hidden <input type=file>
 *   drop    element that takes dropped files
 * Returns { files(), payload(), clear(), busy() }.
 */
export function attachable({ input, tray, clip, file, drop, toast }) {
  let list = [];
  let pending = 0;
  const enabled = () => !input.disabled;

  function render() {
    tray.hidden = !list.length && !pending;
    tray.replaceChildren(...list.map((a, i) => {
      const x = h('button', { type: 'button', class: 'att-x', 'aria-label': `Remove ${a.name}`, title: 'Remove', onclick: () => remove(i) }, svgUse('i-x', 10));
      const tip = `${a.name} · ${kb(a.size)}`;
      return a.url
        ? h('span', { class: 'att att-img', title: tip }, h('img', { src: a.url, alt: a.name }), x)
        : h('span', { class: 'att att-file', title: tip }, svgUse('i-clip', 11), h('span', { class: 'att-n' }, a.name), x);
    }), ...(pending ? [h('span', { class: 'att att-wait muted' }, 'reading…')] : []));
  }
  function remove(i) {
    const [a] = list.splice(i, 1);
    if (a?.url) URL.revokeObjectURL(a.url);
    render(); input.focus();
  }

  async function add(files) {
    files = [...files];
    if (!files.length) return;
    if (!enabled()) { toast('This session cannot take a prompt here.'); return; }
    if (list.length + files.length > MAX_FILES) { toast(`Up to ${MAX_FILES} attachments per prompt.`); files = files.slice(0, Math.max(0, MAX_FILES - list.length)); }
    pending += files.length; render();
    const errors = [];
    await Promise.all(files.map(async (f) => {
      try {
        const a = await prepare(f);
        if (list.reduce((n, x) => n + x.data.length, a.data.length) > MAX_TOTAL) throw new Error('would take this prompt past 40 MB');
        list.push(a);
      } catch (e) { errors.push(`${f.name || 'pasted file'}: ${e.message}`); }
      finally { pending--; render(); }
    }));
    if (errors.length) toast(errors.join(' · '));
  }

  clip.addEventListener('click', () => { if (enabled()) file.click(); });
  file.addEventListener('change', () => { add(file.files); file.value = ''; input.focus(); });

  // Pasted files win over the text that sometimes rides along (a Finder copy carries the name too).
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  drop.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !enabled()) return; e.preventDefault(); depth++; drop.classList.add('dropping'); });
  drop.addEventListener('dragover', (e) => { if (!hasFiles(e) || !enabled()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('dragleave', () => { if (depth && --depth === 0) drop.classList.remove('dropping'); });
  drop.addEventListener('drop', (e) => {
    depth = 0; drop.classList.remove('dropping');
    if (!hasFiles(e) || !enabled()) return;
    e.preventDefault(); e.stopPropagation();
    add(e.dataTransfer.files);
    input.focus();
  });

  return {
    files: () => list,
    busy: () => pending > 0,
    /** What the API takes: [{ name, mediaType, data }]. */
    payload: () => list.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    clear() { for (const a of list) if (a.url) URL.revokeObjectURL(a.url); list = []; render(); },
  };
}

/** A file dropped anywhere else would make the browser open it and leave the deck. */
export function guardWindowDrops() {
  const files = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => { if (files(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  window.addEventListener('drop', (e) => { if (files(e)) e.preventDefault(); });
}
