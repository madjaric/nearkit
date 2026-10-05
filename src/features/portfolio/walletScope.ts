import type { Position } from '@/types/domain'

/**
 * Positions re-cut to one wallet's share, valued at the same prices. With PnL from on-chain history,
 * the wallet's own figures are used: the same engine as All wallets, on that wallet's history alone
 * (src/services/real/positionsPnl.ts), so nothing of another wallet leaks in; a wallet without them
 * has unknown figures. Without such PnL (the demo), the share is costed at the position's average entry.
 */
export function forWallet(positions: Position[], walletId: string): Position[] {
  return positions.flatMap((p) => {
    const share = p.wallets.find((w) => w.walletId === walletId)
    if (!share) return []
    const valueUsd = p.priceUsd === null ? null : share.amount * p.priceUsd
    if (p.pnl !== undefined) {
      const f = share.figures
      return [
        {
          ...p,
          balance: share.amount,
          valueUsd,
          avgEntryUsd: f?.avgEntryUsd ?? null,
          costUsd: f?.costUsd ?? null,
          pnlUsd: f?.pnlUsd ?? null,
          pnlPct: f?.pnlPct ?? null,
          pnl: f?.pnl,
          wallets: [share],
        },
      ]
    }
    const costUsd = p.avgEntryUsd === null ? null : share.amount * p.avgEntryUsd
    const pnlUsd = valueUsd !== null && costUsd !== null ? valueUsd - costUsd : null
    const pnlPct = pnlUsd !== null && costUsd ? (pnlUsd / costUsd) * 100 : null
    return [{ ...p, balance: share.amount, valueUsd, costUsd, pnlUsd, pnlPct, wallets: [share] }]
  })
}
