import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export type Placement = 'top' | 'bottom' | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface FloatingPosition {
  top: number
  left: number
  /** Anchor width, for overlays that match their trigger. */
  anchorWidth: number
}

const GAP = 6
const MARGIN = 8

/**
 * Positions a fixed element against an anchor, flipping vertically when it
 * would leave the viewport and clamping horizontally. Returns null until the
 * first measurement, so callers render the overlay hidden for one frame.
 */
export function useFloatingPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  placement: Placement,
): FloatingPosition | null {
  const [pos, setPos] = useState<FloatingPosition | null>(null)

  const update = useCallback(() => {
    const anchor = anchorRef.current
    const floating = floatingRef.current
    if (!anchor || !floating) return
    const a = anchor.getBoundingClientRect()
    const f = floating.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const wantsTop = placement.startsWith('top')
    const spaceAbove = a.top
    const spaceBelow = vh - a.bottom
    const top = wantsTop ? spaceAbove >= f.height + GAP + MARGIN || spaceAbove > spaceBelow : !(spaceBelow >= f.height + GAP + MARGIN || spaceBelow > spaceAbove)
    const align = placement.endsWith('start') ? 'start' : placement.endsWith('end') ? 'end' : 'center'
    let left = align === 'start' ? a.left : align === 'end' ? a.right - f.width : a.left + a.width / 2 - f.width / 2
    left = Math.max(MARGIN, Math.min(left, vw - f.width - MARGIN))
    let y = top ? a.top - f.height - GAP : a.bottom + GAP
    y = Math.max(MARGIN, Math.min(y, vh - f.height - MARGIN))
    setPos({ top: y, left, anchorWidth: a.width })
  }, [anchorRef, floatingRef, placement])

  // Measure after the overlay mounts: reading layout is what layout effects are for.
  useLayoutEffect(() => {
    if (open) update()
  }, [open, update])

  useEffect(() => {
    if (!open) return
    const onChange = () => update()
    window.addEventListener('resize', onChange)
    window.addEventListener('scroll', onChange, true)
    const observer = new ResizeObserver(onChange)
    if (floatingRef.current) observer.observe(floatingRef.current)
    return () => {
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange, true)
      observer.disconnect()
    }
  }, [open, update, floatingRef])

  return open ? pos : null
}

/** Close an overlay on outside pointer-down or Escape. */
export function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  const refsRef = useRef(refs)
  useLayoutEffect(() => {
    refsRef.current = refs
  })
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (refsRef.current.some((r) => r.current?.contains(target))) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
}
