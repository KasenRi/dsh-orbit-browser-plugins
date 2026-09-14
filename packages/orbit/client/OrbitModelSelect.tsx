/**
 * OrbitModelSelect: the compact Orbit model control registered as a list entry
 * before the native composer model seat.
 *
 * Root: Commander / Executor / Watchdog current values. Commander and Watchdog
 * pick from the shared catalog and persist into the `orbit` settings
 * namespace; the Executor picks through the SAME per-session ModelDirectory the
 * native seat uses, so the two controls are one state.
 */

import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, useAnchoredMaxHeight, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  effortChoicesOf,
  effortLabelOf,
  modelOf,
  routeForModel,
  routeLabelOf,
  selectionForModel,
  type OrbitModelInjected,
  type OrbitRouteValue,
  type OrbitRoleName,
} from './model-options.ts'
import css from './OrbitModelSelect.module.css'

export interface OrbitModelSelectProps extends OrbitModelInjected {
  t: TranslateNS<'orbit-model'>
}

type Pane =
  | { kind: 'root' }
  | { kind: 'models'; role: OrbitRoleName }
  | { kind: 'efforts'; role: OrbitRoleName; provider: string; modelId: string; effort: string | undefined }

const CHEVRON = '\u203A'
const CARET = '\u25BE'
const BACK = '\u2039'

/** Design cap for the panel; the anchored clamp only ever lowers it. */
const PANEL_MAX_HEIGHT = 420
/**
 * Hidden but laid-out first paint: the panel must be measurable before the
 * anchored position is known, otherwise it would be placed with height 0 and
 * grow downward off the trigger.
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the Orbit model control.
 * @param props - injected directory/settings faces plus the locale seat.
 * @returns the trigger and, while open, the panel.
 */
