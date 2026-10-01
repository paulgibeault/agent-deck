# agent-deck — design plan

A local cockpit for Claude Code agents: see every session and subagent on this
machine, follow their event streams at high fidelity, drive the ones you launch,
and have status read aloud while you work on something else.

Written 2026-09-30 after inspecting a live Claude Code 2.1.284 install on macOS.

---

## Decisions (agreed)

1. **Lives in its own repo:** `~/work/agent-deck`. Not tied to any project.
2. **Prompt pane scope:** full control for sessions the dashboard launches
   (documented stream-json / Agent SDK interface); observe-only for sessions
   launched from the desktop app or a terminal. Protocol work favors standards
   over reverse-engineering (see §6).
3. **Shell tab:** a live shell for the pilot (run a command in a chosen cwd,
   see the result). The *agent's* shell history is already visible in the
   Events stream, so it is not duplicated here.
4. **Runtime:** Node, zero npm dependencies, bound to `127.0.0.1` with a
   per-launch token.

---

## 1. Why a server is required, and why it can stay tiny

A browser page cannot read `~/.claude`, tail files, run git, spawn processes
or talk to sessions. A single `server.mjs` using only `node:http`, `node:fs`,
`node:child_process` covers everything:

- **Server → browser:** Server-Sent Events, one `EventSource`. Auto-reconnect,
  no WebSocket library.
- **Browser → server:** plain `fetch` POSTs.
- **Security:** bind `127.0.0.1` only; random token in the URL checked on
  every request. Transcripts contain everything the agents saw, and the Shell
  tab is remote code execution by design.

Launch: `node server.mjs` → prints `http://127.0.0.1:7777/?t=<token>`.
Cross-platform as long as `~/.claude` resolves (`%USERPROFILE%\.claude` on
Windows).

---

## 2. Data sources (Claude Code 2.1.x, undocumented — isolate the parser)

