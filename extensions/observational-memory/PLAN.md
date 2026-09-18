# Observational Memory — Implementation Plan (v1)

> Companion to `Observational memory — design.md`. The design doc is the *what/why*;
> this is the *how*. Decisions 1–12 from the design are assumed. The open items below
> were resolved with the user before writing this plan (see **Locked decisions**).

Priorities: **performance > speed >= cost**. Cost is the least important factor.

---

## Locked decisions (resolved with user)

| # | Topic | Decision |
|---|---|---|
| L1 | **Build order** | **Phased: A (short-term tier + TUI) → B (long-term tier).** TUI is built from the start (it is the observability surface for the extension itself), not deferred. |
| L2 | **Worker spawning** | **Bespoke `child_process.spawn` of `pi -e <agent-ext> -p`** (the yt-edit launcher pattern). *Not* the `subagents` extension — that uses `--no-session --mode json`, which would defeat decision 11's "every worker is an ordinary recorded global session" observability requirement. |
| L3 | **OM code reuse** | **Vendor/fork** the needed OM modules into this repo (`session-ledger` fold/progress/projection/render, `tokens`, `ids`, `serialize`, `debug-log`), **trimmed to the minimal `{timestamp, content}` schema** and with the reflections tier removed. No runtime dependency on the unstable OM `master` checkout. |
| L4 | **Extension structure** | **One shared agent extension, env-parameterized by worker type** (`OM_WORKER=observer\|consolidator`), mirroring yt-edit's `FINALIZE_MODE` switch. Plus a separate **master-side orchestrator** extension. |
| L5 | **Timestamp-id** | **Orchestrator-assigned**, anchored to the chunk's source-entry times, with a deterministic disambiguator suffix. The observer emits minute-resolution event times (OM-proven); the orchestrator derives the precise unique id at commit. Avoids the LLM copy-fidelity risk (design risk 7). |
| L6 | **Dev default models** | **Strong model everywhere** for bring-up: `anthropic/claude-sonnet-4-6`, `thinking: low` for observers, `thinking: medium` for the consolidator. Fully overridable in config; tune the cheap-observer split later. |
| L7 | **Per-session on/off gate** | A simple **default-OFF** master switch (`/om`, `/om on/off`), persisted per-session in the ledger. When off the extension is completely inert/invisible. Needed because it ships in the global extensions folder during development. See A2a. |

### Phasing consequence to keep in mind (stated explicitly)

Phase A ships **without** the consolidator. Nothing drains the observation buffer, so it is
**not yet bounded** — it grows like OM pre-dropper until compaction renders it. This is an
acceptable, fully-testable intermediate state (observer → ledger → injection → compaction →
`/tree` all exercised). Bounding (`poolTargetTokens`) and the file tier arrive in Phase B
with the consolidator. The compaction renderer in Phase A renders *all* active observations
up to the cutoff; the same renderer in Phase B renders the *bounded* buffer because the
consolidator has tombstoned the overflow.

---

## Component map → pi surfaces

```
MASTER SESSION
└─ orchestrator extension  (in-process, event-driven; the "conductor")
     • clocks/triggers       → pi.on("turn_end" | "agent_end")
     • spawns workers        → child_process.spawn(pi -e agent-ext -p ...)
     • commits observations  → pi.appendEntry("om.observations.recorded", …)   [ledger]
     • tombstones the batch  → pi.appendEntry("om.observations.dropped", …)    [ledger, Phase B]
     • deterministic compact → pi.on("session_before_compact") → {summary, firstKeptEntryId, …}
     • compaction trigger    → pi.on("agent_end") → ctx.compact() when over threshold & idle
     • TUI                    → ctx.ui.setStatus / setWidget / notify
     • commands               → /om:status, /om:compact (debug surfaces)

WORKER SESSIONS  (subprocess `pi`, headless, recorded in global store)
└─ agent extension (OM_WORKER=observer|consolidator)
     • before_agent_start     → replace system prompt for the worker role
     • --no-builtin-tools     → register only the tools the role needs
     • observer: record_observations (terminal) → writes .memory/.runs/<runId>.json → ctx.shutdown()
     • consolidator: read/write/edit scoped to .memory/ (no terminal tool; natural exit) [Phase B]
```

The two extensions live in this repo and are wired by the orchestrator at spawn time with
the verified flag set (below).

---

