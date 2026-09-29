/**
 * NearKit's one PnL engine. Positions, the PnL page, the Telegram bot and any PnL
 * card compute through `computePnl`, so the method can't drift between screens.
 *
 * METHOD: weighted average cost, per token, per account, in two currencies side by
 * side: NEAR (exact, from on-chain amounts) and USD (from NEAR/USD at each trade).
 *
 * - COST BASIS: what was paid for the units still held, as far as it is known. A buy
 *   adds its full value (fees included: values are what actually moved, so NearKit's
 *   fee, Rhea's fees and the gas the account paid are all in them).
 * - AVERAGE ENTRY: cost basis ÷ units with a known cost.
 * - REALIZED PNL: for each sale, proceeds minus the average cost of the units sold.
 * - UNREALIZED PNL: units with a known cost × current price, minus their cost basis.
 * - TOTAL PNL: realized + unrealized.
 * - PNL %: total PnL ÷ everything invested (the sum of all known buy costs).
 * - Units that arrived by transfer have no known cost. They are tracked apart and never
 *   given a guessed cost: a sale takes known and unknown units in proportion, and the
 *   unknown part's proceeds are reported as "unmatched", outside realized PnL.
 * - A transfer out removes units at average cost; nothing is realized.
 * - Selling more than the history holds means history is missing: flagged, and the
 *   position never goes below zero.
 * Every flag that makes a figure partial is listed in `limitations`.
 */

export interface EventValue {
  /** yoctoNEAR paid (buy) or received (sell); null when not known in NEAR. */
  near: bigint | null
  /** USD at the time; null when not known. */
  usd: number | null
}

export type LedgerEvent =
  | { kind: 'buy'; at: number; tx: string; amount: bigint; value: EventValue }
  | { kind: 'sell'; at: number; tx: string; amount: bigint; value: EventValue }
  | { kind: 'transfer-in'; at: number; tx: string; amount: bigint; counterparty: string | null }
  | { kind: 'transfer-out'; at: number; tx: string; amount: bigint; counterparty: string | null }

/** Current price per whole token. */
export interface CurrentPrice {
  near: number | null
  usd: number | null
  decimals: number
}

export type Limitation = 'unknown-cost-units' | 'unknown-proceeds' | 'history-incomplete' | 'no-current-price'

export interface CurrencyPnl<T> {
  /** Cost of the units still held whose cost is known. */
  costBasis: T
  /** Per whole token; null without known-cost units. */
  avgEntry: number | null
  realized: T
  /** Null without a current price. */
  unrealized: T | null
  total: T | null
  /** Sum of every known buy cost. */
  invested: T
  pnlPct: number | null
  /** Proceeds from selling units whose cost was unknown: not counted as profit. */
  unmatchedProceeds: T
  /** Every unit and trade has a known value in this currency. */
  complete: boolean
}

/** One sale, with the realized PnL of its known-cost part (null when its proceeds are unknown). */
export interface Sale {
  at: number
  tx: string
  amount: bigint
  proceedsNear: bigint | null
  costNear: bigint
  realizedNear: bigint | null
  proceedsUsd: number | null
  costUsd: number
  realizedUsd: number | null
}

export interface PnlResult {
  quantity: bigint
  /** Units held whose cost is unknown in NEAR (arrived by transfer, or paid in something unpriced). */
  unknownCostQuantity: bigint
  bought: { quantity: bigint; near: bigint | null; usd: number | null }
  sold: { quantity: bigint; near: bigint | null; usd: number | null }
  transferredIn: bigint
  transferredOut: bigint
  trades: number
  near: CurrencyPnl<bigint>
  usd: CurrencyPnl<number>
  /** Everything was sold or sent away. */
  closed: boolean
  /** NEAR figures cover every unit and trade (the primary figures). */
  complete: boolean
  limitations: Limitation[]
  firstAt: number | null
  lastAt: number | null
  sales: Sale[]
}

