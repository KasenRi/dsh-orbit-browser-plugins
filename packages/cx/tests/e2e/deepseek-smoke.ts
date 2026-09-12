/**
 * Real DeepSeek CX smoke.
 *
 * Runs the full CX chain on a real Cordis Context with the official
 * `deepseek-official` route (real credentials from `~/.dsh/.credentials.yaml`),
 * real Commander/Executor children, real tools, and the real state machine.
 * Intentionally tiny: one file, one verification command.
 *
 * Usage: node packages/cx/tests/e2e/deepseek-smoke.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LlmPlugin from '@deepseek-ai/dsh-llm'
import SessionPlugin, { SessionId } from '@deepseek-ai/dsh-session'
import PersistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import SubagentPlugin from '@deepseek-ai/dsh-subagent'
import * as SpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as DeepseekPlugin from '@deepseek-ai/dsh-llm-deepseek'
import * as CxPlugin from '../../src/index.ts'

const execFileAsync = promisify(execFile)
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }

function textTool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, string>, cwd: string) => Promise<Record<string, unknown>>) {
  return defineTool({
    name,
    description,
    parameters: parameters as never,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
      return (await run(args as unknown as Record<string, string>, cwd)) as never
    },
  })
}

const readTool = textTool('read', 'Read a UTF-8 file relative to the working directory.', { path: { type: 'string', required: true } }, async (args, cwd) => {
  try {
    return { content: readFileSync(join(cwd, args.path ?? ''), 'utf8') }
  } catch (error) {
    return { error: String(error) }
  }
})

const writeTool = textTool(
  'write',
  'Write a UTF-8 file relative to the working directory.',
  { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
  async (args, cwd) => {
    writeFileSync(join(cwd, args.path ?? ''), args.content ?? '', 'utf8')
    return { written: args.path }
  },
)

const bashTool = textTool('bash', 'Run a shell command in the working directory.', { command: { type: 'string', required: true } }, async (args, cwd) => {
  try {
    const result = await execFileAsync('/bin/sh', ['-c', args.command ?? ''], { cwd, timeout: 20_000 })
    return { stdout: result.stdout, stderr: result.stderr, exit_code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exit_code: typeof failure.code === 'number' ? failure.code : 1 }
  }
})

async function main(): Promise<void> {
  const root = new Context()
  const storage = mkdtempSync(join(tmpdir(), 'dsh-cx-deepseek-store-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-cx-deepseek-project-'))
  writeFileSync(join(projectDir, 'hello.txt'), 'OLD\n', 'utf8')

  for (const [plugin, config] of [
    [LlmPlugin, {}],
    [CredentialsLocal, {}],
    [DeepseekPlugin, {}],
    [SessionPlugin, {}],
    [PersistencePlugin, { root: storage }],
    [SessionProjectionPlugin, {}],
    [SystemPromptPlugin, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'You are a coding agent.' }],
    [ToolsPlugin, { mode: 'native' }],
    [AgentPlugin, {}],
    [SubagentPlugin, {}],
    [SpawnPlugin, { providerName: 'spawn' }],
    [AgentLoopPlugin, { agents: [] }],
  ] as const) {
    await root.plugin(plugin as never, config as never)
  }

  root.tools.register(readTool)
  root.tools.register(writeTool)
  root.tools.register(bashTool)

  await root.plugin(CxPlugin as never, {
    routes: { commander: ROUTE, executor: ROUTE, watchdog: ROUTE },
    browserTools: ['agent_browser'],
    commanderReadOnlyTools: ['read'],
    watchdogTools: ['read'],
    executorTools: ['read', 'write', 'bash'],
    registerTool: true,
    registerGuards: true,
  } as never)

  const parent = await root.agents.create({
    sessionId: SessionId('deepseek-smoke-parent'),
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    meta: { cwd: projectDir },
  })

  const result = await root.agents.withInitiator(parent.agent, () =>
    root.cx.run(
      {
        goal: '把 hello.txt 的内容改为 HELLO_WORLD，并用 bash 运行 cat hello.txt 验证输出包含 HELLO_WORLD',
        approved_loop_count: 3,
        user_hard_constraints: ['只允许修改 hello.txt'],
      },
      projectDir,
      new AbortController().signal,
    ),
  )

  const finalContent = readFileSync(join(projectDir, 'hello.txt'), 'utf8')
  const ok = result.phase === 'SUCCESS' && finalContent.includes('HELLO_WORLD')
  console.log(
    JSON.stringify(
      {
        ok,
        phase: result.phase,
        status: result.status,
        loop: result.data?.['loop'],
        plan: result.data?.['plan'],
        commander: result.data?.['commander'],
        last_error: result.data?.['last_error'],
        hello_txt: finalContent,
      },
      null,
      2,
    ),
  )

  await parent.dispose()
  await root.fiber.dispose()
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('DEEPSEEK_SMOKE_FAILED:', error)
  process.exit(1)
})
