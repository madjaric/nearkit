import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, tryParseUnits } from '@/lib/amounts'
import { REQUEST_KEY, type AutomationFeatures, type DetectionView, type ExecutionView, type StrategyDetail, type StrategyPreview, type StrategyView } from '@/lib/automation/api'
import {
  AUTOMATION_MAX_SLIPPAGE,
  DCA_INTERVALS_SEC,
  MAX_SNIPER_BUYS,
  MIN_AUTOMATION_NEAR,
  SNIPER_SOURCES,
  validateSniper,
  type CopyConfig,
  type LimitOrderType,
  type OrderAmount,
  type SniperSettings,
  type SniperSource,
  type StrategyConfig,
  type StrategyKind,
  type StrategyStatus,
  type TokenRef,
} from '@/lib/automation/config'
import { accountIdError } from '@/lib/validation'
import { AutomationError, type AutomationService } from '../automation/service'
import { walletName } from '../custody/limits'
import type { TradingWallet } from '../custody/store'
import { randomToken, sha256Hex } from '../ids'
import { bold, code, esc, shortAccount, truncate } from '../telegram/html'
import { resolveToken } from '../trade/tokens'
import { btn, documented, FLOW_TTL_MS, keyboard, urlBtn, type BotCtx, type BotModule } from './context'
import { txLinks } from './intents'
import { Buckets } from './ratelimit'
import { walletLine } from './tradingWallet'
import { friendlyError, nearText, UNKNOWN } from './ui'

/**
 * Trading automation in Telegram: limit orders (with take profit and stop loss, alone or as a pair),
 * Copy Trade, Sniper and DCA. /orders, /copy, /snipe, /dca list them and start a new one; /auto shows
 * all of them with Pause all.
 *
 * Everything goes through the very service NEARKITS web uses (deps.automation): it decides whose
 * strategy it is (every button re-reads it with the presser's own Telegram account, never trusting
 * an ID in the button alone), validates the configuration again and reads the token from chain. A
 * new automation is first previewed from a fresh executable quote from the chosen NEARKITS wallet,
 * then created only on Confirm, once: the reviewed setup is consumed atomically, so a second tap (or
 * a replayed button) creates nothing, and the create carries a request key derived from that review,
 * so the server makes nothing new for it either. A Sniper that buys needs a second, explicit yes.
 *
 * A Sniper watches one token, or new pools (Nearly launches, meme.cooking graduations, other new pools)
 * as Ref DCL and Ref v2 create them: a new-pools sniper has nothing to quote until a pool appears, so
 * its review is a summary of what it watches and checks, not a quote.
 *
 * Trigger fills, failures and risk-limit refusals reach the chat from the worker (runner.ts): this
 * module never claims a trade happened.
 */

const KIND_LABEL: Record<StrategyKind, string> = { limit: 'Limit orders', copy: 'Copy Trade', sniper: 'Sniper', dca: 'DCA' }
const KIND_ICON: Record<StrategyKind, string> = { limit: '🎯', copy: '👥', sniper: '🔫', dca: '🔁' }
const KIND_COMMAND: Record<StrategyKind, string> = { limit: 'orders', copy: 'copy', sniper: 'snipe', dca: 'dca' }
const KIND_WEB: Record<StrategyKind, string> = { limit: '/limit-orders', copy: '/copy-trade', sniper: '/sniper', dca: '/dca' }
const KIND_NEW: Record<StrategyKind, string> = { limit: '➕ New order', copy: '➕ Follow a wallet', sniper: '➕ New sniper', dca: '➕ New DCA' }
const KINDS: readonly StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']

const ORDER_LABEL: Record<LimitOrderType, string> = { 'limit-buy': 'Limit buy', 'limit-sell': 'Limit sell', 'take-profit': 'Take profit', 'stop-loss': 'Stop loss' }
const STATUS_TEXT: Record<StrategyStatus, string> = {
  draft: '⚪ Draft',
  active: '🟢 Active',
  paused: '⏸ Paused',
  triggered: '🎯 Triggered',
  executing: '⚙️ Trading',
  submitted: '📨 Sent, waiting for the chain',
  filled: '✅ Filled',
  completed: '🏁 Completed',
  cancelled: '✖ Cancelled',
  stopped: '⏹ Stopped',
  expired: '⌛ Expired',
  failed: '❌ Failed',
}
const OPEN: readonly StrategyStatus[] = ['draft', 'active', 'paused']
const EVERY_LABEL: Record<number, string> = { 3_600: 'hour', 14_400: '4 hours', 43_200: '12 hours', 86_400: 'day', 604_800: 'week' }

/** How long a reviewed setup's Confirm stays valid. */
const REVIEW_TTL_MS = 15 * 60_000
const SHOWN = 8
const DEFAULT_SLIPPAGE = 1
const DEFAULT_SNIPER_ATTEMPTS = 3
const HOUR = 3_600_000

// ─── the setup being built ──────────────────────────────────────────────────

type OrderChoice = LimitOrderType | 'tpsl'

/** A new automation while it is being set up: in the chat's waiting step, then (reviewed) in a one-time Confirm. */
interface Draft {
  /** Binds this setup's buttons: a button from an earlier setup does nothing. */
  n: string
  kind: StrategyKind
  walletId?: string
  type?: OrderChoice
  token?: TokenRef
  /** Tokens matching what the user sent, to pick from. */
  cands?: TokenRef[]
  amount?: OrderAmount
  /** The trigger (the take profit's, in a pair). */
  price?: string
  /** The stop loss's trigger, in a pair. */
  sl?: string
  slip?: number
  /** How long until it expires (ms); 0: never. */
  ttl?: number
  target?: string
  side?: CopyConfig['copy']
  sizing?: CopyConfig['sizing']
  maxTrade?: number
  maxExposure?: number
  amountNear?: number
  impact?: number
  mode?: 'notify' | 'execute'
  every?: number
  /** The most buys; 0: no limit. */
  runs?: number
  /** Sniper: one token, or new pools as the exchanges create them. */
  aim?: SniperSettings['target']
  /** New pools: the sources ticked so far, and whether that choice is made (Continue). */
  sources?: SniperSource[]
  sourcesSet?: boolean
  /** New pools: the least NEAR a new pool must hold on its NEAR side. */
  minPool?: number
  /** New pools, buying: how many different tokens it buys before it completes. */
  buys?: number
}

type Step =
  | 'type'
  | 'wallet'
  | 'token'
  | 'amount'
  | 'price'
  | 'sl'
  | 'slip'
  | 'expiry'
  | 'target'
  | 'side'
  | 'sizing'
  | 'maxTrade'
  | 'maxExposure'
  | 'amountNear'
  | 'impact'
  | 'mode'
  | 'every'
  | 'runs'
  | 'aim'
  | 'sources'
  | 'minPool'
  | 'buys'

const STEPS: Record<StrategyKind, Step[]> = {
  limit: ['type', 'wallet', 'token', 'amount', 'price', 'sl', 'slip', 'expiry'],
  copy: ['wallet', 'target', 'side', 'sizing', 'maxTrade', 'maxExposure', 'slip'],
  sniper: ['aim', 'wallet', 'token', 'sources', 'minPool', 'amountNear', 'slip', 'impact', 'expiry', 'mode', 'buys'],
  dca: ['wallet', 'token', 'amountNear', 'every', 'runs', 'slip'],
}

function done(d: Draft, s: Step): boolean {
  switch (s) {
    case 'type':
      return d.type !== undefined
    case 'wallet':
      return d.walletId !== undefined
    case 'token':
      return d.token !== undefined || newPools(d)
    case 'amount':
      return d.amount !== undefined
    case 'price':
      return d.price !== undefined
    case 'sl':
      return d.type !== 'tpsl' || d.sl !== undefined
    case 'slip':
      return d.slip !== undefined
    case 'expiry':
      return d.ttl !== undefined
    case 'target':
      return d.target !== undefined
    case 'side':
      return d.side !== undefined
    case 'sizing':
      return d.sizing !== undefined
    case 'maxTrade':
      return d.maxTrade !== undefined
    case 'maxExposure':
      return d.maxExposure !== undefined
    case 'amountNear':
      return d.amountNear !== undefined
    case 'impact':
      return d.impact !== undefined
    case 'mode':
      return d.mode !== undefined
    case 'every':
      return d.every !== undefined
    case 'runs':
      return d.runs !== undefined
    case 'aim':
      return d.kind !== 'sniper' || d.aim !== undefined
    case 'sources':
      return !newPools(d) || d.sourcesSet === true
    case 'minPool':
      return !newPools(d) || d.minPool !== undefined
    case 'buys':
      return !newPools(d) || d.mode !== 'execute' || d.buys !== undefined
  }
}

/** A sniper on new pools (not on one token). */
const newPools = (d: Draft) => d.kind === 'sniper' && d.aim === 'new-pools'
/** New-pool sources in their own order, whatever order they were ticked in. */
const sourcesOf = (d: Draft): SniperSource[] => SNIPER_SOURCES.filter((x) => d.sources?.includes(x))

const nextStep = (d: Draft): Step | null => STEPS[d.kind].find((s) => !done(d, s)) ?? null
const isSell = (t: OrderChoice | undefined) => t !== undefined && t !== 'limit-buy'

