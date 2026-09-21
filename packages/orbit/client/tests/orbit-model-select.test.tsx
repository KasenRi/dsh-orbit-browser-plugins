// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { OrbitModelSelect } from '../OrbitModelSelect.tsx'
import { zh } from '../locales.ts'
import type { OrbitRouteValue, OrbitRuntimeState, OrbitSessionState, OrbitSettingsState } from '../model-options.ts'
import { lastAnchoredMaxHeight, lastAnchoredPosition } from './helpers/primitives-stub.tsx'

const t: ComponentProps<typeof OrbitModelSelect>['t'] = (key) => (zh as Record<string, string>)[key] ?? key

const reasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'effort-b',
}

function directoryState(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' },
    routable: true,
    groups: [
      {
        id: 'provider-a',
        name: 'Provider A',
        models: [
          { id: 'model-a', name: 'Model A', reasoning },
          { id: 'model-b', name: 'Model B', reasoning },
          { id: 'plain-model', name: 'Plain Model' },
        ],
      },
    ],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

function settingsState(overrides: Partial<OrbitSettingsState> = {}): OrbitSettingsState {
  return {
    status: 'ready',
    commander: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' },
    watchdog: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' },
    moa: { enabled: false, candidateCount: 3, peerCritique: false, maxMoaSteps: 2, candidates: [] },
    revision: 3,
    ...overrides,
  }
}

interface Harness {
  directory: SnapshotStore<ModelDirectoryState>
  settings: SnapshotStore<OrbitSettingsState>
  projection: SnapshotStore<OrbitSessionState | undefined>
  runtimeProjection: SnapshotStore<OrbitRuntimeState | null>
  selectModel: Mock<(selection: ModelSelection) => Promise<boolean>>
  writeRole: Mock<(role: Exclude<import('../model-options.ts').OrbitRoleName, 'executor'>, route: OrbitRouteValue) => Promise<boolean>>
  writeMoaPolicy: Mock<(patch: Partial<Pick<import('../model-options.ts').OrbitMoaSettingsValue, 'enabled' | 'candidateCount' | 'peerCritique' | 'maxMoaSteps'>>) => Promise<boolean>>
  setOrbitEnabled: Mock<(enabled: boolean) => Promise<boolean>>
  loadModels: Mock<() => void>
}

function harness(
  directoryInit: ModelDirectoryState = directoryState(),
  settingsInit: OrbitSettingsState = settingsState(),
  enabledInit?: boolean,
  runtimeInit: OrbitRuntimeState | null = null,
): Harness {
  const directory = createSnapshotStore<ModelDirectoryState>(directoryInit)
  const settings = createSnapshotStore<OrbitSettingsState>(settingsInit)
  const projection = createSnapshotStore<OrbitSessionState | undefined>(
    enabledInit === undefined ? undefined : { enabled: enabledInit },
  )
  const runtimeProjection = createSnapshotStore<OrbitRuntimeState | null>(runtimeInit)
  const selectModel = vi.fn(async (selection: ModelSelection) => {
    // The real directory commits through `session.selectModel` and replays the
    // durable projection: mirror that by updating the SAME store.
    directory.set(directoryState({ current: selection }))
    return true
  })
  const writeRole = vi.fn(async (_role: Exclude<import('../model-options.ts').OrbitRoleName, 'executor'>, _route: OrbitRouteValue) => true)
  const writeMoaPolicy = vi.fn(async (patch: Partial<Pick<import('../model-options.ts').OrbitMoaSettingsValue, 'enabled' | 'candidateCount' | 'peerCritique' | 'maxMoaSteps'>>) => {
    const current = settings.getSnapshot()
    settings.set({ ...current, moa: { ...current.moa, ...patch } })
    return true
  })
  const setOrbitEnabled = vi.fn(async (enabled: boolean) => {
    // The real command logs a `command/run` record the host projection folds;
    // mirror that by updating the same store the control reads.
    projection.set({ enabled })
    return true
  })
  return { directory, settings, projection, runtimeProjection, selectModel, writeRole, writeMoaPolicy, setOrbitEnabled, loadModels: vi.fn() }
}

/** The session slot's projection hook, bound to one harness's store. */
function useTestProjection(
  sessionStore: SnapshotStore<OrbitSessionState | undefined>,
  runtimeStore: SnapshotStore<OrbitRuntimeState | null>,
): UseProjection {
  return ((key: string) => useSyncExternalStore(
    (listener) => key === 'orbitRuntime' ? runtimeStore.subscribe(listener) : sessionStore.subscribe(listener),
    () => key === 'orbitRuntime' ? runtimeStore.getSnapshot() : sessionStore.getSnapshot(),
  )) as UseProjection
}

function renderControl(parts: Harness) {
  function HarnessControl() {
    const useProjection = useTestProjection(parts.projection, parts.runtimeProjection)
    return (
      <OrbitModelSelect
        available
        directory={parts.directory}
        settings={parts.settings}
        loadModels={parts.loadModels}
        selectModel={parts.selectModel}
        writeRole={parts.writeRole}
        writeMoaPolicy={parts.writeMoaPolicy}
        setOrbitEnabled={parts.setOrbitEnabled}
        reloadSettings={vi.fn()}
        useProjection={useProjection}
        t={t}
      />
    )
  }
  return render(<HarnessControl />)
}

afterEach(cleanup)

const ROLE_ROWS = [
  ['指挥官', '指挥官模型', 'Model B', 'High'],
  ['执行员', '执行员模型', 'Model A', 'Low'],
  ['监控模型', '监控模型', 'Model A', 'Low'],
] as const

const ROLE_MODEL_LABELS: Record<string, string> = {
  指挥官: '指挥官模型',
  执行员: '执行员模型',
  监控模型: '监控模型',
}

/** Click the Orbit trigger (assumes the panel is closed). */
function openRoot(): void {
  fireEvent.click(screen.getByTitle('Orbit 模型配置'))
}

/** Open one role's configuration page from the root menu. */
function openRole(name: string): void {
  openRoot()
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(name) }))
}

