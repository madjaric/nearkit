import { checkOwnerAccount, type OwnerAccountMismatch } from '@/lib/ownerAccount'
import type { Session } from '@/types/domain'
import { NoNearAccountError } from './near/errors'
import type { WalletService } from './types'

/** On a mismatch, `session` is what the wallet connected with (null when it shared no NEAR account), for what it returned. */
export type OwnerReconnect = { ok: true; session: Session } | { ok: false; mismatch: OwnerAccountMismatch; session: Session | null }

/**
 * Connect a wallet that must end on `owner` (Recover's "Connect <owner>"). The current session
 * is signed out first: a wallet that still holds one answers a new connect with the same
 * account and never shows its account picker. The owner is asked for by name: when the wallet
 * shares several NEAR accounts, the session is the owner's if it is among them, exactly. What
 * comes back is checked before anything says "connected"; a mismatch says which account came back.
 */
export async function reconnectAs(wallets: Pick<WalletService, 'connect' | 'disconnect'>, walletId: string, owner: string): Promise<OwnerReconnect> {
  await wallets.disconnect()
  let session: Session
  try {
    session = await wallets.connect(walletId, { account: owner })
  } catch (e) {
    const evm = e instanceof NoNearAccountError ? e.evm[0] : undefined
    if (evm !== undefined) return { ok: false, mismatch: { ok: false, reason: 'evm-only', evm }, session: null }
    throw e
  }
  const check = checkOwnerAccount(session.accounts ?? [session.accountId], owner)
  return check.ok ? { ok: true, session } : { ok: false, mismatch: check, session }
}
