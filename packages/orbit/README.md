# @kasenri/dsh-orbit

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

**Orbit — Deterministic Engineering Orchestration for DeepSeek Harness**

Orbit is a deterministic engineering orchestration runtime for DSH, implemented
as a Cordis plugin:

- an `OrbitService` on `ctx.orbit`
- a model-facing `orbit_controller` tool (`cx_controller` remains a legacy alias)
- recoverable tool guards

```text
Goal
 │
 ▼
OrbitService
 └─ Deterministic Supervisor
     ├─ Commander   (plan / step & final evaluation / strategy reconsider)
     ├─ Executor    (one engineering step at a time)
     └─ Smart Watchdog (runtime diagnosis and recovery)
```

Every child role runs on DSH's native `ctx.subagents` service; durable state
lives in `<project>/.cx/state.json`.

Orbit is a *bounded, self-converging engineering execution track*:

```text
PLAN → EXECUTE → EVALUATE → CORRECT / RECOVER → SUCCESS
```

It is not a timer loop, an infinite auto-continue, a pure reviewer, a pure
planner, or an agent swarm. It is a deterministic supervisor plus Commander,
Executor, Smart Watchdog, durable state and bounded recovery.

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| Node.js | `>= 22.19.0` |

Requires the DSH base services: `agents`, `subagents`, `tools`, `sessions`
(the standard/web profile provides them).

## Install

The package is published to the npm Registry; the dedicated Git distribution
mirror remains available when a Git source is preferred:

```bash
dsh plugin --profile web add @kasenri/dsh-orbit
# Git source alternative, tracks the mirror repository HEAD:
# dsh plugin --profile web add github:KasenRi/dsh-orbit
```

The package declares a `dsh.bundle` patch, so `dsh plugin add` registers it as a
profile layer automatically.

