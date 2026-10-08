import type { PnlResult, Sale } from '@/lib/pnl'
import { BUCKET_MS, inPeriod, pnlPoints, sumInPeriod } from '@/lib/pnlPeriod'
import type { ClosedTrade, PnlLimitation, PnlRange, PnlReport, TokenListing, TokenPnl } from '@/types/domain'

/**
 * The PnL page's report, built from the engine's results (src/lib/pnl.ts). One
 * currency throughout: USD where USD values exist, else NEAR (exact). A sale whose
 * realized PnL is unknown counts as a trade but adds nothing to realized PnL, and
 * the report says it is incomplete. The period (src/lib/pnlPeriod.ts) decides which trades, volume
 * and gas count and how the chart is cut; unrealized PnL is the open positions now, whatever it is.
 */

export interface TokenInput {
  token: TokenListing
  combined: PnlResult
  sales: { accountId: string; sale: Sale }[]
  /** Buys and sells in the range, for volume: value in the report's currency (null when unknown). */
  trades: { at: number; value: number | null }[]
  /** Held now (on chain). Defaults to what the history says is held. */
  held?: boolean
}

export function buildPnlReport(input: {
  range: PnlRange
  now: number
  currency: 'USD' | 'NEAR'
  tokens: TokenInput[]
  /** Gas the accounts paid, per transaction, in NEAR: the period's is summed. */
  gas: readonly { at: number; near: number }[]
  /** The history read: when it was capped, older trades are missing and the report says so. */
  history: { complete: boolean; txs: number }
  walletOf: (accountId: string) => string
}): PnlReport {
  const { range, now, currency } = input
  const counts = (at: number) => inPeriod(at, range, now)
  const money = (s: Sale): number | null => (currency === 'USD' ? s.realizedUsd : s.realizedNear === null ? null : Number(s.realizedNear) / 1e24)
  const proceeds = (s: Sale): number | null => (currency === 'USD' ? s.proceedsUsd : s.proceedsNear === null ? null : Number(s.proceedsNear) / 1e24)
  const limits = new Set<PnlLimitation>()
  if (!input.history.complete) limits.add('history-incomplete')

  const byToken: TokenPnl[] = []
  const closed: (ClosedTrade & { known: boolean })[] = []
  // Unrealized PnL of open positions now, whatever the range: unknown ones are left out
  // of the sum, and the sum itself is unknown when no open position has a known figure.
  const open: (number | null)[] = []
  for (const t of input.tokens) {
    for (const l of t.combined.limitations) limits.add(l)
    const sales = t.sales.filter((x) => counts(x.sale.at))
    const judged = sales.filter((x) => money(x.sale) !== null)
    // Realized in the range: 0 without sales; unknown when every sale's result is.
    const realized = sales.length && !judged.length ? null : judged.reduce((s, x) => s + (money(x.sale) as number), 0)
    if (sales.some((x) => money(x.sale) === null)) limits.add('unknown-proceeds')
    const unrealized = currency === 'USD' ? t.combined.usd.unrealized : t.combined.near.unrealized === null ? null : Number(t.combined.near.unrealized) / 1e24
    if (t.held ?? t.combined.quantity > 0n) {
      open.push(unrealized)
      if (unrealized === null) limits.add(t.combined.limitations.includes('no-current-price') ? 'no-current-price' : 'unknown-cost-units')
    }
    const wins = judged.filter((x) => (money(x.sale) as number) > 0).length
    const volume = t.trades.filter((x) => counts(x.at)).reduce((s, x) => s + Math.abs(x.value ?? 0), 0)
    if (!sales.length && !t.trades.some((x) => counts(x.at)) && unrealized === null) continue
    byToken.push({
      token: t.token,
      trades: t.trades.filter((x) => counts(x.at)).length,
      volumeUsd: volume,
      realizedUsd: realized,
      unrealizedUsd: unrealized,
      winRatePct: judged.length ? (wins / judged.length) * 100 : 0,
      closed: judged.length,
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

  // Realized PnL per bucket of the period (an hour for 24H, six for 7D, a day beyond), from 0 at its start.
  const known = closed.filter((c) => c.known)
  const points = pnlPoints(
    known.map((c) => ({ at: c.at, pnl: c.pnlUsd, volume: c.valueUsd })),
    range,
    now,
  )

  const wins = known.filter((c) => c.pnlUsd > 0).length
  const losses = known.filter((c) => c.pnlUsd < 0).length
  return {
    range,
    currency,
    source: 'chain',
    complete: limits.size === 0,
    limitations: [...limits],
    gasNear: sumInPeriod(
      input.gas.map((g) => ({ at: g.at, value: g.near })),
      range,
      now,
    ),
    bucketMs: BUCKET_MS[range],
    history: input.history,
    points,
    realizedUsd: closed.length && !known.length ? null : known.reduce((s, c) => s + c.pnlUsd, 0),
    unrealizedUsd: open.length && open.every((u) => u === null) ? null : open.reduce<number>((s, u) => s + (u ?? 0), 0),
    volumeUsd: byToken.reduce((s, t) => s + t.volumeUsd, 0),
    feesUsd: 0,
    trades: closed.length,
    wins,
    losses,
    winRatePct: known.length ? (wins / known.length) * 100 : 0,
    byToken: byToken.sort((a, b) => (b.realizedUsd ?? 0) + (b.unrealizedUsd ?? 0) - ((a.realizedUsd ?? 0) + (a.unrealizedUsd ?? 0))),
    recentTrades: closed.slice(0, 25).map(({ known: _known, ...c }) => c),
  }
}
