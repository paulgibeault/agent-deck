import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, forSpeech, codeSay, introFor, SpeechQueue } from '../public/speech.js';

const parts = (s) => splitSentences(s).map(({ start, end }) => s.slice(start, end));

test('splitSentences cuts at sentence ends and keeps abbreviations and file names whole', () => {
  assert.deepEqual(parts('Tests pass. Next I will push!  Done?'), ['Tests pass.', 'Next I will push!', 'Done?']);
  assert.deepEqual(parts('Use a flag, e.g. --force here. Then stop.'), ['Use a flag, e.g. --force here.', 'Then stop.']);
  assert.deepEqual(parts('Edited app.js and v1.2 notes.'), ['Edited app.js and v1.2 notes.']);
  assert.deepEqual(parts('He said "ok." Then left.'), ['He said "ok."', 'Then left.']);
  assert.deepEqual(parts('   '), []);
});

test('splitSentences breaks an overlong sentence near a comma', () => {
  const s = Array.from({ length: 40 }, (_, i) => `item number ${i}`).join(', ') + '.';
  const ch = splitSentences(s);
  assert.ok(ch.length > 1);
  for (const c of ch) assert.ok(c.end - c.start <= 320);
  // Offsets stay in order and cover the text without overlap.
  for (let i = 1; i < ch.length; i++) assert.ok(ch[i].start >= ch[i - 1].end);
});

test('forSpeech shortens links and paths and drops markdown marks', () => {
  assert.equal(forSpeech('See https://www.github.com/a/b/pull/3 now'), 'See github.com now');
  assert.equal(forSpeech('Changed /Users/me/work/deck/public/app.js today'), 'Changed app.js today');
  assert.equal(forSpeech('**Bold** and `code` — fine'), 'Bold and code, fine');
  assert.equal(forSpeech('a/b is fine'), 'a/b is fine');
});

test('codeSay counts lines', () => {
  assert.equal(codeSay('a\nb\nc\n'), 'code block, 3 lines');
  assert.equal(codeSay('x'), 'code');
});

test('introFor names the session, the reason and what was skipped', () => {
  assert.equal(introFor({ kind: 'said', title: 'Release check' }), 'Release check.');
  assert.equal(introFor({ kind: 'said', title: 'Release check' }, 3), 'Release check. 3 earlier updates skipped.');
  assert.equal(introFor({ kind: 'needs', title: 'X', permission: true }), 'X needs your permission.');
  assert.equal(introFor({ kind: 'error', title: 'X' }, 1), 'X hit an error. 1 earlier update skipped.');
});

test('SpeechQueue: first in first out, high priority goes to the top behind earlier high ones', () => {
  const q = new SpeechQueue();
  q.push({ id: 1, sessionId: 'a', kind: 'said' });
  q.push({ id: 2, sessionId: 'b', kind: 'said' });
  q.push({ id: 3, sessionId: 'c', kind: 'needs', priority: 'high' });
  q.push({ id: 4, sessionId: 'd', kind: 'needs', priority: 'high' });
  assert.deepEqual(q.items.map(x => x.id), [3, 4, 1, 2]);
});

test('SpeechQueue.next collapses a session to its newest item of the same kind', () => {
  const q = new SpeechQueue();
  q.push({ id: 1, sessionId: 'a', kind: 'said' });
  q.push({ id: 2, sessionId: 'b', kind: 'said' });
  q.push({ id: 3, sessionId: 'a', kind: 'said' });
  q.push({ id: 4, sessionId: 'a', kind: 'done' });
  q.push({ id: 5, sessionId: 'a', kind: 'said' });
  const r = q.next();
  assert.equal(r.item.id, 5);
  assert.equal(r.skipped, 2);
  assert.deepEqual(q.items.map(x => x.id), [2, 4]);
});

test('SpeechQueue.next without latest plays everything in order', () => {
  const q = new SpeechQueue();
  q.push({ id: 1, sessionId: 'a', kind: 'said' });
  q.push({ id: 2, sessionId: 'a', kind: 'said' });
  assert.equal(q.next({ latest: false }).item.id, 1);
  assert.equal(q.next({ latest: false }).item.id, 2);
  assert.equal(q.next(), null);
});

test('SpeechQueue.resume puts an interrupted item first and it is not collapsed', () => {
  const q = new SpeechQueue();
  q.push({ id: 1, sessionId: 'a', kind: 'said', priority: 'high' });
  q.push({ id: 2, sessionId: 'a', kind: 'said' });
  q.resume({ id: 0, sessionId: 'a', kind: 'said' }, 4);
  const r = q.next();
  assert.equal(r.item.id, 0);
  assert.equal(r.item.at, 4);
  assert.equal(r.skipped, 0);
  // New high-priority items queue behind the resumed one.
  q.resume({ id: 9, sessionId: 'z', kind: 'said' }, 1);
  q.push({ id: 7, sessionId: 'y', kind: 'needs', priority: 'high' });
  assert.deepEqual(q.items.map(x => x.id), [9, 1, 7, 2]);
});

// ------------------------------------------------------------ lib/tts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AzureTts, ssml } from '../lib/tts.mjs';

test('ssml escapes text, takes the language from the voice and sets the rate', () => {
  const x = ssml('a < b & "c"', 'en-GB-SoniaNeural', 1.25);
  assert.match(x, /xml:lang="en-GB"/);
  assert.match(x, /<voice name="en-GB-SoniaNeural"><prosody rate="\+25%">a &lt; b &amp; &quot;c&quot;<\/prosody>/);
  assert.doesNotMatch(ssml('hi', 'en-US-AvaNeural', 1), /prosody/);
});

test('AzureTts keeps a working key (0600), caches audio, and never stores a rejected key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  let synths = 0;
  const fetchImpl = async (url, opts = {}) => {
    const ok = opts.headers['Ocp-Apim-Subscription-Key'] === 'good';
    if (url.endsWith('/voices/list')) return { ok, status: ok ? 200 : 401, json: async () => [{ ShortName: 'en-US-AvaMultilingualNeural', DisplayName: 'Ava', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' }] };
    synths++;
    return { ok, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const t = new AzureTts({ dir, fetchImpl, env: {} });
  assert.equal(t.configured(), false);
  await assert.rejects(t.configure({ key: 'bad', region: 'eastus' }), /rejected/);
  assert.equal(t.configured(), false);
  assert.equal(fs.existsSync(path.join(dir, 'tts.json')), false);
  assert.deepEqual(await t.configure({ key: 'good', region: 'EastUS' }), { configured: true, region: 'eastus', fromEnv: false });
  assert.equal(fs.statSync(path.join(dir, 'tts.json')).mode & 0o777, 0o600);
  assert.equal((await t.voices())[0].multilingual, true);
  const a = await t.synth({ text: 'hello', voice: 'en-US-AvaMultilingualNeural' });
  const b = await t.synth({ text: 'hello', voice: 'en-US-AvaMultilingualNeural' });
  assert.equal(a, b); assert.equal(synths, 1);
  // A fresh instance reads the saved key.
  assert.equal(new AzureTts({ dir, fetchImpl, env: {} }).configured(), true);
  await t.configure({});
  assert.equal(fs.existsSync(path.join(dir, 'tts.json')), false);
});
