import type { NetworkConfig } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import type { AutomationFeatures, CreateStrategyInput, DetectionView, ExecutionView, StrategyDetail, StrategyPreview, StrategyView } from '@/lib/automation/api'
import {
  AUTOMATION_MAX_SLIPPAGE,
  FINAL_STATUSES,
  parseStrategy,
  sideOf,
  tokenOfStrategy,
  type ConfigIssue,
  type StrategyConfig,
  type StrategyKind,
  type TokenRef,
} from '@/lib/automation/config'
import { formatPrice, meetsTrigger, priceYocto, targetYocto } from '@/lib/automation/price'
import { walletName } from '../custody/limits'
import type { TradingWallet } from '../custody/store'
import type { CustodyDeps } from '../custody/wallets'
import type { ServerNear } from '../near'
import { DEFAULT_LIMITS, quoteAmounts, type AutomationLimits } from './execute'
import { LiveLimitError, type AutomationStore, type Strategy } from './store'

/**
 * Trading automation's operations, the same for NEARKITS web and the Telegram bot: both call these
 * with the user the session or the Telegram update names, and nothing else decides. Every operation
 * checks that the strategy (and the wallet) is that user's; a configuration is parsed and validated
 * here again, whatever the client checked, the token's symbol and decimals are read from chain, and
 * NEARKITS' limits apply.
 */

export class AutomationError extends Error {
  constructor(
    readonly code: 'off' | 'not-found' | 'wallet' | 'token' | 'limit' | 'busy' | 'confirm' | 'target' | 'pair' | 'state',
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(message)
  }
}

export interface AutomationServiceDeps {
  store: AutomationStore
  custody: CustodyDeps
  near: ServerNear
  network: NetworkConfig
  enabled: ReadonlySet<StrategyKind>
  limits?: AutomationLimits
  now: () => number
}

