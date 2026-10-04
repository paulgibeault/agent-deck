import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileKind, fuzzy } from '../public/files.js';
import { markdown } from '../public/events.js';
import { listDir, allFiles, within } from '../lib/filetree.mjs';

test('fileKind picks a view for each kind of file', () => {
  const want = { 'README.md': 'markdown', 'package.json': 'json', '.env.local': 'env', 'logo.PNG': 'image', 'icon.svg': 'svg', 'Makefile': 'code',
    'app.tsx': 'code', 'data.tsv': 'csv', 'LICENSE': 'text', 'config.yaml': 'config', 'yarn.lock': 'config', 'doc.pdf': 'pdf', 'a.zip': 'archive' };
  for (const [f, k] of Object.entries(want)) assert.equal(fileKind(f), k, f);
  assert.equal(fileKind('src', true), 'dir');
});

test('fuzzy favours file names and segment starts', () => {
  assert.equal(fuzzy('zz', 'public/app.js'), null);
  const a = fuzzy('evjs', 'public/events.js'), b = fuzzy('evjs', 'lib/everything/vendor/jquery.js');
  assert.ok(a && b && a.score > b.score);
  assert.deepEqual(fuzzy('ap', 'public/app.js').hits, [7, 8]);
});

test('markdown resolves images and relative links only when asked', () => {
  const opts = { soft: true, img: (s) => `/raw?p=${s}`, link: (h) => `/abs/${h}` };
  const html = markdown('See ![logo](img/a.png) and [plan](PLAN.md).\nSame paragraph.\n\n- [x] done\n- [ ] todo\n\n<https://x.dev/a>', opts);
  assert.match(html, /<img src="\/raw\?p=img\/a\.png" alt="logo"/);
  assert.match(html, /<a href="#" data-abs="\/abs\/PLAN\.md"/);
  assert.match(html, /\. Same paragraph/);               // soft wrap joins lines
  assert.match(html, /<li class="task"><input type="checkbox" disabled checked> done/);
  assert.match(html, /<a href="https:\/\/x\.dev\/a"/);
  const chat = markdown('a\nb ![x](y.png) [p](q.md)');
  assert.match(chat, /a<br>b x p/);                      // no resolver: plain text, hard breaks
});

test('filetree lists one level, flags git state, and stays inside the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tree-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'x');
  fs.writeFileSync(path.join(dir, 'b.md'), '# b'); fs.writeFileSync(path.join(dir, 'A.txt'), 'a');
  const r = await listDir(dir, '');
  assert.deepEqual(r.entries.map(e => e.name), ['src', 'A.txt', 'b.md']); // folders first, natural order
  assert.equal(r.entries[0].dir, true);
  assert.deepEqual((await listDir(dir, 'src')).entries.map(e => e.path), ['src/a.js']);
  assert.ok((await listDir(dir, '../')).error);
  assert.equal(within(dir, '../../etc'), null);
  assert.deepEqual((await allFiles(dir)).files.sort(), ['A.txt', 'b.md', 'src/a.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});
