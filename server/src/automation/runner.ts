import type { NetworkConfig } from '@/config/networks'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { sideOf, type CopyConfig, type DcaConfig, type LimitConfig, type SniperSettings, type StrategyKind, type TokenRef } from '@/lib/automation/config'
import { formatPrice, meetsTrigger, priceYocto, targetYocto } from '@/lib/automation/price'
import { liquidityOf } from '@/lib/volumeBot/risk'
import { fetchAccountTxs, fetchFullTxs } from '@/services/near/history'
import type { TradingWallet } from '../custody/store'
import type { CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import { esc } from '../telegram/html'
import { copyBuySize, readCopyTrade } from './copy'
import { createExecutor, DEFAULT_LIMITS, quoteAmounts, type AutomationLimits, type TradeOutcome } from './execute'
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
const PER_TICK = 4
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
const DCA_RETRY_MS = 60_000
const DCA_MAX_TRIES = 5
const LIQUIDITY_MAX_AGE_SEC = 300
const SETTLE_PER_TICK = 20

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

  /** One quote from the shared per-minute budget; false when it is spent (the strategy waits). */
  function takeQuote(): boolean {
    const t = now()
    budget.tokens = Math.min(budget.max, budget.tokens + ((t - budget.at) / 60_000) * budget.max)
    budget.at = t
    if (budget.tokens < 1) return false
    budget.tokens -= 1
    return true
  }

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

  /** Asked before the intent and before signing: still the same strategy state, its lease, the switches. */
  const allowedWhile = (s: Strategy, statuses: readonly Strategy['status'][]) => async (): Promise<string | null> => {
    const cur = await store.get(s.id)
    if (!cur || !statuses.includes(cur.status)) return 'Stopped, paused or cancelled before the trade was sent'
    if (!deps.enabled.has(s.kind)) return 'This automation is switched off by NEARKITS'
    if (!(await store.claim(s.id, deps.instanceId, LEASE_MS))) return 'Another worker took this strategy over'
    return switchesOpen()
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
        await notify(s, `✅ <b>${label}</b> filled on chain: ${e.side === 'buy' ? 'bought' : 'sold'} ${got}.`)
      }
      return
    }
    if (out.kind === 'submitted') {
      await store.transition(s.id, ['triggered', 'executing'], 'submitted', { reason: 'Sent; waiting for the chain' })
      return
    }
    if (out.kind === 'duplicate') return
    // Not traded: back to watching, or failed for good after its attempts.
    const reason = out.kind === 'failed' ? out.reason : out.reason
    if (out.kind === 'failed' && s.attempts >= MAX_ORDER_ATTEMPTS) {
      if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'failed', { reason })) {
        await store.event(s.id, 'failed', reason)
        await notify(s, `❌ <b>${label}</b> failed ${s.attempts} times and stopped: ${esc(reason)}`)
      }
      return
    }
    if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'active', { reason, nextCheckAt: now() + LIMIT_CHECK_MS, state: { ...s.state, armedAt: null } })) {
      await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `${out.kind === 'failed' ? 'The trade failed' : 'Not traded'}: ${reason}. Watching again.`)
      if (out.kind === 'failed')
        await notify(s, `⚠️ <b>${label}</b>: the trade failed (${esc(reason)}). The order keeps watching (attempt ${s.attempts} of ${MAX_ORDER_ATTEMPTS}).`)
    }
  }

  async function stepLimit(s: Strategy, c: LimitConfig): Promise<void> {
    const label = `${ORDER_LABEL[c.type]} ${esc(c.token.symbol)}`
    if (s.status !== 'active') return recoverStuck(s)
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
    const amount = await orderAmount(c, wallet)
    if ('wait' in amount) {
      await store.setNext(s.id, now() + 60_000, { ...s.state, waiting: amount.wait, armedAt: null })
      return
    }
    if (!takeQuote()) return void (await store.setNext(s.id, now() + 15_000))
    const side = sideOf(c.type)
    let q: Awaited<ReturnType<CustodyDeps['swaps']['quote']>>
    try {
      q = await custody.swaps.quote({ side, token: c.token.id, symbol: c.token.symbol, decimals: c.token.decimals, amountIn: amount.amount, slippagePct: c.slippagePct }, wallet)
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : 'no quote'
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
      waiting: insufficient ? 'Not enough NEAR in the wallet for this order and its gas' : null,
    }
    if (!meets || price === null) return void (await store.setNext(s.id, now() + LIMIT_CHECK_MS, { ...seen, armedAt: null }))
    const armedAt = typeof s.state.armedAt === 'number' ? s.state.armedAt : null
    if (armedAt === null || now() - armedAt > CONFIRM_MAX_MS) {
      await store.event(s.id, 'trigger-seen', `Price ${formatPrice(price)} NEAR met the target ${c.triggerPriceNear}: confirming with a second reading`)
      return void (await store.setNext(s.id, now() + CONFIRM_MS, { ...seen, armedAt: now() }))
    }
    if (now() - armedAt < CONFIRM_MS) return void (await store.setNext(s.id, armedAt + CONFIRM_MS, seen))
    if (insufficient) return void (await store.setNext(s.id, now() + 60_000, { ...seen, armedAt: null }))
    // Confirmed: triggered (compare-and-set; a Cancel that won the race leaves it cancelled).
    const attempt = s.attempts + 1
    if (!(await store.transition(s.id, ['active'], 'triggered', { attempts: attempt, state: { ...seen, armedAt: null }, reason: null }))) return
    await store.event(s.id, 'trigger', `Triggered at ${formatPrice(price)} NEAR per ${c.token.symbol} (target ${c.triggerPriceNear}); attempt ${attempt}`)
    if (s.ocoGroup) await store.cancelOcoSiblings(s.ocoGroup, s.id, `The other order of this pair triggered`)
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
      if (await store.transition(s.id, ['triggered', 'executing', 'submitted'], 'active', { reason: 'Recovered after an interruption: watching again', nextCheckAt: now() }))
        await store.event(s.id, 'recovered', 'Interrupted before trading: watching again')
      return
    }
    await store.setNext(s.id, now() + 10_000)
  }

  // ─── DCA ──────────────────────────────────────────────────────────────────

  async function stepDca(s: Strategy, c: DcaConfig): Promise<void> {
    const st = s.state as { runs?: number; nextRunAt?: number; tries?: number }
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
    const out = await executor.trade({
      strategy: s,
      wallet,
      side: 'buy',
      token: c.token,
      amountIn: c.amountNear.toFixed(6).replace(/\.?0+$/, ''),
      slippagePct: c.slippagePct,
      idemKey: `dca:${s.id}:${run}`,
      message: `DCA buy ${run}`,
      stillAllowed: allowedWhile(s, ['active']),
    })
    await settledDca(s, c, out, run)
  }

  async function settledDca(s: Strategy, c: DcaConfig, out: TradeOutcome, run: number): Promise<void> {
    const st = s.state as { runs?: number; nextRunAt?: number; tries?: number }
    const every = c.everySec * 1000
    let next = (st.nextRunAt ?? c.startAt) + every
    while (next <= now()) next += every
    if (out.kind === 'confirmed' || out.kind === 'failed') {
      await store.setNext(s.id, next, { runs: run, nextRunAt: next, tries: 0 })
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
    if (out.kind === 'submitted' || out.kind === 'duplicate') return void (await store.setNext(s.id, now() + 10_000))
    const tries = (st.tries ?? 0) + 1
    if (tries >= DCA_MAX_TRIES) {
      await store.event(s.id, 'skip', `Buy ${run} skipped after ${tries} tries: ${out.reason}`)
      await notify(s, `⚠️ DCA buy ${run} into <b>${esc(c.token.symbol)}</b> was skipped: ${esc(out.reason)}.`)
      return void (await store.setNext(s.id, next, { runs: run, nextRunAt: next, tries: 0 }))
    }
    await store.event(s.id, 'skip', `Buy ${run} not traded yet: ${out.reason}`)
    await store.setNext(s.id, now() + DCA_RETRY_MS, { ...st, tries })
  }

  // ─── Sniper ───────────────────────────────────────────────────────────────

  async function stepSniper(s: Strategy, c: SniperSettings): Promise<void> {
    if (c.expiresAt !== null && now() >= c.expiresAt) {
      if (await store.transition(s.id, ['active'], 'expired', { reason: 'Expired' })) {
        await store.event(s.id, 'expired', 'Expired before it bought')
        await notify(s, `⌛ Sniper on <b>${esc(c.token.symbol)}</b> expired.`)
      }
      return
    }
    if ((await store.openExecutionsOf(s.id)).length) return void (await store.setNext(s.id, now() + 10_000))
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    if (!takeQuote()) return void (await store.setNext(s.id, now() + 15_000))
    const amountIn = c.amountNear.toFixed(6).replace(/\.?0+$/, '')
    let q: Awaited<ReturnType<CustodyDeps['swaps']['quote']>>
    try {
      q = await custody.swaps.quote({ side: 'buy', token: c.token.id, symbol: c.token.symbol, decimals: c.token.decimals, amountIn, slippagePct: c.slippagePct }, wallet)
    } catch {
      return void (await store.setNext(s.id, now() + SNIPER_CHECK_MS, { ...s.state, waiting: 'No route trades it yet' }))
    }
    const a = quoteAmounts('buy', q)
    // Price impact as the router reports it; where it can't (no price feed), measured: the full buy's price
    // against a probe of 1% of it on the same route. Unknown stays unknown: buying then fails closed.
    const probe = q.priceImpactPct === null && takeQuote() ? await probePrice(c, wallet) : null
    const impactOf = (fresh: typeof q): number | null => {
      if (fresh.priceImpactPct !== null) return fresh.priceImpactPct
      const f = quoteAmounts('buy', fresh)
      const full = priceYocto(f.nearRaw, f.tokenRaw, c.token.decimals)
      if (probe === null || full === null || probe <= 0n) return null
      return full <= probe ? 0 : Number(((full - probe) * 10_000n) / probe) / 100
    }
    const impact = impactOf(q)
    const marketCheck = await qualityProblem(c.token.id, c.minLiquidityUsd, c.mode === 'execute' ? impact : null, c.mode === 'execute' ? c.maxImpactPct : null)
    if (marketCheck) return void (await store.setNext(s.id, now() + SNIPER_CHECK_MS, { ...s.state, waiting: marketCheck }))
    const first = await store.addDetection({
      strategyId: s.id,
      sourceKey: `route:${c.token.id}`,
      side: 'buy',
      token: c.token.id,
      tokenRaw: a.tokenRaw.toString(),
      nearRaw: a.nearRaw.toString(),
      status: 'eligible',
      reason: null,
    })
    const price = priceYocto(a.nearRaw, a.tokenRaw, c.token.decimals)
    if (c.mode === 'notify') {
      if (first && (await store.transition(s.id, ['active'], 'completed', { reason: 'Tradable: you were told' }))) {
        await store.event(s.id, 'detected', `Tradable: ${amountIn} NEAR buys ${human(a.tokenRaw, c.token.decimals)} ${c.token.symbol}`)
        await notify(
          s,
          `🔔 <b>${esc(c.token.symbol)}</b> is tradable now: ${amountIn} NEAR buys about ${human(a.tokenRaw, c.token.decimals)} (${price ? formatPrice(price) : '?'} NEAR each, impact ${impact === null ? 'unknown' : `${impact.toFixed(2)}%`}). Notify-only: nothing was bought.`,
        )
      }
      return
    }
    const attempt = s.attempts + 1
    const out = await executor.trade({
      strategy: { ...s, attempts: attempt },
      wallet,
      side: 'buy',
      token: c.token,
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
    await settledSniper({ ...s, attempts: attempt }, c, out)
  }

  /** The price (yoctoNEAR per whole token) of a buy of 1% of the sniper's amount: the near-zero-impact reference. */
  async function probePrice(c: SniperSettings, wallet: TradingWallet): Promise<bigint | null> {
    const small = Math.max(c.amountNear / 100, 0.001)
      .toFixed(6)
      .replace(/\.?0+$/, '')
    try {
      const p = await custody.swaps.quote(
        { side: 'buy', token: c.token.id, symbol: c.token.symbol, decimals: c.token.decimals, amountIn: small, slippagePct: c.slippagePct },
        wallet,
      )
      const pa = quoteAmounts('buy', p)
      return priceYocto(pa.nearRaw, pa.tokenRaw, c.token.decimals)
    } catch {
      return null
    }
  }

  async function settledSniper(s: Strategy, c: SniperSettings, out: TradeOutcome): Promise<void> {
    if (out.kind === 'confirmed') {
      if (await store.transition(s.id, ['active'], 'completed', { reason: 'Bought on chain' })) {
        const e = out.execution
        await store.updateDetection(s.id, `route:${c.token.id}`, 'confirmed', { executionId: e.id })
        await store.event(s.id, 'filled', `Bought ${e.tokenRaw ? human(e.tokenRaw, c.token.decimals) : '?'} ${c.token.symbol} on chain`)
        await notify(
          s,
          `✅ Sniper bought <b>${esc(c.token.symbol)}</b>, confirmed on chain: ${e.tokenRaw ? human(e.tokenRaw, c.token.decimals) : '?'} for ${e.nearRaw ? near(e.nearRaw) : '?'} NEAR.`,
        )
      }
      return
    }
    if (out.kind === 'submitted' || out.kind === 'duplicate') return void (await store.setNext(s.id, now() + 10_000))
    const reason = out.kind === 'failed' ? out.reason : out.reason
    await store.event(s.id, out.kind === 'failed' ? 'failed' : 'skip', `Attempt ${s.attempts}: ${reason}`)
    if (out.kind === 'failed' || out.kind === 'not-sent') {
      if (s.attempts >= c.maxAttempts) {
        if (await store.transition(s.id, ['active'], 'failed', { reason: `No buy after ${s.attempts} attempts: ${reason}` }))
          await notify(s, `❌ Sniper on <b>${esc(c.token.symbol)}</b> stopped after ${s.attempts} attempts: ${esc(reason)}`)
        return
      }
    }
    await store.setNext(s.id, now() + SNIPER_CHECK_MS)
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

  async function stepCopy(s: Strategy, c: CopyConfig): Promise<void> {
    const wallet = await walletOf(s)
    if (!wallet) return pauseFor(s, 'Its NEARKITS wallet is no longer active')
    const st = s.state as { since?: number; positions?: Record<string, Position> }
    const since = st.since ?? s.createdAt
    let refs: Awaited<ReturnType<typeof fetchAccountTxs>>['txs']
    try {
      refs = (await fetchAccountTxs(fetchImpl, deps.network.discovery.fastnearTxUrl, c.target, { max: 25, pageSize: 25, pace: async () => undefined })).txs
    } catch (e) {
      log.warn('copy trade: the transaction index failed', { strategy: s.id, error: e })
      return void (await store.setNext(s.id, now() + 60_000))
    }
    const fresh = refs.filter((r) => r.timestampMs > since && now() - r.timestampMs > COPY_FINALITY_MS).sort((a, b) => a.timestampMs - b.timestampMs)
    const unseen = []
    for (const r of fresh) if (!(await store.detection(s.id, r.hash))) unseen.push(r)
    if (!unseen.length) return void (await store.setNext(s.id, now() + COPY_CHECK_MS))
    let full: Awaited<ReturnType<typeof fetchFullTxs>>
    try {
      full = await fetchFullTxs(fetchImpl, deps.network.discovery.fastnearTxUrl, unseen.slice(0, 10), async () => undefined)
    } catch (e) {
      log.warn('copy trade: reading transactions failed', { strategy: s.id, error: e })
      return void (await store.setNext(s.id, now() + 60_000))
    }
    const positions = { ...(st.positions ?? {}) }
    for (const tx of full) {
      const read = readCopyTrade(tx, c.target, deps.network)
      const base = { strategyId: s.id, sourceKey: tx.hash, at: tx.timestampMs ?? now() }
      if (!read.ok) {
        await store.addDetection({ ...base, side: null, token: null, tokenRaw: null, nearRaw: null, status: 'skipped', reason: read.reason })
        continue
      }
      const detected = { ...base, side: read.side, token: read.token, tokenRaw: read.tokenRaw.toString(), nearRaw: read.nearRaw.toString() }
      const skip = async (reason: string, risk = false) => {
        await store.addDetection({ ...detected, status: 'skipped', reason })
        if (risk) await notify(s, `⛔ Copy of <b>${esc(c.target)}</b>: a ${read.side} was not copied: ${esc(reason)}.`)
      }
      if (c.copy !== 'both' && c.copy !== read.side) {
        await skip(`Copying ${c.copy}s only`)
        continue
      }
      if (c.exclude.includes(read.token)) {
        await skip('The token is excluded')
        continue
      }
      const meta = await deps.near.ctx.reader.metadata(read.token).catch(() => null)
      if (!meta) {
        await skip('The token’s metadata can’t be read from chain')
        continue
      }
      const token: TokenRef = { id: read.token, symbol: meta.symbol, decimals: meta.decimals }
      if (!(await store.addDetection({ ...detected, status: 'eligible', reason: null }))) continue
      let amountIn: string
      if (read.side === 'buy') {
        const exposure = Object.values(positions).reduce((sum, p) => sum + near(p.nearIn), 0)
        const size = copyBuySize(c, near(read.nearRaw), exposure)
        if ('skip' in size) {
          await store.updateDetection(s.id, tx.hash, 'skipped', { reason: size.skip })
          await notify(s, `⛔ Copy of <b>${esc(c.target)}</b>: a buy of ${esc(token.symbol)} was not copied: ${esc(size.skip)}.`)
          continue
        }
        const quality = await qualityProblem(token.id, c.minLiquidityUsd, null, null)
        if (quality) {
          await store.updateDetection(s.id, tx.hash, 'skipped', { reason: quality })
          continue
        }
        amountIn = size.near.toFixed(6).replace(/\.?0+$/, '')
      } else {
        const pos = positions[token.id]
        const held = await tokenBalance(token.id, wallet)
        const sell = pos && held !== null ? (BigInt(pos.tokenRaw) < held ? BigInt(pos.tokenRaw) : held) : 0n
        if (sell <= 0n) {
          await store.updateDetection(s.id, tx.hash, 'skipped', { reason: 'Nothing this rule bought of it is left to sell' })
          continue
        }
        amountIn = formatUnits(sell, token.decimals)
      }
      if (!takeQuote()) {
        await store.updateDetection(s.id, tx.hash, 'skipped', { reason: 'NEARKITS’ quote budget was spent; too late to copy' })
        continue
      }
      await store.updateDetection(s.id, tx.hash, 'executing')
      const out = await executor.trade({
        strategy: s,
        wallet,
        side: read.side,
        token,
        amountIn,
        slippagePct: c.slippagePct,
        idemKey: `copy:${s.id}:${tx.hash}`,
        source: tx.hash,
        message: `Copy of ${c.target}’s ${read.side}`,
        stillAllowed: allowedWhile(s, ['active']),
      })
      await settledCopy(s, c, token, tx.hash, out, positions)
    }
    await store.setNext(s.id, now() + COPY_CHECK_MS, { ...st, since, positions })
  }

  async function settledCopy(s: Strategy, c: CopyConfig, token: TokenRef, source: string, out: TradeOutcome, positions: Record<string, Position>): Promise<void> {
    if (out.kind === 'confirmed') {
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
    else if (c.kind === 'dca') await settledDca(s, c.dca, out, Number(e.idemKey.split(':').at(-1)))
    else if (c.kind === 'sniper') await settledSniper(s, c.sniper, out)
    else if (c.kind === 'copy' && e.source) {
      const meta = await deps.near.ctx.reader.metadata(e.token).catch(() => null)
      const positions = { ...(((s.state as { positions?: Record<string, Position> }).positions ?? {}) as Record<string, Position>) }
      await settledCopy(s, c.copy, { id: e.token, symbol: meta?.symbol ?? e.token, decimals: meta?.decimals ?? 18 }, e.source, out, positions)
      await store.setNext(s.id, s.nextCheckAt ?? now(), { ...s.state, positions })
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