| Source | What it gives |
|---|---|
| `~/.claude/sessions/<pid>.json` | live registry: `sessionId`, `cwd`, `name`, `status` (busy/idle), `statusUpdatedAt`, `kind`, `entrypoint`, `messagingSocketPath`. Liveness = `kill -0 pid`. |
| `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | full transcript, append-only. |
| `.../<sessionId>/subagents/agent-*.meta.json` | `agentType`, `description`, `toolUseId`, `worktreePath`, `worktreeBranch`, `spawnDepth`, `requestShape`. |
| `.../<sessionId>/subagents/agent-*.jsonl` | subagent transcript. mtime = heartbeat. Done when the parent transcript holds a `tool_result` for its `toolUseId`. |
| `.../<sessionId>/custom-title.json`, `tool-results/*.txt` | titles; large tool outputs spilled to disk. |
| `git` on each session cwd / worktree | real progress: status, diff, log, branch ahead/behind. |

### Transcript record types observed

Standard turn records: `assistant` (content blocks `text` / `thinking` /
`tool_use`), `user` (`tool_result` or plain prompt), `system`
(`stop_hook_summary` = turn boundary). Each carries `uuid`, `parentUuid`,
`timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, and for assistant
messages `message.usage` (input/output/cache/thinking tokens, service tier).

Sideband records that map straight onto the UI:

| Record | Feeds |
|---|---|
| `queue-operation` | Prompt pane queue view (read-only for foreign sessions) |
| `last-prompt`, `custom-title`, `agent-name` | session list labels |
| `cost-state`, per-message `usage` | Brief badges |
| `pr-link`, `gitBranch`, `mode`, `effort` | session header |
| `file-history-snapshot` | Files tab |
| `attachment` | context attachments |

**Rule:** `lib/transcript.mjs` is the only module that knows these shapes.
Unknown record types render as a generic "raw" event rather than failing, so a
Claude Code upgrade degrades the deck instead of breaking it.

### Session buckets

- **Active:** pid alive (registry file + `kill -0`).
- **Recent:** transcript modified within N days (default 3), pid gone.
- **Closed:** everything else, lazy-loaded.

---

## 3. Layout

```
┌──────────────┬──────────────────────────────┬──────────────────────┐
│ SESSIONS     │ STREAM                       │ DETAILS              │
│ ▾ Active     │ ┌ Brief ───────────────────┐ │ (event renderer)     │
│   ● sess A   │ │ status · tokens · files  │ │                      │
│     ├ sub 1  │ └──────────────────────────┘ │  ┌───────────────────┤
│     └ sub 2  │ ┌ Prompt ──────────────────┐ │  │ TELEPROMPTER      │
│ ▸ Recent     │ │ queue · send · interrupt │ │  │ (slides in over   │
│ ▸ Closed     │ └──────────────────────────┘ │  │  Details)         │
│              │ ┌ Events│Files│Changes│Shell┐│  │                   │
│              │ │ dense virtualized list   │ │  │                   │
└──────────────┴──────────────────────────────┴──┴───────────────────┘
```

Panes are resizable; layout persists in `localStorage`.

---

## 4. Stream pane

### 4.1 Brief (two layers)

- **Heuristic brief** — always on, free, instant. Derived purely from the
  stream: state (thinking / running `npm test` / waiting on 3 subagents /
  idle 4m), last assistant sentence, active tool, tokens & cost this turn and
  session, files touched, branch ahead/behind, open PR link.
- **Narrator brief** — opt-in, throttled. On turn end or every N events, pipe
  the last K events to `claude -p --model <haiku>` with a "two sentences,
  present tense, for a pilot" prompt. This is the natural unit for auto
  read-aloud; a heuristic brief sounds robotic, a narrated one sounds like a
  copilot. Show cost per narration.

### 4.2 Prompt

For **deck-launched** sessions (see §6): compose, **send**, **queue** (ordered,
editable, drag to reorder, delete = prune), **interrupt** (stop current turn,
keep queue), and per-item "send now / move to top".

For **foreign** sessions (desktop app / terminal): queue shown read-only from
`queue-operation` records; "copy prompt" and "open session" affordances;
Send is disabled with a tooltip explaining why.

### 4.3 Events tab

- `tool_use` + its `tool_result` fold into **one row**: icon, tool-specific
  one-liner (`Bash npm test` · `Edit solver.js +12 −3` · `Read index.html` ·
  `Agent "Implement #5"`), duration, exit/error chip, token cost.
- `thinking` collapses to a faint single row showing length; click to expand.
- Subagent events nest under their `Agent` row (collapsible inline, or "open
  as session").
- Turn boundaries (`stop_hook_summary`, user prompts) are visual separators.
- Virtualized list — transcripts reach MBs and keep growing.
- Follow-tail toggle; keyboard: `j`/`k` move, `Enter` opens details,
  `Space` toggles follow.

### 4.4 Files tab

Union of Read/Edit/Write/Glob paths plus `file-history-snapshot`: counts, last
touched, hot/cold indicator. Click → Details shows current content with
highlight and an "open in editor" button (`code -g file:line` via server).

### 4.5 Changes tab

`git status` + `git diff --stat` of the session's cwd/worktree; click a file
for a side-by-side diff. Branch log, ahead/behind vs base, PR link if present.

### 4.6 Shell tab (pilot's live shell)

Simple command runner, not a terminal emulator: cwd selector (defaults to the
selected session's cwd/worktree), input line, history (↑/↓), each run shows
command, stdout/stderr (ANSI stripped or minimally colored), exit code,
duration. Long-running commands stream output over SSE and can be killed.
Server runs via `child_process.spawn(shell, ['-c', cmd])` with the deck
token required. No PTY in v1; a real xterm.js terminal is a possible later
upgrade.

---

## 5. Details pane

Renderer chosen by event kind, each with Copy buttons per block and a Raw
(JSON tree) toggle:

| Event | Renderer |
|---|---|
| assistant `text` | Markdown |
| `Edit` | side-by-side diff of `old_string` / `new_string` |
| `Read` / `Write` | syntax-highlighted source (highlight.js, vendored for offline use) |
| `Bash` | command + stdout/stderr, exit code |
| image tool results | decoded base64 image |
| `Agent` | subagent summary card, link to open as session |
| `thinking` | plain text, muted |
| anything else | JSON tree |

"Open in editor" where a path is known.

---

## 6. Protocol planning — standards first

Goal: control agents with documented interfaces only; no private sockets.

### 6.1 Agent control: Claude Code stream-json (Agent SDK wire format)

Deck-launched sessions run as:

```
claude -p --input-format stream-json --output-format stream-json \
       --verbose [--model …] [--permission-mode …] [--cwd …]
```

- **Send:** write a `{"type":"user","message":{"role":"user","content":…}}`
  line to stdin.
- **Queue:** owned entirely by the deck; nothing is written to stdin until the
  current turn's `result` event arrives. Prune/reorder are pure deck-state
  operations.
- **Interrupt:** send the control request the SDK defines for interrupt (the
  `control_request` / `interrupt` message in stream-json); fall back to
  `SIGINT` on platforms/versions where it is not honored.
- **Events:** stdout stream-json is the highest-fidelity, lowest-latency
  source for the Events tab; the transcript file is still tailed as the
  durable record and for subagents.

The same shapes are what `@anthropic-ai/claude-agent-sdk` speaks, so if the
deck ever moves from spawning the CLI to embedding the SDK, the event model
does not change. Treat the SDK docs as the spec; verify the exact control
message names against the installed version before implementation.

### 6.2 Foreign sessions: observe via files, never via the private socket

`/tmp/cc-socks/<pid>.sock` is an internal peer-messaging channel with no
published protocol. Out of scope. If a documented way to address a running
interactive session appears (CLI flag or SDK API), add it behind the same
Prompt pane.

### 6.3 Hooks: optional push channel

Claude Code hooks (`PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`,
`Notification`) are a documented, stable interface. An optional
`hooks/deck-hook.sh` that POSTs the hook payload to
`http://127.0.0.1:7777/hook?t=…` gives "tool in progress" state before the
result lands in the transcript, and survives transcript-format changes. Users
opt in by adding it to their `settings.json`.

### 6.4 Deck ↔ browser protocol

SSE event stream with a small, explicit vocabulary, mirroring stream-json
where it overlaps:

```
sessions.snapshot   { active[], recent[], closed[] }
session.update      { id, status, brief, usage, branch, … }
event.append        { sessionId, event }        // normalized event
event.batch         { sessionId, events[] }     // initial load / catch-up
agent.tree          { sessionId, subagents[] }
shell.output        { runId, chunk, stream }
shell.exit          { runId, code, durationMs }
tts.audio           { itemId, url }             // server-side TTS fallback
```

REST: `GET /sessions`, `GET /sessions/:id/events?from=`, `POST /launch`,
`POST /sessions/:id/send|queue|interrupt|prune`, `POST /shell/run`,
`POST /shell/kill`, `POST /open-editor`, `POST /tts`.

Normalized event shape (what the UI consumes):

```ts
{ id, sessionId, parentId?, ts, kind: 'text'|'thinking'|'tool'|'prompt'|
  'turn_end'|'queue'|'system'|'raw', tool?: { name, input, result?,
  durationMs?, isError? }, text?, usage?, raw }
```

---

## 7. Read Aloud

### 7.1 Engine and voices

Primary: Web Speech API (`speechSynthesis`). Reality check on
**Microsoft Natural** voices:

| Platform / browser | Natural voices exposed to the page? |
|---|---|
| Windows + Edge | Yes — "Microsoft Aria Online (Natural)" etc. Best case. |
| Windows + Chrome | No — SAPI voices only (David, Zira). |
| macOS, any browser | No Microsoft voices; Apple system voices (Samantha…). Siri voices are not exposed. |

- Voice picker auto-prefers `/Natural|Online/`, then `/Premium|Enhanced/`,
  then default; persisted per machine. Rate/pitch controls.
- **Server-side fallback (phase 2):** `say` on macOS; on Windows 11,
  PowerShell → WinRT `Windows.Media.SpeechSynthesis`, which can reach the
  Natural voices installed under Accessibility → Narrator even when the
  browser cannot. Streams audio to the page as `tts.audio`.
- Edge **online** Natural voices do not fire `onboundary` reliably, so
  highlighting is done by **one utterance per line**. This makes highlight
  exact and ff/rw trivial, at the cost of a brief pause between lines.

### 7.2 Queue and controls

`ReadQueue` state machine: items `{ id, source, title, lines[] }`.

- Controls: play/pause, ◀◀ ▶▶ (line), ⏮ ⏭ (item), stop, speed.
- History drawer: last 50 items, replay any.
- Dedupe: an unread brief is replaced when a newer brief arrives.
- Auto-read toggles per source: Brief, assistant text, errors, subagent
  completions, session idle/finished.
- Per-session mute.

### 7.3 Teleprompter pane

Slides in from the right, overlapping Details (Details remains reachable via
a tab/pin). Shows source badge (Brief / Assistant / Event), the item's lines
with the current line highlighted and auto-scrolled; click any line to seek.
Collapses to a thin bar when idle.

---

## 8. Repository shape

```
agent-deck/
  PLAN.md
  README.md
  server.mjs            http + sse + tail + git + spawn + shell + tts
  lib/
    transcript.mjs      the only file that knows Claude Code's file formats
    sessions.mjs        registry, buckets, subagent tree
    agent.mjs           deck-launched sessions (stream-json control)
    gitinfo.mjs         status / diff / log helpers
    shell.mjs           pilot shell runner
    tts.mjs             server-side TTS fallback
  public/
    index.html
    app.js              state + panes
    events.js           normalized-event renderers (rows + details)
    tts.js              ReadQueue + teleprompter
    styles.css
    vendor/highlight.min.js, github.css (+ dark)
  hooks/deck-hook.sh    optional push channel (see §6.3)
```

No build step. ES modules in the browser, plain CSS, light/dark via
`prefers-color-scheme`.

---

## 9. Phases

1. **Telescope.** Sessions tree (Active/Recent/Closed, subagents), Events /
   Files / Changes / Shell tabs, Details renderers, heuristic Brief,
   read-only queue. Useful on day one for agents already running.
2. **Voice.** Web Speech read-aloud, teleprompter, queue/history, auto-read
   toggles, narrator Brief.
3. **Cockpit.** Launch sessions from the deck with full Prompt control over
   stream-json; hooks push channel; server-side TTS fallback.

---

## 10. Open questions / risks

- Transcript format is undocumented; verify on each Claude Code upgrade.
  Keep a `fixtures/` folder of real jsonl samples for the parser tests.
- Exact stream-json control message for interrupt must be confirmed against
  the installed CLI/SDK version.
- Narrator brief costs tokens; default off, show running cost.
- Live Shell is RCE on localhost: token required, no `0.0.0.0` binding ever,
  confirm dialog for commands when the token came from a URL older than the
  server process.
- Large transcripts: parse incrementally from the last byte offset; never
  re-read whole files on change.