export function createAutomationService(deps: AutomationServiceDeps) {
  const { store, custody, near, network, now } = deps
  const limits = deps.limits ?? DEFAULT_LIMITS

  async function features(): Promise<AutomationFeatures> {
    const s = await custody.ops.state().catch(() => null)
    const paused = !s || s.automation.paused || s.trading.paused
    return {
      enabled: [...deps.enabled],
      paused,
      pausedReason: !s
        ? 'NEARKITS can’t confirm that trading is allowed right now'
        : s.automation.paused
          ? 'NEARKITS has paused automated trading'
          : s.trading.paused
            ? 'Trading is paused by NEARKITS'
            : null,
      limits: { maxTradeNear: limits.maxTradeNear, maxDailyNearPerUser: limits.maxDailyNearPerUser, maxSlippagePct: AUTOMATION_MAX_SLIPPAGE },
    }
  }

  async function view(s: Strategy, wallets?: Map<string, TradingWallet>): Promise<StrategyView> {
    const w = wallets?.get(s.walletId) ?? (await custody.store.wallet(s.walletId))
    const last = typeof s.state.lastPriceYocto === 'string' && /^\d+$/.test(s.state.lastPriceYocto) ? formatPrice(BigInt(s.state.lastPriceYocto)) : null
    return {
      id: s.id,
      kind: s.kind,
      status: s.status,
      walletId: s.walletId,
      walletName: w ? walletName(w) : null,
      subject: s.subject,
      config: s.config,
      statusReason: s.statusReason,
      waiting: typeof s.state.waiting === 'string' ? s.state.waiting : null,
      lastPriceNear: last,
      lastQuoteAt: typeof s.state.lastQuoteAt === 'number' ? s.state.lastQuoteAt : null,
      ocoGroup: s.ocoGroup,
      attempts: s.attempts,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      closedAt: s.closedAt,
    }
  }

  async function own(userId: number, id: string): Promise<Strategy> {
    const s = await store.own(userId, id)
    if (!s || s.network !== network.id) throw new AutomationError('not-found', 'That isn’t one of your automations, or it’s gone.')
    return s
  }

  async function ownWallet(userId: number, walletId: string): Promise<TradingWallet> {
    const w = await custody.store.ownedWallet(userId, walletId)
    if (!w || w.status !== 'active' || w.network !== network.id)
      throw new AutomationError('wallet', 'Choose one of your NEARKITS wallets. Automated trades run only from NEARKITS wallets: a browser wallet is never signed for.')
    if (w.frozenAt) throw new AutomationError('wallet', 'That NEARKITS wallet is frozen by NEARKITS for your protection: it doesn’t trade.')
    return w
  }

  /** The token as the chain describes it: a client's symbol or decimals are never trusted. */
  async function realToken(t: TokenRef): Promise<TokenRef> {
    if (t.id === network.wrapContract) throw new AutomationError('token', 'Trade a token against NEAR, not wNEAR itself.')
    const meta = await near.ctx.reader.metadata(t.id).catch(() => null)
    if (!meta) throw new AutomationError('token', 'NEARKITS can’t read that token from chain. Check the contract, or try again in a moment.')
    return { id: t.id, symbol: meta.symbol, decimals: meta.decimals }
  }

  /** The configuration with the chain's token, checked against NEARKITS' own limits. */
  async function prepared(input: unknown): Promise<StrategyConfig> {
    const parsed = parseStrategy(input, now())
    if (!parsed.ok) throw new AutomationError('state', 'Check the highlighted fields.', parsed.issues)
    const c = parsed.config
    if (!deps.enabled.has(c.kind)) throw new AutomationError('off', 'This automation isn’t switched on by NEARKITS yet.')
    const token = tokenOfStrategy(c)
    const real = token ? await realToken(token) : null
    if (real && token && real.decimals !== token.decimals) throw new AutomationError('token', 'The token’s decimals differ from the chain’s: reload it and try again.')
    const withToken: StrategyConfig =
      c.kind === 'limit' && real
        ? { kind: 'limit', limit: { ...c.limit, token: real } }
        : c.kind === 'sniper' && real
          ? { kind: 'sniper', sniper: { ...c.sniper, token: real } }
          : c.kind === 'dca' && real
            ? { kind: 'dca', dca: { ...c.dca, token: real } }
            : c
    const buyNear =
      withToken.kind === 'limit' && withToken.limit.amount.kind === 'near'
        ? Number(withToken.limit.amount.value)
        : withToken.kind === 'sniper'
          ? withToken.sniper.amountNear
          : withToken.kind === 'dca'
            ? withToken.dca.amountNear
            : withToken.kind === 'copy'
              ? withToken.copy.maxTradeNear
              : 0
    if (buyNear > limits.maxTradeNear)
      throw new AutomationError('limit', `An automated trade spends at most ${limits.maxTradeNear} NEAR.`, [{ field: 'amount', message: `At most ${limits.maxTradeNear} NEAR` }])
    if (withToken.kind === 'copy') {
      // Never follow a NEARKITS wallet: two rules following each other would copy their own copies.
      if (await custody.store.walletByAccount(network.id, withToken.copy.target))
        throw new AutomationError('target', 'That account is a NEARKITS wallet: following NEARKITS wallets isn’t allowed (copies of copies would loop).')
      if (withToken.copy.exclude.includes(network.wrapContract)) withToken.copy.exclude = withToken.copy.exclude.filter((t) => t !== network.wrapContract)
    }
    return withToken
  }

  const subjectOf = (c: StrategyConfig) => (c.kind === 'copy' ? c.copy.target : (tokenOfStrategy(c) as TokenRef).id)
  const firstCheck = (c: StrategyConfig) => (c.kind === 'dca' ? Math.max(now(), c.dca.startAt) : now())
  const expiryOf = (c: StrategyConfig) => (c.kind === 'limit' ? c.limit.expiresAt : c.kind === 'sniper' ? c.sniper.expiresAt : c.kind === 'dca' ? c.dca.endAt : null)

  async function create(userId: number, input: CreateStrategyInput): Promise<StrategyView[]> {
    const wallet = await ownWallet(userId, input.walletId)
    const config = await prepared(input.config)
    if (config.kind === 'sniper' && config.sniper.mode === 'execute' && input.confirmExecute !== true)
      throw new AutomationError('confirm', 'A sniper that buys needs your explicit confirmation: it trades from your NEARKITS wallet without asking again.')
    let pair: StrategyConfig | null = null
    if (input.pair !== undefined) {
      pair = await prepared(input.pair)
      const a = config.kind === 'limit' ? config.limit : null
      const b = pair.kind === 'limit' ? pair.limit : null
      const types = new Set([a?.type, b?.type])
      if (!a || !b || a.token.id !== b.token.id || !types.has('take-profit') || !types.has('stop-loss'))
        throw new AutomationError('pair', 'A pair is a take profit and a stop loss on the same token.')
    }
    const oco = pair ? `oco-${Math.random().toString(36).slice(2, 12)}` : null
    const made: Strategy[] = []
    try {
      for (const c of pair ? [config, pair] : [config]) {
        made.push(
          await store.create({
            userId,
            network: network.id,
            walletId: wallet.id,
            config: c,
            subject: subjectOf(c),
            status: 'active',
            ocoGroup: oco,
            nextCheckAt: firstCheck(c),
            expiresAt: expiryOf(c),
            state: c.kind === 'copy' ? { since: now(), positions: {} } : c.kind === 'dca' ? { runs: 0, nextRunAt: c.dca.startAt, tries: 0 } : {},
          }),
        )
      }
    } catch (e) {
      // The pair's first half is undone when the second can't be made.
      for (const s of made) await store.transition(s.id, ['active'], 'cancelled', { reason: 'Its pair couldn’t be created' })
      if (e instanceof LiveLimitError) throw new AutomationError('limit', e.message)
      if (e instanceof Error && /unique|duplicate/i.test(e.message)) throw new AutomationError('target', 'You already copy this account: pause or stop that rule first.')
      throw e
    }
    const wallets = new Map([[wallet.id, wallet]])
    return Promise.all(made.map((s) => view(s, wallets)))
  }

  async function list(userId: number, kinds?: readonly StrategyKind[]): Promise<StrategyView[]> {
    const rows = await store.forUser(userId, network.id, { kinds })
    const wallets = new Map((await custody.store.activeWallets(userId, network.id)).map((w) => [w.id, w]))
    return Promise.all(rows.map((s) => view(s, wallets)))
  }

  async function detail(userId: number, id: string): Promise<StrategyDetail> {
    const s = await own(userId, id)
    const [executions, events, detections] = await Promise.all([store.executionsOf(s.id), store.events(s.id), store.detectionsOf(s.id)])
    const ev = (e: (typeof executions)[number]): ExecutionView => ({
      id: e.id,
      side: e.side,
      token: e.token,
      status: e.status,
      amountInRaw: e.amountInRaw,
      expectedOutRaw: e.expectedOutRaw,
      minOutRaw: e.minOutRaw,
      nearRaw: e.nearRaw,
      tokenRaw: e.tokenRaw,
      priceNear: e.priceYocto && /^\d+$/.test(e.priceYocto) ? formatPrice(BigInt(e.priceYocto)) : null,
      txHashes: e.txHashes,
      message: e.message,
      source: e.source,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })
    return {
      strategy: await view(s),
      executions: executions.map(ev),
      events,
      detections: detections.map((d): DetectionView => ({
        sourceKey: d.sourceKey,
        at: d.at,
        side: d.side,
        token: d.token,
        tokenRaw: d.tokenRaw,
        nearRaw: d.nearRaw,
        status: d.status,
        reason: d.reason,
      })),
    }
  }

  async function pause(userId: number, id: string): Promise<StrategyView> {
    const s = await own(userId, id)
    if (!(await store.transition(s.id, ['active', 'draft'], 'paused', { reason: 'Paused by you' }))) {
      if (s.status === 'paused') return view(s)
      throw new AutomationError(
        'busy',
        s.status === 'triggered' || s.status === 'executing' || s.status === 'submitted' ? 'A trade is under way: it is followed to the end first.' : 'It has ended already.',
      )
    }
    await store.event(s.id, 'paused', 'Paused by its owner')
    return view((await store.get(s.id)) as Strategy)
  }

  async function resume(userId: number, id: string): Promise<StrategyView> {
    const s = await own(userId, id)
    if (!deps.enabled.has(s.kind)) throw new AutomationError('off', 'This automation isn’t switched on by NEARKITS.')
    await ownWallet(userId, s.walletId)
    if (s.expiresAt !== null && s.expiresAt <= now()) throw new AutomationError('state', 'It has expired: create a new one.')
    if (!(await store.transition(s.id, ['paused'], 'active', { reason: null, nextCheckAt: now(), state: { ...s.state, armedAt: null } }))) {
      if (s.status === 'active') return view(s)
      throw new AutomationError('state', 'Only a paused automation can be resumed.')
    }
    await store.event(s.id, 'resumed', 'Resumed by its owner')
    return view((await store.get(s.id)) as Strategy)
  }

  /**
   * Ends it for good: an order is cancelled, a Copy Trade, Sniper or DCA is stopped. Nothing new is sent
   * from now on; a trade already sent is followed to the end and recorded. An order whose trade is
   * under way can't be cancelled: the chain decides it first.
   */
  async function cancel(userId: number, id: string): Promise<StrategyView> {
    const s = await own(userId, id)
    const to = s.kind === 'limit' ? 'cancelled' : 'stopped'
    if (!(await store.transition(s.id, ['draft', 'active', 'paused'], to, { reason: s.kind === 'limit' ? 'Cancelled by you' : 'Stopped by you' }))) {
      if (FINAL_STATUSES.includes(s.status)) return view(s)
      throw new AutomationError('busy', 'A trade is under way: it is followed to the end first. Try again once it settles.')
    }
    await store.event(s.id, to, s.kind === 'limit' ? 'Cancelled by its owner' : 'Stopped by its owner')
    // Its trade not signed yet (if any) is never signed: the engine finds the intent cancelled.
    for (const e of await store.openExecutionsOf(s.id)) if (e.intentId) await custody.store.setStatus(e.intentId, ['quoted'], 'cancelled')
    return view((await store.get(s.id)) as Strategy)
  }

  /** The user's own pause of everything: every live automation of theirs pauses now. */
  async function pauseAll(userId: number): Promise<number> {
    let n = 0
    for (const s of await store.forUser(userId, network.id, { limit: 200 })) {
      if (await store.transition(s.id, ['active', 'draft'], 'paused', { reason: 'Paused by you (pause all)' })) {
        await store.event(s.id, 'paused', 'Paused by its owner (pause all)')
        n++
      }
    }
    return n
  }

  /** What it would trade now, from a fresh executable quote from the chosen wallet: shown before it is enabled. */
  async function preview(userId: number, walletId: string, input: unknown): Promise<StrategyPreview> {
    const wallet = await ownWallet(userId, walletId)
    const c = await prepared(input)
    const token = tokenOfStrategy(c)
    if (!token) throw new AutomationError('state', 'Copy Trade has nothing to quote until the followed account trades.')
    const side = c.kind === 'limit' ? sideOf(c.limit.type) : 'buy'
    const [nearState, held] = await Promise.all([
      near.ctx.balances.get(wallet.accountId).catch(() => null),
      near.ctx.reader.balanceOf(token.id, wallet.accountId).catch(() => null),
    ])
    let amountIn: string
    if (c.kind === 'limit') {
      const a = c.limit.amount
      if (a.kind === 'percent') {
        if (held === null || held === 0n) throw new AutomationError('state', `The wallet holds no ${token.symbol} to sell.`)
        amountIn = formatUnits((held * BigInt(a.value)) / 100n, token.decimals)
      } else amountIn = a.value
    } else amountIn = (c.kind === 'sniper' ? c.sniper.amountNear : c.kind === 'dca' ? c.dca.amountNear : 0).toFixed(6).replace(/\.?0+$/, '')
    const slippagePct = c.kind === 'limit' ? c.limit.slippagePct : c.kind === 'sniper' ? c.sniper.slippagePct : c.kind === 'dca' ? c.dca.slippagePct : 1
    const q = await custody.swaps.quote({ side, token: token.id, symbol: token.symbol, decimals: token.decimals, amountIn, slippagePct }, wallet)
    const a = quoteAmounts(side, q)
    const price = priceYocto(a.nearRaw, a.tokenRaw, token.decimals)
    const target = c.kind === 'limit' ? targetYocto(c.limit.triggerPriceNear) : null
    return {
      side,
      amountIn,
      expectedOutRaw: q.amountOut,
      minOutRaw: q.minOut,
      priceNear: price === null ? '0' : formatPrice(price),
      priceImpactPct: q.priceImpactPct,
      feeRaw: q.fee.charged ? q.fee.amountRaw : null,
      feeToken: q.fee.charged ? q.fee.token : null,
      networkFeeNear: q.networkFeeNear,
      wouldTrigger: c.kind === 'limit' && target !== null ? meetsTrigger(c.limit.type, a.nearRaw, a.tokenRaw, token.decimals, target) : null,
      balanceNearRaw: nearState?.state?.availableYocto?.toString() ?? null,
      balanceTokenRaw: held === null ? null : held.toString(),
    }
  }

  return { features, create, list, detail, pause, resume, cancel, pauseAll, preview }
}

export type AutomationService = ReturnType<typeof createAutomationService>