/** The configuration(s) a finished setup makes, as of `now` (a DCA starts now; an expiry counts from now). */
function configsOf(d: Draft, now: number): { config: StrategyConfig; pair?: StrategyConfig } {
  const slippagePct = d.slip ?? DEFAULT_SLIPPAGE
  const expiresAt = d.ttl ? now + d.ttl : null
  const token = d.token as TokenRef
  switch (d.kind) {
    case 'limit': {
      const order = (type: LimitOrderType, price: string): StrategyConfig => ({
        kind: 'limit',
        limit: { type, token, amount: d.amount as OrderAmount, triggerPriceNear: price, slippagePct, expiresAt },
      })
      if (d.type === 'tpsl') return { config: order('take-profit', d.price as string), pair: order('stop-loss', d.sl as string) }
      return { config: order(d.type as LimitOrderType, d.price as string) }
    }
    case 'copy':
      return {
        config: {
          kind: 'copy',
          copy: {
            target: d.target as string,
            copy: d.side ?? 'both',
            sizing: d.sizing as CopyConfig['sizing'],
            maxTradeNear: d.maxTrade as number,
            minTradeNear: null,
            maxExposureNear: d.maxExposure as number,
            slippagePct,
            minLiquidityUsd: null,
            exclude: [],
          },
        },
      }
    case 'sniper': {
      const mode = d.mode ?? 'notify'
      if (newPools(d))
        return {
          config: {
            kind: 'sniper',
            sniper: {
              target: 'new-pools',
              token: null,
              sources: sourcesOf(d),
              minPoolNear: d.minPool ?? null,
              // Notify-only buys nothing: its number of tokens is never reached.
              maxBuys: mode === 'execute' ? (d.buys ?? 1) : 1,
              amountNear: d.amountNear as number,
              slippagePct,
              maxImpactPct: d.impact as number,
              minLiquidityUsd: null,
              maxAttempts: DEFAULT_SNIPER_ATTEMPTS,
              expiresAt,
              mode,
            },
          },
        }
      return {
        config: {
          kind: 'sniper',
          sniper: {
            target: 'token',
            token,
            sources: [],
            minPoolNear: null,
            maxBuys: 1,
            amountNear: d.amountNear as number,
            slippagePct,
            maxImpactPct: d.impact as number,
            minLiquidityUsd: null,
            maxAttempts: DEFAULT_SNIPER_ATTEMPTS,
            expiresAt,
            mode,
          },
        },
      }
    }
    case 'dca':
      return {
        config: {
          kind: 'dca',
          dca: { token, amountNear: d.amountNear as number, everySec: d.every as number, startAt: now, endAt: null, slippagePct, maxRuns: d.runs ? d.runs : null },
        },
      }
  }
}

// ─── formatting ─────────────────────────────────────────────────────────────

const num = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(6))) : UNKNOWN)
const fmt = (raw: bigint, decimals: number, maxFraction = 6) => formatUnits(raw, decimals, { maxFraction, group: true })
const rawText = (raw: string | null, decimals: number) => (raw && /^\d+$/.test(raw) ? fmt(BigInt(raw), decimals) : UNKNOWN)
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 90 ? `${s}s ago` : s < 90 * 60 ? `${Math.round(s / 60)} min ago` : s < 48 * 3600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`
}
const ttlText = (ms: number) => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} day${ms === 86_400_000 ? '' : 's'}` : `${Math.round(ms / HOUR)} hours`)
const everyText = (sec: number) => `every ${EVERY_LABEL[sec] ?? `${Math.round(sec / 3600)} hours`}`
const sizingText = (s: CopyConfig['sizing']) => (s.mode === 'fixed' ? `${num(s.amountNear)} NEAR` : `${num(s.pct)}% of what they spent`)
const sideText = (s: CopyConfig['copy']) => (s === 'both' ? 'buys and sells' : s === 'buy' ? 'buys only' : 'sells only')

function amountText(a: OrderAmount, symbol: string): string {
  return a.kind === 'near' ? `${a.value} NEAR` : a.kind === 'tokens' ? `${a.value} ${symbol}` : `${a.value}% of the ${symbol} held then`
}

/** A new-pools sniper's sources: in a sentence, on its toggle buttons, and in the one-line setup so far. */
const SOURCE_LABEL: Record<SniperSource, string> = { nearly: 'Nearly launch pools', 'meme-cooking': 'meme.cooking graduation pools', other: 'other new pools' }
const SOURCE_BUTTON: Record<SniperSource, string> = { nearly: 'Nearly launches', 'meme-cooking': 'meme.cooking graduations', other: 'Other new pools' }
const SOURCE_SHORT: Record<SniperSource, string> = { nearly: 'Nearly', 'meme-cooking': 'meme.cooking', other: 'other pools' }
/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
/** A new-pools sniper's sources in words (plain text). */
const sourcesText = (sources: readonly SniperSource[]) => listText(SNIPER_SOURCES.filter((x) => sources.includes(x)).map((x) => SOURCE_LABEL[x])) || UNKNOWN
const tokensText = (n: number) => `${n} token${n === 1 ? '' : 's'}`
/** A sniper on new pools (its configuration names no token). */
const isNewPools = (c: StrategyConfig): boolean => c.kind === 'sniper' && (c.sniper.target === 'new-pools' || !c.sniper.token)

/** A strategy's name: what it trades and how. Plain text (the caller escapes). */
function titleOf(c: StrategyConfig): string {
  switch (c.kind) {
    case 'limit':
      return `${ORDER_LABEL[c.limit.type]} ${c.limit.token.symbol}`
    case 'copy':
      return `Copy ${shortAccount(c.copy.target, 32)}`
    case 'sniper':
      return isNewPools(c) || !c.sniper.token ? 'Sniper: new pools' : `Sniper ${c.sniper.token.symbol}`
    case 'dca':
      return `DCA ${c.dca.token.symbol}`
  }
}

/** What it does, in one line (HTML). */
function ruleText(c: StrategyConfig): string {
  switch (c.kind) {
    case 'limit': {
      const l = c.limit
      const per = `NEAR per ${esc(l.token.symbol)}`
      const amount = bold(amountText(l.amount, l.token.symbol))
      if (l.type === 'limit-buy') return `Buy with ${amount} when the price is at or below ${bold(l.triggerPriceNear)} ${per}`
      if (l.type === 'stop-loss') return `Sell ${amount} when the price is at or below ${bold(l.triggerPriceNear)} ${per}`
      return `Sell ${amount} when the price is at or above ${bold(l.triggerPriceNear)} ${per}`
    }
    case 'copy': {
      const p = c.copy
      return `Copies ${esc(sideText(p.copy))} of ${code(p.target)}: ${esc(sizingText(p.sizing))} per buy, at most ${bold(`${num(p.maxTradeNear)} NEAR`)} a trade and ${bold(`${num(p.maxExposureNear)} NEAR`)} open in all`
    }
    case 'sniper': {
      const s = c.sniper
      const amount = bold(`${num(s.amountNear)} NEAR`)
      if (isNewPools(c) || !s.token) {
        const pools = `Watches ${esc(sourcesText(s.sources))} holding at least ${bold(`${num(s.minPoolNear ?? 0)} NEAR`)}`
        return s.mode === 'execute'
          ? `${pools}: buys ${amount} of each new token that passes the checks, up to ${tokensText(s.maxBuys)}, at most ${num(s.maxImpactPct)}% price impact`
          : `${pools}: tells you of each new token whose ${amount} buy passes the checks (at most ${num(s.maxImpactPct)}% price impact); nothing is bought`
      }
      return `Once ${esc(s.token.symbol)} trades, ${s.mode === 'execute' ? 'buys' : 'tells you (and would buy)'} with ${amount} at most ${num(s.maxImpactPct)}% price impact`
    }
    case 'dca': {
      const d = c.dca
      return `Buys ${esc(d.token.symbol)} with ${bold(`${num(d.amountNear)} NEAR`)} ${everyText(d.everySec)}${d.maxRuns ? `, ${d.maxRuns} buys` : ', with no end'}`
    }
  }
}

const slippageOf = (c: StrategyConfig) =>
  c.kind === 'limit' ? c.limit.slippagePct : c.kind === 'copy' ? c.copy.slippagePct : c.kind === 'sniper' ? c.sniper.slippagePct : c.dca.slippagePct
const tokenOf = (c: StrategyConfig): TokenRef | null => (c.kind === 'limit' ? c.limit.token : c.kind === 'sniper' ? c.sniper.token : c.kind === 'dca' ? c.dca.token : null)

/** One line in a list. */
function listLine(v: StrategyView, i: number): string {
  return `${i + 1}. ${KIND_ICON[v.kind]} ${bold(titleOf(v.config))} · ${STATUS_TEXT[v.status]}${v.lastPriceNear && v.kind === 'limit' ? ` · now ${esc(v.lastPriceNear)}` : ''}`
}

function executionLine(deps: BotCtx['deps'], e: ExecutionView, token: TokenRef | null): string {
  const icon = { executing: '⚙️', submitted: '📨', confirmed: '✅', failed: '❌', cancelled: '✖' }[e.status]
  const sym = token ? esc(token.symbol) : esc(shortAccount(e.token))
  const tokenAmt = (raw: string | null) => (token ? `${rawText(raw, token.decimals)} ${sym}` : `${sym}`)
  const nearAmt = (raw: string | null) => `${rawText(raw, NEAR_DECIMALS)} NEAR`
  const moved = !token
    ? // Its token's decimals aren't in this view (Copy Trade, a new-pools sniper): the NEAR side only.
      e.side === 'buy'
      ? `${nearAmt(e.status === 'confirmed' ? e.nearRaw : e.amountInRaw)} → ${sym}`
      : e.status === 'confirmed'
        ? `${sym} → ${nearAmt(e.nearRaw)}`
        : `${sym} → ≈ ${nearAmt(e.expectedOutRaw)} expected`
    : e.status === 'confirmed'
      ? e.side === 'buy'
        ? `${nearAmt(e.nearRaw)} → ${tokenAmt(e.tokenRaw)}`
        : `${tokenAmt(e.tokenRaw)} → ${nearAmt(e.nearRaw)}`
      : e.side === 'buy'
        ? `≈ ${tokenAmt(e.expectedOutRaw)} expected`
        : `≈ ${nearAmt(e.expectedOutRaw)} expected`
  return [
    `${icon} ${e.side === 'buy' ? 'Buy' : 'Sell'} · ${moved}`,
    ...(e.priceNear ? [`at ${esc(e.priceNear)} NEAR`] : []),
    when(e.createdAt),
    ...(e.txHashes.length ? [txLinks(deps, e.txHashes)] : []),
    ...(e.status === 'failed' && e.message ? [esc(e.message)] : []),
  ].join(' · ')
}

