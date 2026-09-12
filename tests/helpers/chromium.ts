import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveExecutable } from '../../packages/browser/src/cli.ts'

/**
 * Locate a Chromium/Chrome executable for the real-browser smoke tests without
 * hardcoding a machine-specific path: explicit env override, Playwright browser
 * caches under the current user's home, then the system PATH.
 */
export function findChromium(): string | undefined {
  const explicit = process.env.DSH_BROWSER_EXECUTABLE_PATH
  if (explicit && existsSync(explicit)) return explicit

  const cacheRoots = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
  ].filter((root) => root.length > 0)

  for (const root of cacheRoots) {
    const [candidate] = scanPlaywrightCache(root)
    if (candidate) return candidate
  }

  return (
    resolveExecutable('chromium', process.env.PATH) ??
    resolveExecutable('chromium-browser', process.env.PATH) ??
    resolveExecutable('google-chrome', process.env.PATH) ??
    resolveExecutable('google-chrome-stable', process.env.PATH)
  )
}

function scanPlaywrightCache(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((entry) => entry.startsWith('chromium-') && !entry.startsWith('chromium_headless_shell'))
      .sort()
      .reverse()
      .map((entry) => join(root, entry, 'chrome-linux', 'chrome'))
      .filter((candidate) => existsSync(candidate))
  } catch {
    return []
  }
}
