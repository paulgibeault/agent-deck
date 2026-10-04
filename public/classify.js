// public/classify.js — what an event *is*, for the Events list.
//
// Every event gets a family (its color), an icon (its specific kind), a label
// (tooltip / accessible name) and a one-line body. Bash is classified by what
// the command does, not by the tool that ran it. Pure: no DOM, so the tests
// import it directly.
//
// Families: said (talk) · you · read (inspect) · edit (change) · bash (run) ·
//           stop · git · agent (delegate) · web (external) · muted (system) · err

// ------------------------------------------------------------ bash commands
/**
 * Split a shell command into simple commands on unquoted ; && || | and
 * newlines. Quotes, $(…) and heredoc bodies don't split.
 */
export function splitCommands(cmd) {
  const out = []; let cur = ''; let q = null; let depth = 0;
  const s = String(cmd ?? '');
  // Heredoc bodies (<<'EOF' … EOF) are data, not commands.
  const src = s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, (m) => m.slice(0, m.indexOf('\n')));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { cur += c; if (c === '\\' && q === '"') cur += src[++i] ?? ''; else if (c === q) q = null; continue; }
    if (c === '\\') { cur += c + (src[++i] ?? ''); continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '$' && src[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (c === ')' && depth) { depth--; cur += c; continue; }
    if (!depth && (c === ';' || c === '\n' || c === '|' || (c === '&' && src[i + 1] === '&'))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' && src[i + 1] === '|') || c === '&') i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const words = (seg) => (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^['"]|['"]$/g, ''));
const PREFIX = new Set(['sudo', 'time', 'env', 'nohup', 'exec', 'command', 'builtin', 'xargs', 'timeout', 'gtimeout', 'caffeinate', 'nice', 'npx', 'bunx', 'pnpx', 'uv', 'uvx', 'poetry', 'pipenv']);
// Shell grammar that leads into the real command: `do git push`, `then kill …`.
const LEAD = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', 'time']);
// Commands and grammar that say nothing about what the agent is doing.
const NOISE = new Set(['cd', 'echo', 'printf', 'true', 'false', 'export', 'set', 'source', '.', 'wait', 'unset', 'clear', 'pushd', 'popd', ':',
  'done', 'fi', '}', ')', 'esac', 'break', 'continue', 'exit', 'return', 'for', 'case', 'select', 'in', 'declare', 'local', 'typeset', 'readonly',
  'read', 'shift', 'trap', 'eval', 'let', '[', '[[', 'test', 'run', 'function', 'alias', 'type', 'hash', 'ulimit', 'umask', 'tee', 'basename', 'dirname',
  'realpath', 'seq', 'yes', 'tput', 'mktemp', 'printenv', 'say_', 'cal']);

