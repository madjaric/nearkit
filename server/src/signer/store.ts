import { isUniqueViolation, type Database } from '../db/database'
import { randomToken } from '../ids'

/**
 * The signer's state (signer/schema.ts). Nothing here is a plain secret: keys are sealed,
 * signed transactions become public once sent, and the event log holds accounts, hashes
 * and reasons only.
 */

export interface SignerKey {
  network: string
  accountId: string
  publicKey: string
  /**
   * The owner wallet the key is bound to (in its sealing too). Null for a wallet with no owner
   * wallet: its key is bound to the Telegram account that controls it (`userId`) instead.
   */
  ownerAccount: string | null
  /** The owner key proven when the wallet was created (informational: approvals re-check keys on chain). */
  ownerKey: string | null
  userId: number | null
  walletId: string | null
  /** Null once erased. */
  sealedKey: string | null
  keyRef: string
  status: 'active' | 'erased'
  createdAt: number
  erasedAt: number | null
  eraseReason: string | null
}

export type ChallengeKind = 'owner-session' | 'export' | 'approve-destination'

export interface Challenge {
  id: string
  kind: ChallengeKind
  network: string
  /** The NearKit wallet it is about (null for an owner session). */
  accountId: string | null
  ownerAccount: string
  destination: string | null
  /** Export: the browser key the exported key is encrypted to. */
  recipientKey: string | null
  message: string
  /** base64 of 32 random bytes (NEP-413 nonce). */
  nonce: string
  /** NEP-413 recipient: the web app's host. */
  recipient: string
  attempts: number
  createdAt: number
  expiresAt: number
  usedAt: number | null
}

export interface Destination {
  id: string
  network: string
  accountId: string
  destination: string
  ownerAccount: string
  /** The owner key that signed the approval (a full-access key of the owner when approved). */
  publicKey: string
  challengeId: string
  message: string
  nonce: string
  recipient: string
  signature: string
  approvedAt: number
  revokedAt: number | null
}

export type TelegramRequestKind = 'destination' | 'bind-owner'

/** Something a wallet's Telegram account is asked to approve in NearKit's Mini App (a wallet with no owner wallet). */
export interface TelegramRequest {
  id: string
  /** The Mini App's start parameter: Telegram signs it into the launch (src/lib/telegramApproval.ts). */
  digest: string
  kind: TelegramRequestKind
  network: string
  accountId: string
  /** The Telegram user who controls the wallet, from the signer's own key record. */
  userId: number
  /** The withdrawal address, or the account that becomes the wallet's owner. */
  target: string
  /** bind-owner: the owner's key as its link proved it (informational: owner requests re-check keys on chain). */
  targetKey: string | null
  attempts: number
  createdAt: number
  expiresAt: number
  usedAt: number | null
}

/** A withdrawal address the controlling Telegram account approved, with Telegram's signed launch data, re-verified at every use. */
export interface TelegramApproval {
  id: string
  network: string
  accountId: string
  destination: string
  userId: number
  requestId: string
  requestExpiresAt: number
  initData: string
  approvedAt: number
  revokedAt: number | null
}

export interface SignatureRecord {
  intentId: string
  step: number
  network: string
  accountId: string
  txHash: string
  signed: string
  nonce: string
  opKind: string
  createdAt: number
}

interface KeyRow {
  network: string
  account_id: string
  public_key: string
  owner_account: string | null
  owner_key: string | null
  user_id: number | null
  wallet_id: string | null
  sealed_key: string | null
  key_ref: string
  status: 'active' | 'erased'
  created_at: number
  erased_at: number | null
  erase_reason: string | null
}

const toKey = (r: KeyRow): SignerKey => ({
  network: r.network,
  accountId: r.account_id,
  publicKey: r.public_key,
  ownerAccount: r.owner_account,
  ownerKey: r.owner_key,
  userId: r.user_id,
  walletId: r.wallet_id,
  sealedKey: r.sealed_key,
  keyRef: r.key_ref,
  status: r.status,
  createdAt: r.created_at,
  erasedAt: r.erased_at,
  eraseReason: r.erase_reason,
})

