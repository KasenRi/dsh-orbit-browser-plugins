# DSH Orbit + Browser Plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

> **让 AI 不只是回答问题，而是能持续执行、比较方案、验证结果，直到把任务真正做完。**

这个仓库包含两个独立插件：

- **`@kasenri/dsh-orbit`**：确定性的长任务编排与审核系统。
- **`@kasenri/dsh-browser`**：受控浏览器自动化能力。

Orbit 可以独立使用；Browser 和 MoA 都是按需增强能力，不安装也不会影响 Orbit 的基础 SINGLE 执行模式。

## Orbit 是什么

Orbit 的目标不是做一个“无限自动继续”的 Loop，而是给 DSH 增加一个**有状态、有边界、可恢复、会自我审核的工程执行轨道**。

你只需要给出最终目标，Orbit 会：

- 让 **Commander（指挥官）**规划 1–5 个明确步骤；
- 让 **Executor（执行员）**一次只执行当前步骤；
- 每个步骤完成后重新交给 Commander 审核；
- 发现问题时进入有界修正，而不是直接宣告成功；
- 发生超时、卡死或中断时，让 **Smart Watchdog（监控模型）**参与恢复；
- 将运行状态持久化到项目的 `.cx/state.json`，支持中断后继续；
- 在最终成功前再次执行 Final Evaluation，而不是只相信 Executor 的自述。

核心流程：

```text
用户目标
   ↓
Commander 规划
   ↓
当前 Step
   ↓
SINGLE / MOA
   ↓
真实执行与验证
   ↓
Commander 审核
   ↓
PASS / CORRECT / NEEDS_USER
   ↓
下一步
   ↓
Final Evaluation
   ↓
SUCCESS
```

## v0.6.2：Persistent Role Sessions

从 v0.6.2 开始，一个 Orbit Run 不再为每次 Commander / Executor 交接都创建全新的角色会话：

- PLAN、STEP_EVALUATE、STRATEGY_RECONSIDER、FINAL_EVALUATE 默认继续同一个 **Commander Session**；
- 连续 Step 的工具权限集合一致时，默认继续同一个 **Executor Session**；
- Executor 权限集合发生变化时会自动轮换，避免为了复用上下文而扩大权限；
- Commander 可以在结构化决策里请求 `executor_session: RESET`，但真正的关闭/创建仍由 Supervisor 执行；
- Watchdog、MoA Candidate、MoA Judge 继续保持一次性隔离调用；
- 角色 Session ID、generation、turns、resets 与 Token usage 会写入 `.cx/state.json` 的 `role_sessions`，用于恢复和诊断。

因此默认路径会从“每个阶段一个新 Agent”变成“一个 Run 主要只有一个 Commander + 一个 Executor”，减少重复项目探索和重复上下文建立，同时保留权限隔离和确定性轮换。

## v0.6.3：Trusted Execution Evidence

v0.6.3 补齐 Executor → Supervisor → Commander 的可信执行证据链：Orbit 会从已结算的 DSH `tool/call` + `tool/result` 中提取经过脱敏和限长的真实结果摘要、显式 exit code，以及可识别的测试命令。对于 `run_code` 中可确定识别的字面 `tools.bash({ command: ... })`，Orbit 会把嵌套 shell 命令与对应真实输出关联起来。Commander 会明确区分 `[TRUSTED_TOOL_EVENTS]` 与 `[EXECUTOR_SUMMARY_UNVERIFIED]`，因此已有真实 stdout / exit code / 测试汇总时，不再需要为了重复证明而申请 shell 或让 Executor 额外落盘临时 evidence 文件。

## v0.6.x：Orbit 接入 MoA 多候选执行

从 v0.6.0 开始，Orbit 可以把少量高不确定性步骤交给 **MoA 多候选模式**。

这不是让 MoA 接管 Orbit，也不是启动另一套顶层工作流。Orbit 仍然是唯一的 Supervisor；MoA 只负责在某个 Step 内：

1. 让 2–4 个 Candidate 独立提出方案；
2. 让 Judge 比较已有候选并选出一个 Winner；
3. 由 Orbit Supervisor 受控写回胜出候选；
4. 再交给普通 Executor 做真实测试和验证；
5. 最后仍由 Commander 判断当前 Step 是否真正通过。

