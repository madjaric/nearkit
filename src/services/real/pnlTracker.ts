import { computePnl, type CurrentPrice, type LedgerEvent, type PnlResult } from '@/lib/pnl'
import { fetchNearUsdHours, usdAt } from '@/services/near/candles'
import { fetchAccountTxs, fetchFullTxs, ledgerEvents, type TxRef } from '@/services/near/history'
import type { NearContext } from './context'

/**
 * Per-account ledgers and per-token PnL, for Positions, the PnL page and the bot.
 * Ledger events are cached per transaction (final transactions never change), so
 * after the first read only new transactions are fetched. Nothing here estimates:
 * gaps become `limitations` on the result.
 */

export interface AccountLedger {
  accountId: string
  /** token contract → events, oldest first */
  byToken: Map<string, LedgerEvent[]>
  /** The index returned the whole history (false: capped at MAX_TXS). */
  complete: boolean
  txCount: number
  /** yoctoNEAR of gas this account paid as signer, across its history. */
  gasPaid: bigint
  readAt: number
}

export const MAX_TXS = 600
const TTL_MS = 60_000

interface CachedTx {
  h: number
  gas: string
  events: { token: string; kind: LedgerEvent['kind']; at: number; amount: string; near?: string | null; usd?: number | null; cp?: string | null }[]
}

const serialize = (e: { token: string; event: LedgerEvent }): CachedTx['events'][number] => ({
  token: e.token,
  kind: e.event.kind,
  at: e.event.at,
  amount: e.event.amount.toString(),
  ...(e.event.kind === 'buy' || e.event.kind === 'sell' ? { near: e.event.value.near?.toString() ?? null, usd: e.event.value.usd } : { cp: e.event.counterparty }),
})

function revive(hash: string, c: CachedTx['events'][number]): LedgerEvent {
  const base = { at: c.at, tx: hash, amount: BigInt(c.amount) }
  if (c.kind === 'buy' || c.kind === 'sell') return { kind: c.kind, ...base, value: { near: c.near ? BigInt(c.near) : null, usd: c.usd ?? null } }
  return { kind: c.kind, ...base, counterparty: c.cp ?? null }
}

export function createPnlTracker(ctx: NearContext) {
  const memory = new Map<string, { at: number; value: Promise<AccountLedger> }>()

  function loadCache(accountId: string): Record<string, CachedTx> {
    try {
      const text = ctx.stores.ledger.read(accountId)
      return text ? (JSON.parse(text) as Record<string, CachedTx>) : {}
    } catch {
      return {}
    }
  }

  async function read(accountId: string): Promise<AccountLedger> {
    const txUrl = ctx.network.discovery.fastnearTxUrl
    const { txs, complete } = await fetchAccountTxs(ctx.fetch, txUrl, accountId, { max: MAX_TXS })
    const cache = loadCache(accountId)
    const missing = txs.filter((t) => !cache[t.hash])
    if (missing.length) {
      const full = await fetchFullTxs(ctx.fetch, txUrl, missing)
      const hours = ctx.network.nearUsd
        ? await fetchNearUsdHours(
            ctx.fetch,
            ctx.network.nearUsd.coinbase,
            missing.map((t) => t.timestampMs),
          )
        : new Map<number, number>()
      const options = { wrapContract: ctx.network.wrapContract, stables: ctx.network.stableTokens, nearUsdAt: (ms: number) => usdAt(hours, ms) }
      for (const tx of full) {
        cache[tx.hash] = {
          h: tx.blockHeight ?? 0,
          gas: (tx.signerId === accountId ? tx.gasBurnt : 0n).toString(),
          events: ledgerEvents(tx, accountId, options).map(serialize),
        }
      }
      try {
        ctx.stores.ledger.write(accountId, JSON.stringify(cache))
      } catch {
        // storage full: the ledger just isn't cached
      }
    }
    const byToken = new Map<string, LedgerEvent[]>()
    let gasPaid = 0n
    const seen = new Set(txs.map((t: TxRef) => t.hash))
    for (const [hash, c] of Object.entries(cache)) {
      if (!seen.has(hash)) continue
      gasPaid += BigInt(c.gas)
      for (const e of c.events) byToken.set(e.token, [...(byToken.get(e.token) ?? []), revive(hash, e)])
    }
    for (const list of byToken.values()) list.sort((a, b) => a.at - b.at)
    return { accountId, byToken, complete, txCount: txs.length, gasPaid, readAt: ctx.now() }
  }

  return {
    /** The account's ledger, read at most once a minute. */
    ledger(accountId: string): Promise<AccountLedger> {
      const hit = memory.get(accountId)
      if (hit && ctx.now() - hit.at < TTL_MS) return hit.value
      const value = read(accountId)
      memory.set(accountId, { at: ctx.now(), value })
      value.catch(() => memory.delete(accountId))
      return value
    },
    invalidate(accountId?: string) {
      if (accountId) memory.delete(accountId)
      else memory.clear()
    },
  }
}

export type PnlTracker = ReturnType<typeof createPnlTracker>

/**
 * One token across accounts: each account's PnL computed on its own ledger (average
 * cost is per account), then summed. The on-chain balance is the truth for quantity;
 * when the ledger disagrees with it, history is missing and the result says so.
 */
