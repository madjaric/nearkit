/**
 * Top Wallets' accounting (DISCOVERY.md, "Top Wallets: accounting"): Intear's swap legs → token actions
 * per wallet and transaction → a weighted-average-cost position per wallet and token, in USD at each
 * trade's own value. Pure: the indexer (trades.ts) stores what these return.
 */

/** One swap leg as Intear reports it (one row per swap, seen from the token sold). */
export interface RawTrade {
  id: number
  ts: number
  height: number
  trader: string
  poolId: string
  /** Null for a liquidity change (not a trade). */
  tokenIn: string | null
  amountIn: string | null
  tokenOut: string | null
  amountOut: string | null
  /** USD value of the leg (priced the block before); null when Intear had no price. */
  usd: number | null
  tx: string
}

/** A wallet's purchase or sale of one token in one transaction, after netting its legs. */
export interface TokenAction {
  trader: string
  token: string
  side: 'buy' | 'sell'
  /** Raw units (the token's smallest unit), as a number: only ratios of it are used. */
  qty: number
  usd: number | null
  ts: number
  tx: string
  /** The first leg's id (ordering). */
  id: number
}

const toBig = (s: string | null): bigint | null => {
  if (s === null || !/^\d+$/.test(s)) return null
  return BigInt(s)
}

/** a/b as a number, for big integers (a ≤ b in practice). */
const ratio = (a: bigint, b: bigint): number => (b === 0n ? 0 : Number((a * 1_000_000_000n) / b) / 1e9)

/**
 * Token actions from swap legs: per wallet and transaction, each token's net amount (exact, as big
 * integers), so a route through an intermediate token nets it out. Currency tokens (NEAR, stablecoins)
 * are the money, never a position. Sales come before purchases within a transaction; transactions in
 * the order of their first leg.
 */
export function actionsOf(trades: readonly RawTrade[], currency: ReadonlySet<string>): TokenAction[] {
  type Group = {
    trader: string
    tx: string
    ts: number
    id: number
    net: Map<string, bigint>
    grossIn: Map<string, bigint>
    grossOut: Map<string, bigint>
    usdIn: Map<string, number | null>
    usdOut: Map<string, number | null>
  }
  const groups = new Map<string, Group>()
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v)
  const addUsd = (m: Map<string, number | null>, k: string, v: number | null) => {
    const prev = m.has(k) ? (m.get(k) as number | null) : 0
    m.set(k, prev === null || v === null ? null : prev + v)
  }
  for (const t of trades) {
    const amountIn = toBig(t.amountIn)
    const amountOut = toBig(t.amountOut)
    if (!t.tokenIn || !t.tokenOut || amountIn === null || amountOut === null) continue
    const key = `${t.trader}\u0000${t.tx}`
    let g = groups.get(key)
    if (!g) {
      g = { trader: t.trader, tx: t.tx, ts: t.ts, id: t.id, net: new Map(), grossIn: new Map(), grossOut: new Map(), usdIn: new Map(), usdOut: new Map() }
      groups.set(key, g)
    }
    if (t.ts < g.ts || (t.ts === g.ts && t.id < g.id)) {
      g.ts = t.ts
      g.id = t.id
    }
    add(g.net, t.tokenIn, -amountIn)
    add(g.net, t.tokenOut, amountOut)
    add(g.grossIn, t.tokenIn, amountIn)
    add(g.grossOut, t.tokenOut, amountOut)
    addUsd(g.usdIn, t.tokenIn, t.usd)
    addUsd(g.usdOut, t.tokenOut, t.usd)
  }
  const out: TokenAction[] = []
  for (const g of [...groups.values()].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
    const sells: TokenAction[] = []
    const buys: TokenAction[] = []
    for (const [token, net] of g.net) {
      if (net === 0n || currency.has(token)) continue
      const base = { trader: g.trader, token, ts: g.ts, tx: g.tx, id: g.id }
      if (net < 0n) {
        const usd = g.usdIn.get(token) ?? null
        sells.push({ ...base, side: 'sell', qty: Number(-net), usd: usd === null ? null : usd * ratio(-net, g.grossIn.get(token) ?? -net) })
      } else {
        const usd = g.usdOut.get(token) ?? null
        buys.push({ ...base, side: 'buy', qty: Number(net), usd: usd === null ? null : usd * ratio(net, g.grossOut.get(token) ?? net) })
      }
    }
    out.push(...sells, ...buys)
  }
  return out
}

