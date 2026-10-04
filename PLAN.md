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
- Follow-tail toggle; keyboard: ↓/↑ move, `Enter` opens details,
  `l` toggles follow.

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

Events are narrated as they happen, so the pilot can follow sessions without
reading. The browser does the speaking. The server only produces audio for
online voices that the browser cannot reach.

### 7.1 What gets narrated

| Source | Default | Comes from |
|---|---|---|
| **Said**: assistant messages | on | `event.batch` events with `kind: 'text'` |
| **Needs you**: questions, permission prompts | off | `attention` entries (`lib/attention.mjs`, already worded for the ear) |
| **Errors** | off | `attention` entries with `signal: 'error'` |
| **Finished**: a turn handed back | off | `attention` entries with `signal: 'done'`, `from: 'working'` |
| **Brief updated** | off | `brief.update` (the summary line) |

- **Scope**: off, the selected session, or all sessions. "The selected
  session" follows the selection as it changes.
- **Subagents**: one setting above all of the scopes, **Include subagents**,
  off by default. When it is off, only top-level sessions are narrated.
- **Length**: in full (the default), or the first ~600 characters followed by
  "…and more on screen".
- The session in view is narrated like every other session. Reading it aloud
  is the point.
- Narration hooks the live SSE listener, not `onEvents`. `catchUp()` and
  initial loads feed `onEvents` too, and must never replay history aloud.
  `event.batch` already arrives for every active session (they stay loaded),
  carrying the full text, so no new server stream is needed.

### 7.2 Queue

One queue of items `{ id, sessionId, eventId?, kind, title, markdown, priority, manual }`.

- **Order**: first in, first out. **Needs you** items go to the top of the
  queue but never interrupt the item that is playing.
- **Skip to the latest** (setting, on by default): when an item comes up and
  the same session has newer items of the same kind waiting, only the newest
  plays. It opens with "Release check, 3 earlier updates skipped."
- **Announcement**: every item opens with the session title, then the content.
- **Read-aloud buttons** play right away. The automatic item is paused at its
  current chunk and resumes from that chunk afterwards. Buttons go on:
  - the Assistant section of the details pane
  - the brief box
  - each Ask answer
- **Holding while typing**: while the prompt box (or the Ask input) has focus,
  new items wait. An item that is already playing finishes. The held items
  play once the prompt is sent or the field loses focus. Manual buttons
  ignore the hold.
- **One window speaks**: Web Locks (`navigator.locks`) elect a single tab, so
  two open windows never talk over each other.
- The queue logic is pure (no DOM) in `public/speech.js` and unit-tested,
  like `activity.js`.

### 7.3 Turning text into speech

The rendered markdown is the source. Chunks are cut from the same DOM the
pane shows, so speech and highlight cannot disagree.

1. Render with `markdown()`, as the details pane does.
2. Walk the block elements (`p`, `li`, headings, `blockquote`, cells). Split
   each block's text into sentences, and record each chunk as a DOM `Range`
   plus its spoken text.
3. Clean the spoken text for the ear:
   - a `pre` block is said as "code block, 14 lines"
   - paths shrink to the file name
   - links are read as the domain
   - images are skipped
   - markdown symbols are removed
4. Highlight with the **CSS Custom Highlight API**
   (`CSS.highlights.set('narr', new Highlight(range))`). This touches neither
   the rendered DOM nor the markdown renderer.
   - The chunk being read is always highlighted.
   - The word being read is highlighted too, as a second `narr-word`
     highlight, whenever the engine reports word boundaries (most local
     voices do).
5. **Click a chunk to seek**: `caretPositionFromPoint` finds the clicked
   offset, the chunk that contains it is found, and playback restarts there.

One utterance (or one audio clip) per chunk keeps highlighting exact, makes
seeking trivial, and lets online audio be fetched one chunk ahead.

### 7.4 Voices and engines

One voice picker, grouped **Local** and **☁ Online**. Online voices are
clearly marked and show a small warning when they fall back.

- **Browser** (`speechSynthesis`): Apple voices on macOS Chrome; Microsoft
  "Online (Natural)" voices when the deck runs in Edge. A voice with
  `localService === false` is listed as Online.
- **Azure AI Speech** (official REST API, `lib/tts.mjs`): Microsoft's neural
  voices (Ava, Andrew, Aria, Jenny…) in any browser.
  - `POST /api/tts {text, voice, rate}` returns `audio/mpeg`.
  - `GET /api/tts/voices` returns the voice list, cached for a day.
  - Audio is cached in memory by `hash(voice, rate, text)`, so replays and
    seeks are free.
  - The key and region come from `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`
    or `~/.agent-deck/tts.json`, set from the settings popover. The key is
    never sent back to the page.
  - The free tier covers 0.5M characters a month.
- If an online request fails, that item falls back to the default local
  voice.
- The voice is resolved per item, which leaves room for a voice per session
  later without a redesign.

### 7.5 Narration pane

- **Layering**: a separate layer *above* the details pane, absolutely
  positioned in `#deck` at `right: 0`, full height, `width: var(--right)`. The
  details pane underneath keeps its state (selection, scroll, Ask thread).
- **Visibility**: it pops up whether or not the details pane is open. When
  details is closed, it covers the same strip of the stream.
- **Motion**: it slides in from the right in about 120 ms when narration
  starts, and slides out about 1.5 s after the queue empties. Chained items
  swap in place with a quick crossfade, with no slide between them.
