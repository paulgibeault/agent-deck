// lib/kokoro.mjs — Kokoro (82M, Apache-2.0) neural voices, generated on this
// machine: no account, and the text never leaves it.
//
// Optional. `npm run setup-voices` installs kokoro-js and the model into
// <deck state dir>/kokoro, outside the repo, which keeps its own
// dependencies at zero. Without it the deck offers no Kokoro voices.
//
// The model loads on first use (well under a second once downloaded, about
// 1 GB of memory) and unloads after a few idle minutes. Chunks are generated
// one at a time, several times faster than they play.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ClipCache } from './tts.mjs';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const IDLE_MS = 5 * 60_000;

/** The English voices worth offering (kokoro-js grades C and up), best first. */
export const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'en-US', 'Female'], ['af_bella', 'Bella', 'en-US', 'Female'],
  ['af_nicole', 'Nicole', 'en-US', 'Female'], ['bf_emma', 'Emma', 'en-GB', 'Female'],
  ['am_michael', 'Michael', 'en-US', 'Male'], ['am_fenrir', 'Fenrir', 'en-US', 'Male'],
  ['am_puck', 'Puck', 'en-US', 'Male'], ['af_kore', 'Kore', 'en-US', 'Female'],
  ['af_aoede', 'Aoede', 'en-US', 'Female'], ['af_sarah', 'Sarah', 'en-US', 'Female'],
  ['bm_george', 'George', 'en-GB', 'Male'], ['bm_fable', 'Fable', 'en-GB', 'Male'],
  ['bf_isabella', 'Isabella', 'en-GB', 'Female'],
].map(([id, name, locale, gender]) => ({ id, name, locale, gender }));
const IDS = new Set(KOKORO_VOICES.map(v => v.id));

export class KokoroTts {
  /** `load` replaces the real model (tests). */
  constructor({ dir, load = null, idleMs = IDLE_MS } = {}) {
    this.home = dir ? path.join(dir, 'kokoro') : null;
    this.load = load;
    this.idleMs = idleMs;
    this.model = null;
    this.idle = null;
    this.chain = Promise.resolve();
    this.cache = new ClipCache();
  }

  installed() { return !!this.load || (!!this.home && fs.existsSync(path.join(this.home, 'node_modules', 'kokoro-js', 'package.json'))); }
  status() { const installed = this.installed(); return { installed, loaded: !!this.model, voices: installed ? KOKORO_VOICES : [] }; }

  /** WAV audio for one chunk of text. */
  async synth({ text, voice, rate = 1 }) {
    if (!this.installed()) throw Object.assign(new Error('Kokoro voices are not installed (npm run setup-voices)'), { code: 409 });
    const t = String(text || '').slice(0, 3000);
    if (!t.trim() || !IDS.has(voice)) throw Object.assign(new Error('text and a Kokoro voice required'), { code: 400 });
    const speed = Math.min(2, Math.max(0.5, Number(rate) || 1));
    return this.cache.get(`kokoro\0${voice}\0${speed}\0${t}`, () =>
      this._run(async (m) => Buffer.from((await m.generate(t, { voice, speed })).toWav())));
  }

  async unload() {
    clearTimeout(this.idle);
    const m = this.model; this.model = null;
    try { await m?.model?.dispose?.(); } catch { /* already gone */ }
  }

  /** One generation at a time; the model loads on demand and unloads when idle. */
  _run(fn) {
    const p = this.chain.then(async () => {
      clearTimeout(this.idle);
      try { return await fn(await this._model()); }
      finally { this.idle = setTimeout(() => this.unload(), this.idleMs); this.idle.unref?.(); }
    });
    this.chain = p.catch(() => {});
    return p;
  }

  async _model() {
    if (this.model) return this.model;
    try { this.model = await (this.load ? this.load() : this._import()); }
    catch (e) { throw Object.assign(new Error(`Kokoro failed to load: ${e.message}`), { code: 502 }); }
    return this.model;
  }

  async _import() {
    const entry = createRequire(path.join(this.home, 'package.json')).resolve('kokoro-js');
    const { KokoroTTS } = await import(pathToFileURL(entry).href);
    return KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'cpu' });
  }
}