```text
                         Orbit Supervisor
                                │
                   ┌────────────┴────────────┐
                   │                         │
                SINGLE                     MOA
                   │                         │
               Executor          ┌───────────┼───────────┐
                   │             ↓           ↓           ↓
                   │        Candidate 1 Candidate 2 Candidate 3
                   │             └───────────┼───────────┘
                   │                         ↓
                   │                       Judge
                   │                         ↓
                   │                    Winner
                   │                         ↓
                   │              Orbit 受控 Promotion
                   │                         ↓
                   └──────────────────── Executor
                                             ↓
                                          真验证
                                             ↓
                                         Commander
                                             ↓
                               PASS / CORRECT / NEEDS_USER
```

几个关键边界：

- Candidate 和 Judge 都是**零工具模型调用**，不能直接修改项目。
- 候选方案只写入 `.cx/moa/<run>/<step>/candidate-N/` 隔离区。
- Judge 只负责“哪个候选相对更好”，**不能决定 Step PASS**。
- Winner 写回后仍然必须经过 Executor 的真实测试和 Commander 的最终验收。
- 一个 MoA Step 只消耗一个 Orbit loop，但候选模型调用会额外产生 Token / 成本。
- MoA Route、候选数、Judge、Reasoning 等会在 Run 创建时冻结，中途修改 UI 只影响下一个 Run。
- Orbit ACTIVE 时会阻止独立 `/moa` 抢占同一个 workspace。

## 启用 MoA：需要自行安装 dsh-moa

**MoA 不是 Orbit 的内置依赖。**

只安装 Orbit 时，SINGLE 模式完全可用；如果希望在 Orbit 中启用“MoA 多候选模式”，必须另外安装：

```bash
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

更高版本不会被 Orbit 主动设置版本上限；如果未来 MoA 的公开 API 出现实际破坏性变化，再按真实故障修复。

安装完成后，在 Orbit 的模型菜单中：

```text
MoA 多候选模式      [开关]  >
```

进入二级菜单配置：

- 候选数量：2–4；
- Candidate 1–4 的模型与 Reasoning；
- Judge 评审模型与 Reasoning；
- 是否启用一轮候选互评；
- 每个 Run 最多允许多少个 MoA Step。

开启 MoA 只是**允许 Commander 为合适的步骤选择 MOA**，并不意味着每一步都会强制运行多个模型。

## Browser：需要网页操作时再安装

`@kasenri/dsh-browser` 给 DSH 增加真实浏览器操作能力。Orbit 不依赖 Browser；只有当某个 Step 声明 `browser` capability 时才需要它。

Browser 可以打开网页、点击、输入、读取页面、下载文件，并带有域名限制、状态保护和 stale-ref 检查等安全边界。

组合起来，一个工程任务可以同时拥有：

```text
Orbit
├─ 多步骤规划 / 审核 / 恢复
├─ SINGLE 执行
├─ 可选 MoA 多候选选优
└─ 可选 Browser 网页操作
```

## Technical overview

This monorepo publishes two independent Cordis plugins:

| Package | Role |
|---|---|
| [`@kasenri/dsh-orbit`](packages/orbit) | Deterministic engineering orchestration (`orbit_controller` tool + `OrbitService`). |
| [`@kasenri/dsh-browser`](packages/browser) | Controlled browser automation (`agent_browser` tool + `BrowserAutomationService`). |

Orbit uses a bounded Commander / Executor / Smart Watchdog architecture:

```text
PLAN → EXECUTE → EVALUATE → CORRECT / RECOVER → SUCCESS
```

```text
DeepSeek Harness
│
├─ Native infrastructure: agents / subagents / tools / sessions
│
├─ @kasenri/dsh-orbit
│    ├─ OrbitService (durable state in <project>/.cx/state.json)
│    ├─ Deterministic Supervisor
│    ├─ Commander / Executor / Smart Watchdog
│    ├─ Optional MoA Adapter → Candidate fan-out / Judge / controlled promotion
│    └─ Recoverable guards
│
├─ @goodandready/dsh-moa   (optional, required only for Orbit MoA mode)
│
└─ @kasenri/dsh-browser
     └─ agent_browser → agent-browser CLI → Chromium / Chrome / CDP
```

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| `@goodandready/dsh-moa`（仅 Orbit MoA 模式需要） | `>=0.2.19`；已验证 0.2.19、0.2.20 |
| `agent-browser` (browser plugin) | `0.33.2` |
| Node.js | `>= 22.19.0` |

DSH is in developer preview; the plugins are tested with the versions above,
not with every future DSH release.

## Install

Both packages are published to the npm Registry. `pnpm` must be on `PATH`.

```bash
# Orbit plugin only
dsh plugin --profile web add @kasenri/dsh-orbit

# Browser plugin only
dsh plugin --profile web add @kasenri/dsh-browser

