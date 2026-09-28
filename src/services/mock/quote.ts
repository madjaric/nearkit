import { GAS_RESERVE_NEAR, NEARKIT_FEE_BPS, NETWORK_FEE_NEAR_PER_TX, nearkitFee } from '@/lib/fees'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { MultiTradeQuote, MultiTradeRequest, Quote, QuoteRequest } from '@/types/domain'
import { ServiceError, balanceOf, nearPrice, priceOf, tokenOf, type MockState } from './state'

export const QUOTE_TTL_MS = 15_000

/** Demo math runs on display numbers; a malformed string is 0 and fails validation. */
function demoNumber(text: string): number {
  return /^[0-9]*\.?[0-9]*$/.test(text.trim()) ? Number(text.trim()) || 0 : 0
}
const NEAR = TOKEN_IDS.near

/** Constant-product style impact against half the pool's USD depth. Demo model, not a router. */
function impactFraction(state: MockState, tokenId: string, usd: number): number {
  if (tokenId === NEAR) return 0
  const liquidity = state.market.get(tokenId)?.liquidityUsd ?? 0
  if (liquidity <= 0) return 0
  return Math.min(0.5, usd / (liquidity / 2))
}

function clampSlippage(pct: number): number {
  return Math.min(Math.max(pct, 0), 50) / 100
}

/**
 * Every swap is priced through NEAR: tokenIn → NEAR → tokenOut. The NearKit fee
 * (2.00%) is taken on the NEAR leg: from the input on buys, from proceeds on sells.
 */
export function computeQuote(state: MockState, request: QuoteRequest, now = Date.now()): Quote {
  const tokenIn = tokenOf(state, request.tokenIn)
  const tokenOut = tokenOf(state, request.tokenOut)
  if (tokenIn.id === tokenOut.id) throw new ServiceError('invalid-pair', 'Pick two different tokens')
  const amountIn = demoNumber(request.amountIn)
  if (!(amountIn > 0)) throw new ServiceError('invalid-amount', 'Enter an amount greater than 0')
  const slip = clampSlippage(request.slippagePct)
  const nearUsd = nearPrice(state)

  // Leg 1: tokenIn → NEAR
  let nearGross: number
  let impactIn = 0
  if (tokenIn.id === NEAR) {
    nearGross = amountIn
  } else {
    const usdIn = amountIn * priceOf(state, tokenIn.id)
    impactIn = impactFraction(state, tokenIn.id, usdIn)
    nearGross = (usdIn * (1 - impactIn)) / nearUsd
  }
  const feeNear = nearkitFee(nearGross)
  const nearNet = nearGross - feeNear

  // Leg 2: NEAR → tokenOut
  let amountOut: number
  let impactOut = 0
  if (tokenOut.id === NEAR) {
    amountOut = nearNet
  } else {
    const usd = nearNet * nearUsd
    impactOut = impactFraction(state, tokenOut.id, usd)
    amountOut = usd / (priceOf(state, tokenOut.id) * (1 + impactOut))
  }

  const hops = tokenIn.id !== NEAR && tokenOut.id !== NEAR
  return {
    request,
    amountOut,
    minAmountOut: amountOut * (1 - slip),
    amountOutRaw: null,
    minAmountOutRaw: null,
    rate: amountOut / amountIn,
    priceImpactPct: (1 - (1 - impactIn) / (1 + impactOut)) * 100,
    nearkitFee: { amountNear: feeNear, amountUsd: feeNear * nearUsd, bps: NEARKIT_FEE_BPS, charged: false, receivedBps: null, routerShareBps: null, routerFeeBps: null },
    networkFeeNear: NETWORK_FEE_NEAR_PER_TX * (hops ? 2 : 1),
    path: hops ? [tokenIn.symbol, 'NEAR', tokenOut.symbol] : [tokenIn.symbol, tokenOut.symbol],
    router: 'demo',
    quotedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  }
}

/** Legs are quoted against the combined size: they hit the same pool back to back. */
export function computeMultiQuote(state: MockState, request: MultiTradeRequest, now = Date.now()): MultiTradeQuote {
  const token = tokenOf(state, request.tokenId)
  if (token.isNative) throw new ServiceError('invalid-pair', 'Choose a token other than NEAR')
  const legs = request.legs.map((leg) => ({ ...leg, amountInValue: demoNumber(leg.amountIn) })).filter((leg) => leg.amountInValue > 0)
  if (legs.length === 0) throw new ServiceError('invalid-amount', 'Allocate an amount to at least one wallet')
  const slip = clampSlippage(request.slippagePct)
  const nearUsd = nearPrice(state)
  const tokenUsd = priceOf(state, request.tokenId)
  const totalIn = legs.reduce((s, l) => s + l.amountInValue, 0)

  if (request.side === 'buy') {
    const totalUsd = totalIn * (1 - NEARKIT_FEE_BPS / 10_000) * nearUsd
    const impact = impactFraction(state, request.tokenId, totalUsd)
    const quoted = legs.map((leg) => {
      const fee = nearkitFee(leg.amountInValue)
      const out = ((leg.amountInValue - fee) * nearUsd) / (tokenUsd * (1 + impact))
      const available = Math.max(0, balanceOf(state, leg.walletId, NEAR) - GAS_RESERVE_NEAR)
      return { ...leg, amountOut: out, minAmountOut: out * (1 - slip), nearkitFee: fee, shortfall: Math.max(0, leg.amountInValue - available) }
    })
    return summarize(request, quoted, impact, now)
  }

  const totalUsd = totalIn * tokenUsd
  const impact = impactFraction(state, request.tokenId, totalUsd)
  const quoted = legs.map((leg) => {
    const gross = (leg.amountInValue * tokenUsd * (1 - impact)) / nearUsd
    const fee = nearkitFee(gross)
    const out = gross - fee
    const available = balanceOf(state, leg.walletId, request.tokenId)
    return { ...leg, amountOut: out, minAmountOut: out * (1 - slip), nearkitFee: fee, shortfall: Math.max(0, leg.amountInValue - available) }
  })
  return summarize(request, quoted, impact, now)
}

function summarize(request: MultiTradeRequest, legs: MultiTradeQuote['legs'], impact: number, now: number): MultiTradeQuote {
  const live = legs.filter((l) => l.shortfall <= 1e-9)
  return {
    request,
    legs,
    totalIn: live.reduce((s, l) => s + l.amountInValue, 0),
    totalOut: live.reduce((s, l) => s + l.amountOut, 0),
    totalMinOut: live.reduce((s, l) => s + l.minAmountOut, 0),
    nearkitFeeTotal: live.reduce((s, l) => s + l.nearkitFee, 0),
    feeTokenId: NEAR,
    networkFeeNear: NETWORK_FEE_NEAR_PER_TX * live.length,
    priceImpactPct: impact * 100,
    quotedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
  }
}
