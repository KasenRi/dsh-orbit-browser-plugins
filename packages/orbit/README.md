# @kasenri/dsh-orbit

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

> **让 AI 不只是“连续回答”，而是按照一个可恢复、可审核、有边界的工程流程把任务真正做完。**

Orbit 是一个面向 DeepSeek Harness 的**确定性长任务编排器**。它把“规划、执行、审核、纠错、恢复、最终验收”拆成明确角色，并把真正的流程控制权留在 Supervisor，而不是交给模型自由循环。

从 v0.6.x 开始，Orbit 还可以选择性接入 **MoA 多候选执行**：当某个关键步骤存在多种合理实现路线时，Orbit 可以让多个 Candidate 独立给出方案，再由 Judge 做相对选优，最后仍由 Orbit 写回、真实验证并由 Commander 最终验收。

从 v0.6.2 开始，Commander 与 Executor 在同一个 Run 内默认使用 **Persistent Role Sessions**：PLAN、Step Review、Final Review 会继续同一个 Commander Session；权限集合不变的连续 Step 会继续同一个 Executor Session。这样角色无需在每次交接时重新理解项目。只有权限变化、Watchdog 要求重启、Commander 显式请求 `RESET`、恢复失败或异常时，Supervisor 才会确定性轮换角色 Session。Watchdog、MoA Candidate 和 Judge 仍保持一次性隔离调用。

从 v0.6.3 开始，Orbit 增加 **Trusted Execution Evidence**：Supervisor 会从已结算的 DSH `tool/call` + `tool/result` 中确定性提取真实工具结果摘要、exit code 和测试证据，并能识别 `run_code` 内字面 `tools.bash({ command: ... })` 的嵌套 shell 命令。Commander 会明确区分 `[TRUSTED_TOOL_EVENTS]` 和 `[EXECUTOR_SUMMARY_UNVERIFIED]`，避免已经有真实 stdout / exit code / test summary 时仍重复申请 shell 或要求 Executor 把证据写入临时文件。

## 核心能力

- **Commander**：负责计划、步骤审核、最终审核和策略调整；一个 Run 内默认持续使用同一个 Commander Session。
- **Executor**：一次只执行当前 Step，并负责真实工具调用与验证；权限集合不变时跨 Step 复用同一个 Executor Session。
- **Smart Watchdog**：只在运行异常时介入诊断和恢复。
- **Durable State**：运行状态持久化到 `<project>/.cx/state.json`，支持冷恢复。
- **Bounded Loop**：Plan、Correction、Watchdog 和 Append 都有明确上限。
- **Route Freeze**：Run 创建后冻结角色模型与 Reasoning，中途改 UI 只影响下一次 Run。
- **Persistent Role Sessions**：Commander / Executor 会话身份、轮次、轮换次数和 Token 使用写入 durable state；正常交接不重新创建角色。
- **Mutation Fence**：一个 workspace 同一时间只允许合法的 Orbit 修改驱动者。
- **可选 MoA**：高不确定 Step 可以走 2–4 候选 + Judge 的多方案竞争。
- **可选 Browser**：需要真实网页操作时再配合 `@kasenri/dsh-browser`。

核心状态机：

```text
PLAN → EXECUTE → EVALUATE → CORRECT / RECOVER → SUCCESS
```

普通 SINGLE Step：

```text
Commander
   ↓
Executor
   ↓
真实测试 / Evidence
   ↓
Commander
   ↓
PASS / CORRECT / NEEDS_USER
```

MoA Step：

```text
Commander
   ↓
Candidate 1 ─┐
Candidate 2 ─┼→ Judge → Winner
Candidate 3 ─┘              ↓
                    Orbit 受控写回
                           ↓
                        Executor
                           ↓
                        真验证
                           ↓
                       Commander
```

## MoA 是可选能力，不随 Orbit 自动安装

**只安装 Orbit，就可以正常使用完整的 SINGLE 模式。**

如果你希望在 Orbit 中开启：

```text
MoA 多候选模式
```

需要自行另外安装 `@goodandready/dsh-moa`：

```bash
dsh plugin --profile web add @kasenri/dsh-orbit
dsh plugin --profile web add @goodandready/dsh-moa
```

Orbit 当前接受：

```text
@goodandready/dsh-moa >= 0.2.19
```

已在真实 DSH 环境验证：

```text
0.2.19  ✓
0.2.20  ✓
```

更高版本不会被 Orbit 主动设置上限。如果上游未来发生真实 API 不兼容，再按实际故障修复。

