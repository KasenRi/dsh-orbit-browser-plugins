// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ComponentProps } from 'react'
import { OrbitModelSelect } from '../OrbitModelSelect.tsx'
import { zh } from '../locales.ts'
import type { OrbitRouteValue, OrbitSettingsState } from '../model-options.ts'
import { lastAnchoredMaxHeight, lastAnchoredPosition } from './helpers/primitives-stub.tsx'

const t: ComponentProps<typeof OrbitModelSelect>['t'] = (key) => (zh as Record<string, string>)[key] ?? key

const reasoning = {
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ],
  defaultEffort: 'high',
}

function directoryState(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    routable: true,
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
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
    commander: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    watchdog: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    revision: 3,
    ...overrides,
  }
}

interface Harness {
  directory: SnapshotStore<ModelDirectoryState>
  settings: SnapshotStore<OrbitSettingsState>
  selectModel: Mock<(selection: ModelSelection) => Promise<boolean>>
  writeRole: Mock<(role: 'commander' | 'watchdog', route: OrbitRouteValue) => Promise<boolean>>
  loadModels: Mock<() => void>
}

function harness(
  directoryInit: ModelDirectoryState = directoryState(),
  settingsInit: OrbitSettingsState = settingsState(),
): Harness {
  const directory = createSnapshotStore<ModelDirectoryState>(directoryInit)
  const settings = createSnapshotStore<OrbitSettingsState>(settingsInit)
  const selectModel = vi.fn(async (selection: ModelSelection) => {
    // The real directory commits through `session.selectModel` and replays the
    // durable projection: mirror that by updating the SAME store.
    directory.set(directoryState({ current: selection }))
    return true
  })
  const writeRole = vi.fn(async (_role: 'commander' | 'watchdog', _route: OrbitRouteValue) => true)
  return { directory, settings, selectModel, writeRole, loadModels: vi.fn() }
}

function renderControl(parts: Harness) {
  return render(
    <OrbitModelSelect
      available
      directory={parts.directory}
      settings={parts.settings}
      loadModels={parts.loadModels}
      selectModel={parts.selectModel}
      writeRole={parts.writeRole}
      reloadSettings={vi.fn()}
      t={t}
    />,
  )
}

afterEach(cleanup)

const ROLE_ROWS = [
  ['指挥官', 'DeepSeek-V4-Pro', 'High'],
  ['执行员', 'DeepSeek-V4-Flash', 'Low'],
  ['监控模型', 'DeepSeek-V4-Flash', 'Low'],
] as const

/** Click the Orbit trigger (assumes the panel is closed). */
function openRoot(): void {
  fireEvent.click(screen.getByTitle('Orbit 模型配置'))
}

/** Open one role's configuration page from the root menu. */
function openRole(name: string): void {
  openRoot()
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(name) }))
}

/** Open one role's model list from its role page. */
function openRoleModels(name: string): void {
  openRole(name)
  fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
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
  it.each(ROLE_ROWS)('%s shows both rows with its current values', (role, modelName, effortName) => {
    renderControl(harness())
    openRole(role)

    const modelRow = screen.getByRole('menuitem', { name: /^模型/ })
    expect(modelRow.textContent).toContain(modelName)
    const effortRow = screen.getByRole('menuitem', { name: /^推理等级/ })
    expect(effortRow.textContent).toContain(effortName)
  })

  it('shows Provider default for a role without a stored effort', () => {
    renderControl(harness(
      directoryState(),
      settingsState({ commander: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }),
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

  it('falls back to the UI effort ladder when the model declares none', () => {
    const parts = harness(
      directoryState(),
      settingsState({ commander: { provider: 'deepseek-official', model: 'plain-model' } }),
    )
    renderControl(parts)
    openRoleEfforts('指挥官')

    for (const label of [/^提供方默认/, /^Low/, /^Medium/, /^High/, /^XHigh/, /^Max/]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
    }
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
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
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
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
      })
    })
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
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
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
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
    expect(route).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect('reasoningEffort' in route).toBe(false)
  })
})

describe('Orbit model picks never inherit a stale effort', () => {
  it('switching to a model with metadata applies that model default effort', async () => {
    const parts = harness(
      directoryState(),
      settingsState({ commander: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' } }),
    )
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      })
    })
  })

  it('switching to a model without metadata leaves the effort unset', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /Plain Model/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledTimes(1)
    })
    const [, route] = parts.writeRole.mock.calls[0] as [string, OrbitRouteValue]
    expect(route).toEqual({ provider: 'deepseek-official', model: 'plain-model' })
    expect('reasoningEffort' in route).toBe(false)
  })

  it('persists a commander model pick through settings and never the session model', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('指挥官')

    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Flash/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low',
    })
  })

  it('persists a watchdog model pick through the same settings path', async () => {
    const parts = harness()
    renderControl(parts)
    openRoleModels('监控模型')

    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('watchdog', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
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
    expect(executorRow.textContent).toContain('DeepSeek-V4-Flash')
    expect(executorRow.textContent).toContain('跟随当前会话模型')
    fireEvent.click(executorRow)

    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))

    await waitFor(() => {
      expect(parts.selectModel).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      })
    })
    // One state: the directory now holds the executor pick.
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
  })

  it('shows a native-executor change immediately from the shared store', () => {
    const parts = harness()
    renderControl(parts)
    // The native seat switches the session model behind the panel.
    parts.directory.set(directoryState({ current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }))
    fireEvent.click(screen.getByTitle('Orbit 模型配置'))
    expect(screen.getByRole('menuitem', { name: /执行员/ }).textContent).toContain('DeepSeek-V4-Pro')
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
        reloadSettings={vi.fn()}
        t={t}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
