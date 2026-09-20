import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import type { ModelRunRequest, ModelRunUsage, OrbitHost } from './host.ts'
import { redactText, truncateSafe } from './sanitize.ts'
import type { OrbitMoaCandidateResult, OrbitMoaPolicy, OrbitMoaPromotionReceipt, OrbitMoaUsage, OrbitPlanStep, OrbitRoute } from './types.ts'

const SUPPORTED_MOA_VERSION = '0.2.19'
const MAX_CONTEXT_CHARS = 16_000
const MAX_CANDIDATE_TEXT = 12_000
const MAX_JUDGE_TEXT = 8_000
const MAX_PROMOTED_FILES = 64
const MAX_PROMOTED_FILE_BYTES = 2 * 1024 * 1024
const CODE_FENCE = String.fromCharCode(96, 96, 96)

interface MoaPublicModule {
  collectProjectContext(baseDir: string, maxCharBudget?: number): Promise<{ files?: unknown[]; skippedFiles?: number; skippedList?: string[] }>
  formatProjectContext(projectFiles?: unknown[], options?: { skippedFiles?: number; skippedList?: string[] }): string
}

export interface OrbitMoaAvailability {
  available: boolean
  version?: string
  reason?: string
}

export interface OrbitMoaFanoutResult {
  adapterVersion: string
  candidates: OrbitMoaCandidateResult[]
  successful: number
  failed: number
}

export interface OrbitMoaJudgeResult {
  winningCandidate: number
  winnerModel: string
  summary: string
  usage?: OrbitMoaUsage
}

export interface OrbitMoaAdapterLike {
  availability(): Promise<OrbitMoaAvailability>
  fanout(input: { workspace: string; runId: string; step: OrbitPlanStep; policy: OrbitMoaPolicy; signal?: AbortSignal }): Promise<OrbitMoaFanoutResult>
  judge(input: { workspace: string; runId: string; step: OrbitPlanStep; policy: OrbitMoaPolicy; candidates: OrbitMoaCandidateResult[]; signal?: AbortSignal }): Promise<OrbitMoaJudgeResult>
  promote(input: { workspace: string; runId: string; stepId: string; winningCandidate: number }): Promise<OrbitMoaPromotionReceipt>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function priceFor(route: OrbitRoute, prices: OrbitMoaPolicy['prices']): { input: number; output: number; cacheHit: number } | undefined {
  if (!prices) return undefined
  const provider = route.provider.trim().toLowerCase()
  const model = route.model.trim().toLowerCase()
  const row = prices[`${provider}/${model}`] ?? prices[model] ?? prices[`${provider}/*`] ?? prices['*']
  if (!row) return undefined
  return { input: row.input, output: row.output, cacheHit: row.cacheHit ?? row.input }
}

function toMoaUsage(route: OrbitRoute, usage: ModelRunUsage | undefined, prices: OrbitMoaPolicy['prices']): OrbitMoaUsage | undefined {
  if (!usage) return undefined
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite
  const rates = priceFor(route, prices)
  const cost = rates
    ? ((usage.inputTokens + cacheWrite) / 1_000_000) * rates.input + (cacheRead / 1_000_000) * rates.cacheHit + (usage.outputTokens / 1_000_000) * rates.output
    : undefined
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: total,
    ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
    ...(cost === undefined ? {} : { cost_usd: Number(cost.toFixed(6)) }),
  }
}

function combineUsage(first: OrbitMoaUsage | undefined, second: OrbitMoaUsage | undefined): OrbitMoaUsage | undefined {
  if (!first) return second
  if (!second) return first
  const cost = (first.cost_usd ?? 0) + (second.cost_usd ?? 0)
  const hasCost = first.cost_usd !== undefined || second.cost_usd !== undefined
  return {
    input_tokens: first.input_tokens + second.input_tokens,
    output_tokens: first.output_tokens + second.output_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
    ...((first.cache_read_tokens ?? 0) + (second.cache_read_tokens ?? 0) > 0 ? { cache_read_tokens: (first.cache_read_tokens ?? 0) + (second.cache_read_tokens ?? 0) } : {}),
    ...((first.cache_write_tokens ?? 0) + (second.cache_write_tokens ?? 0) > 0 ? { cache_write_tokens: (first.cache_write_tokens ?? 0) + (second.cache_write_tokens ?? 0) } : {}),
    ...(hasCost ? { cost_usd: Number(cost.toFixed(6)) } : {}),
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 120)
}

