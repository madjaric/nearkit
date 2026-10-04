import type { OwnerControl, OwnerRefusal } from '@/lib/ownerAccount'
import type { Session } from '@/types/domain'
import { NoNearAccountError } from './near/errors'
import type { WalletService } from './types'

/** On a mismatch, `session` is what the wallet connected with (null when it shared no NEAR account), for what it returned. */
export type OwnerReconnect = { ok: true; session: Session; control: Extract<OwnerControl, { ok: true }> } | { ok: false; mismatch: OwnerRefusal; session: Session | null }

/**
 * Connect a wallet that must end on `owner` (Recover's "Connect <owner>"). The current session
 * is signed out first: a wallet that still holds one answers a new connect with the same
 * account and never shows its account picker. The owner is asked for by name: when the wallet
 * shares several NEAR accounts, the session is the owner's if it is among them, exactly. Then the
 * wallet is checked the way the signer checks it (`ownerControl`: the owner account itself, or a
 * full-access key of the owner) before anything says "connected"; a mismatch says why. An account
 * that signs with an owner key stays that account: it is never taken for the owner.
 */
export async function reconnectAs(wallets: Pick<WalletService, 'connect' | 'disconnect' | 'ownerControl'>, walletId: string, owner: string): Promise<OwnerReconnect> {
  await wallets.disconnect()
  let session: Session
  try {
    session = await wallets.connect(walletId, { account: owner })
  } catch (e) {
    const evm = e instanceof NoNearAccountError ? e.evm[0] : undefined
    if (evm !== undefined) return { ok: false, mismatch: { ok: false, reason: 'evm-only', evm }, session: null }
    throw e
  }
  const control = await wallets.ownerControl(owner)
  return control.ok ? { ok: true, session, control } : { ok: false, mismatch: control, session }
}
