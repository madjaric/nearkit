import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { Position, TokenListing } from '@/types/domain'
import type { PortfolioService, WalletService } from '../types'
import { reconcile } from './activity'
import type { NearContext } from './context'
import type { Market } from './market'
import type { PnlTracker } from './pnlTracker'
import { buildPnlReport } from './pnlReport'
import { tokenPnl, withPnl } from './positionsPnl'

/**
 * Portfolio from real balances. Values need a price; where there is none
 * (testnet, unlisted tokens) the figure is null, never zero. Cost basis and PnL
 * come from each account's on-chain history (src/lib/pnl.ts): exact in NEAR,
 * in USD at each trade's hour, and flagged wherever history can't tell.
 */

/** How long a positions read waits for history before answering without PnL. */
const PNL_WAIT_MS = 6_000

export function createPortfolioService(
  ctx: NearContext,
  market: Market,
  wallets: Pick<WalletService, 'getSession' | 'listSnapshots'>,
  active: ReadonlySet<string>,
  tracker: PnlTracker,
): PortfolioService {
  async function positions(): Promise<Position[]> {
    const snapshots = await wallets.listSnapshots()
    const held = [...new Set(snapshots.flatMap((s) => s.holdings.map((h) => h.tokenId)))].filter((id) => id !== NATIVE_TOKEN_ID)
    const tokens = new Map<string, TokenListing>((await market.listTokens(held)).map((t) => [t.id, t]))
    const byToken = new Map<string, { walletId: string; amount: number }[]>()
    for (const s of snapshots) {
      for (const h of s.holdings) {
        if (h.amount <= 0) continue
        byToken.set(h.tokenId, [...(byToken.get(h.tokenId) ?? []), { walletId: h.walletId, amount: h.amount }])
      }
    }
    const list: Position[] = []
    for (const [tokenId, shares] of byToken) {
      const token = tokens.get(tokenId)
      if (!token) continue
      const balance = shares.reduce((s, w) => s + w.amount, 0)
      const price = token.market?.priceUsd ?? null
      list.push({
        token,
        balance,
        avgEntryUsd: null,
        priceUsd: price,
        change24hPct: token.market?.change24hPct ?? null,
        valueUsd: price === null ? null : balance * price,
        costUsd: null,
        pnlUsd: null,
        pnlPct: null,
        wallets: shares.sort((a, b) => b.amount - a.amount),
      })
    }
    // Priced positions by value first, then unpriced ones by balance.
    const sorted = list.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || b.balance - a.balance)
    return withPnl(sorted, snapshots, tracker, PNL_WAIT_MS)
  }

  return {
    async getSummary() {
      const session = await wallets.getSession()
      if (!session) {
        return {
          valueUsd: ctx.capabilities.prices ? 0 : null,
          pnl24hUsd: null,
          pnl24hPct: null,
          unrealizedPnlUsd: null,
          availableNear: 0,
          availableNearUsd: null,
          mainNear: 0,
          activePositions: 0,
          openOrders: 0,
          walletCount: 0,
          updatedAt: ctx.now(),
        }
      }
      const [snapshots, list, near] = await Promise.all([wallets.listSnapshots(), positions(), market.nearQuote()])
      const priced = list.filter((p) => p.valueUsd !== null)
      const availableNear = snapshots.reduce((s, w) => s + w.nearBalance, 0)
      return {
        valueUsd: ctx.capabilities.prices ? priced.reduce((s, p) => s + (p.valueUsd ?? 0), 0) : null,
        pnl24hUsd: null,
        pnl24hPct: null,
        unrealizedPnlUsd: null,
        availableNear,
        availableNearUsd: near ? availableNear * near.priceUsd : null,
        mainNear: snapshots.find((w) => w.accountId === session.accountId)?.nearBalance ?? 0,
        activePositions: list.length,
        openOrders: 0,
        walletCount: snapshots.length,
        updatedAt: ctx.now(),
      }
    },

    listPositions: positions,

    async getValueHistory() {
      return []
    },

    async getPnl(range) {
      const snapshots = await wallets.listSnapshots()
      const accounts = [...new Set(snapshots.map((s) => s.accountId))]
      if (!accounts.length) return null
      const ledgers = await Promise.all(accounts.map((a) => tracker.ledger(a)))
      const ids = [...new Set(ledgers.flatMap((l) => [...l.byToken.keys()]))]
      const listings = new Map((await market.listTokens(ids)).map((t) => [t.id, t]))
      const currency = ctx.capabilities.prices ? 'USD' : 'NEAR'
      const tokens = ids.flatMap((id) => {
        const token = listings.get(id)
        if (!token || !token.contract) return []
        const balances = new Map<string, bigint>()
        for (const s of snapshots) {
          const raw = s.holdings.find((h) => h.tokenId === id)?.raw
          if (raw) balances.set(s.accountId, BigInt(raw))
        }
        const { combined, sales, events } = tokenPnl(token, ledgers, balances)
        const trades = events.flatMap(({ event: e }) =>
          e.kind === 'buy' || e.kind === 'sell' ? [{ at: e.at, value: currency === 'USD' ? e.value.usd : e.value.near === null ? null : Number(e.value.near) / 1e24 }] : [],
        )
        return [{ token, combined, sales, trades }]
      })
      const gasNear = ledgers.reduce((s, l) => s + Number(l.gasPaid) / 1e24, 0)
      return buildPnlReport({ range, now: ctx.now(), currency, tokens, gasNear, walletOf: (a) => snapshots.find((s) => s.accountId === a)?.id ?? a })
    },

    async listActivity(limit = 50) {
      const records = ctx.stores.activity.list()
      const checked = await Promise.all(records.slice(0, limit).map((r) => reconcile(ctx, r, active).catch(() => r)))
      for (const [i, r] of checked.entries()) if (r !== records[i]) ctx.stores.activity.upsert(r)
      return checked
    },
  }
}