export function combinePnl(parts: { result: PnlResult; balance: bigint; ledgerComplete: boolean }[], decimals: number): PnlResult & { mismatch: boolean } {
  const first = parts[0]?.result
  if (!first) return { ...computePnl([], null), mismatch: false }
  const sumBig = (pick: (r: PnlResult) => bigint) => parts.reduce((s, p) => s + pick(p.result), 0n)
  const sumNullBig = (pick: (r: PnlResult) => bigint | null) =>
    parts.reduce<bigint | null>((s, p) => (s === null || pick(p.result) === null ? null : s + (pick(p.result) as bigint)), 0n)
  const sumNum = (pick: (r: PnlResult) => number) => parts.reduce((s, p) => s + pick(p.result), 0)
  const sumNullNum = (pick: (r: PnlResult) => number | null) =>
    parts.reduce<number | null>((s, p) => (s === null || pick(p.result) === null ? null : s + (pick(p.result) as number)), 0)
  const mismatch = parts.some((p) => p.result.quantity !== p.balance)
  const limitations = new Set(parts.flatMap((p) => p.result.limitations))
  if (mismatch || parts.some((p) => !p.ledgerComplete)) limitations.add('history-incomplete')
  const known = sumBig((r) => r.quantity - r.unknownCostQuantity)
  const unit = 10n ** BigInt(decimals)
  const nearCost = sumBig((r) => r.near.costBasis)
  const usdCost = sumNum((r) => r.usd.costBasis)
  // An account holding tokens of which none has a known cost (by its history) has unknown
  // PnL; the others still count. Unknown overall only when every holding account is.
  const holding = parts.filter((p) => p.balance > 0n || p.result.quantity > 0n)
  const unknownHolding = (p: (typeof parts)[number]) => (p.balance > 0n || p.result.quantity > 0n) && p.result.quantity - p.result.unknownCostQuantity === 0n
  const unrealizedOf = <T>(pick: (r: PnlResult) => T | null, add: (a: T, b: T) => T, zero: T): T | null => {
    const known = parts.filter((p) => !unknownHolding(p) && pick(p.result) !== null)
    if (holding.length > 0 && holding.every((p) => unknownHolding(p) || pick(p.result) === null)) return null
    return known.reduce((s, p) => add(s, pick(p.result) as T), zero)
  }
  const nearUnrealized = unrealizedOf<bigint>(
    (r) => r.near.unrealized,
    (a, b) => a + b,
    0n,
  )
  const usdUnrealized = unrealizedOf<number>(
    (r) => r.usd.unrealized,
    (a, b) => a + b,
    0,
  )
  const nearRealized = sumBig((r) => r.near.realized)
  const usdRealized = sumNum((r) => r.usd.realized)
  const nearTotal = nearUnrealized === null ? null : nearRealized + nearUnrealized
  const usdTotal = usdUnrealized === null ? null : usdRealized + usdUnrealized
  const nearInvested = sumBig((r) => r.near.invested)
  const usdInvested = sumNum((r) => r.usd.invested)
  const complete = parts.every((p) => p.result.complete && p.ledgerComplete) && !mismatch
  return {
    ...first,
    quantity: sumBig((r) => r.quantity),
    unknownCostQuantity: sumBig((r) => r.unknownCostQuantity),
    bought: { quantity: sumBig((r) => r.bought.quantity), near: sumNullBig((r) => r.bought.near), usd: sumNullNum((r) => r.bought.usd) },
    sold: { quantity: sumBig((r) => r.sold.quantity), near: sumNullBig((r) => r.sold.near), usd: sumNullNum((r) => r.sold.usd) },
    transferredIn: sumBig((r) => r.transferredIn),
    transferredOut: sumBig((r) => r.transferredOut),
    trades: parts.reduce((s, p) => s + p.result.trades, 0),
    near: {
      costBasis: nearCost,
      avgEntry: known === 0n ? null : Number((nearCost * unit) / known) / 1e24,
      realized: nearRealized,
      unrealized: nearUnrealized,
      total: nearTotal,
      invested: nearInvested,
      pnlPct: nearTotal === null || nearInvested === 0n ? null : (Number((nearTotal * 10n ** 12n) / nearInvested) / 1e12) * 100,
      unmatchedProceeds: sumBig((r) => r.near.unmatchedProceeds),
      complete,
    },
    usd: {
      costBasis: usdCost,
      avgEntry: known === 0n ? null : usdCost / (Number(known) / Number(unit)),
      realized: usdRealized,
      unrealized: usdUnrealized,
      total: usdTotal,
      invested: usdInvested,
      pnlPct: usdTotal === null || usdInvested === 0 ? null : (usdTotal / usdInvested) * 100,
      unmatchedProceeds: sumNum((r) => r.usd.unmatchedProceeds),
      complete: complete && parts.every((p) => p.result.usd.complete),
    },
    closed: parts.every((p) => p.result.closed),
    sales: parts.flatMap((p) => p.result.sales).sort((a, b) => a.at - b.at),
    complete,
    limitations: [...limitations],
    firstAt: parts.reduce<number | null>((m, p) => (p.result.firstAt === null ? m : m === null ? p.result.firstAt : Math.min(m, p.result.firstAt)), null),
    lastAt: parts.reduce<number | null>((m, p) => (p.result.lastAt === null ? m : m === null ? p.result.lastAt : Math.max(m, p.result.lastAt)), null),
    mismatch,
  }
}

export type { CurrentPrice }
