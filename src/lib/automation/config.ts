import { CUSTODY_MAX_SLIPPAGE } from '@/lib/fees'
import { accountIdError } from '@/lib/validation'

/**
 * Trading automation: limit orders (with take profit and stop loss), Copy Trade, Sniper and DCA.
 * One shape for every surface: NEARKITS web and the Telegram bot build these configurations, the
 * server validates them again with these same rules before saving and again before every trade.
 *
 * Every automated trade runs from a NEARKITS wallet, through NEARKITS' own custody path (a fresh
 * quote bound to the wallet, an intent, the engine, the signer's own checks and fee, delivery
 * confirmed on chain). A browser wallet can't be signed for by NEARKITS: it is never automated.
 * Pairs are NEAR and a token, as every NEARKITS-wallet trade is.
 */

export type StrategyKind = 'limit' | 'copy' | 'sniper' | 'dca'

/**
 * A strategy's state. A limit order moves draft → active → triggered → executing → (submitted →)
 * filled, or ends cancelled, expired or failed. Copy Trade, Sniper and DCA stay active (or paused)
 * and end stopped, completed, expired or failed; their trades have their own states (ExecutionStatus).
 */
export type StrategyStatus = 'draft' | 'active' | 'paused' | 'triggered' | 'executing' | 'submitted' | 'filled' | 'completed' | 'cancelled' | 'stopped' | 'expired' | 'failed'

export const STRATEGY_STATUSES: readonly StrategyStatus[] = [
  'draft',
  'active',
  'paused',
  'triggered',
  'executing',
  'submitted',
  'filled',
  'completed',
  'cancelled',
  'stopped',
  'expired',
  'failed',
]
/** States a strategy never leaves. */
export const FINAL_STATUSES: readonly StrategyStatus[] = ['filled', 'completed', 'cancelled', 'stopped', 'expired', 'failed']
/** States in which the worker looks at a strategy. */
export const LIVE_STATUSES: readonly StrategyStatus[] = ['active', 'triggered', 'executing', 'submitted']

/** One automated trade. `confirmed` only once the engine saw the delivery on chain. */
export type ExecutionStatus = 'executing' | 'submitted' | 'confirmed' | 'failed' | 'cancelled'

export type LimitOrderType = 'limit-buy' | 'limit-sell' | 'take-profit' | 'stop-loss'

/**
 * What an order spends. A buy spends NEAR; a sell spends the token: an exact amount, or a share of
 * what the wallet holds when the order triggers (read from chain then).
 */
export type OrderAmount = { kind: 'near'; value: string } | { kind: 'tokens'; value: string } | { kind: 'percent'; value: number }

export interface TokenRef {
  id: string
  symbol: string
  decimals: number
}

export interface LimitConfig {
  type: LimitOrderType
  token: TokenRef
  amount: OrderAmount
  /** The trigger, in NEAR per whole token, as an exact decimal string. */
  triggerPriceNear: string
  slippagePct: number
  /** When the order expires unfilled (ms), or null: good until cancelled. */
  expiresAt: number | null
}

export interface CopyConfig {
  /** The NEAR account whose trades are copied. */
  target: string
  copy: 'buy' | 'sell' | 'both'
  /** A buy's size: a fixed amount, or a share of what the followed account spent. */
  sizing: { mode: 'fixed'; amountNear: number } | { mode: 'percent'; pct: number }
  maxTradeNear: number
  minTradeNear: number | null
  /** The most NEAR this rule may have in copied buys not yet sold back. */
  maxExposureNear: number
  slippagePct: number
  /** Skip tokens whose market liquidity (USD) is below this, or that has none known. Null: no check. */
  minLiquidityUsd: number | null
  /** Token contracts never copied. */
  exclude: string[]
}

export interface SniperSettings {
  /** The token contract to buy once it trades. */
  token: TokenRef
  amountNear: number
  slippagePct: number
  /** The most price impact accepted on the buy. */
  maxImpactPct: number
  minLiquidityUsd: number | null
  maxAttempts: number
  expiresAt: number | null
  /** Notify only, or buy. New snipers start in notify-only mode. */
  mode: 'notify' | 'execute'
}

export interface DcaConfig {
  token: TokenRef
  amountNear: number
  everySec: number
  startAt: number
  endAt: number | null
  slippagePct: number
  /** Stop after this many buys, or null. */
  maxRuns: number | null
}

export type StrategyConfig =
  { kind: 'limit'; limit: LimitConfig } | { kind: 'copy'; copy: CopyConfig } | { kind: 'sniper'; sniper: SniperSettings } | { kind: 'dca'; dca: DcaConfig }

export interface ConfigIssue {
  field: string
  message: string
}

