import { describe, expect, it } from 'vitest'
import { forWallet } from '@/features/portfolio/walletScope'
import type { LedgerEvent } from '@/lib/pnl'
import type { Position, TokenListing, WalletSnapshot } from '@/types/domain'
import { withPnl } from './positionsPnl'
import type { AccountLedger, PnlTracker } from './pnlTracker'

/**
 * Positions scoped to one wallet use the same PnL engine as All wallets, on that wallet's own
 * history: wallet 1 bought 100 TOK for $10, wallet 2 bought 100 TOK for $30, TOK is $0.20 now.
 */

const TOKEN = 'tok.near'
const token = {
  id: TOKEN,
  symbol: 'TOK',
  name: 'Token',
  decimals: 0,
  contract: TOKEN,
  status: 'listed',
  source: 'discovered',
  market: { tokenId: TOKEN, priceUsd: 0.2, priceNear: 0.04, change24hPct: null, liquidityUsd: null, volume24hUsd: null, updatedAt: 1 },
} satisfies TokenListing
const buy = (usd: number, amount: bigint): LedgerEvent => ({ kind: 'buy', at: 1, tx: `tx-${usd}`, amount, value: { near: BigInt(usd) * 10n ** 23n, usd } })
const ledger = (accountId: string, events: LedgerEvent[]): AccountLedger => ({
  accountId,
  byToken: new Map([[TOKEN, events]]),
  complete: true,
  txCount: events.length,
  gasPaid: 0n,
  gas: [],
  readAt: 1,
})
const tracker = (ledgers: AccountLedger[]) =>
  ({
    ledger: async (accountId: string) => ledgers.find((l) => l.accountId === accountId) ?? ledger(accountId, []),
  }) as unknown as PnlTracker
const snapshot = (id: string, accountId: string, raw: string) => ({ id, accountId, holdings: [{ tokenId: TOKEN, raw }] }) as unknown as WalletSnapshot
const position: Position = {
  token,
  balance: 200,
  avgEntryUsd: null,
  priceUsd: 0.2,
  change24hPct: null,
  valueUsd: 40,
  costUsd: null,
  pnlUsd: null,
  pnlPct: null,
  wallets: [
    { walletId: 'w1', amount: 100 },
    { walletId: 'w2', amount: 100 },
  ],
}
const snapshots = [snapshot('w1', 'one.near', '100'), snapshot('w2', 'two.near', '100')]

describe('positions of one wallet: the same PnL model as All wallets, scoped to that wallet', () => {
  it('each wallet has its own avg entry, unrealized PnL and %, from its own history; All is their sum', async () => {
    const [p] = await withPnl([position], snapshots, tracker([ledger('one.near', [buy(10, 100n)]), ledger('two.near', [buy(30, 100n)])]), 1_000)
    if (!p) throw new Error('no position')
    // All wallets: $40 cost, $40 value.
    expect(p.costUsd).toBeCloseTo(40, 9)
    expect(p.avgEntryUsd).toBeCloseTo(0.2, 9)
    expect(p.pnlUsd).toBeCloseTo(0, 9)
    const [one] = forWallet([p], 'w1')
    expect(one).toMatchObject({ balance: 100, wallets: [{ walletId: 'w1', amount: 100 }] })
    expect(one?.valueUsd).toBeCloseTo(20, 9)
    expect(one?.avgEntryUsd).toBeCloseTo(0.1, 9)
    expect(one?.costUsd).toBeCloseTo(10, 9)
    expect(one?.pnlUsd).toBeCloseTo(10, 9)
    expect(one?.pnlPct).toBeCloseTo(100, 9)
    expect(one?.pnl?.bought.amount).toBe(100)
    const [two] = forWallet([p], 'w2')
    expect(two?.avgEntryUsd).toBeCloseTo(0.3, 9)
    expect(two?.costUsd).toBeCloseTo(30, 9)
    expect(two?.pnlUsd).toBeCloseTo(-10, 9)
    expect(two?.pnlPct).toBeCloseTo(-33.333333, 5)
    // Switching wallets re-cuts the same data: nothing of one wallet leaks into another, and All is unchanged.
    expect(forWallet([p], 'w1')[0]?.pnlUsd).toBeCloseTo(10, 9)
    expect(p.pnlUsd).toBeCloseTo(0, 9)
  })

  it('a wallet whose history explains nothing of its holding has unknown figures, never another wallet’s', async () => {
    const [p] = await withPnl([position], snapshots, tracker([ledger('one.near', [buy(10, 100n)])]), 1_000)
    if (!p) throw new Error('no position')
    const [two] = forWallet([p], 'w2')
    expect(two?.balance).toBe(100)
    expect(two?.avgEntryUsd).toBeNull()
    expect(two?.costUsd).toBeNull()
    expect(two?.pnlUsd).toBeNull()
    expect(forWallet([p], 'w1')[0]?.pnlUsd).toBeCloseTo(10, 9)
  })

  it('a position without on-chain PnL (the demo) is re-cut by its average entry, as before', () => {
    const demo: Position = { ...position, avgEntryUsd: 0.1, costUsd: 20, pnlUsd: 20, pnlPct: 100 }
    const [one] = forWallet([demo], 'w1')
    expect(one).toMatchObject({ balance: 100, costUsd: 10, wallets: [{ walletId: 'w1', amount: 100 }] })
    expect(one?.pnlUsd).toBeCloseTo(10, 9)
    expect(forWallet([demo], 'w3')).toEqual([])
  })
})