interface ChallengeRow {
  id: string
  kind: ChallengeKind
  network: string
  account_id: string | null
  owner_account: string
  destination: string | null
  recipient_key: string | null
  message: string
  nonce: string
  recipient: string
  attempts: number
  created_at: number
  expires_at: number
  used_at: number | null
}

const toChallenge = (r: ChallengeRow): Challenge => ({
  id: r.id,
  kind: r.kind,
  network: r.network,
  accountId: r.account_id,
  ownerAccount: r.owner_account,
  destination: r.destination,
  recipientKey: r.recipient_key,
  message: r.message,
  nonce: r.nonce,
  recipient: r.recipient,
  attempts: r.attempts,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
})

interface DestinationRow {
  id: string
  network: string
  account_id: string
  destination: string
  owner_account: string
  public_key: string
  challenge_id: string
  message: string
  nonce: string
  recipient: string
  signature: string
  approved_at: number
  revoked_at: number | null
}

const toDestination = (r: DestinationRow): Destination => ({
  id: r.id,
  network: r.network,
  accountId: r.account_id,
  destination: r.destination,
  ownerAccount: r.owner_account,
  publicKey: r.public_key,
  challengeId: r.challenge_id,
  message: r.message,
  nonce: r.nonce,
  recipient: r.recipient,
  signature: r.signature,
  approvedAt: r.approved_at,
  revokedAt: r.revoked_at,
})

interface TelegramRequestRow {
  id: string
  digest: string
  kind: TelegramRequestKind
  network: string
  account_id: string
  user_id: number
  target: string
  target_key: string | null
  attempts: number
  created_at: number
  expires_at: number
  used_at: number | null
}

const toTelegramRequest = (r: TelegramRequestRow): TelegramRequest => ({
  id: r.id,
  digest: r.digest,
  kind: r.kind,
  network: r.network,
  accountId: r.account_id,
  userId: Number(r.user_id),
  target: r.target,
  targetKey: r.target_key,
  attempts: r.attempts,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  usedAt: r.used_at === null ? null : Number(r.used_at),
})

interface TelegramApprovalRow {
  id: string
  network: string
  account_id: string
  destination: string
  user_id: number
  request_id: string
  request_expires_at: number
  init_data: string
  approved_at: number
  revoked_at: number | null
}

const toTelegramApproval = (r: TelegramApprovalRow): TelegramApproval => ({
  id: r.id,
  network: r.network,
  accountId: r.account_id,
  destination: r.destination,
  userId: Number(r.user_id),
  requestId: r.request_id,
  requestExpiresAt: Number(r.request_expires_at),
  initData: r.init_data,
  approvedAt: Number(r.approved_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
})

interface SignatureRow {
  intent_id: string
  step: number
  network: string
  account_id: string
  tx_hash: string
  signed: string
  nonce: string
  op_kind: string
  created_at: number
}

const toSignature = (r: SignatureRow): SignatureRecord => ({
  intentId: r.intent_id,
  step: r.step,
  network: r.network,
  accountId: r.account_id,
  txHash: r.tx_hash,
  signed: r.signed,
  nonce: r.nonce,
  opKind: r.op_kind,
  createdAt: r.created_at,
})

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))

