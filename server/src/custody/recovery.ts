import { base64Decode, base64Encode } from '@/lib/encoding'
import { accessKeyPermission, verifyNep413 } from '@/services/near/nep413'
import { NearKitError } from '@/services/near/errors'
import type { RpcClient } from '@/services/near/rpc'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import { randomBytesArray, randomToken, sha256Hex } from '../ids'
import type { ServerNear } from '../near'
import { plainText } from '../telegram/html'
import type { IntentHandler } from './engine'
import type { TradingSigner } from './signer'
import type { CustodyStore, TradingWallet } from './store'
import { accessKeys } from './wallets'

/**
 * Keeping a NearKit wallet yours, with or without NearKit.
 *
 * Everything here answers to the wallet's owner: the linked wallet it was created with,
 * never whichever wallet is linked now (someone holding the Telegram session could link
 * their own).
 *
 * - Backup key: a full-access key of the owner wallet (checked on chain) is added to the
 *   NearKit wallet. Whoever holds the user's own wallet can then control this one
 *   directly, even if NearKit, its database and its servers are gone.
 * - Export: the private key, shown once in the NearKit web app after a fresh NEP-413
 *   signature by a full-access key of the owner wallet, never in Telegram. A one-time
 *   code (10 minutes, stored as SHA-256) binds the request to the Telegram user who asked.
 * - Revoke: NearKit deletes its own key from the wallet (only once a full-access key of
 *   the owner wallet is on it), then erases its sealed copy. The wallet stays, the
 *   user's alone.
 */

export const RECOVERY_TTL_MS = 10 * 60_000
export const MAX_RECOVERY_REQUESTS_PER_HOUR = 3
export const MAX_EXPORT_ATTEMPTS = 5

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

export interface RecoveryDescription {
  telegram: { name: string; username: string | null }
  network: string
  /** The NearKit wallet whose key would be exported. */
  wallet: string
  /** The wallet's owner: the only account whose signature can authorize the export. */
  owner: string
  recipient: string
  message: string
  nonce: string
  expiresAt: number
}

export interface RecoveryExport {
  accountId: string
  publicKey: string
  /** The private key, `ed25519:…`. Returned once, to the verified owner, never stored or logged. */
  secretKey: string
}

export function recoveryMessage(user: { userId: number; username: string | null; firstName: string }, wallet: string, network: string): string {
  const who = user.username ? `@${plainText(user.username, 64)}` : plainText(user.firstName, 64) || 'a Telegram user'
  return [
    'NearKit: export the private key of my NearKit wallet',
    `Wallet: ${wallet}`,
    `Telegram: ${who} (id ${user.userId})`,
    `Network: ${network}`,
    '',
    'Only sign this if you asked the NearKit bot for this export yourself. Anyone who sees the exported key controls that wallet.',
  ].join('\n')
}

