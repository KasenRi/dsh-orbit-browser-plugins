import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { redactText } from './security.ts'
import type { LookupAnalysis, NetworkSourceLookupInput, SourceCandidate, SourceLookupInput } from './types.ts'

const DEFAULT_MAX_WORKSPACE_FILES = 500
const MAX_WORKSPACE_FILES = 2000
const MAX_CANDIDATES = 20
const MAX_FAILED_REQUESTS = 10
const SOURCE_FILE_PATTERN = /([A-Za-z0-9_./@-]+\.(?:tsx|jsx|ts|js|mjs|cjs|vue|svelte))(?::(\d+))?(?::(\d+))?/g
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '.turbo', 'target', 'vendor', '.venv', '__pycache__'])
const WORKSPACE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'])

export interface CompiledLookup {
  ok: true
  args: string[]
  stdin: string
  steps: Array<{ action: string; args: string[] }>
  query: Record<string, string | number | boolean | undefined>
}

export interface LookupCompileError {
  ok: false
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string): { value?: string; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.trim().length === 0) return { error: `${field} must be a non-empty string when provided.` }
  return { value: value.trim() }
}

function maxWorkspaceFiles(value: unknown, field: string): { value?: number; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return { error: `${field} must be a positive integer when provided.` }
  if (value > MAX_WORKSPACE_FILES) return { error: `${field} must be ${MAX_WORKSPACE_FILES} or less.` }
  return { value }
}

export function compileSourceLookup(input: SourceLookupInput): CompiledLookup | LookupCompileError {
  const selector = nonEmptyString(input.selector, 'sourceLookup.selector')
  if (selector.error) return { ok: false, message: selector.error }
  const reactFiberId = nonEmptyString(input.reactFiberId, 'sourceLookup.reactFiberId')
  if (reactFiberId.error) return { ok: false, message: reactFiberId.error }
  const componentName = nonEmptyString(input.componentName, 'sourceLookup.componentName')
  if (componentName.error) return { ok: false, message: componentName.error }
  if (!selector.value && !reactFiberId.value && !componentName.value) {
    return { ok: false, message: 'sourceLookup requires selector, reactFiberId, or componentName.' }
  }
  if (input.includeDomHints !== undefined && typeof input.includeDomHints !== 'boolean') {
    return { ok: false, message: 'sourceLookup.includeDomHints must be a boolean when provided.' }
  }
  const max = maxWorkspaceFiles(input.maxWorkspaceFiles, 'sourceLookup.maxWorkspaceFiles')
  if (max.error) return { ok: false, message: max.error }

  const steps: Array<{ action: string; args: string[] }> = []
  const includeDomHints = input.includeDomHints !== false
  if (selector.value) {
    steps.push({ action: 'is-visible', args: ['is', 'visible', selector.value] })
    if (includeDomHints) steps.push({ action: 'get-html', args: ['get', 'html', selector.value] })
  }
  if (reactFiberId.value) steps.push({ action: 'react-inspect', args: ['react', 'inspect', reactFiberId.value] })
  if (componentName.value) steps.push({ action: 'react-tree', args: ['react', 'tree'] })

  return {
    ok: true,
    args: ['batch'],
    stdin: JSON.stringify(steps.map((step) => step.args)),
    steps,
    query: {
      selector: selector.value,
      reactFiberId: reactFiberId.value,
      componentName: componentName.value,
      includeDomHints,
      maxWorkspaceFiles: max.value ?? DEFAULT_MAX_WORKSPACE_FILES,
    },
  }
}

