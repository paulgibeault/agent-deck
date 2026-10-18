# agent-deck — harness-agnostic plan (opencode on the household model)

Written 2026-10-17. Goal: drive opencode, running on the household node's local
model (`qwen3.6-35b-a3b` via the open-act tunnel at `127.0.0.1:8080`), from the
deck with the same cockpit experience Claude Code gets today. Priorities:
simplicity, modularity, reuse. Zero npm dependencies still holds.

Facts below were verified against opencode 2.0.32 on 2026-10-17 (probe
transcripts were in `/tmp/ocprobe/`).

---

## 1. The shape of the change

Today the deck is Claude Code end to end, through four channels:

| Channel | Today | Coupling |
|---|---|---|
| Control (launch/send/interrupt/permissions) | `lib/agent.mjs` spawns `claude -p` stream-json | protocol + modes |
| Events (what the UI renders) | tail `~/.claude/projects/*.jsonl` → `lib/transcript.mjs` | file layout + record shapes |
| One-shot model (Brief, Ask) | `lib/narrator.mjs` spawns `claude -p` | CLI flags |
| Quota | `lib/usage.mjs` (`/usage`, rate-limit events) | Claude subscription |

The one good seam already exists: **the normalized event** (`transcript.mjs`
header) and **`publicState`**. Everything downstream (digest, attention,
turnsnap, brief, the UI's stream) consumes those. So the plan is: keep those as
the contract, make Claude one *harness* that produces them, and add a second
harness that speaks **ACP** (Agent Client Protocol).

Why ACP and not opencode's HTTP service or its SQLite DB:

- **One stream gives control and events.** For a deck-launched session, ACP's
  `session/update` notifications *are* the event stream. No file tailing, no
  second channel to keep in sync.
- **It's a standard.** The same client drives any ACP agent (opencode, Gemini
  CLI, Claude via an adapter), which is PLAN.md §6's "standards first" and
  open-act's "harness-agnostic" rule. opencode is the first, not the only one.
- **History comes free.** `session/list` + `session/load` replay a past
  session as the same `session/update` stream, so live and history share one
  parser. Nothing reads opencode's DB.

## 2. Modules

```
lib/acp.mjs              NEW  generic ACP client: JSON-RPC 2.0 over stdio (~150 lines)
lib/acp-events.mjs       NEW  ACP session/update → normalized events (only module that knows ACP shapes)
lib/harness/claude.mjs   MOVED protocol half of today's agent.mjs (spawn args, stream-json in/out)
lib/harness/acp.mjs      NEW  ACP driver: one acp process, many sessions
lib/agent.mjs            SLIMMED generic manager: queue, held, idle stop, wake, modes store, publicState
lib/llm.mjs              NEW  one-shot model call: `claude -p` or OpenAI-compatible fetch
lib/harnesses.mjs        NEW  registry: config → harness instances, capability flags
```

`transcript.mjs` stays the only module that knows Claude's shapes;
`acp-events.mjs` is the only one that knows ACP's. That rule (PLAN.md §75) is
what keeps this modular.

### 2.1 `lib/acp.mjs` — the reusable piece

A tiny, harness-neutral client. No opencode knowledge.

```js
const conn = new AcpConnection({ bin: 'opencode', args: ['acp'], env, cwd });
await conn.initialize({ fs: false, terminal: false });   // → agentCapabilities
conn.request(method, params)   // → Promise<result>, rejects on JSON-RPC error
conn.notify(method, params)    // session/cancel
conn.on('update', ({ sessionId, update }) => …)            // session/update
conn.onRequest('session/request_permission', handler)      // agent → client requests
conn.close()                   // graceful: session/close each session, end stdin, then signals
```