The canonical source is maintained in the
[source monorepo](https://github.com/KasenRi/dsh-orbit-browser-plugins/tree/main/packages/orbit).
The source monorepo's versioned Release tarballs remain available for manual or
offline fallback, but the Market uses this dedicated Git repository so updates
can compare the locked commit with `HEAD`.

## Usage

The `orbit_controller` tool drives the run:

| Action | Meaning |
|---|---|
| `run` / `start` | Start a run for a goal (or continue the current one). |
| `resume` | Continue the persisted run after an interruption. |
| `status` | Inspect phase, plan, loop budget and last error. |
| `stop` | Close the run. |
| `doctor` | Read-only environment and configuration checks. |

```jsonc
// orbit_controller
{
  "action": "run",
  "goal": "…",
  "approved_loop_count": 4,
  "user_hard_constraints": ["only touch src/"]
}
```

## Activation

Orbit supports three activation styles:

1. `/agent-orbit <goal>` — deterministic slash-command activation. In the Web
   GUI it appears in the `/` menu (`使用 Orbit 确定性工程编排执行目标`); on headless/CLI surfaces a genuine user message
   that starts with `/agent-orbit` activates Orbit directly. The original
   command line stays visible in the conversation, the goal is passed through
   without rewriting, and no goal asks for one instead of starting an empty run.
  2. `orbit模式` — recommended natural-language activation, e.g.
   “用 orbit模式完成这个项目”.
  3. `cx模式` — legacy compatibility; still resolves to Orbit.

All three routes converge on the existing `orbit_controller` tool and
`OrbitService`; the activation layer never starts a run of its own.

## Model configuration (Web)

The Orbit model control sits immediately left of the native composer model
seat (`conversation.input.right` renders before `conversation.input.model`).
Its button names the Commander's model; the menu edits three roles:

- **Commander** and **Watchdog** pick from the same native model catalog and
  persist into the DSH `orbit` settings namespace (`settings.yaml`). Picking a
  model first opens reasoning selection; nothing is saved until the user chooses
  a catalog-declared effort or provider default. No effort is inferred.
- **Executor** follows the current session model ("Follows current session
  model"). Both the Orbit row and the native seat read and write the SAME
  per-session `ModelDirectory`, so a change in either place updates the other.

A new run resolves its routes exactly once — Commander/Watchdog from `orbit`
settings, Executor from the initiating session's current selection — and freezes
them into `state.routes`. Orbit ships no provider/model or reasoning defaults.
Changes made while a run is active apply to the next run; resumed runs keep
their frozen routes. Explicit profile routes are permitted for headless/CLI:
Commander/Watchdog use settings then explicit config; Executor uses the Session
selection, with explicit config only when there is no Session. Missing or
unavailable roles block creation of a Run before any child starts.

## State machine

```text
PLAN → EXECUTE → EVALUATE → SUCCESS
                     │
                     ├─ correction (bounded per step)
                     ├─ append (bounded by remaining loop budget)
                     ├─ NEEDS_USER
                     └─ BUDGET_EXHAUSTED
```

- Only a normally completed Executor step consumes one loop from the budget.
- Corrections are limited per base step and reserve budget for the remaining
  planned steps.
- Commander decisions are validated in code (`PASS_CURRENT_STEP` /
  `CORRECT_CURRENT_STEP` / `NEEDS_USER` for step evaluation, `SUCCESS` /
  `APPEND` / `NEEDS_USER` for final evaluation, `KEEP_APPROACH` /
  `REPLACE_CURRENT_STEP` / `NEEDS_USER` for strategy reconsider).
- Commander runs under an adaptive timeout: a soft review at 360s, a second
  review at 600s and a deterministic hard ceiling at 840s; an extension always
  keeps the same child.
- The Smart Watchdog is only invoked on runtime anomalies, performs at most two
  diagnoses per step, and can resume the same child or restart the step with a
  fresh one after interrupting the old child.
- Blocked tools are recoverable: a guard denial stops that single call, not the
  turn or the run.

## Safety boundaries

- Commander and Watchdog receive read-only tool allowlists.
- Executors always receive only base read tools (`read/read_image/glob/grep`).
  Each Step explicitly declares `filesystem`, `shell`, `web`, or `browser` to
  add only the corresponding tools. Legacy `web-api-recon` normalizes to `web`
  plus `browser`. No capability means no bash, writers, web, or browser tools.
- While Orbit owns a workspace, other top-level autonomous drivers
  (`create_goal`, `ralph`, `workflow`) are refused, and Orbit refuses to start
  while an active Goal driver owns the same workspace. Only an Orbit-owned
  Executor child can use mutation tools while Orbit owns that workspace.
- Bounded, redacted `step_results` preserve each Step's summary, changes and
  test evidence. Cold resume retains them and FINAL_EVALUATE sees every Step.
- `.cx` durable state is written only by the Orbit service (atomic write, short
  lock transaction, monotonic revision).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `projectDir` | session cwd | Project the run operates on. |
| `routes.commander` | none | Explicit profile fallback; normally user-selected in Orbit settings. |
| `routes.executor` | none | Explicit config only without a Session; otherwise follows DSH Session selection. |
| `routes.watchdog` | none | Explicit profile fallback; normally user-selected in Orbit settings. |
| `executorTools` | read/read_image/glob/grep | Base read-only subset; mutation tools require Step capabilities. |
| `browserTools` | `["agent_browser"]` | Browser capability tool names. |
| `commanderReadOnlyTools` | read/glob/grep/web… | Commander allowlist. |
| `watchdogTools` | read/glob/grep | Watchdog allowlist. |
| `executorTimeoutMs` | `480000` | Deterministic executor runtime timeout. |
| `registerTool` | `true` | Register the `orbit_controller` tool and the legacy `cx_controller` alias. |
| `registerGuards` | `true` | Register recoverable tool guards. |
| `slashCommand` | `true` | Register the `/agent-orbit` host command and the gesture boundary. |

Routes are normal DSH model routes; configure them for your own provider and
model identifiers. No credentials are included in this package.

## Optional browser capability

Orbit does not depend on `@kasenri/dsh-browser`. A plan step that declares
`capabilities: ["browser"]` needs the `agent_browser` tool to be registered by
the browser plugin; otherwise Orbit reports `BROWSER_CAPABILITY_UNAVAILABLE` and
lets the Commander decide what to do. Install both packages to use that path:

```bash
dsh plugin --profile web add github:KasenRi/dsh-browser
dsh plugin --profile web add github:KasenRi/dsh-orbit
```

## Migrating from dsh-cx

| CX | Orbit |
|---|---|
| `dsh-cx` | `dsh-orbit` |
| `@kasenri/dsh-cx` | `@kasenri/dsh-orbit` |
| `cx_controller` | `orbit_controller` |
| CX mode | Orbit mode (`orbit模式`; `cx模式` still works) |
| `ctx.cx` | `ctx.orbit` (same `OrbitService` instance; `ctx.cx` remains an alias) |

- `.cx/state.json` remains unchanged.
- Legacy `cx模式` remains supported.
- Existing durable runs do not need migration: Orbit reads the same
  `.cx/state.json`, including historical `CX_*` error strings.
- `.cx` is retained as the durable execution state path for backward
  compatibility with existing CX projects.

## License

MIT
