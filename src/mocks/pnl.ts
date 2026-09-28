import { mulberry32 } from '@/lib/prng'
import type { ClosedTrade, TokenId } from '@/types/domain'
import { SEED_MARKET, TOKEN_IDS } from './tokens'
import { DAY, HOUR, SEED_NOW, startOfDay } from './time'

export const HISTORY_DAYS = 180

const TRADE_MIX: { id: TokenId; weight: number; vol: number }[] = [
  { id: TOKEN_IDS.blackdragon, weight: 0.42, vol: 0.34 },
  { id: TOKEN_IDS.shitzu, weight: 0.24, vol: 0.22 },
  { id: TOKEN_IDS.kit, weight: 0.18, vol: 0.4 },
  { id: TOKEN_IDS.near, weight: 0.16, vol: 0.09 },
]

const WALLET_MIX = ['w01', 'w01', 'w01', 'w02', 'w03', 'w04', 'w05']

/** Deterministic closed-trade history: the same 180 days on every load. */
export function generateClosedTrades(): ClosedTrade[] {
  const rand = mulberry32(20260928)
  const today = startOfDay(SEED_NOW)
  const trades: ClosedTrade[] = []
  let seq = 0

  for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
    const day = today - d * DAY
    const roll = rand()
    const count = roll < 0.5 ? 0 : roll < 0.78 ? 1 : roll < 0.93 ? 2 : 3
    for (let k = 0; k < count; k++) {
      let pick = rand()
      const token = TRADE_MIX.find((t) => (pick -= t.weight) <= 0) ?? TRADE_MIX[0]!
      const valueUsd = Math.round((140 + rand() ** 1.7 * 3900) * 100) / 100
      const r = (rand() - 0.43) * 2 * token.vol
      const pnlUsd = Math.round(((valueUsd * r) / (1 + r)) * 100) / 100
      const base = SEED_MARKET.find((m) => m.tokenId === token.id)?.priceUsd ?? 1
      const priceUsd = base * (0.72 + rand() * 0.56)
      const at = Math.min(SEED_NOW - 20 * 60_000, day + (7 + rand() * 15) * HOUR)
      seq += 1
      trades.push({
        id: `trd-${String(seq).padStart(4, '0')}`,
        tokenId: token.id,
        side: 'sell',
        amount: valueUsd / priceUsd,
        priceUsd,
        valueUsd,
        pnlUsd,
        walletId: WALLET_MIX[Math.floor(rand() * WALLET_MIX.length)] ?? 'w01',
        at,
      })
    }
  }
  return trades
}

/** Relative portfolio path used for the value trace; scaled to the live value at read time. */
export function generateValuePath(days: number): number[] {
  const rand = mulberry32(7331)
  const path: number[] = [1]
  for (let i = 1; i < days * 4; i++) {
    const shock = (rand() - 0.47) * 0.045
    path.push((path[i - 1] ?? 1) * (1 + shock))
  }
  return path
}