Notes from probing: agent→client request ids start at 0 (don't assume ≥1);
opencode never calls `fs/*` or `terminal/*`, so advertise neither and implement
neither (unknown agent→client methods get a `-32601` reply).

### 2.2 `lib/agent.mjs` split — reuse what's already right

`AgentManager` already owns the hard, harness-neutral parts: the deck-side
queue, `held`, merge-and-interrupt (`sendNow`), idle stop after 30 min, wake on
send, persisted modes, `publicState`, `registryEntries`. Keep all of that. Move
only the protocol into a driver with a small interface:

```js
// driver: one per harness (built in phase 3 as lib/harness/claude.mjs)
driver.caps                                    // { modes, resume, events: 'transcript' | 'stream' }
driver.start({ id, cwd, model, permissionMode, name, resume }) → session   // one handle per session
session.pid
session.send(text, attachments) → bool         // a prompt; false if it can't take input
session.interrupt()                            // ask the agent to end the turn
session.answer(permission, decision, message)  // 'allow' | 'always' | 'deny'
session.signal(sig) / session.stop()           // stop: end input, then escalate
events: 'init' {sessionId, model, permissionMode}, 'result' {…lastResult},
        'permission' {requestId, …}, 'permission-cancel' requestId, 'ratelimit', 'exit' {code, signal, stderr}
```

A handle per session (rather than id-keyed driver methods) keeps a resume
that comes back with a new id simple, and fits ACP too: the ACP driver's
handles share one `AcpConnection`.

The queue matters more for ACP than for Claude: opencode rejects a second
prompt on a busy session (`Session already has an active ACP prompt`), and
`AgentManager._pump` already guarantees one turn at a time.

The record gains a `harness` field; `publicState` gains `harness` and
`options` (the modes/models the session advertised, see 2.5).

### 2.3 Events: one store, two producers

`SessionIndex` keeps owning sessions. Today each session's events come from
`SessionState.ingest(jsonlRecord)`. Add a second entry point,
`SessionState.push(normalizedEvent)`, used by the ACP driver. Claude sessions
keep their tailer; ACP sessions have no file, so the index learns about them
from `agents.registryEntries()` (already wired as `index.external`).

`acp-events.mjs` mapping (all fields observed live):

| ACP update | Normalized event |
|---|---|
| (our own prompt) | `prompt` (the deck knows what it sent) |
| `user_message_chunk` (replay only) | `prompt` |
| `agent_message_chunk` | `text`, chunks merged by `messageId` |
| `agent_thought_chunk` | `thinking`, merged by `messageId` |
| `tool_call` / `tool_call_update` | `tool` keyed by `toolCallId`: `pending` until completed/failed; `input` ← `rawInput`; `result.text` ← content text; `diff` ← `{type:'diff',path,oldText,newText}` content; `isError` on failed |
| `usage_update` | session meta: context `used`/`size`, `cost` |
| prompt response `{stopReason, usage}` | `turn_end` (+ inference usage) |
| `config_option_update` | session meta: mode/model/effort |
| `available_commands_update` | session meta (slash commands, later) |
| anything else | `raw` (existing degrade-gracefully rule) |

`turn_end` is synthesized from the prompt response, so turnsnap, briefs and
attention (which key off `prompt`/`turn_end`) work unchanged.

### 2.4 Tool vocabulary: classify by ACP `kind`, not tool name

The UI's tool table is keyed by Claude tool names (`Read`, `Edit`, `Bash`…).
ACP standardizes a `kind` per call: `read | edit | delete | move | search |
execute | think | fetch | other`. Normalized tool events get a `tool.kind`; for
Claude, `transcript.mjs` fills it from a small name→kind map. Then
`classify.js`, `activity.js`, `changes.js` and the detail renderers branch on
`kind` first and keep their Claude-name special cases as refinements. One
vocabulary instead of N tables, and any future ACP agent renders correctly on
day one.

Field normalization in the same pass: tool events carry `tool.paths` (from ACP
`locations`, or Claude's `file_path`) and `tool.command` (ACP `rawInput.command`,
Claude `command`), so renderers stop reaching into harness-specific inputs.

### 2.5 Modes and models come from the session, not constants

`PERMISSION_MODES`, the launch dialog's `<select>`, and `MODELS` in `app.js` are
Claude constants. ACP sessions advertise theirs in `configOptions`
(opencode: mode `build|plan`, effort `low|medium|high|default`, model
`household/qwen3.6-35b-a3b`). Harnesses expose `caps.modes`/`caps.models`; the
UI renders whatever the selected harness offers. Claude's list moves into
`harness/claude.mjs` as its caps.

### 2.6 Permissions: map, don't reinvent

ACP's `request_permission` carries `options: [{optionId, kind}]` with kinds
`allow_once | allow_always | reject_once | reject_always`. The deck's three
buttons map onto kinds (`allow`→`allow_once`, `always`→`allow_always`,
`deny`→`reject_once`); `answer()` picks the matching `optionId`. The diff in the
request's `toolCall.content` feeds the existing permission card.

Behavior to know: rejecting in opencode ends the whole turn
(`stopReason: cancelled`); the model doesn't get to try something else.

### 2.7 `lib/llm.mjs` — Brief and Ask on the local model

`Narrator.run({system, prompt, model})` is the only call site, so swap its
transport, keep its contract (`{text, costUsd, durationMs}`, concurrency 2,
timeout, `fatal` errors):

- `claude` transport: today's code, unchanged.
- `openai` transport: `fetch(POST {url}/chat/completions)` with
  `[{role:'system'},{role:'user'}]`; cost from `usage` or 0. Qwen emits reasoning
  separately; take `message.content` only.

Config: `DECK_LLM=openai DECK_LLM_URL=http://127.0.0.1:8080/v1
DECK_LLM_MODEL=qwen3.6-35b-a3b`. Prompts that say "Claude Code agent session"
become "coding-agent session". This step stands alone and is the cheapest win:
the deck's own model calls go local before any harness work lands.

### 2.8 Quota and usage

`usage.mjs` stays Claude-only, shown only when the Claude harness is enabled.
ACP sessions show a **context meter** from `usage_update` (`used`/`size`), which
for a 64k local model is the number that actually matters. The pricing table
treats unknown models as $0, which is correct for the household model.

## 3. Harness config

One small file, `~/.agent-deck/harnesses.json`, defaults if absent:

```json
{
  "default": "opencode",
  "harnesses": {
    "claude":   { "type": "claude", "bin": "claude" },
    "opencode": { "type": "acp", "bin": "opencode", "args": ["acp"], "label": "opencode · household" }
  }
}
```

The launch dialog gets a harness picker (default from config). Adding Gemini
CLI or another ACP agent later is a config entry, not code.

## 4. Lifecycle and gotchas (verified)

- **One `opencode acp` process per deck**, many sessions in it (parallel
  sessions worked; three processes sharing the DB also worked). Start it
  lazily on first ACP launch; stop it when no ACP session has been active for
  the idle window.
- **Shut down gracefully.** Killing acp mid-turn leaves the session suspended;
  opencode's background service later auto-resumes it with a pending
  permission nobody can answer. `conn.close()` must `session/close` live
  sessions and wait before signaling. Deck `stopAll()` already exists; route it
  here.
- **cwd must be absolute and exist**, and `session/load`/`resume` require the
  original cwd. Store cwd in the record (already done); realpath paths in
  `acp-events` (`/tmp` vs `/private/tmp`).
- **Resume vs load:** wake uses `session/resume` (no replay, context kept).
  Opening an old session that isn't in memory uses `session/load` (replays into
  `acp-events`).
