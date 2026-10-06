/**
 * Splits caption text into runs of words and figures, so "5 wallets · 10.00
 * NEAR total" can set "5" and "10.00 NEAR" in the data face and leave the words
 * in the UI face.
 *
 * A figure is a number with everything bound to it: sign, ≈, $, thousands
 * separators, decimals, a K/M/B/T magnitude, %, and a ticker unit of three or
 * more capitals written right after it ("850 SHITZU"; "1 TP" stays a count and
 * a word). Durations ("24h", "2h 15m"), clock times ("11:59") and short dates
 * ("Sep 25", "Sep 25, 11:59") are figures too. Digits inside a word or an
 * account id ("w01", hex) are left alone.
 */
export interface Run {
  text: string
  figure: boolean
}

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'
const DATE = `${MONTH} \\d{1,2}(?:, \\d{4})?(?:,? \\d{1,2}:\\d{2})?`
const DURATION = '\\d+[smhd](?: \\d+[smh])?'
const DIGITS = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?'
const NUMBER = `(?:≈ ?)?[+−-]?\\$?${DIGITS}(?::\\d{2}|[KMBT]|%)?`
// NEARKITS is the brand, not a ticker: "11 NEARKITS-managed" is a count and a word.
const UNIT = '(?: (?!NEARKITS(?![A-Za-z0-9]))[A-Z][A-Z0-9]{2,15}(?![A-Za-z0-9]))?'
const FIGURE = new RegExp(`(?<![\\w.$])(?:${DATE}|${DURATION}|${NUMBER}${UNIT})(?!\\w)`, 'g')

export function splitFigures(text: string): Run[] {
  const runs: Run[] = []
  let last = 0
  for (const match of text.matchAll(FIGURE)) {
    const start = match.index
    if (start > last) runs.push({ text: text.slice(last, start), figure: false })
    runs.push({ text: match[0], figure: true })
    last = start + match[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last), figure: false })
  return runs
}