export function createRecoveryService(deps: {
  store: Store
  custody: CustodyStore
  signer: TradingSigner
  config: Pick<ServerConfig, 'network' | 'webUrl' | 'linkRecipient'>
  rpc: RpcClient
  now?: () => number
}) {
  const { store, custody, signer, config, rpc } = deps
  const now = deps.now ?? Date.now
  const network = config.network.id

  async function live(code: string) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code))
      throw new RecoveryApiError(400, 'bad-code', 'This export link is not valid. Ask the NearKit bot for a new one in 🔐 Recovery.')
    const req = await custody.recovery(sha256Hex(code))
    if (!req) throw new RecoveryApiError(404, 'unknown', 'This export link is unknown. Ask the NearKit bot for a new one in 🔐 Recovery.')
    if (req.exportedAt !== null || req.verifiedAt !== null) throw new RecoveryApiError(409, 'used', 'This export link was already used. Ask the NearKit bot for a new one.')
    if (now() > req.expiresAt) throw new RecoveryApiError(410, 'expired', 'This export link expired. Ask the NearKit bot for a new one.')
    if (req.network !== network) throw new RecoveryApiError(400, 'network', `This export link is for ${req.network}.`)
    const wallet = await custody.wallet(req.walletId)
    if (!wallet || wallet.status !== 'active' || wallet.userId !== req.userId)
      throw new RecoveryApiError(410, 'wallet', 'This NearKit wallet is closed; NearKit no longer holds its key.')
    if (!wallet.ownerAccount) throw new RecoveryApiError(403, 'no-owner', 'This NearKit wallet has no recorded owner wallet, so its key can’t be exported.')
    return { req, wallet, owner: wallet.ownerAccount }
  }

  return {
    /** From Telegram's Recovery screen: a one-time link to the export page. */
    async createRequest(userId: number): Promise<{ url: string; expiresAt: number }> {
      const wallet = await custody.activeWallet(userId, network)
      if (!wallet) throw new RecoveryApiError(404, 'no-wallet', 'You have no NearKit wallet.')
      if (!wallet.ownerAccount) throw new RecoveryApiError(403, 'no-owner', 'This NearKit wallet has no recorded owner wallet, so its key can’t be exported.')
      if ((await custody.countRecoveriesSince(userId, now() - 3_600_000)) >= MAX_RECOVERY_REQUESTS_PER_HOUR)
        throw new RecoveryApiError(429, 'too-many', 'Too many export links this hour. Use the last one, or try again later.')
      const user = await store.getUser(userId)
      if (!user) throw new RecoveryApiError(404, 'unknown-user', 'Send /start first.')
      const code = randomToken(16)
      const req = await custody.createRecovery({
        codeHash: sha256Hex(code),
        userId,
        walletId: wallet.id,
        network,
        nonce: base64Encode(randomBytesArray(32)),
        message: recoveryMessage(user, wallet.accountId, network),
        ttlMs: RECOVERY_TTL_MS,
      })
      await custody.audit({ userId, walletId: wallet.id, action: 'export-requested', detail: { expiresAt: req.expiresAt } })
      // In the fragment: it never reaches a server log.
      return { url: `${config.webUrl}/telegram#recover=${code}`, expiresAt: req.expiresAt }
    },

    async describe(code: string): Promise<RecoveryDescription> {
      const { req, wallet, owner } = await live(code)
      const user = await store.getUser(req.userId)
      return {
        telegram: { name: user?.firstName ?? 'Telegram user', username: user?.username ?? null },
        network,
        wallet: wallet.accountId,
        owner,
        recipient: config.linkRecipient,
        message: req.message,
        nonce: req.nonce,
        expiresAt: req.expiresAt,
      }
    },

    async export(input: { code: string; accountId: string; publicKey: string; signature: string }): Promise<RecoveryExport & { userId: number; signedBy: string }> {
      const { req, wallet, owner } = await live(input.code)
      if (req.attempts >= MAX_EXPORT_ATTEMPTS) throw new RecoveryApiError(429, 'locked', 'Too many attempts with this link. Ask the NearKit bot for a new one.')
      await custody.bumpRecoveryAttempt(req.codeHash)
      const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
      // The owner alone: a wallet linked later (e.g. by someone holding the Telegram session) can't authorize this.
      if (accountId !== owner) {
        await custody.audit({ userId: req.userId, walletId: wallet.id, action: 'export-refused', detail: { reason: 'not the owner', account: accountId } })
        throw new RecoveryApiError(403, 'not-owner', `Sign with ${owner}, the wallet this NearKit wallet was created with. Nothing was exported.`)
      }
      const nonce = base64Decode(req.nonce)
      const signed = nonce !== null && (await verifyNep413({ message: req.message, nonce, recipient: config.linkRecipient }, input.publicKey, input.signature))
      if (!signed) {
        await custody.audit({ userId: req.userId, walletId: wallet.id, action: 'export-refused', detail: { reason: 'bad signature', account: accountId } })
        throw new RecoveryApiError(401, 'bad-signature', 'The signature does not match this export request. Nothing was exported.')
      }
      let permission
      try {
        permission = await accessKeyPermission(rpc, accountId, input.publicKey)
      } catch {
        throw new RecoveryApiError(503, 'rpc', 'Couldn’t reach NEAR to check the key. Try again in a moment.')
      }
      if (permission !== 'full') throw new RecoveryApiError(403, 'not-full-access', `Sign with a full-access key of ${accountId}. Nothing was exported.`)
      if (!(await custody.markRecoveryVerified(req.codeHash, accountId))) throw new RecoveryApiError(409, 'used', 'This export link was already used.')
      const secretKey = await signer.exportSecret(wallet, req.codeHash)
      return { accountId: wallet.accountId, publicKey: wallet.publicKey, secretKey, userId: req.userId, signedBy: accountId }
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

/** Deletes NearKit's own key from the wallet, then erases NearKit's sealed copy. Needs a key of the owner wallet on it. */
export function revokeHandler(deps: { near: ServerNear; custody: CustodyStore }): IntentHandler {
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
      if (ok) await deps.custody.closeWallet(wallet.id, 'revoked', { tx: confirmed.at(-1)?.hash })
      return {
        ok,
        message: ok ? 'NearKit’s key was removed.' : 'Removing NearKit’s key failed on chain. Nothing changed.',
        hashes: confirmed.map((c) => c.hash),
        facts: { accountId: wallet.accountId },
      }
    },
  }
}
