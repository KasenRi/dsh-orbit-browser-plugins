/**
 * Test stub for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The published primitives package imports its whole component graph
 * (markdown/shiki included) from the package root, which a jsdom component
 * spec does not need. The component under test only consumes the three
 * members stubbed here; the real primitives are exercised by the real Web
 * acceptance run.
 */

import type { ButtonHTMLAttributes, CSSProperties, ReactNode, RefObject } from 'react'

export function Button({ icon, children, ...rest }: {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest}>
      {icon}
      {children}
    </button>
  )
}

/** Last placement options the control requested (placement assertions). */
export const lastAnchoredPosition: { side?: 'top' | 'bottom'; gap?: number; margin?: number } = {}

export function Switch({ checked, onChange, label, disabled, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean | undefined
  title?: string | undefined
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={className}
      onClick={() => {
        onChange(!checked)
      }}
    >
      <span />
    </button>
  )
}

export function useAnchoredPosition(options: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom'
  gap: number
  margin: number
}): CSSProperties | null {
  lastAnchoredPosition.side = options.side
  lastAnchoredPosition.gap = options.gap
  lastAnchoredPosition.margin = options.margin
  return { position: 'fixed', left: 0, top: 0 }
}

/** Last design cap the control requested (fit assertions). */
export const lastAnchoredMaxHeight: { cap?: number } = {}

export function useAnchoredMaxHeight(ref: RefObject<HTMLElement | null>, cap: number, signal: unknown): number {
  void ref
  void signal
  lastAnchoredMaxHeight.cap = cap
  return cap
}

export function useDismissOnOutsidePointer(
  _root: RefObject<HTMLElement | null>,
  _open: boolean,
  _setOpen: (open: boolean) => void,
  _portal?: RefObject<HTMLElement | null>,
): void {}
