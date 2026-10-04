import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommands, bashIntent, bashFacts, classify, mcpServer } from '../public/classify.js';

test('splitCommands respects quotes, $(…) and heredocs', () => {
  assert.deepEqual(splitCommands('git status --short | head; git fetch -q origin && git log'), ['git status --short', 'head', 'git fetch -q origin', 'git log']);
  assert.deepEqual(splitCommands('git commit -m "a; b | c"'), ['git commit -m "a; b | c"']);
  assert.deepEqual(splitCommands(`grep -E 'x|y' f || true`), [`grep -E 'x|y' f`, 'true']);
  const hd = splitCommands('git commit -m "$(cat <<\'EOF\'\nfix; things | more\nEOF\n)" && git push');
  assert.equal(hd.length, 2); assert.equal(hd[1], 'git push'); assert.ok(!hd[0].includes('things'));
});

test('bashIntent picks the most consequential command', () => {
  const cases = {
    'gh pr merge 9 --merge 2>&1 | tail -2; gh pr view 9 --json state': 'merge',
    'git status --short | head; git fetch -q origin; git log --oneline origin/main': 'pull',
    'git add -A && git commit -m "x" && git push -u origin HEAD': 'push',
    'git diff --stat': 'gitlook',
    'git branch --show-current; git status --short': 'gitlook',
    'git branch -D old': 'branch',
    'git checkout -b feature': 'branch',
    'git -C ../repo log -3': 'gitlook',
    'gh pr create --title t --body b': 'pr',
    'gh pr view 9': 'gh',
    'cd app && npm test 2>&1 | tail -20': 'test',
    'node --test test/*.test.mjs': 'test',
    'npx vitest run': 'test',
    'python -m pytest -q': 'test',
    'npm run build': 'build',
    'npm install left-pad': 'install',
    'npm start': 'serve',
    'rm -rf dist': 'delete',
    'sed -i "" s/a/b/ f.js': 'sedit',
    'sed -n 1,40p f.js': 'read',
    'rg -n foo src | head': 'search',
    'ls -la': 'list',
    'curl -s localhost:3000/api': 'web',
    'pkill -f server.mjs': 'kill',
    'echo hi': 'shell',
    'mystery-tool --flag': 'shell',
    'for f in a b; do git -C $f status; done': 'gitlook',
    '(cd ../x && npm test)': 'test',
    'PID=$(lsof -ti:7777); echo $PID': 'proc',
    'until curl -sf localhost:3000; do sleep 1; done': 'poll',
    'timeout 300 node tools/run-ci.mjs': 'test',
    '/usr/bin/time -p node --test': 'test',
    'node --check public/app.js': 'build',
    'node -e "console.log(1)"': 'script',
    "python3 - <<'EOF'\nopen('a.txt','w').write('x')\nEOF": 'sedit',
    'node tools/simulate.mjs --n 5': 'script',
    'node tools/serve.mjs --port 4812': 'serve',
    './dev.sh stop': 'kill',
    'npm run dev': 'serve',
    'gh run watch 123': 'ci',
    'gh issue view 50': 'issue',
    'ssh host uptime': 'remote',
    'sips -Z 800 a.png': 'media',
    'claude -p "hi"': 'agent',
    'run() { node x.mjs; }; run': 'script',
    'sleep 5': 'wait',
    'FOO=1 sudo make test': 'test',
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(bashIntent(cmd), want, cmd);
});

test('bashFacts reads commit sha, PR number and test counts', () => {
  assert.deepEqual(bashFacts('commit', '[auto-resume 1a2b3c4d] Events: icons\n 2 files changed'), { badge: '1a2b3c4', title: 'auto-resume @ 1a2b3c4d' });
  assert.deepEqual(bashFacts('commit', '[main (root-commit) abcdef0] init'), { badge: 'abcdef0', title: 'main @ abcdef0' });
  assert.deepEqual(bashFacts('pr', 'https://github.com/o/r/pull/12\n'), { badge: '#12' });
  assert.deepEqual(bashFacts('merge', 'b01c07c Merge pull request #9 from o/branch'), { badge: '#9' });
  assert.deepEqual(bashFacts('test', '# tests 14\n# pass 13\n# fail 1\n'), { pass: 13, fail: 1 });
  assert.deepEqual(bashFacts('test', '===== 8 passed, 2 failed in 1.2s ====='), { pass: 8, fail: 2 });
  assert.equal(bashFacts('test', 'no counts here'), null);
});

test('classify gives every event a family, icon and body', () => {
  const bash = classify({ kind: 'tool', tool: { name: 'Bash', input: { command: 'git push', description: 'Push the branch' }, summary: 'git push', pending: false, result: { text: '' } } });
  assert.equal(bash.fam, 'git'); assert.equal(bash.icon, 'i-push');
  assert.equal(bash.text, 'Push the branch'); assert.equal(bash.sub, 'git push');
  const mcp = classify({ kind: 'tool', tool: { name: 'mcp__claude_ai_Slack__send_message', input: {}, summary: '{}' } });
  assert.equal(mcp.server, 'Slack'); assert.equal(mcp.text, 'send message');
  const todo = classify({ kind: 'tool', tool: { name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'in_progress', content: 'b', activeForm: 'Doing b' }, { status: 'pending' }] } } });
  assert.equal(todo.text, '1/3 done · Doing b');
  assert.equal(classify({ kind: 'text', text: 'hi', answer: true }).icon, 'i-answer');
  assert.equal(classify({ kind: 'text', text: 'hi' }).icon, 'i-said');
  assert.equal(classify({ kind: 'thinking', text: '' }).text, 'Thought (not recorded)');
  assert.equal(classify({ kind: 'system', error: true, text: 'overloaded' }).fam, 'err');
  assert.equal(classify({ kind: 'raw', text: '{}' }).fam, 'muted');
  assert.equal(mcpServer('plugin_engineering_github'), 'github');
});
