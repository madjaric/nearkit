import type { Db } from '../db/sqlite'
import { randomToken } from '../ids'

/**
 * What NearKit keeps about trading wallets: the wallet (with its key sealed),
 * every confirmed intent, every transaction signed for it (saved before it is
 * sent), a security log and key-export requests. Nothing here is a plain secret:
 * sealed keys are ciphertext, signed transactions are public once broadcast, and
 * the log holds IDs, accounts, hashes and amounts only.
 */

export type WalletStatus = 'active' | 'revoked' | 'deleted'

export interface TradingWallet {
  id: string
  userId: number
  network: string
  accountId: string
  /** NearKit's key on the account (public part). */
  publicKey: string
  /** JSON of a SealedSecret, or null once erased. */
  sealedKey: string | null
  keyRef: string
  status: WalletStatus
  /** The user's own public key, once it is confirmed on the account as a full-access backup key. */
  backupKey: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export type IntentKind = 'buy' | 'sell' | 'withdraw' | 'backup-key' | 'revoke'
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

export type TxStatus = 'signed' | 'submitted' | 'success' | 'failed' | 'expired'

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
  sealedKey: r.sealed_key,
  keyRef: r.key_ref,
  status: r.status,
  backupKey: r.backup_key,
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
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── wallets ──────────────────────────────────────────────────────────────