- **Header**: the session title, a kind chip (Said / Needs you / …), a
  "3 skipped" chip, and the number still queued.
- **Body**: the details pane's renderers (`markdown()`, images, code
  highlighting), with chunk and word highlights.

### 7.6 Controls

- **Title bar**, next to the model picker:
  - a speaker icon (muted when off, animated while speaking) that opens the
    settings popover
  - play/pause, always shown. Pausing with nothing playing makes new items
    wait in the queue until play. A Read aloud button still plays while
    paused, and the queue stays paused afterwards.
  - ⏭, which skips to the next item (it stays paused when paused)
- **Settings popover**:
  - scope (off / this session / all sessions)
  - include subagents
  - voice (Local / ☁ Online) with a preview button
  - speed
  - one checkbox per event type (Said on by default)
  - length (full / short)
  - skip to the latest per session
  - Azure key and region
- **Speaker under the prompt box**: pulses while narration plays. Clicking it
  opens the session being read, selects its event and shows it in details.
  On the overview there is no prompt box; the title bar icon serves.
- **Media keys and AirPods** (Media Session API):
  - metadata: the session title and the kind
  - handlers: play, pause, next track, stop
  - Azure audio plays through an `<audio>` element, which owns the media
    session natively.
  - For `speechSynthesis`, a silent looping `<audio>` plays while narrating,
    so Chrome routes the keys to the deck. *Verify on macOS Chrome.*
- **Keyboard** (ignored inside text fields):
  - `j`: jump to the narrated session and event, the same as the speaker
    under the prompt box
  - `Space`: play/pause narration
  - `]`: next item
  - `r`: read the selected event, or the brief when nothing is selected
  - This moves two old bindings: next/previous event is now ↓/↑ only (`j`/`k`
    are retired), and go live / pause moves from `Space` to `l`.
- **Autoplay**: Chrome allows speech only after the page has had a user
  gesture. Until then, the speaker icon shows "click to enable" and holds the
  queue.

### 7.6a Narration history (the bell)

**The bell** sits at the left of the title bar, after the deck's name. Its
badge counts unheard items, meaning items still waiting in the queue; it
updates as the queue moves. Clicking the bell (or `b`) opens the history,
newest first.

- **Rows:** a dot while unheard, the kind chip, session title, the text,
  and how long ago.
- **Searching:** matches title, kind and text. **All / Unheard** filter the
  list.
- **Opening:** ↑/↓ and `Enter` (or a click) open the event in its session.
  It is played from there, with the details pane's Read aloud button.
- **Footer:** **Mark all heard** empties the queue without playing, and
  **Clear** empties the list.

Every narration event of an enabled kind is logged, whatever the scope, so
the bell works as an inbox even with narration off. Subagent events are
logged only when included. An item skipped by "skip to the latest", or
cleared by stop, is simply heard; it carries no special marker.

Storage: `localStorage`, capped at 500 entries with the text clipped to
4,000 characters. Only the speaking window writes it; other windows follow
through the `storage` event. Server-side history can come later.

### 7.7 Files

| File | Holds |
|---|---|
| `public/speech.js` | pure: queue (priority, collapse to latest, cut-in/resume), sentence splitting, spoken-text cleanup. Tested in `test/speech.test.mjs`. |
| `public/narration.js` | the player: engines, chunk playback, highlights, pane, Media Session, Web Lock, typing hold |
| `lib/tts.mjs` | Azure synthesis, voice list, audio cache |
| `app.js` | hooks only: SSE listeners, read-aloud buttons, title bar, shortcuts |

Settings live in `prefs` (localStorage), one set per machine.

### 7.8 Build order

1. The queue, browser voices, auto **Said**, the pane, the title bar
   controls, and the settings popover.
2. Chunk highlighting, click to seek, the read-aloud buttons with cut-in, and
   the speaker under the prompt box.
3. Azure voices, and the Media Session API.
4. The typing hold, the shortcuts, and the remaining event types.

### 7.9 Later

- A voice per session, so you know who's talking before the title is read.
- "Say it shorter": an opt-in Haiku summary of long messages, run only on
  events, with its cost shown.
- A narration history list in the pane, to replay the last 20 items.

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
    tts.mjs             Azure neural voices + audio cache (§7.4)
  public/
    index.html
    app.js              state + panes
    events.js           normalized-event renderers (rows + details)
    speech.js           read-aloud queue + text-to-speech chunks (pure)
    narration.js        read-aloud player + pane (§7)
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
   *Read aloud is built as §7 describes (public/narration.js,
   public/speech.js, lib/tts.mjs). Not yet verified on real hardware: Azure
   voices with a live key, and media keys / AirPods in Chrome.*
3. **Cockpit.** Launch sessions from the deck with full Prompt control over
   stream-json; hooks push channel; server-side TTS fallback.
   *Launch, send, queue, interrupt, end, resume and permission prompts are
   built (lib/agent.mjs); hooks push and TTS are not yet. Verified on
   2.1.286: interrupt is `control_request {subtype:"interrupt"}`; permission
   prompts arrive as `control_request {subtype:"can_use_tool"}` with
   `--permission-prompt-tool stdio`; `-p` transcripts have no
   `stop_hook_summary` and `-p` writes no `~/.claude/sessions` entry, so the
   deck supplies liveness and busy/idle for its own sessions; `--resume`
   keeps the session id.*

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