function openMoa(): void {
  openRoot()
  fireEvent.click(screen.getByRole('menuitem', { name: 'MoA 多候选模式' }))
}

/** Open one role's model list from its role page. */
function openRoleModels(name: string): void {
  openRole(name)
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${ROLE_MODEL_LABELS[name] ?? '模型'}`) }))
}

/** Open one role's effort list from its role page. */
function openRoleEfforts(name: string): void {
  openRole(name)
  fireEvent.click(screen.getByRole('menuitem', { name: /^推理等级/ }))
}

describe('Orbit panel placement', () => {
  it('anchors the panel above the trigger and fits it to the viewport', () => {
    const parts = harness()
    renderControl(parts)
    expect(lastAnchoredPosition.side).toBe('top')
    expect(lastAnchoredPosition.gap).toBeGreaterThan(0)
    expect(lastAnchoredMaxHeight.cap).toBeGreaterThan(0)
  })
})

describe('Orbit role pages offer model and reasoning effort as separate entries', () => {
  it.each(ROLE_ROWS)('%s shows the model row and a single navigation title', (role, modelLabel, modelName, effortName) => {
    renderControl(harness())
    openRole(role)

    const modelRow = screen.getByRole('menuitem', { name: new RegExp(`^${modelLabel}`) })
    expect(modelRow.textContent).toContain(modelName)
    const effortRow = screen.getByRole('menuitem', { name: /^推理等级/ })
    expect(effortRow.textContent).toContain(effortName)

    const headings = screen.queryAllByText(role).filter((element) => element.closest('[role="menuitem"]') === null)
    expect(headings).toHaveLength(1)
  })

  it('shows Provider default for a role without a stored effort', () => {
    renderControl(harness(
      directoryState(),
      settingsState({ commander: { provider: 'provider-a', model: 'model-b' } }),
    ))
    openRole('指挥官')
    const effortRow = screen.getByRole('menuitem', { name: /^推理等级/ })
    expect(effortRow.textContent).toContain('提供方默认')
  })
})

describe('Orbit effort ladder follows the catalog metadata', () => {
  it('lists exactly the explicit efforts plus Provider default', () => {
    renderControl(harness())
    openRoleEfforts('指挥官')

    expect(screen.getByRole('menuitem', { name: /^提供方默认/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Low/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^High/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^Medium/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^XHigh/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Max/ })).toBeNull()
  })

  it('offers only Provider default when the model declares no reasoning metadata', () => {
    const parts = harness(
      directoryState(),
      settingsState({ commander: { provider: 'provider-a', model: 'plain-model' } }),
    )
    renderControl(parts)
    openRoleEfforts('指挥官')

    expect(screen.getByRole('menuitem', { name: /^提供方默认/ })).toBeTruthy()
    for (const label of [/^Low/, /^Medium/, /^High/, /^XHigh/, /^Max/]) expect(screen.queryByRole('menuitem', { name: label })).toBeNull()
  })
})

describe('Orbit effort-only changes stay on their own path', () => {
  it('persists a commander effort change without touching the session model', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleEfforts('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'low',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })

  it('submits an executor effort change through the shared directory', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleEfforts('执行员')

    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.selectModel).toHaveBeenCalledWith({
        provider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high',
      })
    })
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    })
    expect(parts.writeRole).not.toHaveBeenCalled()
  })

  it('persists a watchdog effort change without touching the session model', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleEfforts('监控模型')

    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('watchdog', {
        provider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })

  it('maps Provider default to an absent reasoningEffort on the wire', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleEfforts('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /^提供方默认/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledTimes(1)
    })
    const [, route] = parts.writeRole.mock.calls[0] as [string, OrbitRouteValue]
    expect(route).toEqual({ provider: 'provider-a', model: 'model-b' })
    expect('reasoningEffort' in route).toBe(false)
  })
})

describe('Orbit model picks never inherit a stale effort', () => {
  it('switching models waits for explicit reasoning selection', async () => {
    const parts = harness(
      directoryState(),
      settingsState({ commander: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' } }),
    )
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /Model B/ }))
    expect(parts.writeRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'high',
      })
    })
  })

  it('switching to a model without metadata leaves the effort unset', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /Plain Model/ }))
    expect(parts.writeRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /^提供方默认/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledTimes(1)
    })
    const [, route] = parts.writeRole.mock.calls[0] as [string, OrbitRouteValue]
    expect(route).toEqual({ provider: 'provider-a', model: 'plain-model' })
    expect('reasoningEffort' in route).toBe(false)
  })

  it('persists a commander model pick through settings and never the session model', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /Model A/ }))
    expect(parts.writeRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low',
    })
  })

  it('persists a watchdog model pick through the same settings path', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('监控模型')

    fireEvent.click(screen.getByRole('menuitem', { name: /Model B/ }))
    expect(parts.writeRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('watchdog', {
        provider: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'high',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })
})

describe('Orbit executor shares the session model directory', () => {
  it('renders the current session model and submits an executor pick through the same store', async () => {
    const parts = harness()
    renderControl(parts)
    openRoot()

    // The Orbit entry sits before the native seat; its trigger names the Commander.
    const executorRow = screen.getByRole('menuitem', { name: /执行员/ })
    expect(executorRow.textContent).toContain('Model A')
    expect(executorRow.textContent).toContain('跟随当前会话模型')
    fireEvent.click(executorRow)

    fireEvent.click(screen.getByRole('menuitem', { name: /^执行员模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model B/ }))
    expect(parts.selectModel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.selectModel).toHaveBeenCalledWith({
        provider: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'high',
      })
    })
    // One state: the directory now holds the executor pick.
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'provider-a',
      model: 'model-b',
      reasoningEffort: 'high',
    })
  })

  it('shows a native-executor change immediately from the shared store', () => {
    const parts = harness()
    renderControl(parts)
    // The native seat switches the session model behind the panel.
    parts.directory.set(directoryState({ current: { provider: 'provider-a', model: 'model-b' } }))
    fireEvent.click(screen.getByTitle('Orbit 模型配置'))
    expect(screen.getByRole('menuitem', { name: /执行员/ }).textContent).toContain('Model B')
  })
})

describe('Orbit MoA configuration', () => {
  it('keeps the root menu compact even while a MoA run is active', () => {
    const parts = harness(
      directoryState(),
      settingsState({ moa: { enabled: true, candidateCount: 3, peerCritique: false, maxMoaSteps: 2, candidates: [] } }),
      true,
      {
        runId: 'run-1',
        phase: 'EXECUTE',
        status: 'running',
        loop: { used: 1, max: 5 },
        currentStep: { id: 'P2', attempt: 1, executionMode: 'MOA' },
        moa: {
          phase: 'PROMOTED',
          candidates: [
            { index: 1, provider: 'provider-a', model: 'model-a', ok: true, files: 1, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.001 } },
          ],
          judgeModel: 'provider-a/model-b',
          winningCandidate: 1,
          winnerModel: 'provider-a/model-a',
          totalUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.001 },
        },
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    )
    renderControl(parts)
    openRoot()

    expect(screen.getByRole('menuitem', { name: 'MoA 多候选模式' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: '启用 MoA' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('当前运行')).toBeNull()
    expect(screen.queryByText('PROMOTED')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /候选数量/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Judge 评审模型/ })).toBeNull()
  })

  it('opens MoA details only in the second-level menu', () => {
    const parts = harness(directoryState(), settingsState({
      moa: {
        enabled: true,
        candidateCount: 3,
        peerCritique: false,
        maxMoaSteps: 2,
        candidates: [{ provider: 'provider-a', model: 'model-a' }],
        judge: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' },
      },
    }))
    renderControl(parts)
    openMoa()

    expect(screen.getByText('MoA 多候选模式')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '启用 MoA' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /候选数量/ }).textContent).toContain('3')
    expect(screen.getByRole('menuitem', { name: /每个 Run 最多 MoA 步骤/ }).textContent).toContain('2')
    expect(screen.getByRole('menuitem', { name: /候选模型 1/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /候选模型 2/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /候选模型 3/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /候选模型 4/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Judge 评审模型/ }).textContent).toContain('Model B')
    expect(screen.getByText('更改将会在下一次发送时生效')).toBeTruthy()
  })

  it('uses explicit selectors for candidate count and max MoA steps', async () => {
    const parts = harness(directoryState(), settingsState())
    renderControl(parts)
    openMoa()

    fireEvent.click(screen.getByRole('menuitem', { name: /候选数量/ }))
    expect(screen.getByRole('menuitemradio', { name: /2 个候选/ }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: /3 个候选/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /4 个候选/ }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('menuitemradio', { name: /4 个候选/ }))

    await waitFor(() => expect(parts.writeMoaPolicy).toHaveBeenCalledWith({ candidateCount: 4 }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /候选模型 4/ })).toBeTruthy())

    fireEvent.click(screen.getByRole('menuitem', { name: /每个 Run 最多 MoA 步骤/ }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    const maxChoices = screen.getAllByRole('menuitemradio')
    fireEvent.click(maxChoices[maxChoices.length - 1] as HTMLElement)
    await waitFor(() => expect(parts.writeMoaPolicy).toHaveBeenCalledWith({ maxMoaSteps: 5 }))
  })

  it('persists the peer critique switch without touching the Session model', async () => {
    const parts = harness()
    renderControl(parts)
    openMoa()

    fireEvent.click(screen.getByRole('switch', { name: '候选互评' }))
    await waitFor(() => {
      expect(parts.writeMoaPolicy).toHaveBeenCalledWith({ peerCritique: true })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })

  it('persists a Candidate model and effort through Orbit settings, not the Session model', async () => {
    const parts = harness(directoryState(), settingsState({
      moa: {
        enabled: true,
        candidateCount: 2,
        peerCritique: false,
        maxMoaSteps: 1,
        candidates: [{ provider: 'provider-a', model: 'model-a' }, { provider: 'provider-a', model: 'model-a' }],
        judge: { provider: 'provider-a', model: 'model-b' },
      },
    }))
    renderControl(parts)
    openMoa()
    fireEvent.click(screen.getByRole('menuitem', { name: /候选模型 1/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model B/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('moa-candidate-1', {
        provider: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'high',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })

  it('maps Provider default for the MoA Judge to an absent reasoning effort', async () => {
    const parts = harness(directoryState(), settingsState({
      moa: {
        enabled: true,
        candidateCount: 2,
        peerCritique: false,
        maxMoaSteps: 1,
        candidates: [{ provider: 'provider-a', model: 'model-a' }, { provider: 'provider-a', model: 'model-b' }],
        judge: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'high' },
      },
    }))
    renderControl(parts)
    openMoa()
    fireEvent.click(screen.getByRole('menuitem', { name: /Judge 评审模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^推理等级/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^提供方默认/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('moa-judge', { provider: 'provider-a', model: 'model-b' })
    })
  })
})

describe('Orbit model control failure surfaces', () => {
  it('keeps the trigger readable while the catalog fails and retries in place', () => {
    const parts = harness(directoryState({ status: 'error', error: 'catalog down' }))
    renderControl(parts)

    openRoot()
    expect(screen.getByText('catalog down')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /执行员/ }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(parts.loadModels).toHaveBeenCalled()
  })

  it('hides the control for addressed subagent sessions', () => {
    const parts = harness()
    render(
      <OrbitModelSelect
        available={false}
        directory={parts.directory}
        settings={parts.settings}
        loadModels={parts.loadModels}
        selectModel={parts.selectModel}
        writeRole={parts.writeRole}
        writeMoaPolicy={parts.writeMoaPolicy}
        setOrbitEnabled={parts.setOrbitEnabled}
        reloadSettings={vi.fn()}
        useProjection={useTestProjection(parts.projection, parts.runtimeProjection)}
        t={t}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Orbit per-Session enable toggle', () => {
  it('defaults to OFF and shows Orbit Off on the trigger', () => {
    const parts = harness()
    renderControl(parts)
    const trigger = screen.getByTitle('Orbit 模型配置')
    expect(trigger.textContent).toContain('Orbit Off')
    expect(trigger.textContent).not.toContain('Model B')
  })

  it('shows the Commander model and effort once the Session is enabled', () => {
    const parts = harness(directoryState(), settingsState(), true)
    renderControl(parts)
    const trigger = screen.getByTitle('Orbit 模型配置')
    expect(trigger.textContent).toContain('Model B')
    expect(trigger.textContent).toContain('High')
    expect(trigger.textContent).not.toContain('Orbit Off')
  })

  it('renders the switch in the root menu and turns the Session on', async () => {
    const parts = harness()
    renderControl(parts)
    openRoot()

    const switchControl = screen.getByRole('switch', { name: '本会话 Orbit 开关' })
    expect(switchControl.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(switchControl)

    await waitFor(() => {
      expect(parts.setOrbitEnabled).toHaveBeenCalledWith(true)
    })
    await waitFor(() => {
      expect(screen.getByTitle('Orbit 模型配置').textContent).toContain('Model B')
    })
  })

  it('turns the Session back off from the switch', async () => {
    const parts = harness(directoryState(), settingsState(), true)
    renderControl(parts)
    openRoot()

    fireEvent.click(screen.getByRole('switch', { name: '本会话 Orbit 开关' }))

    await waitFor(() => {
      expect(parts.setOrbitEnabled).toHaveBeenCalledWith(false)
    })
    await waitFor(() => {
      expect(screen.getByTitle('Orbit 模型配置').textContent).toContain('Orbit Off')
    })
  })

  it('restores the stored state on a fresh mount', () => {
    const parts = harness(directoryState(), settingsState(), true)
    renderControl(parts)
    expect(screen.getByTitle('Orbit 模型配置').textContent).toContain('Model B')
  })

  it('keeps Sessions isolated: toggling one control leaves the other unchanged', async () => {
    const a = harness()
    const b = harness()
    renderControl(a)
    renderControl(b)
    const triggers = screen.getAllByTitle('Orbit 模型配置')
    expect(triggers[0]?.textContent).toContain('Orbit Off')
    expect(triggers[1]?.textContent).toContain('Orbit Off')

    fireEvent.click(triggers[0] as HTMLElement)
    // Only the first Session's panel is open, so its switch is the only one.
    fireEvent.click(screen.getByRole('switch', { name: '本会话 Orbit 开关' }))

    await waitFor(() => {
      expect(a.setOrbitEnabled).toHaveBeenCalledWith(true)
      expect(b.setOrbitEnabled).not.toHaveBeenCalled()
    })
    const after = screen.getAllByTitle('Orbit 模型配置')
    expect(after[0]?.textContent).toContain('Model B')
    expect(after[1]?.textContent).toContain('Orbit Off')
  })

  it('still lets role pages be configured while OFF', () => {
    const parts = harness()
    renderControl(parts)
    openRole('指挥官')
    expect(screen.getByRole('menuitem', { name: /^指挥官模型/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^推理等级/ })).toBeTruthy()
  })
})

describe('Orbit menu copy and hierarchy', () => {
  it('keeps the root menu limited to the approved first-level entries', () => {
    renderControl(harness())
    openRoot()

    expect(screen.getByText('启用一键长执行')).toBeTruthy()
    expect(screen.getByText('更改将会在下一次发送时生效')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /指挥官/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /执行员/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /监控模型/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'MoA 多候选模式' })).toBeTruthy()
    expect(screen.queryByText('Orbit 让AI自我审核连续执行')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /候选数量/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Judge 评审模型/ })).toBeNull()
  })

  it('never renders a duplicated watchdog label', () => {
    renderControl(harness())
    openRole('监控模型')
    expect(screen.queryByText('监控模型模型')).toBeNull()
    expect(screen.getByRole('menuitem', { name: /^监控模型/ })).toBeTruthy()
  })
})
