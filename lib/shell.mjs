// lib/shell.mjs — the pilot's live shell: a command runner, not a terminal.
// Each run spawns `$SHELL -c cmd` in a chosen cwd and streams stdout/stderr.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

const MAX_RUN_BUFFER = 2 * 1024 * 1024;   // per run, kept for reconnects
const MAX_HISTORY = 50;

export class ShellRunner extends EventEmitter {
  constructor() {
    super();
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
      child = spawn(shell, args, { cwd: cwd || os.homedir(), env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      run.code = -1; run.endedAt = Date.now();
      this.emit('output', { runId: id, stream: 'stderr', chunk: String(e.message) });
      this.emit('exit', { runId: id, code: -1, signal: null, durationMs: 0 });
      return run;
    }
    run.child = child;
    const push = (stream) => (buf) => {
      const chunk = buf.toString('utf8');
      if (run.bytes < MAX_RUN_BUFFER) { run.chunks.push({ stream, chunk }); run.bytes += chunk.length; }
      this.emit('output', { runId: id, stream, chunk });
    };
    child.stdout.on('data', push('stdout'));
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
