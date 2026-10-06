import { MIN_EDGE_BPS } from './config'
import { inventoryOf, walletTokenPct, type Inventory } from './inventory'
import type { BotConfig, BotWallet, FairValue, Intent, MarketSnapshot, RiskConfig, RunProgress, SizingConfig, TradeQuote, TradeSide } from './types'

/**
 * The Volume Bot's strategies: what to do at a tick, from the market, fair value, the wallets and the
 * run so far. Pure: the worker brings the readings and executes the answer.
 *
 * - The market maker trades only against fair value: it buys when the executable price (after every
 *   fee and its own impact) is below fair value by its edge, and sells when it is above by its edge;
 *   inventory away from target leans the edges toward rebalancing. Inside the band it does nothing:
 *   a trade there would lose its costs. It never trades on a timer for the sake of trading.
 * - Accumulate and distribute spread one direction over a period (TWAP), under a price limit.
 */

/** Fair value needs this many readings before the market maker trusts it. */
export const MIN_FAIR_SAMPLES = 5
/** A trade below this NEAR value costs more in gas than it is worth: never sent. */
export const MIN_TRADE_NEAR = 0.01

/** Exponential average of the mid price, weighted by time: a reading counts more the longer since the last. */
export function updateFairValue(prev: FairValue | null, price: number, at: number, windowSec: number): FairValue {
  if (!prev || !(prev.value > 0)) return { value: price, at, samples: 1 }
  const dt = Math.max(0, at - prev.at) / 1000
  const alpha = 1 - Math.exp(-dt / Math.max(1, windowSec))
  return { value: prev.value + alpha * (price - prev.value), at, samples: prev.samples + 1 }
}

/** How far from fair value each side must be: the base edge, leaned by inventory away from target, never below the floor. */
export function edgesFor(config: BotConfig, tokenPct: number): { buyEdgeBps: number; sellEdgeBps: number } {
  const { minTokenPct, maxTokenPct, targetTokenPct } = config.inventory
  const half = Math.max(1, (maxTokenPct - minTokenPct) / 2)
  const d = Math.max(-1, Math.min(1, (tokenPct - targetTokenPct) / half))
  const e = config.marketMaker.minEdgeBps
  const k = config.marketMaker.skew
  return { buyEdgeBps: Math.max(MIN_EDGE_BPS, e * (1 + k * d)), sellEdgeBps: Math.max(MIN_EDGE_BPS, e * (1 - k * d)) }
}

export interface DecideInput {
  config: BotConfig
  market: MarketSnapshot
  fair: FairValue | null
  wallets: readonly BotWallet[]
  progress: RunProgress
  now: number
  /** 0 ≤ r < 1: sizes drawn within a range. */
  random: () => number
}

const wait = (reason: string): Intent => ({ kind: 'wait', reason })
const fmt = (n: number) => (n >= 1 ? n.toFixed(4) : n.toPrecision(4))

/** The token value (NEAR) the bot may still add, and the value it may still take off, by its inventory and exposure limits. */
function rooms(config: BotConfig, inv: Inventory): { buy: number; sell: number } {
  const total = inv.totalNear
  const most = Math.min((total * config.inventory.maxTokenPct) / 100, (total * config.risk.maxAggregateExposurePct) / 100, config.inventory.maxNearDeployed)
  const least = (total * config.inventory.minTokenPct) / 100
  return { buy: Math.max(0, most - inv.tokenValueNear), sell: Math.max(0, inv.tokenValueNear - least) }
}

/** NEAR a wallet can spend on a buy: what it holds above its gas reserve. */
const spendable = (w: BotWallet, risk: RiskConfig) => Math.max(0, w.near - risk.gasReserveNear)

/** The wallet best able to fill a side: the most NEAR to spend for a buy, the most tokens for a sell. Busy and frozen wallets wait. */
function pickWallet(wallets: readonly BotWallet[], side: TradeSide, risk: RiskConfig): BotWallet | null {
  const usable = wallets.filter((w) => !w.frozen && !w.busy)
  const capacity = (w: BotWallet) => (side === 'buy' ? spendable(w, risk) : w.tokens)
  const best = usable.reduce<BotWallet | null>((top, w) => (top === null || capacity(w) > capacity(top) ? w : top), null)
  return best && capacity(best) > 0 ? best : null
}

/** The trade's base size by the sizing mode (NEAR value); `auto` is `auto` (TWAP) or the fixed size. */
function baseSize(s: SizingConfig, ctx: { auto: number | null; walletCapital: number; inventoryNear: number; random: () => number }): number {
  switch (s.mode) {
    case 'auto':
      return ctx.auto ?? s.fixedNear
    case 'fixed':
      return s.fixedNear
    case 'range':
      return s.minNear + ctx.random() * Math.max(0, s.maxNear - s.minNear)
    case 'capital-pct':
      return (ctx.walletCapital * s.pct) / 100
    case 'inventory-pct':
      return (ctx.inventoryNear * s.pct) / 100
  }
}

