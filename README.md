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

Tests: `npm test` (parser and index against `test/fixtures/session.jsonl`).

## What you get

- **Sessions tree.** Active (process alive, from `~/.claude/sessions`),
  Recent, Closed. Subagents nest under their parent with
  running / done / stale status, worktree branch and agent type.
- **Brief.** Heuristic, instant, no model calls: state (running `npm test`,
  waiting on 2 subagents, idle 4m, ended), last assistant sentence, tokens
  this turn and session, Claude Code's own cost figure, files touched,
  errors, branch, PR link, queue depth.
- **Prompt.** Read-only mirror of the session's prompt queue with copy
  buttons. Send/interrupt are disabled for sessions the deck did not launch
  (that is phase 3).
- **Events.** Virtualized, dense list, newest on top; "follow" keeps the
  view pinned to the newest row. `tool_use` and its result fold into
  one row with a tool-specific one-liner, duration, error chip, token cost.
  Thinking collapses to a faint row. Agent rows can be opened as a session or
  expanded inline. Prompts and turn ends are visual separators. Filter box,
  hide thinking/queue toggles, follow-tail. Keys: `j`/`k` move, `Enter`
  details, `Space` follow, `/` filter, `1`–`4` tabs.
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
lib/brief.mjs         heuristic brief
lib/gitinfo.mjs       status / diff / log
lib/shell.mjs         pilot shell runner
public/               index.html, app.js, events.js, styles.css, vendor/
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