- **Permissions are open by default in opencode** (`*: allow`), so the deck's
  permission cards would never fire without config. Settled in §7.
- **Titles** are generated asynchronously by opencode and not pushed over ACP;
  use the first prompt as the title, refresh from `session/list` when the
  session goes idle.

## 5. Changes worth making to the platform itself

Since the deck is being reshaped anyway:

1. **Rename the contract, not just the code.** `package.json`/README/PLAN.md
   say "cockpit for Claude Code agents"; make it "for coding agents," with
   Claude Code and ACP as the two drivers. UI copy (`What should Claude do?`,
   actor label `CLAUDE`, `claude --resume`) comes from the harness
   (`label`, `resumeCommand(id)` → `opencode -s <id>`).
2. **Fold the "two channels" into one for deck-launched Claude sessions too —
   later, optional.** Claude's stream-json stdout already carries the
   messages; the deck tails the jsonl only because that was the first
   working path. Keeping the tailer is right for observing foreign sessions,
   so this is a cleanup, not part of this plan.
3. **open-act side:** the client bootstrap already writes `opencode.json`.
   Have it also print (or write) the deck's `DECK_LLM_*` and harness entry, so
   a new household Mac gets cockpit + local model in one step. The model id
   and context size already live in `client.conf`; reuse them, don't
   duplicate.

## 6. Phases

Each phase ships on its own and keeps `npm test` green. Tests follow the
existing convention: a fake binary per external CLI.

1. **Local Brief/Ask** — `lib/llm.mjs` openai transport + env config; prompt
   wording. Test against a tiny fake HTTP server. *Small; immediate value.*
2. **ACP client** — `lib/acp.mjs` + `test/fixtures/fake-acp.mjs` (scripted
   agent: init, new, prompt with chunks, a tool call, a permission request,
   cancel). Unit tests for framing, request/response, errors, agent→client
   requests, graceful close.
3. **Driver split** — move protocol out of `agent.mjs` into
   `harness/claude.mjs`; no behavior change. Existing `agent.test.mjs` must
   pass untouched; that is the proof the seam is right.
4. **opencode sessions** — `harness/acp.mjs`, `acp-events.mjs`,
   `SessionState.push`, registry entries, launch-dialog picker, modes/models
   from caps. Fixture-driven tests plus one manual run against the real
   household model.
5. **Vocabulary** — `tool.kind`/`paths`/`command` normalization; UI branches on
   kind; context meter; harness-driven copy.
6. **History** — list past opencode sessions via `session/list`, open them via
   `session/load`.
7. *(Optional)* **Observe foreign opencode sessions** (TUI, `opencode run`)
   via the background service's SSE `/api/event`. Volatile stream with Basic
   auth from `~/.local/state/opencode/service.json`; worth it only if you
   drive opencode outside the deck often. Note: `opencode acp` sessions don't
   appear on that stream, so it doesn't help deck sessions.

## 7. Decisions (agreed 2026-10-17)

1. **Permissions ask first.** File edits and shell commands require approval
   (`"permission": {"edit": "ask", "bash": "ask"}`). The open-act client
   bootstrap now writes this into the global `opencode.json`; verified that
   `opencode acp` then sends `session/request_permission` for a write. This
   matches the deck's current "default" mode; "auto" answers allow.
2. **Default harness: opencode** (household model) in the launch dialog.
3. **Claude stays a harness.** Same seam, no extra cost; the deck keeps
   observing Claude sessions either way.