安装 MoA 后，在 Orbit 菜单中打开：

```text
MoA 多候选模式      [开关]  >
```

进入二级菜单配置候选数量、Candidate 模型、Judge、Reasoning、候选互评和每个 Run 最大 MoA Step 数。

**开启 MoA 不代表每个 Step 都会运行多个模型。** Commander 仍然可以让普通步骤走 SINGLE，只在适合的高不确定步骤选择 MOA。

## Orbit 与 MoA 的职责边界

Orbit 集成 MoA 后，顶层控制权不会改变：

- Orbit Supervisor 仍然是唯一流程控制者。
- Candidate / Judge 都是零工具模型调用，不能直接修改项目。
- 候选方案只写入 `.cx/moa/<run>/<step>/candidate-N/`。
- Judge 只能从已有成功候选中选择 Winner，不能自己生成新的“第四方案”。
- Judge 只做相对选优，不能决定 `PASS_CURRENT_STEP`。
- Winner 由 Orbit Supervisor 受控 Promotion 到项目目录。
- Promotion 后仍然必须让 Executor 做真实测试。
- 最终仍由 Commander 决定 PASS / CORRECT / NEEDS_USER。
- Orbit ACTIVE 时会阻止独立 `/moa` 抢占同一 workspace。

因此可以把两者理解成：

> **Orbit 决定任务怎么走；MoA 只负责在困难步骤里多想几个答案再选一个。**

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@goodandready/dsh-moa`（可选） | `>=0.2.19`；已验证 0.2.19、0.2.20 |
| Node.js | `>= 22.19.0` |

Requires the DSH base services: `agents`, `subagents`, `tools`, `sessions`
(the standard/web profile provides them).

## Install

只使用 Orbit：

```bash
dsh plugin --profile web add @kasenri/dsh-orbit
```

启用 Orbit + MoA：

```bash
dsh plugin --profile web add @kasenri/dsh-orbit
dsh plugin --profile web add @goodandready/dsh-moa
```

Git 发行镜像：

```bash
dsh plugin --profile web add github:KasenRi/dsh-orbit
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
After a hard-activated run reaches `SUCCESS`, the initiating Session displays
the Final Commander's user-visible result directly, with the Commander's frozen
provider/model provenance. The parent model and parent tools remain bypassed.

## Model configuration (Web)