# Both (Orbit browser-capability steps may then use the browser plugin)
dsh plugin --profile web add @kasenri/dsh-orbit
dsh plugin --profile web add @kasenri/dsh-browser

# Optional: enable Orbit MoA candidate mode (installed separately)
dsh plugin --profile web add @goodandready/dsh-moa
```

The dedicated Git distribution mirrors (`github:KasenRi/dsh-orbit` and
`github:KasenRi/dsh-browser`) track the mirror repository `HEAD` and remain
available when a Git source is preferred; the source monorepo's versioned
GitHub Release tarballs remain for manual or offline installation.

Each package declares a `dsh.bundle` manifest, so `dsh plugin add` installs it
and registers it as a profile layer automatically. See the package READMEs for
configuration:

- [Orbit configuration](packages/orbit/README.md#configuration)
- [Browser configuration](packages/browser/README.md#configuration)

## Quick start

The most deterministic way to start Orbit is the slash command:

```text
/agent-orbit 修复当前项目的 TypeScript 错误并运行测试
```

如果另外安装了 `@goodandready/dsh-moa`，可以在 Orbit 菜单中开启 **MoA 多候选模式**。开启后只是允许 Commander 为少量高不确定步骤选择 MOA；普通步骤仍然可以继续使用 SINGLE Executor。没有安装 MoA 时，Orbit 的基础功能完全不受影响。

Orbit supports three activation styles:

1. `/agent-orbit <goal>` — deterministic slash-command activation (Web GUI slash menu, or a genuine user message gesture on headless/CLI surfaces).
2. `orbit模式` — recommended natural-language activation.
3. `cx模式` — legacy compatibility; still resolves to Orbit.

In the Web GUI an Orbit model control sits immediately left of the native model
seat. Commander/Watchdog persist into DSH settings, Executor follows the current
session model, and optional MoA Candidate/Judge routes live in a dedicated
second-level menu. Each new run snapshots every effective route it needs;
resumes keep those frozen routes.

```text
# Orbit (typed tool, the same entry the slash command activates)
orbit_controller { "action": "run", "goal": "…", "approved_loop_count": 4 }
orbit_controller { "action": "status" }

# Browser
agent_browser { "args": ["open", "https://example.com"] }
agent_browser { "args": ["snapshot", "-i"] }
agent_browser { "args": ["click", "@e2"] }
agent_browser { "args": ["snapshot", "-i"] }
```

## Safety

- Orbit: read-only allowlists for Commander and Watchdog, a writer allowlist for
  Executors, browser tools only for steps that declare the capability,
  single-mutation-owner fencing, bounded corrections and loop budget, and
  recoverable guard denials that stop one tool call instead of the run.
- Browser: page-scoped refs and stale-ref blocking, tab-drift detection with a
  single deterministic recovery, artifact verification, protected browser
  state blocking, credential redaction, strict `allowedDomains` containment,
  and no CAPTCHA/OTP/2FA bypass.

## Migrating from CX

See [packages/orbit/README.md](packages/orbit/README.md#migrating-from-dsh-cx).
In short: `dsh-cx` → `dsh-orbit`, `cx_controller` → `orbit_controller`,
CX mode → Orbit mode, `ctx.cx` → `ctx.orbit`. `.cx/state.json` remains
unchanged, legacy `cx模式` remains supported, and existing durable runs do not
need migration.

## Development

```bash
npm install
npm run typecheck
npm test            # unit tests
npm run test:e2e    # real Cordis host end-to-end
npm run test:smoke  # real Chromium / CDP / Orbit browser smokes
npm run build       # emit lib/ for both packages
```

The test suite covers unit, runner-integration, real-Cordis-host end-to-end and
real-Chromium smoke levels. The DeepSeek Orbit smoke (`npm run smoke:deepseek`)
requires real model credentials and is not part of the default suite.

## Distribution mirrors

This repository is the canonical source monorepo. The npm Registry carries the
primary release; the installable Git sources are the generated release mirrors
[`KasenRi/dsh-orbit`](https://github.com/KasenRi/dsh-orbit) and
[`KasenRi/dsh-browser`](https://github.com/KasenRi/dsh-browser). Do not develop
features in the mirrors. After the release tests and `npm run build` pass, sync
an explicit stable version with:

```bash
npm run sync:distribution -- 0.5.7 --push
```

The script copies only each package's `package.json`, `cordis.patch.yml`,
`README.md`, `LICENSE`, and prebuilt `lib/`. It updates mirror `main` and creates
a missing package-version tag; ordinary development commits never publish to a
mirror automatically. Versioned tarballs in this repository's GitHub Releases
remain available for manual or offline fallback.

## License

MIT
