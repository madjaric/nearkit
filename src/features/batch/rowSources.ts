import { parseUnits } from '@/lib/amounts'
import { executesViaNearKit, signsInBrowser } from '@/lib/wallets'
import type { Wallet } from '@/types/domain'
import type { SendLine } from '../tools/nearkitSends'

/**
 * Batch Send, Manual: while the batch runs on NearKit wallets (Send from is one), each row may name
 * the NearKit wallet it sends from; NearKit's server sends every line from its own wallet, under the
 * same custody rule. A connected account signs the whole batch itself, so its rows always send from it.
 */

/**
 * Whether Manual rows each pick their NEARKITS wallet: `rows` while Send from is one of two or more
 * NEARKITS wallets; `switch` while Send from is a connected account and there are two or more NEARKITS
 * wallets the rows could use (the page says so: Send from decides); null otherwise.
 */
export function perRowSources(mode: 'paste' | 'manual', source: Pick<Wallet, 'source' | 'access'> | undefined, nearkit: readonly unknown[]): 'rows' | 'switch' | null {
  if (mode !== 'manual' || !source || nearkit.length < 2) return null
  if (executesViaNearKit(source)) return 'rows'
  return signsInBrowser(source) ? 'switch' : null
}

/** The wallet a row sends from: its own choice when the batch runs on NearKit wallets and the choice is one of them (never watch-only or frozen), else Send from. */
export function rowSource(choice: string | undefined, sendFromId: string, nearkit: readonly Pick<Wallet, 'id'>[]): string {
  const ids = nearkit.map((w) => w.id)
  return choice !== undefined && ids.includes(sendFromId) && ids.includes(choice) ? choice : sendFromId
}

/** What each source wallet sends in all, exactly (the batch fits only if every wallet holds its own share). */
export function totalsBySource(lines: readonly { source: string; amountText: string }[], decimals: number): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const l of lines) totals.set(l.source, (totals.get(l.source) ?? 0n) + parseUnits(l.amountText, decimals))
  return totals
}

/** The lines NearKit's server sends: each names its wallet only when the rows don't all send from Send from (otherwise exactly as before). */
export function nearkitLines(lines: readonly { to: string; amount: string; source: Wallet }[], sendFrom: Pick<Wallet, 'id'>): SendLine[] {
  const perRow = lines.some((l) => l.source.id !== sendFrom.id)
  return lines.map((l) =>
    perRow ? { to: l.to, amount: l.amount, from: { walletId: l.source.nearkitId ?? '', label: l.source.label, accountId: l.source.accountId } } : { to: l.to, amount: l.amount },
  )
}
