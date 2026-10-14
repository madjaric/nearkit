import type { NetworkConfig } from '@/config/networks'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import {
  AUTOMATION_MAX_SLIPPAGE,
  MIN_AUTOMATION_NEAR,
  NEW_POOLS_SUBJECT as NEW_POOLS,
  sideOf,
  type CopyConfig,
  type DcaConfig,
  type LimitConfig,
  type SniperSettings,
  type SniperSource,
  type StrategyKind,
  type TokenRef,
} from '@/lib/automation/config'
import { formatPrice, meetsTrigger, priceYocto, targetYocto } from '@/lib/automation/price'
import { liquidityOf } from '@/lib/volumeBot/risk'
import { fromRpc, type NormalizedTx } from '@/services/near/flows'
import { fetchAccountTxs, fetchFullTxs, fetchIndexLag, type TxRef } from '@/services/near/history'
import { walletErrorText } from '../bot/ui'
import type { TradingWallet } from '../custody/store'
import type { SwapQuote } from '../custody/swap'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import { esc } from '../telegram/html'
import { copyBuySize, readCopyTrade } from './copy'
import { createExecutor, DEFAULT_LIMITS, quoteAmounts, type AutomationLimits, type TradeOutcome } from './execute'
import type { NewPool, PoolFeed, PoolStore } from './pools'
import type { AutomationStore, Execution, Strategy } from './store'

/**
 * The automation worker. Every tick it settles trades sent earlier (from their intents: a restart
 * loses nothing), then takes the strategies that are due, each under its own lease (two instances
 * never act on one strategy), and steps it:
 *
 * - Limit orders (limit buy, limit sell, take profit, stop loss): an executable quote for the order's
 *   own amount, from the wallet, through the route a trade would take: its price (NEAR per token, every
 *   fee, tax and price impact in it) is compared with the target. The condition must hold on two
 *   readings a few seconds apart before the order triggers, and again on the quote it is traded on.
 *   A triggered order is then a market swap at that quote with the order's slippage: the minimum
 *   received is enforced on chain, the price is not guaranteed. A take profit and a stop loss on the
 *   same position are a pair: the first to trigger cancels the other.
 * - DCA: a buy of a fixed NEAR amount on schedule.
 * - Sniper: watches one token until a route trades it within the limits (liquidity, price impact),
 *   then notifies, or buys when its owner enabled buying.
 * - Copy Trade: reads the followed account's new transactions from FastNEAR's transaction index (final,
 *   each once), keeps NEAR swaps through the exchanges NEARKITS routes through, and copies them within
 *   the rule's limits.
 *
 * Nothing trades while NEARKITS' automation or trading switch is set, a kind is switched off, or a
 * strategy is paused or stopped; trades already sent are still followed to the end.
 */

const TICK_MS = 3_000
const LEASE_MS = 3 * 60_000
const PER_TICK = 8
/** The share of the quote budget only limit orders may use. */
const QUOTE_RESERVE = 0.2
const LIMIT_CHECK_MS = 30_000
/** A trigger seen once is confirmed by a second reading this much later. */
const CONFIRM_MS = 5_000
/** Longer than this between the two readings, and the first one is stale: start again. */
const CONFIRM_MAX_MS = 90_000
const MAX_ORDER_ATTEMPTS = 3
const SNIPER_CHECK_MS = 20_000
const COPY_CHECK_MS = 20_000
/** A source transaction this young may not be final yet: read it next time. */
const COPY_FINALITY_MS = 10_000
/** A trade seen longer than this after it happened (the index behind or down) is not copied: its price has moved. */
const COPY_MAX_DELAY_MS = 3 * 60_000
/** The index this far behind the chain is said on the rule (its copies may come too late). */
const COPY_MAX_LAG_SEC = 60
/** Transactions listed per step (paged back to the rule's cursor), and read in full per step. */
const COPY_LIST_MAX = 100
const COPY_READ_PER_STEP = 10
/** A transaction neither the index nor RPC can serve is tried this many steps (COPY_UNREAD_RETRY_MS apart), then recorded as skipped. */
const COPY_MAX_READ_TRIES = 5
const COPY_UNREAD_RETRY_MS = 10_000
/** A rule that owes a copied trade (tried again) looks this often. */
const COPY_PENDING_RETRY_MS = 15_000
const INDEX_STATUS_TTL_MS = 15_000
/** The index down this long: the rule's owner is told (once per outage). */
const INDEX_DOWN_NOTICE_MS = 10 * 60_000
const DCA_RETRY_MS = 60_000
const DCA_MAX_TRIES = 5
const LIQUIDITY_MAX_AGE_SEC = 300
const SETTLE_PER_TICK = 20
/** A token's reference price is shared this long. */
const REF_TTL_MS = 25_000
/** An order far from its trigger by the reference price still reads its own price at least this often. */
const OWN_QUOTE_MAX_MS = 5 * 60_000
/** How far past the target the reference price must be before an order skips its own quote (1%). */
const REF_MARGIN_BPS = 100n
const SWEEP_MS = 30_000
/** An order whose trade is refused in a row waits up to this long between tries. */
const SKIP_BACKOFF_MAX_MS = 15 * 60_000
/** A ready pool older than this is no longer new: a sniper that was paused (or held) doesn't act on it. */
const POOL_MAX_AGE_MS = 5 * 60_000
/** A copied sell not made yet (a balance unreadable, the budget spent, the price moving, our own buy still under way) is tried again this long after the trade it copies. */
const COPY_SELL_RETRY_MS = 15 * 60_000
/** A copied buy at a price impact above this (measured when the router doesn't say) is not made. */
const COPY_MAX_IMPACT_PCT = 10
/** A new-pools sniper looks for ready pools this often (a database read; quotes only for a new pool). */
const POOL_SNIPER_CHECK_MS = 4_000
const POOLS_PER_STEP = 10
/** A new pool without a route from a NEARKITS wallet is tried again for this long. */
const POOL_ROUTE_WAIT_MS = 5 * 60_000
/** A new pool whose round trip (buy, then sell back) loses more than this is not bought: fees, a tax, a pool too thin to leave. */
const ROUND_TRIP_MAX_LOSS_PCT = 25

export interface AutomationRunnerDeps {
  store: AutomationStore
  custody: CustodyDeps
  near: ServerNear
  network: NetworkConfig
  log: Logger
  instanceId: string
  /** The kinds switched on (NEARKIT_AUTOMATION); the rest are never stepped. */
  enabled: ReadonlySet<StrategyKind>
  limits?: AutomationLimits
  /** Quotes the worker may ask for per minute, all strategies together. */
  quotesPerMinute?: number
  /** A message to the strategy's owner in Telegram (HTML). */
  notify?: (userId: number, html: string) => Promise<void>
  /** New pools (Sniper's discovery): their records, and the feed that reads them (stepped while a new-pools sniper is live). */
  pools?: { store: PoolStore; feed: PoolFeed | null }
  fetch?: typeof fetch
  now?: () => number
}

const near = (raw: bigint | string) => Number(formatUnits(BigInt(raw), NEAR_DECIMALS, { maxFraction: 6 }))
const tokens = (raw: bigint | string, decimals: number) => Number(formatUnits(BigInt(raw), decimals, { maxFraction: 6 }))
const human = (raw: bigint | string, decimals: number) => formatUnits(BigInt(raw), decimals, { maxFraction: 6 })
const ORDER_LABEL: Record<LimitConfig['type'], string> = { 'limit-buy': 'Limit buy', 'limit-sell': 'Limit sell', 'take-profit': 'Take profit', 'stop-loss': 'Stop loss' }

