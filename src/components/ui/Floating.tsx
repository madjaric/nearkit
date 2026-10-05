import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { useDismiss, useFloatingPosition, type Placement } from './useFloating'

export type { Placement } from './useFloating'

export function Portal({ children, container }: { children: ReactNode; container?: HTMLElement | null }) {
  return createPortal(children, container ?? document.body)
}

/**
 * Where an open overlay mounts: inside the open <dialog> its anchor sits in, else the body. A modal
 * dialog is in the browser's top layer and makes everything outside it inert, so an overlay on the
 * body would sit behind the dialog, out of reach (the token list in the trade drawer). Null while closed.
 */
function useOverlayContainer(anchorRef: RefObject<HTMLElement | null>, open: boolean): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setContainer(open ? (anchorRef.current?.closest('dialog') ?? document.body) : null)
  }, [anchorRef, open])
  return container
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
  const container = useOverlayContainer(anchorRef, open)
  const pos = useFloatingPosition(anchorRef, tipRef, open && container !== null, placement)

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
      {open && container && (
        <Portal container={container}>
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
  const container = useOverlayContainer(anchorRef, open)
  const pos = useFloatingPosition(anchorRef, floatingRef, open && container !== null, placement)
  useDismiss(open, onClose, [anchorRef, floatingRef])
  if (!open || !container) return null
  return (
    <Portal container={container}>
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