/** Automated trades trade within the slippage NEARKITS wallets may use (inside the signer's 10% price floor). */
export const AUTOMATION_MAX_SLIPPAGE = CUSTODY_MAX_SLIPPAGE
/** Live strategies one user may have, per kind (worker and quote budgets stay bounded). */
export const MAX_LIVE_PER_USER: Record<StrategyKind, number> = { limit: 20, copy: 5, sniper: 5, dca: 5 }
export const DCA_INTERVALS_SEC: readonly number[] = [3_600, 4 * 3_600, 12 * 3_600, 86_400, 7 * 86_400]
export const MAX_SNIPER_ATTEMPTS = 10
export const MAX_COPY_EXCLUDES = 50
/** A trade below this isn't worth its fee and gas. */
export const MIN_AUTOMATION_NEAR = 0.05

const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,24})?$/
const positiveDecimal = (s: string) => DECIMAL.test(s) && /[1-9]/.test(s)
const finitePositive = (n: number) => typeof n === 'number' && Number.isFinite(n) && n > 0
const slippageOk = (n: number) => finitePositive(n) && n <= AUTOMATION_MAX_SLIPPAGE && Math.round(n * 100) === n * 100

export function tokenIssues(t: TokenRef, field: string): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!t || typeof t.id !== 'string' || accountIdError(t.id) || t.id === 'near') issues.push({ field: `${field}.id`, message: 'Choose a token contract' })
  if (!t || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 32) issues.push({ field: `${field}.decimals`, message: 'The token’s decimals are unknown' })
  if (!t || typeof t.symbol !== 'string' || !t.symbol.trim() || t.symbol.length > 40) issues.push({ field: `${field}.symbol`, message: 'The token’s symbol is unknown' })
  return issues
}

export const sideOf = (type: LimitOrderType): 'buy' | 'sell' => (type === 'limit-buy' ? 'buy' : 'sell')

export function validateLimit(c: LimitConfig, now: number): ConfigIssue[] {
  const issues = tokenIssues(c.token, 'token')
  if (!['limit-buy', 'limit-sell', 'take-profit', 'stop-loss'].includes(c.type)) issues.push({ field: 'type', message: 'Choose limit buy, limit sell, take profit or stop loss' })
  if (typeof c.triggerPriceNear !== 'string' || !positiveDecimal(c.triggerPriceNear)) issues.push({ field: 'triggerPriceNear', message: 'Enter a trigger price in NEAR above 0' })
  const side = sideOf(c.type)
  const a = c.amount
  if (!a || typeof a !== 'object') issues.push({ field: 'amount', message: 'Enter an amount' })
  else if (side === 'buy') {
    if (a.kind !== 'near' || !positiveDecimal(a.value)) issues.push({ field: 'amount', message: 'A buy spends an amount of NEAR above 0' })
    else if (Number(a.value) < MIN_AUTOMATION_NEAR) issues.push({ field: 'amount', message: `Spend at least ${MIN_AUTOMATION_NEAR} NEAR` })
  } else if (a.kind === 'tokens') {
    if (!positiveDecimal(a.value)) issues.push({ field: 'amount', message: 'Enter how many tokens to sell' })
  } else if (a.kind === 'percent') {
    if (!(Number.isInteger(a.value) && a.value >= 1 && a.value <= 100)) issues.push({ field: 'amount', message: 'Sell a whole percentage from 1 to 100' })
  } else issues.push({ field: 'amount', message: 'A sell spends tokens: an amount or a percentage of the balance' })
  if (!slippageOk(c.slippagePct)) issues.push({ field: 'slippagePct', message: `Slippage is above 0 and at most ${AUTOMATION_MAX_SLIPPAGE}%, with at most two decimals` })
  if (c.expiresAt !== null && !(Number.isSafeInteger(c.expiresAt) && c.expiresAt > now)) issues.push({ field: 'expiresAt', message: 'The expiry must be in the future' })
  return issues
}

