import { computePnl, type LedgerEvent, type PnlResult } from '@/lib/pnl'
import type { PnlFiguresView, Position, PositionEvent, PositionPnl, TokenListing, WalletSnapshot } from '@/types/domain'
import { combinePnl, type AccountLedger, type PnlTracker } from './pnlTracker'

/**
 * Positions with PnL: each held token's figures from the accounts' ledgers,
 * computed by the one engine (src/lib/pnl.ts). The balance shown stays the one
 * read from chain; if the ledger disagrees, the PnL says history is incomplete.
 */

const HISTORY_ROWS = 50

const nearNum = (v: bigint) => Number(v) / 1e24

function nearView(r: PnlResult): PnlFiguresView {
  return {
    costBasis: nearNum(r.near.costBasis),
    avgEntry: r.near.avgEntry,
    realized: nearNum(r.near.realized),
    unrealized: r.near.unrealized === null ? null : nearNum(r.near.unrealized),
    total: r.near.total === null ? null : nearNum(r.near.total),
    invested: nearNum(r.near.invested),
    pnlPct: r.near.pnlPct,
    unmatchedProceeds: nearNum(r.near.unmatchedProceeds),
    complete: r.near.complete,
  }
}

function usdView(r: PnlResult): PnlFiguresView {
  return { ...r.usd }
}

export function toPositionPnl(r: PnlResult, decimals: number, history: PositionEvent[]): PositionPnl {
  const units = (raw: bigint) => Number(raw) / 10 ** decimals
  return {
    method: 'average-cost',
    near: nearView(r),
    usd: usdView(r),
    unknownCostAmount: units(r.unknownCostQuantity),
    bought: { amount: units(r.bought.quantity), near: r.bought.near === null ? null : nearNum(r.bought.near), usd: r.bought.usd },
    sold: { amount: units(r.sold.quantity), near: r.sold.near === null ? null : nearNum(r.sold.near), usd: r.sold.usd },
    trades: r.trades,
    complete: r.complete,
    limitations: r.limitations,
    history,
  }
}

export function historyRows(events: { accountId: string; event: LedgerEvent }[], decimals: number): PositionEvent[] {
  return events
    .map(({ accountId, event: e }) => ({
      at: e.at,
      tx: e.tx,
      kind: e.kind,
      accountId,
      amount: Number(e.amount) / 10 ** decimals,
      valueNear: e.kind === 'buy' || e.kind === 'sell' ? (e.value.near === null ? null : nearNum(e.value.near)) : null,
      valueUsd: e.kind === 'buy' || e.kind === 'sell' ? e.value.usd : null,
      counterparty: e.kind === 'transfer-in' || e.kind === 'transfer-out' ? e.counterparty : null,
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_ROWS)
}

/** PnL for one token across the accounts holding (or having held) it. */
export function tokenPnl(token: TokenListing, ledgers: AccountLedger[], balances: Map<string, bigint>) {
  const price = { near: token.market?.priceNear ?? null, usd: token.market?.priceUsd ?? null, decimals: token.decimals }
  const parts = ledgers
    .filter((l) => (l.byToken.get(token.id)?.length ?? 0) > 0 || (balances.get(l.accountId) ?? 0n) > 0n)
    .map((l) => ({
      accountId: l.accountId,
      result: computePnl(l.byToken.get(token.id) ?? [], price),
      balance: balances.get(l.accountId) ?? 0n,
      ledgerComplete: l.complete,
    }))
  const combined = combinePnl(parts, token.decimals)
  const events = ledgers.flatMap((l) => (l.byToken.get(token.id) ?? []).map((event) => ({ accountId: l.accountId, event })))
  return {
    combined,
    sales: parts.flatMap((p) => p.result.sales.map((sale) => ({ accountId: p.accountId, sale }))),
    events,
    view: toPositionPnl(combined, token.decimals, historyRows(events, token.decimals)),
  }
}

export async function withPnl(positions: Position[], snapshots: WalletSnapshot[], tracker: PnlTracker, waitMs: number): Promise<Position[]> {
  const accounts = [...new Set(snapshots.map((s) => s.accountId))]
  if (!accounts.length) return positions
  const load = Promise.all(accounts.map((a) => tracker.ledger(a)))
  let ledgers: AccountLedger[] | null
  try {
    ledgers = await Promise.race([load, new Promise<null>((r) => setTimeout(() => r(null), waitMs))])
  } catch {
    return positions.map((p) => ({ ...p, pnlStatus: p.token.isNative ? undefined : 'unavailable' }))
  }
  if (!ledgers) {
    // Still reading history: keep it going for the next refresh.
    load.catch(() => undefined)
    return positions.map((p) => ({ ...p, pnlStatus: p.token.isNative ? undefined : 'loading' }))
  }
  const byWallet = new Map(snapshots.map((s) => [s.id, s]))
  return positions.map((p) => {
    if (p.token.isNative || !p.token.contract) return p
    const balances = new Map<string, bigint>()
    for (const w of p.wallets) {
      const snap = byWallet.get(w.walletId)
      const raw = snap?.holdings.find((h) => h.tokenId === p.token.id)?.raw
      if (snap && raw) balances.set(snap.accountId, BigInt(raw))
    }
    const { combined, view } = tokenPnl(p.token as TokenListing, ledgers as AccountLedger[], balances)
    const knownUnits = combined.quantity - combined.unknownCostQuantity
    const costUsd = knownUnits > 0n && combined.usd.invested > 0 ? combined.usd.costBasis : null
    const pnlUsd = costUsd === null ? null : combined.usd.unrealized
    return {
      ...p,
      avgEntryUsd: costUsd === null ? null : combined.usd.avgEntry,
      costUsd,
      pnlUsd,
      pnlPct: pnlUsd === null || !costUsd ? null : (pnlUsd / costUsd) * 100,
      pnl: view,
      pnlStatus: 'ready',
    }
  })
}
