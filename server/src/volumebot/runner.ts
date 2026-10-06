import type { NetworkConfig } from '@/config/networks'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { applyFill, emptyBook, inventoryOf, openBook, pnlNear, type Book } from '@/lib/volumeBot/inventory'
import { GUARDIAN_LABEL, guardBalances, guardFill, guardHealth, guardLoss, guardMarket, spreadCheck } from '@/lib/volumeBot/risk'
import { nextEvaluationAt, scheduleGate } from '@/lib/volumeBot/schedule'
import { acceptQuote, decide, MIN_TRADE_NEAR, updateFairValue } from '@/lib/volumeBot/strategy'
import type { BotWallet, GuardianPause, Intent as BotIntent, MarketSnapshot, TradeQuote } from '@/lib/volumeBot/types'
import type { ExecuteResult } from '../custody/engine'
import type { Intent, TradingWallet } from '../custody/store'
import { SWAP_QUOTE_TTL_MS, type SwapParams, type SwapQuote } from '../custody/swap'
import { readWallet, type CustodyDeps } from '../custody/wallets'
import type { Logger } from '../log'
import type { ServerNear } from '../near'
import type { BotTrade, RunState, VolumeBot, VolumeBotStore } from './store'

/**
 * The Volume Bot's worker: every couple of seconds it takes the bots that are due (one worker at a
 * time per bot: a lease), and steps each one. A step settles what earlier steps sent, reads the bot's
 * wallets and the market, lets the guardian pause it (with the exact reason), and asks its strategy
 * what to do. A trade goes through NEARKITS' own custody path exactly like a trade the owner confirms
 * on the web: a fresh quote bound to the wallet, an intent, the engine, the signer's own checks and
 * fee, delivery confirmed on chain. No other key, signer or fee path exists for it.
 *
 * State lives in the database (the run's state, its trades): a restart picks every running bot up
 * where it was, and settles trades that were in flight from their intents.
 */

const TICK_MS = 2_000
/** Longer than a step can take: quotes, then the engine's confirmation wait (it is renewed before a trade is sent). */
const LEASE_MS = 3 * 60_000
/** Bots stepped side by side each tick. */
const BOTS_PER_TICK = 4
/** How long a tick waits for one step: a slower one (a confirmation still on its way) holds only its own bot, under its lease. */
const STEP_WAIT_MS = 90_000
/** The small trade the market's buy and sell prices are read with. */
const PROBE_NEAR = 0.1
const MARKET_TTL_MS = 20_000
const METRIC_EVERY_MS = 60_000
/** A step that couldn't read what it needs tries again this soon. */
const RETRY_MS = 15_000

export interface VolumeBotRunnerDeps {
  store: VolumeBotStore
  custody: CustodyDeps
  near: ServerNear
  network: NetworkConfig
  log: Logger
  instanceId: string
  /** A message to the bot's owner in Telegram (pauses, completion). */
  notify?: (userId: number, text: string) => Promise<void>
  now?: () => number
  random?: () => number
  /** How long a tick waits for one bot's step (tests shorten it). */
  stepWaitMs?: number
}

const human = (raw: bigint | string, decimals: number) => Number(formatUnits(BigInt(raw), decimals))
/** A decimal string of at most `places` decimals, rounded down (never more than meant). */
function decimal(value: number, places: number): string {
  if (!(value > 0)) return '0'
  const factor = 10 ** places
  const floored = Math.floor(value * factor) / factor
  return floored.toFixed(places).replace(/\.?0+$/, '') || '0'
}

const today = (at: number) => new Date(at).toISOString().slice(0, 10)

export function freshRunState(at: number): RunState {
  return {
    progress: { startedAt: at, trades: 0, boughtNear: 0, soldTokens: 0, lastTradeAt: null, inFlight: 0 },
    fair: null,
    books: {},
    expected: [],
    baselineLiquidityUsd: null,
    prevMarket: null,
    health: { consecutiveFailures: 0, rpcErrors: 0, providerErrors: 0 },
    equity: { startNear: null, peakNear: null, dayStartNear: null, day: null },
    lastMetricAt: null,
    waiting: 'Starting',
  }
}

