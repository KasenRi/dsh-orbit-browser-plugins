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
import { Button, Switch, useAnchoredMaxHeight, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  effortChoicesOf,
  effortLabelOf,
  modelOf,
  routeForModel,
  routeLabelOf,
  type OrbitModelInjected,
  type OrbitRouteValue,
  type OrbitRoleName,
} from './model-options.ts'
import css from './OrbitModelSelect.module.css'

export interface OrbitModelSelectProps extends OrbitModelInjected {
  t: TranslateNS<'orbit-model'>
  /** Host-computed projection values (session-scoped slot standard props). */
  useProjection: UseProjection
}

type Pane =
  | { kind: 'root' }
  | { kind: 'role'; role: OrbitRoleName }
  | { kind: 'models'; role: OrbitRoleName }
  | { kind: 'efforts'; role: OrbitRoleName; draft?: OrbitRouteValue }

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
export function OrbitModelSelect({ t, available, directory, settings, loadModels, selectModel, writeRole, writeMoaPolicy, setOrbitEnabled, reloadSettings, useProjection }: OrbitModelSelectProps) {
  const dir = useSyncExternalStore(
    (listener) => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const config = useSyncExternalStore(
    (listener) => settings.subscribe(listener),
    () => settings.getSnapshot(),
  )
  // Canonical enable state comes from the Session's own projection; the local
  // value only bridges the click-to-projection round trip (never the source).
  const orbitSession = useProjection('orbitSession')
  const orbitRuntime = useProjection('orbitRuntime')
  const [orbitOverride, setOrbitOverride] = useState<boolean | null>(null)
  const [orbitPending, setOrbitPending] = useState(false)
  const orbitEnabled = orbitOverride ?? orbitSession?.enabled === true
  useEffect(() => {
    if (orbitOverride !== null && orbitSession?.enabled === orbitOverride) setOrbitOverride(null)
  }, [orbitOverride, orbitSession?.enabled])
  const toggleOrbit = async (next: boolean): Promise<void> => {
    setOrbitOverride(next)
    setOrbitPending(true)
    const ok = await setOrbitEnabled(next)
    setOrbitPending(false)
    if (!ok) setOrbitOverride(null)
  }
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>({ kind: 'root' })
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
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

  const usageText = (usage: { total_tokens: number; cost_usd?: number } | undefined): string | undefined => {
    if (!usage) return undefined
    const tokens = `${usage.total_tokens.toLocaleString()} ${t('moaTokens')}`
    return usage.cost_usd === undefined ? tokens : `${tokens} · $${usage.cost_usd.toFixed(4)}`
  }

  const moaRouteOf = (role: OrbitRoleName): OrbitRouteValue | undefined => {
    if (role === 'moa-judge') return config.moa.judge
    if (!role.startsWith('moa-candidate-')) return undefined
    const index = Number(role.slice('moa-candidate-'.length)) - 1
    return Number.isInteger(index) ? config.moa.candidates[index] : undefined
  }

  const commitRole = async (role: Exclude<OrbitRoleName, 'executor'>, route: OrbitRouteValue): Promise<void> => {
    if (submitting.current || config.status !== 'ready') return
    submitting.current = true
    setBusy(true)
    try {
      if (await writeRole(role, route)) setOpen(false)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const commitMoaPolicy = async (patch: Parameters<typeof writeMoaPolicy>[0]): Promise<void> => {
    if (submitting.current || config.status !== 'ready') return
    submitting.current = true
    setBusy(true)
    try {
      await writeMoaPolicy(patch)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const commitExecutor = async (selection: ModelSelection): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      if (await selectModel(selection)) setOpen(false)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const currentRouteOf = (role: OrbitRoleName): OrbitRouteValue | undefined =>
    role === 'commander' ? config.commander : role === 'watchdog' ? config.watchdog : role === 'executor' ? executorRoute : moaRouteOf(role)

  const roleLabelOf = (role: OrbitRoleName): string | undefined => {
    const route = currentRouteOf(role)
    if (role === 'commander') return commanderLabel
    if (role === 'watchdog') return watchdogLabel
    if (role === 'executor') return executorLabel
    return route === undefined ? undefined : routeLabelOf(dir, route) ?? route.model
  }

  const roleTitleOf = (role: OrbitRoleName): string => {
    if (role === 'commander') return t('commander')
    if (role === 'executor') return t('executor')
    if (role === 'watchdog') return t('watchdog')
    if (role === 'moa-judge') return t('moaJudge')
    return `${t('moaCandidate')} ${role.slice('moa-candidate-'.length)}`
  }

  const roleModelLabelOf = (role: OrbitRoleName): string => {
    if (role === 'commander') return t('commanderModel')
    if (role === 'executor') return t('executorModel')
    if (role === 'watchdog') return t('watchdogModel')
    return t('models')
  }

  const roleEffortLabelOf = (role: OrbitRoleName): string | undefined => {
    if (role === 'commander') return commanderEffort
    if (role === 'watchdog') return watchdogEffort
    if (role === 'executor') return executorEffort
    const route = moaRouteOf(role)
    return effortLabelOf(modelOf(dir, route), route?.reasoningEffort)
  }

  const commitEffort = async (role: OrbitRoleName, route: OrbitRouteValue, effort: string | undefined): Promise<void> => {
    const next: OrbitRouteValue = {
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
    if (role === 'executor') {
      await commitExecutor(next)
      return
    }
    await commitRole(role as Exclude<OrbitRoleName, 'executor'>, next)
  }

  const modelRow = (role: OrbitRoleName, provider: string, providerName: string, model: (typeof dir.groups)[number]['models'][number]): ReactNode => {
    const current = currentRouteOf(role)
    const active = current?.provider === provider && current.model === model.id
    return (
      <button
        key={`${provider}/${model.id}`}
        type="button"
        role="menuitem"
        className={css.row}
        disabled={busy}
        onClick={() => {
          setPane({ kind: 'efforts', role, draft: routeForModel(provider, model) })
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

  const effortPaneRoute = pane.kind === 'efforts' ? pane.draft ?? currentRouteOf(pane.role) : undefined
  const effortPaneModel = modelOf(dir, effortPaneRoute)
  const effortPaneChoices = pane.kind === 'efforts' ? effortChoicesOf(effortPaneModel, t('providerDefault')) : []

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
          {orbitEnabled ? commanderLabel : t('orbitOff')}
          {orbitEnabled && commanderEffort !== undefined ? (
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{` ${commanderEffort}`}</span>
          ) : null}
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
            {pane.kind === 'root' ? (
              <div className={css.title}>{t('title')}</div>
            ) : (
              <button
                type="button"
                className={css.back}
                onClick={() => {
                  setPane(pane.kind === 'role' ? { kind: 'root' } : { kind: 'role', role: pane.role })
                }}
              >
                {`${BACK} ${pane.kind === 'role' ? t('back') : roleTitleOf(pane.role)}`}
              </button>
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
                <div className={css.switchRow}>
                  <span className={css.rowLabel}>{t('enableLongRun')}</span>
                  <Switch
                    className={css.switchControl}
                    checked={orbitEnabled}
                    disabled={orbitPending}
                    label={t('orbitSwitchLabel')}
                    onChange={(next) => {
                      void toggleOrbit(next)
                    }}
                  />
                </div>
                <div className={css.separator} />
                {orbitRuntime ? (
                  <>
                    <div className={css.group}>{t('runtime')}</div>
                    <div className={css.row}>
                      <span className={css.rowLabel}>{orbitRuntime.currentStep?.id ?? orbitRuntime.phase}</span>
                      <span className={css.rowValue}>
                        {orbitRuntime.currentStep?.executionMode ?? orbitRuntime.phase}
                        {` · ${orbitRuntime.loop.used}/${orbitRuntime.loop.max}`}
                      </span>
                    </div>
                    {orbitRuntime.moa ? (
                      <>
                        <div className={css.row}>
                          <span className={css.rowLabel}>{t('moaRuntimePhase')}</span>
                          <span className={css.rowValue}>{orbitRuntime.moa.phase}</span>
                        </div>
                        {orbitRuntime.moa.candidates.map((candidate) => (
                          <div key={candidate.index} className={css.row}>
                            <span className={css.rowLabel}>{`${t('moaCandidate')} ${candidate.index}`}</span>
                            <span className={css.rowValue}>
                              {`${candidate.ok ? '✓' : '✗'} ${candidate.provider}/${candidate.model}`}
                              {usageText(candidate.usage) ? ` · ${usageText(candidate.usage)}` : ''}
                            </span>
                          </div>
                        ))}
                        <div className={css.row}>
                          <span className={css.rowLabel}>{t('moaJudge')}</span>
                          <span className={css.rowValue}>
                            {orbitRuntime.moa.winnerModel ?? orbitRuntime.moa.judgeModel ?? t('moaWaiting')}
                          </span>
                        </div>
                        {orbitRuntime.moa.totalUsage ? (
                          <div className={css.row}>
                            <span className={css.rowLabel}>{t('moaTotalUsage')}</span>
                            <span className={css.rowValue}>
                              {usageText(orbitRuntime.moa.totalUsage)}
                              {orbitRuntime.moa.totalUsage.cost_usd === undefined ? ` · ${t('moaCostUnavailable')}` : ''}
                            </span>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    <div className={css.separator} />
                  </>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'role', role: 'commander' })
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
                    setPane({ kind: 'role', role: 'executor' })
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
                    setPane({ kind: 'role', role: 'watchdog' })
                  }}
                >
                  <span className={css.rowLabel}>{t('watchdog')}</span>
                  <span className={css.rowValue}>
                    {watchdogLabel ?? t('triggerFallback')}
                    {watchdogEffort === undefined ? '' : ` · ${watchdogEffort}`}
                  </span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
                <div className={css.separator} />
                <div className={css.switchRow}>
                  <span className={css.rowLabel}>{t('moa')}</span>
                  <Switch
                    className={css.switchControl}
                    checked={config.moa.enabled}
                    disabled={busy}
                    label={t('moaEnable')}
                    onChange={(next) => { void commitMoaPolicy({ enabled: next }) }}
                  />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => { void commitMoaPolicy({ candidateCount: config.moa.candidateCount >= 4 ? 2 : config.moa.candidateCount + 1 }) }}
                >
                  <span className={css.rowLabel}>{t('moaCandidateCount')}</span>
                  <span className={css.rowValue}>{config.moa.candidateCount}</span>
                </button>
                <div className={css.switchRow}>
                  <span className={css.rowLabel}>{t('moaPeerCritique')}</span>
                  <Switch
                    className={css.switchControl}
                    checked={config.moa.peerCritique}
                    disabled={busy}
                    label={t('moaPeerCritique')}
                    onChange={(next) => { void commitMoaPolicy({ peerCritique: next }) }}
                  />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => { void commitMoaPolicy({ maxMoaSteps: config.moa.maxMoaSteps >= 5 ? 1 : config.moa.maxMoaSteps + 1 }) }}
                >
                  <span className={css.rowLabel}>{t('moaMaxSteps')}</span>
                  <span className={css.rowValue}>{config.moa.maxMoaSteps}</span>
                </button>
                {Array.from({ length: config.moa.candidateCount }, (_, offset) => {
                  const role = (`moa-candidate-${offset + 1}`) as OrbitRoleName
                  return (
                    <button
                      key={role}
                      type="button"
                      role="menuitem"
                      className={css.row}
                      disabled={busy}
                      onClick={() => { setPane({ kind: 'role', role }) }}
                    >
                      <span className={css.rowLabel}>{`${t('moaCandidate')} ${offset + 1}`}</span>
                      <span className={css.rowValue}>{roleLabelOf(role) ?? t('triggerFallback')}</span>
                      <span className={css.chevron}>{CHEVRON}</span>
                    </button>
                  )
                })}
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => { setPane({ kind: 'role', role: 'moa-judge' }) }}
                >
                  <span className={css.rowLabel}>{t('moaJudge')}</span>
                  <span className={css.rowValue}>{roleLabelOf('moa-judge') ?? t('triggerFallback')}</span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
              </>
            ) : null}

            {pane.kind === 'role' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'models', role: pane.role })
                  }}
                >
                  <span className={css.rowLabel}>{roleModelLabelOf(pane.role)}</span>
                  <span className={css.rowValue}>{roleLabelOf(pane.role) ?? t('triggerFallback')}</span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={css.row}
                  disabled={busy}
                  onClick={() => {
                    setPane({ kind: 'efforts', role: pane.role })
                  }}
                >
                  <span className={css.rowLabel}>{t('effort')}</span>
                  <span className={css.rowValue}>{roleEffortLabelOf(pane.role) ?? t('providerDefault')}</span>
                  <span className={css.chevron}>{CHEVRON}</span>
                </button>
                {pane.role === 'executor' ? <div className={css.hint}>{t('followsSession')}</div> : null}
              </>
            ) : null}

            {pane.kind === 'models'
              ? (
                <>
                  <div className={css.group}>{t('models')}</div>
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

            {pane.kind === 'efforts' && effortPaneRoute !== undefined
              ? (
                <>
                  <div className={css.group}>{t('effort')}</div>
                  {effortPaneChoices.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      role="menuitem"
                      className={css.row}
                      disabled={busy}
                      onClick={() => {
                        void commitEffort(pane.role, effortPaneRoute, choice.effort)
                      }}
                    >
                      <span className={css.rowLabel}>{choice.label}</span>
                       {pane.draft === undefined && effortPaneRoute.reasoningEffort === choice.effort ? <span className={css.check}>{'\u2713'}</span> : null}
                    </button>
                  ))}
                </>
              )
              : null}

            <div className={css.separator} />
            <div className={css.hint}>{t('applyOnNextSend')}</div>
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