export class SignerStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── keys ─────────────────────────────────────────────────────────────────

  async insertKey(k: Omit<SignerKey, 'status' | 'createdAt' | 'erasedAt' | 'eraseReason'> & { sealedKey: string }): Promise<void> {
    const t = this.now()
    await this.db.run(
      `INSERT INTO signer_keys (network, account_id, public_key, owner_account, owner_key, user_id, wallet_id, sealed_key, key_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [k.network, k.accountId, k.publicKey, k.ownerAccount, k.ownerKey, k.userId, k.walletId, k.sealedKey, k.keyRef, t, t],
    )
  }

  async key(network: string, accountId: string): Promise<SignerKey | null> {
    const r = await this.db.get<KeyRow>('SELECT * FROM signer_keys WHERE network = ? AND account_id = ?', [network, accountId])
    return r ? toKey(r) : null
  }

  async keysOfOwner(network: string, owner: string): Promise<SignerKey[]> {
    return (await this.db.all<KeyRow>("SELECT * FROM signer_keys WHERE network = ? AND owner_account = ? AND status = 'active' ORDER BY created_at", [network, owner])).map(toKey)
  }

  /** Every key still held, for the reseal tool. */
  async activeKeys(): Promise<SignerKey[]> {
    return (await this.db.all<KeyRow>("SELECT * FROM signer_keys WHERE status = 'active' ORDER BY created_at")).map(toKey)
  }

  /** Erases the sealed key for good. False when it was already erased. */
  async eraseKey(network: string, accountId: string, reason: string): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run(
        "UPDATE signer_keys SET status = 'erased', sealed_key = NULL, erased_at = ?, erase_reason = ?, updated_at = ? WHERE network = ? AND account_id = ? AND status = 'active'",
        [t, reason, t, network, accountId],
      )) === 1
    )
  }

  /**
   * A wallet with no owner wallet gets its first owner, with its key resealed to that owner.
   * Only if it still has no owner and its key is still exactly `before`: an owned wallet is
   * never bound again.
   */
  async bindOwner(network: string, accountId: string, before: string, after: string, owner: string, ownerKey: string | null): Promise<boolean> {
    return (
      (await this.db.run(
        "UPDATE signer_keys SET owner_account = ?, owner_key = ?, sealed_key = ?, updated_at = ? WHERE network = ? AND account_id = ? AND status = 'active' AND owner_account IS NULL AND sealed_key = ?",
        [owner, ownerKey, after, this.now(), network, accountId, before],
      )) === 1
    )
  }

  /** Replaces a sealed key with its resealed form (rotation). Only if it is still exactly `before`. */
  async resealed(network: string, accountId: string, before: string, after: string, keyRef: string): Promise<boolean> {
    return (
      (await this.db.run("UPDATE signer_keys SET sealed_key = ?, key_ref = ?, updated_at = ? WHERE network = ? AND account_id = ? AND status = 'active' AND sealed_key = ?", [
        after,
        keyRef,
        this.now(),
        network,
        accountId,
        before,
      ])) === 1
    )
  }

  // ─── authenticated requests ───────────────────────────────────────────────

  /** Records a request nonce; false when it was seen before (a replay). */
  async firstUse(nonce: string, expiresAt: number): Promise<boolean> {
    return (await this.db.run('INSERT INTO signer_request_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING', [nonce, expiresAt])) === 1
  }

  async prune(): Promise<void> {
    const t = this.now()
    await this.db.run('DELETE FROM signer_request_nonces WHERE expires_at < ?', [t])
    await this.db.run('DELETE FROM signer_challenges WHERE expires_at < ?', [t - 7 * 86_400_000])
    await this.db.run('DELETE FROM signer_tg_requests WHERE expires_at < ?', [t - 7 * 86_400_000])
  }

  // ─── challenges ───────────────────────────────────────────────────────────

  async createChallenge(c: Omit<Challenge, 'attempts' | 'createdAt' | 'usedAt'>): Promise<Challenge> {
    const id = c.id
    const t = this.now()
    await this.db.run(
      `INSERT INTO signer_challenges (id, kind, network, account_id, owner_account, destination, recipient_key, message, nonce, recipient, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.kind, c.network, c.accountId, c.ownerAccount, c.destination, c.recipientKey, c.message, c.nonce, c.recipient, t, c.expiresAt],
    )
    return (await this.challenge(id)) as Challenge
  }

  async challenge(id: string): Promise<Challenge | null> {
    const r = await this.db.get<ChallengeRow>('SELECT * FROM signer_challenges WHERE id = ?', [id])
    return r ? toChallenge(r) : null
  }

  async bumpAttempt(id: string): Promise<void> {
    await this.db.run('UPDATE signer_challenges SET attempts = attempts + 1 WHERE id = ?', [id])
  }

  /** Marks a challenge used, once: only if unused and unexpired. */
  async useChallenge(id: string, key: string): Promise<boolean> {
    const t = this.now()
    return (await this.db.run('UPDATE signer_challenges SET used_at = ?, used_key = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?', [t, key, id, t])) === 1
  }

  async countChallengesSince(network: string, owner: string, since: number): Promise<number> {
    return (
      (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM signer_challenges WHERE network = ? AND owner_account = ? AND created_at >= ?', [network, owner, since]))?.n ?? 0
    )
  }

  // ─── withdrawal destinations ──────────────────────────────────────────────

  /** Records an approval. An already approved destination keeps its first approval (returns it). */
  async addDestination(d: Omit<Destination, 'id' | 'approvedAt' | 'revokedAt'>): Promise<Destination> {
    const t = this.now()
    try {
      await this.db.attempt(() =>
        this.db.run(
          `INSERT INTO signer_destinations (id, network, account_id, destination, owner_account, public_key, challenge_id, message, nonce, recipient, signature, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomToken(12), d.network, d.accountId, d.destination, d.ownerAccount, d.publicKey, d.challengeId, d.message, d.nonce, d.recipient, d.signature, t],
        ),
      )
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
    }
    return (await this.liveDestination(d.network, d.accountId, d.destination)) as Destination
  }

  async liveDestination(network: string, accountId: string, destination: string): Promise<Destination | null> {
    const r = await this.db.get<DestinationRow>('SELECT * FROM signer_destinations WHERE network = ? AND account_id = ? AND destination = ? AND revoked_at IS NULL', [
      network,
      accountId,
      destination,
    ])
    return r ? toDestination(r) : null
  }

  async destinations(network: string, accountId: string): Promise<Destination[]> {
    return (
      await this.db.all<DestinationRow>('SELECT * FROM signer_destinations WHERE network = ? AND account_id = ? AND revoked_at IS NULL ORDER BY approved_at', [network, accountId])
    ).map(toDestination)
  }

  async revokeDestination(network: string, accountId: string, destination: string): Promise<boolean> {
    return (
      (await this.db.run('UPDATE signer_destinations SET revoked_at = ? WHERE network = ? AND account_id = ? AND destination = ? AND revoked_at IS NULL', [
        this.now(),
        network,
        accountId,
        destination,
      ])) === 1
    )
  }

  // ─── Telegram approvals (wallets with no owner wallet) ─────────────────────

  async createTelegramRequest(r: Omit<TelegramRequest, 'attempts' | 'createdAt' | 'usedAt'>): Promise<TelegramRequest> {
    await this.db.run(
      `INSERT INTO signer_tg_requests (id, digest, kind, network, account_id, user_id, target, target_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.digest, r.kind, r.network, r.accountId, r.userId, r.target, r.targetKey, this.now(), r.expiresAt],
    )
    return (await this.telegramRequestByDigest(r.digest)) as TelegramRequest
  }

  async telegramRequestByDigest(digest: string): Promise<TelegramRequest | null> {
    const r = await this.db.get<TelegramRequestRow>('SELECT * FROM signer_tg_requests WHERE digest = ?', [digest])
    return r ? toTelegramRequest(r) : null
  }

  async bumpTelegramAttempt(id: string): Promise<void> {
    await this.db.run('UPDATE signer_tg_requests SET attempts = attempts + 1 WHERE id = ?', [id])
  }

  /** Marks a request used, once: only if unused and unexpired. */
  async useTelegramRequest(id: string): Promise<boolean> {
    const t = this.now()
    return (await this.db.run('UPDATE signer_tg_requests SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?', [t, id, t])) === 1
  }

  async countTelegramRequestsSince(network: string, accountId: string, since: number): Promise<number> {
    return (
      (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM signer_tg_requests WHERE network = ? AND account_id = ? AND created_at >= ?', [network, accountId, since]))?.n ??
      0
    )
  }

  /** Records an approval. An address already approved keeps its first approval (returned). */
  async addTelegramApproval(a: Omit<TelegramApproval, 'id' | 'approvedAt' | 'revokedAt'>): Promise<TelegramApproval> {
    try {
      await this.db.attempt(() =>
        this.db.run(
          `INSERT INTO signer_tg_approvals (id, network, account_id, destination, user_id, request_id, request_expires_at, init_data, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomToken(12), a.network, a.accountId, a.destination, a.userId, a.requestId, a.requestExpiresAt, a.initData, this.now()],
        ),
      )
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
    }
    return (await this.liveTelegramApproval(a.network, a.accountId, a.destination)) as TelegramApproval
  }

  async liveTelegramApproval(network: string, accountId: string, destination: string): Promise<TelegramApproval | null> {
    const r = await this.db.get<TelegramApprovalRow>('SELECT * FROM signer_tg_approvals WHERE network = ? AND account_id = ? AND destination = ? AND revoked_at IS NULL', [
      network,
      accountId,
      destination,
    ])
    return r ? toTelegramApproval(r) : null
  }

  async telegramApprovals(network: string, accountId: string): Promise<TelegramApproval[]> {
    return (
      await this.db.all<TelegramApprovalRow>('SELECT * FROM signer_tg_approvals WHERE network = ? AND account_id = ? AND revoked_at IS NULL ORDER BY approved_at', [
        network,
        accountId,
      ])
    ).map(toTelegramApproval)
  }

  /** Revokes one address (`destination`) or all of a wallet's Telegram approvals. Returns how many. */
  async revokeTelegramApprovals(network: string, accountId: string, destination?: string): Promise<number> {
    const t = this.now()
    return destination === undefined
      ? this.db.run('UPDATE signer_tg_approvals SET revoked_at = ? WHERE network = ? AND account_id = ? AND revoked_at IS NULL', [t, network, accountId])
      : this.db.run('UPDATE signer_tg_approvals SET revoked_at = ? WHERE network = ? AND account_id = ? AND destination = ? AND revoked_at IS NULL', [
          t,
          network,
          accountId,
          destination,
        ])
  }

  // ─── signatures ───────────────────────────────────────────────────────────

  async signature(intentId: string, step: number): Promise<SignatureRecord | null> {
    const r = await this.db.get<SignatureRow>('SELECT * FROM signer_signatures WHERE intent_id = ? AND step = ?', [intentId, step])
    return r ? toSignature(r) : null
  }

  /**
   * Records the one signature of (intent, step). If another signature of that step exists
   * (a concurrent request), that one is returned and this one must not be released.
   */
  async recordSignature(s: Omit<SignatureRecord, 'createdAt'>): Promise<SignatureRecord> {
    try {
      await this.db.attempt(() =>
        this.db.run('INSERT INTO signer_signatures (intent_id, step, network, account_id, tx_hash, signed, nonce, op_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.intentId,
          s.step,
          s.network,
          s.accountId,
          s.txHash,
          s.signed,
          s.nonce,
          s.opKind,
          this.now(),
        ]),
      )
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
    }
    return (await this.signature(s.intentId, s.step)) as SignatureRecord
  }

  // ─── events and state ─────────────────────────────────────────────────────

  async event(kind: string, e: { network?: string | null; accountId?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
    await this.db.run('INSERT INTO signer_events (at, kind, network, account_id, detail) VALUES (?, ?, ?, ?, ?)', [
      this.now(),
      kind,
      e.network ?? null,
      e.accountId ?? null,
      json(e.detail ?? {}),
    ])
  }

  async events(network: string, accountId: string): Promise<{ kind: string; at: number; detail: Record<string, unknown> }[]> {
    return (
      await this.db.all<{ kind: string; at: number; detail: string }>('SELECT kind, at, detail FROM signer_events WHERE network = ? AND account_id = ? ORDER BY id', [
        network,
        accountId,
      ])
    ).map((r) => ({ kind: r.kind, at: r.at, detail: JSON.parse(r.detail) as Record<string, unknown> }))
  }

  async recentEvents(limit = 100): Promise<{ kind: string; at: number; network: string | null; accountId: string | null; detail: Record<string, unknown> }[]> {
    return (
      await this.db.all<{ kind: string; at: number; network: string | null; account_id: string | null; detail: string }>(
        'SELECT kind, at, network, account_id, detail FROM signer_events ORDER BY id DESC LIMIT ?',
        [limit],
      )
    ).map((r) => ({ kind: r.kind, at: r.at, network: r.network, accountId: r.account_id, detail: JSON.parse(r.detail) as Record<string, unknown> }))
  }

  async getState(key: string): Promise<string | null> {
    return (await this.db.get<{ value: string }>('SELECT value FROM signer_state WHERE key = ?', [key]))?.value ?? null
  }

  async setState(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO signer_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, this.now()],
    )
  }
}
