/**
 * Number and text formatting. Every figure the UI prints goes through here so
 * signs, separators and precision stay identical from screen to screen.
 */

export const MINUS = '−'
const LOCALE = 'en-US'

const cache = new Map<string, Intl.NumberFormat>()
function nf(min: number, max: number, extra?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${min}:${max}:${extra ? JSON.stringify(extra) : ''}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max, ...extra })
    cache.set(key, f)
  }
  return f
}

function withSign(text: string, value: number, signed: boolean): string {
  if (value < 0) return `${MINUS}${text}`
  if (signed && value > 0) return `+${text}`
  return text
}

/** Plain grouped number, e.g. 1,208.40 */
export function formatNumber(value: number, minDecimals = 0, maxDecimals = 2): string {
  if (!Number.isFinite(value)) return '—'
  return withSign(nf(minDecimals, maxDecimals).format(Math.abs(value)), value, false)
}

const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉']
function subscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join('')
}

/**
 * Price with precision that follows magnitude:
 *  ≥ 1      → 2 decimals (2.84, 1,204.18)
 *  ≥ 0.01   → 4 decimals (0.0105)
 *  < 0.01   → 3 significant digits, zeros kept visible up to 6 (0.00000788)
 *  tiny     → zero run compressed with a subscript count (0.0₈123)
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs === 0) return '0.00'
  let text: string
  if (abs >= 1) text = nf(2, 2).format(abs)
  else if (abs >= 0.01) text = nf(4, 4).format(abs)
  else {
    let zeros = Math.ceil(-Math.log10(abs)) - 1 // zeros right after the decimal point
    let digits = Math.round(abs * 10 ** (zeros + 3)) // three significant digits
    if (digits >= 1000) {
      // 0.000009996 rounds up into the next decade: 0.0000100
      zeros -= 1
      digits = 100
    }
    const sig = String(digits)
    text = zeros > 6 ? `0.0${subscript(zeros)}${sig}` : `0.${'0'.repeat(zeros)}${sig}`
  }
  return withSign(text, value, false)
}

export function formatUsd(value: number, opts: { signed?: boolean; decimals?: number } = {}): string {
  if (!Number.isFinite(value)) return '—'
  const { signed = false, decimals = 2 } = opts
  const text = `$${nf(decimals, decimals).format(Math.abs(value))}`
  return withSign(text, value, signed)
}

export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const text = `$${formatPrice(Math.abs(value))}`
  return value < 0 ? `${MINUS}${text}` : text
}

const COMPACT_UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

export function formatCompact(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  for (const [size, unit] of COMPACT_UNITS) {
    if (abs >= size) return withSign(`${nf(0, decimals).format(abs / size)}${unit}`, value, false)
  }
  return withSign(nf(0, 2).format(abs), value, false)
}

export function formatUsdCompact(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—'
  const text = `$${formatCompact(Math.abs(value), decimals)}`
  return value < 0 ? `${MINUS}${text}` : text
}

/** How a chart or report writes money: USD, or NEAR where no USD value exists (testnet). */
export interface MoneyFormat {
  full(value: number, opts?: { signed?: boolean }): string
  compact(value: number, decimals?: number): string
}

export const USD_FORMAT: MoneyFormat = { full: (v, o) => formatUsd(v, o), compact: (v, d) => formatUsdCompact(v, d) }

export const NEAR_FORMAT: MoneyFormat = {
  full(value, opts = {}) {
    if (!Number.isFinite(value)) return '—'
    return withSign(`${nf(0, Math.abs(value) < 1 ? 5 : 3).format(Math.abs(value))} NEAR`, value, opts.signed ?? false)
  },
  compact(value, decimals = 1) {
    if (!Number.isFinite(value)) return '—'
    const text = `${formatCompact(Math.abs(value), decimals)} NEAR`
    return value < 0 ? `${MINUS}${text}` : text
  },
}

