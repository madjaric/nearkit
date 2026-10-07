import type { Wallet } from '@/types/domain'

/**
 * A recipient row's target in Split and Batch Send: one of the user's wallets, or an account typed in
 * after "External account…". One picker shows it in both (src/components/domain/RecipientSelect.tsx).
 */
export type RecipientTarget = { kind: 'wallet'; walletId: string } | { kind: 'account'; accountId: string }

/** The picker's value for "External account…". */
export const EXTERNAL_RECIPIENT = '__external__'

/** The picker's value for a target. */
export const choiceOf = (t: RecipientTarget): string => (t.kind === 'wallet' ? t.walletId : EXTERNAL_RECIPIENT)

/** The target a picked value stands for: a wallet, or (External account…) an account still to be typed. */
export const targetOf = (choice: string): RecipientTarget => (choice === EXTERNAL_RECIPIENT ? { kind: 'account', accountId: '' } : { kind: 'wallet', walletId: choice })

/** The account a row sends to: the wallet's own account, or the typed account (trimmed). */
export function recipientAccount(t: RecipientTarget, wallets: readonly Pick<Wallet, 'id' | 'accountId'>[]): string {
  return t.kind === 'wallet' ? (wallets.find((w) => w.id === t.walletId)?.accountId ?? '') : t.accountId.trim()
}

/** What a row's picker leaves out: the source wallet, and the wallets the other rows already send to (a row keeps its own). */
export function takenBy(sourceId: string, rows: readonly ({ id: string | number } & RecipientTarget)[], rowId: string | number): string[] {
  return [sourceId, ...rows.filter((o) => o.id !== rowId && o.kind === 'wallet').map((o) => (o.kind === 'wallet' ? o.walletId : ''))]
}

/** A new row's target (Add): the first wallet that is neither the source nor another row's; with none left, External account. */
export function nextTarget(sourceId: string, rows: readonly RecipientTarget[], wallets: readonly Pick<Wallet, 'id'>[]): RecipientTarget {
  const used = new Set(rows.flatMap((r) => (r.kind === 'wallet' ? [r.walletId] : [])))
  const next = wallets.find((w) => w.id !== sourceId && !used.has(w.id))
  return next ? { kind: 'wallet', walletId: next.id } : { kind: 'account', accountId: '' }
}
