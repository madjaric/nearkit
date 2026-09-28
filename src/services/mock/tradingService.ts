import { formatAmount } from '@/lib/format'
import { TOKEN_IDS } from '@/mocks/tokens'
import type { LimitOrder, OrderExpiry } from '@/types/domain'
import type { TradingService } from '../types'
import { demoMultiPlan, demoSwapPlan } from './demoTrades'
import { coversRaw, rawAmount } from './plans'
import { computeMultiQuote, computeQuote } from './quote'
import { ServiceError, balanceOf, logActivity, nextId, requireSession, tickMarket, tokenOf, wait, walletOf, type MockState } from './state'

const EXPIRY_MS: Record<OrderExpiry, number | null> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  gtc: null,
}

export function createTradingService(state: MockState): TradingService {
  return {
    async quote(request) {
      await wait('quote')
      tickMarket(state)
      return computeQuote(state, request)
    },

    async prepareSwap(request) {
      await wait('write')
      requireSession(state)
      tickMarket(state)
      const quote = computeQuote(state, request)
      const tokenIn = tokenOf(state, request.tokenIn)
      const tokenOut = tokenOf(state, request.tokenOut)
      const wallet = walletOf(state, request.walletId)
      const raw = rawAmount(request.amountIn, tokenIn, 'Amount')
      if (!coversRaw(balanceOf(state, wallet.id, tokenIn.id), raw, tokenIn.decimals)) {
        throw new ServiceError('insufficient', `${wallet.label} holds ${formatAmount(balanceOf(state, wallet.id, tokenIn.id))} ${tokenIn.symbol}`)
      }
      return demoSwapPlan(state, { quote, tokenIn, tokenOut, signerId: wallet.accountId, walletLabel: wallet.label, raw })
    },

    async quoteMulti(request) {
      await wait('quote')
      tickMarket(state)
      return computeMultiQuote(state, request)
    },

    async prepareMulti(request) {
      await wait('write')
      requireSession(state)
      tickMarket(state)
      const quote = computeMultiQuote(state, request)
      const token = tokenOf(state, request.tokenId)
      const live = quote.legs.filter((l) => l.shortfall <= 1e-9)
      if (live.length === 0) throw new ServiceError('insufficient', 'None of the selected wallets can cover its allocation')
      return demoMultiPlan(state, { quote, token, legs: live.map((l) => ({ ...l, wallet: walletOf(state, l.walletId) })) })
    },

    async listOrders() {
      await wait('read')
      if (!state.session) return []
      const now = Date.now()
      for (const order of state.orders) {
        if (order.status === 'open' && order.expiresAt !== null && order.expiresAt <= now) {
          order.status = 'expired'
          order.closedAt = order.expiresAt
        }
      }
      return state.orders.map((o) => ({ ...o })).sort((a, b) => b.createdAt - a.createdAt)
    },

    async createOrder(input) {
      await wait('write')
      requireSession(state)
      const token = tokenOf(state, input.tokenId)
      const wallet = walletOf(state, input.walletId)
      if (token.isNative) throw new ServiceError('invalid-pair', 'Choose a token other than NEAR')
      if (!(input.triggerPriceUsd > 0)) throw new ServiceError('invalid-trigger', 'Enter a trigger price above 0')
      if (!(input.amount > 0)) throw new ServiceError('invalid-amount', 'Enter an amount above 0')
      const spend = input.side === 'buy' ? TOKEN_IDS.near : token.id
      const available = balanceOf(state, wallet.id, spend)
      if (input.amount > available + 1e-9) {
        throw new ServiceError('insufficient', `${wallet.label} holds ${formatAmount(available)} ${input.side === 'buy' ? 'NEAR' : token.symbol}`)
      }
      const now = Date.now()
      const ttl = EXPIRY_MS[input.expiry]
      const order: LimitOrder = {
        id: nextId(state, 'ord'),
        tokenId: token.id,
        side: input.side,
        type: input.type,
        triggerPriceUsd: input.triggerPriceUsd,
        amount: input.amount,
        walletId: wallet.id,
        createdAt: now,
        expiresAt: ttl === null ? null : now + ttl,
        status: 'open',
        closedAt: null,
      }
      state.orders.unshift(order)
      const kindLabel = input.type === 'limit' ? `Limit ${input.side}` : input.type === 'take-profit' ? 'Take profit' : 'Stop loss'
      logActivity(state, {
        kind: 'order',
        title: `${kindLabel} placed (demo)`,
        detail: `${token.symbol} · ${formatAmount(input.amount)} ${input.side === 'buy' ? 'NEAR' : token.symbol}`,
      })
      return { ...order }
    },

    async cancelOrder(id) {
      await wait('write')
      const order = state.orders.find((o) => o.id === id)
      if (!order) throw new ServiceError('not-found', 'Order not found')
      if (order.status !== 'open') throw new ServiceError('not-open', 'Only open orders can be cancelled')
      order.status = 'cancelled'
      order.closedAt = Date.now()
      return { ...order }
    },
  }
}
