import type { LedTone } from '@/components/ui/Indicators'
import { formatUnitsShown } from '@/lib/amounts'
import type { DetectionView, ExecutionView, StrategyView } from '@/lib/automation/api'
import type { TokenListing } from '@/types/domain'
import {
  AUTOMATION_MAX_SLIPPAGE,
  DCA_INTERVALS_SEC,
  FINAL_STATUSES,
  sideOf,
  validateCopy,
  validateDca,
  validateLimit,
  validateSniper,
  type ConfigIssue,
  type CopyConfig,
  type DcaConfig,
  type ExecutionStatus,
  type LimitConfig,
  type LimitOrderType,
  type SniperSettings,
  type StrategyKind,
  type StrategyStatus,
  type TokenRef,
} from '@/lib/automation/config'
import { formatNumber } from '@/lib/format'
import { LinkRequestError } from '@/services/telegramLink'

/**
 * NEARKITS web's side of trading automation, without React: what each state is called, which
 * controls a strategy has, and the forms' text turned into the shared configuration, checked with
 * the same validators the server runs (src/lib/automation/config.ts) so a field the web accepts is
 * one the server accepts too. The server checks everything again; its refusals land on the same fields.
 */

export const NEAR_DECIMALS = 24

// ─── states ─────────────────────────────────────────────────────────────────

export const STATUS_LAMP: Record<StrategyStatus, { tone: LedTone; label: string; hint: string }> = {
  draft: { tone: 'idle', label: 'Draft', hint: 'Saved, not running yet.' },
  active: { tone: 'on', label: 'Active', hint: 'NEARKITS checks it on its schedule, server-side, from your NEARKITS wallet.' },
  paused: { tone: 'warn', label: 'Paused', hint: 'Nothing is checked or traded until it is resumed.' },
  triggered: { tone: 'on', label: 'Triggered', hint: 'Its condition held: the trade is being prepared from a fresh quote.' },
  executing: { tone: 'warn', label: 'Executing', hint: 'Its trade is being sent from your NEARKITS wallet. Not confirmed yet.' },
  submitted: { tone: 'warn', label: 'Submitted', hint: 'Sent; NEARKITS waits for the chain to confirm the delivery. Not confirmed yet.' },
  filled: { tone: 'on', label: 'Filled', hint: 'Its trade was confirmed on chain.' },
  completed: { tone: 'idle', label: 'Completed', hint: 'It ran to its end.' },
  cancelled: { tone: 'off', label: 'Cancelled', hint: 'Cancelled: nothing new is sent.' },
  stopped: { tone: 'off', label: 'Stopped', hint: 'Stopped: nothing new is sent.' },
  expired: { tone: 'off', label: 'Expired', hint: 'It reached its expiry without trading.' },
  failed: { tone: 'neg', label: 'Failed', hint: 'It ended on an error; the reason is shown with it.' },
}

/** A trade is confirmed only once the server saw its delivery on chain; until then it is never shown as done. */
export const EXECUTION_LAMP: Record<ExecutionStatus, { tone: LedTone; label: string }> = {
  executing: { tone: 'warn', label: 'Executing' },
  submitted: { tone: 'warn', label: 'Submitted · not confirmed' },
  confirmed: { tone: 'on', label: 'Confirmed on chain' },
  failed: { tone: 'neg', label: 'Failed' },
  cancelled: { tone: 'off', label: 'Cancelled' },
}

export const DETECTION_LAMP: Record<DetectionView['status'], { tone: LedTone; label: string }> = {
  detected: { tone: 'idle', label: 'Detected' },
  eligible: { tone: 'on', label: 'Eligible' },
  skipped: { tone: 'off', label: 'Skipped' },
  executing: { tone: 'warn', label: 'Executing' },
  submitted: { tone: 'warn', label: 'Submitted · not confirmed' },
  confirmed: { tone: 'on', label: 'Copied · confirmed' },
  failed: { tone: 'neg', label: 'Failed' },
}

export type ListTab = 'active' | 'paused' | 'history'

/** Which tab a strategy is listed under: running (or settling a trade), paused, or ended. */
export function tabOf(status: StrategyStatus): ListTab {
  if (status === 'paused') return 'paused'
  return FINAL_STATUSES.includes(status) ? 'history' : 'active'
}

/**
 * The controls a strategy has now, as the server allows them: pause while it waits, resume when
 * paused, cancel (stop) until it ends. A trade under way (triggered, executing, submitted) is
 * followed to the end first: no control until it settles.
 */
