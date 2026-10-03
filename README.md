# agent-deck

A local cockpit for Claude Code agents. See every session and subagent on
this machine, follow their event streams at high fidelity, inspect what they
changed, and run your own commands next to them.

Sessions started elsewhere (terminal, desktop app, IDE) are observe-only: the
deck reads what Claude Code already writes under `~/.claude` and never
touches them. Sessions you start from the deck (**New session**, or `n`) run
under it, and you can send, queue, interrupt, end and resume them and answer
their permission prompts. See [PLAN.md](PLAN.md) for the full design and the
later phases (read-aloud).

## Run

```bash
node server.mjs
```

Prints a URL like `http://127.0.0.1:7777/?t=<token>`. Open it; the token is
stored in a cookie so the page can be reloaded without it. The token itself
is kept in `~/.agent-deck/token`, so the cookie keeps working across
restarts. Node 20+, no dependencies, no build step.

### Install as an app

The deck is an installable web app. With it open, use Chrome/Edge's
"Install agent-deck" (address bar icon) or Safari's File → Add to Dock. The
app opens even when the backend is stopped: it shows a welcome screen with a
**Launch backend** button and connects as soon as the backend answers.

The button opens an `agent-deck://` link, which needs a one-time helper
install (macOS):

```bash
npm run install-app
```

That puts `Agent Deck Launcher.app` in `~/Applications`, registered for
`agent-deck://`; it starts `server.mjs` in the background (log:
`~/.agent-deck/server.log`) using the `PATH` and `node` from the shell you
installed from. Re-run it if you move the repo or change Node. The first
click asks the browser to allow opening the launcher. `npm run
uninstall-app` removes it.

Flags and environment:

| Option | Default | Meaning |
|---|---|---|
| `--port N` / `DECK_PORT` | 7777 | listen port (always on 127.0.0.1) |
| `--days N` | 3 | sessions modified within N days count as "Recent" |
| `--token X` / `DECK_TOKEN` | saved random | fixed launch token (dev convenience) |
| `--open` | off | open the browser on start |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code keeps its state |
| `DECK_EDITOR` | `code` | command for "open in editor" (`<cmd> -g file:line`) |
| `--no-narrator` / `DECK_NARRATOR=off` | on | turn off the generated Brief and Ask (no model calls) |
| `DECK_BRIEF_MODEL` | `haiku` | model for the generated Brief |
| `DECK_ASK_MODEL` | `sonnet` | model for Ask about this |
| `DECK_CLAUDE_BIN` | `claude` | CLI used for model calls |
| `DECK_AGENT_BIN` | `claude` | CLI used for deck-launched sessions |
| `DECK_STATE_DIR` | `~/.agent-deck` | launch token, hidden sessions, the delete trash |

The Brief and Ask call `claude -p` with no tools, no MCP servers and no
session persistence, using whatever login the CLI already has. If that login
has expired the deck says so in the Brief; run `claude` in a terminal and
`/login`. To try both flows without a login, point `DECK_CLAUDE_BIN` at
`test/fixtures/fake-claude.mjs` (the `agent-deck-fake-model` preview config
does this).

Tests: `npm test` (parser, index, brief scheduler, Ask and trash against
`test/fixtures/session.jsonl`; deck-launched sessions against
`test/fixtures/fake-agent.mjs`). The `agent-deck-fake-agent` preview config
runs the whole deck on the fakes with a throwaway `CLAUDE_CONFIG_DIR`, so
you can try launching without a login or touching `~/.claude`. Its prompt
words steer it: "permission" asks to run a command, "slow" works for a
minute, "crash" exits with an error.

## What you get

- **Overview.** What shows when no session is open: sessions waiting on you
  or failing, cards for working agents with their brief, recently finished.
