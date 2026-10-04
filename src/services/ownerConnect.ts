import { checkOwnerAccount, type OwnerAccountMismatch } from '@/lib/ownerAccount'
import type { Session } from '@/types/domain'
import { NoNearAccountError } from './near/errors'
import type { WalletService } from './types'

export type OwnerReconnect = { ok: true; session: Session } | { ok: false; mismatch: OwnerAccountMismatch }

/**
 * Connect a wallet that must end on `owner` (Recover's "Connect <owner>"). The current session
 * is signed out first: a wallet that still holds one answers a new connect with the same
 * account and never shows its account picker. What comes back is checked against `owner`
 * exactly before anything says "connected"; a mismatch says which account came back.
 */
export async function reconnectAs(wallets: Pick<WalletService, 'connect' | 'disconnect'>, walletId: string, owner: string): Promise<OwnerReconnect> {
  await wallets.disconnect()
  let session: Session
  try {
    session = await wallets.connect(walletId)
  } catch (e) {
    const evm = e instanceof NoNearAccountError ? e.evm[0] : undefined
    if (evm !== undefined) return { ok: false, mismatch: { ok: false, reason: 'evm-only', evm } }
    throw e
  }
  const check = checkOwnerAccount(session.accounts ?? [session.accountId], owner)
  return check.ok ? { ok: true, session } : { ok: false, mismatch: check }
}