export function controlsFor(status: StrategyStatus): { pause: boolean; resume: boolean; cancel: boolean } {
  return {
    pause: status === 'active' || status === 'draft',
    resume: status === 'paused',
    cancel: status === 'active' || status === 'draft' || status === 'paused',
  }
}

/** An order is cancelled; a Copy Trade, Sniper or DCA is stopped. */
export const endWord = (kind: StrategyKind) => (kind === 'limit' ? 'Cancel' : 'Stop')

export const KIND_LABEL: Record<StrategyKind, string> = { limit: 'Limit order', copy: 'Copy Trade', sniper: 'Sniper', dca: 'DCA' }

export const ORDER_TYPE_LABEL: Record<LimitOrderType, string> = { 'limit-buy': 'Limit buy', 'limit-sell': 'Limit sell', 'take-profit': 'Take profit', 'stop-loss': 'Stop loss' }

/** The trigger's direction on an executable price: a limit buy and a stop loss at or below, a limit sell and a take profit at or above. */
export const conditionOf = (type: LimitOrderType): '≤' | '≥' => (type === 'limit-buy' || type === 'stop-loss' ? '≤' : '≥')

export function intervalLabel(sec: number): string {
  if (sec % 604_800 === 0) return sec === 604_800 ? 'week' : `${sec / 604_800} weeks`
  if (sec % 86_400 === 0) return sec === 86_400 ? 'day' : `${sec / 86_400} days`
  if (sec % 3_600 === 0) return sec === 3_600 ? 'hour' : `${sec / 3_600} hours`
  return `${Math.round(sec / 60)} minutes`
}

/** One line for a strategy's list row, from its own configuration. */
export function describeStrategy(s: Pick<StrategyView, 'config'>): string {
  const c = s.config
  const n = (v: number) => formatNumber(v, 0, 4)
  switch (c.kind) {
    case 'limit': {
      const l = c.limit
      const amount =
        l.amount.kind === 'percent' ? `${l.amount.value}% of ${l.token.symbol}` : l.amount.kind === 'near' ? `${l.amount.value} NEAR` : `${l.amount.value} ${l.token.symbol}`
      return `${ORDER_TYPE_LABEL[l.type]} · ${amount} · ${conditionOf(l.type)} ${l.triggerPriceNear} NEAR`
    }
    case 'copy': {
      const k = c.copy
      const size = k.sizing.mode === 'fixed' ? `${n(k.sizing.amountNear)} NEAR each` : `${n(k.sizing.pct)}% of their size`
      return `Copies ${k.copy === 'both' ? 'buys and sells' : `${k.copy}s`} · ${size} · max ${n(k.maxTradeNear)} NEAR`
    }
    case 'sniper':
      return `${c.sniper.mode === 'execute' ? 'Buys' : 'Notify only:'} ${n(c.sniper.amountNear)} NEAR of ${c.sniper.token.symbol} · max impact ${n(c.sniper.maxImpactPct)}%`
    case 'dca':
      return `${n(c.dca.amountNear)} NEAR of ${c.dca.token.symbol} every ${intervalLabel(c.dca.everySec)}${c.dca.maxRuns ? ` · ${c.dca.maxRuns} buys` : ''}`
  }
}

// ─── refusals ───────────────────────────────────────────────────────────────

/** The first message for each field. */
export function issuesByField(issues: readonly ConfigIssue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of issues) if (!(i.field in out)) out[i.field] = i.message
  return out
}

/** A refusal as the server worded it, with the fields to fix when it named some. */
export function refusalOf(e: unknown): { message: string; issues: ConfigIssue[] } {
  if (e instanceof LinkRequestError) {
    const raw = e.detail?.issues
    const issues = Array.isArray(raw)
      ? raw.filter((i): i is ConfigIssue => typeof i === 'object' && i !== null && typeof (i as ConfigIssue).field === 'string' && typeof (i as ConfigIssue).message === 'string')
      : []
    return { message: e.message, issues }
  }
  return { message: e instanceof Error && e.message ? e.message : 'NEARKITS couldn’t answer. Try again in a moment.', issues: [] }
}

// ─── form text → configuration ─────────────────────────────────────────────

