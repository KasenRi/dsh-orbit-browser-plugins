import type { JobInput, JobStep, QaInput } from './types.ts'

export interface CompiledBatchStep {
  action: string
  args: string[]
}

export interface CompiledBatch {
  ok: true
  args: string[]
  stdin: string
  steps: CompiledBatchStep[]
}

export interface CompileBatchError {
  ok: false
  message: string
}

const MAX_DELAYED_TEXT_CHARACTERS = 200

type Located = { kind: 'selector'; selector: string } | { kind: 'find'; args: string[] } | { error: string }

function locate(step: JobStep): Located {
  const roleLocator = step.locator === 'role' || step.role !== undefined
  if (roleLocator) {
    const role = step.role ?? step.value
    if (!role) return { error: 'job role locator requires role or value.' }
    const args = ['find', 'role', role]
    if (step.name !== undefined) args.push('--name', step.name)
    return { kind: 'find', args }
  }
  if (step.selector !== undefined) return { kind: 'selector', selector: step.selector }
  if (step.locator !== undefined && step.value !== undefined) {
    return { kind: 'find', args: ['find', step.locator, step.value] }
  }
  return { error: 'job step requires a selector or locator.' }
}

function compileStep(step: JobStep): string[][] | { error: string } {
  switch (step.action) {
    case 'open': {
      if (!step.url) return { error: 'job open requires url.' }
      const rows: string[][] = [['open', step.url]]
      if (step.loadState) rows.push(['wait', '--load', step.loadState])
      return rows
    }
    case 'click': {
      const located = locate(step)
      if ('error' in located) return { error: located.error }
      if (located.kind === 'selector') return [['click', located.selector]]
      return [[...located.args, 'click']]
    }
    case 'fill': {
      if (!step.text) return { error: 'job fill requires text.' }
      const located = locate(step)
      if ('error' in located) return { error: located.error }
      if (located.kind === 'selector') return [['fill', located.selector, step.text]]
      return [[...located.args, 'fill', step.text]]
    }
    case 'type': {
      if (!step.text) return { error: 'job type requires text.' }
      if (step.delayMs !== undefined && step.text.length > MAX_DELAYED_TEXT_CHARACTERS) {
        return { error: `Delayed typing is limited to ${MAX_DELAYED_TEXT_CHARACTERS} characters per step.` }
      }
      const rows: string[][] = []
      if (step.selector) rows.push(['click', step.selector])
      if (step.delayMs !== undefined) rows.push(['keyboard', 'type', step.text, '--delay', String(step.delayMs)])
      else rows.push(['keyboard', 'type', step.text])
      if (step.press) rows.push(['press', step.press])
      return rows
    }
    case 'select': {
      if (!step.selector) return { error: 'job select requires a selector.' }
      const values = step.values ?? (step.value !== undefined ? [step.value] : [])
      if (values.length === 0) return { error: 'job select requires value or values.' }
      return [['select', step.selector, ...values]]
    }
    case 'wait':
      return [['wait', String(step.milliseconds ?? 0)]]
    case 'assertText':
      if (!step.text) return { error: 'job assertText requires text.' }
      return [['wait', '--text', step.text]]
    case 'assertUrl':
      if (!step.url) return { error: 'job assertUrl requires url.' }
      return [['wait', '--url', step.url]]
    case 'waitForDownload':
      if (!step.path) return { error: 'job waitForDownload requires path.' }
      return [['wait', '--download', step.path]]
    case 'screenshot':
      if (!step.path) return { error: 'job screenshot requires path.' }
      return [['screenshot', step.path]]
    case 'snapshot':
      return [['snapshot', '-i']]
    default:
      return { error: `Unsupported job step: ${String(step.action)}` }
  }
}

export function compileJob(job: JobInput): CompiledBatch | CompileBatchError {
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    return { ok: false, message: 'job.steps must contain at least one step.' }
  }
  const failFast = job.failFast !== false
  const steps: CompiledBatchStep[] = []
  const rows: string[][] = []
  for (const step of job.steps) {
    const compiled = compileStep(step)
    if (!Array.isArray(compiled)) return { ok: false, message: compiled.error }
    if (compiled.length === 0) return { ok: false, message: `Job step ${step.action} produced no command.` }
    rows.push(...compiled)
    steps.push({ action: step.action, args: compiled[compiled.length - 1]! })
  }
  return {
    ok: true,
    args: failFast ? ['batch', '--bail'] : ['batch'],
    stdin: JSON.stringify(rows),
    steps,
  }
}

export function compileQa(qa: QaInput): CompiledBatch | CompileBatchError {
  const diagnosticsReset = qa.attached !== true
  const wantNetwork = qa.checkNetwork ?? diagnosticsReset
  const wantConsole = qa.checkConsole ?? diagnosticsReset
  const wantErrors = qa.checkErrors ?? diagnosticsReset
  const rows: string[][] = []
  const steps: CompiledBatchStep[] = []

  if (diagnosticsReset) {
    rows.push(['network', 'requests', '--clear'])
    rows.push(['console', '--clear'])
    rows.push(['errors', '--clear'])
  }
  if (qa.attached !== true) {
    if (!qa.url) return { ok: false, message: 'qa.url is required unless qa.attached is true.' }
    rows.push(['open', qa.url])
    rows.push(['wait', '--load', qa.loadState ?? 'domcontentloaded'])
  } else {
    rows.push(['get', 'url'])
  }
  if (qa.expectedText) {
    rows.push(['wait', '--fn', `document.body.innerText.includes(${JSON.stringify(qa.expectedText)})`, '--timeout', '5000'])
  }
  if (qa.expectedSelector) rows.push(['wait', '--selector', qa.expectedSelector, '--timeout', '5000'])
  if (qa.screenshotPath) rows.push(['screenshot', qa.screenshotPath])
  if (wantNetwork) rows.push(['network', 'requests'])
  if (wantConsole) rows.push(['console'])
  if (wantErrors) rows.push(['errors'])

  for (const row of rows) steps.push({ action: row[0] ?? 'unknown', args: row })
  return { ok: true, args: ['batch', '--bail'], stdin: JSON.stringify(rows), steps }
}
