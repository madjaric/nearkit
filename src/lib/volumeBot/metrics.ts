import type { TradeSide } from './types'

/**
 * What the Volume Bot really did: figures from its executed trades only. A planned, skipped or failed
 * trade is never volume; USD appears only where every trade carried NEAR's price at its time.
 */

export interface TradeRecord {
  at: number
  side: TradeSide
  walletId: string
  status: 'confirmed' | 'failed'
  /** NEAR value moved: spent on a buy, received on a sell. */
  near: number
  tokens: number
  feeNear: number
  gasNear: number
  /** NEAR/USD at the trade; null when unknown. */
  nearUsd: number | null
}

export interface BotMetrics {
  trades: number
  confirmed: number
  failed: number
  /** Confirmed over attempted; null before any attempt. */
  successRate: number | null
  volumeNear: number
  volume24hNear: number
  buyVolumeNear: number
  sellVolumeNear: number
  avgTradeNear: number | null
  avgIntervalSec: number | null
  feesNear: number
  gasNear: number
  volumeUsd: number | null
  perWallet: { walletId: string; trades: number; volumeNear: number }[]
}

const DAY_MS = 86_400_000

export function summarize(trades: readonly TradeRecord[], now: number): BotMetrics {
  const done = trades.filter((t) => t.status === 'confirmed').sort((a, b) => a.at - b.at)
  const sum = (list: readonly TradeRecord[], f: (t: TradeRecord) => number) => list.reduce((s, t) => s + f(t), 0)
  const volumeNear = sum(done, (t) => t.near)
  const perWallet = new Map<string, { walletId: string; trades: number; volumeNear: number }>()
  for (const t of done) {
    const w = perWallet.get(t.walletId) ?? { walletId: t.walletId, trades: 0, volumeNear: 0 }
    w.trades += 1
    w.volumeNear += t.near
    perWallet.set(t.walletId, w)
  }
  const first = done[0]
  const last = done[done.length - 1]
  return {
    trades: trades.length,
    confirmed: done.length,
    failed: trades.length - done.length,
    successRate: trades.length > 0 ? done.length / trades.length : null,
    volumeNear,
    volume24hNear: sum(
      done.filter((t) => now - t.at <= DAY_MS),
      (t) => t.near,
    ),
    buyVolumeNear: sum(
      done.filter((t) => t.side === 'buy'),
      (t) => t.near,
    ),
    sellVolumeNear: sum(
      done.filter((t) => t.side === 'sell'),
      (t) => t.near,
    ),
    avgTradeNear: done.length > 0 ? volumeNear / done.length : null,
    avgIntervalSec: done.length > 1 && first && last ? (last.at - first.at) / 1000 / (done.length - 1) : null,
    feesNear: sum(done, (t) => t.feeNear),
    gasNear: sum(done, (t) => t.gasNear),
    volumeUsd: done.length > 0 && done.every((t) => t.nearUsd !== null) ? sum(done, (t) => t.near * (t.nearUsd as number)) : null,
    perWallet: [...perWallet.values()].sort((a, b) => a.walletId.localeCompare(b.walletId)),
  }
}

/** Cumulative executed volume (NEAR) over time, for the chart. */
export function cumulativeVolume(trades: readonly TradeRecord[]): { t: number; v: number }[] {
  let total = 0
  return trades
    .filter((t) => t.status === 'confirmed')
    .sort((a, b) => a.at - b.at)
    .map((t) => ({ t: t.at, v: (total += t.near) }))
}