The Orbit model control is the final entry in `conversation.input.right`, so
other composer-side controls (for example DSH's rollback control) stay to its
left while the native `conversation.input.model` seat stays immediately to its
right. Its button names the Commander's model. The first-level menu stays compact:
Orbit toggle, Commander, Executor, Watchdog, and one `MoA 多候选模式` entry. All
Candidate/Judge details live in the MoA second-level menu.

- **Commander** and **Watchdog** pick from the same native model catalog and
  persist into the DSH `orbit` settings namespace (`settings.yaml`). Picking a
  model first opens reasoning selection; nothing is saved until the user chooses
  a catalog-declared effort or provider default. No effort is inferred.
- **Executor** follows the current session model ("Follows current session
  model"). Both the Orbit row and the native seat read and write the SAME
  per-session `ModelDirectory`, so a change in either place updates the other.
- **MoA Candidate / Judge** routes appear only inside the MoA second-level menu.
  Candidate count and max-MoA-step values use explicit selectors instead of
  click-to-cycle controls.

A new run resolves its routes exactly once — Commander/Watchdog from `orbit`
settings, Executor from the initiating session's current selection — and freezes
them into `state.routes`. Orbit ships no provider/model or reasoning defaults.
Changes made while a run is active apply to the next run; resumed runs keep
their frozen routes. Explicit profile routes are permitted for headless/CLI:
Commander/Watchdog use settings then explicit config; Executor uses the Session
selection, with explicit config only when there is no Session. Missing or
unavailable roles block creation of a Run before any child starts.

### Optional MoA execution mode

> 需要额外安装 `@goodandready/dsh-moa`。只安装 Orbit 时，SINGLE 模式仍然完整可用。

Orbit 可以把少量高不确定性步骤标记为 `execution_mode: "MOA"`。这不是新的顶层 Supervisor，也不会把状态机交给 MoA：

```text
Commander PLAN
      ↓
SINGLE ─────────────→ Executor
      \
       MOA → Candidate 1 ─┐
             Candidate 2 ─┼→ Judge → Orbit controlled promotion → Executor verification
             Candidate 3 ─┘
                                              ↓
                                      Commander STEP_EVALUATE
```

关键边界：

- Candidate 和 Judge 都是**零工具**的一次性模型调用，不能直接 `write/edit/bash/subagent`。
- 候选文件只写入 `.cx/moa/<run>/<step>/candidate-N/`，普通 Executor 不能修改 `.cx`。
- Judge 只负责在已有候选中做相对选择，必须返回 `WINNER_CANDIDATE_INDEX`；它不能决定 `PASS_CURRENT_STEP`，也不能生成新的综合实现。
- 胜出候选由 Orbit Supervisor 确定性提升到项目目录；之后仍由 Executor 运行真实测试，最后由 Commander 做绝对验收。
- 整个 MoA Step 只消耗一个 Orbit loop；候选和 Judge 的内部调用受独立的候选数和 `maxMoaSteps` 限制。
- 候选数固定为 2–4；至少需要 2 个成功候选。失败不会偷偷回退成单 Executor，也不会自动换 Judge 模型。
- `peerCritique` 默认关闭；开启时只允许一轮有界互评。
- 新 Run 会冻结 Candidate/Judge 的 provider、model、reasoningEffort、MoA policy，以及原版 MoA settings 中用户显式配置的价格表（如果存在）。中途修改 UI 只影响下一次 Run。
- Candidate/Judge 的 input/output/cache Token 来自 DSH 子 Session 的真实 `assistant/message.usage`；如果冻结的价格表能匹配对应 Route，同时记录美元成本；没有价格时只展示 Token，并明确标记无法计算成本，不猜价格。
- Orbit 会把一个不含目标正文、候选正文、Judge 推理或代码的有界运行快照写进所属 DSH Session projection。v0.6.1 的配置首页不再直接展开这些运行详情，而是保持紧凑；运行快照仍保留给会话恢复与后续运行态界面使用。
- 冷恢复按 durable phase 继续：`JUDGE` 不重跑 Candidate，`SELECTED` 不重跑 Candidate/Judge，`PROMOTED` 不重跑 Candidate/Judge/Promotion。
- Orbit ACTIVE 时会在下游 hook 之前阻止独立 `/moa`，避免原版 MoA 的自动 Promotion 与 Orbit 同时争夺 workspace。
- `@goodandready/dsh-moa` 是可选依赖；未安装时普通 SINGLE 模式完全不受影响。

当前兼容层接受 `@goodandready/dsh-moa >=0.2.19`，并已在 0.2.19 与 0.2.20 上完成真实 DSH 烟雾验证。更高版本不再被 Orbit 主动版本上限拦截；若上游未来发生实际 API 不兼容，再按真实故障修正。Orbit 只依赖它公开的项目上下文接口；候选调度、Judge、持久化与 Promotion 权限均由 `moa-adapter.ts` 封装。

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
- Runs without an explicit user/tool budget start from the historical floor of
  5 loops; after PLAN, Orbit deterministically reserves two extra bounded slots
  beyond the accepted base plan (`max(5, steps + 2)`, therefore at most 7 for
  the 1–5-step plan schema). Explicit `approved_loop_count` / `max_loops`
  values are never enlarged automatically.
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
| `moa.enabled` | `false` | 允许 Commander 为关键步骤选择 `MOA` 执行模式。 |
| `moa.candidateCount` | `3` | 固定候选数量，运行时只允许 2–4。 |
| `moa.candidates` | none | 用户显式选择的 Candidate routes；不会从 Executor 猜测或继承。 |
| `moa.judge` | none | 用户显式选择的 Judge route。 |
| `moa.peerCritique` | `false` | 是否启用一轮有界候选互评。 |
| `moa.maxMoaSteps` | `2` | 一个 Run 最多允许的 MoA 步骤数（上限受 1–5 步 Plan 约束）。 |
| MoA prices | none | 若 `dsh-moa` settings 已配置 `prices`，Orbit 在新 Run 冻结该表并据真实 Token 计算成本；否则不估价。 |
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

- `.cx/state.json` 路径保持不变；v0.6.2 写入 schema 4（新增 `role_sessions`），旧 schema 2/3 状态可继续读取，并在下一次正常持久化时升级。
- Legacy `cx模式` remains supported.
- Existing durable runs do not need migration: Orbit reads the same
  `.cx/state.json`, including historical `CX_*` error strings.
- `.cx` is retained as the durable execution state path for backward
  compatibility with existing CX projects.

## License

MIT