const DETECTION_STATUS: Record<DetectionView['status'], string> = {
  // Seen is only seen: never a trade.
  detected: '👀 seen',
  eligible: '☑️ passed the checks',
  skipped: '⏭ skipped',
  executing: '⚙️ trading, not confirmed yet',
  submitted: '📨 sent, not confirmed yet',
  confirmed: '📨 sent: see Trades for the chain’s answer',
  failed: '❌ failed',
}
const EXECUTION_STATUS: Record<ExecutionView['status'], (side: 'buy' | 'sell') => string> = {
  executing: () => '⚙️ trading, not confirmed yet',
  submitted: () => '📨 sent, not confirmed yet',
  confirmed: (side) => `✅ ${side === 'buy' ? 'bought' : 'sold'}, confirmed on chain`,
  failed: () => '❌ failed on chain',
  cancelled: () => '✖ not sent',
}

/**
 * One thing Copy Trade or Sniper saw: what it was (a new pool, a copied leg with its transaction on the
 * explorer, the followed account's transaction), its token and what became of it. A trade is called
 * bought or sold only when its own record says the chain confirmed it.
 */
function detectionLine(deps: BotCtx['deps'], x: DetectionView, execs: readonly ExecutionView[]): string {
  const pool = /^pool:(dcl|ref):(.+)$/.exec(x.sourceKey)
  const leg = /^([^:]+):(buy|sell)$/.exec(x.sourceKey)
  const route = x.sourceKey.startsWith('route:')
  const tx = (hash: string) => (hash ? txLinks(deps, [hash]) : UNKNOWN)
  const what = pool
    ? `🆕 New pool ${code(pool[2] ?? '')} (${pool[1] === 'dcl' ? 'Ref DCL' : 'Ref v2'})`
    : leg
      ? `↔️ Copied ${leg[2]} leg of ${tx(leg[1] ?? '')}`
      : route
        ? '🔫 A route'
        : !x.sourceKey.includes(':')
          ? `🧾 ${x.side ? `A ${x.side}: ` : ''}${tx(x.sourceKey)}`
          : esc(truncate(x.sourceKey, 40))
  // Its own trade (by the source it was made for; a token sniper's one buy by its token), if there is one.
  const mine = execs.filter((e) => e.source === x.sourceKey || (route && e.source === null && e.token === x.token && e.side === 'buy'))
  const e = mine.find((m) => m.status === 'confirmed') ?? mine[0]
  const traded = x.status === 'executing' || x.status === 'submitted' || x.status === 'confirmed' || x.status === 'failed'
  const status = e && traded ? EXECUTION_STATUS[e.status](e.side) : DETECTION_STATUS[x.status]
  return [`· ${when(x.at)} ${what}`, ...(x.token ? [code(x.token)] : []), `${status}${x.reason ? `: ${esc(truncate(x.reason, 200))}` : ''}`].join(' · ')
}

/** The strategy's card: what it does, its state, and why it waits. */
function cardLines(ctx: BotCtx, v: StrategyView): string[] {
  const now = ctx.deps.now()
  const token = tokenOf(v.config)
  return [
    `${KIND_ICON[v.kind]} ${bold(titleOf(v.config))}`,
    ...(token ? [code(token.id)] : []),
    `${STATUS_TEXT[v.status]}${v.statusReason ? `: ${esc(v.statusReason)}` : ''}`,
    ...(v.waiting && !['filled', 'completed', 'cancelled', 'stopped', 'expired', 'failed'].includes(v.status) ? [`⏳ Waiting: ${esc(v.waiting)}`] : []),
    ruleText(v.config),
    `Slippage ${slippageOf(v.config)}% once it trades`,
    `👛 ${v.walletName ? bold(v.walletName) : 'A NEARKITS wallet'}`,
    ...(v.kind === 'limit' ? [`Last price ${v.lastPriceNear ? `${bold(v.lastPriceNear)} NEAR` : UNKNOWN}${v.lastQuoteAt ? ` · ${ago(now, v.lastQuoteAt)}` : ''}`] : []),
    ...(v.ocoGroup ? ['🔗 Paired: the first of its take profit and stop loss to trigger cancels the other.'] : []),
    v.expiresAt ? `⌛ Expires ${when(v.expiresAt)}` : v.kind === 'limit' ? '⌛ Good till cancelled' : '',
  ].filter((l) => l !== '')
}

// ─── the service, and refusals in plain words ───────────────────────────────

/** Previews hit the quote servers: at most 12 a minute per user. */
const quoteLimits = new WeakMap<object, Buckets>()
function quoteAllowed(ctx: BotCtx): boolean {
  let b = quoteLimits.get(ctx.deps)
  if (!b) {
    b = new Buckets(12, 12 / 60, ctx.deps.now)
    quoteLimits.set(ctx.deps, b)
  }
  return b.take(String(ctx.user.id))
}

const OFF_TEXT = '⏳ Trading automation isn’t switched on yet. NEARKITS turns limit orders, Copy Trade, Sniper and DCA on one by one.'

/** Whether NEARKITS has switched on at least one kind of automation here (the main menu offers it then). */
export async function automationOn(deps: BotCtx['deps']): Promise<boolean> {
  if (!deps.automation || !deps.custody) return false
  return (await deps.automation.features().catch(() => null))?.enabled.length ? true : false
}

/** The service and what NEARKITS has switched on; null (after saying so) when automation isn't on here at all. */
async function service(ctx: BotCtx): Promise<{ svc: AutomationService; f: AutomationFeatures } | null> {
  const svc = ctx.deps.automation
  if (!svc || !ctx.deps.custody) {
    await ctx.show(OFF_TEXT, keyboard([btn('« Menu', 'menu:home')]))
    return null
  }
  return { svc, f: await svc.features() }
}

/** An AutomationError (and its fields to fix) in plain words; null for anything else. */
function refusal(e: unknown): string | null {
  if (!(e instanceof AutomationError)) return null
  const issues = e.issues.slice(0, 4).map((i) => `• ${esc(i.message)}`)
  return [`⚠️ ${esc(e.message)}`, ...issues].join('\n')
}

/** Runs a service call; a refusal is shown (with `markup`) and gives null. Anything else goes to the error boundary. */
async function attempt<T>(ctx: BotCtx, fn: () => Promise<T>, markup = keyboard([btn('🤖 Automations', 'au:l:all')])): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    const text = refusal(e)
    if (!text) throw e
    await ctx.show(text, markup)
    return null
  }
}

// ─── lists, details and controls ────────────────────────────────────────────

async function showList(ctx: BotCtx, which: StrategyKind | 'all'): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const { svc, f } = s
  const kinds = which === 'all' ? KINDS : [which]
  const all = await svc.list(ctx.user.id, kinds)
  // Live first (newest first), then the latest few that ended.
  const live = all.filter((v) => !['filled', 'completed', 'cancelled', 'stopped', 'expired', 'failed'].includes(v.status))
  const ended = all.filter((v) => !live.includes(v)).slice(0, 3)
  const shown = [...live, ...ended].slice(0, SHOWN)
  const enabled = kinds.filter((k) => f.enabled.includes(k))
  if (all.length === 0 && enabled.length === 0) return void (await ctx.show(OFF_TEXT, keyboard([btn('« Menu', 'menu:home')])))
  const head =
    which === 'all'
      ? [
          `🤖 ${bold('Your automations')}`,
          ...KINDS.map((k) => {
            const n = all.filter((v) => v.kind === k && OPEN.concat(['triggered', 'executing', 'submitted']).includes(v.status)).length
            return `${KIND_ICON[k]} ${KIND_LABEL[k]}: ${f.enabled.includes(k) ? `${n} live` : 'not switched on yet'} · /${KIND_COMMAND[k]}`
          }),
        ]
      : [`${KIND_ICON[which]} ${bold(KIND_LABEL[which])}`, ...(f.enabled.includes(which) ? [] : ['Not switched on by NEARKITS yet.'])]
  const text = [
    ...head,
    ...(f.paused && f.pausedReason ? ['', `⏸ ${esc(f.pausedReason)}: nothing trades until it’s back.`] : []),
    '',
    ...(shown.length ? shown.map(listLine) : [which === 'all' ? 'Nothing set up yet.' : `No ${KIND_LABEL[which].toLowerCase()} yet.`]),
    ...(all.length > shown.length ? [`… and ${all.length - shown.length} more on NEARKITS web.`] : []),
  ].join('\n')
  const news = enabled.map((k) => btn(KIND_NEW[k], `au:new:${k}`))
  const anyLive = all.some((v) => v.status === 'active' || v.status === 'draft')
  await ctx.show(
    text,
    keyboard(
      ...shown.map((v, i) => [btn(`${i + 1}. ${titleOf(v.config)}`.slice(0, 60), `au:v:${v.id}`)]),
      news.slice(0, 2),
      news.slice(2),
      which === 'all' && anyLive ? [btn('⏸ Pause all', 'au:pa')] : [],
      [btn('🔄 Refresh', `au:l:${which}`), urlBtn('🌐 NEARKITS web', `${ctx.deps.config.webUrl}${which === 'all' ? KIND_WEB.limit : KIND_WEB[which]}`)],
      [which === 'all' ? btn('« Menu', 'menu:home') : btn('🤖 All automations', 'au:l:all')],
    ),
  )
}

function detailText(ctx: BotCtx, d: StrategyDetail): string {
  const v = d.strategy
  const token = tokenOf(v.config)
  const execs = d.executions.slice(0, 5)
  const events = d.events.slice(0, 5)
  const seen = v.kind === 'copy' || v.kind === 'sniper' ? d.detections.slice(0, isNewPools(v.config) ? 5 : 3) : []
  return [
    ...cardLines(ctx, v),
    '',
    bold('Trades'),
    ...(execs.length ? execs.map((e) => executionLine(ctx.deps, e, token)) : ['None yet.']),
    ...(seen.length ? ['', bold('Seen lately'), ...seen.map((x) => detectionLine(ctx.deps, x, d.executions))] : []),
    '',
    bold('Recent events'),
    ...events.map((e) => `· ${when(e.at)} ${esc(e.message)}`),
  ].join('\n')
}

