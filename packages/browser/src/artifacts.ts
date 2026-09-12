import { isAbsolute, resolve } from 'node:path'
import type { ArtifactEntry, ArtifactVerification } from './types.ts'

export interface StatLike {
  isFile(): boolean
  size: number
}

export type StatFn = (path: string) => Promise<StatLike>

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.har': 'application/json',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}

export interface ArtifactRequest {
  requestedPath: string
  kind: string
  pending?: boolean
}

export function mediaTypeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return EXTENSION_MEDIA_TYPES[path.slice(dot).toLowerCase()]
}

export function kindForExtension(path: string): string {
  const media = mediaTypeForPath(path)
  if (media === 'application/pdf') return 'pdf'
  if (media === 'image/png' || (media?.startsWith('image/') ?? false)) return 'image'
  if (media === 'video/webm' || media === 'video/mp4') return 'video'
  if (path.endsWith('.har')) return 'har'
  if (path.endsWith('.zip')) return 'trace'
  return 'file'
}

/** Resolve the requested path against cwd, then stat it. Never trusts exit code alone. */
export async function verifyArtifacts(
  requests: readonly ArtifactRequest[],
  cwd: string,
  statFn: StatFn,
): Promise<ArtifactVerification> {
  const artifacts: ArtifactEntry[] = []
  for (const request of requests) {
    const absolutePath = isAbsolute(request.requestedPath) ? request.requestedPath : resolve(cwd, request.requestedPath)
    const mediaType = mediaTypeForPath(absolutePath)
    if (request.pending) {
      artifacts.push({
        requestedPath: request.requestedPath,
        absolutePath,
        kind: request.kind,
        ...(mediaType ? { mediaType } : {}),
        exists: false,
        status: 'pending',
      })
      continue
    }
    let exists = false
    let sizeBytes: number | undefined
    try {
      const stat = await statFn(absolutePath)
      exists = stat.isFile()
      if (exists) sizeBytes = stat.size
    } catch {
      exists = false
    }
    artifacts.push({
      requestedPath: request.requestedPath,
      absolutePath,
      kind: request.kind,
      ...(mediaType ? { mediaType } : {}),
      exists,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      status: exists ? 'verified' : 'missing',
    })
  }
  const verifiedCount = artifacts.filter((entry) => entry.status === 'verified').length
  const missingCount = artifacts.filter((entry) => entry.status === 'missing').length
  const pendingCount = artifacts.filter((entry) => entry.status === 'pending').length
  const unverifiedCount = artifacts.filter((entry) => entry.status === 'unverified').length
  return {
    artifacts,
    verified: missingCount === 0 && unverifiedCount === 0 && pendingCount === 0 && verifiedCount === artifacts.length && artifacts.length > 0,
    verifiedCount,
    missingCount,
    pendingCount,
    unverifiedCount,
  }
}

/** Pull candidate artifact paths out of an argv command. */
export function artifactRequestsFromArgs(args: readonly string[]): ArtifactRequest[] {
  const requests: ArtifactRequest[] = []
  const [command, ...rest] = args
  if (!command) return requests
  if (command === 'screenshot' || command === 'pdf') {
    const target = rest.find((token) => !token.startsWith('-'))
    if (target) requests.push({ requestedPath: target, kind: command === 'pdf' ? 'pdf' : 'image' })
    return requests
  }
  if (command === 'download') {
    const target = valueOfFlag(rest, '--path') ?? rest.find((token) => !token.startsWith('-'))
    if (target) requests.push({ requestedPath: target, kind: 'file' })
    return requests
  }
  if (command === 'wait') {
    const target = valueOfFlag(rest, '--download')
    if (target) requests.push({ requestedPath: target, kind: 'file' })
    return requests
  }
  if (command === 'record') {
    if (rest[0] === 'start' || rest[0] === 'restart') {
      const target = valueOfFlag(rest, '--path') ?? rest.find((token) => token.endsWith('.webm') || token.endsWith('.mp4'))
      if (target) requests.push({ requestedPath: target, kind: 'video', pending: true })
    }
    return requests
  }
  if (command === 'har') {
    const target = valueOfFlag(rest, '--path') ?? rest.find((token) => token.endsWith('.har'))
    if (target) requests.push({ requestedPath: target, kind: 'har' })
    return requests
  }
  if (command === 'trace') {
    const target = valueOfFlag(rest, '--path') ?? rest.find((token) => token.endsWith('.zip'))
    if (target) requests.push({ requestedPath: target, kind: 'trace' })
  }
  return requests
}

function valueOfFlag(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === flag) return args[index + 1]
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}