/** A typed decimal as the configuration writes it: "1." → "1", ".5" → "0.5", "007" → "7"; anything else unchanged (the validator says why). */
export function decimalText(text: string): string {
  let t = text.trim()
  if (t.startsWith('.')) t = `0${t}`
  if (t.endsWith('.')) t = t.slice(0, -1)
  const m = /^(\d+)(\.\d+)?$/.exec(t)
  if (!m) return t
  const whole = (m[1] as string).replace(/^0+(?=\d)/, '')
  return `${whole}${m[2] ?? ''}`
}

/** A number field: empty or unreadable is NaN, so the shared validator flags it. */
export function numberOf(text: string): number {
  const t = decimalText(text)
  return t === '' || !/^\d+(\.\d+)?$/.test(t) ? Number.NaN : Number(t)
}

/** An optional number field: empty is null (no limit). */
export const optionalNumberOf = (text: string): number | null => (text.trim() === '' ? null : numberOf(text))

export const EXPIRY_CHOICES = [
  { value: 'gtc', label: 'Good till cancelled', ms: null },
  { value: '1h', label: '1 hour', ms: 3_600_000 },
  { value: '24h', label: '24 hours', ms: 86_400_000 },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000 },
] as const
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['value']

export const expiresAtOf = (choice: ExpiryChoice, now: number): number | null => {
  const ms = EXPIRY_CHOICES.find((c) => c.value === choice)?.ms ?? null
  return ms === null ? null : now + ms
}

export type Built<T> = { config: T; issues: ConfigIssue[] }

const noToken = (token: TokenRef | null): ConfigIssue[] => (token ? [] : [{ field: 'token.id', message: 'Choose a token' }])
const placeholder: TokenRef = { id: '', symbol: '', decimals: 0 }

export interface LimitDraft {
  type: LimitOrderType
  token: TokenRef | null
  /** A sell spends an exact amount of the token, or a share of what the wallet holds when it triggers. */
  sellBy: 'tokens' | 'percent'
  amountText: string
  triggerText: string
  slippagePct: number
  expiry: ExpiryChoice
}

export function buildLimit(d: LimitDraft, now: number): Built<LimitConfig> {
  const side = sideOf(d.type)
  const amount: LimitConfig['amount'] =
    side === 'buy'
      ? { kind: 'near', value: decimalText(d.amountText) }
      : d.sellBy === 'percent'
        ? { kind: 'percent', value: numberOf(d.amountText) }
        : { kind: 'tokens', value: decimalText(d.amountText) }
  const config: LimitConfig = {
    type: d.type,
    token: d.token ?? placeholder,
    amount,
    triggerPriceNear: decimalText(d.triggerText),
    slippagePct: d.slippagePct,
    expiresAt: expiresAtOf(d.expiry, now),
  }
  const issues = d.token ? validateLimit(config, now) : [...noToken(null), ...validateLimit(config, now).filter((i) => !i.field.startsWith('token'))]
  return { config, issues }
}

/**
 * The stop loss that goes with a take profit (a pair: the first to trigger cancels the other): the
 * same token, amount, slippage and expiry, its own trigger. Its issues are named `pair.*`.
 */
export function buildStopLossPair(takeProfit: LimitConfig, stopText: string, now: number): Built<LimitConfig> {
  const config: LimitConfig = { ...takeProfit, type: 'stop-loss', triggerPriceNear: decimalText(stopText) }
  const issues = validateLimit(config, now)
    .filter((i) => i.field === 'triggerPriceNear')
    .map((i) => ({ field: 'pair.triggerPriceNear', message: i.message }))
  return { config, issues }
}

export interface CopyDraft {
  target: string
  copy: CopyConfig['copy']
  sizing: 'fixed' | 'percent'
  fixedText: string
  pctText: string
  maxTradeText: string
  minTradeText: string
  maxExposureText: string
  slippagePct: number
  minLiquidityText: string
  exclude: string[]
}

export function buildCopy(d: CopyDraft): Built<CopyConfig> {
  const config: CopyConfig = {
    target: d.target.trim().toLowerCase(),
    copy: d.copy,
    sizing: d.sizing === 'fixed' ? { mode: 'fixed', amountNear: numberOf(d.fixedText) } : { mode: 'percent', pct: numberOf(d.pctText) },
    maxTradeNear: numberOf(d.maxTradeText),
    minTradeNear: optionalNumberOf(d.minTradeText),
    maxExposureNear: numberOf(d.maxExposureText),
    slippagePct: d.slippagePct,
    minLiquidityUsd: optionalNumberOf(d.minLiquidityText),
    exclude: d.exclude.map((t) => t.trim().toLowerCase()).filter(Boolean),
  }
  return { config, issues: validateCopy(config) }
}