## Repository layout

```
observational-memory/
  package.json            # deps: @earendil-works/pi-coding-agent, pi-ai, pi-agent-core, typebox, pi-tui; dev: vitest, typescript
  tsconfig.json
  vitest.config.ts
  README.md               # user-facing: what it does, config, commands
  PLAN.md                 # this file
  src/
    index.ts              # ORCHESTRATOR entry (master-side). Default export.
    config.ts             # load/merge settings (global + project), defaults
    runtime.ts            # in-process state: in-flight flags, clocks, status controller
    ledger/               # VENDORED + trimmed from OM (minimal schema, no reflections)
      types.ts            # Entry, Observation {timestamp, content, tokenCount}, entry-data guards/builders
      fold.ts             # foldLedger → active observations (drops applied)
      progress.ts         # source-entry detection, coversUpToId watermarks, raw-token clocks
      projection.ts       # buildCompactionProjection (observations up to firstKeptEntryId)
      render.ts           # deterministic injection block: map (Phase B) + observations
      serialize.ts        # serialize source-entry slice → observer prompt chunk
      ids.ts              # orchestrator timestamp-id assignment + disambiguation (L5)
    tokens.ts             # estimateEntryTokens / estimateStringTokens (vendored)
    debug-log.ts          # NDJSON + runId correlation (vendored, optional)
    spawn/
      launch.ts           # buildArgv + spawnHeadless + waitForExit + read result file (L2)
      runs.ts             # .memory/.runs/<runId>.json read/write helpers (IPC)
    hooks/
      observer-trigger.ts # raw-token clock → spawn parallel observers, commit results
      consolidator-trigger.ts  # [Phase B] pool-token clock → spawn one consolidator, tombstone promoted
      compaction-trigger.ts    # agent_end → ctx.compact() when over compactAtContextTokens & idle
      compaction-hook.ts       # session_before_compact → render map+buffer, cutoff on chunk boundary
    commands/
      status.ts           # /om:status
      compact.ts          # /om:compact
    ui/
      status-controller.ts # footer "om", per-worker widgets, start/finish toasts
    memory/               # [Phase B]
      paths.ts            # .memory/ resolution, atomic write (temp+rename)
      index-render.ts     # render INDEX.md from topic front-matter
  agent/                  # the SHARED worker agent extension (loaded via -e in subprocess)
    index.ts              # default export; branches on OM_WORKER env
    observer/
      prompt.ts           # observer system prompt (extract atomic events from THIS chunk)
      tool.ts             # record_observations terminal tool → write result file → ctx.shutdown()
    consolidator/         # [Phase B]
      prompt.ts           # topic-routing prompt (create/split/merge/rewrite)
      tools.ts            # scoped read/write/edit/ls/grep (no terminal tool; natural exit)
  tests/
    ledger.fold.test.ts
    ids.test.ts
    compaction-cutoff.test.ts
    render.test.ts
    spawn.smoke.test.ts
```

Ledger custom-types are namespaced **`om.*`**. (This extension supersedes and replaces the
old observational-memory extension; they are never run together, so no namespace separation
from it is needed.)

---

## Data shapes

### Observation (minimal, L5)

```ts
type Observation = {
  timestamp: string;   // "YYYY-MM-DDTHH:MM:SS[.NN]" — orchestrator-assigned id+time
  content: string;     // single-line plain prose
  tokenCount: number;  // computed in code, not by the model
};
```

The observer model emits `{ timestamp: "YYYY-MM-DD HH:MM", content }` (minute resolution,
OM-proven). The orchestrator, at commit, **re-derives** a precise, unique id-timestamp:
- anchor to the source entry the observation cites (or the chunk's time span midpoint if no
  cite in v1's no-`sourceEntryIds` world → use the chunk's bounding source-entry timestamps),
- ensure strict uniqueness across the committed batch by appending `.01`, `.02`, … when two
  observations resolve to the same second.

> v1 has no `sourceEntryIds` in the stored unit (decision 9). To anchor timestamps the
> orchestrator uses the **chunk boundary source-entry times** it already knows (it built the
> chunk), distributing observations across that span in model-emitted order. Exact per-obs
> source attribution returns with the critic/drill-to-source tier (post-v1).

### Ledger entries (vendored, trimmed)

