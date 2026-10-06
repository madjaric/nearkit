import type { BotConfig, BotStrategy, SizingMode } from '@/lib/volumeBot/types'

/**
 * The setup form's numeric fields: where each lives in the configuration, and how it is entered.
 * A field is entered in its display unit and stored as `display × factor` (a % kept in bps has
 * factor 100; minutes kept in seconds, 60), whole when the configuration needs it.
 */
export interface NumField {
  path: string
  label: string
  unit?: string
  factor?: number
  integer?: boolean
  /** Blank means "no limit" (stored as null). */
  optional?: boolean
  hint?: string
}

type Num = number | null

function at(config: BotConfig, path: string): Num {
  let v: unknown = config
  for (const k of path.split('.')) v = (v as Record<string, unknown>)[k]
  return v === null ? null : (v as number)
}

function put(config: BotConfig, path: string, value: Num): BotConfig {
  const [group, key] = path.split('.') as [keyof BotConfig, string]
  return { ...config, [group]: { ...(config[group] as object), [key]: value } }
}

/** What a field shows for a stored value: trimmed to what the stored precision means. */
export function displayOf(config: BotConfig, f: NumField): string {
  const v = at(config, f.path)
  if (v === null || !Number.isFinite(v)) return ''
  const shown = v / (f.factor ?? 1)
  return String(Number(shown.toPrecision(12)))
}

/** The configuration with every field's text applied. Unreadable text stays NaN, so validation names the field. */
export function applyText(config: BotConfig, fields: readonly NumField[], text: Readonly<Record<string, string>>): BotConfig {
  let out = config
  for (const f of fields) {
    const raw = (text[f.path] ?? '').trim()
    if (raw === '' && f.optional) {
      out = put(out, f.path, null)
      continue
    }
    const n = raw === '' ? Number.NaN : Number(raw) * (f.factor ?? 1)
    out = put(out, f.path, f.integer && Number.isFinite(n) ? Math.round(n) : n)
  }
  return out
}

export const SIZING_LABEL: Record<SizingMode, string> = {
  auto: 'Even slices',
  fixed: 'Fixed',
  range: 'Range',
  'capital-pct': '% of wallet',
  'inventory-pct': '% of inventory',
}

/** The sizing modes that mean something for a strategy. */
export function sizingModes(strategy: BotStrategy): SizingMode[] {
  if (strategy === 'market-maker') return ['fixed', 'range', 'capital-pct', 'inventory-pct']
  if (strategy === 'accumulate') return ['auto', 'fixed', 'range', 'capital-pct']
  return ['auto', 'fixed', 'range', 'inventory-pct']
}

export function strategyFields(strategy: BotStrategy, symbol: string): NumField[] {
  if (strategy === 'market-maker')
    return [
      { path: 'marketMaker.minEdgeBps', label: 'Edge over fair value', unit: '%', factor: 100, integer: true, hint: 'After every fee and the trade’s own price impact' },
      { path: 'marketMaker.skew', label: 'Inventory skew', unit: '0–1', hint: 'How hard it leans back toward the target' },
      { path: 'marketMaker.fairValueWindowSec', label: 'Fair value window', unit: 'min', factor: 60, hint: 'An average of the price over about this long' },
      { path: 'inventory.targetTokenPct', label: 'Target in token', unit: '%' },
      { path: 'inventory.minTokenPct', label: 'Least in token', unit: '%' },
      { path: 'inventory.maxTokenPct', label: 'Most in token', unit: '%' },
      { path: 'inventory.maxNearDeployed', label: 'Most NEAR in the token', unit: 'NEAR', hint: 'Its exposure cap: buys stop there' },
    ]
  const total: NumField =
    strategy === 'accumulate'
      ? { path: 'twap.totalNear', label: 'Budget', unit: 'NEAR', hint: 'NEAR to spend in all' }
      : { path: 'twap.totalTokens', label: 'Amount to sell', unit: symbol || 'tokens', hint: 'Tokens to sell in all' }
  return [
    total,
    { path: 'twap.durationSec', label: 'Over', unit: 'h', factor: 3600, hint: 'From 10 minutes to 30 days' },
    {
      path: 'twap.limitPriceNear',
      label: strategy === 'accumulate' ? 'Price cap' : 'Price floor',
      unit: 'NEAR',
      optional: true,
      hint: strategy === 'accumulate' ? 'Never buys above this price per token; blank: no cap' : 'Never sells below this price per token; blank: no floor',
    },
  ]
}

