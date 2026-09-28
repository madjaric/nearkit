import { accountIdError } from './validation'

export interface RecipientLine {
  line: number
  account: string
  pct: number | null
  error: string | null
}

export interface RecipientParse {
  lines: RecipientLine[]
  valid: RecipientLine[]
  /** True when every valid line carried a percentage. */
  withPercents: boolean
}

/**
 * Recipient list for Split imports: one account per line, optionally followed by
 * a percentage ("alice.near, 40" or "alice.near 40%"). Blank lines and # comments
 * are ignored. Duplicates are rejected so nobody is paid twice by accident.
 */
export function parseRecipients(text: string): RecipientParse {
  const lines: RecipientLine[] = []
  const seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const [account = '', pctText, ...rest] = trimmed.split(/\s*[,;\t]\s*|\s+/).filter(Boolean)
    let error = accountIdError(account)
    let pct: number | null = null
    if (!error && pctText !== undefined) {
      const cleaned = pctText.replace(/%$/, '')
      const value = /^\d*\.?\d+$/.test(cleaned) ? Number(cleaned) : Number.NaN
      if (!Number.isFinite(value) || value <= 0 || value > 100) error = 'Percentage must be between 0 and 100'
      else pct = value
    }
    if (!error && rest.length > 0) error = 'Unexpected text after the percentage'
    if (!error && seen.has(account)) error = 'Duplicate recipient'
    if (!error) seen.add(account)
    lines.push({ line: index + 1, account, pct, error })
  })
  const valid = lines.filter((l) => l.error === null)
  return { lines, valid, withPercents: valid.length > 0 && valid.every((l) => l.pct !== null) }
}
