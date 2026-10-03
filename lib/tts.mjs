// lib/tts.mjs — Microsoft neural voices through Azure AI Speech (the
// documented REST API), for browsers that cannot reach them themselves.
//
// The key and region come from AZURE_SPEECH_KEY / AZURE_SPEECH_REGION, or from
// <deck state dir>/tts.json (0600), which the page can set but never read
// back. Audio is cached by voice, rate and text, so a replay or a seek within
// an item costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const VOICES_TTL_MS = 24 * 3600_000;
const CACHE_MAX_BYTES = 48 << 20;
const FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const xml = (s) => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** SSML for one chunk. `rate` is a multiplier (1 = normal). */
export function ssml(text, voice, rate = 1) {
  const lang = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice)?.[1] || 'en-US';
  const pct = Math.round((Number(rate) || 1) * 100 - 100);
  const body = pct ? `<prosody rate="${pct > 0 ? '+' : ''}${pct}%">${xml(text)}</prosody>` : xml(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xml(voice)}">${body}</voice></speak>`;
}

export class AzureTts {
  constructor({ dir, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.file = dir ? path.join(dir, 'tts.json') : null;
    this.fetch = fetchImpl;
    this.cfg = { key: env.AZURE_SPEECH_KEY || null, region: env.AZURE_SPEECH_REGION || null, fromEnv: !!env.AZURE_SPEECH_KEY };
    if (!this.cfg.key && this.file) {
      try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.cfg = { key: d.key || null, region: d.region || null, fromEnv: false }; } catch { /* not set up */ }
    }
    this.voiceList = null;   // { at, voices }
    this.cache = new Map();  // hash -> Buffer, oldest first
    this.cacheBytes = 0;
  }

  configured() { return !!(this.cfg.key && this.cfg.region); }
  status() { return { configured: this.configured(), region: this.cfg.region, fromEnv: this.cfg.fromEnv }; }

  _base() { return `https://${this.cfg.region}.tts.speech.microsoft.com/cognitiveservices`; }
  _headers(extra = {}) { return { 'Ocp-Apim-Subscription-Key': this.cfg.key, 'User-Agent': 'agent-deck', ...extra }; }

  /** Check a key and region against the voice list, then keep them. */
  async configure({ key, region }) {
    if (this.cfg.fromEnv) throw new Error('the Azure key is set by AZURE_SPEECH_KEY; change it there');
    if (!key && !region) {
      this.cfg = { key: null, region: null, fromEnv: false }; this.voiceList = null;
      if (this.file) try { fs.unlinkSync(this.file); } catch { /* already gone */ }
      return this.status();
    }
    const prev = this.cfg;
    this.cfg = { key: String(key || prev.key || '').trim(), region: String(region || '').trim().toLowerCase(), fromEnv: false };
    this.voiceList = null;
    try { await this.voices(); }
    catch (e) { this.cfg = prev; throw e; }
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ key: this.cfg.key, region: this.cfg.region }) + '\n', { mode: 0o600 });
    }
    return this.status();
  }

  /** [{ id, name, locale, gender, multilingual }] */
  async voices() {
    if (!this.configured()) return [];
    if (this.voiceList && Date.now() - this.voiceList.at < VOICES_TTL_MS) return this.voiceList.voices;
    const r = await this.fetch(`${this._base()}/voices/list`, { headers: this._headers() });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Azure rejected the key (check the key and region)' : `Azure voice list failed: HTTP ${r.status}`);
    const list = await r.json();
    const voices = list.filter(v => v.VoiceType === 'Neural' || !v.VoiceType).map(v => ({
      id: v.ShortName, name: v.DisplayName || v.LocalName || v.ShortName, locale: v.Locale, gender: v.Gender || null,
      multilingual: /Multilingual/.test(v.ShortName),
    }));
    this.voiceList = { at: Date.now(), voices };
    return voices;
  }

  /** MP3 audio for one chunk of text. */
  async synth({ text, voice, rate = 1 }) {
    if (!this.configured()) throw Object.assign(new Error('Azure voices are not set up'), { code: 409 });
    const t = String(text || '').slice(0, 3000);
    if (!t.trim() || !voice) throw Object.assign(new Error('text and voice required'), { code: 400 });
    const key = createHash('sha1').update(`${voice}\0${rate}\0${t}`).digest('hex');
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    const r = await this.fetch(`${this._base()}/v1`, {
      method: 'POST', body: ssml(t, voice, rate),
      headers: this._headers({ 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': FORMAT }),
    });
    if (!r.ok) throw Object.assign(new Error(r.status === 401 || r.status === 403 ? 'Azure rejected the key' : r.status === 429 ? 'Azure speech is rate limited' : `Azure speech failed: HTTP ${r.status}`), { code: 502 });
    const buf = Buffer.from(await r.arrayBuffer());
    this.cache.set(key, buf); this.cacheBytes += buf.length;
    for (const [k, b] of this.cache) { if (this.cacheBytes <= CACHE_MAX_BYTES) break; this.cache.delete(k); this.cacheBytes -= b.length; }
    return buf;
  }
}