async function controls(ctx: BotCtx, svc: AutomationService, v: StrategyView) {
  const sibling = v.ocoGroup ? (await svc.list(ctx.user.id, ['limit'])).find((x) => x.ocoGroup === v.ocoGroup && x.id !== v.id) : undefined
  const back = `au:l:${v.kind}`
  return keyboard(
    [
      v.status === 'active' || v.status === 'draft' ? btn('⏸ Pause', `au:p:${v.id}`) : null,
      v.status === 'paused' ? btn('▶️ Resume', `au:r:${v.id}`) : null,
      OPEN.includes(v.status) ? btn(v.kind === 'limit' ? '✖ Cancel order' : '⏹ Stop', `au:x:${v.id}`) : null,
    ],
    sibling ? [btn(`🔗 Its pair: ${titleOf(sibling.config)}`.slice(0, 60), `au:v:${sibling.id}`)] : [],
    [btn('🔄 Refresh', `au:v:${v.id}`), urlBtn('🌐 On NEARKITS web', `${ctx.deps.config.webUrl}${KIND_WEB[v.kind]}`)],
    [btn(`« ${KIND_LABEL[v.kind]}`, back), btn('🤖 All', 'au:l:all')],
  )
}

async function showDetail(ctx: BotCtx, id: string, note?: string): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  // The service reads it for this Telegram account only: anyone else's ID is "not found".
  const d = await attempt(ctx, () => s.svc.detail(ctx.user.id, id))
  if (!d) return
  await ctx.show([...(note ? [note, ''] : []), detailText(ctx, d)].join('\n'), await controls(ctx, s.svc, d.strategy))
}

async function act(ctx: BotCtx, action: 'p' | 'r' | 'xx' | 'xb', id: string): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const { svc } = s
  if (action === 'p') {
    const v = await attempt(ctx, () => svc.pause(ctx.user.id, id))
    if (v) await showDetail(ctx, v.id, '⏸ Paused. Nothing trades until you resume it.')
    return
  }
  if (action === 'r') {
    const v = await attempt(ctx, () => svc.resume(ctx.user.id, id))
    if (v) await showDetail(ctx, v.id, '▶️ Resumed: it watches again.')
    return
  }
  // Cancelling either order of a take profit / stop loss pair cancels the other (the server does both; 'xb' is an older button for the same).
  const v = await attempt(ctx, () => svc.cancel(ctx.user.id, id))
  if (!v) return
  let note = v.kind === 'limit' ? '✖ Cancelled. Nothing new is sent for it.' : '⏹ Stopped. Nothing new is sent for it.'
  if (v.ocoGroup) {
    const sibling = (await svc.list(ctx.user.id, ['limit'])).find((x) => x.ocoGroup === v.ocoGroup && x.id !== v.id)
    if (sibling?.status === 'cancelled') note = '✖ Both orders of the pair are cancelled. Nothing new is sent for them.'
    else if (sibling && ['triggered', 'executing', 'submitted'].includes(sibling.status))
      note = '✖ Cancelled. The other order of its pair is trading already: its result is followed to the end.'
  }
  await showDetail(ctx, v.id, note)
}

/** Cancel (an order) or Stop (the rest) asks first. */
async function askCancel(ctx: BotCtx, id: string): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const d = await attempt(ctx, () => s.svc.detail(ctx.user.id, id))
  if (!d) return
  const v = d.strategy
  if (!OPEN.includes(v.status))
    return showDetail(
      ctx,
      v.id,
      v.status === 'triggered' || v.status === 'executing' || v.status === 'submitted' ? 'A trade is under way: it is followed to the end first.' : 'It has ended already.',
    )
  const order = v.kind === 'limit'
  await ctx.show(
    [
      `${order ? '✖ Cancel' : '⏹ Stop'} ${bold(titleOf(v.config))}?`,
      ruleText(v.config),
      '',
      'It ends for good: nothing new is sent for it. A trade already sent is followed to the end and recorded.',
      ...(v.ocoGroup ? ['', 'It is one of a take profit and stop loss pair: cancelling it cancels the other order too.'] : []),
    ].join('\n'),
    keyboard([btn(order ? (v.ocoGroup ? '✖ Yes, cancel both orders' : '✖ Yes, cancel it') : '⏹ Yes, stop it', `au:xx:${v.id}`)], [btn('« Keep it', `au:v:${v.id}`)]),
  )
}

async function askPauseAll(ctx: BotCtx): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const live = (await s.svc.list(ctx.user.id)).filter((v) => v.status === 'active' || v.status === 'draft')
  if (!live.length) return showList(ctx, 'all')
  await ctx.show(
    [`⏸ ${bold('Pause all your automations?')}`, `${live.length} active: they stop watching until you resume each one. A trade already sent is followed to the end.`].join('\n'),
    keyboard([btn('⏸ Yes, pause all', 'au:pax')], [btn('« Back', 'au:l:all')]),
  )
}

async function pauseAll(ctx: BotCtx): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const n = await s.svc.pauseAll(ctx.user.id)
  await ctx.answer(n ? `Paused ${n}` : 'Nothing to pause')
  await showList(ctx, 'all')
}

// ─── setting one up ─────────────────────────────────────────────────────────

const FLOW = 'au.input'

async function save(ctx: BotCtx, d: Draft): Promise<void> {
  await ctx.deps.store.setSession(ctx.chat.id, ctx.user.id, FLOW, d, FLOW_TTL_MS)
}

/** The setup this chat is building, when `n` is its own (a button of an earlier one does nothing). */
async function current(ctx: BotCtx, n?: string): Promise<Draft | null> {
  const s = await ctx.deps.store.getSession<Draft>(ctx.chat.id, ctx.user.id)
  if (!s || s.flow !== FLOW || !s.data || typeof s.data.n !== 'string') return null
  if (n !== undefined && s.data.n !== n) return null
  return s.data
}

const quitRow = () => [btn('✖ Cancel', 'au:quit')]
const pick = (d: Draft, label: string, field: string, value: string | number) => btn(label, `au:s:${d.n}:${field}:${value}`)