/** Never larger than the trade cap, the wallet, the strategy's room, the wallet's own exposure room (buys) and the pool's liquidity share. */
function capSize(size: number, caps: { config: BotConfig; side: TradeSide; wallet: BotWallet; price: number; room: number; market: MarketSnapshot }): number {
  const { config, side, wallet, price, room, market } = caps
  const limits = [size, config.risk.maxTradeNear, room]
  if (side === 'buy') {
    limits.push(spendable(wallet, config.risk))
    // A buy turns the wallet's NEAR into token: its own token share must stay within its cap.
    const walletTotal = wallet.near + wallet.tokens * price
    limits.push(Math.max(0, (walletTotal * config.risk.maxWalletExposurePct) / 100 - wallet.tokens * price))
  } else limits.push(wallet.tokens * price)
  if (config.sizing.maxLiquidityPct > 0 && market.liquidityUsd !== null && market.nearUsd !== null && market.nearUsd > 0)
    limits.push((market.liquidityUsd * config.sizing.maxLiquidityPct) / 100 / market.nearUsd)
  return Math.max(0, Math.min(...limits))
}

function marketMaker(i: DecideInput): Intent {
  const { config, market, fair, wallets } = i
  if (!fair || fair.samples < MIN_FAIR_SAMPLES) return wait(`Learning fair value (${fair?.samples ?? 0} of ${MIN_FAIR_SAMPLES} readings)`)
  const inv = inventoryOf(
    wallets.filter((w) => !w.frozen),
    market.midNear,
  )
  const { buyEdgeBps, sellEdgeBps } = edgesFor(config, inv.tokenPct)
  const buyMax = fair.value * (1 - buyEdgeBps / 10_000)
  const sellMin = fair.value * (1 + sellEdgeBps / 10_000)
  const room = rooms(config, inv)
  const canBuy = market.askNear !== null && market.askNear <= buyMax && room.buy >= MIN_TRADE_NEAR
  const canSell = market.bidNear !== null && market.bidNear >= sellMin && room.sell >= MIN_TRADE_NEAR
  if (!canBuy && !canSell) return wait(`Price within the band around fair value (buys under ${fmt(buyMax)}, sells over ${fmt(sellMin)} NEAR)`)
  const buyGap = canBuy ? (buyMax - (market.askNear as number)) / fair.value : -1
  const sellGap = canSell ? ((market.bidNear as number) - sellMin) / fair.value : -1
  const side: TradeSide = buyGap >= sellGap ? 'buy' : 'sell'
  const price = side === 'buy' ? (market.askNear as number) : (market.bidNear as number)
  const wallet = pickWallet(wallets, side, config.risk)
  if (!wallet) return wait(side === 'buy' ? 'No wallet has NEAR to spend above its gas reserve' : 'No wallet holds the token to sell')
  const base = baseSize(config.sizing, {
    auto: null,
    walletCapital: side === 'buy' ? spendable(wallet, config.risk) : wallet.tokens * price,
    inventoryNear: inv.tokenValueNear,
    random: i.random,
  })
  const sizeNear = capSize(base, { config, side, wallet, price, room: side === 'buy' ? room.buy : room.sell, market })
  if (sizeNear < MIN_TRADE_NEAR) return wait('The trade it would make is too small to be worth its gas')
  return {
    kind: 'trade',
    side,
    walletId: wallet.walletId,
    sizeNear,
    reason:
      side === 'buy'
        ? `Price ${fmt(price)} is under fair value ${fmt(fair.value)} by more than its edge`
        : `Price ${fmt(price)} is over fair value ${fmt(fair.value)} by more than its edge`,
    maxPriceNear: side === 'buy' ? buyMax : null,
    minPriceNear: side === 'sell' ? sellMin : null,
  }
}