export function createAutomationRunner(deps: AutomationRunnerDeps) {
  const { store, custody, log } = deps
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const executor = createExecutor({ store, custody, network: deps.network, limits: deps.limits ?? DEFAULT_LIMITS, log, now })
  const budget = { tokens: deps.quotesPerMinute ?? 60, max: deps.quotesPerMinute ?? 60, at: now() }

  /**
   * Quotes from the shared per-minute budget (all or none); false when there aren't that many left (the
   * strategy waits). Limit orders (stop losses among them) may use all of it; the other kinds leave a
   * reserve (QUOTE_RESERVE of the budget), so a flood of new pools or copies never starves an order.
   */
  function takeQuotes(wanted: number, priority = false): boolean {
    const t = now()
    budget.tokens = Math.min(budget.max, budget.tokens + ((t - budget.at) / 60_000) * budget.max)
    budget.at = t
    // Never more than the budget holds at most (a budget smaller than a step's needs still lets it run).
    const n = Math.min(wanted, budget.max)
    const floor = priority ? 0 : Math.min(budget.max * QUOTE_RESERVE, budget.max - n)
    if (budget.tokens - n < floor) return false
    budget.tokens -= n
    return true
  }
  const takeQuote = (priority = false) => takeQuotes(1, priority)

  async function notify(s: Strategy, text: string): Promise<void> {
    await deps.notify?.(s.userId, text).catch((e: unknown) => log.warn('automation notice failed', { strategy: s.id, error: e }))
  }

  /** Whether automated trading may go on at all now (NEARKITS' switches, fail closed). */
  async function switchesOpen(): Promise<string | null> {
    const s = await custody.ops.state().catch(() => null)
    if (!s) return 'NEARKITS can’t confirm that trading is allowed right now'
    if (s.automation.paused) return 'NEARKITS has paused automated trading'
    if (s.trading.paused) return 'Trading is paused by NEARKITS'
    return null
  }

  /** Asked before the intent and before signing: still the same strategy state, its wallet, its lease, the switches. */
  const allowedWhile = (s: Strategy, statuses: readonly Strategy['status'][]) => async (): Promise<string | null> => {
    const cur = await store.get(s.id)
    if (!cur || !statuses.includes(cur.status)) return 'Stopped, paused or cancelled before the trade was sent'
    if (!deps.enabled.has(s.kind)) return 'This automation is switched off by NEARKITS'
    const w = await custody.store.ownedWallet(s.userId, s.walletId)
    if (!w || w.status !== 'active') return 'Its NEARKITS wallet is no longer active'
    if (w.frozenAt) return 'Its NEARKITS wallet is frozen by NEARKITS'
    if (!(await store.claim(s.id, deps.instanceId, LEASE_MS))) return 'Another worker took this strategy over'
    return switchesOpen()
  }

  // ─── reference prices ─────────────────────────────────────────────────────

  /**
   * One small buy quote per token, shared by every order on it for a while: the price (yoctoNEAR per
   * whole token) of MIN_AUTOMATION_NEAR's worth. An order's own trade is larger and pays fees both
   * ways, so its executable price is never better than this: a limit buy can't trigger while this is
   * above its target, and a sell (limit sell, take profit) can't while this is below. Such orders skip
   * their own quote (the quote budget goes to orders near their trigger). Null: unknown.
   */
  const refs = new Map<string, { at: number; price: Promise<bigint | null> }>()
  function referencePrice(t: TokenRef, wallet: TradingWallet): Promise<bigint | null> {
    const hit = refs.get(t.id)
    // Orders stepped at the same moment share one quote, even while it is on its way.
    if (hit && now() - hit.at < REF_TTL_MS) return hit.price
    if (!takeQuote(true)) return Promise.resolve(null)
    const price = custody.swaps
      .quote({ side: 'buy', token: t.id, symbol: t.symbol, decimals: t.decimals, amountIn: String(MIN_AUTOMATION_NEAR), slippagePct: AUTOMATION_MAX_SLIPPAGE }, wallet)
      .then((q) => {
        const a = quoteAmounts('buy', q)
        return priceYocto(a.nearRaw, a.tokenRaw, t.decimals)
      })
      .catch(() => null)
    if (refs.size > 500) refs.clear()
    refs.set(t.id, { at: now(), price })
    return price
  }

  /** Whether an order can't trigger at a reference price (with a margin for a router that splits a larger trade better). */
  function cannotTrigger(type: LimitConfig['type'], ref: bigint, target: bigint): boolean {
    if (type === 'limit-buy') return ref * 10_000n > target * (10_000n + REF_MARGIN_BPS)
    if (type === 'limit-sell' || type === 'take-profit') return ref * 10_000n < target * (10_000n - REF_MARGIN_BPS)
    // A stop loss always reads its own price: its executable price can be far below a small buy's.
    return false
  }

  // ─── ends that passed ─────────────────────────────────────────────────────

  let sweptAt = Number.NEGATIVE_INFINITY
  /**
   * Strategies whose expiry (or DCA end) passed, even while paused (the worker doesn't look at paused
   * ones): an order or sniper expires, a DCA completes. One with a trade under way is left until it settles.
   */
  async function sweepLapsed(): Promise<void> {
    if (now() - sweptAt < SWEEP_MS) return
    sweptAt = now()
    for (const s of await store.lapsed(50)) {
      if ((await store.openExecutionsOf(s.id)).length) continue
      const c = s.config
      const dca = c.kind === 'dca'
      const runs = dca ? Number((s.state as { runs?: number }).runs ?? 0) : 0
      const reason = dca ? `Completed after ${runs} buys: its end date passed` : s.kind === 'limit' ? 'Expired unfilled' : 'Expired'
      if (!(await store.transition(s.id, ['draft', 'active', 'paused'], dca ? 'completed' : 'expired', { reason }))) continue
      await store.event(s.id, dca ? 'completed' : 'expired', s.status === 'paused' ? `${reason} (while paused)` : reason)
      const what =
        c.kind === 'limit'
          ? `<b>${ORDER_LABEL[c.limit.type]} ${esc(c.limit.token.symbol)}</b> expired unfilled`
          : c.kind === 'sniper'
            ? `${sniperName(c.sniper)} expired`
            : c.kind === 'dca'
              ? `DCA into <b>${esc(c.dca.token.symbol)}</b> completed after ${runs} buys (its end date passed)`
              : 'An automation ended'
      await notify(s, `${dca ? '🏁' : '⌛'} ${what}${s.status === 'paused' ? ' while paused' : ''}.`)
    }
  }

  async function walletOf(s: Strategy): Promise<TradingWallet | null> {
    const w = await custody.store.ownedWallet(s.userId, s.walletId)
    return w && w.status === 'active' ? w : null
  }

  /** The wallet's balance of a token (raw), or null when the chain can't be read. */
  async function tokenBalance(token: string, wallet: TradingWallet): Promise<bigint | null> {
    return deps.near.ctx.reader.balanceOf(token, wallet.accountId).catch(() => null)
  }

  // ─── limit orders ─────────────────────────────────────────────────────────

  /** What the order spends now, as an exact decimal; or why it waits. */
  async function orderAmount(c: LimitConfig, wallet: TradingWallet): Promise<{ amount: string } | { wait: string }> {
    if (c.amount.kind === 'near') return { amount: c.amount.value }
    const held = await tokenBalance(c.token.id, wallet)
    if (held === null) return { wait: 'The wallet’s balance can’t be read right now' }
    if (c.amount.kind === 'tokens') {
      // Revalidated at every look: an order never sells more than the wallet holds.
      const want = tryParseUnits(c.amount.value, c.token.decimals)
      if (!want.ok || want.value <= 0n) return { wait: 'The amount to sell is unreadable' }
      if (held < want.value) return { wait: `The wallet holds less ${c.token.symbol} than the order sells` }
      return { amount: c.amount.value }
    }
    const share = (held * BigInt(c.amount.value)) / 100n
    if (share === 0n) return { wait: `The wallet holds no ${c.token.symbol}` }
    return { amount: formatUnits(share, c.token.decimals) }
  }

  async function settledOrder(s: Strategy, c: LimitConfig, out: TradeOutcome): Promise<void> {
    const label = `${ORDER_LABEL[c.type]} ${esc(c.token.symbol)}`
    if (out.kind === 'confirmed') {
      if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'filled', { reason: 'Filled on chain' })) {
        const e = out.execution
        const got =
          e.side === 'buy'
            ? `${e.tokenRaw ? tokens(e.tokenRaw, c.token.decimals) : '?'} ${esc(c.token.symbol)} for ${e.nearRaw ? near(e.nearRaw) : '?'} NEAR`
            : `${e.tokenRaw ? tokens(e.tokenRaw, c.token.decimals) : '?'} ${esc(c.token.symbol)} for ${e.nearRaw ? near(e.nearRaw) : '?'} NEAR`
        await store.event(s.id, 'filled', `Filled on chain: ${e.side === 'buy' ? 'bought' : 'sold'} ${got.replace(/<[^>]+>/g, '')}`)
        const cancelled = s.ocoGroup ? await store.cancelOcoSiblings(s.ocoGroup, s.id, 'The other order of its pair filled') : []
        await notify(
          s,
          `✅ <b>${label}</b> filled on chain: ${e.side === 'buy' ? 'bought' : 'sold'} ${got}.${cancelled.length ? ' The other order of its pair was cancelled.' : ''}`,
        )
      }
      return
    }
    if (out.kind === 'submitted') {
      await store.transition(s.id, ['triggered', 'executing'], 'submitted', { reason: 'Sent; waiting for the chain' })
      return
    }
    if (out.kind === 'duplicate') return
    // Not traded. Cancelled by its owner meanwhile (with its pair): it ends cancelled, not watching again.
    const reason = out.reason
    if (await cancelIfRequested(s, label)) return
    if (out.kind === 'failed' && s.attempts >= MAX_ORDER_ATTEMPTS) {
      if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'failed', { reason })) {
        await store.event(s.id, 'failed', reason)
        await notify(s, `❌ <b>${label}</b> failed ${s.attempts} times and stopped: ${esc(reason)}`)
      }
      return
    }
    // Back to watching. A trade refused before signing (a limit, a frozen wallet, the price moving back) waits
    // longer each time it is refused in a row (its owner is told once), so it doesn't re-trigger every 35 s.
    const skips = out.kind === 'failed' ? 0 : (Number(s.state.skips) || 0) + 1
    const delay = skips ? Math.min(LIMIT_CHECK_MS * 2 ** (skips - 1), SKIP_BACKOFF_MAX_MS) : LIMIT_CHECK_MS
    if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'active', { reason, nextCheckAt: now() + delay, state: { ...s.state, armedAt: null, skips } })) {
      await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `${out.kind === 'failed' ? 'The trade failed' : 'Not traded'}: ${reason}. Watching again.`)
      if (out.kind === 'failed')
        await notify(s, `⚠️ <b>${label}</b>: the trade failed (${esc(reason)}). The order keeps watching (attempt ${s.attempts} of ${MAX_ORDER_ATTEMPTS}).`)
      else if (skips === 1) await notify(s, `⏳ <b>${label}</b> wasn’t traded: ${esc(reason)}. It keeps watching (and looks less often while this lasts).`)
    }
  }

  /** An order its owner cancelled (with its pair) while it traded, not traded in the end: cancelled now. */
  async function cancelIfRequested(s: Strategy, label: string): Promise<boolean> {
    const fresh = await store.get(s.id)
    if (!fresh?.cancelRequestedAt) return false
    if (
      await store.transition(s.id, ['active', 'triggered', 'executing', 'submitted'], 'cancelled', { reason: 'Cancelled with the other order of its pair (its trade wasn’t made)' })
    ) {
      await store.event(s.id, 'cancelled', 'Cancelled with the other order of its pair: its trade wasn’t made')
      await notify(s, `✖ <b>${label}</b> is cancelled with the other order of its pair: its trade wasn’t made.`)
    }
    return true
  }

  async function stepLimit(s: Strategy, c: LimitConfig): Promise<void> {
    const label = `${ORDER_LABEL[c.type]} ${esc(c.token.symbol)}`
    if (s.status !== 'active') return recoverStuck(s)
    if (s.cancelRequestedAt && (await cancelIfRequested(s, label))) return
    if (s.expiresAt !== null && now() >= s.expiresAt) {
      if (await store.transition(s.id, ['active'], 'expired', { reason: 'Expired unfilled' })) {
        await store.event(s.id, 'expired', 'Expired unfilled')
        await notify(s, `⌛ <b>${label}</b> expired unfilled.`)
      }
      return
    }
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    const target = targetYocto(c.triggerPriceNear)
    if (target === null) return failFor(s, 'Its trigger price is unreadable')
    // The other order of its pair is trading: its result decides (filled: this one is cancelled; not traded: this one watches on).
    if (s.ocoGroup && (await store.pairTrading(s.ocoGroup, s.id)))
      return void (await store.setNext(s.id, now() + 10_000, { ...s.state, waiting: 'The other order of its pair is trading: waiting for its result', armedAt: null }))
    const amount = await orderAmount(c, wallet)
    if ('wait' in amount) {
      await store.setNext(s.id, now() + 60_000, { ...s.state, waiting: amount.wait, armedAt: null })
      return
    }
    // Far from its trigger by the token's shared reference price: no quote of its own this time.
    const ownAt = typeof s.state.ownQuoteAt === 'number' ? s.state.ownQuoteAt : 0
    if (typeof s.state.armedAt !== 'number' && now() - ownAt < OWN_QUOTE_MAX_MS && c.type !== 'stop-loss') {
      const ref = await referencePrice(c.token, wallet)
      if (ref !== null && cannotTrigger(c.type, ref, target))
        return void (await store.setNext(s.id, now() + LIMIT_CHECK_MS, { ...s.state, refPriceYocto: ref.toString(), refAt: now(), waiting: null, armedAt: null }))
    }
    if (!takeQuote(true)) return void (await store.setNext(s.id, now() + 15_000))
    const side = sideOf(c.type)
    let q: Awaited<ReturnType<CustodyDeps['swaps']['quote']>>
    try {
      q = await custody.swaps.quote({ side, token: c.token.id, symbol: c.token.symbol, decimals: c.token.decimals, amountIn: amount.amount, slippagePct: c.slippagePct }, wallet)
    } catch (e) {
      // In plain words: a provider's URL (with any key in it) or an internal message stays in the server log.
      const reason = walletErrorText(e, { network: deps.network.id === 'mainnet' ? 'mainnet' : 'testnet', side, log, context: 'automation order quote failed' })
      await store.setNext(s.id, now() + LIMIT_CHECK_MS, { ...s.state, waiting: `No quote right now: ${reason}`, armedAt: null })
      return
    }
    const a = quoteAmounts(side, q)
    const price = priceYocto(a.nearRaw, a.tokenRaw, c.token.decimals)
    const meets = meetsTrigger(c.type, a.nearRaw, a.tokenRaw, c.token.decimals, target)
    const insufficient = q.need && q.available && /^\d+$/.test(q.need) && /^\d+$/.test(q.available) && BigInt(q.available) < BigInt(q.need)
    const seen = {
      ...s.state,
      lastPriceYocto: price?.toString() ?? null,
      lastQuoteAt: q.quotedAt,
      ownQuoteAt: now(),
      waiting: insufficient ? 'Not enough NEAR in the wallet for this order and its gas' : null,
    }
    if (!meets || price === null) return void (await store.setNext(s.id, now() + LIMIT_CHECK_MS, { ...seen, armedAt: null, skips: 0 }))
    const armedAt = typeof s.state.armedAt === 'number' ? s.state.armedAt : null
    if (armedAt === null || now() - armedAt > CONFIRM_MAX_MS) {
      await store.event(s.id, 'trigger-seen', `Price ${formatPrice(price)} NEAR met the target ${c.triggerPriceNear}: confirming with a second reading`)
      return void (await store.setNext(s.id, now() + CONFIRM_MS, { ...seen, armedAt: now() }))
    }
    if (now() - armedAt < CONFIRM_MS) return void (await store.setNext(s.id, armedAt + CONFIRM_MS, seen))
    if (insufficient) return void (await store.setNext(s.id, now() + 60_000, { ...seen, armedAt: null }))
    // Confirmed: triggered (compare-and-set; a Cancel that won the race leaves it cancelled, and of a
    // pair only one order trades at a time). The other order of a pair is cancelled once this one fills.
    const attempt = s.attempts + 1
    const triggered = await store.triggerOrder(s, { attempts: attempt, state: { ...seen, armedAt: null }, reason: null })
    if (triggered === 'pair-busy')
      return void (await store.setNext(s.id, now() + 10_000, { ...seen, waiting: 'The other order of its pair is trading: waiting for its result', armedAt: null }))
    if (triggered !== 'triggered') return
    await store.event(s.id, 'trigger', `Triggered at ${formatPrice(price)} NEAR per ${c.token.symbol} (target ${c.triggerPriceNear}); attempt ${attempt}`)
    // Told once: a trigger again after refusals in a row isn't news.
    if (!(Number(s.state.skips) > 0))
      await notify(
        s,
        `🎯 <b>${label}</b> triggered at ${formatPrice(price)} NEAR. Trading now at market with ${c.slippagePct}% slippage; the result follows once the chain confirms it.`,
      )
    const current = { ...s, attempts: attempt, status: 'triggered' as const }
    const out = await executor.trade({
      strategy: current,
      wallet,
      side,
      token: c.token,
      amountIn: amount.amount,
      slippagePct: c.slippagePct,
      idemKey: `limit:${s.id}:${attempt}`,
      message: `${ORDER_LABEL[c.type]} at ${c.triggerPriceNear}`,
      accept: (fresh) => {
        const f = quoteAmounts(side, fresh)
        return meetsTrigger(c.type, f.nearRaw, f.tokenRaw, c.token.decimals, target) ? null : 'The price moved back past the target before signing'
      },
      stillAllowed: async () => {
        const reason = await allowedWhile(current, ['triggered', 'executing'])()
        if (!reason) await store.transition(s.id, ['triggered'], 'executing')
        return reason
      },
    })
    await settledOrder(current, c, out)
  }

  /** A strategy left triggered or executing with nothing under way (a crash between steps): back to watching. */
  async function recoverStuck(s: Strategy): Promise<void> {
    const open = await store.openExecutionsOf(s.id)
    if (open.length) return void (await store.setNext(s.id, now() + 10_000))
    if (s.kind === 'limit' && (s.status === 'triggered' || s.status === 'executing' || s.status === 'submitted') && now() - s.updatedAt > 2 * 60_000) {
      const key = await store.executionByKey(`limit:${s.id}:${s.attempts}`)
      if (key?.status === 'confirmed') {
        await settledOrder(s, (s.config as { limit: LimitConfig }).limit, { kind: 'confirmed', execution: key })
        return
      }
      const lc = (s.config as { limit: LimitConfig }).limit
      if (await cancelIfRequested(s, `${ORDER_LABEL[lc.type]} ${esc(lc.token.symbol)}`)) return
      if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'active', { reason: 'Recovered after an interruption: watching again', nextCheckAt: now() }))
        await store.event(s.id, 'recovered', 'Interrupted before trading: watching again')
      return
    }
    await store.setNext(s.id, now() + 10_000)
  }

  // ─── DCA ──────────────────────────────────────────────────────────────────

  type DcaState = { runs?: number; nextRunAt?: number; tries?: number }

  async function stepDca(s: Strategy, c: DcaConfig): Promise<void> {
    const st = s.state as DcaState
    const runs = st.runs ?? 0
    const nextRunAt = st.nextRunAt ?? c.startAt
    if ((c.endAt !== null && now() >= c.endAt) || (c.maxRuns !== null && runs >= c.maxRuns)) {
      if (await store.transition(s.id, ['active'], 'completed', { reason: `Completed after ${runs} buys` })) {
        await store.event(s.id, 'completed', `Completed after ${runs} buys`)
        await notify(s, `🏁 DCA into <b>${esc(c.token.symbol)}</b> completed after ${runs} buys.`)
      }
      return
    }
    if (now() < nextRunAt) return void (await store.setNext(s.id, nextRunAt))
    if ((await store.openExecutionsOf(s.id)).length) return void (await store.setNext(s.id, now() + 10_000))
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    if (!takeQuote()) return void (await store.setNext(s.id, now() + 15_000))
    const run = runs + 1
    const tries = st.tries ?? 0
    const out = await executor.trade({
      strategy: s,
      wallet,
      side: 'buy',
      token: c.token,
      amountIn: c.amountNear.toFixed(6).replace(/\.?0+$/, ''),
      slippagePct: c.slippagePct,
      // Each try of a run is its own trade (a try not sent never blocks the next one).
      idemKey: `dca:${s.id}:${run}:${tries}`,
      message: `DCA buy ${run}`,
      stillAllowed: allowedWhile(s, ['active']),
    })
    await settledDca(s, c, out, run)
  }

  /** A run's outcome. The plan's memory is written whatever its status (a pause meanwhile keeps what the buy settled); its next look while it is live. */
  async function settledDca(s: Strategy, c: DcaConfig, result: TradeOutcome, run: number): Promise<void> {
    let out = result
    // This try's trade exists already (settled before a restart, or by another worker): its own result decides.
    if (out.kind === 'duplicate') {
      const e = out.execution
      if (e.status === 'confirmed') out = { kind: 'confirmed', execution: e }
      else if (e.status === 'failed') out = { kind: 'failed', execution: e, reason: e.message ?? 'The trade failed on chain' }
      else if (e.status === 'cancelled') out = { kind: 'not-sent', execution: e, reason: e.message ?? 'Not sent' }
      else return void (await store.setNext(s.id, now() + 10_000))
    }
    const fresh = (await store.get(s.id)) ?? s
    const st = fresh.state as DcaState
    // Settled already (the step and a later settle both saw it): once.
    if ((st.runs ?? 0) >= run) return
    const every = c.everySec * 1000
    let next = (st.nextRunAt ?? c.startAt) + every
    while (next <= now()) next += every
    const keep = async (state: DcaState, at: number) => {
      await store.saveState(s.id, state)
      await store.setNext(s.id, at)
    }
    if (out.kind === 'confirmed' || out.kind === 'failed') {
      await keep({ runs: run, nextRunAt: next, tries: 0 }, next)
      const e = out.execution
      if (out.kind === 'confirmed') {
        await store.event(s.id, 'filled', `Buy ${run} confirmed: ${e.tokenRaw ? human(e.tokenRaw, c.token.decimals) : '?'} ${c.token.symbol}`)
        await notify(s, `✅ DCA buy ${run} into <b>${esc(c.token.symbol)}</b> confirmed on chain.`)
      } else {
        await store.event(s.id, 'failed', `Buy ${run} failed: ${out.reason}`)
        await notify(s, `⚠️ DCA buy ${run} into <b>${esc(c.token.symbol)}</b> failed: ${esc(out.reason)}. The next buy is on schedule.`)
      }
      return
    }
    if (out.kind === 'submitted') return void (await store.setNext(s.id, now() + 10_000))
    const tries = (st.tries ?? 0) + 1
    if (tries >= DCA_MAX_TRIES) {
      await store.event(s.id, 'skip', `Buy ${run} skipped after ${tries} tries: ${out.reason}`)
      await notify(s, `⚠️ DCA buy ${run} into <b>${esc(c.token.symbol)}</b> was skipped: ${esc(out.reason)}.`)
      return keep({ runs: run, nextRunAt: next, tries: 0 }, next)
    }
    await store.event(s.id, 'skip', `Buy ${run} not traded yet: ${out.reason}`)
    await keep({ ...st, tries }, now() + DCA_RETRY_MS)
  }

  // ─── Sniper ───────────────────────────────────────────────────────────────

  async function stepSniper(s: Strategy, c: SniperSettings): Promise<void> {
    if (c.expiresAt !== null && now() >= c.expiresAt) {
      if (await store.transition(s.id, ['active'], 'expired', { reason: 'Expired' })) {
        await store.event(s.id, 'expired', c.target === 'token' ? 'Expired before it bought' : 'Expired')
        await notify(s, `⌛ ${sniperName(c)} expired.`)
      }
      return
    }
    if ((await store.openExecutionsOf(s.id)).length) return void (await store.setNext(s.id, now() + 10_000))
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    if (c.target === 'new-pools' || !c.token) return stepSniperPools(s, c, wallet)
    return stepSniperToken(s, c, c.token, wallet)
  }

  const sniperName = (c: SniperSettings) => (c.target === 'token' && c.token ? `Sniper on <b>${esc(c.token.symbol)}</b>` : 'The new-pools sniper')

  /** Price impact as the router reports it; where it can't (no price feed), measured against a probe of 1% of the amount on the same route. Unknown stays unknown. */
  function impactAgainst(token: TokenRef, probe: bigint | null) {
    return (q: SwapQuote): number | null => {
      if (q.priceImpactPct !== null) return q.priceImpactPct
      const f = quoteAmounts('buy', q)
      const full = priceYocto(f.nearRaw, f.tokenRaw, token.decimals)
      if (probe === null || full === null || probe <= 0n) return null
      return full <= probe ? 0 : Number(((full - probe) * 10_000n) / probe) / 100
    }
  }

  async function stepSniperToken(s: Strategy, c: SniperSettings, token: TokenRef, wallet: TradingWallet): Promise<void> {
    if (!takeQuote()) return void (await store.setNext(s.id, now() + 15_000))
    const amountIn = c.amountNear.toFixed(6).replace(/\.?0+$/, '')
    let q: SwapQuote
    try {
      q = await custody.swaps.quote({ side: 'buy', token: token.id, symbol: token.symbol, decimals: token.decimals, amountIn, slippagePct: c.slippagePct }, wallet)
    } catch {
      return void (await store.setNext(s.id, now() + SNIPER_CHECK_MS, { ...s.state, waiting: 'No route trades it yet' }))
    }
    const a = quoteAmounts('buy', q)
    // Unknown impact stays unknown: buying then fails closed.
    const impactOf = impactAgainst(token, q.priceImpactPct === null && takeQuote() ? await probePrice(token, c, wallet) : null)
    const impact = impactOf(q)
    const marketCheck = await qualityProblem(token.id, c.minLiquidityUsd, c.mode === 'execute' ? impact : null, c.mode === 'execute' ? c.maxImpactPct : null)
    if (marketCheck) return void (await store.setNext(s.id, now() + SNIPER_CHECK_MS, { ...s.state, waiting: marketCheck }))
    const first = await store.addDetection({
      strategyId: s.id,
      sourceKey: `route:${token.id}`,
      side: 'buy',
      token: token.id,
      tokenRaw: a.tokenRaw.toString(),
      nearRaw: a.nearRaw.toString(),
      status: 'eligible',
      reason: null,
    })
    const price = priceYocto(a.nearRaw, a.tokenRaw, token.decimals)
    if (c.mode === 'notify') {
      if (first && (await store.transition(s.id, ['active'], 'completed', { reason: 'Tradable: you were told' }))) {
        await store.event(s.id, 'detected', `Tradable: ${amountIn} NEAR buys ${human(a.tokenRaw, token.decimals)} ${token.symbol}`)
        await notify(
          s,
          `🔔 <b>${esc(token.symbol)}</b> is tradable now: ${amountIn} NEAR buys about ${human(a.tokenRaw, token.decimals)} (${price ? formatPrice(price) : '?'} NEAR each, impact ${impact === null ? 'unknown' : `${impact.toFixed(2)}%`}). Notify-only: nothing was bought.`,
        )
      }
      return
    }
    const attempt = s.attempts + 1
    const out = await executor.trade({
      strategy: { ...s, attempts: attempt },
      wallet,
      side: 'buy',
      token,
      amountIn,
      slippagePct: c.slippagePct,
      idemKey: `sniper:${s.id}:${attempt}`,
      message: `Sniper attempt ${attempt}`,
      accept: (fresh) => {
        const i = impactOf(fresh)
        return i === null || i > c.maxImpactPct ? `Price impact ${i === null ? 'unknown' : `${i.toFixed(2)}%`} is over the ${c.maxImpactPct}% limit` : null
      },
      stillAllowed: allowedWhile(s, ['active']),
    })
    // A skip (no fresh quote, a limit) is not an attempt: nothing was created for it.
    if (out.kind === 'skipped') {
      await store.event(s.id, 'skip', out.reason)
      return void (await store.setNext(s.id, now() + SNIPER_CHECK_MS, { ...s.state, waiting: out.reason }))
    }
    await store.setAttempts(s.id, attempt)
    await settledSniper({ ...s, attempts: attempt }, c, token, out)
  }

  /** The price (yoctoNEAR per whole token) of a buy of 1% of the sniper's amount: the near-zero-impact reference. */
  async function probePrice(token: TokenRef, c: { amountNear: number; slippagePct: number }, wallet: TradingWallet): Promise<bigint | null> {
    const small = Math.max(c.amountNear / 100, 0.001)
      .toFixed(6)
      .replace(/\.?0+$/, '')
    try {
      const p = await custody.swaps.quote({ side: 'buy', token: token.id, symbol: token.symbol, decimals: token.decimals, amountIn: small, slippagePct: c.slippagePct }, wallet)
      const pa = quoteAmounts('buy', p)
      return priceYocto(pa.nearRaw, pa.tokenRaw, token.decimals)
    } catch {
      return null
    }
  }

  async function settledSniper(s: Strategy, c: SniperSettings, token: TokenRef, out: TradeOutcome): Promise<void> {
    if (out.kind === 'confirmed') {
      // Paused while its buy was on its way: bought all the same, so it ends (it never buys twice).
      if (await store.transition(s.id, ['active', 'paused'], 'completed', { reason: 'Bought on chain' })) {
        const e = out.execution
        await store.updateDetection(s.id, `route:${token.id}`, 'confirmed', { executionId: e.id })
        await store.event(s.id, 'filled', `Bought ${e.tokenRaw ? human(e.tokenRaw, token.decimals) : '?'} ${token.symbol} on chain`)
        await notify(
          s,
          `✅ Sniper bought <b>${esc(token.symbol)}</b>, confirmed on chain: ${e.tokenRaw ? human(e.tokenRaw, token.decimals) : '?'} for ${e.nearRaw ? near(e.nearRaw) : '?'} NEAR.`,
        )
      }
      return
    }
    if (out.kind === 'submitted' || out.kind === 'duplicate') return void (await store.setNext(s.id, now() + 10_000))
    const reason = out.reason
    await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `Attempt ${s.attempts}: ${reason}`)
    if (out.kind === 'failed' || out.kind === 'not-sent') {
      if (s.attempts >= c.maxAttempts) {
        if (await store.transition(s.id, ['active'], 'failed', { reason: `No buy after ${s.attempts} attempts: ${reason}` }))
          await notify(s, `❌ Sniper on <b>${esc(token.symbol)}</b> stopped after ${s.attempts} attempts: ${esc(reason)}`)
        return
      }
    }
    await store.setNext(s.id, now() + SNIPER_CHECK_MS)
  }

  // ─── Sniper: new pools ────────────────────────────────────────────────────

  type PoolSniperState = {
    /** The last ready pool handled (its ready time and id): the ones after it are still to look at. */
    readyAfter?: { at: number; id: number }
    buys?: number
    failures?: number
    /** Pools without an executable route yet, with when they were first tried. */
    retry?: Record<string, number>
    waiting?: string | null
  }

  const poolKey = (p: Pick<NewPool, 'source' | 'poolId'>) => `pool:${p.source}:${p.poolId}`
  const sourceOfPool = (p: NewPool): SniperSource => p.launchpad ?? 'other'
  const poolWhat = (p: NewPool) =>
    p.launchpad === 'nearly' ? 'a new Nearly launch' : p.launchpad === 'meme-cooking' ? 'a meme.cooking graduation' : `a new ${p.source === 'dcl' ? 'Ref DCL' : 'Ref'} pool`

  /**
   * New pools the feed found ready (NEAR liquidity in them) after this sniper was made, each once: from
   * the sources it watches, holding at least its NEAR minimum, with an executable route from its wallet
   * within its price impact, and a round trip (buy then sell back) losing at most ROUND_TRIP_MAX_LOSS_PCT.
   * Notify-only tells its owner of each; buying buys each once, up to its number of tokens.
   */
  async function stepSniperPools(s: Strategy, c: SniperSettings, wallet: TradingWallet): Promise<void> {
    const st: PoolSniperState = { ...(s.state as PoolSniperState) }
    if (!deps.pools) return void (await store.setNext(s.id, now() + 60_000, { ...st, waiting: 'This server doesn’t read new pools' }))
    st.waiting = null
    const handle = async (p: NewPool): Promise<'next' | 'stop' | 'later'> => {
      if (!p.token || !c.sources.includes(sourceOfPool(p))) return 'next'
      const key = poolKey(p)
      const seen = await store.detection(s.id, key)
      if (seen && seen.status !== 'detected') return 'next'
      return snipePool(s, c, wallet, st, p, key)
    }
    // Pools still waiting for a route first (gone ones forgotten), then the ones that became ready since the last one handled.
    let go = true
    for (const k of Object.keys(st.retry ?? {})) {
      const p = await poolOfKey(k)
      if (!p) {
        if (st.retry) delete st.retry[k]
        continue
      }
      if ((await handle(p)) !== 'next') {
        go = false
        break
      }
    }
    if (go) {
      for (const p of await deps.pools.store.readySince(deps.network.id, s.createdAt, st.readyAfter ?? { at: 0, id: 0 }, POOLS_PER_STEP)) {
        // Ready too long ago (the sniper was paused, held by a switch, or short of quotes): no longer new.
        if (p.readyAt !== null && now() - p.readyAt > POOL_MAX_AGE_MS) {
          st.readyAfter = { at: p.readyAt, id: p.id }
          continue
        }
        const r = await handle(p)
        // Not looked at yet (the quote budget spent): the cursor stays before it.
        if (r === 'later') break
        st.readyAfter = { at: p.readyAt ?? 0, id: p.id }
        if (r === 'stop') break
      }
    }
    const current = await store.get(s.id)
    if (current?.status === 'active') await store.setNext(s.id, now() + POOL_SNIPER_CHECK_MS, st)
  }

  async function poolOfKey(key: string): Promise<NewPool | null> {
    const [, source, ...rest] = key.split(':')
    if ((source !== 'dcl' && source !== 'ref') || !deps.pools) return null
    return deps.pools.store.get(deps.network.id, source, rest.join(':'))
  }

  async function snipePool(s: Strategy, c: SniperSettings, wallet: TradingWallet, st: PoolSniperState, p: NewPool, key: string): Promise<'next' | 'stop' | 'later'> {
    const tokenId = p.token as string
    const base = { strategyId: s.id, sourceKey: key, side: 'buy' as const, token: tokenId, tokenRaw: null, nearRaw: p.nearRaw }
    const record = async (status: 'detected' | 'skipped', reason: string) => {
      if (!(await store.addDetection({ ...base, status, reason }))) await store.updateDetection(s.id, key, status, { reason })
    }
    const settle = async (reason: string) => {
      if (st.retry) delete st.retry[key]
      await record('skipped', reason)
      return 'next' as const
    }
    const poolNear = p.nearRaw && /^\d+$/.test(p.nearRaw) ? near(p.nearRaw) : 0
    if (c.minPoolNear !== null && poolNear < c.minPoolNear) return settle(`The pool holds ${poolNear} NEAR, below this sniper’s ${c.minPoolNear} NEAR`)
    const meta = await deps.near.ctx.reader.metadata(tokenId).catch(() => null)
    if (!meta) return settle('The token’s metadata can’t be read from chain')
    const token: TokenRef = { id: tokenId, symbol: meta.symbol, decimals: meta.decimals }
    // The buy, a probe of its impact and the round trip: all three from the budget, or later.
    if (!takeQuotes(3)) return 'later'
    const amountIn = c.amountNear.toFixed(6).replace(/\.?0+$/, '')
    let q: SwapQuote
    try {
      q = await custody.swaps.quote({ side: 'buy', token: token.id, symbol: token.symbol, decimals: token.decimals, amountIn, slippagePct: c.slippagePct }, wallet)
    } catch {
      // A new pool may not be routed yet (an aggregator indexes it later): looked at again for a while.
      const first = st.retry?.[key] ?? now()
      if (now() - first > POOL_ROUTE_WAIT_MS) return settle('No route traded it from a NEARKITS wallet within 5 minutes')
      st.retry = { ...(st.retry ?? {}), [key]: first }
      await record('detected', 'Waiting for a route from a NEARKITS wallet')
      return 'next'
    }
    if (st.retry) delete st.retry[key]
    const a = quoteAmounts('buy', q)
    const impactOf = impactAgainst(token, q.priceImpactPct === null ? await probePrice(token, c, wallet) : null)
    const impact = impactOf(q)
    if (impact === null || impact > c.maxImpactPct) return settle(`Price impact ${impact === null ? 'unknown' : `${impact.toFixed(2)}%`} is over ${c.maxImpactPct}%`)
    // A round trip (this buy, then selling what it gets) shows fees, a tax and a pool too thin to leave.
    let loss: number | null = null
    try {
      const back = await custody.swaps.quote(
        { side: 'sell', token: token.id, symbol: token.symbol, decimals: token.decimals, amountIn: formatUnits(a.tokenRaw, token.decimals), slippagePct: c.slippagePct },
        wallet,
      )
      const nearBack = quoteAmounts('sell', back).nearRaw
      loss = a.nearRaw > 0n ? Number(((a.nearRaw - (nearBack < a.nearRaw ? nearBack : a.nearRaw)) * 10_000n) / a.nearRaw) / 100 : null
    } catch {
      loss = null
    }
    if (loss === null) return settle('Selling it back can’t be quoted: not bought')
    if (loss > ROUND_TRIP_MAX_LOSS_PCT) return settle(`A round trip loses ${loss.toFixed(2)}% (fees, a tax or a thin pool): over ${ROUND_TRIP_MAX_LOSS_PCT}%`)
    const facts = `${amountIn} NEAR buys about ${human(a.tokenRaw, token.decimals)} ${token.symbol} (impact ${impact.toFixed(2)}%, a round trip loses ${loss.toFixed(2)}%); the pool holds ${poolNear} NEAR`
    if (!(await store.addDetection({ ...base, tokenRaw: a.tokenRaw.toString(), nearRaw: a.nearRaw.toString(), status: 'eligible', reason: facts })))
      await store.updateDetection(s.id, key, 'eligible', { reason: facts })
    if (c.mode === 'notify') {
      await store.event(s.id, 'detected', `${token.symbol} (${poolWhat(p)}): ${facts}`)
      await notify(s, `🆕 <b>${esc(token.symbol)}</b> (<code>${esc(token.id)}</code>), ${poolWhat(p)}: ${esc(facts)}. Notify-only: nothing was bought.`)
      return 'next'
    }
    if ((st.buys ?? 0) >= c.maxBuys) return 'stop'
    const out = await executor.trade({
      strategy: s,
      wallet,
      side: 'buy',
      token,
      amountIn,
      slippagePct: c.slippagePct,
      idemKey: `sniper:${s.id}:${key}`,
      source: key,
      message: `Sniper buy of ${token.symbol} (${poolWhat(p)})`,
      accept: (fresh) => {
        const i = impactOf(fresh)
        return i === null || i > c.maxImpactPct ? `Price impact ${i === null ? 'unknown' : `${i.toFixed(2)}%`} is over the ${c.maxImpactPct}% limit` : null
      },
      stillAllowed: allowedWhile(s, ['active']),
    })
    if (out.kind === 'skipped') {
      await store.updateDetection(s.id, key, 'skipped', { reason: out.reason })
      return 'next'
    }
    await settledPoolSnipe(s, c, token, key, out, st)
    return out.kind === 'confirmed' && (st.buys ?? 0) < c.maxBuys ? 'next' : 'stop'
  }

  async function settledPoolSnipe(s: Strategy, c: SniperSettings, token: TokenRef, key: string, out: TradeOutcome, st: PoolSniperState): Promise<void> {
    if (out.kind === 'duplicate') return
    if (out.kind === 'submitted') return void (await store.updateDetection(s.id, key, 'submitted', { executionId: out.execution.id }))
    // Each pool's outcome counts once (the step and a later settle may both see it).
    const seen = await store.detection(s.id, key)
    if (seen && (seen.status === 'confirmed' || seen.status === 'failed' || seen.status === 'skipped')) return
    // Counted whatever the status: a buy that confirms while its owner paused it still counts toward its tokens.
    const keep = async () => {
      await store.saveState(s.id, st)
      await store.setNext(s.id, now() + POOL_SNIPER_CHECK_MS)
    }
    if (out.kind === 'confirmed') {
      const e = out.execution
      await store.updateDetection(s.id, key, 'confirmed', { executionId: e.id })
      st.buys = (st.buys ?? 0) + 1
      await store.event(s.id, 'filled', `Bought ${e.tokenRaw ? human(e.tokenRaw, token.decimals) : '?'} ${token.symbol} on chain (${st.buys} of ${c.maxBuys})`)
      await notify(
        s,
        `✅ The new-pools sniper bought <b>${esc(token.symbol)}</b>, confirmed on chain: ${e.tokenRaw ? human(e.tokenRaw, token.decimals) : '?'} for ${e.nearRaw ? near(e.nearRaw) : '?'} NEAR (${st.buys} of ${c.maxBuys}).`,
      )
      await keep()
      if (st.buys >= c.maxBuys && (await store.transition(s.id, ['active', 'paused'], 'completed', { reason: `Bought ${st.buys} new tokens` })))
        await store.event(s.id, 'completed', `Bought ${st.buys} new tokens`)
      return
    }
    const reason = out.reason
    await store.updateDetection(s.id, key, out.kind === 'failed' ? 'failed' : 'skipped', { reason, ...('execution' in out ? { executionId: out.execution.id } : {}) })
    st.failures = (st.failures ?? 0) + 1
    await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `${token.symbol}: ${reason}`)
    if (out.kind === 'failed') await notify(s, `⚠️ The new-pools sniper’s buy of <b>${esc(token.symbol)}</b> failed: ${esc(reason)}`)
    await keep()
    if (st.failures >= c.maxAttempts && (await store.transition(s.id, ['active', 'paused'], 'failed', { reason: `${st.failures} buys not made: ${reason}` })))
      await notify(s, `❌ The new-pools sniper stopped after ${st.failures} buys that weren’t made: ${esc(reason)}`)
  }

  /** Market quality for an automated buy: liquidity (fresh, known) and price impact within limits. */
  async function qualityProblem(token: string, minLiquidityUsd: number | null, impactPct: number | null, maxImpactPct: number | null): Promise<string | null> {
    if (maxImpactPct !== null && (impactPct === null || impactPct > maxImpactPct))
      return `Price impact ${impactPct === null ? 'unknown' : `${impactPct.toFixed(2)}%`} is over ${maxImpactPct}%`
    if (minLiquidityUsd !== null && minLiquidityUsd > 0) {
      const m = await deps.near.tokens.getMarketData(token).catch(() => null)
      const liquidity = liquidityOf(m?.liquidityUsd, now(), LIQUIDITY_MAX_AGE_SEC)
      if (liquidity === null) return 'Its market liquidity is unknown'
      if (liquidity < minLiquidityUsd) return `Liquidity $${Math.round(liquidity)} is below $${minLiquidityUsd}`
    }
    return null
  }

  // ─── Copy Trade ───────────────────────────────────────────────────────────

  type Position = { nearIn: string; tokenRaw: string }
  /** A copied trade not made yet that is tried again: what it copies, when that happened, its tries so far and why it waits. */
  type PendingLeg = { side: 'buy' | 'sell'; token: string; tokenRaw: string; sourceNear: string | null; at: number; tries: number; reason: string }
  type CopyState = {
    since?: number
    /** Every transaction of the account up to this moment (ms) is handled: recorded, or not one it started. */
    cursorMs?: number
    positions?: Record<string, Position>
    limitNoticeAt?: number
    /** Since when the transaction index hasn't answered (null: it answers). */
    indexDownSince?: number | null
    indexNoticeAt?: number
    /** Transactions neither the index nor RPC could serve yet: the tries so far and when each happened. */
    unread?: Record<string, { tries: number; at: number }>
    /** Copied trades to try again (by their source key): a sell the rule owes is never dropped on a passing failure. */
    pendingLegs?: Record<string, PendingLeg>
    waiting?: string | null
  }

  /** FastNEAR's lag behind the chain (seconds), read once for every rule every little while; 'down' when it doesn't answer. */
  let indexStatus: { at: number; lag: Promise<number | 'down'> } | null = null
  function indexLag(): Promise<number | 'down'> {
    if (indexStatus && now() - indexStatus.at < INDEX_STATUS_TTL_MS) return indexStatus.lag
    const lag = fetchIndexLag(fetchImpl, deps.network.discovery.fastnearTxUrl)
      .then((l) => l ?? 0)
      .catch(() => 'down' as const)
    indexStatus = { at: now(), lag }
    return lag
  }

  /** A transaction the followed account signed itself, read from NEAR RPC: the fallback when the index can't serve it. */
  async function rpcTx(r: TxRef, signer: string): Promise<NormalizedTx | null> {
    try {
      return fromRpc(await deps.near.ctx.rpc.txStatus(r.hash, signer, 'FINAL'), { height: r.blockHeight, timestampMs: r.timestampMs })
    } catch {
      return null
    }
  }

  /** The rule's memory, written whatever its status (a pause meanwhile keeps its positions and what it owes), then its next look while live. */
  async function keepCopy(s: Strategy, st: CopyState, at: number): Promise<void> {
    await store.saveState(s.id, st)
    await store.setNext(s.id, at)
  }

  /** The index doesn't answer: the rule waits (and says so); its owner is told once when that lasts. */
  async function indexDown(s: Strategy, c: CopyConfig, st: CopyState): Promise<void> {
    const since = st.indexDownSince ?? now()
    const next: CopyState = { ...st, indexDownSince: since, waiting: 'FastNEAR’s transaction index isn’t answering: copies wait' }
    const minutes = Math.round((now() - since) / 60_000)
    if (now() - since >= INDEX_DOWN_NOTICE_MS && !(typeof st.indexNoticeAt === 'number' && st.indexNoticeAt >= since)) {
      next.indexNoticeAt = now()
      await store.event(s.id, 'held', `The transaction index hasn’t answered for ${minutes} min: copies wait`)
      await notify(
        s,
        `⚠️ Copy of <b>${esc(c.target)}</b>: FastNEAR’s transaction index hasn’t answered for ${minutes} minutes. Copies wait; a trade seen more than ${COPY_MAX_DELAY_MS / 60_000} minutes after it happened is not copied.`,
      )
    }
    await keepCopy(s, next, now() + 60_000)
  }

  const unreadOf = (u: CopyState['unread'] | Record<string, unknown> | undefined): Record<string, { tries: number; at: number }> =>
    Object.fromEntries(
      Object.entries(u ?? {}).map(([h, v]) => [
        h,
        typeof v === 'number' ? { tries: v, at: now() } : { tries: Number((v as { tries?: number }).tries) || 0, at: Number((v as { at?: number }).at) || now() },
      ]),
    )

  /**
   * Reads the followed account's new transactions (FastNEAR's index, paged back to where the rule got
   * to; each transaction the account started read in full, from the index or else from NEAR RPC) and
   * copies each once, in order: a transaction not readable yet stops the step there, so a later sell is
   * never copied before the buy it follows. Copied trades owed from earlier (a sell that couldn't be made
   * then) are tried first. A trade seen too late (the index behind or down) is recorded, not copied.
   */
  async function stepCopy(s: Strategy, c: CopyConfig): Promise<void> {
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    const st: CopyState = { ...(s.state as CopyState) }
    const since = st.since ?? s.createdAt
    const positions = { ...(st.positions ?? {}) }
    st.positions = positions
    await retryPending(s, c, wallet, st, positions)
    const url = deps.network.discovery.fastnearTxUrl
    const lag = await indexLag()
    if (lag === 'down') return indexDown(s, c, st)
    let listed: { txs: TxRef[]; complete: boolean }
    try {
      listed = await fetchAccountTxs(fetchImpl, url, c.target, { max: COPY_LIST_MAX, pageSize: 25, pace: async () => undefined, until: st.cursorMs ?? since })
    } catch (e) {
      log.warn('copy trade: the transaction index failed', { strategy: s.id, error: e })
      return indexDown(s, c, st)
    }
    if (typeof st.indexDownSince === 'number') {
      await store.event(s.id, 'resumed', `The transaction index answers again after ${Math.round((now() - st.indexDownSince) / 60_000)} min`)
      st.indexDownSince = null
    }
    st.waiting = lag > COPY_MAX_LAG_SEC ? `FastNEAR’s index is ${Math.round(lag)} s behind the chain: trades seen late are not copied` : null
    let floor = st.cursorMs ?? since
    // More transactions since the last look than one listing holds: the ones before the oldest listed weren't read.
    if (!listed.complete && listed.txs.length) {
      const oldest = Math.min(...listed.txs.map((r) => r.timestampMs))
      if (oldest > floor) {
        await store.event(s.id, 'gap', `More than ${COPY_LIST_MAX} transactions since the last look: the older ones weren’t read (too late to copy by now)`)
        floor = oldest
      }
    }
    // Final and after the rule was made; the same moment as the cursor again (one block holds several transactions).
    const candidates = listed.txs
      .filter((r) => r.timestampMs > since && r.timestampMs >= floor && now() - r.timestampMs > COPY_FINALITY_MS)
      .sort((a, b) => a.timestampMs - b.timestampMs)
    const inView = new Set(candidates.map((r) => r.hash))
    const unread = unreadOf(st.unread)
    // Unread ones out of view now (the listing moved on, or the cursor passed them): recorded, not kept forever.
    for (const [hash, u] of Object.entries(unread)) {
      if (inView.has(hash)) continue
      delete unread[hash]
      await recordUnreadable(s, hash, u.at)
    }
    const todo: TxRef[] = []
    for (const r of candidates) if (!(await store.detection(s.id, r.hash))) todo.push(r)
    // Only what the account started can be copied: the rest isn't read in full. A failed one is recorded without reading it.
    const started = todo.filter((r) => r.signer !== false)
    for (const r of started.filter((x) => x.success === false))
      await store.addDetection({
        strategyId: s.id,
        sourceKey: r.hash,
        at: r.timestampMs,
        side: null,
        token: null,
        tokenRaw: null,
        nearRaw: null,
        status: 'skipped',
        reason: 'Failed on chain',
      })
    const readable = started.filter((r) => r.success !== false)
    const batch = readable.slice(0, COPY_READ_PER_STEP)
    let full: NormalizedTx[] = []
    try {
      full = batch.length ? await fetchFullTxs(fetchImpl, url, batch, async () => undefined) : []
    } catch (e) {
      log.warn('copy trade: reading transactions from the index failed', { strategy: s.id, error: e })
    }
    const byHash = new Map(full.map((t) => [t.hash, t]))
    for (const r of batch) {
      if (byHash.has(r.hash) || !r.directSigner) continue
      const tx = await rpcTx(r, c.target)
      if (tx) byHash.set(r.hash, tx)
    }
    // In order; the first one readable nowhere yet stops the step (tried again, then recorded as unreadable).
    let stopped = -1
    for (const [i, r] of batch.entries()) {
      const tx = byHash.get(r.hash)
      if (!tx) {
        const u = unread[r.hash] ?? { tries: 0, at: r.timestampMs }
        u.tries += 1
        if (u.tries < COPY_MAX_READ_TRIES) {
          unread[r.hash] = u
          stopped = i
          break
        }
        delete unread[r.hash]
        await recordUnreadable(s, r.hash, r.timestampMs)
        continue
      }
      delete unread[r.hash]
      await copyOne(s, c, wallet, st, positions, tx)
    }
    // The cursor moves up to the first transaction still to do (unread, or beyond this step's batch).
    const pending = new Set((stopped >= 0 ? batch.slice(stopped) : []).concat(readable.slice(COPY_READ_PER_STEP)).map((r) => r.hash))
    let cursor = st.cursorMs ?? since
    for (const r of candidates) {
      if (pending.has(r.hash)) break
      cursor = Math.max(cursor, r.timestampMs)
    }
    const owed = Object.keys(st.pendingLegs ?? {}).length > 0
    const delay = stopped >= 0 ? COPY_UNREAD_RETRY_MS : pending.size ? 3_000 : owed ? COPY_PENDING_RETRY_MS : COPY_CHECK_MS
    await keepCopy(s, { ...st, since, cursorMs: cursor, positions, unread }, now() + delay)
  }

  async function recordUnreadable(s: Strategy, hash: string, at: number): Promise<void> {
    await store.addDetection({
      strategyId: s.id,
      sourceKey: hash,
      at,
      side: null,
      token: null,
      tokenRaw: null,
      nearRaw: null,
      status: 'skipped',
      reason: 'Its details couldn’t be read (the index and NEAR RPC both failed)',
    })
  }

  /** One transaction of the followed account: skipped with its reason, or copied (a token-for-token swap as two NEAR trades). */
  async function copyOne(s: Strategy, c: CopyConfig, wallet: TradingWallet, st: CopyState, positions: Record<string, Position>, tx: NormalizedTx): Promise<void> {
    const read = readCopyTrade(tx, c.target, deps.network)
    const at = tx.timestampMs ?? now()
    const base = { strategyId: s.id, sourceKey: tx.hash, at }
    if (!read.ok) return void (await store.addDetection({ ...base, side: null, token: null, tokenRaw: null, nearRaw: null, status: 'skipped', reason: read.reason }))
    // Seen too long after it happened (the index was behind or down): its price has moved, so it isn't copied.
    const late = now() - at
    if (late > COPY_MAX_DELAY_MS) {
      const reason = `Seen ${Math.round(late / 1000)} s after it happened (the index was behind): not copied at a price that has moved`
      if (read.side === 'swap') await store.addDetection({ ...base, side: null, token: read.bought, tokenRaw: read.boughtRaw.toString(), nearRaw: null, status: 'skipped', reason })
      else
        await store.addDetection({ ...base, side: read.side, token: read.token, tokenRaw: read.tokenRaw.toString(), nearRaw: read.nearRaw.toString(), status: 'skipped', reason })
      return
    }
    if (read.side !== 'swap')
      return copyLeg(s, c, wallet, st, positions, { key: tx.hash, side: read.side, token: read.token, tokenRaw: read.tokenRaw, sourceNear: read.nearRaw, at })
    // A token-for-token swap: NEARKITS wallets trade against NEAR, so it is copied as a sell of what this
    // rule holds of the first token and a buy of the second with NEAR (each its own trade and record).
    const recorded = await store.addDetection({
      ...base,
      side: null,
      token: read.bought,
      tokenRaw: read.boughtRaw.toString(),
      nearRaw: null,
      status: 'detected',
      reason: `A swap of ${read.sold} for ${read.bought}: copied as NEAR trades (a sell of what this rule holds of the first, a buy of the second)`,
    })
    if (!recorded) return
    await copyLeg(s, c, wallet, st, positions, { key: `${tx.hash}:sell`, side: 'sell', token: read.sold, tokenRaw: read.soldRaw, sourceNear: null, at })
    // A buy sized as a share of what the account spent needs that in NEAR: the token's executable NEAR value now.
    const value = c.sizing.mode === 'percent' && c.copy !== 'sell' ? await nearValueOf(read.sold, read.soldRaw, wallet) : null
    await copyLeg(s, c, wallet, st, positions, { key: `${tx.hash}:buy`, side: 'buy', token: read.bought, tokenRaw: read.boughtRaw, sourceNear: value, at })
  }

  /** Copied trades owed from earlier steps, tried again while their window lasts (a sell 15 minutes, a buy only while it is fresh). */
  async function retryPending(s: Strategy, c: CopyConfig, wallet: TradingWallet, st: CopyState, positions: Record<string, Position>): Promise<void> {
    for (const [key, p] of Object.entries(st.pendingLegs ?? {})) {
      const window = p.side === 'sell' ? COPY_SELL_RETRY_MS : COPY_MAX_DELAY_MS
      if (now() - p.at > window) {
        if (st.pendingLegs) delete st.pendingLegs[key]
        await store.updateDetection(s.id, key, 'skipped', { reason: `Not made within ${Math.round(window / 60_000)} minutes: ${p.reason}` })
        await store.event(s.id, 'skip', `A copied ${p.side} of ${p.token} wasn’t made within ${Math.round(window / 60_000)} minutes: ${p.reason}`)
        if (p.side === 'sell') await notify(s, `⚠️ Copy of <b>${esc(c.target)}</b>: a sell couldn’t be made in time (${esc(p.reason)}). The tokens stay in your NEARKITS wallet.`)
        continue
      }
      await copyLeg(
        s,
        c,
        wallet,
        st,
        positions,
        { key, side: p.side, token: p.token, tokenRaw: BigInt(p.tokenRaw), sourceNear: p.sourceNear ? BigInt(p.sourceNear) : null, at: p.at },
        p.tries,
      )
    }
  }

  /** What `raw` of a token would sell for in NEAR now (an executable quote from the rule's wallet); null when unknown. */
  async function nearValueOf(token: string, raw: bigint, wallet: TradingWallet): Promise<bigint | null> {
    const meta = await deps.near.ctx.reader.metadata(token).catch(() => null)
    if (!meta || !takeQuote()) return null
    try {
      const q = await custody.swaps.quote(
        { side: 'sell', token, symbol: meta.symbol, decimals: meta.decimals, amountIn: formatUnits(raw, meta.decimals), slippagePct: AUTOMATION_MAX_SLIPPAGE },
        wallet,
      )
      return quoteAmounts('sell', q).nearRaw
    } catch {
      return null
    }
  }

  /** A copied trade that couldn't be made now and may be later: kept (its detection says why), tried on the next steps. */
  async function owe(s: Strategy, st: CopyState, leg: CopyLeg, tries: number, reason: string): Promise<void> {
    st.pendingLegs = {
      ...(st.pendingLegs ?? {}),
      [leg.key]: { side: leg.side, token: leg.token, tokenRaw: leg.tokenRaw.toString(), sourceNear: leg.sourceNear?.toString() ?? null, at: leg.at, tries: tries + 1, reason },
    }
    const waiting = `Waiting to try again: ${reason}`
    const added = await store.addDetection({
      strategyId: s.id,
      sourceKey: leg.key,
      at: leg.at,
      side: leg.side,
      token: leg.token,
      tokenRaw: leg.tokenRaw.toString(),
      nearRaw: leg.sourceNear?.toString() ?? null,
      status: 'detected',
      reason: waiting,
    })
    if (!added) await store.updateDetection(s.id, leg.key, 'detected', { reason: waiting })
  }

  type CopyLeg = { key: string; side: 'buy' | 'sell'; token: string; tokenRaw: bigint; sourceNear: bigint | null; at: number }

  /**
   * One copied trade, with everything checked again right before it: the side and exclusions, the
   * token from chain, the size within the rule's limits and its exposure (trades still under way
   * included), price impact (a buy), what the wallet holds (a sell never sells more than this rule
   * bought, nor than the wallet holds, and waits for this rule's own buy still on its way), the quote
   * budget; then the custody path (fresh quote, slippage, NEARKITS' limits, the signer). A sell that
   * can't be made now is owed (tried again); a buy is not chased (only while it is fresh).
   */
  async function copyLeg(s: Strategy, c: CopyConfig, wallet: TradingWallet, st: CopyState, positions: Record<string, Position>, leg: CopyLeg, tries = 0): Promise<void> {
    const detected = {
      strategyId: s.id,
      sourceKey: leg.key,
      at: leg.at,
      side: leg.side,
      token: leg.token,
      tokenRaw: leg.tokenRaw.toString(),
      nearRaw: leg.sourceNear?.toString() ?? null,
    }
    const settled = () => {
      if (st.pendingLegs) delete st.pendingLegs[leg.key]
    }
    // Recorded as skipped (added, or updated when it waited before): this leg is done.
    const final = async (reason: string) => {
      settled()
      if (!(await store.addDetection({ ...detected, status: 'skipped', reason }))) await store.updateDetection(s.id, leg.key, 'skipped', { reason })
    }
    if (c.copy !== 'both' && c.copy !== leg.side) return final(`Copying ${c.copy}s only`)
    if (c.exclude.includes(leg.token)) return final('The token is excluded')
    // A sell of what this rule never bought (and isn't buying now): nothing to sell, nothing owed.
    const buying = leg.side === 'sell' && (await store.openExecutionsOf(s.id)).some((e) => e.side === 'buy' && e.token === leg.token)
    if (leg.side === 'sell' && !positions[leg.token] && !buying) return final(`Nothing this rule bought of ${leg.token} is left to sell`)
    const meta = await deps.near.ctx.reader.metadata(leg.token).catch(() => null)
    if (!meta)
      return leg.side === 'sell' ? owe(s, st, leg, tries, 'The token’s metadata can’t be read from chain right now') : final('The token’s metadata can’t be read from chain')
    const token: TokenRef = { id: leg.token, symbol: meta.symbol, decimals: meta.decimals }
    if (!(await store.addDetection({ ...detected, status: 'eligible', reason: null }))) {
      // Seen before: go on only with a trade this rule still owes.
      const seen = await store.detection(s.id, leg.key)
      if (seen?.status !== 'detected' || !st.pendingLegs?.[leg.key]) return
      await store.updateDetection(s.id, leg.key, 'eligible', { reason: null })
    }
    let amountIn: string
    let accept: ((q: SwapQuote) => string | null) | undefined
    if (leg.side === 'buy') {
      if (c.sizing.mode === 'percent' && leg.sourceNear === null) return final('What the account spent is unknown in NEAR')
      // Exposure: NEAR in copied buys not sold back, and in buys still under way.
      const exposure = Object.values(positions).reduce((sum, p) => sum + near(p.nearIn), 0) + near(await store.openBuyNear(s.id))
      const size = copyBuySize(c, leg.sourceNear === null ? 0 : near(leg.sourceNear), exposure)
      if ('skip' in size) {
        await final(size.skip)
        // A risk-limit refusal is worth a notice, once an hour per rule: every skip stays in the history.
        const lastNotice = typeof st.limitNoticeAt === 'number' ? st.limitNoticeAt : 0
        if (now() - lastNotice > 3_600_000) {
          st.limitNoticeAt = now()
          await notify(s, `⛔ Copy of <b>${esc(c.target)}</b>: a buy of ${esc(token.symbol)} was not copied: ${esc(size.skip)}.`)
        }
        return
      }
      const quality = await qualityProblem(token.id, c.minLiquidityUsd, null, null)
      if (quality) return final(quality)
      // The buy, and a probe of its price impact: both from the budget, while the trade is fresh.
      if (!takeQuotes(2))
        return now() - leg.at < COPY_MAX_DELAY_MS ? owe(s, st, leg, tries, 'NEARKITS’ quote budget was spent') : final('NEARKITS’ quote budget was spent; too late to copy')
      amountIn = size.near.toFixed(6).replace(/\.?0+$/, '')
      // Price impact as the router reports it, or measured against a 1% probe: over the limit (or unknown), it isn't bought.
      const impactOf = impactAgainst(token, await probePrice(token, { amountNear: size.near, slippagePct: c.slippagePct }, wallet))
      accept = (q) => {
        const i = impactOf(q)
        return i === null || i > COPY_MAX_IMPACT_PCT ? `Price impact ${i === null ? 'unknown' : `${i.toFixed(2)}%`} is over the ${COPY_MAX_IMPACT_PCT}% copied buys accept` : null
      }
    } else {
      // This rule's own buy of it still on its way: the position isn't known yet, so the sell waits for it.
      if (buying) return owe(s, st, leg, tries, `This rule’s buy of ${token.symbol} is still on its way`)
      const pos = positions[token.id]
      if (!pos) return final(`Nothing this rule bought of ${token.symbol} is left to sell`)
      const held = await tokenBalance(token.id, wallet)
      if (held === null) return owe(s, st, leg, tries, 'The wallet’s balance can’t be read right now')
      const sell = BigInt(pos.tokenRaw) < held ? BigInt(pos.tokenRaw) : held
      if (sell <= 0n) return final(`Nothing this rule bought of ${token.symbol} is left in the wallet`)
      if (!takeQuote()) return owe(s, st, leg, tries, 'NEARKITS’ quote budget was spent')
      amountIn = formatUnits(sell, token.decimals)
    }
    await store.updateDetection(s.id, leg.key, 'executing')
    const out = await executor.trade({
      strategy: s,
      wallet,
      side: leg.side,
      token,
      amountIn,
      slippagePct: c.slippagePct,
      // Each try its own trade (a try not sent never blocks the next one); the source stays the leg's key.
      idemKey: `copy:${s.id}:${leg.key}${tries ? `#${tries}` : ''}`,
      source: leg.key,
      message: `Copy of ${c.target}’s ${leg.side}`,
      ...(accept ? { accept } : {}),
      stillAllowed: allowedWhile(s, ['active']),
    })
    // A sell not made this time (refused before signing, the price moving, a skip) is owed, not dropped.
    if (leg.side === 'sell' && (out.kind === 'skipped' || out.kind === 'not-sent')) return owe(s, st, leg, tries, out.reason)
    settled()
    await settledCopy(s, c, token, leg.key, out, positions)
  }

  async function settledCopy(s: Strategy, c: CopyConfig, token: TokenRef, source: string, out: TradeOutcome, positions: Record<string, Position>): Promise<void> {
    if (out.kind === 'confirmed') {
      // Each copied trade counts once (the step and a later settle may both see it).
      if ((await store.detection(s.id, source))?.status === 'confirmed') return
      const e = out.execution
      await store.updateDetection(s.id, source, 'confirmed', { executionId: e.id })
      const pos = positions[token.id] ?? { nearIn: '0', tokenRaw: '0' }
      if (e.side === 'buy')
        positions[token.id] = {
          nearIn: (BigInt(pos.nearIn) + BigInt(e.nearRaw ?? e.nearInRaw ?? '0')).toString(),
          tokenRaw: (BigInt(pos.tokenRaw) + BigInt(e.tokenRaw ?? '0')).toString(),
        }
      else {
        const left = BigInt(pos.tokenRaw) - BigInt(e.tokenRaw ?? e.amountInRaw ?? '0')
        if (left > 0n) positions[token.id] = { nearIn: ((BigInt(pos.nearIn) * left) / (BigInt(pos.tokenRaw) || 1n)).toString(), tokenRaw: left.toString() }
        else delete positions[token.id]
      }
      await store.event(s.id, 'filled', `Copied a ${e.side} of ${token.symbol}, confirmed on chain`)
      await notify(
        s,
        `✅ Copied <b>${esc(c.target)}</b>: ${e.side === 'buy' ? 'bought' : 'sold'} ${e.tokenRaw ? human(e.tokenRaw, token.decimals) : '?'} ${esc(token.symbol)} (${e.nearRaw ? near(e.nearRaw) : '?'} NEAR), confirmed on chain.`,
      )
      return
    }
    if (out.kind === 'submitted') return void (await store.updateDetection(s.id, source, 'submitted', { executionId: out.execution.id }))
    if (out.kind === 'duplicate') return
    const reason = out.reason
    await store.updateDetection(s.id, source, out.kind === 'failed' ? 'failed' : 'skipped', { reason, ...('execution' in out ? { executionId: out.execution.id } : {}) })
    await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `Copy of ${source.slice(0, 10)}…: ${reason}`)
    if (out.kind === 'failed') await notify(s, `⚠️ Copy of <b>${esc(c.target)}</b> failed: ${esc(reason)}`)
  }

  // ─── shared ───────────────────────────────────────────────────────────────

  async function pauseFor(s: Strategy, reason: string): Promise<void> {
    if (await store.transition(s.id, ['active'], 'paused', { reason })) {
      await store.event(s.id, 'paused', reason)
      await notify(s, `⏸ An automation was paused: ${esc(reason)}.`)
    }
  }

  async function failFor(s: Strategy, reason: string): Promise<void> {
    if (await store.transition(s.id, ['active'], 'failed', { reason })) await store.event(s.id, 'failed', reason)
  }

  /** A trade sent earlier, finished now: the strategy hears the outcome. */
  async function settleOne(e: Execution): Promise<void> {
    const out = await executor.settleOpen(e)
    if (!out) return
    const s = await store.get(e.strategyId)
    if (!s) return
    const c = s.config
    if (c.kind === 'limit') await settledOrder(s, c.limit, out)
    // dca:<strategy>:<run>:<try>
    else if (c.kind === 'dca') await settledDca(s, c.dca, out, Number(e.idemKey.split(':')[2]))
    else if (c.kind === 'sniper' && c.sniper.target === 'new-pools' && e.source) {
      const meta = await deps.near.ctx.reader.metadata(e.token).catch(() => null)
      await settledPoolSnipe(s, c.sniper, { id: e.token, symbol: meta?.symbol ?? e.token, decimals: meta?.decimals ?? 18 }, e.source, out, { ...(s.state as PoolSniperState) })
    } else if (c.kind === 'sniper' && c.sniper.token) await settledSniper(s, c.sniper, c.sniper.token, out)
    else if (c.kind === 'copy' && e.source) {
      const meta = await deps.near.ctx.reader.metadata(e.token).catch(() => null)
      const st: CopyState = { ...(s.state as CopyState) }
      const positions = { ...(st.positions ?? {}) }
      const d = await store.detection(s.id, e.source)
      if (e.side === 'sell' && out.kind === 'not-sent' && d?.token) {
        // A copied sell not sent after all: owed (tried again), not dropped.
        const leg: CopyLeg = { key: e.source, side: 'sell', token: d.token, tokenRaw: BigInt(d.tokenRaw ?? '0'), sourceNear: null, at: d.at }
        await owe(s, st, leg, st.pendingLegs?.[e.source]?.tries ?? 0, out.reason)
      } else await settledCopy(s, c.copy, { id: e.token, symbol: meta?.symbol ?? e.token, decimals: meta?.decimals ?? 18 }, e.source, out, positions)
      // What it now holds (and owes) is kept whatever its status (paused meanwhile too).
      await store.saveState(s.id, { ...st, positions })
    }
  }

  async function step(s: Strategy): Promise<void> {
    if (!deps.enabled.has(s.kind)) return void (await store.setNext(s.id, now() + 5 * 60_000))
    const closed = await switchesOpen()
    if (closed) {
      if (s.state.waiting !== closed) await store.event(s.id, 'held', closed)
      return void (await store.setNext(s.id, now() + 30_000, { ...s.state, waiting: closed }))
    }
    const c = s.config
    if (c.kind === 'limit') return stepLimit(s, c.limit)
    if (s.status !== 'active') return recoverStuck(s)
    if (c.kind === 'dca') return stepDca(s, c.dca)
    if (c.kind === 'sniper') return stepSniper(s, c.sniper)
    return stepCopy(s, c.copy)
  }

  async function leased(s: Strategy): Promise<void> {
    try {
      // Read again under the lease: a click may have paused or cancelled it meanwhile.
      const current = await store.get(s.id)
      if (current) await step(current)
    } catch (e) {
      log.warn('automation step failed', { strategy: s.id, kind: s.kind, error: e })
      await store.setNext(s.id, now() + 60_000).catch(() => undefined)
    } finally {
      await store.release(s.id, deps.instanceId).catch(() => undefined)
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let stopped = false

  async function tick(): Promise<void> {
    for (const e of await store.openExecutions(SETTLE_PER_TICK)) await settleOne(e).catch((err: unknown) => log.warn('automation settle failed', { execution: e.id, error: err }))
    await sweepLapsed().catch((err: unknown) => log.warn('automation expiry sweep failed', { error: err }))
    // New pools are read only while a new-pools sniper needs them.
    if (deps.pools?.feed && deps.enabled.has('sniper') && (await store.liveWithSubject(deps.network.id, 'sniper', NEW_POOLS)))
      await deps.pools.feed.step().catch((err: unknown) => log.warn('pool feed failed', { error: err }))
    const claimed: Strategy[] = []
    for (const s of await store.due(PER_TICK)) if (await store.claim(s.id, deps.instanceId, LEASE_MS)) claimed.push(s)
    await Promise.all(claimed.map((s) => leased(s)))
  }

  function loop(): void {
    if (stopped) return
    running = tick()
      .catch((e: unknown) => log.warn('automation tick failed', { error: e }))
      .finally(() => {
        running = null
        if (!stopped) timer = setTimeout(loop, TICK_MS)
      })
  }

  return {
    start() {
      stopped = false
      loop()
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
    /** One tick, for tests. */
    tick,
  }
}

export type AutomationRunner = ReturnType<typeof createAutomationRunner>
