import type { RecoveryService } from '../custody/recovery'
import type { Route } from './http'
import { field } from './linkRoutes'

/**
 * The web half of exporting a NearKit wallet's key: describe the one-time request,
 * then exchange the linked wallet's NEP-413 signature for the key. The key is in
 * this one response body only (never cached: the API sends no-store; never logged:
 * the API logs path and status only).
 */
export function recoveryRoutes(deps: { recovery: RecoveryService; onExported: (r: { userId: number; wallet: string; signedBy: string }) => Promise<void> }): Record<string, Route> {
  return {
    '/api/recovery/describe': async (body) => deps.recovery.describe(field(body, 'code', 64)),
    '/api/recovery/export': async (body) => {
      const r = await deps.recovery.export({
        code: field(body, 'code', 64),
        accountId: field(body, 'accountId', 64),
        publicKey: field(body, 'publicKey', 128),
        signature: field(body, 'signature', 256),
      })
      // Telling Telegram is best effort; the export already happened.
      await deps.onExported({ userId: r.userId, wallet: r.accountId, signedBy: r.signedBy }).catch(() => undefined)
      return { accountId: r.accountId, publicKey: r.publicKey, secretKey: r.secretKey }
    },
  }
}