export function OrbitModelSelect({ t, available, directory, settings, loadModels, selectModel, writeRole, reloadSettings }: OrbitModelSelectProps) {
  const dir = useSyncExternalStore(
    (listener) => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const config = useSyncExternalStore(
    (listener) => settings.subscribe(listener),
    () => settings.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>({ kind: 'root' })
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, side: 'top', gap: 8, margin: 12 })
  // Bottom-anchored fit: after placement the panel's bottom edge sits at the
  // trigger top, so this clamps the design cap to the space above it.
  const maxHeight = useAnchoredMaxHeight(panelRef, PANEL_MAX_HEIGHT, position)
  useDismissOnOutsidePointer(triggerRef, open, setOpen, panelRef)

  useEffect(() => {
    if (open) loadModels()
  }, [open, loadModels])

  useEffect(() => {
    if (!open) setPane({ kind: 'root' })
  }, [open])

  if (!available) return null

  const commanderRoute = config.commander
  const commanderModel = modelOf(dir, commanderRoute)
  const commanderLabel = commanderRoute === undefined
    ? t('triggerFallback')
    : routeLabelOf(dir, commanderRoute) ?? commanderRoute.model
  const commanderEffort = effortLabelOf(commanderModel, commanderRoute?.reasoningEffort)

  const executorRoute: OrbitRouteValue | undefined = dir.current === null
    ? undefined
    : {
      provider: dir.current.provider,
      model: dir.current.model,
      ...(dir.current.reasoningEffort === undefined ? {} : { reasoningEffort: dir.current.reasoningEffort }),
    }
  const executorModel = modelOf(dir, executorRoute)
  const executorLabel = executorRoute === undefined ? undefined : routeLabelOf(dir, executorRoute) ?? executorRoute.model
  const executorEffort = effortLabelOf(executorModel, executorRoute?.reasoningEffort)

  const watchdogRoute = config.watchdog
  const watchdogModel = modelOf(dir, watchdogRoute)
  const watchdogLabel = watchdogRoute === undefined ? undefined : routeLabelOf(dir, watchdogRoute) ?? watchdogRoute.model
  const watchdogEffort = effortLabelOf(watchdogModel, watchdogRoute?.reasoningEffort)

  const commitRole = async (role: 'commander' | 'watchdog', route: OrbitRouteValue): Promise<void> => {
    setBusy(true)
    const ok = await writeRole(role, route)
    setBusy(false)
    if (ok) setOpen(false)
  }

  const commitExecutor = async (selection: ModelSelection): Promise<void> => {
    setBusy(true)
    const ok = await selectModel(selection)
    setBusy(false)
    if (ok) setOpen(false)
  }

  const currentRouteOf = (role: OrbitRoleName): OrbitRouteValue | undefined =>
    role === 'commander' ? config.commander : role === 'watchdog' ? config.watchdog : executorRoute

  const modelRow = (role: OrbitRoleName, provider: string, providerName: string, model: (typeof dir.groups)[number]['models'][number]): ReactNode => {
    const current = currentRouteOf(role)
    const active = current?.provider === provider && current.model === model.id
    const reasoning = model.reasoning
    return (
      <button
        key={`${provider}/${model.id}`}
        type="button"
        role="menuitem"
        className={css.row}
        disabled={busy}
        onClick={() => {
          if (reasoning !== undefined && reasoning.efforts.length > 0) {
            const effort = active
              ? current?.reasoningEffort ?? reasoning.defaultEffort
              : reasoning.defaultEffort
            setPane({ kind: 'efforts', role, provider, modelId: model.id, effort })
            return
          }
          if (role === 'executor') {
            void commitExecutor(selectionForModel(dir, provider, model))
            return
          }
          void commitRole(role, routeForModel(provider, model))
        }}
      >
        <span className={css.rowLabel}>
          {model.name}
          <span className={css.rowDetail}> {providerName}</span>
        </span>
        {active ? <span className={css.check}>{'\u2713'}</span> : null}
      </button>
    )
  }

  const effortRow = (role: OrbitRoleName, provider: string, modelId: string, id: string, label: string, effort: string | undefined, currentEffort: string | undefined): ReactNode => {
    const healthy = pane.kind === 'efforts' ? pane.effort : currentEffort
    const active = id === 'provider-default'
      ? healthy === undefined
      : healthy === effort
    return (
      <button
        key={id}
        type="button"
        role="menuitem"
        className={css.row}
        disabled={busy}
        onClick={() => {
          if (role === 'executor') {
            void commitExecutor({ provider, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
            return
          }
          void commitRole(role, { provider, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
        }}
      >
        <span className={css.rowLabel}>{label}</span>
        {active ? <span className={css.check}>{'\u2713'}</span> : null}
      </button>
    )
  }

  const settingsError = config.error
  const modelError = dir.status === 'error' ? dir.error ?? t('loadFailed') : undefined

  return (
    <>
      <span ref={triggerRef} style={{ display: 'inline-flex' }}>
        <Button
          variant="ghost"
          size="sm"
          title={t('tooltip')}
          disabled={busy}
          onClick={() => {
            setOpen((value) => !value)
          }}
        >
          {commanderLabel}
          {commanderEffort === undefined ? null : (
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{` ${commanderEffort}`}</span>
          )}
          <span className={css.chevron}>{CARET}</span>
        </Button>
      </span>
      {open
        ? createPortal(
          <div
            ref={panelRef}
            className={css.panel}
            style={{ ...(position ?? MEASURE_STYLE), maxHeight }}
            role="menu"
          >
            {pane.kind !== 'root' ? (
              <button
                type="button"
                className={css.back}
                onClick={() => {
                  setPane({ kind: 'root' })
                }}
              >
                {`${BACK} ${t('back')}`}
              </button>
            ) : (
              <div className={css.title}>{t('title')}</div>
            )}

            {settingsError === undefined ? null : (
              <div className={css.error}>
                <span>{`${t('settingsFailed')}: ${settingsError}`}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    reloadSettings()
                  }}
                >
                  {t('retry')}
                </Button>
              </div>
            )}

            {modelError === undefined ? null : (
              <div className={css.error}>
                <span>{modelError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    loadModels()
                  }}
                >
                  {t('retry')}
                </Button>
              </div>
            )}

            {pane.kind === 'root' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'models', role: 'commander' })
                  }}
                >
                  <span className={css.rowLabel}>{t('commander')}</span>
                  <span className={css.rowValue}>
                    {commanderLabel}
                    {commanderEffort === undefined ? '' : ` · ${commanderEffort}`}
                  </span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'models', role: 'executor' })
                  }}
                >
                  <span className={css.rowLabel}>{t('executor')}</span>
                  <span className={css.rowValue}>
                    {executorLabel ?? t('triggerFallback')}
                    {executorEffort === undefined ? '' : ` · ${executorEffort}`}
                  </span>
                  <span className={css.rowDetail}>{t('followsSession')}</span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'models', role: 'watchdog' })
                  }}
                >
                  <span className={css.rowLabel}>{t('watchdog')}</span>
                  <span className={css.rowValue}>
                    {watchdogLabel ?? t('triggerFallback')}
                    {watchdogEffort === undefined ? '' : ` · ${watchdogEffort}`}
                  </span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
              </>
            ) : null}

            {pane.kind === 'models'
              ? (
                <>
                  <div className={css.group}>{`${t(pane.role)} · ${t('models')}`}</div>
                  {dir.groups.map((group) => (
                    <Fragment key={group.id}>
                      <div className={css.group}>{group.name}</div>
                      {group.models.map((model) => modelRow(pane.role, group.id, group.name, model))}
                    </Fragment>
                  ))}
                  {dir.failures.map((failure) => (
                    <div key={failure.id} className={css.error}>
                      <span>{`${failure.name}: ${failure.message}`}</span>
                    </div>
                  ))}
                </>
              )
              : null}

            {pane.kind === 'efforts'
              ? (
                <>
                  <div className={css.group}>{`${t(pane.role)} · ${t('effort')}`}</div>
                  {effortChoicesOf(
                    (() => {
                      for (const group of dir.groups) {
                        if (group.id !== pane.provider) continue
                        for (const model of group.models) if (model.id === pane.modelId) return model
                      }
                      return undefined
                    })(),
                    t('providerDefault'),
                  ).map((choice) =>
                    effortRow(pane.role, pane.provider, pane.modelId, choice.id, choice.label, choice.effort, pane.effort))}
                </>
              )
              : null}

            <div className={css.separator} />
            <div className={css.hint}>{t('nextRunOnly')}</div>
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
