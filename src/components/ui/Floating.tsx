import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { useDismiss, useFloatingPosition, type Placement } from './useFloating'

export type { Placement } from './useFloating'

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

// ─── tooltip ────────────────────────────────────────────────────────────────

interface TipProps {
  content: ReactNode
  children: ReactNode
  placement?: Placement
  className?: string
  /** Render the trigger as a focusable inline element (for plain text triggers). */
  focusable?: boolean
}

/** Hover/focus hint. Content is supplementary; never put required information only here. */
export function Tip({ content, children, placement = 'top', className, focusable = false }: TipProps) {
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const pos = useFloatingPosition(anchorRef, tipRef, open, placement)

  const show = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), 120)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <span
        ref={anchorRef}
        className={cn('inline-flex', className)}
        tabIndex={focusable ? 0 : undefined}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open && (
        <Portal>
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="pointer-events-none z-[80] max-w-72 animate-fade rounded-sm border border-line bg-raised px-2.5 py-2 text-xs leading-[1.45] text-fg-2 shadow-pop"
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  )
}

// ─── popover ────────────────────────────────────────────────────────────────

interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  placement?: Placement
  className?: string
  /** Match the anchor's width (dropdowns). */
  matchWidth?: boolean
  role?: string
  label?: string
}

export function Popover({ anchorRef, open, onClose, children, placement = 'bottom-start', className, matchWidth = false, role = 'dialog', label }: PopoverProps) {
  const floatingRef = useRef<HTMLDivElement>(null)
  const pos = useFloatingPosition(anchorRef, floatingRef, open, placement)
  useDismiss(open, onClose, [anchorRef, floatingRef])
  if (!open) return null
  return (
    <Portal>
      <div
        ref={floatingRef}
        role={role}
        aria-label={label}
        style={{
          position: 'fixed',
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          width: matchWidth && pos ? pos.anchorWidth : undefined,
          visibility: pos ? 'visible' : 'hidden',
        }}
        className={cn('z-[70] animate-fade rounded-md border border-line bg-raised shadow-pop', className)}
      >
        {children}
      </div>
    </Portal>
  )
}
