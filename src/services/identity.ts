import type { Session } from '@/types/domain'
import type { NearKitEndedSession, NearKitWebSession } from './nearkitWeb'

/**
 * Who the user is, the one check every page asks (`useIdentity` in queries.ts). The user is signed
 * in with a browser wallet (it signs), a NEARKITS web session (the custodial NEARKITS wallets,
 * signed in from the bot's /web link), or both. Where a page takes NEARKITS wallets (`custodial`),
 * the NEARKITS session alone signs the user in; a session of it that ended says so instead of
 * "connect a wallet". The server decides which wallets a session may touch; this only decides what
 * the page shows.
 */
export type Identity =
  /** The browser wallet's session is still being restored, and nothing else answers for the user yet. */
  | { kind: 'pending' }
  | { kind: 'signed-in'; wallet: Session | null; nearkit: NearKitWebSession | null }
  /** Nobody, and the NEARKITS web session this browser had ended (expired, or signed out from Telegram). */
  | { kind: 'session-ended'; ended: NearKitEndedSession }
  | { kind: 'signed-out' }

export interface IdentityInputs {
  wallet: Session | null | undefined
  walletPending: boolean
  nearkit: NearKitWebSession | null
  ended: NearKitEndedSession | null
}

/**
 * `custodial`: the page takes NEARKITS wallets (and this build has a NEARKITS server).
 * `waitForWallet`: pending until the browser wallet is restored even when a NEARKITS session
 * answers (the top bar, which shows the wallet's chip first).
 */
export function identityOf(i: IdentityInputs, options: { custodial: boolean; waitForWallet?: boolean }): Identity {
  const nearkit = options.custodial ? i.nearkit : null
  if (i.walletPending && (nearkit === null || options.waitForWallet)) return { kind: 'pending' }
  const wallet = i.wallet ?? null
  if (wallet || nearkit) return { kind: 'signed-in', wallet, nearkit }
  if (options.custodial && i.ended) return { kind: 'session-ended', ended: i.ended }
  return { kind: 'signed-out' }
}

/** How a NEARKITS web user is named: the Telegram @handle when there is one, else the name. */
export const nearkitUserLabel = (s: Pick<NearKitWebSession, 'userName' | 'userHandle'>) => (s.userHandle ? `@${s.userHandle}` : s.userName)