async function startNew(ctx: BotCtx, kind: StrategyKind): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  if (!s.f.enabled.includes(kind)) return void (await ctx.show(`⏳ ${KIND_LABEL[kind]} isn’t switched on by NEARKITS yet.`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  const wallets = await (ctx.deps.custody?.store.activeWallets(ctx.user.id, ctx.deps.config.network.id) ?? Promise.resolve([] as TradingWallet[]))
  if (!wallets.length)
    return void (await ctx.show(
      'Automated trades run only from a NEARKITS wallet (NEARKITS signs them, so a browser wallet is never automated). Create one first.',
      keyboard([btn('👛 Wallet', 'cw:home')]),
    ))
  const d: Draft = { n: randomToken(6), kind }
  if (wallets.length === 1) d.walletId = (wallets[0] as TradingWallet).id
  await advance(ctx, d)
}

/** Asks for the next missing piece, or (all there) shows the review. */
async function advance(ctx: BotCtx, d: Draft): Promise<void> {
  const step = nextStep(d)
  if (!step) return review(ctx, d)
  await save(ctx, d)
  await ask(ctx, d, step)
}

/** The setup so far, one line. */
function soFar(d: Draft): string {
  const bits = [
    d.kind === 'limit' ? (d.type ? (d.type === 'tpsl' ? 'Take profit + stop loss' : ORDER_LABEL[d.type]) : 'New order') : `New ${KIND_LABEL[d.kind]}`,
    d.token?.symbol,
    d.target,
    newPools(d) ? 'New pools' : undefined,
    newPools(d) && d.sourcesSet
      ? sourcesOf(d)
          .map((x) => SOURCE_SHORT[x])
          .join(' + ')
      : undefined,
    newPools(d) && d.minPool !== undefined ? `pool ≥ ${num(d.minPool)} NEAR` : undefined,
    d.amount ? amountText(d.amount, d.token?.symbol ?? '') : undefined,
    d.amountNear !== undefined ? `${num(d.amountNear)} NEAR${newPools(d) ? ' each' : ''}` : undefined,
    d.price ? `${d.type === 'tpsl' ? 'TP ' : 'at '}${d.price}` : undefined,
    d.sl ? `SL ${d.sl}` : undefined,
  ].filter((b): b is string => Boolean(b))
  return `${KIND_ICON[d.kind]} ${bits.map(esc).join(' · ')}`
}

async function priceHint(ctx: BotCtx, d: Draft): Promise<string> {
  const svc = ctx.deps.automation
  if (!svc || !d.walletId || !d.token || !d.amount || !d.type || !quoteAllowed(ctx)) return ''
  const type: LimitOrderType = d.type === 'tpsl' ? 'take-profit' : d.type
  const probe: StrategyConfig = { kind: 'limit', limit: { type, token: d.token, amount: d.amount, triggerPriceNear: '1', slippagePct: DEFAULT_SLIPPAGE, expiresAt: null } }
  const p = await svc.preview(ctx.user.id, d.walletId, probe).catch(() => null)
  return p && p.priceNear !== '0'
    ? `Now ≈ ${bold(`${p.priceNear} NEAR`)} per ${esc(d.token.symbol)}, executable for this amount (fees, tax and price impact included).`
    : `The current price couldn’t be read right now.`
}

async function ask(ctx: BotCtx, d: Draft, step: Step): Promise<void> {
  const head = soFar(d)
  const show = (lines: string[], ...rows: Parameters<typeof keyboard>) => ctx.show([head, '', ...lines].join('\n'), keyboard(...rows, quitRow()))
  const sym = esc(d.token?.symbol ?? 'the token')
  const limits = (await ctx.deps.automation?.features())?.limits
  const maxTrade = limits?.maxTradeNear ?? Infinity
  switch (step) {
    case 'type':
      return show(
        [
          bold('What kind of order?'),
          'Limit buy: buys when the price falls to your price or below.',
          'Limit sell and Take profit: sell at your price or above.',
          'Stop loss: sells at your price or below.',
          'Take profit + stop loss: both on one position; the first to trigger cancels the other.',
          '',
          'Prices are NEAR per whole token, as an executable quote gives them: fees, tax and price impact included. After a trigger it is a market swap with your slippage: the price isn’t guaranteed.',
        ],
        [pick(d, '🟢 Limit buy', 'type', 'limit-buy'), pick(d, '🔴 Limit sell', 'type', 'limit-sell')],
        [pick(d, '💰 Take profit', 'type', 'take-profit'), pick(d, '🛑 Stop loss', 'type', 'stop-loss')],
        [pick(d, '🎯 Take profit + stop loss', 'type', 'tpsl')],
      )
    case 'wallet': {
      const wallets = await (ctx.deps.custody?.store.activeWallets(ctx.user.id, ctx.deps.config.network.id) ?? Promise.resolve([] as TradingWallet[]))
      return show(
        [bold('Which NEARKITS wallet trades it?'), 'Automated trades run only from NEARKITS wallets: NEARKITS signs them through its own signer, with its checks and fee.'],
        ...wallets.map((w) => [pick(d, `${w.slot}. ${walletName(w)} · ${shortAccount(w.accountId)}`.slice(0, 60), 'w', w.id)]),
      )
    }
    case 'token':
      return show([bold('Which token?'), 'Send its symbol or its exact contract ID. It trades against NEAR.'])
    case 'amount':
      if (d.type === 'limit-buy') {
        const presets = (await ctx.deps.store.getSettings(ctx.user.id)).buyPresets.filter((p) => Number(p) >= MIN_AUTOMATION_NEAR && Number(p) <= maxTrade).slice(0, 3)
        return show(
          [
            bold('How much NEAR does it spend when it triggers?'),
            `At least ${MIN_AUTOMATION_NEAR} NEAR${Number.isFinite(maxTrade) ? `, at most ${maxTrade}` : ''}. Tap one or type an amount.`,
          ],
          presets.map((p) => pick(d, `${p} NEAR`, 'amt', `n${p}`)),
        )
      }
      return show(
        [bold(`How much ${sym} does it sell?`), 'A share of what the wallet holds when it triggers (read from chain then), or type an exact amount, e.g. 120 or 50%.'],
        [pick(d, '25%', 'amt', 'p25'), pick(d, '50%', 'amt', 'p50'), pick(d, '100%', 'amt', 'p100')],
      )
    case 'price': {
      const hint = await priceHint(ctx, d)
      const rule =
        d.type === 'limit-buy'
          ? 'It buys when the price is at or below it.'
          : d.type === 'stop-loss'
            ? 'It sells when the price is at or below it.'
            : 'It sells when the price is at or above it.'
      return show([bold(`${d.type === 'tpsl' ? 'Take profit price' : 'Trigger price'}, in NEAR per 1 ${sym}?`), rule, ...(hint ? [hint] : []), 'Type it, e.g. 0.0025.'])
    }
    case 'sl':
      return show([
        bold(`Stop loss price, in NEAR per 1 ${sym}?`),
        `Below the take profit at ${esc(d.price ?? '')}: it sells when the price is at or below it.`,
        'Type it, e.g. 0.0018.',
      ])
    case 'slip':
      return show(
        [bold('Slippage once it trades?'), `It is a market swap then: the minimum received is set on chain from this. At most ${AUTOMATION_MAX_SLIPPAGE}%. Tap one or type it.`],
        [pick(d, '0.5%', 'slip', '0.5'), pick(d, '1% ✓', 'slip', '1'), pick(d, '2%', 'slip', '2'), pick(d, `${AUTOMATION_MAX_SLIPPAGE}%`, 'slip', String(AUTOMATION_MAX_SLIPPAGE))],
      )
    case 'expiry':
      return show(
        [bold(d.kind === 'limit' ? 'Until when?' : 'How long does it watch?'), 'Or type a duration, e.g. 12h or 3d.'],
        [...(d.kind === 'limit' ? [pick(d, 'Good till cancelled', 'exp', '0')] : []), pick(d, '24 hours', 'exp', '24'), pick(d, '7 days', 'exp', '168')],
        [pick(d, '30 days', 'exp', '720'), ...(d.kind === 'sniper' ? [pick(d, 'No expiry', 'exp', '0')] : [])],
      )
    case 'target':
      return show([
        bold('Which NEAR account do you follow?'),
        'Send its account ID, e.g. trader.near. Its NEAR swaps are copied from your NEARKITS wallet, within your limits. NEARKITS wallets can’t be followed.',
      ])
    case 'side':
      return show(
        [bold('Copy what?'), 'A copied sell only sells what this rule bought.'],
        [pick(d, 'Buys and sells', 'side', 'both')],
        [pick(d, 'Buys only', 'side', 'buy'), pick(d, 'Sells only', 'side', 'sell')],
      )
    case 'sizing':
      return show(
        [bold('How big is each copied buy?'), 'A fixed NEAR amount, or a share of what they spent. Tap one or type it, e.g. 0.5 or 10%.'],
        [pick(d, '0.5 NEAR', 'size', 'n0.5'), pick(d, '1 NEAR', 'size', 'n1'), pick(d, '10%', 'size', 'p10'), pick(d, '25%', 'size', 'p25')],
      )
    case 'maxTrade':
      return show(
        [bold('The most NEAR one copied trade may spend?'), `Tap one or type it${Number.isFinite(maxTrade) ? ` (NEARKITS allows at most ${maxTrade})` : ''}.`],
        [1, 5, 10].filter((v) => v <= maxTrade).map((v) => pick(d, `${v} NEAR`, 'mt', v)),
      )
    case 'maxExposure': {
      const m = d.maxTrade ?? 1
      return show(
        [bold('The most NEAR this rule may have in copied buys not yet sold?'), `At least one maximum trade (${num(m)} NEAR). Tap one or type it.`],
        [2, 5, 10].map((x) => pick(d, `${num(m * x)} NEAR`, 'mx', num(m * x))),
      )
    }
    case 'amountNear':
      return show(
        [
          bold(d.kind === 'dca' ? 'How much NEAR per buy?' : newPools(d) ? 'How much NEAR does it buy each new token with?' : 'How much NEAR does it buy with?'),
          `At least ${MIN_AUTOMATION_NEAR} NEAR. Tap one or type it.`,
        ],
        ['0.5', '1', '2'].filter((v) => Number(v) <= maxTrade).map((v) => pick(d, `${v} NEAR`, 'an', v)),
      )
    case 'impact':
      return show(
        [bold('The most price impact its buy accepts?'), 'A new pool is often thin: above this, it doesn’t buy. Tap one or type it (at most 50%).'],
        [pick(d, '5%', 'imp', '5'), pick(d, '10%', 'imp', '10'), pick(d, '25%', 'imp', '25')],
      )
    case 'mode':
      return show(
        newPools(d)
          ? [
              bold('Notify only, or buy?'),
              'Notify only: you get a message for each new pool whose token passes the checks, and buy yourself.',
              'Buy automatically: NEARKITS buys each new token that passes the checks from your NEARKITS wallet without asking again, up to the number of tokens you choose next (you confirm that once more at the end).',
            ]
          : [
              bold('Notify only, or buy?'),
              'Notify only: you get a message the moment it trades, and buy yourself.',
              'Buy automatically: NEARKITS buys from your NEARKITS wallet without asking again (you confirm that once more at the end).',
            ],
        [pick(d, '🔔 Notify only (recommended)', 'mode', 'notify')],
        [pick(d, '⚡ Buy automatically', 'mode', 'execute')],
      )
    case 'aim':
      return show(
        [
          bold('What does the sniper watch?'),
          '🎯 One token: a contract you name, until a route trades it.',
          '🆕 New pools: new NEAR pools as Ref DCL and Ref v2 create them (Nearly launches, meme.cooking graduations, other new pools). Each is checked before you hear of it; pools made before the sniper are never reported.',
        ],
        [pick(d, '🎯 One token', 'aim', 'token')],
        [pick(d, '🆕 New pools', 'aim', 'new-pools')],
      )
    case 'sources': {
      const on = sourcesOf(d)
      return show(
        [
          bold('Which new pools?'),
          'Tap to tick one or more, then Continue.',
          'Nearly launches: the Ref DCL pool a Nearly launch creates (counted once Nearly says the launch is done).',
          'meme.cooking graduations: the Ref v2 pool a meme.cooking token gets when it graduates.',
          'Other new pools: any other new pool paired with NEAR on Ref DCL or Ref v2.',
        ],
        ...SNIPER_SOURCES.map((x) => [pick(d, `${on.includes(x) ? '✅' : '⬜'} ${SOURCE_BUTTON[x]}`, 'src', x)]),
        [pick(d, 'Continue »', 'src', 'ok')],
      )
    }
    case 'minPool':
      return show(
        [
          bold('The least NEAR a new pool must hold?'),
          'Read on its NEAR side when the pool is found with liquidity: a thinner pool is skipped. Tap one or type it (0 to 100,000).',
        ],
        [1, 5, 20].map((v) => pick(d, `${v} NEAR`, 'mp', v)),
      )
    case 'buys':
      return show(
        [
          bold('How many new tokens may it buy?'),
          `Each one once, ${num(d.amountNear ?? 0)} NEAR each; it completes after that many. Tap one or type a number from 1 to ${MAX_SNIPER_BUYS}. NEARKITS’ per-trade and daily limits still apply.`,
        ],
        [1, 3, 5].map((v) => pick(d, tokensText(v), 'buys', v)),
      )
    case 'every':
      return show(
        [bold('How often?')],
        DCA_INTERVALS_SEC.slice(0, 3).map((s) => pick(d, `Every ${EVERY_LABEL[s] ?? s}`, 'ev', s)),
        DCA_INTERVALS_SEC.slice(3).map((s) => pick(d, `Every ${EVERY_LABEL[s] ?? s}`, 'ev', s)),
      )
    case 'runs':
      return show(
        [bold('How many buys?'), 'It stops after that many. Tap one or type a number. An end date can be set on NEARKITS web.'],
        [pick(d, '10', 'runs', 10), pick(d, '30', 'runs', 30), pick(d, '100', 'runs', 100), pick(d, 'No limit', 'runs', 0)],
      )
  }
}

/** A positive decimal string of at most `decimals` places, normalized; null otherwise. */
function decimal(text: string, decimals: number): string | null {
  const t = text.trim().replace(/,/g, '.').replace(/\s/g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const p = tryParseUnits(t, decimals)
  return p.ok && p.value > 0n ? formatUnits(p.value, decimals) : null
}

function nearNumber(text: string): number | null {
  const s = decimal(text.replace(/near$/i, ''), NEAR_DECIMALS)
  return s === null ? null : Number(s)
}

function slippage(text: string): number | null {
  const v = Number(text.trim().replace(/%$/, '').replace(',', '.'))
  return Number.isFinite(v) && v > 0 && v <= AUTOMATION_MAX_SLIPPAGE && Math.round(v * 100) === v * 100 ? v : null
}

/** A typed duration: 12h, 3d, 2w (up to a year). */
function duration(text: string): number | null {
  const m = /^(\d{1,4})\s*(h|hours?|d|days?|w|weeks?)$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'h')[0]?.toLowerCase()
  const ms = n * (unit === 'h' ? HOUR : unit === 'd' ? 24 * HOUR : 7 * 24 * HOUR)
  return ms > 0 && ms <= 366 * 24 * HOUR ? ms : null
}

/** Applies one answer (typed or tapped) to the setup: the new setup, or why it can't be used. */
async function apply(ctx: BotCtx, d: Draft, step: Step, raw: string): Promise<Draft | string> {
  const text = raw.trim()
  switch (step) {
    case 'type':
      return ['limit-buy', 'limit-sell', 'take-profit', 'stop-loss', 'tpsl'].includes(text) ? { ...d, type: text as OrderChoice } : 'Choose an order type with the buttons'
    case 'wallet': {
      const w = await ctx.deps.custody?.store.ownedWallet(ctx.user.id, text)
      if (!w || w.status !== 'active' || w.network !== ctx.deps.config.network.id) return 'That isn’t one of your active NEARKITS wallets'
      return { ...d, walletId: w.id }
    }
    case 'amount': {
      if (!isSell(d.type)) {
        const v = decimal(text.replace(/^n/, '').replace(/near$/i, ''), NEAR_DECIMALS)
        if (v === null || Number(v) < MIN_AUTOMATION_NEAR) return `Send an amount of NEAR of at least ${MIN_AUTOMATION_NEAR}`
        return { ...d, amount: { kind: 'near', value: v } }
      }
      const pct = /^p?(\d{1,3})\s*%?$/.exec(text)
      if (pct && (text.startsWith('p') || text.endsWith('%'))) {
        const v = Number(pct[1])
        return v >= 1 && v <= 100 ? { ...d, amount: { kind: 'percent', value: v } } : 'A share is a whole percentage from 1 to 100'
      }
      const v = decimal(text, d.token?.decimals ?? 0)
      return v === null ? `Send how many ${d.token?.symbol ?? 'tokens'} to sell, or a share like 50%` : { ...d, amount: { kind: 'tokens', value: v } }
    }
    case 'price': {
      const v = decimal(text, NEAR_DECIMALS)
      return v === null ? 'Send a price in NEAR above 0, e.g. 0.0025' : { ...d, price: v }
    }
    case 'sl': {
      const v = decimal(text, NEAR_DECIMALS)
      if (v === null) return 'Send a price in NEAR above 0, e.g. 0.0018'
      const tp = tryParseUnits(d.price ?? '0', NEAR_DECIMALS)
      const sl = tryParseUnits(v, NEAR_DECIMALS)
      if (tp.ok && sl.ok && sl.value >= tp.value) return `The stop loss must be below the take profit (${d.price})`
      return { ...d, sl: v }
    }
    case 'slip': {
      const v = slippage(text)
      return v === null ? `Slippage is above 0 and at most ${AUTOMATION_MAX_SLIPPAGE}%, with at most two decimals` : { ...d, slip: v }
    }
    case 'expiry': {
      if (text === '0') return d.kind === 'limit' || d.kind === 'sniper' ? { ...d, ttl: 0 } : 'Choose a duration'
      const hours = /^\d{1,4}$/.test(text) ? Number(text) * HOUR : duration(text)
      return hours ? { ...d, ttl: hours } : 'Send a duration like 12h, 3d or 2w'
    }
    case 'target': {
      const t = text.toLowerCase()
      const err = accountIdError(t)
      return err ? `That isn’t a NEAR account ID: ${err}` : { ...d, target: t }
    }
    case 'side':
      return text === 'both' || text === 'buy' || text === 'sell' ? { ...d, side: text } : 'Choose with the buttons'
    case 'sizing': {
      const pct = /^p?(\d{1,3}(?:\.\d{1,2})?)\s*%?$/.exec(text)
      if (pct && (text.startsWith('p') || text.endsWith('%'))) {
        const v = Number(pct[1])
        return v > 0 && v <= 100 ? { ...d, sizing: { mode: 'percent', pct: v } } : 'A share above 0 and at most 100%'
      }
      const v = nearNumber(text.replace(/^n/, ''))
      return v === null ? 'Send a NEAR amount (e.g. 0.5) or a share (e.g. 10%)' : { ...d, sizing: { mode: 'fixed', amountNear: v } }
    }
    case 'maxTrade': {
      const v = nearNumber(text)
      return v === null || v < MIN_AUTOMATION_NEAR ? `Send a NEAR amount of at least ${MIN_AUTOMATION_NEAR}` : { ...d, maxTrade: v }
    }
    case 'maxExposure': {
      const v = nearNumber(text)
      return v === null || v < (d.maxTrade ?? 0) ? `At least one maximum trade (${num(d.maxTrade ?? 0)} NEAR)` : { ...d, maxExposure: v }
    }
    case 'amountNear': {
      const v = nearNumber(text)
      return v === null || v < MIN_AUTOMATION_NEAR ? `Send a NEAR amount of at least ${MIN_AUTOMATION_NEAR}` : { ...d, amountNear: v }
    }
    case 'impact': {
      const v = Number(text.replace(/%$/, '').replace(',', '.'))
      return Number.isFinite(v) && v > 0 && v <= 50 ? { ...d, impact: v } : 'A price impact above 0 and at most 50%'
    }
    case 'mode':
      return text === 'notify' || text === 'execute' ? { ...d, mode: text } : 'Choose with the buttons'
    case 'every': {
      const v = Number(text)
      return DCA_INTERVALS_SEC.includes(v) ? { ...d, every: v } : 'Choose how often with the buttons'
    }
    case 'runs': {
      if (/^(0|none|no limit)$/i.test(text)) return { ...d, runs: 0 }
      const v = Number(text)
      return Number.isInteger(v) && v >= 1 && v <= 10_000 ? { ...d, runs: v } : 'Send a whole number of buys from 1 to 10,000'
    }
    case 'token':
      return 'Send the token’s symbol or contract'
    case 'aim':
      return text === 'token' || text === 'new-pools' ? { ...d, aim: text } : 'Choose with the buttons'
    case 'sources': {
      if (text === 'ok')
        return sourcesOf(d).length ? { ...d, sources: sourcesOf(d), sourcesSet: true } : 'Tick at least one: Nearly launches, meme.cooking graduations or other new pools'
      if (!(SNIPER_SOURCES as readonly string[]).includes(text)) return 'Choose with the buttons'
      const x = text as SniperSource
      const ticked = sourcesOf(d)
      return { ...d, sources: ticked.includes(x) ? ticked.filter((y) => y !== x) : [...ticked, x] }
    }
    case 'minPool': {
      const t = text.replace(/near$/i, '').trim().replace(',', '.')
      const v = /^\d{1,6}(\.\d{1,6})?$/.test(t) ? Number(t) : Number.NaN
      return Number.isFinite(v) && v >= 0 && v <= 100_000 ? { ...d, minPool: v } : 'Send the least NEAR a new pool must hold, from 0 to 100,000'
    }
    case 'buys': {
      const v = Number(text)
      return Number.isInteger(v) && v >= 1 && v <= MAX_SNIPER_BUYS ? { ...d, buys: v } : `Send a whole number of tokens from 1 to ${MAX_SNIPER_BUYS}`
    }
  }
}

/** The token step: a symbol or contract, read from chain; several matches become buttons. */
async function chooseToken(ctx: BotCtx, d: Draft, text: string): Promise<void> {
  const extra = await ctx.deps.store.userTokens(ctx.user.id, ctx.deps.config.network.id)
  const match = await resolveToken(ctx.deps.near, text, extra)
  const retry = (why: string) => ctx.reply(`⚠️ ${esc(why)}\n\nSend another symbol or contract, or /cancel.`).then(() => undefined)
  if (match.kind === 'none')
    return retry(match.error ? friendlyError(match.error, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'automation token' }) : match.message)
  const refOf = (t: { id: string; contract?: string | null; symbol: string; decimals: number }): TokenRef => ({ id: t.contract ?? t.id, symbol: t.symbol, decimals: t.decimals })
  if (match.kind === 'many') {
    const cands = match.tokens
      .filter((t) => t.id !== NATIVE_TOKEN_ID && t.id !== ctx.deps.config.network.wrapContract)
      .slice(0, 6)
      .map(refOf)
    if (!cands.length) return retry('Trade a token against NEAR, not NEAR itself')
    const next = { ...d, cands }
    await save(ctx, next)
    await ctx.show(
      [soFar(d), '', 'Several tokens match. Check the contract and pick one:'].join('\n'),
      keyboard(...cands.map((t, i) => [pick(next, `${t.symbol} · ${shortAccount(t.id, 30)}`.slice(0, 60), 'tk', i)]), quitRow()),
    )
    return
  }
  if (match.token.id === NATIVE_TOKEN_ID || (match.token.contract ?? match.token.id) === ctx.deps.config.network.wrapContract)
    return retry('Trade a token against NEAR, not NEAR itself')
  await advance(ctx, { ...d, token: refOf(match.token), cands: undefined })
}