export function validateCopy(c: CopyConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const err = typeof c.target === 'string' ? accountIdError(c.target) : 'missing'
  if (err) issues.push({ field: 'target', message: `The account to follow: ${err}` })
  if (!['buy', 'sell', 'both'].includes(c.copy)) issues.push({ field: 'copy', message: 'Copy buys, sells or both' })
  if (c.sizing?.mode === 'fixed') {
    if (!finitePositive(c.sizing.amountNear)) issues.push({ field: 'sizing', message: 'Enter a fixed size above 0' })
  } else if (c.sizing?.mode === 'percent') {
    if (!(finitePositive(c.sizing.pct) && c.sizing.pct <= 100)) issues.push({ field: 'sizing', message: 'A percentage from above 0 to 100' })
  } else issues.push({ field: 'sizing', message: 'Choose a fixed size or a percentage' })
  if (!finitePositive(c.maxTradeNear) || c.maxTradeNear < MIN_AUTOMATION_NEAR)
    issues.push({ field: 'maxTradeNear', message: `Set a maximum trade of at least ${MIN_AUTOMATION_NEAR} NEAR` })
  if (c.minTradeNear !== null && !(finitePositive(c.minTradeNear) && c.minTradeNear <= c.maxTradeNear))
    issues.push({ field: 'minTradeNear', message: 'The minimum trade is above 0 and not above the maximum' })
  if (!finitePositive(c.maxExposureNear) || c.maxExposureNear < c.maxTradeNear)
    issues.push({ field: 'maxExposureNear', message: 'The total exposure is at least one maximum trade' })
  if (!slippageOk(c.slippagePct)) issues.push({ field: 'slippagePct', message: `Slippage is above 0 and at most ${AUTOMATION_MAX_SLIPPAGE}%, with at most two decimals` })
  if (c.minLiquidityUsd !== null && !(typeof c.minLiquidityUsd === 'number' && Number.isFinite(c.minLiquidityUsd) && c.minLiquidityUsd >= 0))
    issues.push({ field: 'minLiquidityUsd', message: 'A minimum liquidity of 0 or more' })
  if (!Array.isArray(c.exclude) || c.exclude.length > MAX_COPY_EXCLUDES || c.exclude.some((t) => typeof t !== 'string' || accountIdError(t)))
    issues.push({ field: 'exclude', message: `Up to ${MAX_COPY_EXCLUDES} token contracts` })
  return issues
}

export function validateSniper(c: SniperSettings, now: number): ConfigIssue[] {
  const issues = tokenIssues(c.token, 'token')
  if (!finitePositive(c.amountNear) || c.amountNear < MIN_AUTOMATION_NEAR) issues.push({ field: 'amountNear', message: `Buy at least ${MIN_AUTOMATION_NEAR} NEAR` })
  if (!slippageOk(c.slippagePct)) issues.push({ field: 'slippagePct', message: `Slippage is above 0 and at most ${AUTOMATION_MAX_SLIPPAGE}%, with at most two decimals` })
  if (!(finitePositive(c.maxImpactPct) && c.maxImpactPct <= 50)) issues.push({ field: 'maxImpactPct', message: 'A maximum price impact above 0 and at most 50%' })
  if (c.minLiquidityUsd !== null && !(typeof c.minLiquidityUsd === 'number' && Number.isFinite(c.minLiquidityUsd) && c.minLiquidityUsd >= 0))
    issues.push({ field: 'minLiquidityUsd', message: 'A minimum liquidity of 0 or more' })
  if (!(Number.isInteger(c.maxAttempts) && c.maxAttempts >= 1 && c.maxAttempts <= MAX_SNIPER_ATTEMPTS))
    issues.push({ field: 'maxAttempts', message: `From 1 to ${MAX_SNIPER_ATTEMPTS} attempts` })
  if (c.expiresAt !== null && !(Number.isSafeInteger(c.expiresAt) && c.expiresAt > now)) issues.push({ field: 'expiresAt', message: 'The expiry must be in the future' })
  if (c.mode !== 'notify' && c.mode !== 'execute') issues.push({ field: 'mode', message: 'Notify only, or buy' })
  return issues
}

export function validateDca(c: DcaConfig, now: number): ConfigIssue[] {
  const issues = tokenIssues(c.token, 'token')
  if (!finitePositive(c.amountNear) || c.amountNear < MIN_AUTOMATION_NEAR) issues.push({ field: 'amountNear', message: `Buy at least ${MIN_AUTOMATION_NEAR} NEAR each time` })
  if (!DCA_INTERVALS_SEC.includes(c.everySec)) issues.push({ field: 'everySec', message: 'Every hour, 4 hours, 12 hours, day or week' })
  if (!Number.isSafeInteger(c.startAt) || c.startAt < now - 60_000) issues.push({ field: 'startAt', message: 'The start can’t be in the past' })
  if (c.endAt !== null && !(Number.isSafeInteger(c.endAt) && c.endAt > c.startAt)) issues.push({ field: 'endAt', message: 'The end must be after the start' })
  if (c.maxRuns !== null && !(Number.isInteger(c.maxRuns) && c.maxRuns >= 1 && c.maxRuns <= 10_000)) issues.push({ field: 'maxRuns', message: 'From 1 to 10,000 buys' })
  if (!slippageOk(c.slippagePct)) issues.push({ field: 'slippagePct', message: `Slippage is above 0 and at most ${AUTOMATION_MAX_SLIPPAGE}%, with at most two decimals` })
  return issues
}

