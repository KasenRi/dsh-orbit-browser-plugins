# DSH CX + Browser Plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

This monorepo publishes two independent Cordis plugins:

| Package | Role |
|---|---|
| [`@kasenri/dsh-browser`](packages/browser) | Controlled browser automation (`agent_browser` tool + `BrowserAutomationService`). |
| [`@kasenri/dsh-cx`](packages/cx) | Deterministic engineering orchestration (`cx_controller` tool + `CxService`). |

The two packages are decoupled: the browser plugin is a shared capability and
CX works without it. Only a plan step that declares the `browser` capability
needs the `agent_browser` tool to be registered.

```text
DeepSeek Harness
│
├─ Native infrastructure: agents / subagents / tools / sessions
│
├─ @kasenri/dsh-browser
│    └─ agent_browser → agent-browser CLI → Chromium / Chrome / CDP
│
└─ @kasenri/dsh-cx
     ├─ CxService (durable state in <project>/.cx/state.json)
     ├─ Deterministic Supervisor
     ├─ Commander / Executor / Smart Watchdog
     └─ Recoverable guards
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

```bash
# Browser plugin only
dsh plugin --profile web add @kasenri/dsh-browser@0.1.0

# CX plugin only
dsh plugin --profile web add @kasenri/dsh-cx@0.1.0

# Both (CX steps may then use the browser capability)
dsh plugin --profile web add @kasenri/dsh-browser@0.1.0
dsh plugin --profile web add @kasenri/dsh-cx@0.1.0
```

Each package declares a `dsh.bundle` manifest, so `dsh plugin add` installs it
and registers it as a profile layer automatically. See the package READMEs for
configuration:

- [Browser configuration](packages/browser/README.md#configuration)
- [CX configuration](packages/cx/README.md#configuration)

## Quick start

```text
# Browser
agent_browser { "args": ["open", "https://example.com"] }
agent_browser { "args": ["snapshot", "-i"] }
agent_browser { "args": ["click", "@e2"] }
agent_browser { "args": ["snapshot", "-i"] }

# CX
cx_controller { "action": "run", "goal": "…", "approved_loop_count": 4 }
cx_controller { "action": "status" }
```

## Safety

- Browser: page-scoped refs and stale-ref blocking, tab-drift detection with a
  single deterministic recovery, artifact verification, protected browser
  state blocking, credential redaction, strict `allowedDomains` containment,
  and no CAPTCHA/OTP/2FA bypass.
- CX: read-only allowlists for Commander and Watchdog, a writer allowlist for
  Executors, browser tools only for steps that declare the capability,
  single-mutation-owner fencing, bounded corrections and loop budget, and
  recoverable guard denials that stop one tool call instead of the run.

## Development

```bash
npm install
npm run typecheck
npm test            # unit tests
npm run test:e2e    # real Cordis host end-to-end
npm run test:smoke  # real Chromium / CDP / CX browser smokes
npm run build       # emit lib/ for both packages
```

The test suite covers unit, runner-integration, real-Cordis-host end-to-end and
real-Chromium smoke levels. The DeepSeek CX smoke (`npm run smoke:deepseek`)
requires real model credentials and is not part of the default suite.

## License

MIT
