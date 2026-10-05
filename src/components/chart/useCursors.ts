import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { indexAtPointer, nearestAt, pointerFrac } from './geometry'

export type CursorId = 'a' | 'b'

/**
 * Two measurement cursors over `count` samples, driven by pointer (grab the
 * nearest, drag) or keyboard on each handle (arrows, Shift = 7 steps, Home/End).
 * `fracs`: where each sample sits when they aren't evenly spaced (a time scale).
 */
export function useCursors(count: number, initial: [number, number], plotRef: RefObject<HTMLElement | null>, fracs?: readonly number[]) {
  const at = (clientX: number, plot: HTMLElement) => (fracs ? nearestAt(fracs, pointerFrac(clientX, plot)) : indexAtPointer(clientX, plot, count))
  const [state, setState] = useState({ a: initial[0], b: initial[1] })
  const dragging = useRef<CursorId | null>(null)
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i))
  const a = clamp(state.a)
  const b = clamp(state.b)

  const move = (id: CursorId, index: number) => setState((s) => ({ ...s, [id]: clamp(index) }))

  const plotHandlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const i = at(e.clientX, e.currentTarget)
      const id: CursorId = Math.abs(i - a) <= Math.abs(i - b) ? 'a' : 'b'
      dragging.current = id
      e.currentTarget.setPointerCapture(e.pointerId)
      move(id, i)
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      dragging.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
  }

  /** Returns true when the move was consumed by a drag. */
  const dragTo = (e: PointerEvent<HTMLElement>): boolean => {
    if (!dragging.current) return false
    move(dragging.current, at(e.clientX, e.currentTarget))
    return true
  }

  const handleKeys = (id: CursorId) => (e: KeyboardEvent<HTMLElement>) => {
    const current = id === 'a' ? a : b
    const step = e.shiftKey ? 7 : 1
    const map: Record<string, number> = { ArrowLeft: current - step, ArrowRight: current + step, Home: 0, End: count - 1, PageUp: current + 7, PageDown: current - 7 }
    const next = map[e.key]
    if (next === undefined) return
    e.preventDefault()
    move(id, next)
  }

  const grab = (id: CursorId) => (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation()
    dragging.current = id
    // Moves are tracked on the plot, so capture the pointer there.
    plotRef.current?.setPointerCapture(e.pointerId)
  }

  return { a, b, move, plotHandlers, dragTo, handleKeys, grab, isDragging: () => dragging.current !== null }
}
