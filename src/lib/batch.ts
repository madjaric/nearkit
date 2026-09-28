import { formatUnits, tryParseUnits } from './amounts'
import { accountIdError } from './validation'

/**
 * Client-side parser for batch transfer lists:
 *
 *   alice.near,100
 *   bob.near,250
 *
 * Separators: comma, semicolon, tab or spaces. Blank lines and lines starting
 * with # or // are ignored; a leading header row (account,amount) is skipped.
 * Duplicate recipients are flagged and skipped rather than sent twice.
 */

export type BatchRowStatus = 'ok' | 'invalid-account' | 'invalid-amount' | 'duplicate'

export interface BatchRow {
  line: number
  raw: string
  account: string
  /** Display value; never used for execution. */
  amount: number | null
  /** The amount exactly as written (underscores removed); this is what gets sent. */
  amountText: string | null
  status: BatchRowStatus
  message: string | null
}

export interface BatchParseResult {
  rows: BatchRow[]
  valid: BatchRow[]
  invalidCount: number
  duplicateCount: number
  /** Display total. */
  total: number
  /** Exact total in raw units, when the token's decimals were given. */
  totalRaw: bigint | null
  totalText: string | null
}

/** Header words, matched against the whole first column so `to.near,100` is never taken for a header. */
const HEADER_WORD = /^(account|recipient|address|wallet|to)s?$/i
const NUMBER_LIKE = /^[\d.,_]+$/
const SEPARATOR = /\s*[,;\t]\s*|\s+/

function parseLine(text: string): { account: string; amountText: string; extra: string[] } {
  const [account = '', amountText = '', ...extra] = text.split(SEPARATOR).filter((part) => part.length > 0)
  return { account, amountText, extra }
}

export function parseBatchList(text: string, options: { decimals?: number } = {}): BatchParseResult {
  const rows: BatchRow[] = []
  const seen = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  let headerChecked = false

  lines.forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return
    if (!headerChecked) {
      headerChecked = true
      const first = parseLine(trimmed)
      if (HEADER_WORD.test(first.account) && !NUMBER_LIKE.test(first.amountText)) return
    }

    const { account, amountText, extra } = parseLine(trimmed)
    let status: BatchRowStatus = 'ok'
    let message: string | null = null
    let amount: number | null = null
    let exact: string | null = null

    const accountError = accountIdError(account)
    if (accountError) {
      status = 'invalid-account'
      message = accountError
    }

    if (status === 'ok') {
      if (!amountText) {
        status = 'invalid-amount'
        message = 'Missing amount'
      } else if (extra.length > 0) {
        // "alice.near,1,000" is ambiguous for money: never guess.
        status = 'invalid-amount'
        message = extra.every((part) => /^\d{3}(\.\d+)?$/.test(part)) ? 'Remove thousands separators (write 1000)' : 'Unexpected text after the amount'
      } else {
        const cleaned = amountText.replace(/_/g, '')
        const value = /^\d*\.?\d+$/.test(cleaned) ? Number(cleaned) : Number.NaN
        if (!Number.isFinite(value)) {
          status = 'invalid-amount'
          message = 'Amount must be a plain number'
        } else if (value <= 0) {
          status = 'invalid-amount'
          message = 'Amount must be greater than 0'
        } else {
          // With the token's decimals known, an amount it cannot represent is refused, never rounded.
          const parsed = options.decimals === undefined ? null : tryParseUnits(cleaned, options.decimals)
          if (parsed && !parsed.ok) {
            status = 'invalid-amount'
            message = parsed.error.message
          } else {
            amount = value
            exact = cleaned
          }
        }
      }
    }

    if (status === 'ok') {
      const first = seen.get(account)
      if (first !== undefined) {
        status = 'duplicate'
        message = `Duplicate of line ${first}, skipped`
      } else {
        seen.set(account, line)
      }
    }

    rows.push({ line, raw: trimmed, account, amount, amountText: exact, status, message })
  })

  const valid = rows.filter((r) => r.status === 'ok')
  const decimals = options.decimals
  const totalRaw =
    decimals === undefined
      ? null
      : valid.reduce((s, r) => {
          const parsed = r.amountText === null ? null : tryParseUnits(r.amountText, decimals)
          return s + (parsed?.ok ? parsed.value : 0n)
        }, 0n)
  return {
    rows,
    valid,
    invalidCount: rows.filter((r) => r.status === 'invalid-account' || r.status === 'invalid-amount').length,
    duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
    total: valid.reduce((s, r) => s + (r.amount ?? 0), 0),
    totalRaw,
    totalText: totalRaw === null || decimals === undefined ? null : formatUnits(totalRaw, decimals),
  }
}

export const BATCH_EXAMPLE = ['alice.near,100', 'bob.near,250', 'charlie.near,500'].join('\n')

/** The example list with the network's account suffix, so it never suggests the other network's accounts. */
export const batchExample = (network: 'mainnet' | 'testnet' | null) => (network === 'testnet' ? BATCH_EXAMPLE.replaceAll('.near,', '.testnet,') : BATCH_EXAMPLE)
