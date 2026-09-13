/** Copy dictionaries for the Orbit model control. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'orbit-model'

/** English strings (the key-set source of truth for this pair). */
export const en = {
  triggerFallback: 'Orbit',
  tooltip: 'Orbit model configuration',
  title: 'Orbit',
  commander: 'Commander',
  executor: 'Executor',
  watchdog: 'Watchdog',
  followsSession: 'Follows current session model',
  models: 'Models',
  effort: 'Reasoning effort',
  providerDefault: 'Provider default',
  back: 'Back',
  retry: 'Retry',
  loadFailed: 'Failed to load models',
  settingsFailed: 'Failed to load Orbit settings',
  saveFailed: 'Failed to save Orbit settings',
  nextRunOnly: 'Changes apply to the next Orbit run',
}

/** Chinese strings. */
export const zh: Record<keyof typeof en, string> = {
  triggerFallback: 'Orbit',
  tooltip: 'Orbit 模型配置',
  title: 'Orbit',
  commander: '指挥官',
  executor: '执行员',
  watchdog: '监控模型',
  followsSession: '跟随当前会话模型',
  models: '模型',
  effort: '推理强度',
  providerDefault: '提供方默认',
  back: '返回',
  retry: '重试',
  loadFailed: '模型列表加载失败',
  settingsFailed: 'Orbit 设置加载失败',
  saveFailed: 'Orbit 设置保存失败',
  nextRunOnly: '更改应用于下一个新的 Orbit 运行',
}

export type OrbitModelKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Orbit model control's copy. */
    'orbit-model': OrbitModelKey
  }
}
