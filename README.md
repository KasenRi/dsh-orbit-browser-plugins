# DSH Orbit + Browser Plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

> **让 AI 不只是回答问题，而是真的把任务做完。**
>
> 这是一组面向 DeepSeek Harness 的实用插件：Orbit 负责把一个完整目标拆成步骤、分配给不同模型执行并持续检查结果；Browser 负责让 AI 真正操作浏览器。两者可以独立使用，也可以组合成一个能够持续推进项目、自动处理网页任务的 AI 工作流。


### @kasenri/dsh-orbit — 让 AI 项目在无人监管下持续推进

你只需要告诉 AI 最终目标，Orbit 会负责把任务拆成多个步骤，安排执行、逐步检查，并在还有工作没完成时继续推进，而不是每做一步都等你重新下指令。

Orbit 把工作分成不同角色：更强的模型可以负责规划和审核，价格更低的模型负责大量实际执行，因此可以在保证关键环节质量的同时，让低成本模型也真正参与到工程里，**降低整个项目使用 AI 的总成本**。

从 v0.6.0 开始，Orbit 还可以选择性配合 `@goodandready/dsh-moa`；v0.6.1 已验证兼容 0.2.19–0.2.20：对于存在多种合理实现路线的关键步骤，让 2–4 个候选模型独立提出方案，由 Judge 做相对选优，再由 Orbit 受控写回、真实测试并交给 Commander 最终审核。MoA 不接管 Orbit 状态机，也不能直接决定 Step 通过。

同时，Smart Watchdog 会关注运行中的异常情况。如果执行器长时间没有进展、出现卡死、超时或中断，Watchdog 可以介入诊断，并尝试恢复任务，而不是让整个工程静默停在那里。

适合的场景包括：代码修改、项目维护、批量文件处理、自动测试、需要多步骤推进的工程任务，以及你希望“交代完目标以后先让 AI 自己干”的工作。

### @kasenri/dsh-browser — 让 AI 真正操作浏览器完成任务

Browser 给 DSH 增加真实浏览器操作能力。AI 可以打开网页、点击按钮、输入内容、翻页、读取页面信息、下载文件，并把浏览器操作作为整个任务的一部分继续执行。

它适合网页测试、信息采集、后台操作、表单处理和其他需要真实浏览器交互的自动化任务，同时提供域名限制等安全控制，避免浏览器能力无限制地访问不相关站点。

### 两个插件一起使用

组合后，一个典型任务可以变成：

```text
你给出最终目标
      ↓
Orbit 自动规划任务
      ↓
Commander 负责规划 / 审核
      ↓
Executor 负责实际执行
      ↓
需要网页时调用 Browser
      ↓
Watchdog 处理卡死 / 超时 / 中断
      ↓
逐步检查并继续推进
      ↓
完成目标并返回最终结果
```

Orbit 和 Browser 彼此独立：只需要自动工程编排时可以只安装 Orbit，只需要浏览器能力时可以只安装 Browser；当 Orbit 的某一步需要访问网页时，再组合使用 Browser。

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
│    └─ Recoverable guards
│
└─ @kasenri/dsh-browser
     └─ agent_browser → agent-browser CLI → Chromium / Chrome / CDP
```

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
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

# Optional MoA integration for Orbit v0.6.0
dsh plugin --profile web add @goodandready/dsh-moa@0.2.20
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

Orbit v0.6.0 的可选 MoA 模式保持同一顶层 Supervisor：Candidate/Judge 使用冻结的 DSH routes、零工具运行，候选只写入 `.cx/moa/` 隔离区；胜出结果由 Orbit Supervisor 受控提升，Executor 真实验证，Commander 最终验收。运行态仍通过 DSH Session projection 保留 Candidate/Judge、Token 与成本等有界数据；v0.6.1 将配置首页恢复为紧凑一级菜单，MoA 详细配置进入二级菜单，不再把运行详情直接铺在首页。当 Orbit Run 为 ACTIVE 时，Orbit 会先于下游 hook 阻止独立 `/moa`，避免原版 MoA 的自动 Promotion 与 Orbit 同时争夺 workspace。

Orbit supports three activation styles:

1. `/agent-orbit <goal>` — deterministic slash-command activation (Web GUI slash menu, or a genuine user message gesture on headless/CLI surfaces).
2. `orbit模式` — recommended natural-language activation.
3. `cx模式` — legacy compatibility; still resolves to Orbit.

In the Web GUI an Orbit model control sits immediately left of the native model
seat: Commander/Watchdog persist into DSH settings, and the Executor follows the
current session model through the same shared model directory. Each new run
snapshots the three effective routes; resumes keep their frozen routes.

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