// Intents, most consequential first wins (rank). fam/icon/label describe them.
export const INTENTS = {
  merge:   { rank: 9, fam: 'git',  icon: 'i-merge',   label: 'Merge' },
  push:    { rank: 9, fam: 'git',  icon: 'i-push',    label: 'Push' },
  pr:      { rank: 8, fam: 'git',  icon: 'i-pr',      label: 'Pull request' },
  commit:  { rank: 8, fam: 'git',  icon: 'i-commit',  label: 'Commit' },
  delete:  { rank: 7, fam: 'edit', icon: 'i-trash',   label: 'Delete files' },
  branch:  { rank: 6, fam: 'git',  icon: 'i-branch',  label: 'Branch' },
  stage:   { rank: 6, fam: 'git',  icon: 'i-stage',   label: 'Stage / reset' },
  test:    { rank: 6, fam: 'bash', icon: 'i-flask',   label: 'Tests' },
  build:   { rank: 6, fam: 'bash', icon: 'i-build',   label: 'Build / check' },
  install: { rank: 6, fam: 'bash', icon: 'i-package', label: 'Install' },
  sedit:   { rank: 6, fam: 'edit', icon: 'i-pencil',  label: 'Edit by script' },
  pull:    { rank: 5, fam: 'git',  icon: 'i-pull',    label: 'Pull / fetch' },
  serve:   { rank: 5, fam: 'bash', icon: 'i-play',    label: 'Start server / app' },
  script:  { rank: 4, fam: 'bash', icon: 'i-code',    label: 'Run script' },
  kill:    { rank: 5, fam: 'stop', icon: 'i-stop',    label: 'Stop process' },
  fs:      { rank: 4, fam: 'edit', icon: 'i-folder',  label: 'Move / copy files' },
  agent:   { rank: 5, fam: 'agent', icon: 'i-agent',  label: 'Run Claude' },
  remote:  { rank: 4, fam: 'web',  icon: 'i-term',    label: 'Remote shell' },
  media:   { rank: 4, fam: 'bash', icon: 'i-image',   label: 'Media' },
  ci:      { rank: 3, fam: 'git',  icon: 'i-ci',      label: 'CI checks' },
  issue:   { rank: 4, fam: 'git',  icon: 'i-issue',   label: 'Issue' },
  poll:    { rank: 3.5, fam: 'shell', icon: 'i-history', label: 'Wait until ready' },
  gh:      { rank: 3, fam: 'git',  icon: 'i-pr',      label: 'GitHub' },
  web:     { rank: 3, fam: 'web',  icon: 'i-globe',   label: 'HTTP request' },
  gitlook: { rank: 2, fam: 'git',  icon: 'i-gitlook', label: 'Git status / log / diff' },

  search:  { rank: 1, fam: 'read', icon: 'i-search',  label: 'Search' },
  read:    { rank: 1, fam: 'read', icon: 'i-file',    label: 'Read' },
  list:    { rank: 1, fam: 'read', icon: 'i-folder',  label: 'List' },
  proc:    { rank: 1, fam: 'read', icon: 'i-proc',    label: 'Inspect processes' },
  // Unrecognized: grey, so "unknown" never passes for a category.
  shell:   { rank: 0.5, fam: 'shell', icon: 'i-shell', label: 'Shell' },
  wait:    { rank: 0.2, fam: 'shell', icon: 'i-history', label: 'Wait' },
};

const PKG = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const TESTERS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'rspec', 'phpunit', 'ava', 'tap', 'playwright']);
const BUILDERS = new Set(['tsc', 'make', 'cmake', 'ninja', 'webpack', 'rollup', 'esbuild', 'vite', 'gradle', 'mvn', 'xcodebuild', 'swiftc', 'gcc', 'clang']);

const RUNTIMES = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'tsx', 'ts-node', 'sh', 'bash', 'zsh', 'osascript', 'swift', 'go', 'cargo', 'java', 'php', 'lua']);
const INLINE = new Set(['-', '-e', '-p', '--eval', '--print', '-c']);
const TESTY = /test|spec|smoke|e2e|acceptance|(^|[-_.])ci([-_.]|$)|unit|gate|verify/i;
const SERVY = /serve|server|(^|[-_.])dev([-_.]|$)|start|boot|preview|watch/i;
/** A runtime or script: inline code, a syntax check, a test harness, a server, or a script. */
function runIntent(p, w) {
  const args = w.slice(1);
  if (p === 'node' && (args.includes('--check') || args.includes('-c'))) return 'build';
  if (/^(--version|-v|-V|--help|-h)$/.test(args[0] || '')) return 'proc';
  if (p.startsWith('python') && args[0] === '-m') return /^(http\.server|uvicorn|flask|django)/.test(args[1] || '') ? 'serve' : 'script';
  if (INLINE.has(args[0]) || args.some(x => x.startsWith('--input-type'))) return 'script';
  if (p === 'go' && args[0] === 'run') return 'script';
  const file = RUNTIMES.has(p) ? args.find(x => !x.startsWith('-')) || '' : w[0];
  if (file && args.includes('stop')) return 'kill';
  const base = file.split('/').pop();
  if (TESTY.test(base)) return 'test';
  if (SERVY.test(base) || args.some(x => /^--port\b/.test(x))) return 'serve';
  return 'script';
}

