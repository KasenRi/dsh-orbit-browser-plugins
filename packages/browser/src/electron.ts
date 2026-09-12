import type { ElectronInput } from './types.ts'

export interface CompiledElectron {
  ok: true
  args: string[]
  generatedStdin?: string
}

export interface ElectronCompileError {
  ok: false
  message: string
}

const CDP_URL = /^(?:wss?|https?):\/\//i

/**
 * Electron support is an explicit CDP attach adapter over the native
 * `connect <port|url>` command. It never scans for or auto-attaches to desktop
 * apps: the caller must name the port or URL. `probe` is read-only.
 */
export function compileElectron(input: ElectronInput): CompiledElectron | ElectronCompileError {
  if (input.action === 'connect') {
    const provided = [input.port !== undefined, input.url !== undefined].filter(Boolean).length
    if (provided !== 1) {
      return { ok: false, message: 'electron.connect requires exactly one of port or url.' }
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      return { ok: false, message: 'electron.port must be an integer in 1..65535.' }
    }
    if (input.url !== undefined && !CDP_URL.test(input.url)) {
      return { ok: false, message: 'electron.url must be a ws/wss/http/https CDP URL.' }
    }
    return { ok: true, args: ['connect', input.url ?? String(input.port)] }
  }

  if (input.action === 'probe') {
    const steps = [['get', 'url'], ['get', 'title'], ['tab', 'list']]
    return { ok: true, args: ['batch'], generatedStdin: JSON.stringify(steps) }
  }

  return { ok: false, message: 'electron.action must be one of: connect, probe.' }
}