export function sizingFields(config: BotConfig): NumField[] {
  const mode = config.sizing.mode
  const out: NumField[] = []
  if (mode === 'fixed' || (mode === 'auto' && config.strategy === 'market-maker')) out.push({ path: 'sizing.fixedNear', label: 'Per trade', unit: 'NEAR' })
  if (mode === 'range')
    out.push(
      { path: 'sizing.minNear', label: 'Smallest trade', unit: 'NEAR' },
      { path: 'sizing.maxNear', label: 'Largest trade', unit: 'NEAR', hint: 'Each trade’s size is drawn between the two' },
    )
  if (mode === 'capital-pct') out.push({ path: 'sizing.pct', label: 'Of the wallet’s NEAR', unit: '%' })
  if (mode === 'inventory-pct') out.push({ path: 'sizing.pct', label: 'Of the token inventory', unit: '%' })
  out.push({ path: 'sizing.maxLiquidityPct', label: 'Most of pool liquidity', unit: '%', hint: 'Per trade; 0 turns the cap off' })
  return out
}

export const SCHEDULE_FIELDS: NumField[] = [
  { path: 'schedule.minIntervalSec', label: 'Check at least every', unit: 's', integer: true },
  { path: 'schedule.maxIntervalSec', label: 'At most every', unit: 's', integer: true, hint: 'Each wait is drawn between the two' },
  { path: 'schedule.cooldownSec', label: 'Cooldown after a trade', unit: 's', integer: true },
  { path: 'schedule.maxConcurrent', label: 'Trades in flight at once', integer: true, hint: 'Each from a different wallet' },
  { path: 'schedule.maxTrades', label: 'Stop after', unit: 'trades', integer: true, optional: true, hint: 'Blank: no limit' },
  { path: 'schedule.maxRuntimeSec', label: 'Stop after running', unit: 'h', factor: 3600, optional: true, hint: 'Blank: no limit' },
]

export const RISK_FIELDS: NumField[] = [
  { path: 'risk.maxTradeNear', label: 'Largest trade', unit: 'NEAR' },
  { path: 'risk.maxDailyLossNear', label: 'Daily loss limit', unit: 'NEAR', hint: 'Pauses when the day’s PnL (UTC) falls below minus this' },
  { path: 'risk.maxDrawdownPct', label: 'Drawdown limit', unit: '%', hint: 'Pauses when value falls this far below its peak' },
  { path: 'risk.maxSlippageBps', label: 'Max slippage', unit: '%', factor: 100, integer: true },
  { path: 'risk.maxPriceImpactBps', label: 'Max price impact', unit: '%', factor: 100, integer: true },
  { path: 'risk.maxSpreadBps', label: 'Max spread', unit: '%', factor: 100, integer: true, hint: 'Waits while buying and selling back would cost more' },
  { path: 'risk.minLiquidityUsd', label: 'Least pool liquidity', unit: 'USD', hint: 'Pauses below it' },
  { path: 'risk.gasReserveNear', label: 'Gas kept per wallet', unit: 'NEAR' },
  { path: 'risk.maxWalletExposurePct', label: 'Most of a wallet in token', unit: '%' },
  { path: 'risk.maxAggregateExposurePct', label: 'Most of all wallets in token', unit: '%' },
]

export const GUARDIAN_FIELDS: NumField[] = [
  { path: 'risk.maxPriceMovePct', label: 'Abnormal price move', unit: '%', hint: 'Away from fair value, or within a few minutes' },
  { path: 'risk.maxConsecutiveFailures', label: 'Failures in a row', integer: true },
  { path: 'risk.maxDataAgeSec', label: 'Market data stale after', unit: 's', integer: true },
  { path: 'risk.maxQuoteAgeSec', label: 'Quote stale after', unit: 's', integer: true },
  { path: 'risk.txTimeoutSec', label: 'Trade timeout', unit: 's', integer: true },
]

/** Every numeric field the form shows for this configuration. */
export function fieldsFor(config: BotConfig): NumField[] {
  return [...strategyFields(config.strategy, config.tokenSymbol), ...sizingFields(config), ...SCHEDULE_FIELDS, ...RISK_FIELDS, ...GUARDIAN_FIELDS]
}

/** The text of every field, for a configuration. */
export function textOf(config: BotConfig): Record<string, string> {
  const all = [
    ...strategyFields('market-maker', ''),
    ...strategyFields('accumulate', ''),
    ...strategyFields('distribute', ''),
    ...SCHEDULE_FIELDS,
    ...RISK_FIELDS,
    ...GUARDIAN_FIELDS,
  ]
  const sizing: NumField[] = ['fixedNear', 'minNear', 'maxNear', 'pct', 'maxLiquidityPct'].map((k) => ({ path: `sizing.${k}`, label: k }))
  const out: Record<string, string> = {}
  for (const f of [...all, ...sizing]) out[f.path] = displayOf(config, f)
  return out
}
