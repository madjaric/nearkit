import type { SealedExport } from '@/lib/exportCrypto'
import { accessKeyPermission } from '@/services/near/nep413'
import { NearKitError } from '@/services/near/errors'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import type { ServerNear } from '../near'
import type { ChallengeView } from '../signer/core'
import { BadRequestError } from '../signer/codec'
import { ChainUncertainError } from '../signer/chain'
import { ChallengeError, SignerPausedError, SignerUnavailableError } from '../signer/errors'
import { KmsUnavailableError } from '../signer/kms'
import type { IntentHandler } from './engine'
import { walletName } from './limits'
import type { ChallengeRequest, OwnerProof, TradingSigner } from './signer'
import type { CustodyStore, TradingWallet } from './store'
import { KeyUnavailableError } from './vault'
import { accessKeys } from './wallets'

/**
 * Keeping a NearKit wallet yours, with or without NearKit, and without Telegram.
 *
 * Everything here answers to the wallet's owner: the linked wallet it was created with,
 * never whichever wallet is linked now (someone holding the Telegram session could link
 * their own). The signer enforces that itself; the app only relays.
 *
 * - Backup key: a full-access key of the owner wallet (checked on chain) is added to the
 *   NearKit wallet. Whoever holds the user's own wallet can then control this one
 *   directly, even if NearKit, its database and its servers are gone.
 * - Export and the web recovery page: the owner wallet signs a one-time message the signer
 *   wrote (NEP-413, minutes, once). Telegram is not needed: the NearKit web app lists the
 *   owner's NearKit wallets after a signature, and exports one after another. The key is
 *   sealed by the signer to a key of the owner's browser, named in the signed message, so
 *   the app relaying it can't read it. Telegram only hears about it afterwards.
 * - Revoke: NearKit deletes its own key from the wallet (only once a full-access key of
 *   the owner wallet is on it), then the signer erases its sealed copy. The wallet stays,
 *   the user's alone.
 */

export class RecoveryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryApiError'
  }
}

/** A signer refusal as the web app sees it: a status, a code and a plain sentence. Never a secret. */
export function recoveryError(e: unknown): RecoveryApiError | null {
  if (e instanceof RecoveryApiError) return e
  if (e instanceof ChallengeError) {
    const status = e.problem === 'rate-limited' ? 429 : e.problem === 'expired' ? 410 : e.problem === 'used' ? 409 : e.problem === 'unknown' ? 404 : 403
    return new RecoveryApiError(status, e.problem, e.message)
  }
  if (e instanceof KeyUnavailableError) return new RecoveryApiError(410, 'wallet', 'This NearKit wallet is closed; NearKit no longer holds its key.')
  if (e instanceof SignerPausedError) return new RecoveryApiError(503, 'paused', 'NearKit’s signer is paused right now. Try again later.')
  if (e instanceof ChainUncertainError) return new RecoveryApiError(503, 'rpc', 'Couldn’t check your wallet on NEAR right now. Try again in a moment.')
  if (e instanceof KmsUnavailableError || e instanceof SignerUnavailableError)
    return new RecoveryApiError(503, 'signer', 'NearKit’s signer is not answering right now. Try again in a moment.')
  if (e instanceof BadRequestError) return new RecoveryApiError(400, 'bad-request', e.message)
  return null
}

const relay = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (e) {
    throw recoveryError(e) ?? e
  }
}

export interface OwnedWalletView {
  accountId: string
  /** Its name in Telegram (Main, Wallet 2, a label). */
  name: string
  createdAt: number
}