```ts
// om.observations.recorded
data: { observations: Observation[]; coversUpToId: string }

// om.observations.dropped   (Phase B — consolidator promotion tombstones)
data: { observationTimestamps: string[]; coversUpToId: string }
```

`coversUpToId` semantics are unchanged from OM: a progress + projection watermark equal to
the id of the last source entry the worker covered. Folding to a `/tree` position replays
entries whose `coversUpToId` resolves at-or-before that position — this is what makes
short-term memory roll back natively (design requirement).

### Compaction details

```ts
details: { type: "om.folded"; version: 1; observations: Observation[] }
```

Rendered by `session_before_compact`; read back by any future visible projection.

---

## Phase A — short-term tier + TUI

Goal: a working observer → ledger → injection → compaction loop that is correct under
`/tree`, with full TUI/observability. No `.memory/` files yet.

### A1. Scaffolding
- `package.json`, `tsconfig`, `vitest`. Copy the dependency set from OM's `package.json`.
- Vendor + trim from OM: `tokens.ts`, `ids.ts` (then extend for L5), `serialize.ts`,
  `debug-log.ts`, and `ledger/{types,fold,progress,projection,render}.ts`. Strip reflections,
  `relevance`, `sourceEntryIds`, hash-ids, dropper-specific pool logic. Keep watermark folding,
  source-entry detection, raw-token clocks, compaction projection, deterministic render.
- Port OM's vitest suites for the kept modules; delete reflection/relevance assertions.

### A2. Orchestrator skeleton (`src/index.ts`, `runtime.ts`, `config.ts`)
- `session_start`: read the persisted on/off gate (A2a); `ensureConfig(ctx.cwd)`; if **on**,
  attach TUI status (`setStatus("om", "om")`); if **off**, stay fully invisible.
- `session_shutdown`: detach status, abort in-flight workers.
- In-process `Runtime`: `enabled: boolean`, `observersInFlight: Map<runId, AbortController>`,
  clocks, last-error, status controller. Event-driven only — **no daemon/timer** (per design +
  extension rules).

### A2a. Per-session on/off gate (default OFF) — simple, like `memory.ts`
- **Why:** the extension lives in the global `~/.pi/agent/extensions/` folder during
  development, so it would otherwise attach to *every* pi session. The gate keeps it inert
  unless explicitly enabled in a session.
- **State:** persisted per-session via `pi.appendEntry("om.enabled", { enabled })`. On
  `session_start`, scan the branch backwards for the latest `om.enabled` entry; default
  `false` if none. Survives restarts/resume within that session lineage.
- **Command:** `/om` toggles; `/om on` / `/om off` set explicitly. On change: append the state
  entry, attach/detach TUI, `ctx.ui.notify("om enabled/disabled")`.
- **Gate semantics:** when `enabled === false` the extension is **completely invisible and
  does nothing** — every trigger (`turn_end` observer clock, `agent_end` compaction trigger),
  the `session_before_compact` hook, all TUI, and all worker spawning return immediately at the
  top. No footer, no widgets, no ledger writes, no subprocesses. A single `if (!runtime.enabled) return;`
  is the first line of every handler (mirrors OM's `passive` short-circuit, but here it is the
  master switch and defaults off).
- Distinct from config `passive`: `passive` is a power-user setting; the gate is the
  build-time master switch and is the outermost guard.

### A3. Parallel observers (`hooks/observer-trigger.ts`, `spawn/`)
- Trigger on `turn_end` (and `agent_start` for catch-up, mirroring OM).
- Clock: `rawTokensSinceObservationCoverage(branch) >= chunkTokens` (5000 default).
  Unlike OM (which couples observers sequentially), **cut at fixed token boundaries** and
  **fire observers in parallel** — each is a pure mapper over its own chunk. The watermark
  advances per committed chunk; multiple chunks can be in flight at once.
- For each due chunk:
  1. Select the source-entry slice after the latest covered watermark, bounded to ~`chunkTokens`.
     `coversUpToId` = last source entry id in the slice.
  2. `serializeSourceAddressedBranchEntries(slice)` → serialized chunk; wrap with a short
     framing line (current local time + instruction) to form the `-p` prompt (no prior
     observations needed).
  3. Spawn observer subprocess (A4), passing that prompt as `-p`. TUI: widget `◐ [observer]`
     keyed by `<runId>`, start toast.
  4. On exit: read `.memory/.runs/<runId>.result.json`; validate; **commit on the master ledger**:
     - assign disambiguated timestamp-ids (L5),
     - `pi.appendEntry("om.observations.recorded", { observations, coversUpToId })`.
     - TUI: `✓ [observer] +N`, finish toast. On failure: `✗`, error toast, record last-error.