/** Text typed while a setup waits. */
async function onInput(ctx: BotCtx, text: string, data: Record<string, unknown>): Promise<void> {
  const d = data as unknown as Draft
  const step = nextStep(d)
  if (!step) return
  if (step === 'token') return chooseToken(ctx, d, text)
  if (step === 'type' || step === 'wallet' || step === 'side' || step === 'mode' || step === 'every' || step === 'aim' || step === 'sources') {
    await ctx.reply('Choose with the buttons above, or send /cancel.')
    return
  }
  const r = await apply(ctx, d, step, text.slice(0, 200))
  if (typeof r === 'string') return void (await ctx.reply(`⚠️ ${esc(r)}. Send it again, or /cancel.`))
  await advance(ctx, r)
}

/** A tapped answer: `n` binds it to this chat's current setup. */
async function onPick(ctx: BotCtx, arg: string): Promise<void> {
  const [n = '', field = '', ...rest] = arg.split(':')
  const value = rest.join(':')
  const d = await current(ctx, n)
  if (!d) return void (await ctx.answer('This setup has ended. Start again with /auto.', true))
  if (field === 'tk') {
    const t = d.cands?.[Number(value)]
    if (!t || nextStep(d) !== 'token') return ctx.answer('Pick a token from the latest list.', true)
    return advance(ctx, { ...d, token: t, cands: undefined })
  }
  const STEP_OF: Record<string, Step> = {
    type: 'type',
    w: 'wallet',
    amt: 'amount',
    slip: 'slip',
    exp: 'expiry',
    side: 'side',
    size: 'sizing',
    mt: 'maxTrade',
    mx: 'maxExposure',
    an: 'amountNear',
    imp: 'impact',
    mode: 'mode',
    ev: 'every',
    runs: 'runs',
    aim: 'aim',
    src: 'sources',
    mp: 'minPool',
    buys: 'buys',
  }
  const step = STEP_OF[field]
  // Only the step the setup is at now: an older button of this setup can't change an answer behind the review.
  if (!step || nextStep(d) !== step) return ctx.answer('That choice was already made. Continue below, or /cancel.', true)
  const r = await apply(ctx, d, step, value)
  if (typeof r === 'string') return ctx.answer(r, true)
  await advance(ctx, r)
}

