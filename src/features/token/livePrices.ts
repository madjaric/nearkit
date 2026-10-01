import type { PricePoint } from '@/types/domain'

/**
 * Prices this page has seen, per token: the chart of a token with no history source, and the
 * live end of one with a source. Each is recorded at the time its source reported it, once. In
 * memory for this browser tab only: nothing is stored, sent or shared.
 */

const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_POINTS = 2_000
const EMPTY: readonly PricePoint[] = Object.freeze([])

const seen = new Map<string, readonly PricePoint[]>()
const listeners = new Set<() => void>()

/** Records a price reported at `at`. False when it adds nothing: a price read again, out of order, or not a price. */
export function recordPrice(tokenId: string, usd: number, at: number): boolean {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(at)) return false
  const list = seen.get(tokenId) ?? EMPTY
  const last = list[list.length - 1]
  if (last && at <= last.t) return false
  const next = [...list, { t: at, usd }].filter((p) => p.t >= at - MAX_AGE_MS).slice(-MAX_POINTS)
  seen.set(tokenId, next)
  for (const l of listeners) l()
  return true
}

/** The prices seen for a token, oldest first; the same list until a new one is seen. */
export function livePrices(tokenId: string): readonly PricePoint[] {
  return seen.get(tokenId) ?? EMPTY
}

export function subscribeLivePrices(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Tests only. */
export function resetLivePrices(): void {
  seen.clear()
}
