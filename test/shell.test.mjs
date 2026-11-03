// The pilot shell (lib/shell.mjs): output streams while a command runs, even
// from programs that buffer when stdout is a pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellRunner, ttyText, PTY } from '../lib/shell.mjs';

/** Run cmd; resolves { out, err, code, signal, firstAt, exitAt } (ms since start). */
function run(cmd, { killAfter } = {}) {
  const s = new ShellRunner();
  const t0 = Date.now();
  return new Promise((resolve) => {
    const r = { out: '', err: '', firstAt: null };
    const id = s.run({ cmd }).id;
    s.on('output', (o) => { if (o.runId !== id) return; r.firstAt ??= Date.now() - t0; r[o.stream === 'stderr' ? 'err' : 'out'] += o.chunk; });
    s.on('exit', (e) => { if (e.runId === id) resolve({ ...r, code: e.code, signal: e.signal, exitAt: Date.now() - t0 }); });
    if (killAfter) setTimeout(() => s.kill(id), killAfter);
  });
}

test('ttyText: drops the EOF echo, even split across chunks, and turns \\r\\n into \\n', () => {
  const t = ttyText();
  assert.equal(t.feed('^D'), '');
  assert.equal(t.feed('\b\bhello\r'), 'hello');
  assert.equal(t.feed('\nworld\r\n'), '\nworld\n');
  assert.equal(t.feed('^D later is kept'), '^D later is kept');
  assert.equal(ttyText().feed('no echo\r\n'), 'no echo\n');
});

test('a buffering program streams before it exits', { skip: !PTY && 'no pty on this platform' }, async () => {
  const r = await run(`python3 -c "import time
for i in range(3): print('line', i); time.sleep(0.4)"`);
  assert.equal(r.out, 'line 0\nline 1\nline 2\n');
  assert.ok(r.firstAt < r.exitAt - 500, `first output at ${r.firstAt}ms, exit at ${r.exitAt}ms`);
});

test('stderr stays its own stream; exit codes, quoting and end of input are as before', { skip: !PTY && 'no pty on this platform' }, async () => {
  const r = await run(`echo "it's" out; echo oops >&2; cat; exit 3`);
  assert.equal(r.out, "it's out\n");
  assert.equal(r.err, 'oops\n');
  assert.equal(r.code, 3);
});

test('a command that is stopped ends', async () => {
  const r = await run('sleep 30; echo never', { killAfter: 300 });
  assert.equal(r.out, '');
  assert.ok(r.exitAt < 5000);
});
