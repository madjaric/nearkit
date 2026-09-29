import { base64Decode, base64Encode } from '@/lib/encoding'
import { accountIdError, isForeignToNetwork } from '@/lib/validation'
import { accessKeyPermission, verifyNep413 } from '@/services/near/nep413'
import type { RpcClient } from '@/services/near/rpc'
import type { ServerConfig } from '../config'
import { LinkError, type Store } from '../db/store'
import { randomBytesArray, randomToken, sha256Hex } from '../ids'
import { plainText } from '../telegram/html'

/**
 * Linking a Telegram account to a NEAR account, without keys ever leaving the wallet:
 *
 * 1. In Telegram, /link issues a one-time code (128 bits, 10 minutes, one use),
 *    bound to that Telegram user. Only its SHA-256 is stored.
 * 2. The NearKit web page (`/telegram#link=<code>`, a fragment so it stays out of
 *    server logs) shows which Telegram account asked, and asks the wallet to sign
 *    a NEP-413 message naming that Telegram account. Signing is free.
 * 3. The server checks the signature over the exact stored message, nonce and
 *    recipient, then that the key is a FULL-ACCESS key of the account on chain.
 *    Only then is the account linked.
 *
 * A NEAR account has at most one Telegram account per network. Moving it needs
 * the owner's signature again, and the previous Telegram account is told.
 */

export const LINK_TTL_MS = 10 * 60_000
export const MAX_LINK_REQUESTS_PER_HOUR = 5
export const MAX_CONFIRM_ATTEMPTS = 5

export class LinkApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LinkApiError'
  }
}

export interface LinkDescription {
  telegram: { name: string; username: string | null }
  network: string
  recipient: string
  message: string
  /** Base64 of the 32-byte NEP-413 nonce. */
  nonce: string
  expiresAt: number
}

export interface LinkConfirmation {
  code: string
  accountId: string
  publicKey: string
  signature: string
}

export function linkMessage(user: { userId: number; username: string | null; firstName: string }, network: string): string {
  const who = user.username ? `@${plainText(user.username, 64)}` : plainText(user.firstName, 64) || 'a Telegram user'
  return [
    'NearKit: link this NEAR account to Telegram',
    `Telegram: ${who} (id ${user.userId})`,
    `Network: ${network}`,
    '',
    'Only sign this if you asked the NearKit bot for this link yourself. Signing is free and moves no funds.',
  ].join('\n')
}

export function createLinkService(deps: { store: Store; config: Pick<ServerConfig, 'network' | 'webUrl' | 'linkRecipient'>; rpc: RpcClient; now?: () => number }) {
  const { store, config, rpc } = deps
  const now = deps.now ?? Date.now
  const network = config.network.id

  function liveRequest(code: string) {
    if (typeof code !== 'string' || code.length < 16 || code.length > 64 || !/^[A-Za-z0-9_-]+$/.test(code)) {
      throw new LinkApiError(400, 'bad-code', 'This link code is not valid. Ask the NearKit bot for a new one with /link.')
    }
    const req = store.getLinkRequest(sha256Hex(code))
    if (!req) throw new LinkApiError(404, 'unknown', 'This link code is unknown. Ask the NearKit bot for a new one with /link.')
    if (req.usedAt !== null) throw new LinkApiError(409, 'used', 'This link code was already used. Ask the NearKit bot for a new one with /link.')
    if (now() > req.expiresAt) throw new LinkApiError(410, 'expired', 'This link code expired. Ask the NearKit bot for a new one with /link.')
    if (req.network !== network) throw new LinkApiError(400, 'network', `This link code is for ${req.network}.`)
    return req
  }

  return {
    /** Called by /link. Throws when the user asked for too many codes this hour. */
    createRequest(userId: number): { code: string; url: string; expiresAt: number } {
      if (store.countLinkRequestsSince(userId, now() - 3_600_000) >= MAX_LINK_REQUESTS_PER_HOUR) {
        throw new LinkApiError(429, 'too-many', 'Too many link requests this hour. Use the last link I sent, or try again later.')
      }
      const user = store.getUser(userId)
      if (!user) throw new LinkApiError(404, 'unknown-user', 'Send /start first.')
      const code = randomToken(16)
      const req = store.createLinkRequest({
        codeHash: sha256Hex(code),
        userId,
        network,
        nonce: base64Encode(randomBytesArray(32)),
        message: linkMessage(user, network),
        ttlMs: LINK_TTL_MS,
      })
      return { code, url: `${config.webUrl}/telegram#link=${code}`, expiresAt: req.expiresAt }
    },

    /** What the web page shows before the wallet signs, and exactly what it must sign. */
    describe(code: string): LinkDescription {
      const req = liveRequest(code)
      const user = store.getUser(req.userId)
      return {
        telegram: { name: user?.firstName ?? 'Telegram user', username: user?.username ?? null },
        network,
        recipient: config.linkRecipient,
        message: req.message,
        nonce: req.nonce,
        expiresAt: req.expiresAt,
      }
    },

    async confirm(input: LinkConfirmation): Promise<{ accountId: string; userId: number; previousUserId: number | null }> {
      const req = liveRequest(input.code)
      if (req.attempts >= MAX_CONFIRM_ATTEMPTS) throw new LinkApiError(429, 'locked', 'Too many attempts with this code. Ask the NearKit bot for a new one with /link.')
      store.bumpLinkAttempt(req.codeHash)

      const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
      const accountError = accountIdError(accountId)
      if (accountError) throw new LinkApiError(400, 'bad-account', `Account: ${accountError}`)
      if (isForeignToNetwork(accountId, config.network.id)) throw new LinkApiError(400, 'network', `${accountId} is not a ${network} account.`)
      if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string') throw new LinkApiError(400, 'bad-signature', 'The wallet’s answer is incomplete.')

      const nonce = base64Decode(req.nonce)
      const signed = nonce !== null && (await verifyNep413({ message: req.message, nonce, recipient: config.linkRecipient }, input.publicKey, input.signature))
      if (!signed) throw new LinkApiError(401, 'bad-signature', 'The signature does not match this link request. Nothing was linked.')

      let permission
      try {
        permission = await accessKeyPermission(rpc, accountId, input.publicKey)
      } catch {
        throw new LinkApiError(503, 'rpc', 'Couldn’t reach NEAR to check the key. Try again in a moment.')
      }
      if (permission === 'function-call')
        throw new LinkApiError(403, 'function-call-key', 'That key can only call certain contracts. Sign with your wallet’s full-access key to prove you own the account.')
      if (permission !== 'full') throw new LinkApiError(403, 'key-not-on-account', `That key is not a key of ${accountId}. Nothing was linked.`)

      let result
      try {
        result = store.completeLink({ codeHash: req.codeHash, network, accountId, userId: req.userId, publicKey: input.publicKey })
      } catch (e) {
        if (e instanceof LinkError) throw new LinkApiError(e.code === 'expired' ? 410 : e.code === 'used' ? 409 : 400, e.code, e.message)
        throw e
      }
      if (!store.getSettings(req.userId).defaultAccount) store.updateSettings(req.userId, { defaultAccount: accountId })
      return { accountId, userId: req.userId, previousUserId: result.previousUserId }
    },
  }
}

export type LinkService = ReturnType<typeof createLinkService>
