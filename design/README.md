# Redesign (2026-09-30)

Source files for the Claude Design canvas
<https://claude.ai/artifact/A93yVbnw9n7fjxaXANYrM1> (private to the owner).
These are mockups, not app code; `public/` implements them.

| Board | What it specifies |
|---|---|
| `Main.dc.html` | Session view: close/delete, generated Brief (summary, progress, done/now/next, watch), event rows grouped by turn, details pane with the docked Ask composer |
| `Overview.dc.html` | What shows when no session is selected: needs-you, working cards with brief freshness, recently finished |
| `Rail.dc.html` | Sessions rail grouped by repo, counters, subagent progress |
| `Anatomy.dc.html` | Palette, session states, event kinds, row states, brief refresh cadence, Ask about this |

Decisions taken with the design:

- Four session states only: working (green), your turn (amber), done (blue), ended (grey). Red is reserved for errors.
- The Brief is model-generated from the transcript to date and refreshed incrementally: every 20s while shown and working, at turn end while shown and idle, every 2m when not shown but working, paused when not shown and idle, once when ended. The heuristic brief stays as the instant fallback.
- "Ask about this" exists on every list, text block, output and buffer. Context starts as the item itself; the pilot adds parents (command, turn, brief) explicitly. Answers come from a separate read-only model call and never reach the session.
- Close hides a session from the deck (the deck cannot stop sessions it did not launch). Delete removes its transcript files after a confirm.