export function createRecoveryService(deps: { custody: CustodyStore; signer: TradingSigner; config: Pick<ServerConfig, 'network' | 'webUrl'> }) {
  const { custody, signer, config } = deps
  const network = config.network.id

  return {
    /**
     * Telegram's Export button: the NearKit web page for this one wallet. The link holds
     * no secret (the wallet's address, in the fragment): only the owner wallet's signature
     * exports anything.
     */
    async exportLink(userId: number, walletId: string): Promise<{ url: string }> {
      const w = await custody.ownedWallet(userId, walletId)
      if (!w || w.network !== network) throw new RecoveryApiError(404, 'no-wallet', 'That NearKit wallet is closed or not yours.')
      if (!w.ownerAccount) throw new RecoveryApiError(403, 'no-owner', 'This NearKit wallet has no recorded owner wallet, so its key can’t be exported.')
      await custody.audit({ userId, walletId: w.id, action: 'export-link-shown' })
      return { url: `${config.webUrl}/recover#wallet=${w.accountId}` }
    },

    /** A one-time message for the owner wallet to sign, written by the signer. */
    challenge: (req: ChallengeRequest): Promise<ChallengeView> => relay(() => signer.challenge(req)),

    /** The owner's NearKit wallets on this network, after the owner signed a session message. */
    async ownerWallets(proof: OwnerProof): Promise<{ ownerAccount: string; network: string; wallets: OwnedWalletView[] }> {
      const r = await relay(() => signer.ownerWallets(proof))
      const wallets = await Promise.all(
        r.wallets.map(async (k) => {
          const w = await custody.walletByAccount(network, k.accountId)
          return { accountId: k.accountId, name: w && w.status === 'active' ? walletName(w) : 'NearKit wallet', createdAt: k.createdAt }
        }),
      )
      return { ownerAccount: r.ownerAccount, network, wallets }
    },

    /** The key, sealed by the signer to the owner's browser key. The app relays it and can't open it. */
    async export(proof: OwnerProof): Promise<{ accountId: string; publicKey: string; sealed: SealedExport; userId: number | null; ownerAccount: string | null }> {
      const r = await relay(() => signer.exportKey(proof))
      const w = await custody.walletByAccount(network, r.accountId)
      if (w) await custody.audit({ userId: w.userId, walletId: w.id, action: 'key-exported', detail: { signedWith: proof.publicKey } })
      return { ...r, userId: w?.userId ?? null, ownerAccount: w?.ownerAccount ?? null }
    },

    /** The owner approves a withdrawal destination for one wallet (a signed message the signer verifies and keeps). */
    async approveDestination(proof: OwnerProof): Promise<{ accountId: string; destination: string; userId: number | null; walletId: string | null }> {
      const r = await relay(() => signer.approveDestination(proof))
      const w = await custody.walletByAccount(network, r.accountId)
      if (w) await custody.audit({ userId: w.userId, walletId: w.id, action: 'destination-approved', detail: { destination: r.destination, signedWith: proof.publicKey } })
      return { accountId: r.accountId, destination: r.destination, userId: w?.userId ?? null, walletId: w?.id ?? null }
    },
  }
}

export type RecoveryService = ReturnType<typeof createRecoveryService>

export interface BackupKeyParams {
  /** The wallet's owner (the linked wallet it was created with); its verified key becomes the backup key. */
  linkedAccount: string
  publicKey: string
}

export const RECOVERY_INTENT_TTL_MS = 5 * 60_000

/**
 * The owner key to add as the backup key: the one the owner wallet last proved when it
 * was linked here (a re-link after a key change updates it), else the one the NearKit
 * wallet was created with.
 */
export async function ownerKeyNow(links: Pick<Store, 'linkOf'>, wallet: TradingWallet): Promise<string | null> {
  if (!wallet.ownerAccount) return null
  const link = await links.linkOf(wallet.network, wallet.ownerAccount)
  return link && link.userId === wallet.userId ? link.publicKey : wallet.ownerKey
}

