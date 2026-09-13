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

describe('Orbit executor shares the session model directory', () => {
  it('renders the current session model and submits an executor pick through the same store', async () => {
    const parts = harness()
    renderControl(parts)

    // The Orbit entry sits before the native seat; its trigger names the Commander.
    const trigger = screen.getByRole('button', { name: /DeepSeek-V4-Pro/ })
    fireEvent.click(trigger)

    const executorRow = screen.getByRole('menuitem', { name: /执行员/ })
    expect(executorRow.textContent).toContain('DeepSeek-V4-Flash')
    expect(executorRow.textContent).toContain('跟随当前会话模型')
    fireEvent.click(executorRow)

    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))
    // The picked model publishes efforts: choose the explicit effort.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))

    await waitFor(() => {
      expect(parts.selectModel).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
      })
    })
    // One state: the directory now holds the executor pick.
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    })
  })

  it('shows a native-executor change immediately from the shared store', () => {
    const parts = harness()
    renderControl(parts)
    // The native seat switches the session model behind the panel.
    parts.directory.set(directoryState({ current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }))
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Pro/ }))
    expect(screen.getByRole('menuitem', { name: /执行员/ }).textContent).toContain('DeepSeek-V4-Pro')
  })
})

describe('Orbit commander and watchdog stay isolated from the session model', () => {
  it('persists the commander pick into orbit settings without touching the session model', async () => {
    const parts = harness()
    renderControl(parts)

    fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /指挥官/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Flash/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'low',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
    expect(parts.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low',
    })
  })

  it('applies the picked model default effort and never inherits the previous effort', async () => {
    const parts = harness(
      directoryState(),
      settingsState({
        commander: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      }),
    )
    renderControl(parts)

    fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Flash/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /指挥官/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))
    // The effort pane opens on the picked model's default.
    expect(screen.getByRole('menuitem', { name: /High/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /High/ }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('commander', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      })
    })
  })

  it('persists the watchdog pick through the same settings path', async () => {
    const parts = harness()
    renderControl(parts)

    fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /监控模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))

    await waitFor(() => {
      expect(parts.writeRole).toHaveBeenCalledWith('watchdog', {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
      })
    })
    expect(parts.selectModel).not.toHaveBeenCalled()
  })
})

describe('Orbit model control failure surfaces', () => {
  it('keeps the trigger readable while the catalog fails and retries in place', () => {
    const parts = harness(directoryState({ status: 'error', error: 'catalog down' }))
    renderControl(parts)

    fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Pro/ }))
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
