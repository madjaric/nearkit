import { isUniqueViolation, type Database } from '../db/database'
import { randomToken } from '../ids'
import { MAX_ACTIVE_WALLETS_PER_USER } from './limits'

/**
 * What the app keeps about trading wallets: the wallet (its address, public key and
 * owner; never its key, which only the signer holds, signer/store.ts), every confirmed
 * intent, every transaction signed for it (saved before it is sent) and a security
 * log. Nothing here is a secret: signed transactions are public once broadcast, and the
 * log holds IDs, accounts, hashes and amounts only.
 */

export type WalletStatus = 'active' | 'revoked' | 'deleted'

export interface TradingWallet {
  id: string
  userId: number
  network: string
  accountId: string
  /** NearKit's key on the account (public part). The key itself is in the signer's vault. */
  publicKey: string
  /** The KEK the signer sealed the key with when it was made (public reference). */
  keyRef: string
  status: WalletStatus
  /** The user's own public key, once it is confirmed on the account as a full-access backup key. */
  backupKey: string | null
  /**
   * The owner: the linked wallet (and its NEP-413-verified full-access key) this wallet was
   * created with. Export, the backup key and removing NearKit's key answer to it alone.
   */
  ownerAccount: string | null
  ownerKey: string | null
  /** Its place among the user's active wallets, 1..MAX_ACTIVE_WALLETS_PER_USER (1 shows as "Main"). */
  slot: number
  /** A name the user gave it, or null. */
  label: string | null
  /** Frozen by the operator (npm run ops): no trades or withdrawals; its owner can still add the backup key and export. */
  frozenAt: number | null
  frozenReason: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

/** The user already has MAX_ACTIVE_WALLETS_PER_USER active wallets on this network. */
export class ActiveWalletLimitError extends Error {
  constructor() {
    super(`You can have at most ${MAX_ACTIVE_WALLETS_PER_USER} NearKit wallets at once. Delete or empty one first.`)
    this.name = 'ActiveWalletLimitError'
  }
}

export type IntentKind = 'buy' | 'sell' | 'withdraw' | 'unwrap' | 'backup-key' | 'revoke'
export type IntentStatus = 'quoted' | 'confirmed' | 'signing' | 'submitted' | 'done' | 'failed' | 'cancelled' | 'expired' | 'replaced'

/** An intent in these states may have, or be about to have, a transaction in flight. */
export const IN_FLIGHT: readonly IntentStatus[] = ['confirmed', 'signing', 'submitted']
export const FINAL_STATUSES: readonly IntentStatus[] = ['done', 'failed', 'cancelled', 'expired', 'replaced']

export interface Intent<P = Record<string, unknown>, Q = Record<string, unknown>> {
  id: string
  walletId: string
  userId: number
  chatId: number
  kind: IntentKind
  params: P
  quote: Q | null
  status: IntentStatus
  expiresAt: number
  result: IntentResult | null
  replacedBy: string | null
  /** The server instance running it while in flight, and until when (its execution lease). */
  leaseOwner: string | null
  leaseUntil: number | null
  /** Intents one confirmation covers (a trade prepared on NearKit web, one per wallet); null for a single one. */
  groupId: string | null
  createdAt: number
  updatedAt: number
}

export interface IntentResult {
  ok: boolean
  /** Short, user-facing. Never a stack trace or a secret. */
  message: string
  hashes: string[]
  /** Public amounts read from chain, raw units as strings. */
  facts?: Record<string, unknown>
}

/** `unconfirmed`: past expiry, the key's nonce moved, yet the chain returns no such transaction; it may have gone through. */
export type TxStatus = 'signed' | 'submitted' | 'success' | 'failed' | 'expired' | 'unconfirmed'

export interface WalletTx {
  intentId: string
  step: number
  hash: string
  signerId: string
  receiverId: string
  nonce: bigint
  expiresHeight: number
  /** Base64 of the signed transaction. */
  signed: string
  plan: unknown
  status: TxStatus
  outcome: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface RecoveryRequest {
  codeHash: string
  userId: number
  walletId: string
  network: string
  nonce: string
  message: string
  createdAt: number
  expiresAt: number
  attempts: number
  verifiedAt: number | null
  verifiedAccount: string | null
  exportedAt: number | null
}

export type ConfirmRefusal = 'unknown' | 'not-yours' | 'expired' | 'busy' | 'not-open' | 'wallet'

/**
 * The execution lease on an intent passed to someone else (it expired while this
 * instance was busy, and another took over). Stop at once: sign and send nothing more.
 */
export class LeaseLostError extends Error {
  constructor(intentId: string) {
    super(`Lost the execution lease on intent ${intentId}`)
    this.name = 'LeaseLostError'
  }
}

/** How long an execution lease lasts without renewal. The executor renews it at every step. */
export const EXECUTION_LEASE_MS = 120_000

const parse = <T>(text: string | null): T | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

interface WalletRow {
  id: string
  user_id: number
  network: string
  account_id: string
  public_key: string
  sealed_key: string | null
  key_ref: string
  status: WalletStatus
  backup_key: string | null
  owner_account: string | null
  owner_key: string | null
  slot: number
  label: string | null
  create_key: string | null
  frozen_at: number | null
  frozen_reason: string | null
  created_at: number
  updated_at: number
  closed_at: number | null
}

const toWallet = (r: WalletRow): TradingWallet => ({
  id: r.id,
  userId: r.user_id,
  network: r.network,
  accountId: r.account_id,
  publicKey: r.public_key,
  keyRef: r.key_ref,
  status: r.status,
  backupKey: r.backup_key,
  ownerAccount: r.owner_account,
  ownerKey: r.owner_key,
  slot: r.slot,
  label: r.label,
  frozenAt: r.frozen_at ?? null,
  frozenReason: r.frozen_reason ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
})

interface IntentRow {
  id: string
  wallet_id: string
  user_id: number
  chat_id: number
  kind: IntentKind
  params: string
  quote: string | null
  status: IntentStatus
  expires_at: number
  result: string | null
  replaced_by: string | null
  lease_owner: string | null
  lease_until: number | null
  group_id: string | null
  created_at: number
  updated_at: number
}

const toIntent = (r: IntentRow): Intent => ({
  id: r.id,
  walletId: r.wallet_id,
  userId: r.user_id,
  chatId: r.chat_id,
  kind: r.kind,
  params: parse<Record<string, unknown>>(r.params) ?? {},
  quote: parse<Record<string, unknown>>(r.quote),
  status: r.status,
  expiresAt: r.expires_at,
  result: parse<IntentResult>(r.result),
  replacedBy: r.replaced_by,
  leaseOwner: r.lease_owner,
  leaseUntil: r.lease_until,
  groupId: r.group_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface TxRow {
  intent_id: string
  step: number
  hash: string
  signer_id: string
  receiver_id: string
  nonce: string
  expires_height: number
  signed: string
  plan: string
  status: TxStatus
  outcome: string | null
  created_at: number
  updated_at: number
}

const toTx = (r: TxRow): WalletTx => ({
  intentId: r.intent_id,
  step: r.step,
  hash: r.hash,
  signerId: r.signer_id,
  receiverId: r.receiver_id,
  nonce: BigInt(r.nonce),
  expiresHeight: r.expires_height,
  signed: r.signed,
  plan: parse<unknown>(r.plan),
  status: r.status,
  outcome: parse<Record<string, unknown>>(r.outcome),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ')

export class CustodyStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── wallets ──────────────────────────────────────────────────────────────

  /**
   * Saves a new wallet in the user's lowest free slot. `createKey` (the Create button's
   * one-time key) makes creation idempotent: a double tap, a replayed update or two
   * instances handling the same press get the same wallet, and the second key material
   * is simply never stored. The database refuses an 11th active wallet (slot CHECK and
   * a unique index per active slot), so no race gets past the limit either.
   */
  async createWallet(w: {
    userId: number
    network: string
    accountId: string
    publicKey: string
    keyRef: string
    owner?: { accountId: string; publicKey: string } | null
    createKey?: string | null
  }): Promise<{ wallet: TradingWallet; created: boolean }> {
    // A lost race for a slot (another creation took it) just tries the next one.
    for (let attempt = 0; attempt < MAX_ACTIVE_WALLETS_PER_USER; attempt++) {
      const result = await this.db.tx(async () => {
        if (w.createKey) {
          const same = await this.walletByCreateKey(w.userId, w.createKey)
          if (same) return { wallet: same, created: false }
        }
        const used = new Set((await this.activeWallets(w.userId, w.network)).map((x) => x.slot))
        const slot = Array.from({ length: MAX_ACTIVE_WALLETS_PER_USER }, (_, i) => i + 1).find((n) => !used.has(n))
        if (slot === undefined) throw new ActiveWalletLimitError()
        const id = randomToken(12)
        const t = this.now()
        try {
          await this.db.attempt(() =>
            this.db.run(
              `INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, key_ref, status, owner_account, owner_key, slot, create_key, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
              [id, w.userId, w.network, w.accountId, w.publicKey, w.keyRef, w.owner?.accountId ?? null, w.owner?.publicKey ?? null, slot, w.createKey ?? null, t, t],
            ),
          )
        } catch (e) {
          if (!isUniqueViolation(e)) throw e
          // A race lost to another creation: it used this key (then that wallet is the answer)
          // or took this slot (then try the next free one). Anything else is a real error.
          if (w.createKey) {
            const same = await this.walletByCreateKey(w.userId, w.createKey)
            if (same) return { wallet: same, created: false }
          }
          if ((await this.activeWallets(w.userId, w.network)).some((x) => x.slot === slot)) return null
          throw e
        }
        await this.audit({
          userId: w.userId,
          walletId: id,
          action: 'wallet-created',
          detail: { network: w.network, accountId: w.accountId, publicKey: w.publicKey, keyRef: w.keyRef, owner: w.owner?.accountId ?? null, slot },
        })
        return { wallet: (await this.wallet(id)) as TradingWallet, created: true }
      })
      if (result) return result
    }
    throw new ActiveWalletLimitError()
  }

  async walletByCreateKey(userId: number, createKey: string): Promise<TradingWallet | null> {
    const r = await this.db.get<WalletRow>('SELECT * FROM trading_wallets WHERE user_id = ? AND create_key = ?', [userId, createKey])
    return r ? toWallet(r) : null
  }

  async wallet(id: string): Promise<TradingWallet | null> {
    const r = await this.db.get<WalletRow>('SELECT * FROM trading_wallets WHERE id = ?', [id])
    return r ? toWallet(r) : null
  }

  /** The user's active wallets on this network, in slot order (Main first). */
  /** The user's active wallets, in the order they put them in (wallets never ordered follow, by slot). */
  async activeWallets(userId: number, network: string): Promise<TradingWallet[]> {
    return (
      await this.db.all<WalletRow>(
        "SELECT * FROM trading_wallets WHERE user_id = ? AND network = ? AND status = 'active' ORDER BY (display_order IS NULL), display_order, slot",
        [userId, network],
      )
    ).map(toWallet)
  }

  /**
   * Lists the user's active wallets in this order. `walletIds` must be exactly those wallets,
   * each once; false (and nothing changes) otherwise. Only the listing order changes: no
   * wallet's account, key, owner, slot or name.
   */
  async setDisplayOrder(userId: number, network: string, walletIds: readonly string[]): Promise<boolean> {
    return this.db.tx(async () => {
      const active = (await this.activeWallets(userId, network)).map((w) => w.id)
      const exact = walletIds.length === active.length && new Set(walletIds).size === walletIds.length && walletIds.every((id) => active.includes(id))
      if (!exact) return false
      const t = this.now()
      for (const [i, id] of walletIds.entries()) await this.db.run('UPDATE trading_wallets SET display_order = ?, updated_at = ? WHERE id = ? AND user_id = ?', [i + 1, t, id, userId])
      return true
    })
  }

  /** The wallet `walletId` if it is `userId`'s and active; null otherwise (another user's, closed or unknown). */
  async ownedWallet(userId: number, walletId: string): Promise<TradingWallet | null> {
    const w = await this.wallet(walletId)
    return w && w.userId === userId && w.status === 'active' ? w : null
  }

  /** Renames a wallet (null gives it back its default name). */
  async setLabel(walletId: string, label: string | null): Promise<void> {
    await this.db.run('UPDATE trading_wallets SET label = ?, updated_at = ? WHERE id = ?', [label, this.now(), walletId])
  }

  /** Wallets a user created since `since`, closed ones included. */
  async countWalletsSince(userId: number, since: number): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trading_wallets WHERE user_id = ? AND created_at >= ?', [userId, since]))?.n ?? 0
  }

  async walletByAccount(network: string, accountId: string): Promise<TradingWallet | null> {
    const r = await this.db.get<WalletRow>('SELECT * FROM trading_wallets WHERE network = ? AND account_id = ?', [network, accountId])
    return r ? toWallet(r) : null
  }

  /** Freezes (reason) or unfreezes (null) a wallet. */
  async setFrozen(walletId: string, reason: string | null): Promise<boolean> {
    const t = this.now()
    return (await this.db.run('UPDATE trading_wallets SET frozen_at = ?, frozen_reason = ?, updated_at = ? WHERE id = ?', [reason === null ? null : t, reason, t, walletId])) === 1
  }

  /** Wallets closed since `since` (their keys should be erased by the signer). */
  async closedSince(since: number): Promise<TradingWallet[]> {
    return (await this.db.all<WalletRow>("SELECT * FROM trading_wallets WHERE status IN ('revoked', 'deleted') AND closed_at >= ? ORDER BY closed_at", [since])).map(toWallet)
  }

  /**
   * A wallet with no owner wallet got its first owner (the signer bound it, and resealed its
   * key to it). Only if it has none here yet: an owner is never replaced.
   */
  async setOwner(walletId: string, owner: string, ownerKey: string | null): Promise<boolean> {
    return (
      (await this.db.run('UPDATE trading_wallets SET owner_account = ?, owner_key = ?, updated_at = ? WHERE id = ? AND owner_account IS NULL', [
        owner,
        ownerKey,
        this.now(),
        walletId,
      ])) === 1
    )
  }

  async setBackupKey(walletId: string, publicKey: string | null): Promise<void> {
    await this.db.run('UPDATE trading_wallets SET backup_key = ?, updated_at = ? WHERE id = ?', [publicKey, this.now(), walletId])
  }

  /**
   * Ends a wallet here. The signer erases its sealed key for good (crypto-shredding) on its
   * own, once the chain shows the key controls nothing (signer.eraseKey). `sealed_key` is
   * a column from before the signer, cleared for good measure.
   */
  async closeWallet(walletId: string, status: 'revoked' | 'deleted', detail: Record<string, unknown> = {}): Promise<boolean> {
    return this.db.tx(async () => {
      const w = await this.wallet(walletId)
      if (!w || w.status !== 'active') return false
      const t = this.now()
      await this.db.run('UPDATE trading_wallets SET status = ?, sealed_key = NULL, closed_at = ?, updated_at = ? WHERE id = ?', [status, t, t, walletId])
      await this.audit({ userId: w.userId, walletId, action: status === 'revoked' ? 'wallet-revoked' : 'wallet-deleted', detail: { accountId: w.accountId, ...detail } })
      return true
    })
  }

  // ─── intents ──────────────────────────────────────────────────────────────

  async createIntent(i: {
    walletId: string
    userId: number
    chatId: number
    kind: IntentKind
    params: unknown
    quote?: unknown
    ttlMs: number
    /** One confirmation for several intents (see Intent.groupId). */
    groupId?: string | null
  }): Promise<Intent> {
    const id = randomToken(12)
    const t = this.now()
    await this.db.run(
      `INSERT INTO wallet_intents (id, wallet_id, user_id, chat_id, kind, params, quote, status, expires_at, created_at, updated_at, group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?, ?)`,
      [id, i.walletId, i.userId, i.chatId, i.kind, JSON.stringify(i.params), i.quote === undefined ? null : JSON.stringify(i.quote), t + i.ttlMs, t, t, i.groupId ?? null],
    )
    return (await this.intent(id)) as Intent
  }

  /** The intents one confirmation covers, in their wallets' order (a group has one per wallet). */
  async intentsOfGroup(groupId: string): Promise<Intent[]> {
    return (
      await this.db.all<IntentRow>('SELECT i.* FROM wallet_intents i JOIN trading_wallets w ON w.id = i.wallet_id WHERE i.group_id = ? ORDER BY w.slot, i.created_at, i.id', [
        groupId,
      ])
    ).map(toIntent)
  }

  /** Quotes of this wallet still waiting for a Confirm. */
  async quotedOf(walletId: string): Promise<Intent[]> {
    return (await this.db.all<IntentRow>("SELECT * FROM wallet_intents WHERE wallet_id = ? AND status = 'quoted' ORDER BY created_at, id", [walletId])).map(toIntent)
  }

  /** Cancels the group's quotes still waiting, for their own user only; how many. */
  async cancelGroup(groupId: string, userId: number): Promise<number> {
    return this.db.run("UPDATE wallet_intents SET status = 'cancelled', updated_at = ? WHERE group_id = ? AND user_id = ? AND status = 'quoted'", [this.now(), groupId, userId])
  }

  async intent(id: string): Promise<Intent | null> {
    const r = await this.db.get<IntentRow>('SELECT * FROM wallet_intents WHERE id = ?', [id])
    return r ? toIntent(r) : null
  }

  /**
   * The Confirm button, atomically: only the user it belongs to, only while quoted
   * and unexpired, only while nothing else of this wallet is in flight. A second
   * press finds it no longer quoted and changes nothing. The confirming instance
   * gets the execution lease (`lease.owner`): it alone may sign for the intent.
   *
   * The database decides, not a process: the move from quoted is a compare-and-set,
   * and a unique index allows one intent in flight per wallet, so two server
   * instances confirming at once can't both win.
   */
  async confirmIntent(
    id: string,
    userId: number,
    lease: { owner: string; ms: number } = { owner: 'local', ms: EXECUTION_LEASE_MS },
  ): Promise<{ ok: true; intent: Intent } | { ok: false; reason: ConfirmRefusal; intent: Intent | null }> {
    return this.db.tx(async () => {
      const intent = await this.intent(id)
      if (!intent) return { ok: false, reason: 'unknown', intent: null }
      if (intent.userId !== userId) return { ok: false, reason: 'not-yours', intent: null }
      if (intent.status !== 'quoted') return { ok: false, reason: 'not-open', intent }
      if (this.now() > intent.expiresAt) {
        await this.setStatus(id, ['quoted'], 'expired')
        return { ok: false, reason: 'expired', intent: await this.intent(id) }
      }
      const wallet = await this.wallet(intent.walletId)
      if (!wallet || wallet.status !== 'active') return { ok: false, reason: 'wallet', intent }
      if ((await this.inFlight(intent.walletId)).length) return { ok: false, reason: 'busy', intent }
      const t = this.now()
      let moved: number
      try {
        moved = await this.db.attempt(() =>
          this.db.run("UPDATE wallet_intents SET status = 'confirmed', lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'quoted'", [
            lease.owner,
            t + lease.ms,
            t,
            id,
          ]),
        )
      } catch (e) {
        // Another intent of this wallet went in flight a moment ago (on another instance).
        if (isUniqueViolation(e)) return { ok: false, reason: 'busy', intent }
        throw e
      }
      if (moved !== 1) return { ok: false, reason: 'not-open', intent: await this.intent(id) }
      await this.audit({ userId, walletId: intent.walletId, action: 'intent-confirmed', detail: { intent: id, kind: intent.kind, params: intent.params } })
      return { ok: true, intent: (await this.intent(id)) as Intent }
    })
  }

  /** Moves an intent forward only from one of `from`. True when it moved. */
  async setStatus(id: string, from: readonly IntentStatus[], to: IntentStatus, patch: { result?: IntentResult; replacedBy?: string } = {}): Promise<boolean> {
    const sets = ['status = ?', 'updated_at = ?']
    const params: (string | number | null)[] = [to, this.now()]
    if (patch.result) {
      sets.push('result = ?')
      params.push(JSON.stringify(patch.result))
    }
    if (patch.replacedBy) {
      sets.push('replaced_by = ?')
      params.push(patch.replacedBy)
    }
    return (await this.db.run(`UPDATE wallet_intents SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from.length)})`, [...params, id, ...from])) === 1
  }

  async inFlight(walletId: string): Promise<Intent[]> {
    return (
      await this.db.all<IntentRow>(`SELECT * FROM wallet_intents WHERE wallet_id = ? AND status IN (${placeholders(IN_FLIGHT.length)}) ORDER BY created_at`, [
        walletId,
        ...IN_FLIGHT,
      ])
    ).map(toIntent)
  }

  /** Every intent that may have something on its way to the chain. */
  async allInFlight(): Promise<Intent[]> {
    return (await this.db.all<IntentRow>(`SELECT * FROM wallet_intents WHERE status IN (${placeholders(IN_FLIGHT.length)}) ORDER BY created_at`, [...IN_FLIGHT])).map(toIntent)
  }

  /** In-flight intents nobody is running: no lease, or an expired one (the resolver's work list). */
  async unattended(): Promise<Intent[]> {
    return (
      await this.db.all<IntentRow>(
        `SELECT * FROM wallet_intents WHERE status IN (${placeholders(IN_FLIGHT.length)}) AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < ?) ORDER BY created_at`,
        [...IN_FLIGHT, this.now()],
      )
    ).map(toIntent)
  }

  // ─── execution leases ─────────────────────────────────────────────────────

  /** Takes an unattended in-flight intent (no lease, or an expired one). True for exactly one taker. */
  async claimIntent(id: string, owner: string, ms: number): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run(
        `UPDATE wallet_intents SET lease_owner = ?, lease_until = ? WHERE id = ? AND status IN (${placeholders(IN_FLIGHT.length)})
           AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < ?)`,
        [owner, t + ms, id, ...IN_FLIGHT, t],
      )) === 1
    )
  }

  /** Extends `owner`'s lease. False when it no longer holds it: then it must stop. */
  async renewLease(id: string, owner: string, ms: number): Promise<boolean> {
    return (
      (await this.db.run(`UPDATE wallet_intents SET lease_until = ? WHERE id = ? AND lease_owner = ? AND status IN (${placeholders(IN_FLIGHT.length)})`, [
        this.now() + ms,
        id,
        owner,
        ...IN_FLIGHT,
      ])) === 1
    )
  }

  /** Gives the lease up (the intent is settled, or handed to the resolver). */
  async releaseLease(id: string, owner: string): Promise<void> {
    await this.db.run('UPDATE wallet_intents SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', [id, owner])
  }

  /**
   * A new quote replaces the wallet's older open ones of the same kinds, so two
   * Confirm buttons on screen can never both trade.
   */
  async cancelQuoted(walletId: string, kinds: readonly IntentKind[]): Promise<number> {
    return this.db.run(`UPDATE wallet_intents SET status = 'cancelled', updated_at = ? WHERE wallet_id = ? AND status = 'quoted' AND kind IN (${placeholders(kinds.length)})`, [
      this.now(),
      walletId,
      ...kinds,
    ])
  }

  /** Quotes nobody confirmed in time. */
  async expireQuotes(): Promise<number> {
    return this.db.run("UPDATE wallet_intents SET status = 'expired', updated_at = ? WHERE status = 'quoted' AND expires_at < ?", [this.now(), this.now()])
  }

  // ─── signed transactions ──────────────────────────────────────────────────

  /**
   * Saves a signed transaction before it is sent, and marks the intent as signing, in
   * one write, only while `owner` holds the intent's execution lease (it is extended
   * too). Otherwise it throws LeaseLostError and nothing is recorded: the caller must
   * not send. The lease check comes first, so a resolver that took the intent over
   * either sees this transaction or makes this write fail.
   */
  async recordSigned(t: {
    intentId: string
    step: number
    hash: string
    signerId: string
    receiverId: string
    nonce: bigint
    expiresHeight: number
    signed: string
    plan: unknown
    owner: string
    leaseMs?: number
  }): Promise<void> {
    await this.db.tx(async () => {
      const at = this.now()
      const held = await this.db.run(
        "UPDATE wallet_intents SET status = 'signing', lease_until = ?, updated_at = ? WHERE id = ? AND status IN ('confirmed', 'signing') AND lease_owner = ?",
        [at + (t.leaseMs ?? EXECUTION_LEASE_MS), at, t.intentId, t.owner],
      )
      if (held !== 1) throw new LeaseLostError(t.intentId)
      await this.db.run(
        `INSERT INTO wallet_txs (intent_id, step, hash, signer_id, receiver_id, nonce, expires_height, signed, plan, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)`,
        [t.intentId, t.step, t.hash, t.signerId, t.receiverId, t.nonce.toString(), t.expiresHeight, t.signed, JSON.stringify(t.plan), at, at],
      )
    })
  }

  async markTx(intentId: string, step: number, status: TxStatus, outcome?: Record<string, unknown>): Promise<void> {
    await this.db.run('UPDATE wallet_txs SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE intent_id = ? AND step = ?', [
      status,
      outcome ? JSON.stringify(outcome) : null,
      this.now(),
      intentId,
      step,
    ])
  }

  /**
   * Transactions still open (sent, not final) of intents already done: trades reported when
   * their tokens arrived, whose chain settlement is filed later. Oldest first.
   */
  async settlingTxs(limit = 50): Promise<(WalletTx & { userId: number; walletId: string })[]> {
    const rows = await this.db.all<TxRow & { user_id: number; wallet_id: string }>(
      `SELECT t.*, i.user_id AS user_id, i.wallet_id AS wallet_id FROM wallet_txs t JOIN wallet_intents i ON i.id = t.intent_id
       WHERE t.status IN ('signed', 'submitted') AND i.status = 'done' ORDER BY t.created_at LIMIT ?`,
      [limit],
    )
    return rows.map((r) => ({ ...toTx(r), userId: r.user_id, walletId: r.wallet_id }))
  }

  /** Files an open transaction's final outcome once: false when it was no longer open (another instance filed it). */
  async settleTx(intentId: string, step: number, status: 'success' | 'failed', outcome: Record<string, unknown>): Promise<boolean> {
    const moved = await this.db.run("UPDATE wallet_txs SET status = ?, outcome = ?, updated_at = ? WHERE intent_id = ? AND step = ? AND status IN ('signed', 'submitted')", [
      status,
      JSON.stringify(outcome),
      this.now(),
      intentId,
      step,
    ])
    return moved === 1
  }

  async txsOf(intentId: string): Promise<WalletTx[]> {
    return (await this.db.all<TxRow>('SELECT * FROM wallet_txs WHERE intent_id = ? ORDER BY step', [intentId])).map(toTx)
  }

  // ─── audit ────────────────────────────────────────────────────────────────

  async audit(e: { userId?: number | null; walletId?: string | null; action: string; detail?: Record<string, unknown> }): Promise<void> {
    await this.db.run('INSERT INTO custody_audit (at, user_id, wallet_id, action, detail) VALUES (?, ?, ?, ?, ?)', [
      this.now(),
      e.userId ?? null,
      e.walletId ?? null,
      e.action,
      e.detail ? JSON.stringify(e.detail, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) : null,
    ])
  }

  async auditOf(walletId: string): Promise<{ action: string; at: number; detail: Record<string, unknown> | null }[]> {
    return (
      await this.db.all<{ action: string; at: number; detail: string | null }>('SELECT action, at, detail FROM custody_audit WHERE wallet_id = ? ORDER BY id', [walletId])
    ).map((r) => ({ action: r.action, at: r.at, detail: parse<Record<string, unknown>>(r.detail) }))
  }

  // ─── key export requests ──────────────────────────────────────────────────

  async createRecovery(r: { codeHash: string; userId: number; walletId: string; network: string; nonce: string; message: string; ttlMs: number }): Promise<RecoveryRequest> {
    const t = this.now()
    await this.db.run('INSERT INTO recovery_requests (code_hash, user_id, wallet_id, network, nonce, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      r.codeHash,
      r.userId,
      r.walletId,
      r.network,
      r.nonce,
      r.message,
      t,
      t + r.ttlMs,
    ])
    return (await this.recovery(r.codeHash)) as RecoveryRequest
  }

  async recovery(codeHash: string): Promise<RecoveryRequest | null> {
    const r = await this.db.get<{
      code_hash: string
      user_id: number
      wallet_id: string
      network: string
      nonce: string
      message: string
      created_at: number
      expires_at: number
      attempts: number
      verified_at: number | null
      verified_account: string | null
      exported_at: number | null
    }>('SELECT * FROM recovery_requests WHERE code_hash = ?', [codeHash])
    return r
      ? {
          codeHash: r.code_hash,
          userId: r.user_id,
          walletId: r.wallet_id,
          network: r.network,
          nonce: r.nonce,
          message: r.message,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          attempts: r.attempts,
          verifiedAt: r.verified_at,
          verifiedAccount: r.verified_account,
          exportedAt: r.exported_at,
        }
      : null
  }

  async bumpRecoveryAttempt(codeHash: string): Promise<void> {
    await this.db.run('UPDATE recovery_requests SET attempts = attempts + 1 WHERE code_hash = ?', [codeHash])
  }

  /** Records the verified owner signature; true only the first time. */
  async markRecoveryVerified(codeHash: string, accountId: string): Promise<boolean> {
    return (
      (await this.db.run('UPDATE recovery_requests SET verified_at = ?, verified_account = ? WHERE code_hash = ? AND verified_at IS NULL', [this.now(), accountId, codeHash])) === 1
    )
  }

  /** The key leaves the signer once per request: true only the first time. */
  async markExported(codeHash: string): Promise<boolean> {
    return (await this.db.run('UPDATE recovery_requests SET exported_at = ? WHERE code_hash = ? AND verified_at IS NOT NULL AND exported_at IS NULL', [this.now(), codeHash])) === 1
  }

  async countRecoveriesSince(userId: number, since: number): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_requests WHERE user_id = ? AND created_at >= ?', [userId, since]))?.n ?? 0
  }
}
