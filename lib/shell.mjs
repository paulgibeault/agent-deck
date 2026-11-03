// lib/shell.mjs — the pilot's live shell: a command runner, not a terminal.
// Each run spawns `$SHELL -c cmd` in a chosen cwd and streams stdout/stderr.
//
// On macOS stdout is a pseudo-terminal (`script -q /dev/null …`): with a plain
// pipe, anything built on C stdio (python, grep, awk, sed) holds its output
// until it exits, and the run looks blank. stderr stays its own stream, passed
// out on fd 3. The terminal's stdin is at end-of-input from the start (as
// /dev/null was), which `script` echoes as "^D\b\b"; that and the terminal's
// \r\n line ends are taken out again.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const SCRIPT = '/usr/bin/script';
export const PTY = process.platform === 'darwin' && fs.existsSync(SCRIPT);
const EOF_ECHO = '^D\b\b';

const MAX_RUN_BUFFER = 2 * 1024 * 1024;   // per run, kept for reconnects
const MAX_HISTORY = 50;

/**
 * The terminal's output as a pipe would have given it: without the leading
 * EOF echo, with \n line ends. Holds back only what a chunk boundary may have
 * split (the echo's first bytes, a trailing \r).
 */
export function ttyText() {
  let lead = true, held = '';
  return {
    feed(chunk) {
      let t = held + chunk; held = '';
      if (lead) {
        if (t.length < EOF_ECHO.length && EOF_ECHO.startsWith(t)) { held = t; return ''; }
        if (t.startsWith(EOF_ECHO)) t = t.slice(EOF_ECHO.length);
        lead = false;
      }
      if (t.endsWith('\r')) { held = '\r'; t = t.slice(0, -1); }
      return t.replace(/\r\n/g, '\n');
    },
    flush() { const t = held; held = ''; return t; },
  };
}

export class ShellRunner extends EventEmitter {
  /** pty: run under a pseudo-terminal (default: on macOS). */
  constructor({ pty = PTY } = {}) {
    super();
    this.pty = pty;
    this.runs = new Map();     // runId -> { id, cmd, cwd, startedAt, chunks[], bytes, code, signal, child }
    this.order = [];
  }

  run({ cmd, cwd }) {
    const id = randomBytes(6).toString('hex');
    const isWin = process.platform === 'win32';
    const shell = process.env.SHELL || (isWin ? 'cmd.exe' : '/bin/sh');
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    const run = { id, cmd, cwd, startedAt: Date.now(), chunks: [], bytes: 0, code: null, signal: null, child: null, endedAt: null };
    this.runs.set(id, run);
    this.order.push(id);
    while (this.order.length > MAX_HISTORY) this.runs.delete(this.order.shift());

    let child;
    try {
      // A terminal would start a pager (git log) that waits for keys nobody can press.
      const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', ...(this.pty ? { PAGER: 'cat', GIT_PAGER: 'cat' } : {}) };
      child = this.pty
        // $0 and $1 carry the shell and the command, so the command is parsed by $SHELL as before.
        ? spawn(SCRIPT, ['-q', '/dev/null', '/bin/sh', '-c', 'exec 2>&3; exec "$0" -c "$1"', shell, cmd], { cwd: cwd || os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
        : spawn(shell, args, { cwd: cwd || os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      run.code = -1; run.endedAt = Date.now();
      this.emit('output', { runId: id, stream: 'stderr', chunk: String(e.message) });
      this.emit('exit', { runId: id, code: -1, signal: null, durationMs: 0 });
      return run;
    }
    run.child = child;
    const emit = (stream, chunk) => {
      if (!chunk) return;
      if (run.bytes < MAX_RUN_BUFFER) { run.chunks.push({ stream, chunk }); run.bytes += chunk.length; }
      this.emit('output', { runId: id, stream, chunk });
    };
    const push = (stream) => (buf) => emit(stream, buf.toString('utf8'));
    if (this.pty) {
      const tty = ttyText();
      child.stdout.on('data', (buf) => emit('stdout', tty.feed(buf.toString('utf8'))));
      child.stdout.on('end', () => emit('stdout', tty.flush()));
      child.stdio[3].on('data', push('stderr'));
    } else child.stdout.on('data', push('stdout'));
    child.stderr.on('data', push('stderr'));
    child.on('error', (e) => { this.emit('output', { runId: id, stream: 'stderr', chunk: `spawn error: ${e.message}\n` }); });
    child.on('close', (code, signal) => {
      run.code = code; run.signal = signal; run.endedAt = Date.now(); run.child = null;
      this.emit('exit', { runId: id, code, signal, durationMs: run.endedAt - run.startedAt });
    });
    return run;
  }

  kill(runId) {
    const run = this.runs.get(runId);
    if (!run?.child) return false;
    try { run.child.kill('SIGTERM'); } catch { return false; }
    setTimeout(() => { try { run.child?.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
    return true;
  }

  history() {
    return this.order.map(id => this.runs.get(id)).filter(Boolean).map(r => ({
      id: r.id, cmd: r.cmd, cwd: r.cwd, startedAt: r.startedAt, endedAt: r.endedAt, code: r.code, signal: r.signal,
      running: !!r.child, output: r.chunks, truncated: r.bytes >= MAX_RUN_BUFFER,
    }));
  }
}
