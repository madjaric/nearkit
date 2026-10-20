import type { PricePoint } from '@/types/domain'

/**
 * The points of a token's price line: its source's prices when the source has no candles (CoinGecko),
 * then the live prices this page saw after the last of them; with no source, only the live prices.
 * Only observed prices: nothing is interpolated or carried back, a gap stays a gap. One point a second
 * (the chart's time unit), the later one kept; a price from the future (clock skew) is not drawn.
 */
export function linePoints(source: readonly PricePoint[], live: readonly PricePoint[], now: number): PricePoint[] {
  const ok = (p: PricePoint) => Number.isFinite(p.t) && p.t <= now && Number.isFinite(p.usd) && p.usd > 0
  const base = source.filter(ok)
  const lastT = base.reduce((m, p) => Math.max(m, p.t), Number.NEGATIVE_INFINITY)
  const all = [...base, ...live.filter((p) => ok(p) && p.t > lastT)].sort((a, b) => a.t - b.t)
  const out: PricePoint[] = []
  for (const p of all) {
    const prev = out[out.length - 1]
    if (prev && Math.floor(prev.t / 1000) === Math.floor(p.t / 1000)) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}
