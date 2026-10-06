import type { HeldExport, OwnerProof } from '../custody/signer'
import type { RecoveryService } from '../custody/recovery'
import type { TradingWallet } from '../custody/store'
import { HttpError, type Route } from './http'
import { field } from './linkRoutes'

/**
 * The web half of recovery, with or without Telegram. Every request that does anything
 * carries the owner wallet's NEP-413 signature of a one-time message the signer wrote;
 * the signer verifies it (and the key on chain) itself. A key export is held by the signer
 * (24 hours by default) and the wallet's Telegram account is told at once, with a button to
 * release it sooner in the Mini App and one to cancel it; if it can't be told, the export is
 * cancelled. The key crosses this API only once released, and only sealed to the owner's
 * browser key, so it can't be read here. Responses are never cached (no-store) and the API
 * logs path and status only.
 */

const proof = (body: unknown): OwnerProof => ({
  challengeId: field(body, 'challengeId', 64),
  publicKey: field(body, 'publicKey', 128),
  signature: field(body, 'signature', 256),
})

/** What the wallet's Telegram account is told about one of its exports. */
export interface ExportNotice {
  /** The wallet's Telegram account, as the signer records it: told, and the only account that releases or cancels the export there. */
  userId: number
  /** This app's record of the wallet. */
  wallet: TradingWallet
  exportId: string
  accountId: string
  ownerAccount: string
  /** The browser key's fingerprint, as the owner signed it and the web page shows it. */
  browserKey: string
  releaseAt: number
  expiresAt: number
  /** The Mini App start parameter of "Release it now". */
  digest: string
}

const noticeOf = (held: HeldExport, wallet: TradingWallet): ExportNotice => ({
  userId: held.userId,
  wallet,
  exportId: held.exportId,
  accountId: held.accountId,
  ownerAccount: held.ownerAccount,
  browserKey: held.browserKey,
  releaseAt: held.releaseAt,
  expiresAt: held.expiresAt,
  digest: held.digest,
})

/** A held export as the browser that asked sees it: no Telegram account, no Mini App parameter. */
const webView = (h: HeldExport) => ({
  exportId: h.exportId,
  accountId: h.accountId,
  ownerAccount: h.ownerAccount,
  browserKey: h.browserKey,
  status: h.status,
  requestedAt: h.requestedAt,
  releaseAt: h.releaseAt,
  expiresAt: h.expiresAt,
  confirmedAt: h.confirmedAt,
  cancelledAt: h.cancelledAt,
  cancelledBy: h.cancelledBy,
  collectedAt: h.collectedAt,
})

export function recoveryRoutes(deps: {
  recovery: RecoveryService
  /** Tells the wallet's Telegram account about a held export, with "Release it now" and "Cancel". False: it wasn't told, so the export is cancelled. */
  onExportRequested: (r: ExportNotice) => Promise<boolean>
  /** The wallet's Telegram account hears about every export collected… */
  onExported: (r: ExportNotice & { released: 'hold' | 'telegram' }) => Promise<void>
  /** …and every one cancelled on the web. */
  onExportCancelled: (r: ExportNotice) => Promise<void>
  /** And about every approved withdrawal destination. */
  onDestinationApproved: (r: { userId: number; walletId: string; wallet: string; destination: string }) => Promise<void>
}): Record<string, Route> {
  const exportId = (body: unknown) => field(body, 'exportId', 64)
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
      const { held, wallet } = await deps.recovery.requestExport(proof(body))
      // Telling Telegram is part of the export: if the wallet's account can't be told, nothing will be released.
      const told = await deps.onExportRequested(noticeOf(held, wallet)).catch(() => false)
      if (!told) {
        await deps.recovery.cancelExport({ exportId: held.exportId, by: 'app' }).catch(() => undefined)
        throw new HttpError(
          503,
          'telegram',
          'NEARKITS couldn’t tell this wallet’s Telegram account about the export, so it was cancelled and nothing will be released. Open NEARKITS’ bot in Telegram (unblock it if you blocked it), then start again.',
        )
      }
      await deps.recovery.noticeDelivered(held, wallet)
      return webView(held)
    },
    '/api/recovery/export/status': async (body) => {
      const h = await deps.recovery.exportStatus({ exportId: exportId(body) })
      if (!h) throw new HttpError(404, 'unknown', 'This export is unknown. Start again.')
      return webView(h)
    },
    '/api/recovery/export/collect': async (body) => {
      const { collected, wallet, held } = await deps.recovery.collectExport(exportId(body))
      // Telling Telegram is best effort here; the key was already released to the browser the owner signed for.
      await deps.onExported({ ...noticeOf(held, wallet), released: collected.released }).catch(() => undefined)
      return { exportId: collected.exportId, accountId: collected.accountId, publicKey: collected.publicKey, sealed: collected.sealed, released: collected.released }
    },
    '/api/recovery/export/cancel': async (body) => {
      const { held, wallet } = await deps.recovery.cancelExport({ exportId: exportId(body), by: 'web' })
      if (wallet && held.status === 'cancelled' && held.cancelledBy === 'web') await deps.onExportCancelled(noticeOf(held, wallet)).catch(() => undefined)
      return webView(held)
    },
    '/api/recovery/destination': async (body) => {
      const r = await deps.recovery.approveDestination(proof(body))
      if (r.userId !== null && r.walletId !== null)
        await deps.onDestinationApproved({ userId: r.userId, walletId: r.walletId, wallet: r.accountId, destination: r.destination }).catch(() => undefined)
      return { accountId: r.accountId, destination: r.destination }
    },
  }
}
