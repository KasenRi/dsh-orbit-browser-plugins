# DSH Orbit + Browser Plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

This monorepo publishes two independent Cordis plugins:

| Package | Role |
|---|---|
| [`@kasenri/dsh-orbit`](packages/orbit) | Deterministic engineering orchestration (`orbit_controller` tool + `OrbitService`). |
| [`@kasenri/dsh-browser`](packages/browser) | Controlled browser automation (`agent_browser` tool + `BrowserAutomationService`). |

Orbit is a deterministic engineering orchestration runtime for DeepSeek Harness.
It coordinates planning, execution, evaluation, bounded correction, runtime
recovery and durable state through a minimal Commander / Executor / Smart
Watchdog architecture. Orbit 强调的是一个“有界、自我收敛的工程执行轨道”：

```text
PLAN → EXECUTE → EVALUATE → CORRECT / RECOVER → SUCCESS
```

Orbit is not a timer loop, an infinite auto-continue, a pure reviewer, a pure
planner, or an agent swarm. It is a deterministic supervisor plus Commander,
Executor, Smart Watchdog, durable state and bounded recovery.

The two packages are decoupled: the browser plugin is a shared capability and
Orbit works without it. Only a plan step that declares the `browser` capability
needs the `agent_browser` tool to be registered.

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
npm run sync:distribution -- 0.5.4 --push
```

The script copies only each package's `package.json`, `cordis.patch.yml`,
`README.md`, `LICENSE`, and prebuilt `lib/`. It updates mirror `main` and creates
a missing package-version tag; ordinary development commits never publish to a
mirror automatically. Versioned tarballs in this repository's GitHub Releases
remain available for manual or offline fallback.

## License

MIT