- **Sessions rail.** Active sessions grouped by repo, Recent, Closed, Hidden.
  Counters for working / your turn / with errors filter the list. Subagents
  show as a progress bar under their parent, running first.
  Collapse it (`[` or the panel button) to a column of chips: one per live
  session, then recent ones. The ring colour is the state, an amber chip
  pulses when Claude asked you something or wants a permission, and badges
  count errors, running subagents and queued prompts. Hover or focus a chip
  for a card with whose move it is, the current tool or question, the brief,
  any Watch item, progress, running subagents, the queue, and errors, turns,
  files, cost and model.
- **Model picker.** The title bar picks the model new sessions start
  with (Default shows what your Claude settings use, e.g. `opus[1m]`).
  The New session and Resume dialogs start on it; a different pick there
  applies to that launch only.
- **Plan usage.** A small ring in the top bar shows how full your tightest
  plan window is (green, amber from 75% or when the pace would run out
  before the reset, red when limited). Hover for each window (5-hour,
  weekly) with reset times and pace, extra-usage status, what the deck's
  own brief / Ask / quota-check calls have cost, and live session spend.
  Quota comes from the `rate_limit_event` every `claude` call reports, so it
  updates for free whenever the deck or a deck-launched session makes a
  call; if nothing has for 30 minutes while the deck is open, it checks
  with a one-word Haiku call. Click the ring to check now.
- **States.** One signal per session, the same colour in every view:
  yellow working (pulses), orange paused on your input (a permission prompt,
  or a turn that ended on a question), red the newest event is an error,
  green done, grey ended. Orange and red are **Needs you**: they lead the
  overview, fill the "need you" counter and the tab title count, and pulse
  in the rail. The status line for a red session jumps to the error.
- **Needs you events.** `lib/attention.mjs` watches the signals and turns
  each settled change into an entry with a priority and one sentence to
  speak ("release check is asking: should we ship it?"). They stream as
  `attention` SSE events (and `GET /api/attention`); the page reads them
  out through a polite live region for screen readers, and spoken
  narration will consume the same entries.
- **Brief.** A model-written summary of the session to date: what it has
  done, a progress bar when the work has countable units, done / next, and
  a Watch line for risks that links to the event. It refreshes on events
  that change the story, not on a clock: when the agent hands back (turn
  end, a question), when a subagent finishes, on a commit, push or PR, and
  mid-turn once enough work piles up (edits and commands count, reads
  barely do; at most every 3m, at least every 10m while it keeps working).
  Permission prompts and reads alone never refresh it. In the background,
  live sessions refresh only on handoffs, finished subagents and every 10m
  of solid work; everything else waits until opened. Each refresh is
  incremental (previous brief + new events only). The footer says how old
  the brief is and why it ran, tallies what has happened since (counted
  from the event stream, free), and shows what refreshes it next, with a
  small meter filling toward the mid-turn refresh. The live status line
  under it says what the agent is doing right now, so the brief does not.
  Folder, model, tokens, cost and what the brief itself has cost sit
  behind the ⓘ in the session's title row.
- **Ask about this.** On every list, message, command, output, file, diff,
  shell run and the brief (or press `a`). Context starts as just that item;
  chips add its turn or the session brief. Answers come from a separate
  read-only call and never reach the session.
- **Close / delete.** Close hides a session from the deck (Undo, or find it
  under Hidden). Delete moves a finished session's transcript and subagent
  files to `~/.agent-deck/trash/` after a confirm.
