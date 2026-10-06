import type { TradeSide } from './types'

/**
 * The Volume Bot's accounting, in NEAR: average cost, realized and unrealized PnL, and the
 * inventory split between NEAR and the token. Fills carry what actually moved: a buy's `near` is
 * what it spent (the NearKit fee inside it), a sell's `near` is what it received (after the fee),
 * so fees count once, through the amounts; `feeNear` is kept for reporting only. Gas is a cost of
 * its own and comes off PnL.
 */

export interface Book {
  tokens: number
  /** Cost basis of the tokens held. */
  costNear: number
  realizedNear: number
  feesNear: number
  gasNear: number
  volumeNear: number
  buys: number
  sells: number
}

export interface Fill {
  side: TradeSide
  tokens: number
  near: number
  feeNear: number
  gasNear: number
}

export function emptyBook(): Book {
  return { tokens: 0, costNear: 0, realizedNear: 0, feesNear: 0, gasNear: 0, volumeNear: 0, buys: 0, sells: 0 }
}

/** The inventory a run starts with, marked at the start price: PnL measures the bot from there. */
export function openBook(tokens: number, markPriceNear: number): Book {
  return { ...emptyBook(), tokens, costNear: tokens * markPriceNear }
}

export function applyFill(b: Book, f: Fill): Book {
  const common = { feesNear: b.feesNear + f.feeNear, gasNear: b.gasNear + f.gasNear, volumeNear: b.volumeNear + f.near }
  if (f.side === 'buy') return { ...b, ...common, tokens: b.tokens + f.tokens, costNear: b.costNear + f.near, buys: b.buys + 1 }
  const sold = Math.min(f.tokens, b.tokens)
  const avg = b.tokens > 0 ? b.costNear / b.tokens : 0
  const cost = avg * sold
  const rest = b.tokens - sold
  return {
    ...b,
    ...common,
    tokens: rest,
    costNear: rest > 0 ? b.costNear - cost : 0,
    realizedNear: b.realizedNear + f.near - cost,
    sells: b.sells + 1,
  }
}

export function avgCostNear(b: Book): number | null {
  return b.tokens > 0 ? b.costNear / b.tokens : null
}

export function unrealizedNear(b: Book, priceNear: number): number {
  return b.tokens * priceNear - b.costNear
}

/** Realized plus unrealized, less gas. */
export function pnlNear(b: Book, priceNear: number): number {
  return b.realizedNear + unrealizedNear(b, priceNear) - b.gasNear
}

export interface Inventory {
  near: number
  tokens: number
  tokenValueNear: number
  totalNear: number
  /** The token's share of the total value, in %. */
  tokenPct: number
}

export function inventoryOf(wallets: readonly { near: number; tokens: number }[], priceNear: number): Inventory {
  const near = wallets.reduce((s, w) => s + w.near, 0)
  const tokens = wallets.reduce((s, w) => s + w.tokens, 0)
  const tokenValueNear = tokens * priceNear
  const totalNear = near + tokenValueNear
  return { near, tokens, tokenValueNear, totalNear, tokenPct: totalNear > 0 ? (tokenValueNear / totalNear) * 100 : 0 }
}

/** One wallet's token share of its own value, in %. */
export function walletTokenPct(w: { near: number; tokens: number }, priceNear: number): number {
  return inventoryOf([w], priceNear).tokenPct
}