function stepRoot(workspace: string, runId: string, stepId: string): string {
  return join(workspace, '.cx', 'moa', safeSegment(runId), safeSegment(stepId))
}

function candidateDir(workspace: string, runId: string, stepId: string, index: number): string {
  return join(stepRoot(workspace, runId, stepId), 'candidate-' + index)
}

function candidateMetaPath(workspace: string, runId: string, stepId: string, index: number): string {
  return join(stepRoot(workspace, runId, stepId), 'candidate-' + index + '.json')
}

function judgePath(workspace: string, runId: string, stepId: string): string {
  return join(stepRoot(workspace, runId, stepId), 'decision.json')
}

function sanitizeRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\\/gu, '/').replace(/^\/+/, '')
  if (trimmed === '') return undefined
  const first = trimmed.split('/')[0]?.toLowerCase()
  if (first === '.cx' || first === '.git' || first === '.moa') return undefined
  const normalized = trimmed.split('/').filter((part) => part !== '' && part !== '.').join('/')
  if (normalized.split('/').some((part) => part === '..')) return undefined
  return normalized
}

function extractFileBlocks(text: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  const seen = new Set<string>()
  const fenced = /\x60{3}[\w-]*\s+(?:file|path|filepath)=["']?([^\s"'\n\r]+)["']?[\r\n]+([\s\S]*?)\x60{3}/giu
  for (const match of text.matchAll(fenced)) {
    const path = sanitizeRelativePath(match[1] ?? '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    files.push({ path, content: match[2] ?? '' })
  }
  const headed = /(?:###?\s*File:\s*|File:\s*)["']?([A-Za-z0-9_.\-/\\]+)["']?\s*[\r\n]+\x60{3}[\w-]*[\r\n]+([\s\S]*?)\x60{3}/giu
  for (const match of text.matchAll(headed)) {
    const path = sanitizeRelativePath(match[1] ?? '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    files.push({ path, content: match[2] ?? '' })
  }
  return files
}

async function assertNoSymlinkTraversal(root: string, relativePath: string): Promise<void> {
  let current = root
  for (const part of relativePath.split('/')) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('ORBIT_MOA_PROMOTION_SYMLINK: ' + relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function writeCandidateFiles(root: string, files: Array<{ path: string; content: string }>): Promise<string[]> {
  const paths: string[] = []
  for (const file of files.slice(0, MAX_PROMOTED_FILES)) {
    if (Buffer.byteLength(file.content, 'utf8') > MAX_PROMOTED_FILE_BYTES) continue
    const target = resolve(root, file.path)
    if (relative(root, target).startsWith('..')) continue
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, file.content, { encoding: 'utf8', mode: 0o600 })
    paths.push(file.path)
  }
  return paths
}

function modelPrompt(step: OrbitPlanStep, context: string, index: number, total: number): string {
  return [
    '你是 Orbit 的 MoA 独立候选模型。',
    '你正在处理候选 ' + index + '/' + total + '。请独立解决当前步骤，不要假设其他候选会补救你的方案。',
    '你没有工具调用权限，也不能声称已经实际修改或测试项目。',
    '如果方案需要修改文件，请输出完整文件内容，并使用严格格式：' + CODE_FENCE + '语言 file="相对路径"' + '。不要写入 .cx。',
    '优先给出可以直接应用、最小且完整的实现；说明关键取舍与预期验证方式。',
    '自然语言默认使用简体中文；代码、命令、路径、provider/model ID 保持原样。',
    '当前步骤：' + step.goal,
    context ? '当前项目上下文（只读）：\n' + context : '当前项目上下文：无可读文本文件。',
  ].join('\n')
}

function critiquePrompt(step: OrbitPlanStep, own: string, others: string): string {
  return [
    '你是 Orbit 的 MoA 候选模型，现在进入一次有界的同伴互评修订。',
    '请保留自己方案中正确的部分，吸收其他候选的优点，修复明确缺陷，然后重新输出完整候选。',
    '不要把多个方案简单拼接；最终仍必须是一份可独立应用的完整方案。',
    '如果修改文件，继续使用带 file="相对路径" 的完整文件代码块格式。',
    '当前步骤：' + step.goal,
    '你上一轮的方案：\n' + truncateSafe(own, 6_000),
    '其他候选摘要：\n' + truncateSafe(others, 8_000),
  ].join('\n')
}

function judgePrompt(step: OrbitPlanStep, candidates: OrbitMoaCandidateResult[], texts: string[]): string {
  const body = candidates
    .filter((candidate) => candidate.ok)
    .map((candidate) => [
      '候选 ' + candidate.index + '（' + candidate.provider + '/' + candidate.model + '）',
      '文件：' + (candidate.files.join(', ') || '无'),
      truncateSafe(texts[candidate.index - 1] ?? candidate.summary, 4_000),
    ].join('\n'))
    .join('\n\n---\n\n')
  return [
    '你是 Orbit 的 MoA Judge。',
    '你的职责只有相对比较：从现有成功候选中选择最适合当前步骤的一份。不要生成新的综合代码，不要决定 Orbit Step 是否通过。',
    '必须考虑正确性、最小改动、可验证性、回归风险和用户原始步骤目标。',
    '最终必须单独输出机器标记：WINNER_CANDIDATE_INDEX: <数字>。',
    '自然语言默认使用简体中文。',
    '当前步骤：' + step.goal,
    body,
  ].join('\n\n')
}

function winnerIndex(text: string, allowed: ReadonlySet<number>): number | undefined {
  const match = text.match(/WINNER_CANDIDATE_INDEX\s*:\s*(\d+)/iu)
  if (!match) return undefined
  const index = Number(match[1])
  return allowed.has(index) ? index : undefined
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export class OrbitMoaAdapter implements OrbitMoaAdapterLike {
  private readonly host: OrbitHost
  private modulePromise?: Promise<{ version: string; api: MoaPublicModule }>

  constructor(host: OrbitHost) {
    this.host = host
  }

  private async load(): Promise<{ version: string; api: MoaPublicModule }> {
    if (this.modulePromise) return this.modulePromise
    this.modulePromise = (async () => {
      const require = createRequire(import.meta.url)
      let packageJsonPath: string
      try {
        packageJsonPath = require.resolve('@goodandready/dsh-moa/package.json')
      } catch {
        throw new Error('ORBIT_MOA_UNAVAILABLE: 未安装 @goodandready/dsh-moa。')
      }
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string }
      const version = String(pkg.version ?? '')
      if (version !== SUPPORTED_MOA_VERSION) {
        throw new Error('ORBIT_MOA_VERSION_UNSUPPORTED: 当前支持 ' + SUPPORTED_MOA_VERSION + '，检测到 ' + (version || 'unknown') + '。')
      }
      const entry = require.resolve('@goodandready/dsh-moa')
      const api = await import(pathToFileURL(entry).href) as unknown as MoaPublicModule
      if (typeof api.collectProjectContext !== 'function' || typeof api.formatProjectContext !== 'function') {
        throw new Error('ORBIT_MOA_API_UNAVAILABLE: dsh-moa 缺少项目上下文接口。')
      }
      return { version, api }
    })()
    return this.modulePromise
  }

  async availability(): Promise<OrbitMoaAvailability> {
    if (!this.host.runModel) return { available: false, reason: 'ORBIT_MOA_MODEL_RUNNER_UNAVAILABLE' }
    try {
      const loaded = await this.load()
      return { available: true, version: loaded.version }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private async call(route: OrbitRoute, label: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; usage?: ModelRunUsage }> {
    if (!this.host.runModel) throw new Error('ORBIT_MOA_MODEL_RUNNER_UNAVAILABLE')
    const request: ModelRunRequest = { label, prompt, route, ...(signal ? { signal } : {}) }
    const result = await this.host.runModel(request)
    if (result.interrupted) throw new Error(result.reason ?? 'ORBIT_MOA_MODEL_INTERRUPTED')
    return { text: result.output, ...(result.usage ? { usage: result.usage } : {}) }
  }

  async fanout(input: { workspace: string; runId: string; step: OrbitPlanStep; policy: OrbitMoaPolicy; signal?: AbortSignal }): Promise<OrbitMoaFanoutResult> {
    const loaded = await this.load()
    const collected = await loaded.api.collectProjectContext(input.workspace, MAX_CONTEXT_CHARS)
    const context = loaded.api.formatProjectContext(collected.files ?? [], {
      skippedFiles: collected.skippedFiles ?? 0,
      skippedList: collected.skippedList ?? [],
    })
    const count = input.policy.candidate_count
    await mkdir(stepRoot(input.workspace, input.runId, input.step.id), { recursive: true, mode: 0o700 })
    const texts = new Array<string>(count).fill('')

    const firstPass = await Promise.all(input.policy.candidates.slice(0, count).map(async (route, offset) => {
      const index = offset + 1
      const metaPath = candidateMetaPath(input.workspace, input.runId, input.step.id, index)
      const routeHash = sha256(JSON.stringify(route))
      const cached = await readJson<OrbitMoaCandidateResult & { text?: string; route_hash?: string }>(metaPath)
      if (cached?.route_hash === routeHash && typeof cached.text === 'string') {
        texts[offset] = cached.text
        return cached
      }
      try {
        const call = await this.call(route, 'moa-candidate-' + input.step.id + '-' + index, modelPrompt(input.step, context, index, count), input.signal)
        const text = call.text
        texts[offset] = text
        const written = await writeCandidateFiles(candidateDir(input.workspace, input.runId, input.step.id, index), extractFileBlocks(text))
        const result: OrbitMoaCandidateResult & { text: string; route_hash: string } = {
          index,
          provider: route.provider,
          model: route.model,
          ok: true,
          summary: redactText(truncateSafe(text, 2_000)),
          files: written,
          ...(toMoaUsage(route, call.usage, input.policy.prices) ? { usage: toMoaUsage(route, call.usage, input.policy.prices) } : {}),
          text: truncateSafe(text, MAX_CANDIDATE_TEXT),
          route_hash: routeHash,
        }
        await writeFile(metaPath, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 })
        return result
      } catch (error) {
        const message = redactText(truncateSafe(error instanceof Error ? error.message : String(error), 500))
        const result: OrbitMoaCandidateResult & { route_hash: string } = {
          index,
          provider: route.provider,
          model: route.model,
          ok: false,
          summary: message,
          files: [],
          error: message,
          route_hash: routeHash,
        }
        await writeFile(metaPath, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 })
        return result
      }
    }))

    if (input.policy.peer_critique) {
      await Promise.all(firstPass.map(async (candidate, offset) => {
        if (!candidate.ok) return
        const route = input.policy.candidates[offset] as OrbitRoute
        const others = firstPass.filter((other) => other.ok && other.index !== candidate.index).map((other) => '候选 ' + other.index + ': ' + other.summary).join('\n\n')
        try {
          const revisedCall = await this.call(route, 'moa-critique-' + input.step.id + '-' + candidate.index, critiquePrompt(input.step, texts[offset] ?? candidate.summary, others), input.signal)
          const revised = revisedCall.text
          texts[offset] = revised
          candidate.summary = redactText(truncateSafe(revised, 2_000))
          candidate.files = await writeCandidateFiles(candidateDir(input.workspace, input.runId, input.step.id, candidate.index), extractFileBlocks(revised))
          candidate.usage = combineUsage(candidate.usage, toMoaUsage(route, revisedCall.usage, input.policy.prices))
          await writeFile(candidateMetaPath(input.workspace, input.runId, input.step.id, candidate.index), JSON.stringify({
            ...candidate,
            text: truncateSafe(revised, MAX_CANDIDATE_TEXT),
            route_hash: sha256(JSON.stringify(route)),
            peer_critique: true,
          }, null, 2), { encoding: 'utf8', mode: 0o600 })
        } catch (error) {
          candidate.ok = false
          candidate.error = redactText(truncateSafe(error instanceof Error ? error.message : String(error), 500))
        }
      }))
    }

    const candidates = firstPass.map((candidate) => {
      const copy = { ...candidate } as Record<string, unknown>
      delete copy.text
      delete copy.route_hash
      return copy as unknown as OrbitMoaCandidateResult
    })
    const successful = candidates.filter((candidate) => candidate.ok).length
    return { adapterVersion: loaded.version, candidates, successful, failed: candidates.length - successful }
  }

  async judge(input: { workspace: string; runId: string; step: OrbitPlanStep; policy: OrbitMoaPolicy; candidates: OrbitMoaCandidateResult[]; signal?: AbortSignal }): Promise<OrbitMoaJudgeResult> {
    const cached = await readJson<OrbitMoaJudgeResult>(judgePath(input.workspace, input.runId, input.step.id))
    if (cached?.winningCandidate && cached.summary) return cached
    const successful = input.candidates.filter((candidate) => candidate.ok)
    if (successful.length < 2) throw new Error('ORBIT_MOA_QUORUM_FAILED: 至少需要 2 个成功候选。')
    const texts: string[] = []
    for (const candidate of input.candidates) {
      const meta = await readJson<{ text?: string }>(candidateMetaPath(input.workspace, input.runId, input.step.id, candidate.index))
      texts[candidate.index - 1] = meta?.text ?? candidate.summary
    }
    const judgeCall = await this.call(input.policy.judge, 'moa-judge-' + input.step.id, judgePrompt(input.step, input.candidates, texts), input.signal)
    const output = judgeCall.text
    const allowed = new Set(successful.map((candidate) => candidate.index))
    const selected = winnerIndex(output, allowed)
    if (selected === undefined) throw new Error('ORBIT_MOA_JUDGE_INVALID: Judge 未返回有效 WINNER_CANDIDATE_INDEX。')
    const winner = input.candidates[selected - 1]
    if (!winner) throw new Error('ORBIT_MOA_JUDGE_INVALID: winner 不存在。')
    const result: OrbitMoaJudgeResult = {
      winningCandidate: selected,
      winnerModel: winner.provider + '/' + winner.model,
      summary: redactText(truncateSafe(output, MAX_JUDGE_TEXT)),
      ...(toMoaUsage(input.policy.judge, judgeCall.usage, input.policy.prices) ? { usage: toMoaUsage(input.policy.judge, judgeCall.usage, input.policy.prices) } : {}),
    }
    await writeFile(judgePath(input.workspace, input.runId, input.step.id), JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 })
    return result
  }

  async promote(input: { workspace: string; runId: string; stepId: string; winningCandidate: number }): Promise<OrbitMoaPromotionReceipt> {
    const sourceRoot = candidateDir(input.workspace, input.runId, input.stepId, input.winningCandidate)
    const workspaceRoot = await realpath(input.workspace).catch(() => resolve(input.workspace))
    const receiptPath = join(stepRoot(input.workspace, input.runId, input.stepId), 'promotion.json')
    const cached = await readJson<OrbitMoaPromotionReceipt>(receiptPath)
    if (cached && Array.isArray(cached.files)) {
      if (cached.files.length === 0) return cached
      const matches = await Promise.all(cached.files.map(async (entry) => {
        try {
          return sha256(await readFile(join(workspaceRoot, entry.path))) === entry.promoted_sha256
        } catch {
          return false
        }
      }))
      if (matches.every(Boolean)) return cached
    }

    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) await walk(absolute)
        else if (entry.isFile()) files.push(relative(sourceRoot, absolute).replace(/\\/gu, '/'))
      }
    }
    await walk(sourceRoot)
    if (files.length > MAX_PROMOTED_FILES) throw new Error('ORBIT_MOA_PROMOTION_TOO_LARGE: 文件数量超过安全上限。')

    const receipt: OrbitMoaPromotionReceipt = { files: [], promoted_at: new Date().toISOString() }
    if (files.length === 0) {
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600 })
      return receipt
    }
    for (const rel of files.sort()) {
      const safe = sanitizeRelativePath(rel)
      if (!safe) throw new Error('ORBIT_MOA_PROMOTION_PATH_INVALID: ' + rel)
      const source = resolve(sourceRoot, safe)
      const info = await stat(source)
      if (!info.isFile() || info.size > MAX_PROMOTED_FILE_BYTES) throw new Error('ORBIT_MOA_PROMOTION_FILE_INVALID: ' + safe)
      const destination = resolve(workspaceRoot, safe)
      if (relative(workspaceRoot, destination).startsWith('..')) throw new Error('ORBIT_MOA_PROMOTION_PATH_INVALID: ' + safe)
      await assertNoSymlinkTraversal(workspaceRoot, safe)
      await mkdir(dirname(destination), { recursive: true })
      const candidateBytes = await readFile(source)
      await copyFile(source, destination)
      const promotedBytes = await readFile(destination)
      receipt.files.push({ path: safe, candidate_sha256: sha256(candidateBytes), promoted_sha256: sha256(promotedBytes) })
    }
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600 })
    return receipt
  }
}
