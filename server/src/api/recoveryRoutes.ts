import type { OwnerProof } from '../custody/signer'
import type { RecoveryService } from '../custody/recovery'
import { HttpError, type Route } from './http'
import { field } from './linkRoutes'

/**
 * The web half of recovery, with or without Telegram. Every request that does anything
 * carries the owner wallet's NEP-413 signature of a one-time message the signer wrote;
 * the signer verifies it (and the key on chain) itself. An exported key crosses this API
 * only sealed to the owner's browser key, so it can't be read here. Responses are never
 * cached (no-store) and the API logs path and status only.
 */

const proof = (body: unknown): OwnerProof => ({
  challengeId: field(body, 'challengeId', 64),
  publicKey: field(body, 'publicKey', 128),
  signature: field(body, 'signature', 256),
})

export function recoveryRoutes(deps: {
  recovery: RecoveryService
  /** The wallet's Telegram user hears about every export, whoever did it. */
  onExported: (r: { userId: number; wallet: string; owner: string }) => Promise<void>
  /** And about every approved withdrawal destination. */
  onDestinationApproved: (r: { userId: number; walletId: string; wallet: string; destination: string }) => Promise<void>
}): Record<string, Route> {
  return {
    '/api/recovery/challenge': async (body) => {
      const kind = field(body, 'kind', 32)
      if (kind === 'owner-session') return deps.recovery.challenge({ kind, owner: field(body, 'owner', 64) })
      if (kind === 'export') return deps.recovery.challenge({ kind, accountId: field(body, 'accountId', 64), recipientKey: field(body, 'recipientKey', 128) })
      if (kind === 'approve-destination') return deps.recovery.challenge({ kind, accountId: field(body, 'accountId', 64), destination: field(body, 'destination', 64) })
      throw new HttpError(400, 'bad-request', 'Unknown kind of request')
    },
    '/api/recovery/wallets': async (body) => deps.recovery.ownerWallets(proof(body)),
    '/api/recovery/export': async (body) => {
      const r = await deps.recovery.export(proof(body))
      // Telling Telegram is best effort; the export already happened.
      if (r.userId !== null) await deps.onExported({ userId: r.userId, wallet: r.accountId, owner: r.ownerAccount ?? 'your owner wallet' }).catch(() => undefined)
      return { accountId: r.accountId, publicKey: r.publicKey, sealed: r.sealed }
    },
    '/api/recovery/destination': async (body) => {
      const r = await deps.recovery.approveDestination(proof(body))
      if (r.userId !== null && r.walletId !== null)
        await deps.onDestinationApproved({ userId: r.userId, walletId: r.walletId, wallet: r.accountId, destination: r.destination }).catch(() => undefined)
      return { accountId: r.accountId, destination: r.destination }
    },
  }
}