- **New session.** Pick a folder, write the first prompt, choose a model and
  a permission mode (ask me, accept edits, auto, plan only). The deck runs
  `claude -p --input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio`, and the session shows up like any other.
  Any ended session (the deck's or not) can be continued
  with the resume (▷) button, which runs `--resume <id>`.
- **Status.** The line just above the prompt box says whose move it is: **CLAUDE**
  (thinking, writing, running a tool, waiting on subagents, with a clock) or
  **YOU** (your turn, Claude asked you a question, or a permission prompt).
  A working session with no new events for 90s shows as **quiet**, which
  may mean a stall. Sessions waiting on an answer pulse in the rail, and the
  tab title counts the sessions waiting on you.
- **Prompt.** Sits under the brief, above the tabs, so it stays in reach
  whichever tab is open; its header line collapses it and keeps the queue
  count in view. For deck sessions there is one send button (⌘↩): it sends
  when Claude is idle and queues while it works. The deck owns the queue and
  writes the next prompt only when the turn ends, so items can be moved,
  sent next or removed. Click a queued prompt to reword it in place: ⌘↩ or
  clicking away saves, Esc cancels, and the deck holds that prompt back
  while you type so a turn ending mid-edit does not send the old wording.
  **Send now** (the bolt, ⇧⌘↩) stops the current turn and sends the prompt
  ahead of the queue. **Stop** (the square, ⌘.) shows while Claude works:
  it ends the turn and holds the queue. The power button ends the process
  (sessions also end when the backend stops). For other sessions the panel
  is a read-only mirror of the queue.
- **Permissions.** A deck session's permission prompt shows as a card with
  the command, path or plan: Allow, Allow for session (applies the CLI's
  suggested rule or mode), or Deny with an optional reason for Claude. It
  counts as "your turn" in the rail and the overview. AskUserQuestion is
  turned off for deck sessions; Claude asks in plain text instead.
- **Events.** Virtualized, dense list, newest on top. **Live** (green
  dot) keeps the list and the details pane on the newest event; picking an
  event, scrolling away or opening a file greys it out, and clicking either
  Live button (list or details) brings both back to the newest event. `tool_use` and its result fold into
  one row with a tool-specific one-liner, duration, error chip, token cost.
  Thinking collapses to a faint row. Agent rows can be opened as a session or
  expanded inline. Prompts and turn ends are visual separators. Filter box,
  All / Tools / Messages / Errors, thinking toggle, Live. Keys:
  `j`/`k` move, `Enter` details, `a` ask, `Space` live / pause, `/` filter,
  `1`–`4` tabs, `Esc` overview, `?` help.
- **Details.** Markdown for assistant text; side-by-side diff for Edit;
  highlighted source for Read/Write (highlight.js vendored); command +
  stdout/stderr for Bash; decoded images; subagent card for Agent; JSON for
  everything else. Copy buttons, raw-record toggle, open in editor.
- **Files.** Union of Read/Edit/Write paths and file-history records with
  counts, last touched, hot/cold. Click to view, open in editor.
- **Changes.** `git status`, numstat, ahead/behind upstream and default
  branch, recent commits for the session's cwd or worktree. Click a file for
  a side-by-side diff. Refreshes every 10s while visible.
- **Shell.** Pilot's command runner: pick a cwd (defaults to the selected
  session's), run a command, see streamed stdout/stderr, exit code and
  duration, kill long runs. History with ↑/↓.

## Layout and security

```
server.mjs            http + sse + tail + git + shell
lib/transcript.mjs    the ONLY file that knows Claude Code's file formats
lib/sessions.mjs      registry, buckets, subagent tree, watching, loading
lib/brief.mjs         heuristic brief (instant state, NOW line, figures)
lib/briefs.mjs        generated brief: cadence, incremental prompts
lib/narrator.mjs      one-shot `claude -p` calls
lib/digest.mjs        events -> compact text for the model
lib/ask.mjs           Ask about this: scope resolution + answer
lib/deckstate.mjs     hidden sessions, delete trash
lib/gitinfo.mjs       status / diff / log
lib/shell.mjs         pilot shell runner
lib/agent.mjs         deck-launched sessions (stream-json control)
public/               index.html, app.js, events.js, styles.css, vendor/
design/               Claude Design canvas source for the current look
test/                 node --test; fixtures/ holds a sanitized transcript
```

The server binds `127.0.0.1` only and checks the launch token (query, cookie
or `X-Deck-Token`) on every request. Transcripts contain everything the
agents saw, and the Shell tab is remote code execution by design, so never
expose the port.

Transcript parsing is incremental (byte offset + partial line), so large,
growing transcripts are never re-read. Unknown record types render as raw
events instead of failing; the format is undocumented, so re-check
`lib/transcript.mjs` after a Claude Code upgrade (verified on 2.1.284).