// ─── the review, and Confirm ────────────────────────────────────────────────

type Previewed = { p: StrategyPreview } | { note: string } | { limited: true }

/**
 * A preview of one configuration: the quote, a reason it can't be quoted now (still allowed), no quote
 * because the user asked for too many (nothing can be confirmed until a fresh one), or a refusal (thrown).
 */
async function previewOf(ctx: BotCtx, svc: AutomationService, walletId: string, config: StrategyConfig): Promise<Previewed> {
  // Copy Trade and a new-pools sniper have nothing to quote (the service only validates them): no quote is spent on them.
  if (tokenOf(config) !== null && !quoteAllowed(ctx)) return { limited: true }
  try {
    return { p: await svc.preview(ctx.user.id, walletId, config) }
  } catch (e) {
    // The setup itself is refused (its fields, the wallet, the token, NEARKITS' limits): shown, nothing is offered.
    if (e instanceof AutomationError && (e.code !== 'state' || e.issues.length)) throw e
    // Valid, but nothing to quote right now (no balance yet; Copy Trade quotes only when the account trades, a new-pools sniper when a pool appears).
    if (e instanceof AutomationError) return { note: e.message }
    // No route or quote right now: the worker keeps looking.
    return { note: `No executable quote right now: ${friendlyError(e, { network: ctx.deps.config.network.id, log: ctx.deps.log, context: 'automation preview' })}` }
  }
}

function previewLines(ctx: BotCtx, config: StrategyConfig, r: Previewed): string[] {
  if ('limited' in r) return ['⏳ Too many quotes in a minute: tap Refresh in a moment for the live preview, then confirm.']
  if ('note' in r) return [`ℹ️ ${esc(r.note)}`]
  const p = r.p
  const token = tokenOf(config) as TokenRef
  const outDecimals = p.side === 'buy' ? token.decimals : NEAR_DECIMALS
  const outSymbol = p.side === 'buy' ? token.symbol : 'NEAR'
  const fee =
    p.feeRaw === null
      ? `none on ${ctx.deps.config.network.id}`
      : `${rawText(p.feeRaw, p.feeToken === token.id ? token.decimals : NEAR_DECIMALS)} ${p.feeToken === token.id ? token.symbol : 'NEAR'}`
  const net = /^\d+$/.test(p.networkFeeNear) ? nearText(BigInt(p.networkFeeNear)) : UNKNOWN
  const trigger =
    p.wouldTrigger === null
      ? []
      : p.wouldTrigger
        ? ['✅ Its condition holds at this quote: it would trade shortly after you confirm (after a second price reading).']
        : ['⏳ Not met at this quote: it waits for the price.']
  return [
    `Now ≈ ${bold(`${p.priceNear} NEAR`)} per ${esc(token.symbol)} (executable: fees, tax and price impact included)`,
    ...trigger,
    `At this quote: ${esc(p.amountIn)} ${p.side === 'buy' ? 'NEAR' : esc(token.symbol)} → ≈ ${esc(rawText(p.expectedOutRaw, outDecimals))} ${esc(outSymbol)} · minimum ${esc(rawText(p.minOutRaw, outDecimals))} ${esc(outSymbol)}`,
    `Price impact ${p.priceImpactPct === null ? UNKNOWN : `${p.priceImpactPct.toFixed(2)}%`} · NEARKITS fee ${esc(fee)} · network ≈ ${esc(net)} NEAR`,
  ]
}

/**
 * A new-pools sniper's review: nothing is quoted until a pool appears (the service says so), so it says
 * what the sniper watches and what every new pool must pass before it is reported or bought.
 */
function newPoolsLines(r: Previewed): string[] {
  return [
    `ℹ️ ${'note' in r ? esc(r.note) : 'Nothing to quote until a new pool appears.'} Each new pool is quoted from your NEARKITS wallet when it appears.`,
    '',
    bold('What it watches'),
    'New pools as Ref DCL and Ref v2 create them, read from the exchanges’ own pool lists; only pools paired with NEAR count. A pool counts once it holds at least your NEAR minimum (a Nearly launch once Nearly says the launch is done).',
    'Its token must then trade from your NEARKITS wallet within your price impact, and a round trip (buy, then sell straight back) may lose at most 25%: fees, a tax or a pool too thin to leave show there. A pool with no route yet is tried again for 5 minutes.',
    'Pools made before the sniper are never reported.',
  ]
}

async function review(ctx: BotCtx, d: Draft): Promise<void> {
  await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
  const s = await service(ctx)
  if (!s) return
  const { svc } = s
  const walletId = d.walletId as string
  const { config, pair } = configsOf(d, ctx.deps.now())
  const again = keyboard([btn('« Start over', `au:new:${d.kind}`), btn('🤖 Automations', 'au:l:all')])
  // The shared rules first (the service checks them again): a sniper the server would refuse isn't offered.
  if (config.kind === 'sniper') {
    const issues = validateSniper(config.sniper, ctx.deps.now())
    if (issues.length) return void (await ctx.show(refusal(new AutomationError('state', 'Check this sniper’s settings: nothing was created.', issues)) ?? '', again))
  }
  const previews = await attempt(ctx, async () => Promise.all([config, ...(pair ? [pair] : [])].map((c) => previewOf(ctx, svc, walletId, c))), again)
  if (!previews) return
  const wallet = await ctx.deps.custody?.store.ownedWallet(ctx.user.id, walletId)
  if (!wallet) return void (await ctx.show('That NEARKITS wallet is closed or not yours any more. Nothing was created.', again))
  const token = tokenOf(config)
  const lines: string[] = [
    `${KIND_ICON[d.kind]} ${bold(`Review · ${d.type === 'tpsl' ? `Take profit + stop loss ${token?.symbol ?? ''}` : titleOf(config)}`)}`,
    ...(token ? [code(token.id)] : []),
    `👛 From ${walletLine(wallet)}`,
    '',
  ]
  const cfgs = [config, ...(pair ? [pair] : [])]
  cfgs.forEach((c, i) => {
    if (pair) lines.push(bold(i === 0 ? 'Take profit' : 'Stop loss'))
    lines.push(ruleText(c))
    if (isNewPools(c)) lines.push(...newPoolsLines(previews[i] as Previewed))
    else if (c.kind !== 'copy') lines.push(...previewLines(ctx, c, previews[i] as Previewed))
    lines.push('')
  })
  if (pair) lines.push('🔗 The first of the two to trigger cancels the other.')
  lines.push(`Slippage ${slippageOf(config)}% once it trades: the minimum received is enforced on chain; the price isn’t guaranteed.`)
  if (d.kind === 'limit' || d.kind === 'sniper') lines.push(d.ttl ? `⌛ Expires in ${ttlText(d.ttl)}` : d.kind === 'limit' ? '⌛ Good till cancelled' : '⌛ No expiry')
  if (d.kind === 'dca') lines.push('The first buy is now, then on schedule. You get a message after each buy the chain confirms.')
  if (d.kind === 'copy')
    lines.push(
      'A copied buy runs once the followed account’s swap is final on chain; every one is checked against your limits first. Exclusions and a minimum liquidity can be set on NEARKITS web.',
    )
  if (d.kind === 'sniper')
    lines.push(
      d.mode === 'execute'
        ? '⚡ It buys automatically from your NEARKITS wallet: you confirm that once more next.'
        : newPools(d)
          ? '🔔 Notify only: you get a message for each new pool whose token passes the checks; nothing is bought.'
          : '🔔 Notify only: you get a message the moment it trades; nothing is bought.',
    )
  if (s.f.paused && s.f.pausedReason) lines.push('', `⏸ ${esc(s.f.pausedReason)}: it waits until that’s lifted.`)
  // Without a live preview there is nothing to confirm yet: only Refresh (and the stored setup says so too).
  const previewed = !previews.some((r) => 'limited' in r)
  const id = await ctx.deps.store.putCallback({ d, previewed } satisfies Reviewed, ctx.user.id, ctx.chat.id, REVIEW_TTL_MS)
  const label =
    d.kind === 'limit'
      ? pair
        ? '✅ Confirm both orders'
        : '✅ Confirm order'
      : d.kind === 'copy'
        ? '✅ Start copying'
        : d.kind === 'sniper'
          ? '✅ Confirm sniper'
          : '✅ Start DCA'
  await ctx.show(
    lines.join('\n').trim(),
    keyboard(
      previewed ? [btn(label, `au:ok:${id}`)] : [],
      [btn('🔄 Refresh', `au:rv:${id}`), btn('✖ Cancel', 'au:quit')],
      d.kind === 'copy' ? [urlBtn('🌐 More settings on NEARKITS web', `${ctx.deps.config.webUrl}${KIND_WEB.copy}`)] : [],
    ),
  )
}

