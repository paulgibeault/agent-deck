# agent-deck

A local cockpit for Claude Code agents. See every session and subagent on
this machine, follow their event streams at high fidelity, inspect what they
changed, and run your own commands next to them.

Phase 1 ("Telescope") is observe-only: it reads what Claude Code already
writes under `~/.claude` and never touches a running session. See
[PLAN.md](PLAN.md) for the full design and the later phases (read-aloud,
deck-launched sessions with prompt control).

## Run

```bash
node server.mjs
```

Prints a URL like `http://127.0.0.1:7777/?t=<token>`. Open it; the token is
stored in a cookie so the page can be reloaded without it. Node 20+, no
dependencies, no build step.

Flags and environment:

| Option | Default | Meaning |
|---|---|---|
| `--port N` / `DECK_PORT` | 7777 | listen port (always on 127.0.0.1) |
| `--days N` | 3 | sessions modified within N days count as "Recent" |
| `--token X` / `DECK_TOKEN` | random | fixed launch token (dev convenience) |
| `--open` | off | open the browser on start |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code keeps its state |
| `DECK_EDITOR` | `code` | command for "open in editor" (`<cmd> -g file:line`) |
| `--no-narrator` / `DECK_NARRATOR=off` | on | turn off the generated Brief and Ask (no model calls) |
| `DECK_BRIEF_MODEL` | `haiku` | model for the generated Brief |
| `DECK_ASK_MODEL` | `sonnet` | model for Ask about this |
| `DECK_CLAUDE_BIN` | `claude` | CLI used for model calls |
| `DECK_STATE_DIR` | `~/.agent-deck` | hidden sessions and the delete trash |

The Brief and Ask call `claude -p` with no tools, no MCP servers and no
session persistence, using whatever login the CLI already has. If that login
has expired the deck says so in the Brief; run `claude` in a terminal and
`/login`. To try both flows without a login, point `DECK_CLAUDE_BIN` at
`test/fixtures/fake-claude.mjs` (the `agent-deck-fake-model` preview config
does this).

Tests: `npm test` (parser, index, brief scheduler, Ask and trash against
`test/fixtures/session.jsonl`).

## What you get

- **Overview.** What shows when no session is open: sessions waiting on you
  or failing, cards for working agents with their brief, recently finished.
- **Sessions rail.** Active sessions grouped by repo, Recent, Closed, Hidden.
  Counters for working / your turn / with errors filter the list. Subagents
  show as a progress bar under their parent, running first.
- **States.** Four, one colour each: working (green), your turn (amber),
  done (blue), ended (grey). Red only means something failed.
- **Brief.** A model-written summary of the session to date: what it has
  done, a progress bar when the work has countable units, done / now / next,
  and a Watch line for risks that links to the event. Refreshed
  incrementally (previous brief + new events only): every 20s while you
  look at a working session, once per new activity when it is idle, every
  2m in the background for live sessions, paused otherwise. The heuristic
  NOW line (current tool and how long it has run) and token, cost and error
  figures stay instant and free.
- **Ask about this.** On every list, message, command, output, file, diff,
  shell run and the brief (or press `a`). Context starts as just that item;
  chips add its turn or the session brief. Answers come from a separate
  read-only call and never reach the session.
- **Close / delete.** Close hides a session from the deck (Undo, or find it
  under Hidden). Delete moves a finished session's transcript and subagent
  files to `~/.agent-deck/trash/` after a confirm.
- **Prompt.** Read-only mirror of the session's prompt queue with copy
  buttons. Send/interrupt are disabled for sessions the deck did not launch
  (that is phase 3).
- **Events.** Virtualized, dense list, newest on top; "follow" keeps the
  view pinned to the newest row. `tool_use` and its result fold into
  one row with a tool-specific one-liner, duration, error chip, token cost.
  Thinking collapses to a faint row. Agent rows can be opened as a session or
  expanded inline. Prompts and turn ends are visual separators. Filter box,
  All / Tools / Messages / Errors, thinking toggle, follow-tail. Keys:
  `j`/`k` move, `Enter` details, `a` ask, `Space` follow, `/` filter,
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
