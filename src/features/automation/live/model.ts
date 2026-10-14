import type { LedTone } from '@/components/ui/Indicators'
import { formatUnitsShown } from '@/lib/amounts'
import { REQUEST_KEY, type CreateStrategyInput, type DetectionView, type ExecutionView, type StrategyView } from '@/lib/automation/api'
import type { TokenListing } from '@/types/domain'
import {
  AUTOMATION_MAX_SLIPPAGE,
  DCA_INTERVALS_SEC,
  FINAL_STATUSES,
  SNIPER_SOURCES,
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
  type SniperSource,
  type SniperTarget,
  type StrategyKind,
  type StrategyStatus,
  type TokenRef,
} from '@/lib/automation/config'
import { formatNumber } from '@/lib/format'
import { newCreateKey } from '@/services/nearkitWeb'
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

/**
 * What a detection's status is called. `detected` is only "seen" (a token-for-token swap before its
 * legs, a new pool waiting for a route): never a trade or a fill. Confirmed only as the server says.
 */
export const DETECTION_LAMP: Record<DetectionView['status'], { tone: LedTone; label: string }> = {
  detected: { tone: 'idle', label: 'Seen' },
  eligible: { tone: 'on', label: 'Eligible' },
  skipped: { tone: 'off', label: 'Skipped' },
  executing: { tone: 'warn', label: 'Executing' },
  submitted: { tone: 'warn', label: 'Submitted · not confirmed' },
  confirmed: { tone: 'on', label: 'Copied · confirmed' },
  failed: { tone: 'neg', label: 'Failed' },
}

/** A detection's lamp for its kind: a sniper's confirmed detection is a buy, a Copy Trade's a copy. */
export function detectionLamp(status: DetectionView['status'], kind: StrategyKind): { tone: LedTone; label: string } {
  return status === 'confirmed' && kind === 'sniper' ? { tone: 'on', label: 'Bought · confirmed' } : DETECTION_LAMP[status]
}

/**
 * What a detection's key names. A sniper on new pools: `pool:dcl:<pool id>` (Ref DCL) or
 * `pool:ref:<index>` (Ref v2); on one token: `route:<token>`. Copy Trade: the followed account's
 * transaction hash, and for a token-for-token swap its two legs, `<hash>:sell` and `<hash>:buy`.
 */
export type DetectionSource =
  | { kind: 'pool'; exchange: 'Ref DCL' | 'Ref v2'; poolId: string }
  | { kind: 'leg'; side: 'buy' | 'sell'; txHash: string }
  | { kind: 'tx'; txHash: string }
  | { kind: 'route' }
  | { kind: 'other' }

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/

export function detectionSourceOf(sourceKey: string, kind: StrategyKind): DetectionSource {
  if (kind === 'sniper') {
    if (sourceKey.startsWith('pool:dcl:') && sourceKey.length > 9) return { kind: 'pool', exchange: 'Ref DCL', poolId: sourceKey.slice(9) }
    if (sourceKey.startsWith('pool:ref:') && sourceKey.length > 9) return { kind: 'pool', exchange: 'Ref v2', poolId: sourceKey.slice(9) }
    if (sourceKey.startsWith('route:')) return { kind: 'route' }
    return { kind: 'other' }
  }
  if (kind === 'copy') {
    const leg = /^(.+):(sell|buy)$/.exec(sourceKey)
    if (leg && TX_HASH.test(leg[1] as string)) return { kind: 'leg', side: leg[2] as 'buy' | 'sell', txHash: leg[1] as string }
    if (TX_HASH.test(sourceKey)) return { kind: 'tx', txHash: sourceKey }
  }
  return { kind: 'other' }
}