/** A reviewed setup, behind its Confirm: previewed once its live preview was shown. */
interface Reviewed {
  d: Draft
  previewed: boolean
}

/** The reviewed setup behind a Confirm, for this user only, without using it up. */
async function peek(ctx: BotCtx, id: string): Promise<Reviewed | null> {
  const p = await ctx.deps.store.getCallback<Partial<Reviewed>>(id, ctx.user.id)
  return p?.d ? { d: p.d, previewed: p.previewed === true } : null
}

/** Uses a reviewed setup up, once: of two taps (or a replay) only the one that removes it gets it (takeCallback). */
async function take(ctx: BotCtx, id: string): Promise<Reviewed | null> {
  const p = await ctx.deps.store.takeCallback<Partial<Reviewed>>(id, ctx.user.id)
  return p?.d ? { d: p.d, previewed: p.previewed === true } : null
}

const USED = 'This confirmation was used already or has expired. Nothing new was created.'

/**
 * The server's key for creating a reviewed setup: one per review (its Confirm's id), the same for every
 * tap or replay of that Confirm, so the server makes its strategies once, whatever reaches it twice.
 */
export function requestKeyOf(reviewId: string): string {
  const key = `tg-${reviewId}`
  return REQUEST_KEY.test(key) ? key : `tg-${sha256Hex(reviewId).slice(0, 40)}`
}

async function confirm(ctx: BotCtx, id: string, execute: boolean): Promise<void> {
  const s = await service(ctx)
  if (!s) return
  const reviewed = await peek(ctx, id)
  if (!reviewed) return void (await ctx.show(`⚠️ ${USED}`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  // Nothing is created that wasn't previewed live first.
  if (!reviewed.previewed) return refreshReview(ctx, id)
  const seen = reviewed.d
  const buys = seen.kind === 'sniper' && seen.mode === 'execute'
  if (buys && !execute) {
    // A sniper that buys: one more explicit yes, on its own screen.
    const amount = seen.amountNear ?? 0
    const limits = `at most ${num(seen.impact ?? 0)}% price impact, ${seen.slip ?? DEFAULT_SLIPPAGE}% slippage`
    await ctx.show(
      [
        `⚡ ${bold('Buy automatically?')}`,
        newPools(seen)
          ? `NEARKITS buys ${bold(`${num(amount)} NEAR`)} of each new token that passes the checks, up to ${tokensText(seen.buys ?? 1)}, from your NEARKITS wallet without asking again (${limits}; at most ${num(amount * (seen.buys ?? 1))} NEAR in all).`
          : `Once ${esc(seen.token?.symbol ?? 'the token')} trades, NEARKITS buys with ${bold(`${num(amount)} NEAR`)} from your NEARKITS wallet without asking again (up to ${DEFAULT_SNIPER_ATTEMPTS} attempts, ${limits}).`,
        'New tokens are risky: a pool can be thin, taxed or pulled. Buy only what you can lose.',
      ].join('\n'),
      keyboard([btn('⚡ Yes, buy automatically', `au:okx:${id}`)], [btn('✖ Cancel', 'au:quit')]),
    )
    return
  }
  if (execute && !buys) return void (await ctx.show(`⚠️ ${USED}`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  const d = (await take(ctx, id))?.d
  if (!d) return void (await ctx.show(`⚠️ ${USED}`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  const { config, pair } = configsOf(d, ctx.deps.now())
  const startedAt = ctx.deps.now()
  const made = await attempt(
    ctx,
    async () => {
      try {
        // This review's key: if the same Confirm reaches the server again (a replay, two taps at once), it makes nothing new.
        return await s.svc.create(ctx.user.id, {
          walletId: d.walletId as string,
          config,
          ...(pair ? { pair } : {}),
          ...(buys && execute ? { confirmExecute: true } : {}),
          requestKey: requestKeyOf(id),
        })
      } catch (e) {
        // The key was used already (for this review, as of another moment): nothing new is made.
        if (e instanceof AutomationError && e.code === 'request') return 'used' as const
        throw e
      }
    },
    keyboard([btn('« Start over', `au:new:${d.kind}`), btn('🤖 Automations', 'au:l:all')]),
  )
  if (made === 'used') return void (await ctx.show(`⚠️ ${USED}`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  if (!made || !made.length) return
  const first = made[0] as StrategyView
  // The server answered with what this review's first Confirm made.
  const replayed = made.every((v) => v.createdAt < startedAt)
  const what = replayed
    ? 'Nothing new was made: this is what this review’s first Confirm created.'
    : d.kind === 'limit'
      ? made.length > 1
        ? 'Both orders are active. NEARKITS watches the executable price; the first to trigger cancels the other.'
        : 'It’s active. NEARKITS watches the executable price and trades when the condition holds.'
      : d.kind === 'copy'
        ? 'It’s active: swaps the account makes from now on are copied within your limits.'
        : d.kind === 'sniper'
          ? newPools(d)
            ? d.mode === 'execute'
              ? `It’s active: it buys each new token that passes the checks, up to ${tokensText(d.buys ?? 1)}.`
              : 'It’s active: you get a message for each new pool whose token passes the checks.'
            : d.mode === 'execute'
              ? 'It’s active and buys once the token trades.'
              : 'It’s active: you get a message once the token trades.'
          : 'It’s active: the first buy runs shortly.'
  await ctx.show(
    [
      `✅ ${bold(replayed ? 'Already created' : made.length > 1 ? 'Take profit + stop loss created' : `${titleOf(first.config)} created`)}`,
      what,
      'You get a message when it triggers and when the chain confirms a trade.',
      '',
      ...made.map((v, i) => listLine(v, i)),
    ].join('\n'),
    keyboard(...made.map((v, i) => [btn(`🔎 ${i + 1}. ${titleOf(v.config)}`.slice(0, 60), `au:v:${v.id}`)]), [
      btn(`« ${KIND_LABEL[d.kind]}`, `au:l:${d.kind}`),
      btn('🤖 All', 'au:l:all'),
    ]),
  )
}

/** Refresh on the review: the old Confirm is used up first, so only the new one can create it. */
async function refreshReview(ctx: BotCtx, id: string): Promise<void> {
  const d = (await take(ctx, id))?.d
  if (!d) return void (await ctx.show(`⚠️ ${USED}`, keyboard([btn('🤖 Automations', 'au:l:all')])))
  await review(ctx, d)
}

async function quit(ctx: BotCtx): Promise<void> {
  await ctx.deps.store.clearSession(ctx.chat.id, ctx.user.id)
  await ctx.show('Cancelled. Nothing was created.', keyboard([btn('🤖 Automations', 'au:l:all'), btn('« Menu', 'menu:home')]))
}

// ─── the module ─────────────────────────────────────────────────────────────

/** Not in Telegram's command menu (its order is pinned): listed in /help. */
const command = (name: string, run: (ctx: BotCtx) => Promise<void>) => ({ ...documented(name), menu: false as const, run })

export function automationModule(): BotModule {
  return {
    commands: {
      orders: command('orders', (ctx) => showList(ctx, 'limit')),
      copy: command('copy', (ctx) => showList(ctx, 'copy')),
      snipe: command('snipe', (ctx) => showList(ctx, 'sniper')),
      dca: command('dca', (ctx) => showList(ctx, 'dca')),
      auto: command('auto', (ctx) => showList(ctx, 'all')),
    },
    callbacks: {
      au: async (ctx, action, arg) => {
        switch (action) {
          case 's':
            return onPick(ctx, arg)
          case 'pax':
            return pauseAll(ctx)
        }
        await ctx.answer()
        switch (action) {
          case 'l':
            return showList(ctx, (KINDS as readonly string[]).includes(arg) ? (arg as StrategyKind) : 'all')
          case 'new':
            return (KINDS as readonly string[]).includes(arg) ? startNew(ctx, arg as StrategyKind) : showList(ctx, 'all')
          case 'v':
            return showDetail(ctx, arg)
          case 'p':
          case 'r':
          case 'xx':
          case 'xb':
            return act(ctx, action, arg)
          case 'x':
            return askCancel(ctx, arg)
          case 'pa':
            return askPauseAll(ctx)
          case 'ok':
            return confirm(ctx, arg, false)
          case 'okx':
            return confirm(ctx, arg, true)
          case 'rv':
            return refreshReview(ctx, arg)
          case 'quit':
            return quit(ctx)
          default:
            return showList(ctx, 'all')
        }
      },
    },
    flows: { [FLOW]: onInput },
  }
}
