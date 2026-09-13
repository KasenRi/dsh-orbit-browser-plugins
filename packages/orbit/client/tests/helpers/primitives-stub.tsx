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

export function useAnchoredPosition(_options: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side?: 'top' | 'bottom'
  gap: number
  margin: number
}): CSSProperties | null {
  return { position: 'fixed', left: 0, top: 0 }
}

export function useDismissOnOutsidePointer(
  _root: RefObject<HTMLElement | null>,
  _open: boolean,
  _setOpen: (open: boolean) => void,
  _portal?: RefObject<HTMLElement | null>,
): void {}
