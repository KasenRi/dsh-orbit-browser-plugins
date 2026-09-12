# @kasenri/dsh-browser

Community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with or endorsed by DeepSeek.

Exposes controlled **browser automation** to DSH as a Cordis plugin:

- a `BrowserAutomationService` on `ctx.browserAutomation`
- a model-facing `agent_browser` tool that drives the
  [`agent-browser`](https://www.npmjs.com/package/agent-browser) CLI

```text
Harness native infrastructure (agents, tools, sessions)
        │
        ▼
@kasenri/dsh-browser
        │  BrowserAutomationService + agent_browser tool
        ▼
agent-browser CLI  →  Chromium / Chrome  (or an explicit CDP endpoint)
```

## Requirements

| Component | Tested with |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.2` |
| `@deepseek-ai/cordis` | `4.0.2` |
| `agent-browser` | `0.33.2` (must be on `PATH`) |
| Node.js | `>= 22.19.0` |
| Browser | Chromium / Google Chrome (or an Electron/CDP debug endpoint) |

DSH is in developer preview and evolves quickly; this package is tested with the
versions above, not with every future DSH release.

## Install

Distributed as a GitHub Release asset (npm registry publishing is pending):

```bash
dsh plugin --profile web add https://github.com/KasenRi/dsh-orbit-browser-plugins/releases/download/v0.3.0/kasenri-dsh-browser-0.1.0.tgz
```

The package declares a `dsh.bundle` patch, so `dsh plugin add` registers it as a
profile layer automatically. Restart the profile (or start a new session) after
installing.

If `agent-browser` is not on `PATH`, point the plugin at an executable with the
`command` config key, the `executablePath` config key, or the
`DSH_BROWSER_EXECUTABLE_PATH` environment variable.

## Tool input modes

`agent_browser` accepts exactly one of:

| Mode | Purpose |
|---|---|
| `args` | Raw `agent-browser` argv (e.g. `["open", "https://…"]`, `["snapshot", "-i"]`). |
| `semanticAction` | Stable target: `action` + `locator`/`role`/`name`/`selector`. |
| `job` | Short deterministic multi-step batch (`steps`, `failFast`). |
| `qa` | Page QA preset (`url` or `attached`, expected text/selector, diagnostics). |
| `electron` | Explicit CDP attach: `{ action: "connect", port | url }` or `{ action: "probe" }`. |
| `sourceLookup` | Candidate source locations from DOM/React evidence + bounded workspace scan. |
| `networkSourceLookup` | Failed-request evidence + candidate source/workspace hints. |

Standard workflow: `open` → `snapshot -i` → use the current `@refs` →
`click`/`fill`/`select` → `snapshot -i` again after the page changes.

Other options: `stdin` (only for `batch`, `eval --stdin`,
`auth save --password-stdin`), `outputPath` (atomic `0600` write of the
structured result), `timeoutMs`, `sessionMode` (`auto` | `fresh`).

## What it protects

- **Stale refs** — refs are page-scoped; mutations against refs that are not in
  the latest snapshot of the same target are blocked before any browser call.
- **Tab drift** — an unexpected active-target change (including `about:blank`)
  invalidates refs and triggers exactly one deterministic recovery via
  `tab list` + `tab <id>`; ambiguity fails as `tab-drift` instead of guessing.
- **Artifacts** — screenshots, downloads, PDFs, HAR/trace/record files are
  verified on disk (existence, size, type) before success is reported.
- **Secrets and protected state** — `.agent-browser` state, password stores and
  cookie databases are blocked; credential-shaped values are redacted from all
  tool output.
- **Domain containment** — when `allowedDomains` is configured, known URLs are
  preflighted, the managed context launches with upstream `--allowed-domains`,
  and the final URL is verified. CDP attach (`electron`/`connect`) is refused
  while containment is enabled, because it cannot be enforced on an
  existing browser context.
- **Human verification** — CAPTCHA, OTP, passkey, WebAuthn and 2FA are never
  bypassed; the tool reports what it saw and stops.

Large outputs are compacted into a bounded preview plus a spill file instead of
being pushed into the model context.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `agent-browser` | Executable to invoke. |
| `namespace` | — | Optional agent-browser namespace. |
| `executablePath` | `DSH_BROWSER_EXECUTABLE_PATH` | Chromium/Chrome executable for the managed context. |
| `timeoutMs` | `35000` | Default per-call subprocess timeout. |
| `maxOutputChars` | `8000` | Inline output budget before spilling. |
| `maxOutputLines` | `120` | Inline line budget before spilling. |
| `spillDir` | `~/.dsh/browser-artifacts` | Where compacted outputs are written. |
| `allowedDomains` | `[]` | Domain allowlist for strict containment. |
| `registerTool` | `true` | Register the `agent_browser` tool. |

## License

MIT
