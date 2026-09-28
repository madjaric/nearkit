import { NEAR_DECIMALS } from '@/config/networks'

/**
 * Exact on-chain amount math. Raw amounts are `bigint` (or decimal strings at a
 * boundary); a JavaScript `number` never carries a raw amount. Rules:
 * - parsing never rounds: extra decimals are an error, not a silent cut;
 * - formatting truncates toward zero, so a display never shows more than exists;
 * - splits hand out every raw unit, so totals are preserved exactly.
 */

export const U128_MAX = (1n << 128n) - 1n

/** Percentages carry up to 4 decimals: 100% = 1,000,000 units. */
export const PERCENT_DECIMALS = 4
export const PERCENT_SCALE = 100n * 10n ** BigInt(PERCENT_DECIMALS)

export type AmountErrorCode = 'empty' | 'format' | 'precision' | 'overflow' | 'decimals'

export class AmountError extends Error {
  readonly code: AmountErrorCode
  constructor(code: AmountErrorCode, message: string) {
    super(message)
    this.name = 'AmountError'
    this.code = code
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new AmountError('decimals', `Invalid token decimals: ${decimals}`)
}

/** ASCII digits with at most one decimal point. No sign, exponent or separators. */
const DECIMAL = /^([0-9]*)(?:\.([0-9]*))?$/

/** Human decimal string → raw integer units. Throws `AmountError` on anything ambiguous. */
export function parseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals)
  const s = text.trim()
  if (s === '') throw new AmountError('empty', 'Enter an amount')
  const match = DECIMAL.exec(s)
  const whole = match?.[1] ?? ''
  const frac = match?.[2] ?? ''
  if (!match || (whole === '' && frac === '')) throw new AmountError('format', 'Use digits and one decimal point, like 12.5')
  if (frac.length > decimals) {
    throw new AmountError('precision', decimals === 0 ? 'This token only supports whole numbers' : `This token supports at most ${decimals} decimals`)
  }
  const raw = BigInt(`${whole || '0'}${frac.padEnd(decimals, '0')}`)
  if (raw > U128_MAX) throw new AmountError('overflow', 'Amount is too large')
  return raw
}

export function tryParseUnits(text: string, decimals: number): { ok: true; value: bigint } | { ok: false; error: AmountError } {
  try {
    return { ok: true, value: parseUnits(text, decimals) }
  } catch (e) {
    if (e instanceof AmountError) return { ok: false, error: e }
    throw e
  }
}

export interface FormatUnitsOptions {
  /** Keep at most this many fraction digits, truncating toward zero. */
  maxFraction?: number
  /** Pad the fraction with zeros to at least this many digits. */
  minFraction?: number
  /** Group the whole part in thousands with commas (display only). */
  group?: boolean
}

/** Raw integer units → exact human decimal string. */
export function formatUnits(raw: bigint, decimals: number, opts: FormatUnitsOptions = {}): string {
  assertDecimals(decimals)
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : ''
  if (opts.maxFraction !== undefined && frac.length > opts.maxFraction) frac = frac.slice(0, Math.max(0, opts.maxFraction))
  frac = frac.replace(/0+$/, '')
  const minFraction = opts.minFraction ?? 0
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, '0')
  let wholeText = whole.toString()
  if (opts.group) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = frac ? `${wholeText}.${frac}` : wholeText
  const nonZero = whole > 0n || /[1-9]/.test(frac)
  return negative && nonZero ? `-${body}` : body
}

/**
 * A non-negative requirement (gas, deposits) shown with at most `maxFraction`
 * digits, rounded up so the display is never below what is actually needed.
 * Never use this for an amount that is sent.
 */
export function formatUnitsUp(raw: bigint, decimals: number, maxFraction: number, opts: Omit<FormatUnitsOptions, 'maxFraction'> = {}): string {
  assertDecimals(decimals)
  if (raw < 0n) throw new AmountError('format', 'A requirement cannot be negative')
  const drop = BigInt(Math.max(0, decimals - maxFraction))
  const unit = 10n ** drop
  return formatUnits(((raw + unit - 1n) / unit) * unit, decimals, { ...opts, maxFraction })
}

export const toYocto = (near: string): bigint => parseUnits(near, NEAR_DECIMALS)
export const fromYocto = (yocto: bigint, opts?: FormatUnitsOptions): string => formatUnits(yocto, NEAR_DECIMALS, opts)

/** floor(raw × bps / 10,000): a fee is never rounded up. */
export function mulBps(raw: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError(`Basis points must be an integer from 0 to 10000, got ${bps}`)
  if (raw < 0n) throw new RangeError('Amount must not be negative')
  return (raw * BigInt(bps)) / 10_000n
}

/** n parts that differ by at most one unit; the first (total mod n) parts get the extra unit. */
export function splitEqual(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('Split into at least one part')
  if (total < 0n) throw new RangeError('Total must not be negative')
  const count = BigInt(n)
  const base = total / count
  const extra = Number(total % count)
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1n : 0n))
}

/**
 * Split `total` in proportion to integer `weights` (largest-remainder method).
 * Each part is floor(total × w / Σw); the leftover units go one each to the parts
 * with the largest remainders, ties to the lower index. The sum always equals total.
 */
export function splitByWeights(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new RangeError('Total must not be negative')
  if (weights.length === 0) throw new RangeError('Give at least one weight')
  if (weights.some((w) => w < 0n)) throw new RangeError('Weights must not be negative')
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum === 0n) throw new RangeError('Weights must not all be zero')
  const parts = weights.map((w) => (total * w) / sum)
  let left = total - parts.reduce((a, b) => a + b, 0n)
  const order = weights.map((w, i) => ({ i, r: (total * w) % sum })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of order) {
    if (left === 0n) break
    parts[i] = (parts[i] ?? 0n) + 1n
    left -= 1n
  }
  return parts
}

/** Percentage text → units of PERCENT_SCALE (100% = 1,000,000). At most 4 decimals. */
export function parsePercent(text: string): bigint {
  try {
    return parseUnits(text, PERCENT_DECIMALS)
  } catch (e) {
    if (e instanceof AmountError && e.code === 'precision') throw new AmountError('precision', `Percentages take at most ${PERCENT_DECIMALS} decimals`)
    throw e
  }
}

/** floor(raw × numerator / denominator) for the 25/50/75/MAX keys; never more than the whole. */
export function fractionOf(raw: bigint, numerator: number, denominator: number): bigint {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0 || numerator < 0 || numerator > denominator)
    throw new RangeError('Fraction must be between 0 and 1')
  if (raw < 0n) throw new RangeError('Amount must not be negative')
  return (raw * BigInt(numerator)) / BigInt(denominator)
}

/** Thousands separators on an exact decimal string, for display only (never parsed back). */
export function groupDigits(text: string): string {
  const negative = text.startsWith('-')
  const body = negative ? text.slice(1) : text
  const [whole = '', frac] = body.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}