export interface SniperDraft {
  token: TokenRef | null
  amountText: string
  slippagePct: number
  maxImpactText: string
  minLiquidityText: string
  maxAttemptsText: string
  expiry: ExpiryChoice
  mode: SniperSettings['mode']
}

export function buildSniper(d: SniperDraft, now: number): Built<SniperSettings> {
  const config: SniperSettings = {
    token: d.token ?? placeholder,
    amountNear: numberOf(d.amountText),
    slippagePct: d.slippagePct,
    maxImpactPct: numberOf(d.maxImpactText),
    minLiquidityUsd: optionalNumberOf(d.minLiquidityText),
    maxAttempts: numberOf(d.maxAttemptsText),
    expiresAt: expiresAtOf(d.expiry, now),
    mode: d.mode,
  }
  const issues = validateSniper(config, now)
  return { config, issues: d.token ? issues : [...noToken(null), ...issues.filter((i) => !i.field.startsWith('token'))] }
}

export interface DcaDraft {
  token: TokenRef | null
  amountText: string
  everySec: number
  /** Empty: now. Otherwise a datetime-local value (the browser's time zone). */
  startText: string
  endBy: 'never' | 'runs' | 'date'
  maxRunsText: string
  endText: string
  slippagePct: number
}

/** A datetime-local value as ms, or NaN. */
export const localTimeOf = (text: string): number => (text ? new Date(text).getTime() : Number.NaN)

export function buildDca(d: DcaDraft, now: number): Built<DcaConfig> {
  const config: DcaConfig = {
    token: d.token ?? placeholder,
    amountNear: numberOf(d.amountText),
    everySec: d.everySec,
    startAt: d.startText ? localTimeOf(d.startText) : now,
    endAt: d.endBy === 'date' ? localTimeOf(d.endText) : null,
    slippagePct: d.slippagePct,
    maxRuns: d.endBy === 'runs' ? numberOf(d.maxRunsText) : null,
  }
  const issues = validateDca(config, now)
  return { config, issues: d.token ? issues : [...noToken(null), ...issues.filter((i) => !i.field.startsWith('token'))] }
}

/** Slippage choices within NEARKITS wallets' cap: an automated trade never asks for more. */
export const SLIPPAGE_CHOICES = [0.5, 1, 2, 3, 5].filter((v) => v <= AUTOMATION_MAX_SLIPPAGE)

/** A listed token as the configuration names it: its contract, symbol and decimals (the server checks them on chain). */
export const tokenRefOf = (t: Pick<TokenListing, 'contract' | 'symbol' | 'decimals'> | undefined): TokenRef | null =>
  t && t.contract ? { id: t.contract, symbol: t.symbol, decimals: t.decimals } : null

export const DCA_INTERVALS = DCA_INTERVALS_SEC.map((sec) => ({ value: String(sec), label: `Every ${intervalLabel(sec)}` }))

// ─── amounts ────────────────────────────────────────────────────────────────

/** A raw amount for display (grouped, at most 6 decimals; "< 0.000001" rather than 0 for dust); "—" when unknown. */
export function shownRaw(raw: string | null | undefined, decimals: number, maxFraction = 6): string {
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return '—'
  return formatUnitsShown(BigInt(raw), decimals, maxFraction)
}

/** What an execution spent and received, in words, from the chain's figures once confirmed (else the quote's, said so). */
export function executionAmounts(e: ExecutionView, token: TokenRef | null): { spent: string; received: string; quoted: boolean } {
  const symbol = token?.symbol ?? 'tokens'
  const decimals = token?.decimals ?? null
  const tok = (raw: string | null) => (decimals === null ? (raw ? `${raw} raw units` : '—') : `${shownRaw(raw, decimals)} ${symbol}`)
  const near = (raw: string | null) => `${shownRaw(raw, NEAR_DECIMALS)} NEAR`
  if (e.status === 'confirmed' && e.nearRaw !== null && e.tokenRaw !== null)
    return e.side === 'buy' ? { spent: near(e.nearRaw), received: tok(e.tokenRaw), quoted: false } : { spent: tok(e.tokenRaw), received: near(e.nearRaw), quoted: false }
  return e.side === 'buy'
    ? { spent: near(e.amountInRaw), received: `min ${tok(e.minOutRaw)}`, quoted: true }
    : { spent: tok(e.amountInRaw), received: `min ${near(e.minOutRaw)}`, quoted: true }
}
