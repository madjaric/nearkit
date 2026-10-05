import type { Candle } from '@/types/domain'

const price = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/**
 * One candle from a source's row, or null when it doesn't add up: every price above zero, the high
 * at or above open, close and low, the low at or below them. Never repaired. A volume that isn't one
 * is unknown (null); the prices stand. `t`: the candle's start, in seconds.
 */
export function candleOf(t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): Candle | null {
  if (typeof t !== 'number' || !Number.isFinite(t) || !price(o) || !price(h) || !price(l) || !price(c)) return null
  if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) return null
  return { t: t * 1000, o, h, l, c, v: typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null }
}
