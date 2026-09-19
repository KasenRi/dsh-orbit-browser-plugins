/**
 * Orbit browser half: the compact `/orbit`-style model control beside the
 * native composer model seat.
 *
 * - Commander/Watchdog read and write the host `orbit` settings namespace.
 * - Executor reads and writes the SAME per-session ModelDirectory the native
 *   seat uses (`ctx.modelDirectories`), so one selection state backs both.
 * - The slot entry registers as the final item in `conversation.input.right`,
 *   so native/third-party right-side controls stay to its left while the
 *   native `conversation.input.model` seat remains immediately to its right.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OrbitModelSelect } from './OrbitModelSelect.tsx'
import { NS, en, zh } from './locales.ts'
import { routeFromSettingsValue, type OrbitModelInjected, type OrbitRouteValue, type OrbitSettingsState } from './model-options.ts'

/** The host settings namespace Orbit registers for its own two roles. */
export const ORBIT_SETTINGS_NS = 'orbit'

/**
 * Keep Orbit as the final list entry in `conversation.input.right`.
 * DSH renders the whole right list before the named model seat, so this gives
 * the stable local order: other right-side controls → Orbit → model selector.
 */
export const ORBIT_INPUT_RIGHT_PRIORITY = Number.MAX_SAFE_INTEGER
export const ORBIT_INPUT_RIGHT_ORDER = Number.MAX_SAFE_INTEGER

/** Required client services: slots, the shared model directory, Remote (settings namespace), and locale. */
export const inject = ['slots', 'modelDirectories', 'remote', 'remote.settings', 'locale']

/**
 * Mount the Orbit model control over `ctx.modelDirectories` and the `orbit`
 * settings namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-orbit: model control dictionaries')

  const settings = createSnapshotStore<OrbitSettingsState>({ status: 'loading' })

  const adoptView = (view: SettingsNamespaceView): void => {
    const value = view.value as { commander?: unknown; watchdog?: unknown } | null
    settings.set({
      status: 'ready',
      commander: routeFromSettingsValue(value?.commander),
      watchdog: routeFromSettingsValue(value?.watchdog),
      revision: view.revision,
    })
  }

  const reloadSettings = (): void => {
    void (async () => {
      settings.update((draft) => {
        draft.status = 'loading'
      })
      try {
        const response = await ctx.remote.settings.describe()
        if (!response.ok) {
          settings.update((draft) => {
            draft.status = 'error'
            draft.error = response.error.message
          })
          return
        }
        const view = response.value.namespaces.find((entry) => entry.ns === ORBIT_SETTINGS_NS)
        if (view === undefined) {
          settings.update((draft) => {
            draft.status = 'error'
            draft.error = `settings namespace "${ORBIT_SETTINGS_NS}" is not registered`
          })
          return
        }
        adoptView(view)
      } catch (error) {
        settings.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
    })()
  }

  ctx.effect(() => {
    reloadSettings()
    return ctx.remote.$on('settings/document-updated', () => {
      reloadSettings()
    })
  }, 'dsh-orbit: settings mirror')

  const writeRole = async (role: 'commander' | 'watchdog', route: OrbitRouteValue): Promise<boolean> => {
    const snapshot = settings.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.revision === undefined) return false
    try {
      const response = await ctx.remote.settings.update(
        ORBIT_SETTINGS_NS,
        {
          [role]: {
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort ?? '',
          },
        },
        snapshot.revision,
      )
      if (!response.ok) {
        settings.update((draft) => {
          draft.error = response.error.message
        })
        // A refused write means the server value is the truth again.
        reloadSettings()
        return false
      }
      adoptView(response.value)
      return true
    } catch (error) {
      settings.update((draft) => {
        draft.error = error instanceof Error ? error.message : String(error)
      })
      reloadSettings()
      return false
    }
  }

  ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    const injected = (sessionId: SessionId): OrbitModelInjected => {
      const directory = models.directoryFor(sessionId)
      const available = sessions.subagentAddress(sessionId) === undefined
      return {
        available,
        directory: directory.store,
        settings,
        loadModels: () => {
          if (available) directory.load().catch(() => { /* surfaced on the store */ })
        },
        selectModel: (selection: ModelSelection) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
        writeRole,
        setOrbitEnabled: async (enabled) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return false
          try {
            const result = await session.command(`/orbit-toggle ${enabled ? 'on' : 'off'}`)
            return result.ok && result.value.matched
          } catch {
            return false
          }
        },
        reloadSettings,
      }
    }
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'orbit-model',
      priority: ORBIT_INPUT_RIGHT_PRIORITY,
      order: ORBIT_INPUT_RIGHT_ORDER,
      locale: NS,
      inject: injected,
    }, OrbitModelSelect))
  })
}