export function compileNetworkSourceLookup(input: NetworkSourceLookupInput): CompiledLookup | LookupCompileError {
  const requestId = nonEmptyString(input.requestId, 'networkSourceLookup.requestId')
  if (requestId.error) return { ok: false, message: requestId.error }
  const filter = nonEmptyString(input.filter, 'networkSourceLookup.filter')
  if (filter.error) return { ok: false, message: filter.error }
  const url = nonEmptyString(input.url, 'networkSourceLookup.url')
  if (url.error) return { ok: false, message: url.error }
  if (!requestId.value && !filter.value && !url.value) {
    return { ok: false, message: 'networkSourceLookup requires requestId, filter, or url.' }
  }
  const max = maxWorkspaceFiles(input.maxWorkspaceFiles, 'networkSourceLookup.maxWorkspaceFiles')
  if (max.error) return { ok: false, message: max.error }

  const steps: Array<{ action: string; args: string[] }> = []
  if (requestId.value) steps.push({ action: 'network-request', args: ['network', 'request', requestId.value] })
  const effectiveFilter = filter.value ?? url.value
  if (effectiveFilter) steps.push({ action: 'network-requests', args: ['network', 'requests', '--filter', effectiveFilter] })

  return {
    ok: true,
    args: ['batch'],
    stdin: JSON.stringify(steps.map((step) => step.args)),
    steps,
    query: {
      requestId: requestId.value,
      filter: filter.value,
      url: url.value,
      maxWorkspaceFiles: max.value ?? DEFAULT_MAX_WORKSPACE_FILES,
    },
  }
}

function redactLookupUrl(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const isRelative = value.startsWith('/')
    const url = new URL(value, isRelative ? 'https://redacted.invalid' : undefined)
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]')
    if (/(?:token|secret|password|passwd|pwd|key|auth|session|jwt|credential)/i.test(url.hash)) url.hash = '#[REDACTED]'
    return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString()
  } catch {
    return redactText(value).replace(/([?&][^=]+)=([^&#\s"'\]]+)/g, '$1=[REDACTED]')
  }
}

function addCandidate(candidates: SourceCandidate[], candidate: SourceCandidate): void {
  if (candidates.length >= MAX_CANDIDATES) return
  const key = [candidate.source, candidate.file ?? '', candidate.line ?? '', candidate.requestUrl ?? ''].join(':')
  if (candidates.some((existing) => [existing.source, existing.file ?? '', existing.line ?? '', existing.requestUrl ?? ''].join(':') === key)) return
  candidates.push({
    ...candidate,
    evidence: candidate.evidence.slice(0, 3).map((item) => redactText(item).slice(0, 200)),
    ...(candidate.file ? { file: redactLookupUrl(candidate.file) ?? candidate.file } : {}),
    ...(candidate.requestUrl ? { requestUrl: redactLookupUrl(candidate.requestUrl) } : {}),
  })
}

function collectSourceCandidates(value: unknown, source: string, candidates: SourceCandidate[], evidence: string[], depth = 0): void {
  if (depth > 6 || value === undefined || value === null || candidates.length >= MAX_CANDIDATES) return
  if (typeof value === 'string') {
    for (const match of value.matchAll(SOURCE_FILE_PATTERN)) {
      addCandidate(candidates, {
        source,
        confidence: source === 'react-inspect' ? 'high' : 'medium',
        evidence,
        file: match[1] ?? '',
        ...(match[2] ? { line: Number(match[2]) } : {}),
        ...(match[3] ? { column: Number(match[3]) } : {}),
      })
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceCandidates(item, source, candidates, evidence, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const nested of Object.values(value)) collectSourceCandidates(nested, source, candidates, evidence, depth + 1)
}

function getBatchItems(data: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) return []
  return data.filter(isRecord)
}

function resultPayload(item: Record<string, unknown>): unknown {
  const result = item['result']
  if (isRecord(result) && 'data' in result) return result['data']
  return result
}

async function walkWorkspace(root: string, maxFiles: number, extensions = WORKSPACE_EXTENSIONS): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path)
      } else if (entry.isFile() && extensions.has(extname(entry.name))) {
        files.push(path)
      }
    }
  }
  await visit(root)
  return { files, truncated }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function analyzeSourceLookup(
  data: unknown,
  query: Record<string, string | number | boolean | undefined>,
  cwd: string,
): Promise<LookupAnalysis> {
  const candidates: SourceCandidate[] = []
  const limitations = [
    'Experimental lookup reports candidates with evidence only; it cannot guarantee a DOM node maps to one source file.',
    'React source hints require the page to be opened with --enable react-devtools and app build source metadata.',
  ]
  for (const item of getBatchItems(data)) {
    const command = Array.isArray(item['command']) ? (item['command'] as unknown[]).filter((token): token is string => typeof token === 'string') : []
    const payload = resultPayload(item)
    if (command[0] === 'react' && command[1] === 'inspect') collectSourceCandidates(payload, 'react-inspect', candidates, ['react inspect returned source-like metadata'])
    if (command[0] === 'get' && command[1] === 'html') collectSourceCandidates(payload, 'dom-html', candidates, ['selector HTML contained source-like text'])
  }

  const componentName = typeof query.componentName === 'string' ? query.componentName : undefined
  if (componentName) {
    const maxFiles = typeof query.maxWorkspaceFiles === 'number' ? query.maxWorkspaceFiles : DEFAULT_MAX_WORKSPACE_FILES
    const { files, truncated } = await walkWorkspace(cwd, maxFiles)
    if (truncated) limitations.push(`Workspace source scan stopped at ${maxFiles} files.`)
    const componentPattern = new RegExp(`(?:function|class)\\s+${escapeRegExp(componentName)}\\b|(?:const|let|var)\\s+${escapeRegExp(componentName)}\\s*=`)
    for (const file of files) {
      if (candidates.filter((candidate) => candidate.source === 'workspace-search').length >= 10) break
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const match = componentPattern.exec(text)
      if (!match) continue
      addCandidate(candidates, {
        source: 'workspace-search',
        confidence: 'low',
        evidence: [`local workspace contains a matching ${componentName} declaration`],
        file,
        line: text.slice(0, match.index).split('\n').length,
        componentName,
      })
    }
  }

  const status = candidates.length > 0 ? 'candidates-found' : 'no-candidates'
  return {
    status,
    summary: candidates.length > 0 ? `Source lookup found ${candidates.length} candidate location(s).` : 'Source lookup found no candidate locations.',
    candidates,
    limitations,
  }
}