/** Adds a full-access key of the owner wallet to the NearKit wallet (AddKey, full access). No other key, ever. */
export function backupKeyHandler(deps: { near: ServerNear; custody: CustodyStore }): IntentHandler {
  return {
    async plan(intent, wallet) {
      const p = intent.params as unknown as BackupKeyParams
      if (!wallet.ownerAccount || p.linkedAccount !== wallet.ownerAccount)
        throw new NearKitError('INVALID_ACCOUNT', 'Only a key of the wallet this NearKit wallet was created with can be its backup key.')
      const [permission, keys] = await Promise.all([accessKeyPermission(deps.near.ctx.rpc, p.linkedAccount, p.publicKey), accessKeys(deps.near, wallet.accountId)])
      if (permission !== 'full')
        throw new NearKitError('INVALID_ACCOUNT', `That key is no longer a full-access key of ${p.linkedAccount}. Link ${p.linkedAccount} again, then add the backup key.`)
      if (keys === null) throw new NearKitError('RPC_ERROR', 'Couldn’t read the wallet’s keys.')
      if (!keys.includes(wallet.publicKey)) throw new NearKitError('INVALID_ACCOUNT', 'NearKit’s key isn’t on this wallet (is it funded?).')
      if (keys.includes(p.publicKey)) throw new NearKitError('INVALID_ACCOUNT', 'That key is already a backup key of this wallet.')
      return {
        kind: 'plan',
        op: { kind: 'add-backup-key', publicKey: p.publicKey },
        plan: [{ receiverId: wallet.accountId, actions: [{ kind: 'add-key', publicKey: p.publicKey }], label: 'Add backup key' }],
      }
    },
    async summarize(intent, wallet, confirmed) {
      const p = intent.params as unknown as BackupKeyParams
      const status = confirmed.at(-1)?.result.status as Record<string, unknown> | undefined
      const ok = Boolean(status && 'SuccessValue' in status)
      if (ok) {
        await deps.custody.setBackupKey(wallet.id, p.publicKey)
        await deps.custody.audit({ userId: wallet.userId, walletId: wallet.id, action: 'backup-key-added', detail: { publicKey: p.publicKey, linkedAccount: p.linkedAccount } })
      }
      return { ok, message: ok ? 'Backup key added.' : 'Adding the backup key failed on chain.', hashes: confirmed.map((c) => c.hash), facts: { ...p } }
    },
  }
}

/** Deletes NearKit's own key from the wallet, then the signer erases its sealed copy. Needs a key of the owner wallet on it. */
export function revokeHandler(deps: { near: ServerNear; custody: CustodyStore; signer: TradingSigner }): IntentHandler {
  return {
    async plan(_intent, wallet) {
      const keys = await accessKeys(deps.near, wallet.accountId)
      if (keys === null) throw new NearKitError('RPC_ERROR', 'Couldn’t read the wallet’s keys.')
      if (!keys.includes(wallet.publicKey)) throw new NearKitError('INVALID_ACCOUNT', 'NearKit’s key isn’t on this wallet.')
      // Never leave the wallet to a key NearKit can't vouch for: another key on it must be a
      // full-access key of the owner wallet, right now.
      const owner = wallet.ownerAccount
      const others = keys.filter((k) => k !== wallet.publicKey).slice(0, 8)
      const held = owner ? await Promise.all(others.map((k) => accessKeyPermission(deps.near.ctx.rpc, owner, k))) : []
      if (!held.includes('full'))
        throw new NearKitError(
          'INVALID_ACCOUNT',
          owner
            ? `Add your backup key first: no other key on this wallet is a full-access key of ${owner}, so nobody could control it after NearKit’s key is gone.`
            : 'This NearKit wallet has no recorded owner wallet, so NearKit won’t remove its own key. Withdraw your funds instead.',
        )
      return {
        kind: 'plan',
        op: { kind: 'revoke', publicKey: wallet.publicKey },
        plan: [{ receiverId: wallet.accountId, actions: [{ kind: 'delete-key', publicKey: wallet.publicKey }], label: 'Remove NearKit’s key' }],
      }
    },
    async summarize(_intent, wallet, confirmed) {
      const status = confirmed.at(-1)?.result.status as Record<string, unknown> | undefined
      const ok = Boolean(status && 'SuccessValue' in status)
      if (ok) {
        await deps.custody.closeWallet(wallet.id, 'revoked', { tx: confirmed.at(-1)?.hash })
        // The signer checks on chain that its key is gone before it erases its copy; if it can't tell yet, housekeeping asks again.
        await deps.signer.eraseKey({ accountId: wallet.accountId, reason: 'revoked' }).catch(() => false)
      }
      return {
        ok,
        message: ok ? 'NearKit’s key was removed.' : 'Removing NearKit’s key failed on chain. Nothing changed.',
        hashes: confirmed.map((c) => c.hash),
        facts: { accountId: wallet.accountId },
      }
    },
  }
}