function twap(i: DecideInput, side: TradeSide): Intent {
  const { config, market, wallets, progress, now } = i
  const t = config.twap
  const elapsed = now - progress.startedAt
  const price = side === 'buy' ? (market.askNear ?? market.midNear) : (market.bidNear ?? market.midNear)
  const remainingNear = side === 'buy' ? t.totalNear - progress.boughtNear : (t.totalTokens - progress.soldTokens) * price
  if (remainingNear < MIN_TRADE_NEAR) return { kind: 'complete', reason: side === 'buy' ? 'Spent its budget' : 'Sold its amount' }
  if (elapsed >= t.durationSec * 1000) return { kind: 'complete', reason: 'Its period ended' }
  if (t.limitPriceNear !== null && side === 'buy' && price > t.limitPriceNear) return wait(`Price ${fmt(price)} is above your limit of ${fmt(t.limitPriceNear)} NEAR`)
  if (t.limitPriceNear !== null && side === 'sell' && price < t.limitPriceNear) return wait(`Price ${fmt(price)} is below your floor of ${fmt(t.limitPriceNear)} NEAR`)
  const avgMs = ((config.schedule.minIntervalSec + config.schedule.maxIntervalSec) / 2) * 1000
  const slicesLeft = Math.max(1, Math.ceil((t.durationSec * 1000 - elapsed) / Math.max(1, avgMs)))
  const inv = inventoryOf(
    wallets.filter((w) => !w.frozen),
    market.midNear,
  )
  const wallet = pickWallet(wallets, side, config.risk)
  if (!wallet) return wait(side === 'buy' ? 'No wallet has NEAR to spend above its gas reserve' : 'No wallet holds the token to sell')
  const base = baseSize(config.sizing, {
    auto: remainingNear / slicesLeft,
    walletCapital: side === 'buy' ? spendable(wallet, config.risk) : wallet.tokens * price,
    inventoryNear: inv.tokenValueNear,
    random: i.random,
  })
  const room = rooms(config, inv)
  const sizeNear = capSize(Math.min(base, remainingNear), { config, side, wallet, price, room: side === 'buy' ? room.buy : room.sell, market })
  if (sizeNear < MIN_TRADE_NEAR) return wait('The slice it would trade is too small to be worth its gas')
  return {
    kind: 'trade',
    side,
    walletId: wallet.walletId,
    sizeNear,
    reason: `${side === 'buy' ? 'Accumulating' : 'Distributing'}: slice of ${slicesLeft} left`,
    maxPriceNear: side === 'buy' ? t.limitPriceNear : null,
    minPriceNear: side === 'sell' ? t.limitPriceNear : null,
  }
}

/** The strategy's answer at a tick: a trade to quote, a wait (and why), or the run's end. */
export function decide(i: DecideInput): Intent {
  switch (i.config.strategy) {
    case 'market-maker':
      return marketMaker(i)
    case 'accumulate':
      return twap(i, 'buy')
    case 'distribute':
      return twap(i, 'sell')
  }
}

export type QuoteVerdict = { ok: true } | { ok: false; action: 'skip' | 'shrink'; reason: string }

/**
 * Whether a quote may be executed: fresh, within the price-impact limit (or, with adaptive sizing, to
 * be tried smaller), and at a price that still meets the strategy's (after every fee and the trade's
 * own impact). The swap's own minimum output (slippage) protects the rest on chain.
 */
export function acceptQuote(
  intent: Extract<Intent, { kind: 'trade' }>,
  quote: TradeQuote,
  risk: RiskConfig,
  sizing: SizingConfig,
  now: number,
  /** The bot's own tiny probe quotes (the market snapshot): the price before this trade's own impact. */
  probe?: Pick<MarketSnapshot, 'askNear' | 'bidNear'>,
): QuoteVerdict {
  if (now - quote.at > risk.maxQuoteAgeSec * 1000) return { ok: false, action: 'skip', reason: 'Stale quote: older than its limit' }
  // The router's own figure; without one (no USD price for the token), against the probe: a buy paying
  // more per token than the probe, or a sell getting less, is what this trade's size moves the price.
  const reference = quote.side === 'buy' ? probe?.askNear : probe?.bidNear
  const impactBps =
    quote.priceImpactBps ??
    (reference && reference > 0 && quote.priceNear > 0 ? Math.max(0, (quote.side === 'buy' ? quote.priceNear / reference - 1 : 1 - quote.priceNear / reference) * 10_000) : null)
  if (impactBps === null) return { ok: false, action: 'skip', reason: 'Price impact can’t be measured for this quote: no price to compare it with' }
  if (impactBps > risk.maxPriceImpactBps)
    return sizing.adaptiveImpact
      ? { ok: false, action: 'shrink', reason: `Price impact ${(impactBps / 100).toFixed(2)}% is over the limit: trying smaller` }
      : { ok: false, action: 'skip', reason: `Price impact ${(impactBps / 100).toFixed(2)}% is over the limit` }
  if (intent.side === 'buy' && intent.maxPriceNear !== null && quote.priceNear > intent.maxPriceNear)
    return { ok: false, action: 'skip', reason: `Its executable price ${fmt(quote.priceNear)} is above the strategy’s ${fmt(intent.maxPriceNear)}` }
  if (intent.side === 'sell' && intent.minPriceNear !== null && quote.priceNear < intent.minPriceNear)
    return { ok: false, action: 'skip', reason: `Its executable price ${fmt(quote.priceNear)} is below the strategy’s ${fmt(intent.minPriceNear)}` }
  return { ok: true }
}

/** A wallet's token share (for the dashboard's exposure column). */
export const exposurePct = walletTokenPct