export function validateStrategy(s: StrategyConfig, now: number): ConfigIssue[] {
  switch (s?.kind) {
    case 'limit':
      return validateLimit(s.limit, now)
    case 'copy':
      return validateCopy(s.copy)
    case 'sniper':
      return validateSniper(s.sniper, now)
    case 'dca':
      return validateDca(s.dca, now)
    default:
      return [{ field: 'kind', message: 'Unknown strategy' }]
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A configuration from the network (the web API, a stored row): exactly the fields of its kind, of
 * the right types, then validated. Never coerced: a field of the wrong type is an issue.
 */
export function parseStrategy(input: unknown, now: number): { ok: true; config: StrategyConfig } | { ok: false; issues: ConfigIssue[] } {
  if (!isObj(input) || typeof input.kind !== 'string') return { ok: false, issues: [{ field: 'kind', message: 'Unknown strategy' }] }
  const kind = input.kind as StrategyKind
  const body = input[kind]
  if (!isObj(body)) return { ok: false, issues: [{ field: kind, message: 'Missing configuration' }] }
  const token = (v: unknown): TokenRef | null =>
    isObj(v) && typeof v.id === 'string' && typeof v.symbol === 'string' && typeof v.decimals === 'number'
      ? { id: v.id.trim().toLowerCase(), symbol: v.symbol, decimals: v.decimals }
      : null
  const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN)
  const numOrNull = (v: unknown) => (v === null ? null : num(v))
  let config: StrategyConfig
  if (kind === 'limit') {
    const a = body.amount
    const amount: OrderAmount | null = isObj(a)
      ? a.kind === 'percent'
        ? { kind: 'percent', value: num(a.value) }
        : (a.kind === 'near' || a.kind === 'tokens') && typeof a.value === 'string'
          ? { kind: a.kind, value: a.value.trim() }
          : null
      : null
    const t = token(body.token)
    if (!t || !amount) return { ok: false, issues: [{ field: t ? 'amount' : 'token', message: t ? 'Enter an amount' : 'Choose a token' }] }
    config = {
      kind,
      limit: {
        type: body.type as LimitOrderType,
        token: t,
        amount,
        triggerPriceNear: typeof body.triggerPriceNear === 'string' ? body.triggerPriceNear.trim() : '',
        slippagePct: num(body.slippagePct),
        expiresAt: numOrNull(body.expiresAt),
      },
    }
  } else if (kind === 'copy') {
    const s = body.sizing
    const sizing =
      isObj(s) && s.mode === 'fixed'
        ? { mode: 'fixed' as const, amountNear: num(s.amountNear) }
        : isObj(s) && s.mode === 'percent'
          ? { mode: 'percent' as const, pct: num(s.pct) }
          : null
    if (!sizing) return { ok: false, issues: [{ field: 'sizing', message: 'Choose a fixed size or a percentage' }] }
    config = {
      kind,
      copy: {
        target: typeof body.target === 'string' ? body.target.trim().toLowerCase() : '',
        copy: body.copy as CopyConfig['copy'],
        sizing,
        maxTradeNear: num(body.maxTradeNear),
        minTradeNear: numOrNull(body.minTradeNear),
        maxExposureNear: num(body.maxExposureNear),
        slippagePct: num(body.slippagePct),
        minLiquidityUsd: numOrNull(body.minLiquidityUsd),
        exclude: Array.isArray(body.exclude) ? body.exclude.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : [],
      },
    }
  } else if (kind === 'sniper') {
    const t = token(body.token)
    if (!t) return { ok: false, issues: [{ field: 'token', message: 'Choose a token' }] }
    config = {
      kind,
      sniper: {
        token: t,
        amountNear: num(body.amountNear),
        slippagePct: num(body.slippagePct),
        maxImpactPct: num(body.maxImpactPct),
        minLiquidityUsd: numOrNull(body.minLiquidityUsd),
        maxAttempts: num(body.maxAttempts),
        expiresAt: numOrNull(body.expiresAt),
        mode: body.mode as SniperSettings['mode'],
      },
    }
  } else if (kind === 'dca') {
    const t = token(body.token)
    if (!t) return { ok: false, issues: [{ field: 'token', message: 'Choose a token' }] }
    config = {
      kind,
      dca: {
        token: t,
        amountNear: num(body.amountNear),
        everySec: num(body.everySec),
        startAt: num(body.startAt),
        endAt: numOrNull(body.endAt),
        slippagePct: num(body.slippagePct),
        maxRuns: numOrNull(body.maxRuns),
      },
    }
  } else return { ok: false, issues: [{ field: 'kind', message: 'Unknown strategy' }] }
  const issues = validateStrategy(config, now)
  return issues.length ? { ok: false, issues } : { ok: true, config }
}

/** The token a strategy trades, or null (Copy Trade follows an account, not a token). */
export function tokenOfStrategy(s: StrategyConfig): TokenRef | null {
  return s.kind === 'limit' ? s.limit.token : s.kind === 'sniper' ? s.sniper.token : s.kind === 'dca' ? s.dca.token : null
}