/** A detection row's title, when its key says more than its side: "New pool", "Copied sell leg". */
export function detectionTitle(source: DetectionSource): string | null {
  return source.kind === 'pool' ? 'New pool' : source.kind === 'leg' ? `Copied ${source.side} leg` : null
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

/** The other order of a take profit / stop loss pair, from a list of the user's orders. */
export function pairSibling(s: Pick<StrategyView, 'id' | 'ocoGroup'>, list: readonly StrategyView[] | undefined): StrategyView | null {
  if (!s.ocoGroup) return null
  return list?.find((x) => x.ocoGroup === s.ocoGroup && x.id !== s.id) ?? null
}

/**
 * What ending it asks first. Cancelling either order of a take profit / stop loss pair cancels the
 * other too (the server does both), unless the other is already trading: then that one is followed
 * to the end.
 */
export function endPrompt(s: Pick<StrategyView, 'kind' | 'ocoGroup'>): { title: string; description: string; confirm: string } {
  if (s.kind === 'limit' && s.ocoGroup)
    return {
      title: 'Cancel both orders of this pair?',
      description:
        'This take profit and stop loss end together: both orders of the pair are cancelled for good, and nothing is sent for either from now on. If the other order is already trading, it is followed to the end.',
      confirm: 'Cancel both orders',
    }
  return s.kind === 'limit'
    ? { title: 'Cancel this limit order?', description: 'It is cancelled for good: nothing is sent from now on. Create a new order to trade again.', confirm: 'Cancel' }
    : {
        title: `Stop this ${KIND_LABEL[s.kind].toLowerCase()}?`,
        description: 'It is stopped for good: nothing new is sent. A trade already sent is followed to the end and recorded.',
        confirm: 'Stop',
      }
}

const TRADING: readonly StrategyStatus[] = ['triggered', 'executing', 'submitted']

/**
 * What the toast says once the server answered a cancel (or stop): `after` is the server's answer,
 * `list` the user's orders read again since. A pair is "both cancelled" only when the list shows
 * the other order cancelled too; one that had ended on its own is said as it is.
 */
export function endedNote(asked: StrategyView, after: StrategyView, list: readonly StrategyView[] | undefined): { title: string; detail: string } {
  const target: StrategyStatus = asked.kind === 'limit' ? 'cancelled' : 'stopped'
  if (after.status !== target)
    return {
      title: asked.kind === 'limit' ? 'Not cancelled: it had ended already' : 'Not stopped: it had ended already',
      detail: `It is ${STATUS_LAMP[after.status].label.toLowerCase()}.`,
    }
  if (asked.kind !== 'limit') return { title: `${KIND_LABEL[asked.kind]} stopped`, detail: describeStrategy(asked) }
  const sibling = pairSibling(asked, list)
  if (sibling?.status === 'cancelled') return { title: 'Both orders of the pair are cancelled', detail: 'Nothing is sent for either from now on.' }
  if (sibling && TRADING.includes(sibling.status)) return { title: 'Order cancelled', detail: 'The other order of its pair is trading already: its result is followed to the end.' }
  return { title: 'Order cancelled', detail: describeStrategy(asked) }
}

/** Where a new-pools sniper's pools come from, as its checkboxes say. */
export const SNIPER_SOURCE_LABEL: Record<SniperSource, { label: string; hint: string }> = {
  nearly: { label: 'Nearly launches', hint: 'The Ref DCL pool a Nearly launch creates, once Nearly says the launch is done.' },
  'meme-cooking': { label: 'meme.cooking graduations', hint: 'The Ref v2 pool a meme.cooking token graduates to.' },
  other: { label: 'Other new pools', hint: 'Any other new Ref DCL or Ref v2 pool of a token against NEAR.' },
}

const SOURCE_SHORT: Record<SniperSource, string> = { nearly: 'Nearly launches', 'meme-cooking': 'meme.cooking', other: 'other new pools' }

/** "Nearly launches, meme.cooking and other new pools", in the sources' own order. */
export function sourcesText(sources: readonly SniperSource[]): string {
  const ordered = SNIPER_SOURCES.filter((x) => sources.includes(x))
  const named = ordered.filter((x) => x !== 'other').map((x) => SOURCE_SHORT[x])
  if (!ordered.includes('other')) return named.join(', ')
  return named.length ? `${named.join(', ')} and ${SOURCE_SHORT.other}` : SOURCE_SHORT.other
}

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
    case 'sniper': {
      const k = c.sniper
      if (k.target === 'new-pools') {
        const src = sourcesText(k.sources)
        const onlyOther = k.sources.length > 0 && k.sources.every((x) => x === 'other')
        const what =
          k.mode === 'execute' ? `Buys up to ${k.maxBuys} new token${k.maxBuys === 1 ? '' : 's'} from ${src}` : `Notify only: ${onlyOther ? src : `new pools from ${src}`}`
        return `${what} · pool ≥ ${k.minPoolNear === null ? '—' : n(k.minPoolNear)} NEAR · ${n(k.amountNear)} NEAR each`
      }
      return `${k.mode === 'execute' ? 'Buys' : 'Notify only:'} ${n(k.amountNear)} NEAR of ${k.token ? k.token.symbol : 'a token'} · max impact ${n(k.maxImpactPct)}%`
    }
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

/** The server refused a create whose request key it had seen with a different request (HTTP 409, code 'request'). */
export const REVIEW_AGAIN = 'This review was already used for a different request, so nothing was created from it. Review it again.'

/**
 * A create's refusal, and whether the review closes so the form is reviewed again (a new review, a
 * new request key): when the server named fields to fix, or refused the request key.
 */
export function createRefusalOf(e: unknown): { message: string; issues: ConfigIssue[]; reviewAgain: boolean } {
  if (e instanceof LinkRequestError && e.code === 'request') return { message: REVIEW_AGAIN, issues: [], reviewAgain: true }
  const r = refusalOf(e)
  return { ...r, reviewAgain: r.issues.length > 0 }
}

// ─── one create per review ──────────────────────────────────────────────────

/**
 * A create request's key (src/lib/automation/api.ts REQUEST_KEY): made once when a review opens and
 * sent with every Confirm of that review, so a retry or a second click makes nothing twice; the server
 * answers the same key with what the first request made. Editing and reviewing again makes a new one.
 * 16 random bytes, base64url (22 of A–Z, a–z, 0–9, _ and -), as a wallet Create's key.
 */
export const newRequestKey = (): string => newCreateKey()

export const validRequestKey = (key: string) => REQUEST_KEY.test(key)

/** What a review holds: exactly what Confirm sends (the configuration, the wallet) and its one request key. */
export interface Reviewed<T> {
  config: T
  walletId: string
  requestKey: string
}

export const reviewOf = <T>(config: T, walletId: string, requestKey: string = newRequestKey()): Reviewed<T> => ({ config, walletId, requestKey })

/**
 * Whether a create that failed this way may be sent again as it was: the server never answered (or
 * answered with its own error), so it may have made the strategies; the same request key makes the
 * server answer with them instead of making them twice. A refusal (4xx) is never resent.
 */
export const retryableCreate = (e: unknown): boolean => e instanceof LinkRequestError && (e.status === 0 || e.status >= 500)

/** Sends a create; a request with a key that failed retryably is sent once more, unchanged (the same key). */
export async function sendCreate<T>(send: (input: CreateStrategyInput) => Promise<T>, input: CreateStrategyInput, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  try {
    return await send(input)
  } catch (e) {
    if (!input.requestKey || !retryableCreate(e)) throw e
    await wait(1_500)
    return send(input)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  /** One token contract, or new pools as the exchanges create them. */
  target: SniperTarget
  /** 'token': the contract to buy once it trades. Ignored for new pools (each new pool names its token). */
  token: TokenRef | null
  /** New pools: where they come from. */
  sources: SniperSource[]
  /** New pools: the least NEAR a pool must hold. */
  minPoolText: string
  /** New pools in buy mode: how many different tokens it buys before it completes. */
  maxBuysText: string
  amountText: string
  slippagePct: number
  maxImpactText: string
  /** One token only (new pools have no market data yet). */
  minLiquidityText: string
  maxAttemptsText: string
  expiry: ExpiryChoice
  mode: SniperSettings['mode']
}

/** The new-pools sniper's starting NEAR minimum for a pool: enough to leave a trade room, small enough for a fresh launch. */
export const DEFAULT_MIN_POOL_NEAR = '5'

/**
 * One token: the token, no pool sources, no pool minimum, one buy (as the server requires). New
 * pools: no token, the sources, the pool's NEAR minimum, no market-liquidity check, and a number of
 * tokens to buy (one in notify-only mode, where nothing is bought).
 */
export function buildSniper(d: SniperDraft, now: number): Built<SniperSettings> {
  const pools = d.target === 'new-pools'
  const config: SniperSettings = {
    target: d.target,
    token: pools ? null : (d.token ?? placeholder),
    sources: pools ? SNIPER_SOURCES.filter((x) => d.sources.includes(x)) : [],
    minPoolNear: pools ? numberOf(d.minPoolText) : null,
    maxBuys: pools && d.mode === 'execute' ? numberOf(d.maxBuysText) : 1,
    amountNear: numberOf(d.amountText),
    slippagePct: d.slippagePct,
    maxImpactPct: numberOf(d.maxImpactText),
    minLiquidityUsd: pools ? null : optionalNumberOf(d.minLiquidityText),
    maxAttempts: numberOf(d.maxAttemptsText),
    expiresAt: expiresAtOf(d.expiry, now),
    mode: d.mode,
  }
  const issues = validateSniper(config, now)
  return { config, issues: pools || d.token ? issues : [...noToken(null), ...issues.filter((i) => !i.field.startsWith('token'))] }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The explicit yes a sniper that buys needs, in the words of what it will do. */
export function buyConfirmation(c: SniperSettings): string {
  return c.target === 'new-pools'
    ? `I confirm: buy ${c.amountNear} NEAR of each new token that passes these checks, up to ${plural(c.maxBuys, 'token')}, from my NEARKITS wallet without asking me again.`
    : `I confirm: buy ${c.amountNear} NEAR of ${c.token ? c.token.symbol : 'this token'} from my NEARKITS wallet when it trades within these limits, without asking me again.`
}

/** A sniper's review summary: what it does, and the limits it keeps. */
export function sniperSummary(c: SniperSettings): string {
  const what = describeStrategy({ config: { kind: 'sniper', sniper: c } })
  if (c.target === 'token') return `${what}. Up to ${c.maxAttempts} attempts; slippage ${c.slippagePct}%.`
  const buys = c.mode === 'execute' ? ` It stops after ${plural(c.maxAttempts, 'buy')} that weren’t made.` : ''
  return `${what}. Price impact at most ${c.maxImpactPct}%; a round trip loses at most 25%; slippage ${c.slippagePct}%.${buys}`
}

/** What the toast says once a sniper is created. */
export function sniperCreatedNote(c: SniperSettings): { title: string; detail: string } {
  const execute = c.mode === 'execute'
  if (c.target === 'new-pools')
    return execute
      ? { title: 'Sniper armed to buy new pools', detail: `It buys up to ${plural(c.maxBuys, 'new token')}, ${c.amountNear} NEAR each, when their pools pass its checks.` }
      : { title: 'Sniper watching new pools (notify only)', detail: 'It buys nothing: it tells you about each new pool that passes its checks.' }
  return execute
    ? { title: 'Sniper armed to buy', detail: 'It buys once when the token trades within your limits.' }
    : { title: 'Sniper watching (notify only)', detail: 'It buys nothing: it tells you when the token trades.' }
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