- Concurrency: observers are independent; cap via a small semaphore (default 4) to bound spawn
  load. Out-of-order completion is fine — each commit carries its own `coversUpToId`.

> **Chunk overlap:** default **0** in v1 (simplest). Boundary-spanning events are tolerated;
> the consolidator dedupes in Phase B. `chunkOverlapTokens` is a config knob, defaulting 0.

### A4. Subprocess launch (`spawn/launch.ts`) — the yt-edit pattern (L2)
```
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
   --no-builtin-tools \
   --model <m> --thinking <t> \
   -e <repo>/agent/index.ts \
   -n om-observer-<runId> \
   -p "<framing line + serialized chunk>"
```
- `-p` is the print/headless flag; the positional arg is the **full prompt** = a short framing
  line (current local time + instruction) followed by the serialized chunk. **The chunk is the
  `-p` prompt** so it is recorded as a real user message in the worker's global session and
  stays faithfully inspectable on resume (decision 11's observability requirement). This is the
  old-OM shape (chunk in the user message), now carried by the recorded `-p` prompt.
- **Why not the `context` hook / system prompt:** the `context` hook is non-destructive — its
  injected messages are used for the LLM call but **never persisted** to the session, so the
  chunk would be invisible when inspecting/resuming the observer run (verified). Putting the
  chunk in the system prompt has the same recall value but is the wrong semantic slot. So the
  chunk rides the recorded `-p` prompt instead.
- **Arg length:** at v1 defaults (`chunkTokens` 5 000 ≈ 20 KB) this is far under `ARG_MAX`
  (1 MB on macOS; per-arg 128 KB on Linux). A pathologically large `chunkTokens` could approach
  the Linux per-arg cap — a tuning concern, not a v1 risk.
- env: `OM_WORKER=observer`, `OM_RUN_ID=<runId>`, `OM_RESULT_PATH=<abs .memory/.runs/<id>.result.json>`.
  No chunk file / `OM_CHUNK_PATH` — the chunk travels as the `-p` prompt.
- `cwd` = master's `cwd` (so the worker session is recorded under the project path in the
  **global** store `~/.pi/agent/sessions`, satisfying decision 11 — no `--session-dir`).