export function createVolumeBotRunner(deps: VolumeBotRunnerDeps) {
  const { store, custody, near, log } = deps
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const markets = new Map<string, { at: number; value: Promise<MarketSnapshot | null> }>()

  const toTradeQuote = (side: 'buy' | 'sell', q: SwapQuote, decimals: number): TradeQuote => {
    const near = side === 'buy' ? human(q.amountInRaw, NEAR_DECIMALS) : human(q.amountOut, NEAR_DECIMALS)
    const tokens = side === 'buy' ? human(q.amountOut, decimals) : human(q.amountInRaw, decimals)
    return {
      side,
      near,
      tokens,
      priceNear: tokens > 0 ? near / tokens : Number.POSITIVE_INFINITY,
      priceImpactBps: q.priceImpactPct === null ? null : q.priceImpactPct * 100,
      at: q.quotedAt,
    }
  }

  const paramsOf = (bot: VolumeBot, side: 'buy' | 'sell', amountIn: string): SwapParams => ({
    side,
    token: bot.config.tokenId,
    symbol: bot.config.tokenSymbol,
    decimals: bot.config.tokenDecimals,
    amountIn,
    slippagePct: bot.config.risk.maxSlippageBps / 100,
  })

  /** The market at this moment: a small buy and a small sell quoted through the route a trade would take, plus the pool's liquidity. */
  function snapshot(bot: VolumeBot, wallet: TradingWallet): Promise<MarketSnapshot | null> {
    const key = `${bot.network}|${bot.token}`
    const hit = markets.get(key)
    if (hit && now() - hit.at < MARKET_TTL_MS) return hit.value
    const value = (async (): Promise<MarketSnapshot | null> => {
      const decimals = bot.config.tokenDecimals
      try {
        const buy = toTradeQuote('buy', await custody.swaps.quote(paramsOf(bot, 'buy', decimal(PROBE_NEAR, 6)), wallet), decimals)
        if (!(buy.tokens > 0)) return null
        const sellQuote = await custody.swaps.quote(paramsOf(bot, 'sell', decimal(buy.tokens, Math.min(decimals, 6))), wallet).catch(() => null)
        const sell = sellQuote ? toTradeQuote('sell', sellQuote, decimals) : null
        const ask = buy.priceNear
        const bid = sell && sell.tokens > 0 ? sell.priceNear : null
        const [market, nearQuote] = await Promise.all([near.tokens.getMarketData(bot.token).catch(() => null), near.market.nearQuote().catch(() => null)])
        const liquidity = market?.liquidityUsd.state === 'known' || market?.liquidityUsd.state === 'stale' ? market.liquidityUsd.value : null
        return {
          at: now(),
          midNear: bid !== null ? (ask + bid) / 2 : ask,
          askNear: ask,
          bidNear: bid,
          liquidityUsd: liquidity,
          nearUsd: nearQuote?.priceUsd ?? null,
          source: 'Rhea quotes',
        }
      } catch (e) {
        log.warn('volume bot market read failed', { bot: bot.id, error: e })
        return null
      }
    })()
    markets.set(key, { at: now(), value })
    value.then((v) => v === null && markets.delete(key)).catch(() => markets.delete(key))
    return value
  }

  /** The bot's wallets as they are now: each must still be the owner's, active; frozen ones are kept but never trade. */
  async function readWallets(bot: VolumeBot, busy: ReadonlySet<string>): Promise<{ bots: BotWallet[]; trading: TradingWallet[] } | null> {
    const trading: TradingWallet[] = []
    for (const id of bot.config.walletIds) {
      const w = await custody.store.ownedWallet(bot.userId, id)
      if (w) trading.push(w)
    }
    if (trading.length === 0) return { bots: [], trading }
    try {
      const bots = await Promise.all(
        trading.map(async (w): Promise<BotWallet> => {
          const view = await readWallet(near, w)
          if (view.near === null) throw new Error(`${w.accountId}: balance unread`)
          const tokens = await near.ctx.reader.balanceOf(bot.token, w.accountId)
          const inFlight = (await custody.store.inFlight(w.id)).length > 0
          return {
            walletId: w.id,
            label: w.label ?? `Wallet ${w.slot}`,
            accountId: w.accountId,
            near: human(view.near, NEAR_DECIMALS),
            tokens: human(tokens, bot.config.tokenDecimals),
            frozen: w.frozenAt !== null,
            busy: inFlight || busy.has(w.id),
          }
        }),
      )
      return { bots, trading }
    } catch (e) {
      log.warn('volume bot wallet read failed', { bot: bot.id, error: e })
      return null
    }
  }

  async function notify(bot: VolumeBot, text: string) {
    await deps.notify?.(bot.userId, text).catch((e: unknown) => log.warn('volume bot notice failed', { bot: bot.id, error: e }))
  }

  async function pause(bot: VolumeBot, runId: string, st: RunState, g: GuardianPause) {
    const reason = `${GUARDIAN_LABEL[g.code]}: ${g.detail}`
    st.waiting = reason
    await store.saveRunState(runId, st)
    if (await store.pause(bot.id, g.code, reason)) {
      await store.event(bot.id, 'guardian', reason, g.code)
      await notify(bot, `⏸ Your Volume Bot on ${bot.config.tokenSymbol} paused itself.\n${reason}\nResume it on NEARKITS web or with /volume resume when you’ve checked.`)
    }
  }

  async function complete(bot: VolumeBot, runId: string, st: RunState, reason: string) {
    st.waiting = reason
    await store.saveRunState(runId, st)
    if (await store.end(bot.id, 'completed', reason)) {
      await store.event(bot.id, 'completed', reason)
      await notify(bot, `✅ Your Volume Bot on ${bot.config.tokenSymbol} completed: ${reason}.`)
    }
  }

  /** NEAR value of a fee, from the result's facts: in NEAR (wNEAR) as is, in the token at the trade's own price. */
  function feeNear(bot: VolumeBot, facts: Record<string, unknown> | undefined, price: number): number {
    const fee = facts?.fee as { token?: string; raw?: string } | null | undefined
    if (!fee?.raw || !fee.token) return 0
    if (fee.token === near.ctx.network.wrapContract || fee.token === 'near') return human(fee.raw, NEAR_DECIMALS)
    if (fee.token === bot.token) return human(fee.raw, bot.config.tokenDecimals) * price
    return 0
  }

  /** A trade's intent has settled: what moved goes into the books and the record. */
  async function settle(bot: VolumeBot, st: RunState, trade: BotTrade, intent: Intent): Promise<GuardianPause | null> {
    st.progress.inFlight = Math.max(0, st.progress.inFlight - 1)
    // Its own trade moved the balances (and the gas it held comes back over the next blocks): the
    // next step takes its baseline afresh instead of reading that as someone else's doing.
    st.expected = []
    const result = intent.result
    if (intent.status !== 'done' || !result?.ok) {
      st.health.consecutiveFailures += 1
      await store.settleTradeWithState(
        trade.id,
        { status: 'failed', message: result?.message ?? `The trade ended ${intent.status}.`, txHash: result?.hashes.at(-1) ?? null },
        trade.runId,
        st,
      )
      await store.event(bot.id, 'trade-failed', result?.message ?? `A ${trade.side} ended ${intent.status}.`)
      return guardHealth(st.health, bot.config.risk)
    }
    const facts = result.facts
    const decimals = bot.config.tokenDecimals
    const tokenRaw = typeof facts?.tokenAmount === 'string' ? facts.tokenAmount : trade.tokenRaw
    const nearRaw = typeof facts?.nearAmount === 'string' ? facts.nearAmount : trade.nearRaw
    const tokens = tokenRaw ? human(tokenRaw, decimals) : 0
    const nearMoved = nearRaw ? human(nearRaw, NEAR_DECIMALS) : 0
    const price = tokens > 0 ? nearMoved / tokens : 0
    const gas = typeof facts?.gasBurnt === 'string' ? human(facts.gasBurnt, NEAR_DECIMALS) : 0
    const fee = feeNear(bot, facts, price)
    st.books[trade.walletId] = applyFill(st.books[trade.walletId] ?? emptyBook(), { side: trade.side, tokens, near: nearMoved, feeNear: fee, gasNear: gas })
    st.progress.trades += 1
    st.progress.lastTradeAt = now()
    if (trade.side === 'buy') st.progress.boughtNear += nearMoved
    else st.progress.soldTokens += tokens
    st.health.consecutiveFailures = 0
    await store.settleTradeWithState(
      trade.id,
      { status: 'confirmed', nearRaw, tokenRaw, priceNear: price || trade.priceNear, feeNear: fee, gasNear: gas, txHash: result.hashes.at(-1) ?? null },
      trade.runId,
      st,
    )
    // What the quote promised against what arrived: the swap's own minimum guards it on chain; a worse fill pauses.
    const quoted = trade.nearRaw && trade.tokenRaw ? { near: human(trade.nearRaw, NEAR_DECIMALS), tokens: human(trade.tokenRaw, decimals) } : null
    return quoted
      ? guardFill({
          quote: { side: trade.side, near: quoted.near, tokens: quoted.tokens, priceNear: 0, priceImpactBps: null, at: 0 },
          filled: { near: nearMoved, tokens },
          risk: bot.config.risk,
        })
      : null
  }

  /** Trades sent by earlier steps (or before a restart): settled from their intents once final. */
  async function settleOpen(bot: VolumeBot, st: RunState): Promise<{ open: number; pause: GuardianPause | null }> {
    let open = 0
    let pause: GuardianPause | null = null
    for (const t of await store.openTrades(bot.id)) {
      const intent = t.intentId ? await custody.store.intent(t.intentId) : null
      if (!intent) {
        await store.dropTrade(t.id)
        continue
      }
      if (intent.status === 'done' || intent.status === 'failed') {
        pause = (await settle(bot, st, t, intent)) ?? pause
        continue
      }
      if (intent.status === 'quoted' || intent.status === 'cancelled' || intent.status === 'expired' || intent.status === 'replaced') {
        // Never sent: nothing to record.
        st.progress.inFlight = Math.max(0, st.progress.inFlight - 1)
        await store.dropTrade(t.id)
        continue
      }
      open += 1
      if (now() - t.createdAt > bot.config.risk.txTimeoutSec * 1000)
        pause ??= {
          code: 'tx-timeout',
          detail: `A ${t.side} sent ${Math.round((now() - t.createdAt) / 1000)} s ago isn’t confirmed yet (limit ${bot.config.risk.txTimeoutSec} s); it is still followed`,
        }
    }
    return { open, pause }
  }

  /** Whether the bot may still send a trade now: running, and neither its switch nor trading paused by NEARKITS. */
  async function stillTrading(botId: string): Promise<boolean> {
    const current = await store.get(botId)
    if (current?.status !== 'running') return false
    const switches = await custody.ops.state().catch(() => null)
    return switches !== null && !switches.volumebot.paused && !switches.trading.paused
  }

  async function trade(
    bot: VolumeBot,
    runId: string,
    st: RunState,
    intent: Extract<BotIntent, { kind: 'trade' }>,
    market: MarketSnapshot,
    wallet: TradingWallet,
  ): Promise<GuardianPause | null> {
    const cfg = bot.config
    let sizeNear = intent.sizeNear
    for (let attempt = 0; attempt < 3; attempt++) {
      const amountIn = intent.side === 'buy' ? decimal(sizeNear, 6) : decimal(sizeNear / (market.bidNear ?? market.midNear), Math.min(cfg.tokenDecimals, 6))
      if (amountIn === '0') return null
      const blocked = await custody.ops.blocked(intent.side, wallet)
      if (blocked) return { code: 'operator', detail: blocked }
      const params = paramsOf(bot, intent.side, amountIn)
      let quote: SwapQuote
      try {
        quote = await custody.swaps.quote(params, wallet)
      } catch (e) {
        st.waiting = `No quote: ${e instanceof Error ? e.message : String(e)}`
        await store.event(bot.id, 'skip', st.waiting)
        return null
      }
      const verdict = acceptQuote(intent, toTradeQuote(intent.side, quote, cfg.tokenDecimals), cfg.risk, cfg.sizing, now())
      if (!verdict.ok) {
        if (verdict.action === 'shrink' && attempt < 2 && sizeNear / 2 >= MIN_TRADE_NEAR) {
          sizeNear /= 2
          continue
        }
        st.waiting = verdict.reason
        await store.event(bot.id, 'skip', verdict.reason)
        return null
      }
      const tq = toTradeQuote(intent.side, quote, cfg.tokenDecimals)
      // Stop, Emergency stop or Pause pressed while this step ran, or NEARKITS paused every bot: nothing more is sent.
      if (!(await stillTrading(bot.id))) {
        st.waiting = 'Stopped or paused before this trade was sent'
        return null
      }
      const created = await custody.store.createIntent({
        walletId: wallet.id,
        userId: bot.userId,
        chatId: 0,
        kind: intent.side,
        params,
        quote,
        ttlMs: SWAP_QUOTE_TTL_MS,
        groupId: `vb-${bot.id}`,
      })
      const tradeId = await store.addTrade({
        botId: bot.id,
        runId,
        walletId: wallet.id,
        intentId: created.id,
        side: intent.side,
        status: 'submitted',
        nearRaw: intent.side === 'buy' ? quote.amountInRaw : quote.amountOut,
        tokenRaw: intent.side === 'buy' ? quote.amountOut : quote.amountInRaw,
        priceNear: tq.priceNear,
        impactBps: tq.priceImpactBps,
        feeNear: null,
        gasNear: null,
        nearUsd: market.nearUsd,
        txHash: null,
        message: intent.reason,
      })
      st.progress.inFlight += 1
      // Saved before anything is signed: a restart finds this trade and settles it from its intent.
      await store.saveRunState(runId, st)
      // The lease runs from now for the whole confirmation wait: no other worker steps this bot meanwhile.
      await store.claim(bot.id, deps.instanceId, LEASE_MS)
      let r: ExecuteResult
      try {
        r = await custody.engine.execute(created.id, bot.userId)
      } catch (e) {
        log.warn('volume bot execute failed', { bot: bot.id, error: e })
        const after = await custody.store.intent(created.id)
        const row = (await store.openTrades(bot.id)).find((t) => t.id === tradeId)
        if (after && row && (after.status === 'done' || after.status === 'failed')) return settle(bot, st, row, after)
        return null
      }
      const row = (await store.openTrades(bot.id)).find((t) => t.id === tradeId)
      if (!row) return null
      if (r.kind === 'refused' || r.kind === 'requoted') {
        // Nothing was signed (a wallet busy with its owner's own trade, or a route that changed): try again later.
        st.progress.inFlight = Math.max(0, st.progress.inFlight - 1)
        await store.dropTrade(tradeId)
        st.waiting = r.kind === 'refused' ? `The wallet couldn’t take the trade now (${r.reason})` : 'The route changed before signing; asked again next time'
        return null
      }
      if (r.kind === 'pending') return null
      return settle(bot, st, row, r.intent)
    }
    return null
  }

  async function step(bot: VolumeBot): Promise<void> {
    const run = await store.currentRun(bot.id)
    if (!run) {
      await store.pause(bot.id, 'error', 'Its run state is missing: start it again')
      return
    }
    const st = run.state
    const cfg = bot.config
    const later = (ms: number) => store.setNextTick(bot.id, now() + ms)
    const settled = await settleOpen(bot, st)

    if (bot.status === 'stopping') {
      if (settled.open > 0) {
        st.waiting = `Stopping: ${settled.open} trade${settled.open === 1 ? '' : 's'} in flight are being settled`
        await store.saveRunState(run.id, st)
        await later(5_000)
        return
      }
      await store.saveRunState(run.id, st)
      if (await store.end(bot.id, 'stopped', bot.pauseReason ?? 'Stopped')) {
        await store.event(bot.id, 'stopped', bot.pauseReason ?? 'Stopped')
        await notify(bot, `⏹ Your Volume Bot on ${cfg.tokenSymbol} stopped. Nothing more is sent.`)
      }
      return
    }
    if (settled.pause) return pause(bot, run.id, st, settled.pause)

    // NEARKITS' own switches: every bot pauses when trading or the Volume Bot is paused.
    const switches = await custody.ops.state().catch(() => null)
    if (!switches) return pause(bot, run.id, st, { code: 'operator', detail: 'NEARKITS can’t confirm trading is allowed right now' })
    if (switches.volumebot.paused || switches.trading.paused)
      return pause(bot, run.id, st, { code: 'operator', detail: switches.volumebot.paused ? 'NEARKITS paused every Volume Bot' : 'Trading is paused by NEARKITS' })

    const gate = scheduleGate(now(), cfg.schedule, st.progress)
    if (!gate.open) {
      if (gate.kind === 'complete') return complete(bot, run.id, st, gate.reason)
      st.waiting = gate.reason
      await store.saveRunState(run.id, st)
      await store.setNextTick(bot.id, gate.until)
      return
    }

    const busy = new Set((await store.openTrades(bot.id)).map((t) => t.walletId))
    const read = await readWallets(bot, busy)
    if (!read) {
      st.health.rpcErrors += 1
      const g = guardHealth(st.health, cfg.risk)
      if (g) return pause(bot, run.id, st, g)
      st.waiting = 'The NEAR network didn’t answer; asking again shortly'
      await store.saveRunState(run.id, st)
      await later(RETRY_MS)
      return
    }
    st.health.rpcErrors = 0
    if (read.bots.length === 0) return pause(bot, run.id, st, { code: 'unexpected-balance', detail: 'None of its wallets is an active NEARKITS wallet of yours any more' })
    // A balance its own trades don't explain (a withdrawal, a manual trade) pauses it; refunds and deposits don't.
    if (st.expected.length > 0 && busy.size === 0) {
      const g = guardBalances({ expected: st.expected, actual: read.bots })
      if (g) return pause(bot, run.id, st, g)
    }
    st.expected = read.bots.map((w) => ({ walletId: w.walletId, near: w.near, tokens: w.tokens }))

    const probeWallet = read.trading.find((w) => w.frozenAt === null) ?? read.trading[0]
    const market = probeWallet ? await snapshot(bot, probeWallet) : null
    if (!market) {
      st.health.providerErrors += 1
      const g = guardHealth(st.health, cfg.risk)
      if (g) return pause(bot, run.id, st, g)
      st.waiting = 'No price could be read; asking again shortly'
      await store.saveRunState(run.id, st)
      await later(RETRY_MS)
      return
    }
    st.health.providerErrors = 0
    st.baselineLiquidityUsd ??= market.liquidityUsd
    const marketGuard = guardMarket({
      market,
      prev: st.prevMarket,
      fair: cfg.strategy === 'market-maker' ? st.fair : null,
      risk: cfg.risk,
      now: now(),
      baselineLiquidityUsd: st.baselineLiquidityUsd,
    })
    if (marketGuard) return pause(bot, run.id, st, marketGuard)
    st.fair = updateFairValue(st.fair, market.midNear, market.at, cfg.marketMaker.fairValueWindowSec)
    st.prevMarket = market

    // The books: what each wallet held when the run began is marked at that price (PnL measures the bot from there).
    for (const w of read.bots) st.books[w.walletId] ??= openBook(w.tokens, market.midNear)
    const pnl = Object.values(st.books).reduce((s: number, b: Book) => s + pnlNear(b, market.midNear), 0)
    const inv = inventoryOf(read.bots, market.midNear)
    st.equity.startNear ??= inv.totalNear
    const equity = (st.equity.startNear ?? inv.totalNear) + pnl
    if (st.equity.day !== today(now())) {
      st.equity.day = today(now())
      st.equity.dayStartNear = pnl
    }
    st.equity.peakNear = Math.max(st.equity.peakNear ?? equity, equity)
    const lossGuard = guardLoss({ pnlTodayNear: pnl - (st.equity.dayStartNear ?? 0), peakEquityNear: st.equity.peakNear, equityNear: equity }, cfg.risk)
    if (lossGuard) return pause(bot, run.id, st, lossGuard)

    if (st.lastMetricAt === null || now() - st.lastMetricAt >= METRIC_EVERY_MS) {
      const done = (await store.tradesOfRun(run.id)).filter((t) => t.status === 'confirmed')
      const volume = done.reduce((s, t) => s + (t.nearRaw ? human(t.nearRaw, NEAR_DECIMALS) : 0), 0)
      await store.addMetric(bot.id, {
        at: now(),
        priceNear: market.midNear,
        equityNear: equity,
        pnlNear: pnl,
        tokenPct: inv.tokenPct,
        inventoryTokens: inv.tokens,
        volumeNear: volume,
        trades: done.length,
      })
      st.lastMetricAt = now()
    }

    const spread = spreadCheck(market, cfg.risk)
    let next = nextEvaluationAt(now(), cfg.schedule, random)
    if (spread) st.waiting = spread
    else {
      const intent = decide({ config: cfg, market, fair: st.fair, wallets: read.bots, progress: st.progress, now: now(), random })
      if (intent.kind === 'complete') return complete(bot, run.id, st, intent.reason)
      if (intent.kind === 'wait') st.waiting = intent.reason
      else {
        const wallet = read.trading.find((w) => w.id === intent.walletId)
        if (wallet) {
          st.waiting = null
          const g = await trade(bot, run.id, st, intent, market, wallet)
          if (g) return pause(bot, run.id, st, g)
          if (st.progress.lastTradeAt !== null) next = Math.max(next, st.progress.lastTradeAt + cfg.schedule.cooldownSec * 1000)
        }
      }
    }
    await store.saveRunState(run.id, st)
    await store.setNextTick(bot.id, next)
  }

  let ticking: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  /** One bot's step under its lease, released when the step is over (however long it takes). */
  async function leasedStep(bot: VolumeBot): Promise<void> {
    try {
      // Read again under the lease: a click may have paused or stopped it meanwhile.
      const fresh = await store.get(bot.id)
      if (fresh && (fresh.status === 'running' || fresh.status === 'stopping')) await step(fresh)
    } catch (e) {
      log.error('volume bot step failed', { bot: bot.id, error: e })
      await store.event(bot.id, 'error', 'A step failed; it is tried again shortly').catch(() => undefined)
      await store.setNextTick(bot.id, now() + RETRY_MS).catch(() => undefined)
    } finally {
      await store.release(bot.id, deps.instanceId).catch(() => undefined)
    }
  }

  /** Resolves when `work` does, or after `ms`, whichever comes first (the timer never outlives it). */
  function within(work: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    return Promise.race([work, wait]).finally(() => clearTimeout(timer))
  }

  async function tick(): Promise<void> {
    const claimed: VolumeBot[] = []
    for (const bot of await store.due(BOTS_PER_TICK)) if (await store.claim(bot.id, deps.instanceId, LEASE_MS)) claimed.push(bot)
    // Side by side; a slow step holds only its own bot (its lease), never the next tick.
    await Promise.all(claimed.map((bot) => within(leasedStep(bot), deps.stepWaitMs ?? STEP_WAIT_MS)))
  }

  return {
    step,
    tick,
    /** Steps due bots every couple of seconds, one step at a time (never two ticks at once). */
    start() {
      if (timer) return
      timer = setInterval(() => {
        if (ticking) return
        ticking = tick()
          .catch((e: unknown) => log.error('volume bot tick failed', { error: e }))
          .finally(() => {
            ticking = null
          })
      }, TICK_MS)
      timer.unref?.()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await ticking
    },
  }
}

export type VolumeBotRunner = ReturnType<typeof createVolumeBotRunner>
