import type { BatchRow } from '@/lib/batch'
import { recipientAccount, type RecipientTarget } from '@/lib/recipientTarget'
import type { Wallet } from '@/types/domain'
import type { SendLine } from '../tools/nearkitSends'

/**
 * Batch Send: one source (Send from) and one token for the whole batch. A Manual row picks its
 * recipient the way Split does (one of the user's wallets, or an external account) and an amount.
 */
export type ManualRow = { id: number; amount: string } & RecipientTarget

/** Why the source wallet can't be one of its own batch's recipients (Split's rule). */
export const SELF_RECIPIENT = 'The source wallet cannot receive its own batch'

/** Manual rows as the batch list the parser reads: one `account,amount` line per row; an empty row is a comment, so line N stays row N. */
export function manualList(rows: readonly ManualRow[], wallets: readonly Pick<Wallet, 'id' | 'accountId'>[]): string {
  return rows
    .map((r) => {
      const account = recipientAccount(r, wallets)
      const amount = r.amount.trim()
      return account || amount ? `${account},${amount}` : '#'
    })
    .join('\n')
}

/** What NEARKITS' server sends: every line from Send from, the batch's one source (no line names a wallet of its own). */
export function batchLines(valid: readonly Pick<BatchRow, 'account' | 'amountText'>[]): SendLine[] {
  return valid.map((r) => ({ to: r.account, amount: r.amountText ?? '' }))
}