/** The intent of one simple command, or null when it's noise (cd, echo…). */
export function segmentIntent(seg) {
  let w = words(seg);
  for (;;) {
    if (!w.length) return null;
    // `name() { body`: keep the body.
    if (/^[\w-]+\(\)\{?$/.test(w[0]) || w[0] === 'function') { w = w.slice(w[0] === 'function' ? 2 : 1); continue; }
    if (w[1] === '()') { w = w.slice(2); continue; }
    const w0 = w[0].replace(/^[\\({]+|[)}]+$/g, '');
    if (w0 !== w[0]) { w = w0 ? [w0, ...w.slice(1)] : w.slice(1); continue; }
    if (/^[0-9&]*[<>]+&?$/.test(w0)) { w = w.slice(2); continue; } // `> file`: the target goes too
    if (LEAD.has(w0) || PREFIX.has(w0.split('/').pop()) || /^\w+=/.test(w0) || /^-/.test(w0) || /^\d+[smhd]?$/.test(w0) || /^[0-9&]*[<>]/.test(w0)) { w = w.slice(1); continue; }
    break;
  }
  if (/^#/.test(w[0])) return null; // a comment
  const p = w[0].split('/').pop(); const a = w[1] || ''; const b = w[2] || '';
  const rest = w.slice(1).filter(x => !x.startsWith('-'));
  if (NOISE.has(p)) return null;
  if (p === 'sleep') return 'wait';
  if (p === 'claude') return 'agent';
  if (['ssh', 'scp', 'mosh', 'sftp'].includes(p)) return 'remote';
  if (['sips', 'afconvert', 'afplay', 'say', 'ffmpeg', 'ffprobe', 'magick', 'convert', 'screencapture', 'pdftoppm', 'qlmanage', 'exiftool', 'optipng', 'pngquant'].includes(p)) return 'media';
  if (p === 'git') {
    const sub = w.slice(1).find((x, i, arr) => !x.startsWith('-') && !(i > 0 && /^-[Cc]$/.test(arr[i - 1]))) || '';
    if (sub === 'push') return 'push';
    if (sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick') return 'merge';
    if (sub === 'commit' || sub === 'tag' || sub === 'revert') return 'commit';
    if (sub === 'pull' || sub === 'fetch' || sub === 'clone') return 'pull';
    if (sub === 'branch' && !w.some(x => /^-[dDmMcC]$|^--(delete|move|copy|set-upstream)/.test(x)) && w.slice(w.indexOf('branch') + 1).every(x => x.startsWith('-'))) return 'gitlook';
    if (sub === 'worktree' && w.includes('list')) return 'gitlook';
    if (sub === 'checkout' || sub === 'switch' || sub === 'branch' || sub === 'worktree') return w.includes('--') ? 'stage' : 'branch';
    if (['add', 'rm', 'mv', 'reset', 'restore', 'stash', 'apply', 'clean'].includes(sub)) return 'stage';
    return 'gitlook';
  }
  if (p === 'gh') {
    if (a === 'run' || a === 'workflow' || (a === 'pr' && b === 'checks')) return 'ci';
    if (a === 'issue') return 'issue';
    if (a === 'pr' && b === 'merge') return 'merge';
    if (a === 'pr' && (b === 'create' || b === 'edit' || b === 'ready' || b === 'close' || b === 'comment' || b === 'review')) return 'pr';
    return 'gh';
  }
  if (PKG.has(p)) {
    const sub = rest[0] === 'run' ? rest[1] || '' : rest[0] || '';
    if (/^(test|t)(:|$)/.test(sub) || rest[0] === 'test') return 'test';
    if (['install', 'i', 'add', 'ci', 'remove', 'uninstall', 'update', 'upgrade'].includes(rest[0])) return 'install';
    if (/^(build|compile|typecheck|lint|check|format)/.test(sub)) return 'build';
    if (rest[0] === 'start' || /^(dev|start|serve|preview|watch)/.test(sub)) return 'serve';
    if (rest[0] === 'exec' || rest[0] === 'x' || rest[0] === 'dlx') return 'script';
    if (TESTY.test(sub)) return 'test';
    return 'script';
  }
  if (TESTERS.has(p)) return 'test';
  if ((p === 'node' || p === 'deno' || p === 'bun') && w.includes('--test')) return 'test';
  if (p === 'deno' && a === 'test') return 'test';
  if ((p === 'go' || p === 'cargo' || p === 'swift' || p === 'dotnet' || p === 'mix') && a === 'test') return 'test';
  if ((p === 'go' || p === 'cargo' || p === 'swift' || p === 'dotnet') && (a === 'build' || a === 'check' || a === 'vet')) return 'build';
  if ((p === 'python' || p === 'python3') && a === '-m' && (b === 'pytest' || b === 'unittest')) return 'test';
  if ((p === 'python' || p === 'python3') && a === '-m' && b === 'pip') return 'install';
  if (p === 'make' && /test|check/.test(a)) return 'test';
  if (BUILDERS.has(p)) return 'build';
  if (['pip', 'pip3', 'brew', 'apt', 'apt-get', 'gem', 'bundle'].includes(p) || (p === 'cargo' && a === 'add') || (p === 'go' && a === 'get')) return 'install';
  if (p === 'rm' || p === 'rmdir' || p === 'unlink') return 'delete';
  if (['mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'tar', 'unzip', 'rsync'].includes(p)) return 'fs';
  if ((p === 'sed' || p === 'perl') && w.some(x => /^-[a-zA-Z]*i/.test(x))) return 'sedit';
  if (['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fzf', 'locate', 'mdfind', 'which', 'whereis', 'command -v'].includes(p)) return 'search';
  if (['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'wc', 'jq', 'bat', 'diff', 'file', 'stat', 'nl', 'cut', 'sort', 'uniq', 'od', 'xxd', 'strings', 'shasum', 'md5', 'tr', 'perl', 'column', 'base64', 'cmp', 'comm', 'paste', 'fold', 'rev', 'plutil', 'defaults', 'mdls', 'otool', 'sqlite3', 'yq', 'pbpaste'].includes(p)) return 'read';
  if (['ls', 'tree', 'pwd', 'du', 'df', 'exa', 'eza'].includes(p)) return 'list';
  if (['curl', 'wget', 'http', 'https', 'xh', 'ping', 'nc', 'dig'].includes(p)) return 'web';
  if (['kill', 'pkill', 'killall'].includes(p) || (p === 'launchctl' && /^(stop|unload|bootout|kill)$/.test(a)) || (p === 'docker' && /^(stop|kill|rm)$/.test(a))) return 'kill';
  if (['ps', 'lsof', 'top', 'pgrep', 'netstat', 'launchctl', 'uptime', 'whoami', 'env', 'printenv', 'date', 'uname', 'sw_vers'].includes(p)) return 'proc';
  if (['codesign', 'eslint', 'prettier', 'biome', 'ruff', 'mypy', 'pyright', 'shellcheck', 'tsc', 'swiftlint', 'black'].includes(p)) return 'build';
  if (['sysctl', 'sw_vers', 'system_profiler', 'ioreg', 'id', 'hostname', 'tty'].includes(p)) return 'proc';
  if (p === 'open') return 'serve';
  if (p === 'docker') return /^(up|run|start)$/.test(a) || (a === 'compose' && /^(up|start)$/.test(b)) ? 'serve' : 'script';
  if (RUNTIMES.has(p) || /^\.{0,2}\//.test(w[0])) return runIntent(p, w);
  return 'shell';
}

/** The most consequential intent across a compound command. */
export function bashIntent(cmd) {
  let best = null;
  const take = (k) => { if (k && (!best || INTENTS[k].rank > INTENTS[best].rank)) best = k; };
  const segs = splitCommands(cmd);
  for (const seg of segs) {
    take(segmentIntent(seg));
    for (const inner of subshells(seg)) take(bashIntent(inner) === 'shell' ? null : bashIntent(inner));
  }
  // `until curl …; do sleep 1; done`: a wait for something to come up.
  if (segs.some(x => /^(until|while)\s/.test(x)) && segs.some(x => /(^|\s)sleep\s/.test(x))) take('poll');
  // Inline code that writes files is an edit, whatever runs it.
  if (best === 'script' && WRITES.test(String(cmd))) best = 'sedit';
  return best || 'shell';
}

const WRITES = /writeFileSync|writeFile\(|appendFileSync|\.write_text\(|\.write\(|open\([^)]*,\s*['"][wa]b?['"]|fs\.rename|unlinkSync|os\.remove|shutil\./;

/** The commands inside $(…) in a segment. */
function subshells(seg) {
  const out = [];
  for (let i = seg.indexOf('$('); i >= 0; i = seg.indexOf('$(', i + 2)) {
    let d = 0, j = i + 1;
    for (; j < seg.length; j++) { if (seg[j] === '(') d++; else if (seg[j] === ')' && --d === 0) break; }
    out.push(seg.slice(i + 2, j));
  }
  return out;
}

// ------------------------------------------------------------ result facts
/** Small, high-value facts read from a Bash result: commit sha, PR, tests. */
export function bashFacts(intent, text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (intent === 'commit') {
    const m = /^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,})\]/m.exec(t);
    if (m) return { badge: m[2].slice(0, 7), title: `${m[1]} @ ${m[2]}` };
  }
  if (intent === 'pr' || intent === 'merge' || intent === 'gh' || intent === 'push') {
    const m = /\/pull\/(\d+)/.exec(t) || (intent === 'merge' ? /[Mm]erged? (?:pull request )?#(\d+)/.exec(t) : null);
    if (m) return { badge: `#${m[1]}` };
  }
  if (intent === 'test') {
    const num = (re) => { let n = null; for (const m of t.matchAll(re)) n = (n || 0) + Number(m[1]); return n; };
    // node --test / tap: "# pass 12" / "# fail 1"; pytest/jest/vitest: "12 passed, 1 failed".
    let pass = num(/^# pass (\d+)/gm), fail = num(/^# fail (\d+)/gm);
    if (pass == null && fail == null) {
      pass = num(/\b(\d+) (?:passed|passing)\b/g); fail = num(/\b(\d+) (?:failed|failing)\b/g);
    }
    if (pass != null || fail != null) return { pass: pass || 0, fail: fail || 0 };
  }
  return null;
}

// ------------------------------------------------------------ tools
const TOOL = {
  Read:        { fam: 'read', icon: 'i-file',     label: 'Read file' },
  Glob:        { fam: 'read', icon: 'i-search',   label: 'Find files' },
  Grep:        { fam: 'read', icon: 'i-search',   label: 'Search' },
  LS:          { fam: 'read', icon: 'i-folder',   label: 'List' },
  Write:       { fam: 'edit', icon: 'i-filenew',  label: 'Write file' },
  Edit:        { fam: 'edit', icon: 'i-pencil',   label: 'Edit file' },
  MultiEdit:   { fam: 'edit', icon: 'i-pencil',   label: 'Edit file' },
  NotebookEdit:{ fam: 'edit', icon: 'i-pencil',   label: 'Edit notebook' },
  TodoWrite:   { fam: 'agent', icon: 'i-todo',    label: 'Plan' },
  EnterPlanMode: { fam: 'agent', icon: 'i-todo',  label: 'Plan mode' },
  ExitPlanMode:  { fam: 'agent', icon: 'i-todo',  label: 'Plan ready' },
  Agent:       { fam: 'agent', icon: 'i-agent',   label: 'Subagent' },
  Task:        { fam: 'agent', icon: 'i-agent',   label: 'Subagent' },
  Skill:       { fam: 'agent', icon: 'i-bolt',    label: 'Skill' },
  SendMessage: { fam: 'agent', icon: 'i-send',    label: 'Message agent' },
  Workflow:    { fam: 'agent', icon: 'i-agent',   label: 'Workflow' },
  Monitor:     { fam: 'bash', icon: 'i-eye',      label: 'Watch' },
  TaskStop:    { fam: 'stop', icon: 'i-stop',     label: 'Stop task' },
  TaskOutput:  { fam: 'bash', icon: 'i-bg',       label: 'Task output' },
  WebFetch:    { fam: 'web', icon: 'i-globe',     label: 'Fetch page' },
  WebSearch:   { fam: 'web', icon: 'i-globe',     label: 'Web search' },
  ToolSearch:  { fam: 'muted', icon: 'i-plug',    label: 'Load tools' },
  AskUserQuestion: { fam: 'you', icon: 'i-q',     label: 'Asked you' },
  SendUserFile:{ fam: 'said', icon: 'i-clip',     label: 'Sent a file' },
  ScheduleWakeup: { fam: 'muted', icon: 'i-history', label: 'Scheduled wakeup' },
};

/** "claude_ai_Slack" → "Slack", "plugin_engineering_github" → "github". */
export const mcpServer = (s) => String(s || '').replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ');

function todoText(todos = []) {
  const done = todos.filter(t => t.status === 'completed').length;
  const now = todos.find(t => t.status === 'in_progress');
  return `${done}/${todos.length} done${now ? ' · ' + (now.activeForm || now.content) : ''}`;
}

function classifyTool(t) {
  const n = t.name;
  if (n === 'Bash') {
    const intent = bashIntent(t.input?.command);
    const it = INTENTS[intent];
    const desc = t.input?.description;
    return { fam: it.fam, icon: it.icon, label: it.label, intent, text: desc || t.summary, sub: desc ? t.summary : null, sans: !!desc,
      facts: t.pending ? null : bashFacts(intent, t.result?.text) };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (m) return { fam: 'web', icon: 'i-plug', label: `${mcpServer(m[1])} · ${m[2]}`, server: mcpServer(m[1]), text: `${m[2].replace(/_/g, ' ')}${t.summary && t.summary !== '{}' ? ' · ' + t.summary : ''}` };
  if (n === '?') return { fam: 'muted', icon: 'i-info', label: 'Tool result', text: t.summary };
  const k = TOOL[n] || { fam: 'said', icon: 'i-code', label: n };
  const out = { ...k, text: t.summary || t.display };
  if (n === 'TodoWrite') out.text = todoText(t.input?.todos);
  else if (n === 'Agent' || n === 'Task') { out.text = t.input?.description || t.summary; if (t.input?.subagent_type) out.sub = t.input.subagent_type; out.sans = true; }
  else if (n === 'Skill') out.text = t.input?.skill || t.summary;
  else if (n === 'WebSearch' || n === 'AskUserQuestion') out.sans = true;
  return out;
}

// ------------------------------------------------------------ events
const SYSTEM = {
  compact_summary: { icon: 'i-compact', label: 'Context compacted' },
  compact_boundary: { icon: 'i-compact', label: 'Context compacted' },
  local_command: { icon: 'i-term', label: 'Slash command' },
  artifact: { icon: 'i-open', label: 'Artifact', fam: 'web' },
  informational: { icon: 'i-info', label: 'Note' },
  meta: { icon: 'i-info', label: 'Note' },
  loading: { icon: 'i-history', label: 'Loading' },
};

/**
 * { fam, icon, label, text, sub?, sans?, intent?, facts?, server? }
 * `text` is the row body; `sub` an optional dim secondary (e.g. the command
 * under a Bash description).
 */
export function classify(ev) {
  switch (ev.kind) {
    case 'tool': return classifyTool(ev.tool);
    case 'text': return ev.answer
      ? { fam: 'said', icon: 'i-answer', label: 'Answer', text: ev.text, sans: true }
      : { fam: 'said', icon: 'i-said', label: 'Said', text: ev.text, sans: true };
    case 'thinking': return { fam: 'muted', icon: 'i-think', label: 'Thinking', sans: true,
      text: ev.redacted ? 'Thought (redacted)' : ev.text ? ev.text : 'Thought (not recorded)' };
    case 'prompt': return { fam: 'you', icon: 'i-user', label: 'You', text: ev.text };
    case 'queue': return ev.op === 'remove'
      ? { fam: 'muted', icon: 'i-x', label: 'Withdrawn', text: `Withdrawn: ${ev.text || 'queued message'}`, sans: true }
      : { fam: 'you', icon: 'i-history', label: 'Queued', text: `Queued: ${ev.text || 'message'}`, sans: true };
    case 'turn_end': return { fam: 'muted', icon: 'i-check', label: 'Turn ended', text: ev.text || '' };
    case 'system': {
      if (ev.error) return { fam: 'err', icon: 'i-alert', label: 'API error', text: ev.text, sans: true };
      if (ev.subtype === 'task') return { fam: 'agent', icon: 'i-bg', label: 'Background task', text: ev.text, sans: true };
      if (/hook/i.test(ev.subtype || '')) return { fam: 'muted', icon: 'i-hook', label: 'Hook', text: ev.text };
      const s = SYSTEM[ev.subtype] || { icon: 'i-info', label: ev.subtype || 'System' };
      return { fam: s.fam || 'muted', icon: s.icon, label: s.label, text: ev.text, sans: true };
    }
    default: return { fam: 'muted', icon: 'i-code', label: ev.subtype || 'Raw record', text: ev.text };
  }
}

// ------------------------------------------------------------ filters
/**
 * The Events filter: a multi-select of glyph categories that together cover
 * every event. Errors add any failed event, whatever its category.
 */
export const FILTER_ALL = { icon: 'i-filter', fam: 'muted', label: 'All events' };
export const FILTERS = [
  { k: 'messages', icon: 'i-said',   fam: 'said',  label: 'Conversation' },
  { k: 'thinking', icon: 'i-think',  fam: 'muted', label: 'Thinking' },
  { k: 'git',      icon: 'i-branch', fam: 'git',   label: 'Git & GitHub' },
  { k: 'run',      icon: 'i-play',   fam: 'bash',  label: 'Commands: tests, builds, scripts' },
  { k: 'edit',     icon: 'i-pencil', fam: 'edit',  label: 'File changes' },
  { k: 'read',     icon: 'i-search', fam: 'read',  label: 'Reading & searching' },
  { k: 'agent',    icon: 'i-agent',  fam: 'agent', label: 'Subagents, skills & plans' },
  { k: 'web',      icon: 'i-globe',  fam: 'web',   label: 'Web & MCP' },
  { k: 'other',    icon: 'i-info',   fam: 'muted', label: 'Notes & system' },
  { k: 'errors',   icon: 'i-alert',  fam: 'err',   label: 'Errors' },
];
const GROUP = { git: 'git', bash: 'run', stop: 'run', shell: 'run', edit: 'edit', read: 'read', agent: 'agent', web: 'web', said: 'messages', you: 'messages' };
/** The filter category an event belongs to (never 'errors'; that one is cross-cutting). */
export function filterCat(ev) {
  switch (ev.kind) {
    case 'text': case 'prompt': return 'messages';
    case 'thinking': return 'thinking';
    case 'tool': return GROUP[classify(ev).fam] || 'other';
    case 'system': return ev.subtype === 'task' ? 'agent' : 'other';
    default: return 'other';
  }
}