- Resolve the `pi` binary via `process.argv[1]` realpath (subagents' `resolvePiBinary` trick),
  falling back to `pi` on PATH.
- Completion: the worker's terminal tool writes the result file then calls `ctx.shutdown()`;
  the parent `await`s process exit, then reads + validates the result file. Non-zero exit or
  missing/invalid file → error path.

### A5. Worker agent extension (`agent/index.ts`, `agent/observer/`) (L4)
- Default export branches on `process.env.OM_WORKER`.
- `before_agent_start`: **replace** the system prompt entirely with the observer
  instructions (return `{ systemPrompt: OBSERVER_SYSTEM }`). The system prompt contains
  role definition and quality rules only — **no chunk content**. Builtins already
  disabled by `--no-builtin-tools`.
- **Chunk delivery is the recorded `-p` prompt** (built by the orchestrator, see A3/A4) — the
  agent does nothing special to receive it; pi records it as the first user message. The agent
  deliberately does **not** use the `context` hook (non-destructive → not persisted → invisible
  on resume). System prompt/user-message boundary stays correct: system prompt = persistent
  instructions; user message = this run's input, and it survives in the session record.
- Register `record_observations` (typebox schema: `{ observations: [{ timestamp, content }] }`,
  minute-resolution timestamp pattern). On call: accumulate; on the terminal call (model stops),
  write `OM_RUNS_DIR/OM_RUN_ID.json` = `{ observations: [...] }`, then `ctx.shutdown()`.
- Prompt = trimmed OM observer prompt: "extract atomic events from THIS chunk; one line each;
  no markdown; prefer inline conversation timestamps." Drop relevance/sourceEntryIds language.

### A6. Compaction (`hooks/compaction-trigger.ts`, `hooks/compaction-hook.ts`)
- **Trigger** (`turn_end`): if context pressure `>= compactAtContextTokens` and not already
  compacting → `ctx.compact()` (fire-and-forget). `ctx.compact()` synchronously disconnects +
  aborts the agent loop up front, so firing it from `turn_end` is race-free; the
  `session_before_compact` hook waits for in-flight observers so the block reflects settled
  state. We fire on `turn_end` (not `agent_end`) so compaction pauses the chat *between* turns.
- **Auto-resume after a mid-run compaction** (`resumeAfterMidRunCompaction`, default true):
  a manual/threshold compaction always leaves the session idle (only pi's *internal overflow*
  path auto-retries). To make a mid-run compaction transparent, in `onComplete` we resume the
  agent ourselves via `ctx.sendMessage({ customType: "om.resume", display:false }, { triggerTurn:true })`
  — a hidden custom message pi surfaces to the model as a user turn (no agent-*invisible* resume
  exists through the public API; `convertToLlm` rewrites custom→user). The resume fires **only**
  when the turn had pending tool work. A `turn_end` that is also the run's terminal turn
  (`toolResults` empty) is left to stop, exactly as if no compaction happened. The mid-run
  decision is captured from the `turn_end` event *before* compaction aborts/reloads.
- **Hook** (`session_before_compact`), deterministic + model-free:
  1. `preparation.firstKeptEntryId` gives pi's proposed kept tail. **Snap** it to the nearest
     **observation chunk boundary** (a covered `coversUpToId` source-entry id) such that the
     verbatim tail ≈ `tailTokens`. The actual tail may be slightly larger/smaller to align.
  2. `buildCompactionProjection(branch, snappedFirstKeptId)` → active observations whose
     `coversUpToId` ≤ cutoff. Observations whose source lies in the kept tail are **excluded**
     (already verbatim) — this falls out of the projection boundary automatically.
  3. `renderSummary(map, observations)`: Phase A renders only the observations section
     (chronological, verbatim, `YYYY-MM-DDTHH:MM:SS  content`). The map section is a no-op
     placeholder until Phase B.
  4. return `{ compaction: { summary, firstKeptEntryId: snapped, tokensBefore, details } }`.
  - Guard against re-entrant hooks (OM's `compactHookInFlight`).

### A7. TUI (`ui/status-controller.ts`) — from the start (L1)
- Footer: `ctx.ui.setStatus("om", "om")` once at load; never cleared mid-session.
- Per-worker widgets keyed `<type>-<runId>` so parallel observers **stack**:
  - working: animate `◐◓◑◒` via periodic `setWidget` (interval cleared on finish/shutdown);
  - success: `✓ [observer] +N`, hold 5s, then `setWidget(key, undefined)`;
  - error: `✗ [observer]`, hold 5s, clear.
- Toasts via `ctx.ui.notify`: observer start (chunk tokens), finish (chunk tokens + N obs),
  error (+message). All gated on `ctx.hasUI`.

### A8. Commands (debug + control)
- `/om`, `/om on`, `/om off`: the on/off gate (A2a).
- `/om:status`: in-flight workers, observation count, next-observer token progress, live
  context usage vs `compactAtContextTokens`, last worker error. Reports "om is off" when gated off.
- `/om:compact`: force `ctx.compact()` now (ignores threshold). No-op when gated off.

### A9. Phase A acceptance
- Long scratch session: observers fire every ~`chunkTokens`, widgets stack, toasts log,
  observations appended to ledger; `/om:status` accurate.
- Compaction at threshold renders the observation block; cutoff lands on a chunk boundary; the
  verbatim tail is not double-represented.
- **`/tree` rollback**: navigate back past observation commits → folded buffer shrinks
  correctly (watermark folding); continue on a new branch → re-observation works. This is the
  primary Phase A test surface (design: short-term is `/tree`-testable).

---

## Phase B — long-term tier (consolidator + `.memory/`)

Goal: bound the buffer and gain durable, navigable, cross-session topic files.

### B1. `.memory/` substrate (`src/memory/paths.ts`)
- `<project>/.memory/` with `INDEX.md`, `<topic>.md`, `.runs/<runId>.json`.
- **Atomic writes**: temp file + `rename` over target so the master never reads a half-written
  file. (Consolidator edits files directly in the subprocess; same atomic helper there.)
- Filesystem **is** the recall interface — master uses normal `ls`/`read`/`grep`; no `recall`
  tool. Files are **not** rolled back by `/tree` (design: long-term tracks the repo).

### B2. Consolidator trigger (`hooks/consolidator-trigger.ts`)
- Clock: folded **active** observation pool tokens `>= consolidateAtPoolTokens` (200% of
  `poolTargetTokens`).
- **Strictly one consolidator at a time** (`consolidatorInFlight` flag — design risk 4).
- Promote **oldest-first**: select the overflow above `poolTargetTokens` (the oldest
  observations), serialize them + the current `.memory/` INDEX into the consolidator prompt.
- Spawn consolidator subprocess (`OM_WORKER=consolidator`); it edits `.memory/*.md` directly.
  It produces **no result file** — the file edits are the output, and the run ends by natural
  exit of `pi -p`.
- On clean exit (code 0): **tombstone the whole handed batch**, intersected with what is still
  active: `pi.appendEntry("om.observations.dropped", { observationTimestamps, coversUpToId })`.
  - **Critical (design risk 4):** the tombstone set = `handedBatch ∩ stillActive`. The handed
    batch is the enforcement mechanism — an observation an observer committed *during* the run
    is not in it, so it can never be tombstoned. The consolidator does **not** report back: it
    must consolidate everything it was given (filing or discarding noise are both valid), so we
    trust it on clean exit. This guarantees the buffer always drains (a report-subset model
    would strand un-filed/junk observations in the buffer forever, breaking the bounded-buffer
    invariant). A flaked-out partial run is recoverable from the worker's global session
    recording and is the critic tier's job to catch (decision 2).

### B3. Consolidator agent (`agent/consolidator/`) (L4)
- `before_agent_start`: replace system prompt with the topic-routing prompt.
- `--no-builtin-tools` ⇒ the extension must **register its own** `read`/`write`/`edit`/`ls`/`grep`
  **scoped to `.memory/`** (design risk 6). No terminal tool: the file edits are the output and
  the headless run ends by natural exit once the model emits its closing confirmation.
- Prompt: create/split/merge topic files; write clean current-state prose; remove superseded
  facts (no tombstone cruft); maintain front-matter (`id, title, summary, updated`). Routing
  aggressiveness is a tunable prompt knob (start conservative: prefer fewer, larger topics).
- Works from **observation text only** in v1 (decision 8 — no drill-to-source).

### B4. Injection map (`src/memory/index-render.ts`, extend `ledger/render.ts`)
- Compaction block section 1 = **memory map**: deterministically render `INDEX` from each
  topic file's front-matter (`path · summary · updated`) + a thin orientation header.
- Regenerated **each compaction**, never edited incrementally (design: throwaway projection,
  cannot decay).
- INDEX.md on disk is (re)rendered by the orchestrator after each consolidation so live
  `ls`/`grep` truth leads the pushed map (design risk 3 — accepted).

### B5b. Project journey (`JOURNEY.md`) — running descriptive history [implemented]

A third long-term artifact alongside the topic files and INDEX: a single, whole-project,
free-form prose narrative of **how the project/work got to where it is**. Purpose is
**orientation only** — give a freshly-compacted agent the rough arc so it stays on track —
not detailed recall (the topic files hold detail).

- **File:** `.memory/JOURNEY.md`. Consolidator-authored plain markdown, **no front-matter**.
  A special file like INDEX.md: **excluded** from `listTopics`/the memory map, never a topic.
- **Tier rules:** same as topic files — file-backed, shared across sessions, does **not** roll
  back under `/tree`.
- **Pushed, not pull-only:** rendered **verbatim from disk** into the compaction block as a
  new first section (`## Journey`), before the memory map and observations. So post-compaction
  the agent sees `journey` (settled past) → `map` (current topics) → `observations` (recent) →
  verbatim tail. Model-free at compaction (stays a throwaway render of a durable file).
- **Writer & cadence:** the **consolidator**, once per consolidation run. The current journey
  text is injected into its `-p` prompt (like the INDEX); it rewrites the file with its scoped
  `write` tool. It narrates the arc of the **promoted (aging-out) batch**, so the journey
  trails the live buffer by ~`poolTargetTokens` — a clean, non-overlapping chronology.
- **Append-mostly + compress-tail (the buffer insight, one tier up):** each run appends one
  short dated segment and leaves recent segments intact; only when the file exceeds
  `journeyTargetTokens` does it **compress the oldest segments** into a tighter lead summary.
  Recent history stays detailed; the distant past decays gracefully. Bounds the pushed section.
- **Anti-steering (load-bearing prompt constraint):** strictly past-tense descriptive. **No**
  recommendations, next steps, TODOs, plans, advice, predictions, or evaluative judgement —
  enforced entirely in the consolidator system prompt. The block header also tells the reader
  it is orientation, not instruction.

> **Deliberate exception to Core Stance 5.** The journey is the *one* intentionally
> **cumulative** artifact — no actor ever sees the whole history, so the consolidator can only
> maintain it incrementally (the `MEMORY.md` decay mode the rest of the design avoids). Accepted
> because it is **low-stakes orientation, not recall**: decay is confined to the compressed
> distant-past tail, recent history stays faithful, and the durable truth still lives in the
> worker session recordings + topic files. If this ever needs to be lossless, the critic tier /
> git-versioned `.memory` are the future guards (already on the post-v1 list).

### B5. Phase B acceptance
- Buffer stays bounded near `poolTargetTokens`; consolidation drains overflow into topic files.
- Topic files are clean current-state prose; rewrites are atomic; master can `grep` them.
- Cross-session: a second session in the same project reads the same `.memory/` files.
- `/tree` past a consolidation re-activates promoted observations in the buffer while files do
  **not** roll back (design risk 1 — accepted; consolidator dedupes on next rewrite).

---

## Config (`src/config.ts`)

Namespace `observational-memory` under `~/.pi/agent/settings.json` and project
`.pi/settings.json` (project overrides global). Defaults:

```jsonc
{
  "chunkTokens": 5000,
  "chunkOverlapTokens": 0,
  "poolTargetTokens": 10000,            // Phase B
  "consolidateAtPoolTokens": 20000,     // Phase B (200% of target)
  "compactAtContextTokens": 100000,     // tune per model
  "tailTokens": 20000,                  // verbatim tail; snaps to chunk boundary
  "journeyTargetTokens": 1000,          // Phase B — pushed JOURNEY.md size; compress old tail past this
  "observerConcurrency": 4,
  "models": {
    "observer":     { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "low" },
    "consolidator": { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "medium" }
  },
  "passive": false,
  "debugLog": false
}
```

`PI_OM_PASSIVE` env may force `passive` (disables all triggers) for clean `/tree` testing.

---

## Cross-cutting correctness (design risks → handling)

| Risk | Handling in v1 |
|---|---|
| R1 cross-tier double-rep on `/tree` | Accepted. Consolidator in-place dedupe keeps files sane; documented. |
| R2 just-promoted blind spot | INDEX summary quality is load-bearing; conservative routing + good front-matter. |
| R3 INDEX staleness | Master reads live FS; orchestrator re-renders INDEX.md post-consolidation. |
| R4 observer/consolidator concurrency | One consolidator at a time; tombstone the handed batch ∩ still-active (no report-back) — a during-run observation isn't in the batch, so never tombstoned. Enforced in `consolidator-trigger.ts`. |
| R5 compaction stalls on slow worker | Wait only for in-flight **observers** (not consolidators). **Fast path:** skip the wait entirely when no in-flight observer can affect the block (`canSkipObserverWait`) — each in-flight observer's chunk ends after the cutoff (excluded from the projection) **and** the snapped tail is already ≤ `tailTokens` (snap is provably stable). In the steady state observers cover only tail chunks, so compaction is instant; it only blocks for a genuinely pre-cutoff slow observer (out-of-order completion). |
| R6 `--no-builtin-tools` + consolidator | Consolidator extension registers its own `.memory/`-scoped read/write/edit. |
| R7 timestamp-id reliability | Resolved by L5: orchestrator assigns ids; observer emits minute-resolution only. |

---

## Open tuning items (defaults set; revisit during use)

- `compactAtContextTokens`, `tailTokens` — tune per target model (defaults above).
- `chunkOverlapTokens` — default 0; raise if boundary-spanning events are lost.
- Consolidator topic-routing aggressiveness — start conservative (fewer, larger topics).
- Observer/consolidator model split — currently strong everywhere (L6); try cheap/fast
  observers once quality is validated.

---

## Build sequence (checklist)

**Phase A**
1. Scaffold package + tsconfig + vitest.
2. Vendor & trim ledger/tokens/ids/serialize/debug-log; port + prune tests.
3. Orchestrator skeleton + config + runtime + TUI status controller (footer).
3a. Per-session on/off gate (default OFF): `om.enabled` state, `/om` `/om on` `/om off`,
    outermost `if (!enabled) return;` guard in every handler.
4. `spawn/launch.ts` + `spawn/runs.ts` (IPC) + smoke test.
5. Worker agent extension (observer mode) + `record_observations` terminal tool.
6. Observer trigger (parallel, fixed-boundary chunks) + commit-to-ledger + widgets/toasts.
7. Compaction trigger + hook (cutoff-on-boundary render) .
8. `/om:status`, `/om:compact`.
9. Acceptance: long session, parallel observers, compaction, `/tree` rollback.

**Phase B** — implemented
10. ✅ `.memory/` paths + atomic write + INDEX render (`src/memory/{paths,index-render}.ts`).
11. ✅ Consolidator agent: scoped `read/write/edit/ls/grep`, no terminal tool (natural exit)
    (`agent/consolidator/{prompt,tools}.ts`).
12. ✅ Consolidator trigger: pool clock, one-at-a-time, oldest-first, tombstone the
    provided∩still-active batch on clean exit (no report-back); drop `coversUpToId` = tip's
    last source entry (`src/hooks/consolidator-trigger.ts`).
13. ✅ Memory-map section in the injection block (live from disk at compaction) +
    post-consolidation INDEX.md re-render. `/om:consolidate` + extended `/om:status`.
14. Acceptance (manual): bounded buffer, clean topic files, cross-session read, `/tree` semantics.

Resolved Phase-B decisions: the consolidator must consolidate everything it is handed
(filing or discarding noise are both valid), so it does **not** report back — the orchestrator
tombstones the whole handed batch (∩ still-active) on clean exit. Race-safety comes from the
handed batch, not a report: a during-run observation is not in it, so it is never tombstoned.
This also guarantees the buffer drains (a report-subset model would strand un-filed/junk
observations forever). The orchestrator owns INDEX.md (consolidator never writes it);
consolidator authors full
front-matter using an injected current-time; runs in the background concurrent with observers
(compaction never waits for it).

---

## Explicitly out of v1 (per design)

Critic/verification tier · git-versioned `.memory` · conscious "jot" write path / scratchpad
· drill-to-source consolidation · `.memory/.runs` GC · per-position `/tree` correctness for
long-term memory · multi-agent `.memory` sharing/merge.

---

## Addendum — per-session memory scoping (post-v1)

Long-term memory is now scoped per session: everything that used to live flat under
`<project>/.memory/` (`INDEX.md`, `<topic>.md`, `JOURNEY.md`, and `.runs/`) now lives under
`<project>/.memory/<sessionId>/`. The key is the **immutable session-header id**
(`sessionManager.getSessionId()`), which survives `/name`, `/resume`, and `/tree` — never the
session filename UUID (can diverge) or display name (mutated by `/name`).

- **Why:** two sessions in the same directory were sharing (and clobbering) one consolidator
  output. Scoping by session id isolates them.
- **Fork/clone seeding:** the short-term ledger already travels with a fork, so the long-term
  tier is seeded to match. `ensureSessionMemory` (src/memory/session.ts) copies the parent's
  memory root in **once, on first touch** (parent discovered via the durable `parentSession`
  header lineage), excluding transient `.runs/`. Idempotent: an existing root is never
  re-seeded, so `/resume` and `/tree` never disturb it. No parent ⇒ lazy create on first write.
- **Mechanics:** `sessionMemoryRoot(cwd, sessionId)` is the chokepoint; all path helpers
  (`indexPath`/`journeyPath`/`readJourney`/`listTopics`/`resolveWithinMemory`, `run*Path`) take
  the resolved **root**. The orchestrator stores it on `runtime.memoryRoot` (set whenever the
  gate is enabled) and passes the worker its session dir via `OM_MEMORY_DIR`. The worker /
  agent side is unchanged — it only ever receives explicit paths.
- **Memory-map paths** advertised to the master are rendered relative to the project cwd
  (`.memory/<sessionId>/<topic>.md`) so its `read`/`grep` resolve to the right session dir.
- **Not migrated:** pre-existing flat `.memory/*` content is left in place and ignored (clean
  break). `/tree` correctness for the long-term tier is still out of scope (now per-session).
