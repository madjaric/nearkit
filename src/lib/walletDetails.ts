import type { WalletAccountDetail } from '@/types/domain'
import { implicitAccountOf, type ReportedKey } from './ownerAccount'

/**
 * What a wallet returned for its accounts, kept so the user can see it when it isn't the account
 * NearKit needs (Recover's "Connect <owner>"). Only plain fields (text, numbers, true/false) are
 * kept, cut short, and never a field whose name looks secret: a wallet shouldn't send a private key
 * or a token here, and if one does, NearKit neither shows nor keeps it. Nothing here decides
 * anything: the account NearKit uses is the account id itself, exactly (ownerAccount.ts).
 */

const MAX_ACCOUNTS = 20
const MAX_FIELDS = 12
const MAX_TEXT = 80
/** Field names never kept: anything that could hold a secret. */
const SECRET_NAME = /priv|secret|seed|mnemonic|phrase|pass|token|sign|auth|cookie|session|jwt|credential/i
/** Any other key but a public one is never kept either (`publicKey` is read on its own). */
const KEY_NAME = /key/i
const PUBLIC_NAME = /public/i

const cut = (text: string) => text.slice(0, MAX_TEXT)
const hidden = (name: string) => SECRET_NAME.test(name) || (KEY_NAME.test(name) && !PUBLIC_NAME.test(name))
const NONE: WalletAccountDetail = { accountId: null, publicKey: null, extra: [] }

function detail(entry: unknown): WalletAccountDetail {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return NONE
  const record = entry as Record<string, unknown>
  const extra: string[] = []
  for (const [name, value] of Object.entries(record)) {
    if (name === 'accountId' || name === 'publicKey' || hidden(name) || extra.length >= MAX_FIELDS) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') extra.push(`${cut(name)}=${cut(String(value))}`)
  }
  return {
    accountId: typeof record.accountId === 'string' ? cut(record.accountId) : null,
    publicKey: typeof record.publicKey === 'string' ? cut(record.publicKey) : null,
    extra,
  }
}

/**
 * The key each account says it signs with (NEAR Connect's `Account.publicKey`): an ed25519 key,
 * the first one per account, only for an entry that names its account. The owner check reads it on
 * chain; it is never trusted by itself.
 */
export function reportedKeys(list: readonly unknown[]): ReportedKey[] {
  const keys: ReportedKey[] = []
  for (const entry of list.slice(0, MAX_ACCOUNTS)) {
    try {
      if (typeof entry !== 'object' || entry === null) continue
      const { accountId, publicKey } = entry as Record<string, unknown>
      if (typeof accountId !== 'string' || typeof publicKey !== 'string' || implicitAccountOf(publicKey) === null) continue
      if (!keys.some((k) => k.accountId === accountId)) keys.push({ accountId, publicKey })
    } catch {
      // An object that can't even be read: no key from it.
    }
  }
  return keys
}

/** The wallet's account objects, as plain fields to show (at most 20). */
export function providerAccounts(list: readonly unknown[]): WalletAccountDetail[] {
  return list.slice(0, MAX_ACCOUNTS).map((entry) => {
    try {
      return detail(entry)
    } catch {
      // An object that can't even be read (a throwing getter): nothing to show for it.
      return NONE
    }
  })
}