function collectFailedRequests(data: unknown, queryText: string | undefined): LookupAnalysis['failedRequests'] {
  const failed: NonNullable<LookupAnalysis['failedRequests']> = []
  for (const item of getBatchItems(data)) {
    const payload = resultPayload(item)
    const record = isRecord(payload) ? payload : undefined
    const requests = record && Array.isArray(record['requests']) ? record['requests'] : Array.isArray(payload) ? payload : []
    for (const request of requests) {
      if (!isRecord(request)) continue
      const url = typeof request['url'] === 'string' ? request['url'] : undefined
      if (queryText && url && !url.includes(queryText) && !queryText.includes(url)) continue
      const status = typeof request['status'] === 'number' ? request['status'] : undefined
      const error = typeof request['error'] === 'string' ? request['error'] : undefined
      const isFailed = request['failed'] === true || error !== undefined || (status !== undefined && status >= 400)
      if (!isFailed || failed.length >= MAX_FAILED_REQUESTS) continue
      failed.push({
        ...(typeof request['id'] === 'string' ? { requestId: request['id'] } : {}),
        ...(url ? { url: redactLookupUrl(url) } : {}),
        ...(typeof request['method'] === 'string' ? { method: request['method'] } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(error ? { error: redactText(error).slice(0, 200) } : {}),
      })
    }
  }
  return failed
}

function collectInitiatorCandidates(data: unknown, candidates: SourceCandidate[]): void {
  for (const item of getBatchItems(data)) {
    const payload = resultPayload(item)
    const record = isRecord(payload) ? payload : undefined
    const requests = record && Array.isArray(record['requests']) ? record['requests'] : [payload]
    for (const request of requests) {
      if (!isRecord(request)) continue
      const status = typeof request['status'] === 'number' ? request['status'] : undefined
      const error = request['error']
      const failed = request['failed'] === true || error !== undefined || (status !== undefined && status >= 400)
      if (!failed) continue
      const requestUrl = typeof request['url'] === 'string' ? request['url'] : undefined
      for (const field of ['initiator', 'stack', 'source', 'trace']) {
        const local: SourceCandidate[] = []
        collectSourceCandidates(request[field], 'initiator', local, ['failed network request included source-like initiator metadata'])
        for (const candidate of local) {
          addCandidate(candidates, { ...candidate, source: 'initiator', ...(requestUrl ? { requestUrl } : {}) })
        }
      }
    }
  }
}

async function collectWorkspaceRequestCandidates(
  query: Record<string, string | number | boolean | undefined>,
  failedRequests: NonNullable<LookupAnalysis['failedRequests']>,
  cwd: string,
  candidates: SourceCandidate[],
  limitations: string[],
): Promise<void> {
  const rawNeedles = [
    typeof query.url === 'string' ? query.url : undefined,
    typeof query.filter === 'string' ? query.filter : undefined,
    ...failedRequests.map((request) => request.url),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const needles = [...new Set(
    rawNeedles.flatMap((value) => {
      try {
        const parsed = new URL(value)
        return [value, parsed.pathname].filter((item) => item && item !== '/')
      } catch {
        return [value]
      }
    }),
  )].slice(0, 8)
  if (needles.length === 0) return

  const maxFiles = typeof query.maxWorkspaceFiles === 'number' ? query.maxWorkspaceFiles : DEFAULT_MAX_WORKSPACE_FILES
  const { files, truncated } = await walkWorkspace(cwd, maxFiles, new Set([...WORKSPACE_EXTENSIONS, '.json', '.html']))
  if (truncated) limitations.push(`Workspace source scan stopped at ${maxFiles} files.`)
  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const needle of needles) {
      const index = text.indexOf(needle)
      if (index === -1) continue
      addCandidate(candidates, {
        source: 'workspace-search',
        confidence: 'low',
        evidence: [`local workspace contains request URL literal ${needle}`],
        file,
        line: text.slice(0, index).split('\n').length,
        requestUrl: needle,
      })
      if (candidates.filter((candidate) => candidate.source === 'workspace-search').length >= 10) return
    }
  }
}