interface Arith<T> {
  zero: T
  add(a: T, b: T): T
  sub(a: T, b: T): T
  /** a × num ÷ den (floor for bigint). */
  part(a: T, num: bigint, den: bigint): T
  ratio(a: T, b: T): number
  isZero(a: T): boolean
  /** As a plain number in whole currency units (NEAR, USD). */
  display(a: T): number
}

const BIG: Arith<bigint> = {
  zero: 0n,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  part: (a, num, den) => (den === 0n ? 0n : (a * num) / den),
  ratio: (a, b) => (b === 0n ? 0 : Number((a * 10n ** 12n) / b) / 1e12),
  isZero: (a) => a === 0n,
  display: (a) => Number(a) / 1e24,
}

const NUM: Arith<number> = {
  zero: 0,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  part: (a, num, den) => (den === 0n ? 0 : (a * Number(num)) / Number(den)),
  ratio: (a, b) => (b === 0 ? 0 : a / b),
  isZero: (a) => a === 0,
  display: (a) => a,
}

/** A decimal number as an exact scaled integer (15 significant digits), e.g. 0.15 NEAR → 15 × 10^22 yocto. */
export function scaled(value: number, scale: number): bigint {
  if (!Number.isFinite(value) || value === 0) return 0n
  const [mantissa = '0', exp = '0'] = Math.abs(value).toExponential(14).split('e')
  const digits = BigInt(mantissa.replace('.', ''))
  const shift = Number(exp) - 14 + scale
  const v = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift)
  return value < 0 ? -v : v
}

/** One currency's book for one token: known-cost units, their cost, and what was realized. */
class Book<T> {
  knownQty = 0n
  cost: T
  realized: T
  invested: T
  unmatched: T
  complete = true
  constructor(private readonly m: Arith<T>) {
    this.cost = m.zero
    this.realized = m.zero
    this.invested = m.zero
    this.unmatched = m.zero
  }

  buy(amount: bigint, value: T | null) {
    if (value === null) {
      this.complete = false
      return
    }
    this.knownQty += amount
    this.cost = this.m.add(this.cost, value)
    this.invested = this.m.add(this.invested, value)
  }

  unknownIn() {
    this.complete = false
  }

  /**
   * Removes `amount` of the `held` units, known and unknown in proportion.
   * `proceeds`: a sale's value for those units (null: unknown); undefined: a transfer.
   * `excess`: proceeds of units sold beyond what the history holds.
   */
  remove(amount: bigint, held: bigint, proceeds: T | null | undefined, excess: T | null): { costSold: T; realized: T | null } {
    const soldKnown = held === 0n ? 0n : (this.knownQty * amount) / held
    const costSold = this.knownQty === 0n ? this.m.zero : this.m.part(this.cost, soldKnown, this.knownQty)
    let realized: T | null = null
    if (proceeds === null) this.complete = false
    else if (proceeds !== undefined) {
      const known = amount === 0n ? this.m.zero : this.m.part(proceeds, soldKnown, amount)
      realized = this.m.sub(known, costSold)
      this.realized = this.m.add(this.realized, realized)
      if (soldKnown < amount) {
        this.unmatched = this.m.add(this.unmatched, this.m.sub(proceeds, known))
        this.complete = false
      }
    }
    if (excess !== null) this.unmatched = this.m.add(this.unmatched, excess)
    this.knownQty -= soldKnown
    this.cost = this.m.sub(this.cost, costSold)
    return { costSold, realized }
  }

  figures(unit: bigint, valueOfKnown: T | null): CurrencyPnl<T> {
    const unrealized = valueOfKnown === null ? null : this.m.sub(valueOfKnown, this.cost)
    const total = unrealized === null ? null : this.m.add(this.realized, unrealized)
    return {
      costBasis: this.cost,
      avgEntry: this.knownQty === 0n ? null : this.m.display(this.m.part(this.cost, unit, this.knownQty)),
      realized: this.realized,
      unrealized,
      total,
      invested: this.invested,
      pnlPct: total === null || this.m.isZero(this.invested) ? null : this.m.ratio(total, this.invested) * 100,
      unmatchedProceeds: this.unmatched,
      complete: this.complete,
    }
  }
}

