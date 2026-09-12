# @kasenri/dsh-cx

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

Deterministic engineering orchestration for DSH, implemented as a Cordis plugin:

- a `CxService` on `ctx.cx`
- a model-facing `cx_controller` tool
- recoverable tool guards

```text
Goal
 │
 ▼
CxService
 └─ Deterministic Supervisor
     ├─ Commander   (plan / step & final evaluation / strategy reconsider)
     ├─ Executor    (one engineering step at a time)
     └─ Smart Watchdog (runtime diagnosis and recovery)
```

Every child role runs on DSH's native `ctx.subagents` service; durable state
lives in `<project>/.cx/state.json`.

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| Node.js | `>= 22.19.0` |

Requires the DSH base services: `agents`, `subagents`, `tools`, `sessions`
(the standard/web profile provides them).

## Install

```bash
dsh plugin --profile web add @kasenri/dsh-cx@0.1.0
```

The package declares a `dsh.bundle` patch, so `dsh plugin add` registers it as a
profile layer automatically.

## Usage

The `cx_controller` tool drives the run:

| Action | Meaning |
|---|---|
| `run` / `start` | Start a run for a goal (or continue the current one). |
| `resume` | Continue the persisted run after an interruption. |
| `status` | Inspect phase, plan, loop budget and last error. |
| `stop` | Close the run. |
| `doctor` | Read-only environment and configuration checks. |

```jsonc
// cx_controller
{
  "action": "run",
  "goal": "…",
  "approved_loop_count": 4,
  "user_hard_constraints": ["only touch src/"]
}
```

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
- Executors receive the configured writer allowlist; browser tools are added
  only for steps that declare the `browser` capability.
- While CX owns a workspace, other top-level autonomous drivers
  (`create_goal`, `ralph`, `workflow`) are refused, and CX refuses to start
  while an active goal driver owns the same workspace.
- `.cx` durable state is written only by the CX service (atomic write, short
  lock transaction, monotonic revision).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `projectDir` | session cwd | Project the run operates on. |
| `routes.commander` | `deepseek-official` / `deepseek-v4-pro` / `high` | Commander model route. |
| `routes.executor` | `deepseek-official` / `deepseek-v4-flash` / `high` | Executor model route. |
| `routes.watchdog` | `deepseek-official` / `deepseek-v4-flash` / `low` | Watchdog model route. |
| `executorTools` | read/glob/grep/bash/edit/write/… | Executor allowlist. |
| `browserTools` | `["agent_browser"]` | Browser capability tool names. |
| `commanderReadOnlyTools` | read/glob/grep/web… | Commander allowlist. |
| `watchdogTools` | read/glob/grep | Watchdog allowlist. |
| `executorTimeoutMs` | `480000` | Deterministic executor runtime timeout. |
| `registerTool` | `true` | Register the `cx_controller` tool. |
| `registerGuards` | `true` | Register recoverable tool guards. |

Routes are normal DSH model routes; configure them for your own provider and
model identifiers. No credentials are included in this package.

## Optional browser capability

CX does not depend on `@kasenri/dsh-browser`. A plan step that declares
`capabilities: ["browser"]` needs the `agent_browser` tool to be registered by
the browser plugin; otherwise CX reports `BROWSER_CAPABILITY_UNAVAILABLE` and
lets the Commander decide what to do. Install both packages to use that path:

```bash
dsh plugin --profile web add @kasenri/dsh-browser@0.1.0
dsh plugin --profile web add @kasenri/dsh-cx@0.1.0
```

## License

MIT
