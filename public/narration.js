// public/narration.js — the read-aloud player (PLAN.md §7).
//
// Items come in from the deck's live events (auto) or from Read aloud buttons
// (manual, which cut in). Each item is rendered the way the details pane
// renders text, cut into sentence chunks from that same DOM, and spoken one
// chunk at a time: the chunk being read is highlighted (CSS Custom Highlight
// API, no DOM changes), a click on any chunk restarts from there.
//
// Two engines: the browser's speechSynthesis (local voices, plus Microsoft's
// online voices when the deck runs in Edge) and Azure neural voices through
// the server (/api/tts). The queue rules live in speech.js.
import { h, markdown, highlightIn, svgUse } from './events.js';
import { SpeechQueue, splitSentences, forSpeech, codeSay, introFor } from './speech.js';

export const KINDS = [
  ['said', 'Said', 'Assistant messages'],
  ['needs', 'Needs you', 'Questions and permission prompts'],
  ['error', 'Errors', 'A session hit an error'],
  ['done', 'Finished', 'A session handed back'],
  ['brief', 'Brief updated', 'A new brief summary'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
const DEFAULTS = { scope: 'all', subagents: false, voice: '', rate: 1.1, events: { said: true, needs: false, error: false, done: false, brief: false }, length: 'full', latest: true };
const SHORT_CHARS = 600;
const LINGER_MS = 1500;
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dt, dd';

/** A second of silence. Playing it in a loop makes Chrome route media keys here while speechSynthesis talks. */
function silentWav() {
  const n = 8000, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const str = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

/**
 * Cut rendered content into chunks: [{ say, range, text, start }]. Text nodes
 * are grouped by their nearest block; each block's text splits into
 * sentences, each sentence becomes a DOM Range over the nodes it spans. A
 * code block is one chunk, said as "code block, N lines".
 */
function chunksOf(root) {
  const groups = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const pre = n.parentElement.closest('pre');
    if (pre && root.contains(pre)) {
      if (last?.pre !== pre) groups.push(last = { pre, nodes: [] });
      continue;
    }
    const block = n.parentElement.closest(BLOCKS);
    const owner = block && root.contains(block) ? block : root;
    if (last?.owner !== owner || last.pre) groups.push(last = { owner, nodes: [] });
    last.nodes.push(n);
  }
  const out = [];
  for (const g of groups) {
    if (g.pre) {
      const r = document.createRange(); r.selectNodeContents(g.pre);
      out.push({ say: codeSay(g.pre.textContent), range: r, text: '', start: 0 });
      continue;
    }
    const text = g.nodes.map(n => n.data).join('');
    const at = (pos) => {
      let i = 0;
      for (const n of g.nodes) { if (pos <= i + n.data.length) return [n, pos - i]; i += n.data.length; }
      const n = g.nodes.at(-1); return [n, n.data.length];
    };
    for (const s of splitSentences(text)) {
      const say = forSpeech(text.slice(s.start, s.end));
      if (!/[\p{L}\p{N}]/u.test(say)) continue;
      const r = document.createRange();
      r.setStart(...at(s.start)); r.setEnd(...at(s.end));
      out.push({ say, range: r, text: text.slice(s.start, s.end), start: s.start, at });
    }
  }
  return out;
}

const synth = globalThis.speechSynthesis || null;

export function createNarration({ prefs, savePrefs, api, host, isSubagent, inScope, titleOf, onChange, onJump, onWarn }) {
  const s = prefs.readAloud = { ...DEFAULTS, ...(prefs.readAloud || {}), events: { ...DEFAULTS.events, ...(prefs.readAloud?.events || {}) } };
  const queue = new SpeechQueue();
  const seen = new Set();
  let cur = null;          // { item, skipped, view, i, gen, engine }
  let lastView = null;     // the view still on screen after an item ends
  let gen = 0;
  let paused = false, held = false;
  let repause = false;     // paused when a Read aloud button played: pause again after it
  let leader = !navigator.locks;
  let blocked = !(navigator.userActivation?.hasBeenActive ?? true);
  let hideTimer = null;
  let soon = false;
  let azure = { configured: false, voices: [], region: null, error: null };

  // ---------------------------------------------------------- one speaking window
  navigator.locks?.request('agent-deck-narration', () => { leader = true; changed(); pump(); return new Promise(() => {}); });

  // ---------------------------------------------------------- autoplay
  // Chrome lets a page speak only after a user gesture.
  const unblock = () => {
    if (!blocked) return;
    blocked = false;
    if (cur && !paused) playChunk(); else pump();
    changed();
  };
  addEventListener('pointerdown', unblock, true);
  addEventListener('keydown', unblock, true);

  // ---------------------------------------------------------- voices
  const lang = (navigator.language || 'en').slice(0, 2);
  function browserVoices() {
    return (synth?.getVoices() || []).filter(v => v.lang.slice(0, 2) === lang);
  }
  synth?.addEventListener?.('voiceschanged', () => changed());
  function voiceList() {
    const local = [], online = [];
    for (const v of browserVoices()) (v.localService ? local : online).push({ id: `browser:${v.voiceURI}`, name: v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\).*/, ' (Natural)'), online: !v.localService });
    for (const v of azure.voices) if (v.locale.slice(0, 2) === lang || v.multilingual) online.push({ id: `azure:${v.id}`, name: `${v.name} · ${v.locale}${v.multilingual ? ' · multilingual' : ''}`, online: true, azure: true });
    return { local, online };
  }
  /** The voice to use: the saved pick if it still exists, else the best on offer. */
  function pickVoice() {
    const { local, online } = voiceList();
    const all = [...local, ...online];
    if (s.voice && all.some(v => v.id === s.voice)) return s.voice;
    const natural = online.find(v => !v.azure && /Natural/.test(v.name));
    const nice = local.find(v => /Premium|Enhanced/.test(v.name));
    const def = browserVoices().find(v => v.default);
    return natural?.id || nice?.id || (def ? `browser:${def.voiceURI}` : local[0]?.id || online[0]?.id || '');
  }
  async function loadAzure() {
    try { azure = await api.get('/api/tts/voices'); } catch (e) { azure = { configured: false, voices: [], error: e.message }; }
    changed();
  }
  loadAzure();

  // ---------------------------------------------------------- engines
  const audio = new Audio();
  const keepAlive = Object.assign(new Audio(silentWav()), { loop: true });
  const clips = new Map();   // text+voice+rate -> Promise<objectURL>
  let utter = null;          // keeps Chrome from collecting a live utterance (and its onend)

  function clip(text, voice) {
    const key = `${voice}\0${s.rate}\0${text}`;
    if (!clips.has(key)) {
      clips.set(key, fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate: s.rate }) })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `HTTP ${r.status}`); return URL.createObjectURL(await r.blob()); })
        .catch((e) => { clips.delete(key); throw e; }));
      if (clips.size > 200) { const [k, p] = clips.entries().next().value; clips.delete(k); p.then(URL.revokeObjectURL, () => {}); }
    }
    return clips.get(key);
  }

  /** Speak one chunk; resolves when it ends or is cancelled. Rejects { blocked } or { failed }. */
  async function speak(text, voiceId, onWord) {
    if (voiceId.startsWith('azure:')) {
      const url = await clip(text, voiceId.slice(6)).catch((e) => { throw Object.assign(e, { failed: true }); });
      audio.src = url;
      await new Promise((resolve, reject) => {
        audio.onended = audio.onpause = () => resolve();
        audio.onerror = () => reject(Object.assign(new Error('audio failed'), { failed: true }));
        audio.play().catch((e) => reject(Object.assign(e, e.name === 'NotAllowedError' ? { blocked: true } : { failed: true })));
      });
      return;
    }
    if (!synth) throw Object.assign(new Error('this browser has no speech synthesis'), { failed: true });
    const v = synth.getVoices().find(x => `browser:${x.voiceURI}` === voiceId) || null;
    if (keepAlive.paused) keepAlive.play().catch(() => {});
    await new Promise((resolve, reject) => {
      const u = utter = new SpeechSynthesisUtterance(text);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = s.rate;
      u.onboundary = (e) => { if (e.name === 'word') onWord?.(e.charIndex, e.charLength); };
      u.onend = () => resolve();
      u.onerror = (e) => e.error === 'not-allowed' ? reject(Object.assign(new Error('blocked'), { blocked: true }))
        : e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(Object.assign(new Error(e.error), { failed: true }));
      synth.speak(u);
    });
  }
  function hush() {
    if (!audio.paused) audio.pause();
    if (synth?.speaking || synth?.pending) synth.cancel();
  }

  // ---------------------------------------------------------- pane
  const title = h('button', { type: 'button', class: 'narr-t', title: 'Open this event (j)', onclick: () => onJump?.() });
  const kindChip = h('span', { class: 'chip' });
  const skipChip = h('span', { class: 'chip narr-skip' });
  const queued = h('span', { class: 'narr-q' });
  const body = h('div', { class: 'narr-body' });
  const pane = h('aside', { class: 'narr', 'aria-label': 'Read aloud', hidden: true },
    h('header', { class: 'narr-h' }, h('span', { class: 'narr-wave', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), title,
      h('span', { class: 'spacer' }), kindChip, skipChip, queued,
      h('button', { type: 'button', class: 'icon-btn sm ghost', 'aria-label': 'Stop reading aloud', title: 'Stop and clear the queue', onclick: () => stop() }, svgUse('i-x', 12))),
    body);
  host.append(pane);

  function showPane() {
    clearTimeout(hideTimer);
    if (!pane.hidden && pane.classList.contains('open')) return;
    pane.hidden = false;
    requestAnimationFrame(() => pane.classList.add('open'));
  }
  function hidePane() {
    pane.classList.remove('open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!pane.classList.contains('open')) { pane.hidden = true; body.replaceChildren(); lastView = null; } }, 200);
  }

  /** Render an item into the pane and cut it into chunks. */
  function buildView(item, skipped) {
    const content = h('div', { class: 'details' }, h('div', { class: 'dbody' },
      h('div', { class: 'md', html: markdown(item.markdown || item.text || '') })));
    highlightIn(content);
    title.textContent = item.title || 'A session';
    kindChip.textContent = item.manual ? 'Read aloud' : KIND_LABEL[item.kind] || item.kind;
    kindChip.className = `chip narr-k k-${item.kind}`;
    skipChip.textContent = skipped ? `${skipped} skipped` : '';
    skipChip.hidden = !skipped;
    const swap = !pane.hidden;
    body.replaceChildren(content);
    body.scrollTop = 0;
    if (swap) { body.classList.remove('swap'); void body.offsetWidth; body.classList.add('swap'); }
    const intro = document.createRange(); intro.selectNodeContents(title);
    let chunks = chunksOf(content);
    if (s.length === 'short' && !item.manual) {
      let n = 0, i = 0;
      while (i < chunks.length && n < SHORT_CHARS) n += chunks[i++].say.length;
      if (i < chunks.length) chunks = [...chunks.slice(0, i), { say: 'And more on screen.', range: null }];
    }
    return { item, skipped, chunks: [{ say: introFor(item, skipped), range: intro }, ...chunks] };
  }

  // ---------------------------------------------------------- highlight
  const hl = globalThis.CSS?.highlights;
  function mark(ch) {
    if (!hl) return;
    hl.delete('narr-word');
    if (!ch?.range) { hl.delete('narr'); return; }
    hl.set('narr', new Highlight(ch.range));
    const r = ch.range.getBoundingClientRect(), b = body.getBoundingClientRect();
    if (body.contains(ch.range.startContainer) && (r.top < b.top || r.bottom > b.bottom)) body.scrollTop += r.top - b.top - b.height / 3;
  }
  /** Word boundaries come as offsets into the spoken text; find that word in the chunk's own text. */
  function wordMarker(ch) {
    let from = 0;
    return (charIndex, len) => {
      if (!hl || !ch.at) return;
      const word = ch.say.slice(charIndex, charIndex + (len || (/\S+/.exec(ch.say.slice(charIndex))?.[0].length ?? 0))).replace(/^\W+|\W+$/g, '');
      if (!word) return;
      const pos = ch.text.indexOf(word, from);
      if (pos < 0) return;
      from = pos + word.length;
      const r = document.createRange();
      r.setStart(...ch.at(ch.start + pos)); r.setEnd(...ch.at(ch.start + pos + word.length));
      hl.set('narr-word', new Highlight(r));
    };
  }

  // Click a chunk to read from there (also after the item has ended).
  body.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const view = cur?.view || lastView;
    if (!view) return;
    const p = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const node = p ? p.offsetNode : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
    const off = p ? p.offset : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset;
    if (!node) return;
    const i = view.chunks.findIndex(ch => ch.range && body.contains(ch.range.startContainer) && ch.range.isPointInRange(node, off));
    if (i < 0) return;
    if (cur?.view === view) { seek(i); return; }
    if (cur) queue.resume({ ...cur.item, skipped: cur.skipped }, cur.i);
    begin(view, i);
  });

  // ---------------------------------------------------------- playback
  function pump() {
    if (cur || paused || blocked) { changed(); return; }
    const head = queue.items[0];
    if (!head || (held && !head.manual && !head.resume)) {
      changed();
      if (!head && !pane.hidden) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!cur && !queue.length) { mark(null); hidePane(); } }, LINGER_MS); }
      if (!head) { keepAlive.pause(); media('none'); }
      return;
    }
    if (repause && !head.manual) { repause = false; paused = true; media('paused'); changed(); return; }
    const n = queue.next({ latest: s.latest });
    begin(buildView(n.item, n.skipped), n.item.at || 0);
  }
  function begin(view, at = 0) {
    hush();
    cur = { item: view.item, skipped: view.skipped, view, i: at, gen: ++gen, voice: pickVoice() };
    lastView = view;
    showPane();
    paused = false;
    media('playing');
    playChunk();
  }
  async function playChunk() {
    const c = cur;
    if (!c || paused || blocked) return changed();
    if (c.i >= c.view.chunks.length) { cur = null; pump(); return; }
    const ch = c.view.chunks[c.i];
    const g = c.gen = ++gen;
    mark(ch);
    changed();
    if (c.voice.startsWith('azure:') && c.view.chunks[c.i + 1]) clip(c.view.chunks[c.i + 1].say, c.voice.slice(6)).catch(() => {});
    try { await speak(ch.say, c.voice, wordMarker(ch)); }
    catch (e) {
      if (cur !== c || c.gen !== g) return;
      if (e.blocked) { blocked = true; changed(); return; }
      // An online voice failed: the rest of this item uses a local one.
      if (c.voice.startsWith('azure:')) {
        onWarn?.(`Online voice failed (${e.message}); using a local voice`);
        const local = voiceList().local[0];
        if (local) { c.voice = local.id; playChunk(); return; }
      }
    }
    if (cur !== c || c.gen !== g || paused) return;
    c.i++;
    playChunk();
  }
  function seek(i) {
    if (!cur) return;
    hush();
    cur.i = Math.max(0, Math.min(i, cur.view.chunks.length - 1));
    paused = false;
    media('playing');
    playChunk();
  }

  // ---------------------------------------------------------- media keys
  function media(st) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = st;
    if (st === 'none') { ms.metadata = null; return; }
    if (cur) ms.metadata = new MediaMetadata({ title: cur.item.title || 'Agent Deck', artist: cur.item.manual ? 'Read aloud' : KIND_LABEL[cur.item.kind] || '', album: 'Agent Deck' });
  }
  if (navigator.mediaSession) {
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported action */ } };
    set('play', () => play());
    set('pause', () => pause());
    set('nexttrack', () => skip());
    set('stop', () => stop());
  }

  // ---------------------------------------------------------- public
  function changed() {
    queued.textContent = queue.length ? `${queue.length} queued` : '';
    pane.classList.toggle('playing', !!cur && !paused && !blocked);
    onChange?.(status());
  }
  function status() {
    return {
      state: blocked && (cur || queue.length) ? 'blocked' : paused ? 'paused' : cur ? 'playing' : queue.length ? (held ? 'held' : 'waiting') : 'idle',
      item: cur?.item || null, queued: queue.length, on: s.scope !== 'off', leader,
    };
  }
  function wants(item) {
    if (!leader || s.scope === 'off' || !s.events[item.kind]) return false;
    if (isSubagent(item.sessionId) && !s.subagents) return false;
    return s.scope === 'all' || inScope(item.sessionId);
  }
  /** An event from the live stream: queued if the settings want it. */
  function auto(item) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    item = { priority: item.kind === 'needs' ? 'high' : 'normal', title: titleOf(item.sessionId), ...item };
    if (!wants(item)) return;
    queue.push(item);
    // One SSE batch can carry several messages: queue them all before picking, so they collapse.
    if (!soon) { soon = true; queueMicrotask(() => { soon = false; pump(); }); }
  }
  /** A Read aloud button: plays now; what was playing resumes afterwards. */
  function read(item) {
    item = { title: titleOf(item.sessionId), ...item, manual: true, id: `manual:${Date.now()}` };
    if (cur) queue.resume({ ...cur.item, skipped: cur.skipped }, cur.i);
    if (paused) { repause = true; paused = false; }
    hush(); cur = null;
    queue.items.unshift(item);
    if (blocked) { blocked = false; }   // a click is the gesture
    pump();
  }
  /** Pausing with nothing playing is allowed: new items then wait in the queue until play. */
  function pause() { if (paused) return; paused = true; repause = false; gen++; hush(); keepAlive.pause(); media(cur ? 'paused' : 'none'); changed(); }
  function play() {
    if (blocked) { unblock(); return; }
    if (paused) { paused = false; if (cur) { media('playing'); playChunk(); } else pump(); return; }
    if (held) { held = false; }
    pump();
  }
  function toggle() { paused || (blocked && (cur || queue.length)) ? play() : pause(); }
  /** Next item. While paused, this drops what is on screen and stays paused. */
  function skip() {
    if (!cur && !queue.length) return;
    hush(); cur = null;
    if (paused) { mark(null); hidePane(); changed(); return; }
    pump();
  }
  function stop() { queue.clear(); hush(); cur = null; repause = false; gen++; mark(null); keepAlive.pause(); media('none'); hidePane(); changed(); }
  /** While the pilot types, new items wait; what is playing finishes. */
  function hold(on) { if (held === on) return; held = on; if (!on) pump(); else changed(); }
  function set(key, value) {
    if (key.startsWith('events.')) s.events[key.slice(7)] = value; else s[key] = value;
    savePrefs();
    if (key === 'scope' && value === 'off') { queue.clear(x => !x.manual); }
    if (key === 'voice' || key === 'rate') { if (cur) cur.voice = pickVoice(); }
    changed();
  }
  function preview() { read({ sessionId: null, title: 'Read aloud', kind: 'said', markdown: 'This is how narration will sound.' }); }

  // ---------------------------------------------------------- settings popover
  function renderSettings(el) {
    const radio = (name, value, label, checked, on) => h('label', { class: 'ra-opt' }, h('input', { type: 'radio', name, value, checked: checked || null, onchange: on }), label);
    const check = (label, checked, on, hint) => h('label', { class: 'ra-opt', title: hint || null }, h('input', { type: 'checkbox', checked: checked || null, onchange: (e) => on(e.target.checked) }), label);
    const { local, online } = voiceList();
    const cv = pickVoice();
    const sel = h('select', { class: 'field', onchange: (e) => { set('voice', e.target.value); renderSettings(el); } },
      local.length ? h('optgroup', { label: 'Local' }, ...local.map(v => h('option', { value: v.id, selected: v.id === cv || null }, v.name))) : null,
      online.length ? h('optgroup', { label: '☁ Online' }, ...online.map(v => h('option', { value: v.id, selected: v.id === cv || null }, `☁ ${v.name}`))) : null);
    const rate = h('input', { type: 'range', min: '0.7', max: '2', step: '0.05', value: String(s.rate), oninput: (e) => { set('rate', Number(e.target.value)); rateOut.textContent = `${s.rate.toFixed(2)}×`; } });
    const rateOut = h('span', { class: 'muted' }, `${s.rate.toFixed(2)}×`);
    const az = h('details', { class: 'ra-az' }, h('summary', {}, azure.configured ? `Azure voices: on (${azure.region})` : 'Add Microsoft voices (Azure)'));
    if (azure.fromEnv) az.append(h('p', { class: 'muted' }, 'Set by AZURE_SPEECH_KEY / AZURE_SPEECH_REGION.'));
    else {
      const key = h('input', { class: 'field', type: 'password', placeholder: azure.configured ? 'key (saved)' : 'Azure Speech key', autocomplete: 'off', spellcheck: 'false' });
      const region = h('input', { class: 'field', type: 'text', placeholder: 'region, e.g. eastus', value: azure.region || '', spellcheck: 'false' });
      const msg = h('p', { class: 'muted' }, azure.error || 'Neural voices from Azure AI Speech. The free tier covers 0.5M characters a month. The key stays on this machine.');
      const save = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        save.disabled = true; msg.textContent = 'Checking…';
        try { azure = await api.post('/api/tts/config', { key: key.value || undefined, region: region.value }); renderSettings(el); }
        catch (e) { msg.textContent = e.message; save.disabled = false; }
      } }, 'Save');
      const forget = azure.configured ? h('button', { type: 'button', class: 'btn', onclick: async () => { azure = await api.post('/api/tts/config', {}); if (s.voice.startsWith('azure:')) set('voice', ''); renderSettings(el); } }, 'Remove') : null;
      az.append(h('div', { class: 'ra-row' }, key), h('div', { class: 'ra-row' }, region, save, forget), msg);
    }
    el.replaceChildren(
      h('h3', {}, 'Read aloud'),
      h('div', { class: 'ra-g' }, h('div', { class: 'ra-l' }, 'Narrate'),
        h('div', { class: 'ra-seg' },
          radio('ra-scope', 'off', 'Off', s.scope === 'off', () => set('scope', 'off')),
          radio('ra-scope', 'session', 'This session', s.scope === 'session', () => set('scope', 'session')),
          radio('ra-scope', 'all', 'All sessions', s.scope === 'all', () => set('scope', 'all'))),
        check('Include subagents', s.subagents, (v) => set('subagents', v), 'Also read what subagents say')),
      h('div', { class: 'ra-g' }, h('div', { class: 'ra-l' }, 'Voice'),
        h('div', { class: 'ra-row' }, sel, h('button', { type: 'button', class: 'ib', 'aria-label': 'Preview the voice', title: 'Preview', onclick: preview }, svgUse('i-play', 13))),
        h('div', { class: 'ra-row' }, h('span', { class: 'ra-l2' }, 'Speed'), rate, rateOut), az),
      h('div', { class: 'ra-g' }, h('div', { class: 'ra-l' }, 'Read'),
        ...KINDS.map(([k, l, hint]) => check(l, s.events[k], (v) => set(`events.${k}`, v), hint))),
      h('div', { class: 'ra-g' }, h('div', { class: 'ra-l' }, 'Queue'),
        check('Skip to the latest per session', s.latest, (v) => set('latest', v), 'When a session has several updates waiting, read only the newest and say how many were skipped'),
        h('div', { class: 'ra-seg' },
          radio('ra-len', 'full', 'Read in full', s.length === 'full', () => set('length', 'full')),
          radio('ra-len', 'short', 'First ~600 characters', s.length === 'short', () => set('length', 'short')))),
      h('p', { class: 'ra-keys muted' }, h('kbd', {}, 'Space'), ' play/pause · ', h('kbd', {}, ']'), ' next · ', h('kbd', {}, 'j'), ' open the event · ', h('kbd', {}, 'r'), ' read the selection'));
  }

  return { auto, read, play, pause, toggle, skip, stop, hold, status, renderSettings, reloadVoices: loadAzure, current: () => cur?.item || lastView?.item || null, settings: s };
}
