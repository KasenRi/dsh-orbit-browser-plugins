/** Copy dictionaries for the Orbit model control. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'orbit-model'

/** English strings (the key-set source of truth for this pair). */
export const en = {
  triggerFallback: 'Not configured',
  tooltip: 'Orbit model configuration',
  title: 'Orbit — Self-reviewing continuous execution',
  enableLongRun: 'Enable long-running execution',
  orbitOff: 'Orbit Off',
  orbitSwitchLabel: 'Orbit for this chat',
  commander: 'Commander',
  executor: 'Executor',
  watchdog: 'Watchdog',
  commanderModel: 'Commander model',
  executorModel: 'Executor model',
  watchdogModel: 'Watchdog model',
  followsSession: 'Follows current session model',
  models: 'Model',
  effort: 'Reasoning effort',
  providerDefault: 'Provider default',
  back: 'Back',
  retry: 'Retry',
  loadFailed: 'Failed to load models',
  settingsFailed: 'Failed to load Orbit settings',
  saveFailed: 'Failed to save Orbit settings',
  applyOnNextSend: 'Changes apply to the next message',
}

/** Chinese strings. */
export const zh: Record<keyof typeof en, string> = {
  triggerFallback: '未配置',
  tooltip: 'Orbit 模型配置',
  title: 'Orbit 让AI自我审核连续执行',
  enableLongRun: '启用一键长执行',
  orbitOff: 'Orbit Off',
  orbitSwitchLabel: '本会话 Orbit 开关',
  commander: '指挥官',
  executor: '执行员',
  watchdog: '监控模型',
  commanderModel: '指挥官模型',
  executorModel: '执行员模型',
  watchdogModel: '监控模型',
  followsSession: '跟随当前会话模型',
  models: '模型',
  effort: '推理等级',
  providerDefault: '提供方默认',
  back: '返回',
  retry: '重试',
  loadFailed: '模型列表加载失败',
  settingsFailed: 'Orbit 设置加载失败',
  saveFailed: 'Orbit 设置保存失败',
  applyOnNextSend: '更改将会在下一次发送时生效',
}

export type OrbitModelKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Orbit model control's copy. */
    'orbit-model': OrbitModelKey
  }
}
