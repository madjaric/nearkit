import { NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { tryParseUnits } from '@/lib/amounts'
import type { TokenRef } from '@/lib/automation/config'
import { priceYocto } from '@/lib/automation/price'
import { walletErrorText } from '../bot/ui'
import type { Intent, TradingWallet } from '../custody/store'
import { SWAP_QUOTE_TTL_MS, type SwapParams, type SwapQuote } from '../custody/swap'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import { WEB_CHAT } from '../web/execute'
import type { AutomationStore, Execution, Strategy } from './store'

/**
 * One automated trade, through NEARKITS' own custody path and nothing else: the kill switches, a fresh
 * quote bound to the wallet (the router, the fee, the registrations and the funds checks), an intent,
 * the engine (which re-checks everything at Confirm, asks the signer, whose own policy and price floor
 * apply, and waits for the delivery on chain). The same path as a trade its owner confirms on the web.
 *
 * The trade is saved under its idem_key before anything is signed: a restart finds it and settles it
 * from its intent; a second worker or a retry of the same trigger finds the key taken and does nothing.
 * Nothing is called confirmed until the engine saw the delivery on chain (intent done and ok).
 */

/** A quote older than this is not traded on. */
export const QUOTE_MAX_AGE_MS = 30_000

export interface AutomationLimits {
  /** The most one automated trade may spend, in NEAR. */
  maxTradeNear: number
  /** The most NEAR one user's automated buys may spend in 24 hours. */
  maxDailyNearPerUser: number
  /** The most NEAR all automated buys together may spend in 24 hours. */
  maxDailyNearGlobal: number
}

export const DEFAULT_LIMITS: AutomationLimits = { maxTradeNear: 50, maxDailyNearPerUser: 200, maxDailyNearGlobal: 2_000 }

export interface ExecuteDeps {
  store: AutomationStore
  custody: CustodyDeps
  network: NetworkConfig
  limits: AutomationLimits
  log: Logger
  now: () => number
}

export interface TradeRequest {
  strategy: Strategy
  wallet: TradingWallet
  side: 'buy' | 'sell'
  token: TokenRef
  /** Exact decimal: NEAR on a buy, the token on a sell. */
  amountIn: string
  slippagePct: number
  idemKey: string
  source?: string | null
  message?: string
  /** Asked right before the intent and again right before signing: a reason to stop, or null. */
  stillAllowed: () => Promise<string | null>
  /** A last check of the fresh quote (the trigger still met, the price impact within limits): a reason to stop, or null. */
  accept?: (q: SwapQuote) => string | null
}

export type TradeOutcome =
  /** Nothing was created or signed. */
  | { kind: 'skipped'; reason: string }
  /** The trigger was handled already (this key exists): nothing new. */
  | { kind: 'duplicate'; execution: Execution }
  /** Created, then stopped before anything was signed (busy wallet, a route that changed, a stop). */
  | { kind: 'not-sent'; reason: string; execution: Execution }
  | { kind: 'submitted'; execution: Execution }
  | { kind: 'confirmed'; execution: Execution }
  | { kind: 'failed'; execution: Execution; reason: string }

const DAY_MS = 86_400_000

/** NEAR as raw yocto from a decimal (0 for anything unreadable). */
const nearRaw = (near: number) => {
  const p = tryParseUnits(near.toFixed(6), NEAR_DECIMALS)
  return p.ok ? p.value : 0n
}

/** The NEAR and token amounts of a quote, raw: what is paid and what comes out. */
export function quoteAmounts(side: 'buy' | 'sell', q: SwapQuote): { nearRaw: bigint; tokenRaw: bigint } {
  const amountIn = /^\d+$/.test(q.amountInRaw) ? BigInt(q.amountInRaw) : 0n
  const out = /^\d+$/.test(q.amountOut) ? BigInt(q.amountOut) : 0n
  return side === 'buy' ? { nearRaw: amountIn, tokenRaw: out } : { nearRaw: out, tokenRaw: amountIn }
}

/** A quote that can be traded on: something in, something out, a minimum, and fresh. */
export function quoteProblem(q: SwapQuote, now: number): string | null {
  if (!/^\d+$/.test(q.amountInRaw) || BigInt(q.amountInRaw) <= 0n) return 'The quote spends nothing'
  if (!/^\d+$/.test(q.amountOut) || BigInt(q.amountOut) <= 0n) return 'The quote pays nothing'
  if (!/^\d+$/.test(q.minOut) || BigInt(q.minOut) <= 0n) return 'The quote has no minimum'
  if (!Number.isFinite(q.quotedAt) || now - q.quotedAt > QUOTE_MAX_AGE_MS || q.quotedAt - now > 5_000) return 'The quote is stale'
  return null
}

export function createExecutor(deps: ExecuteDeps) {
  const { store, custody, log, now } = deps
  const net = deps.network.id === 'mainnet' ? 'mainnet' : 'testnet'

  /** Why a buy of `near` would break a spending limit now, or null. */
  async function overLimit(userId: number, near: bigint): Promise<string | null> {
    if (near > nearRaw(deps.limits.maxTradeNear)) return `Above the ${deps.limits.maxTradeNear} NEAR limit per automated trade`
    const since = now() - DAY_MS
    if ((await store.nearSpentSince(since, userId)) + near > nearRaw(deps.limits.maxDailyNearPerUser))
      return `Your automated buys would pass ${deps.limits.maxDailyNearPerUser} NEAR in 24 hours`
    if ((await store.nearSpentSince(since, null)) + near > nearRaw(deps.limits.maxDailyNearGlobal)) return 'NEARKITS’ automated buys reached their 24-hour limit; try later'
    return null
  }

  /** A trade's outcome from its intent, once the engine (or the resolver) finished it. */
  async function settle(execution: Execution, intent: Intent | null): Promise<TradeOutcome | null> {
    if (!intent) return null
    if (intent.status === 'done' && intent.result?.ok) {
      const facts = (intent.result.facts ?? {}) as { tokenAmount?: unknown; nearAmount?: unknown }
      const tokenRaw = typeof facts.tokenAmount === 'string' ? facts.tokenAmount : null
      const near = typeof facts.nearAmount === 'string' ? facts.nearAmount : null
      await store.updateExecution(execution.id, ['executing', 'submitted'], 'confirmed', {
        nearRaw: near,
        tokenRaw,
        txHashes: intent.result.hashes,
        message: intent.result.message,
      })
      return { kind: 'confirmed', execution: (await store.execution(execution.id)) as Execution }
    }
    if (intent.status === 'failed' && (intent.result?.hashes.length ?? 0) === 0) {
      // Refused before anything was signed (a switch set meanwhile, funds short at Confirm): not a trade that failed.
      const reason = intent.result?.message ?? 'Not sent'
      await store.updateExecution(execution.id, ['executing', 'submitted'], 'cancelled', { message: reason })
      return { kind: 'not-sent', reason, execution: (await store.execution(execution.id)) as Execution }
    }
    if (intent.status === 'done' || intent.status === 'failed') {
      const reason = intent.result?.message ?? 'The trade failed on chain'
      await store.updateExecution(execution.id, ['executing', 'submitted'], 'failed', { txHashes: intent.result?.hashes ?? [], message: reason })
      return { kind: 'failed', execution: (await store.execution(execution.id)) as Execution, reason }
    }
    if (intent.status === 'cancelled' || intent.status === 'expired' || intent.status === 'replaced') {
      // Never confirmed by the engine: nothing was signed for it.
      await store.updateExecution(execution.id, ['executing', 'submitted'], 'cancelled', { message: `Not sent (${intent.status})` })
      return { kind: 'not-sent', reason: `Not sent (${intent.status})`, execution: (await store.execution(execution.id)) as Execution }
    }
    // Confirmed, signing or submitted: still under way. The resolver finishes it from the chain.
    if (execution.status === 'executing' && (intent.status === 'signing' || intent.status === 'submitted')) await store.updateExecution(execution.id, ['executing'], 'submitted')
    return null
  }

  async function trade(r: TradeRequest): Promise<TradeOutcome> {
    const { strategy, wallet, side } = r
    const done = await store.executionByKey(r.idemKey)
    if (done) return { kind: 'duplicate', execution: done }
    const blocked = await custody.ops.blocked(side, wallet)
    if (blocked) return { kind: 'skipped', reason: blocked }
    const params: SwapParams = { side, token: r.token.id, symbol: r.token.symbol, decimals: r.token.decimals, amountIn: r.amountIn, slippagePct: r.slippagePct }
    let quote: SwapQuote
    try {
      quote = await custody.swaps.quote(params, wallet)
    } catch (e) {
      return { kind: 'skipped', reason: `No quote: ${walletErrorText(e, { network: net, side, log, context: 'automation quote failed' })}` }
    }
    const problem = quoteProblem(quote, now())
    if (problem) return { kind: 'skipped', reason: problem }
    const accepted = r.accept?.(quote) ?? null
    if (accepted) return { kind: 'skipped', reason: accepted }
    const amounts = quoteAmounts(side, quote)
    const before = await r.stillAllowed()
    if (before) return { kind: 'skipped', reason: before }

    // NEARKITS' daily limits and this trade's record under one lock: buys running side by side can't each
    // pass a limit the others fill. The record exists before anything is signed.
    const reserved = await store.underSpendLock(async (): Promise<{ limit: string } | { execution: Execution | null }> => {
      if (side === 'buy') {
        const limit = await overLimit(strategy.userId, amounts.nearRaw)
        if (limit) return { limit }
      }
      return {
        execution: await store.addExecution({
          strategyId: strategy.id,
          userId: strategy.userId,
          walletId: wallet.id,
          idemKey: r.idemKey,
          side,
          token: r.token.id,
          nearInRaw: side === 'buy' ? amounts.nearRaw.toString() : null,
          amountInRaw: quote.amountInRaw,
          expectedOutRaw: quote.amountOut,
          minOutRaw: quote.minOut,
          priceYocto: priceYocto(amounts.nearRaw, amounts.tokenRaw, r.token.decimals)?.toString() ?? null,
          source: r.source ?? null,
          message: r.message ?? null,
        }),
      }
    })
    if ('limit' in reserved) return { kind: 'skipped', reason: reserved.limit }
    const execution = reserved.execution
    if (!execution) {
      // Taken by another worker between the first look and now.
      const other = (await store.executionByKey(r.idemKey)) as Execution
      return { kind: 'duplicate', execution: other }
    }
    let intent: Intent
    try {
      intent = await custody.store.createIntent({
        walletId: wallet.id,
        userId: strategy.userId,
        chatId: WEB_CHAT,
        kind: side,
        params,
        quote,
        ttlMs: SWAP_QUOTE_TTL_MS,
        groupId: `auto-${strategy.id}`,
      })
    } catch (e) {
      log.warn('automation intent failed', { strategy: strategy.id, error: e })
      await store.updateExecution(execution.id, ['executing'], 'cancelled', { message: 'Not sent: the trade couldn’t be prepared' })
      return { kind: 'not-sent', reason: 'Not sent: the trade couldn’t be prepared', execution: (await store.execution(execution.id)) as Execution }
    }
    await store.updateExecution(execution.id, ['executing'], 'executing', { intentId: intent.id })
    await store.event(strategy.id, 'sign', `${side === 'buy' ? 'Buying' : 'Selling'} ${r.token.symbol}: asking the signer`)
    // A pause, cancel or kill switch that landed meanwhile: nothing is signed.
    const last = await r.stillAllowed()
    if (last) {
      await custody.store.setStatus(intent.id, ['quoted'], 'cancelled')
      await store.updateExecution(execution.id, ['executing'], 'cancelled', { message: last })
      return { kind: 'not-sent', reason: last, execution: (await store.execution(execution.id)) as Execution }
    }
    let result: Awaited<ReturnType<CustodyDeps['engine']['execute']>>
    try {
      result = await custody.engine.execute(intent.id, strategy.userId)
    } catch (e) {
      log.warn('automation execute failed', { strategy: strategy.id, error: e })
      // Whatever was sent is finished by the resolver; the worker settles this trade from its intent.
      const settled = await settle(execution, await custody.store.intent(intent.id))
      return settled ?? { kind: 'submitted', execution: (await store.execution(execution.id)) as Execution }
    }
    if (result.kind === 'refused' || result.kind === 'requoted') {
      const reason = result.kind === 'refused' ? `The wallet couldn’t take the trade now (${result.reason})` : 'The price moved before signing'
      if (result.kind === 'requoted') await custody.store.setStatus(result.next.id, ['quoted'], 'cancelled')
      await store.updateExecution(execution.id, ['executing'], 'cancelled', { message: reason })
      return { kind: 'not-sent', reason, execution: (await store.execution(execution.id)) as Execution }
    }
    if (result.kind === 'pending') {
      await store.updateExecution(execution.id, ['executing'], 'submitted')
      return { kind: 'submitted', execution: (await store.execution(execution.id)) as Execution }
    }
    return (await settle(execution, result.intent)) ?? { kind: 'submitted', execution: (await store.execution(execution.id)) as Execution }
  }

  /** A trade sent earlier (before a restart, or still on its way), settled from its intent if it is finished now. */
  async function settleOpen(execution: Execution): Promise<TradeOutcome | null> {
    if (!execution.intentId) {
      // Saved, then the process stopped before its intent was recorded: nothing was signed for it.
      if (now() - execution.createdAt > 5 * 60_000) {
        await store.updateExecution(execution.id, ['executing'], 'cancelled', { message: 'Not sent: interrupted before signing' })
        return { kind: 'not-sent', reason: 'Not sent: interrupted before signing', execution: (await store.execution(execution.id)) as Execution }
      }
      return null
    }
    return settle(execution, await custody.store.intent(execution.intentId))
  }

  return { trade, settleOpen }
}

export type Executor = ReturnType<typeof createExecutor>