/** A wallet's position in one token, and its running totals. */
export interface Position {
  /** Units of known cost, and their cost (USD). */
  qty: number
  cost: number
  /** Units of unknown cost (bought without a price). */
  unknownQty: number
  /** When the open position was opened (its first buy since it was last flat). */
  openSince: number | null
  realized: number
  closed: number
  wins: number
  holdMs: number
  holds: number
  buys: number
  sells: number
  buyUsd: number
  sellUsd: number
  firstBuyAt: number | null
  lastAt: number | null
}

export const emptyPosition = (): Position => ({
  qty: 0,
  cost: 0,
  unknownQty: 0,
  openSince: null,
  realized: 0,
  closed: 0,
  wins: 0,
  holdMs: 0,
  holds: 0,
  buys: 0,
  sells: 0,
  buyUsd: 0,
  sellUsd: 0,
  firstBuyAt: null,
  lastAt: null,
})

/** What one action did, for the daily rows. */
export interface Effect {
  realized: number
  /** Cost basis of the units sold with a known cost (the return's denominator). */
  costClosed: number
  closed: 0 | 1
  win: 0 | 1
  gain: number
  loss: number
  /** Sale value of units with no indexed or priced purchase: never profit. */
  unmatchedUsd: number
  unpriced: 0 | 1
  /** The holding time of a position this sale closed. */
  holdMs: number | null
  buyUsd: number
  sellUsd: number
}

/** A position under this share of what it held is closed (dust after a sale). */
const DUST = 1e-6

/** One action on a position (weighted average cost). */
export function applyAction(before: Position, a: TokenAction): { position: Position; effect: Effect } {
  const p: Position = { ...before, lastAt: a.ts }
  const e: Effect = { realized: 0, costClosed: 0, closed: 0, win: 0, gain: 0, loss: 0, unmatchedUsd: 0, unpriced: 0, holdMs: null, buyUsd: 0, sellUsd: 0 }
  if (!(a.qty > 0)) return { position: p, effect: e }
  if (a.side === 'buy') {
    p.buys += 1
    if (p.openSince === null) p.openSince = a.ts
    p.firstBuyAt ??= a.ts
    if (a.usd === null) {
      p.unknownQty += a.qty
      e.unpriced = 1
    } else {
      p.qty += a.qty
      p.cost += a.usd
      p.buyUsd += a.usd
      e.buyUsd = a.usd
    }
    return { position: p, effect: e }
  }
  // A sale: units of known cost first, then units of unknown cost, then units never seen bought.
  p.sells += 1
  const held = p.qty + p.unknownQty
  const matched = Math.min(a.qty, p.qty)
  const fromUnknown = Math.min(a.qty - matched, p.unknownQty)
  const costSold = p.qty > 0 ? (p.cost * matched) / p.qty : 0
  if (a.usd === null) {
    e.unpriced = 1
  } else {
    p.sellUsd += a.usd
    e.sellUsd = a.usd
    e.unmatchedUsd = (a.usd * (a.qty - matched)) / a.qty
    if (matched > 0) {
      const proceeds = (a.usd * matched) / a.qty
      const realized = proceeds - costSold
      e.realized = realized
      e.costClosed = costSold
      e.closed = 1
      e.win = realized > 0 ? 1 : 0
      e.gain = realized > 0 ? realized : 0
      e.loss = realized < 0 ? -realized : 0
      p.realized += realized
      p.closed += 1
      p.wins += e.win
    }
  }
  p.qty -= matched
  p.cost -= costSold
  p.unknownQty -= fromUnknown
  const left = p.qty + p.unknownQty
  if (held > 0 && left <= held * DUST) {
    if (p.openSince !== null) {
      e.holdMs = a.ts - p.openSince
      p.holdMs += e.holdMs
      p.holds += 1
    }
    p.qty = 0
    p.cost = 0
    p.unknownQty = 0
    p.openSince = null
  }
  return { position: p, effect: e }
}

/** The UTC day a time falls on (days since 1970-01-01). */
export const dayOf = (ms: number): number => Math.floor(ms / 86_400_000)