export async function analyzeNetworkSourceLookup(
  data: unknown,
  query: Record<string, string | number | boolean | undefined>,
  cwd: string,
): Promise<LookupAnalysis> {
  const limitations = [
    'Experimental network source hints report candidates only; failed requests can be triggered indirectly by frameworks, caches, service workers, or third-party scripts.',
    'Initiator/source-map metadata is upstream/browser-build dependent and may be absent.',
  ]
  const queryText = (typeof query.url === 'string' ? query.url : undefined) ?? (typeof query.filter === 'string' ? query.filter : undefined)
  const failedRequests = collectFailedRequests(data, queryText) ?? []
  const candidates: SourceCandidate[] = []
  collectInitiatorCandidates(data, candidates)
  await collectWorkspaceRequestCandidates(query, failedRequests, cwd, candidates, limitations)

  const status = failedRequests.length === 0 ? 'no-failed-requests' : candidates.length > 0 ? 'failed-requests-found' : 'no-candidates'
  const summary =
    failedRequests.length === 0
      ? 'Network source lookup found no failed requests.'
      : candidates.length > 0
        ? `Network source lookup found ${failedRequests.length} failed request(s) and ${candidates.length} candidate source hint(s).`
        : `Network source lookup found ${failedRequests.length} failed request(s) but no source candidates.`
  return { status, summary, candidates, failedRequests, limitations }
}

/** Build a source-map candidate from the `get html <selector>` payload of a single element. */
export function analyzeSourceLookupFromHtml(html: string): LookupAnalysis {
  const candidates: SourceCandidate[] = []
  collectSourceCandidates(html, 'dom-html', candidates, ['selector HTML contained source-like text'])
  return {
    status: candidates.length > 0 ? 'candidates-found' : 'no-candidates',
    summary: candidates.length > 0 ? `Source lookup found ${candidates.length} candidate location(s).` : 'Source lookup found no candidate locations.',
    candidates,
    limitations: ['Experimental lookup reports candidates with evidence only.'],
  }
}