/**
 * Token amount: large balances drop decimals, small ones keep enough to be exact.
 * minDecimals keeps a steady column (e.g. NEAR always shows 2).
 */
export function formatAmount(value: number, minDecimals = 0): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  let text: string
  if (abs === 0) text = nf(minDecimals, minDecimals).format(0)
  else if (abs >= 100_000) text = nf(Math.min(minDecimals, 0), 0).format(abs)
  else if (abs >= 1) text = nf(minDecimals, Math.max(minDecimals, 2)).format(abs)
  else if (abs >= 0.0001) text = nf(Math.max(minDecimals, 2), 6).format(abs)
  else text = formatPrice(abs)
  return withSign(text, value, false)
}

export function formatPct(value: number, opts: { signed?: boolean; decimals?: number } = {}): string {
  if (!Number.isFinite(value)) return '—'
  const { signed = true, decimals = 2 } = opts
  return withSign(`${nf(decimals, decimals).format(Math.abs(value))}%`, value, signed)
}

/** Direction of a signed figure, for color and arrow choices. */
export function trend(value: number, epsilon = 1e-9): 'up' | 'down' | 'flat' {
  if (value > epsilon) return 'up'
  if (value < -epsilon) return 'down'
  return 'flat'
}

const IMPLICIT = /^[0-9a-f]{64}$/
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/

export function truncateMiddle(text: string, head = 6, tail = 4): string {
  if (text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/** Named accounts print in full up to a limit; implicit (hex) accounts are shortened. */
export function formatAccount(accountId: string, max = 26): string {
  if (IMPLICIT.test(accountId)) return truncateMiddle(accountId, 6, 4)
  if (ETH_IMPLICIT.test(accountId)) return truncateMiddle(accountId, 6, 4)
  if (accountId.length > max) return truncateMiddle(accountId, max - 10, 8)
  return accountId
}

// ─── time ───────────────────────────────────────────────────────────────────

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms)
  if (abs < MIN) return `${Math.max(1, Math.round(abs / 1000))}s`
  if (abs < HOUR) return `${Math.round(abs / MIN)}m`
  // Round the total first so a remainder never reads as "60m" or "24h".
  if (abs < DAY) {
    const minutes = Math.round(abs / MIN)
    if (minutes >= 24 * 60) return '1d'
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const hours = Math.round(abs / HOUR)
  const d = Math.floor(hours / 24)
  const h = hours % 24
  return h ? `${d}d ${h}h` : `${d}d`
}

export function formatAgo(at: number, now = Date.now()): string {
  const diff = now - at
  if (diff < 45_000) return 'just now'
  return `${formatDuration(diff)} ago`
}

export function formatUntil(at: number, now = Date.now()): string {
  const diff = at - now
  if (diff <= 0) return 'now'
  return `in ${formatDuration(diff)}`
}

// h23, not hour12: false: in en-US that one prints the hour after midnight as 24.
const dateTime = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateOnly = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' })
const dateYear = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' })

export function formatDateTime(at: number): string {
  return dateTime.format(at)
}
/** Time of day alone, for an axis whose whole window sits within a day. */
export function formatClock(at: number): string {
  return clock.format(at)
}
export function formatDate(at: number, withYear = false): string {
  return (withYear ? dateYear : dateOnly).format(at)
}

// ─── input parsing ──────────────────────────────────────────────────────────

/** Parse a user-typed amount. Accepts spaces/underscores as group separators, rejects anything else. */
export function parseAmount(input: string): number | null {
  const cleaned = input.trim().replace(/[\s_]/g, '')
  if (!cleaned) return null
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Round down to a number of decimals, so MAX never exceeds a balance. */
export function floorTo(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.floor(value * f + 1e-9) / f
}

/** Plain string for putting a number back into an input (no grouping). */
export function toInputString(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value) || value === 0) return value === 0 ? '0' : ''
  return String(Number(value.toFixed(maxDecimals)))
}
