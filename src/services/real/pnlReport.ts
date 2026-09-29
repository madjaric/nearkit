import type { PnlResult, Sale } from '@/lib/pnl'
import type { ClosedTrade, PnlLimitation, PnlPoint, PnlRange, PnlReport, TokenListing, TokenPnl } from '@/types/domain'

/**
 * The PnL page's report, built from the engine's results (src/lib/pnl.ts). One
 * currency throughout: USD where USD values exist, else NEAR (exact). A sale whose
 * realized PnL is unknown counts as a trade but adds nothing to realized PnL, and
 * the report says it is incomplete.
 */

const DAY = 86_400_000
const DAYS: Record<PnlRange, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null }

export interface TokenInput {
  token: TokenListing
  combined: PnlResult
  sales: { accountId: string; sale: Sale }[]
  /** Buys and sells in the range, for volume: value in the report's currency (null when unknown). */
  trades: { at: number; value: number | null }[]
}

export function buildPnlReport(input: {
  range: PnlRange
  now: number
  currency: 'USD' | 'NEAR'
  tokens: TokenInput[]
  gasNear: number
  walletOf: (accountId: string) => string
}): PnlReport {
  const { range, now, currency } = input
  const days = DAYS[range]
  const since = days === null ? 0 : now - days * DAY
  const money = (s: Sale): number | null => (currency === 'USD' ? s.realizedUsd : s.realizedNear === null ? null : Number(s.realizedNear) / 1e24)
  const proceeds = (s: Sale): number | null => (currency === 'USD' ? s.proceedsUsd : s.proceedsNear === null ? null : Number(s.proceedsNear) / 1e24)
  const limits = new Set<PnlLimitation>()

  const byToken: TokenPnl[] = []
  const closed: (ClosedTrade & { known: boolean })[] = []
  for (const t of input.tokens) {
    for (const l of t.combined.limitations) limits.add(l)
    const sales = t.sales.filter((x) => x.sale.at >= since)
    const realized = sales.reduce((s, x) => s + (money(x.sale) ?? 0), 0)
    if (sales.some((x) => money(x.sale) === null)) limits.add('unknown-proceeds')
    const unrealized = currency === 'USD' ? t.combined.usd.unrealized : t.combined.near.unrealized === null ? null : Number(t.combined.near.unrealized) / 1e24
    const judged = sales.filter((x) => money(x.sale) !== null)
    const wins = judged.filter((x) => (money(x.sale) as number) > 0).length
    const volume = t.trades.filter((x) => x.at >= since).reduce((s, x) => s + Math.abs(x.value ?? 0), 0)
    if (!sales.length && !t.trades.some((x) => x.at >= since) && unrealized === null) continue
    byToken.push({
      token: t.token,
      trades: t.trades.filter((x) => x.at >= since).length,
      volumeUsd: volume,
      realizedUsd: realized,
      unrealizedUsd: unrealized ?? 0,
      winRatePct: judged.length ? (wins / judged.length) * 100 : 0,
    })
    for (const x of sales) {
      const pnl = money(x.sale)
      const value = proceeds(x.sale)
      const amount = Number(x.sale.amount) / 10 ** t.token.decimals
      closed.push({
        id: `${x.sale.tx}:${t.token.id}:${x.accountId}`,
        tokenId: t.token.id,
        side: 'sell',
        amount,
        priceUsd: value !== null && amount > 0 ? value / amount : 0,
        valueUsd: value ?? 0,
        pnlUsd: pnl ?? 0,
        walletId: input.walletOf(x.accountId),
        at: x.sale.at,
        known: pnl !== null,
      })
    }
  }
  closed.sort((a, b) => b.at - a.at)

  // Daily realized PnL, from the range start (or the first sale) to today, in UTC days.
  const known = closed.filter((c) => c.known)
  const first = days === null ? (known.length ? Math.min(...known.map((c) => c.at)) : now) : since
  const startDay = Math.floor(first / DAY) * DAY
  const points: PnlPoint[] = []
  let cumulative = 0
  for (let d = startDay; d <= now; d += DAY) {
    const today = known.filter((c) => c.at >= d && c.at < d + DAY)
    const daily = today.reduce((s, c) => s + c.pnlUsd, 0)
    cumulative += daily
    points.push({ t: d, daily, cumulative, volumeUsd: today.reduce((s, c) => s + c.valueUsd, 0) })
  }

  const wins = known.filter((c) => c.pnlUsd > 0).length
  const losses = known.filter((c) => c.pnlUsd < 0).length
  return {
    range,
    currency,
    source: 'chain',
    complete: limits.size === 0 || (limits.size === 1 && limits.has('no-current-price')),
    limitations: [...limits],
    gasNear: input.gasNear,
    points,
    realizedUsd: known.reduce((s, c) => s + c.pnlUsd, 0),
    unrealizedUsd: byToken.reduce((s, t) => s + t.unrealizedUsd, 0),
    volumeUsd: byToken.reduce((s, t) => s + t.volumeUsd, 0),
    feesUsd: 0,
    trades: closed.length,
    wins,
    losses,
    winRatePct: known.length ? (wins / known.length) * 100 : 0,
    byToken: byToken.sort((a, b) => b.realizedUsd + b.unrealizedUsd - (a.realizedUsd + a.unrealizedUsd)),
    recentTrades: closed.slice(0, 25).map(({ known: _known, ...c }) => c),
  }
}