  /**
   * Saves a new wallet unless the user already has a live one on this network, in
   * which case that one is returned and the new key material is simply never stored.
   */
  createWallet(w: { userId: number; network: string; accountId: string; publicKey: string; sealedKey: string; keyRef: string }): { wallet: TradingWallet; created: boolean } {
    return this.db.tx(() => {
      const existing = this.activeWallet(w.userId, w.network)
      if (existing) return { wallet: existing, created: false }
      const id = randomToken(12)
      const t = this.now()
      this.db.run(
        `INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [id, w.userId, w.network, w.accountId, w.publicKey, w.sealedKey, w.keyRef, t, t],
      )
      this.audit({ userId: w.userId, walletId: id, action: 'wallet-created', detail: { network: w.network, accountId: w.accountId, publicKey: w.publicKey, keyRef: w.keyRef } })
      return { wallet: this.wallet(id) as TradingWallet, created: true }
    })
  }

  wallet(id: string): TradingWallet | null {
    const r = this.db.get<WalletRow>('SELECT * FROM trading_wallets WHERE id = ?', [id])
    return r ? toWallet(r) : null
  }

  activeWallet(userId: number, network: string): TradingWallet | null {
    const r = this.db.get<WalletRow>("SELECT * FROM trading_wallets WHERE user_id = ? AND network = ? AND status = 'active'", [userId, network])
    return r ? toWallet(r) : null
  }

  /** Wallets a user created since `since`, closed ones included. */
  countWalletsSince(userId: number, since: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trading_wallets WHERE user_id = ? AND created_at >= ?', [userId, since])?.n ?? 0
  }

  walletByAccount(network: string, accountId: string): TradingWallet | null {
    const r = this.db.get<WalletRow>('SELECT * FROM trading_wallets WHERE network = ? AND account_id = ?', [network, accountId])
    return r ? toWallet(r) : null
  }

  setBackupKey(walletId: string, publicKey: string | null): void {
    this.db.run('UPDATE trading_wallets SET backup_key = ?, updated_at = ? WHERE id = ?', [publicKey, this.now(), walletId])
  }

  /** Ends a wallet: NearKit's sealed key is erased for good (crypto-shredding). */
  closeWallet(walletId: string, status: 'revoked' | 'deleted', detail: Record<string, unknown> = {}): boolean {
    return this.db.tx(() => {
      const w = this.wallet(walletId)
      if (!w || w.status !== 'active') return false
      const t = this.now()
      this.db.run('UPDATE trading_wallets SET status = ?, sealed_key = NULL, closed_at = ?, updated_at = ? WHERE id = ?', [status, t, t, walletId])
      this.audit({ userId: w.userId, walletId, action: status === 'revoked' ? 'wallet-revoked' : 'wallet-deleted', detail: { accountId: w.accountId, ...detail } })
      return true
    })
  }

  // ─── intents ──────────────────────────────────────────────────────────────

  createIntent(i: { walletId: string; userId: number; chatId: number; kind: IntentKind; params: unknown; quote?: unknown; ttlMs: number }): Intent {
    const id = randomToken(12)
    const t = this.now()
    this.db.run(
      `INSERT INTO wallet_intents (id, wallet_id, user_id, chat_id, kind, params, quote, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?)`,
      [id, i.walletId, i.userId, i.chatId, i.kind, JSON.stringify(i.params), i.quote === undefined ? null : JSON.stringify(i.quote), t + i.ttlMs, t, t],
    )
    return this.intent(id) as Intent
  }

  intent(id: string): Intent | null {
    const r = this.db.get<IntentRow>('SELECT * FROM wallet_intents WHERE id = ?', [id])
    return r ? toIntent(r) : null
  }

  /**
   * The Confirm button, atomically: only the user it belongs to, only while quoted
   * and unexpired, only while nothing else of this wallet is in flight. A second
   * press finds it no longer quoted and changes nothing.
   */
  confirmIntent(id: string, userId: number): { ok: true; intent: Intent } | { ok: false; reason: ConfirmRefusal; intent: Intent | null } {
    return this.db.tx(() => {
      const intent = this.intent(id)
      if (!intent) return { ok: false, reason: 'unknown', intent: null }
      if (intent.userId !== userId) return { ok: false, reason: 'not-yours', intent: null }
      if (intent.status !== 'quoted') return { ok: false, reason: 'not-open', intent }
      if (this.now() > intent.expiresAt) {
        this.setStatus(id, ['quoted'], 'expired')
        return { ok: false, reason: 'expired', intent: this.intent(id) }
      }
      const wallet = this.wallet(intent.walletId)
      if (!wallet || wallet.status !== 'active') return { ok: false, reason: 'wallet', intent }
      if (this.inFlight(intent.walletId).length) return { ok: false, reason: 'busy', intent }
      this.setStatus(id, ['quoted'], 'confirmed')
      this.audit({ userId, walletId: intent.walletId, action: 'intent-confirmed', detail: { intent: id, kind: intent.kind, params: intent.params } })
      return { ok: true, intent: this.intent(id) as Intent }
    })
  }

  /** Moves an intent forward only from one of `from`. True when it moved. */
  setStatus(id: string, from: readonly IntentStatus[], to: IntentStatus, patch: { result?: IntentResult; replacedBy?: string } = {}): boolean {
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
    return this.db.run(`UPDATE wallet_intents SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from.length)})`, [...params, id, ...from]) === 1
  }

  inFlight(walletId: string): Intent[] {
    return this.db
      .all<IntentRow>(`SELECT * FROM wallet_intents WHERE wallet_id = ? AND status IN (${placeholders(IN_FLIGHT.length)}) ORDER BY created_at`, [walletId, ...IN_FLIGHT])
      .map(toIntent)
  }

  /** Every intent that may have something on its way to the chain, for the resolver. */
  allInFlight(): Intent[] {
    return this.db.all<IntentRow>(`SELECT * FROM wallet_intents WHERE status IN (${placeholders(IN_FLIGHT.length)}) ORDER BY created_at`, [...IN_FLIGHT]).map(toIntent)
  }

  /** Quotes nobody confirmed in time. */
  expireQuotes(): number {
    return this.db.run("UPDATE wallet_intents SET status = 'expired', updated_at = ? WHERE status = 'quoted' AND expires_at < ?", [this.now(), this.now()])
  }

  // ─── signed transactions ──────────────────────────────────────────────────

  /** Saves a signed transaction before it is sent, and marks the intent as signing, in one write. */
  recordSigned(t: {
    intentId: string
    step: number
    hash: string
    signerId: string
    receiverId: string
    nonce: bigint
    expiresHeight: number
    signed: string
    plan: unknown
  }): void {
    this.db.tx(() => {
      const at = this.now()
      this.db.run(
        `INSERT INTO wallet_txs (intent_id, step, hash, signer_id, receiver_id, nonce, expires_height, signed, plan, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)`,
        [t.intentId, t.step, t.hash, t.signerId, t.receiverId, t.nonce.toString(), t.expiresHeight, t.signed, JSON.stringify(t.plan), at, at],
      )
      this.setStatus(t.intentId, ['confirmed', 'signing'], 'signing')
    })
  }

  markTx(intentId: string, step: number, status: TxStatus, outcome?: Record<string, unknown>): void {
    this.db.run('UPDATE wallet_txs SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE intent_id = ? AND step = ?', [
      status,
      outcome ? JSON.stringify(outcome) : null,
      this.now(),
      intentId,
      step,
    ])
  }

  txsOf(intentId: string): WalletTx[] {
    return this.db.all<TxRow>('SELECT * FROM wallet_txs WHERE intent_id = ? ORDER BY step', [intentId]).map(toTx)
  }

  // ─── audit ────────────────────────────────────────────────────────────────

  audit(e: { userId?: number | null; walletId?: string | null; action: string; detail?: Record<string, unknown> }): void {
    this.db.run('INSERT INTO custody_audit (at, user_id, wallet_id, action, detail) VALUES (?, ?, ?, ?, ?)', [
      this.now(),
      e.userId ?? null,
      e.walletId ?? null,
      e.action,
      e.detail ? JSON.stringify(e.detail, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) : null,
    ])
  }

  auditOf(walletId: string): { action: string; at: number; detail: Record<string, unknown> | null }[] {
    return this.db
      .all<{ action: string; at: number; detail: string | null }>('SELECT action, at, detail FROM custody_audit WHERE wallet_id = ? ORDER BY id', [walletId])
      .map((r) => ({ action: r.action, at: r.at, detail: parse<Record<string, unknown>>(r.detail) }))
  }

  // ─── key export requests ──────────────────────────────────────────────────

  createRecovery(r: { codeHash: string; userId: number; walletId: string; network: string; nonce: string; message: string; ttlMs: number }): RecoveryRequest {
    const t = this.now()
    this.db.run('INSERT INTO recovery_requests (code_hash, user_id, wallet_id, network, nonce, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      r.codeHash,
      r.userId,
      r.walletId,
      r.network,
      r.nonce,
      r.message,
      t,
      t + r.ttlMs,
    ])
    return this.recovery(r.codeHash) as RecoveryRequest
  }

  recovery(codeHash: string): RecoveryRequest | null {
    const r = this.db.get<{
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

  bumpRecoveryAttempt(codeHash: string): void {
    this.db.run('UPDATE recovery_requests SET attempts = attempts + 1 WHERE code_hash = ?', [codeHash])
  }

  /** Records the verified owner signature; true only the first time. */
  markRecoveryVerified(codeHash: string, accountId: string): boolean {
    return this.db.run('UPDATE recovery_requests SET verified_at = ?, verified_account = ? WHERE code_hash = ? AND verified_at IS NULL', [this.now(), accountId, codeHash]) === 1
  }

  /** The key leaves the signer once per request: true only the first time. */
  markExported(codeHash: string): boolean {
    return this.db.run('UPDATE recovery_requests SET exported_at = ? WHERE code_hash = ? AND verified_at IS NOT NULL AND exported_at IS NULL', [this.now(), codeHash]) === 1
  }

  countRecoveriesSince(userId: number, since: number): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_requests WHERE user_id = ? AND created_at >= ?', [userId, since])?.n ?? 0
  }
}