export function computePnl(input: readonly LedgerEvent[], price: CurrentPrice | null): PnlResult {
  const events = [...input].sort((a, b) => a.at - b.at)
  const near = new Book(BIG)
  const usd = new Book(NUM)
  const limits = new Set<Limitation>()
  let qty = 0n
  const bought = { quantity: 0n, near: 0n as bigint | null, usd: 0 as number | null }
  const sold = { quantity: 0n, near: 0n as bigint | null, usd: 0 as number | null }
  let transferredIn = 0n
  let transferredOut = 0n
  let trades = 0
  const sales: Sale[] = []

  for (const e of events) {
    if (e.kind === 'buy') {
      trades += 1
      near.buy(e.amount, e.value.near)
      usd.buy(e.amount, e.value.usd)
      if (e.value.near === null) limits.add('unknown-cost-units')
      qty += e.amount
      bought.quantity += e.amount
      bought.near = bought.near === null || e.value.near === null ? null : bought.near + e.value.near
      bought.usd = bought.usd === null || e.value.usd === null ? null : bought.usd + e.value.usd
    } else if (e.kind === 'transfer-in') {
      near.unknownIn()
      usd.unknownIn()
      limits.add('unknown-cost-units')
      qty += e.amount
      transferredIn += e.amount
    } else {
      const effective = e.amount > qty ? qty : e.amount
      const excess = e.amount - effective
      if (excess > 0n) limits.add('history-incomplete')
      if (e.kind === 'sell') {
        trades += 1
        const nearProceeds = e.value.near === null ? null : BIG.part(e.value.near, effective, e.amount)
        const usdProceeds = e.value.usd === null ? null : NUM.part(e.value.usd, effective, e.amount)
        const n = near.remove(effective, qty, nearProceeds, excess > 0n && e.value.near !== null ? e.value.near - (nearProceeds as bigint) : null)
        const u = usd.remove(effective, qty, usdProceeds, excess > 0n && e.value.usd !== null ? e.value.usd - (usdProceeds as number) : null)
        sales.push({
          at: e.at,
          tx: e.tx,
          amount: e.amount,
          proceedsNear: e.value.near,
          costNear: n.costSold,
          realizedNear: n.realized,
          proceedsUsd: e.value.usd,
          costUsd: u.costSold,
          realizedUsd: u.realized,
        })
        if (e.value.near === null) limits.add('unknown-proceeds')
        sold.quantity += e.amount
        sold.near = sold.near === null || e.value.near === null ? null : sold.near + e.value.near
        sold.usd = sold.usd === null || e.value.usd === null ? null : sold.usd + e.value.usd
      } else {
        near.remove(effective, qty, undefined, null)
        usd.remove(effective, qty, undefined, null)
        transferredOut += e.amount
      }
      if (excess > 0n) {
        near.complete = false
        usd.complete = false
      }
      qty -= effective
    }
  }

  const unit = 10n ** BigInt(price?.decimals ?? 0)
  if (!price || price.near === null) limits.add('no-current-price')
  const nearValue = price && price.near !== null ? (near.knownQty * scaled(price.near, 24)) / unit : null
  const usdValue = price && price.usd !== null ? (Number(usd.knownQty) / Number(unit)) * price.usd : null

  return {
    quantity: qty,
    unknownCostQuantity: qty - near.knownQty,
    bought,
    sold,
    transferredIn,
    transferredOut,
    trades,
    near: near.figures(unit, nearValue),
    usd: usd.figures(unit, usdValue),
    closed: qty === 0n && events.length > 0,
    complete: near.complete,
    limitations: [...limits],
    firstAt: events[0]?.at ?? null,
    lastAt: events.at(-1)?.at ?? null,
    sales,
  }
}
