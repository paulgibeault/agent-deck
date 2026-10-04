import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, parsePs, parseComms, bashCommand, attribute, parseLsof, parseEnvTail } from '../lib/procs.mjs';

const WRAP = (cmd) => `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`;

test('parseClock reads elapsed and CPU times', () => {
  assert.equal(parseClock('05:03'), 303);
  assert.equal(parseClock('01:00:00'), 3600);
  assert.equal(parseClock('2-01:00:00'), 2 * 86400 + 3600);
  assert.equal(parseClock('0:01.50'), 1.5);
  assert.equal(parseClock('-'), null);
});

test('parsePs keeps arguments with spaces and takes names from comm', () => {
  const now = 1_000_000_000;
  const text = [
    '  101     1   101   501 me       Ss    1.5  0.3  20480 400000   0:02.00    10:00 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=gpu',
    '  202   101   202   501 me       R+   12.0  1.0  10240 300000   0:10.00    00:05 claude -p --verbose',
  ].join('\n');
  const procs = parsePs(text, parseComms('  101 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n  202 claude\n'), now);
  const a = procs.get(101);
  assert.equal(a.name, 'Electron');
  assert.equal(a.args, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=gpu');
  assert.equal(a.rss, 20480 * 1024);
  assert.equal(a.start, now - 600_000);
  assert.equal(procs.get(202).ppid, 101);
  assert.equal(procs.get(202).state, 'R+');
  const nl = parsePs('  303     1   303   501 me S 0.0 0.0 10 10 0:00.00 00:01 sh -c sleep 1\\012echo hi', new Map(), now);
  assert.equal(nl.get(303).args, 'sh -c sleep 1\necho hi');
});

test('bashCommand recovers the command from Claude Code’s wrapper, quotes included', () => {
  assert.equal(bashCommand(WRAP('sleep 240; echo done')), 'sleep 240; echo done');
  assert.equal(bashCommand(WRAP("awk '$2==1' f")), "awk '$2==1' f");
  assert.equal(bashCommand('/bin/zsh -c ls'), null);
});

function table(rows) {
  return new Map(rows.map(([pid, ppid, args, start = 0]) => [pid, { pid, ppid, pgid: pid, args, name: args.split(' ')[0].split('/').pop(), start }]));
}

test('attribute ties tasks, calls, shell runs and orphans to the deck', () => {
  const procs = table([
    [1, 0, 'launchd'],
    [10, 1, 'node server.mjs'],                // the deck
    [20, 10, 'claude -p --input-format stream-json'],   // a deck session
    [21, 20, WRAP('npm test')],                // background task
    [22, 21, 'node test.js'],
    [23, 21, WRAP('npm test')],                // its own subshell: same args, not a second task
    [24, 20, WRAP('git status')],              // a call in flight
    [25, 20, WRAP('ls')],                      // a call the transcript has not shown yet
    [26, 20, 'node /x/mcp-server.js'],
    [30, 10, 'claude -p --model haiku'],       // the deck's own model call
    [40, 10, '/bin/zsh -c make'],              // a Shell tab run
    [50, 1, WRAP('tail -f log')],              // outlived its session
    [60, 1, 'Finder'],
  ]);
  const work = (id) => id === 'S' ? {
    tasks: [{ id: 'bg1', command: 'npm test', title: 'Run tests', running: true }, { id: 'old', command: 'tail -f log', title: 'Tail', running: false }],
    calls: [{ id: 'toolu_1', command: 'git status', title: 'Status' }],
  } : { tasks: [], calls: [] };
  const a = attribute(procs, {
    deck: 10,
    sessions: [{ pid: 20, sessionId: 'S', title: 'Fix the build', deck: true }],
    shell: [{ pid: 40, runId: 'r1', cmd: 'make' }],
    work,
    subagents: () => [{ id: 'ag1', title: 'Explore', agentType: 'Explore' }],
  });
  assert.equal(a.tags.get(10).kind, 'deck');
  assert.deepEqual([a.tags.get(20).kind, a.tags.get(20).label], ['session', 'Fix the build']);
  assert.deepEqual([a.tags.get(21).kind, a.tags.get(21).taskId, a.tags.get(21).label], ['task', 'bg1', 'Run tests']);
  assert.equal(a.tags.has(23), false);
  assert.deepEqual([a.tags.get(24).kind, a.tags.get(24).toolUseId], ['tool', 'toolu_1']);
  assert.deepEqual([a.tags.get(25).kind, a.tags.get(25).label], ['bash', 'ls']);
  assert.equal(a.tags.get(26).kind, 'mcp');
  assert.equal(a.tags.get(30).kind, 'model');
  assert.equal(a.tags.get(40).kind, 'shell');
  assert.deepEqual([a.tags.get(50).kind, a.tags.get(50).taskId, a.tags.get(50).detached], ['task', 'old', true]);
  for (const pid of [10, 20, 21, 22, 23, 24, 25, 26, 30, 40, 50]) assert.ok(a.scope.has(pid), `pid ${pid} in scope`);
  assert.equal(a.scope.has(60), false);
  assert.equal(a.scope.has(1), false);
  assert.deepEqual(a.virtual.map(v => [v.id, v.ppid]), [['agent:ag1', 20]]);
});

test('parseLsof reads files and sockets', () => {
  const text = 'p20\nfcwd\na \ntDIR\nn/Users/me/repo\nf7\nau\ntIPv4\nPTCP\nn10.0.0.1:5000->1.2.3.4:443\nTST=ESTABLISHED\nTQR=0\nf9\nau\ntIPv6\nPTCP\nn*:7777\nTST=LISTEN\n';
  const { files, total } = parseLsof(text);
  assert.equal(total, 3);
  assert.deepEqual(files[0], { fd: 'cwd', access: ' ', type: 'DIR', name: '/Users/me/repo' });
  assert.equal(files[1].tcpState, 'ESTABLISHED');
  assert.equal(files[2].tcpState, 'LISTEN');
});

test('parseEnvTail peels the environment off ps -E output', () => {
  const args = 'node server.mjs --port 7777';
  const vars = parseEnvTail(`${args} HOME=/Users/me PATH=/usr/bin:/bin GREETING=hello world TOKEN=abc=def`, args);
  assert.deepEqual(vars, [['HOME', '/Users/me'], ['PATH', '/usr/bin:/bin'], ['GREETING', 'hello world'], ['TOKEN', 'abc=def']]);
});
