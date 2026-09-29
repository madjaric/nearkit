import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { Db } from '../db/sqlite'
import { Store } from '../db/store'
import { CustodyStore } from './store'

let now = 1_000_000
let db: Db
let store: CustodyStore

const USER = 101
const wallet = (userId = USER, accountId = 'a'.repeat(64)) => ({ userId, network: 'testnet', accountId, publicKey: 'ed25519:K', sealedKey: '{"v":1}', keyRef: 'local:x' })

beforeEach(async () => {
  now = 1_000_000
  db = await Db.open(null)
  migrate(db)
  const users = new Store(db, () => now)
  users.upsertUser({ userId: USER, username: 'alice', firstName: 'Alice', languageCode: null })
  users.upsertUser({ userId: 202, username: 'bob', firstName: 'Bob', languageCode: null })
  store = new CustodyStore(db, () => now)
})

describe('trading wallets', () => {
  it('one live wallet per user and network: creating again returns the same wallet', () => {
    const first = store.createWallet(wallet())
    const again = store.createWallet(wallet(USER, 'b'.repeat(64)))
    expect(first.created).toBe(true)
    expect(again).toEqual({ wallet: first.wallet, created: false })
    expect(store.auditOf(first.wallet.id).map((a) => a.action)).toEqual(['wallet-created'])
    // Even a direct insert can't make a second live wallet.
    expect(() =>
      db.run(
        "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, created_at, updated_at) VALUES ('x', ?, 'testnet', ?, 'k', 's', 'r', 'active', 1, 1)",
        [USER, 'c'.repeat(64)],
      ),
    ).toThrow(/UNIQUE/)
  })

  it('closing erases the sealed key for good; a new wallet can then be created', () => {
    const { wallet: w } = store.createWallet(wallet())
    expect(store.closeWallet(w.id, 'revoked', { tx: 'h' })).toBe(true)
    expect(store.wallet(w.id)).toMatchObject({ status: 'revoked', sealedKey: null, closedAt: now })
    expect(store.closeWallet(w.id, 'deleted')).toBe(false)
    expect(store.activeWallet(USER, 'testnet')).toBeNull()
    expect(store.createWallet(wallet(USER, 'd'.repeat(64))).created).toBe(true)
  })
})

describe('intents', () => {
  const intentFor = (walletId: string, ttlMs = 60_000) =>
    store.createIntent({ walletId, userId: USER, chatId: USER, kind: 'buy', params: { token: 't' }, quote: { min: '1' }, ttlMs })

  it('Confirm works once, for its owner, before it expires', () => {
    const { wallet: w } = store.createWallet(wallet())
    const i = intentFor(w.id)
    expect(store.confirmIntent(i.id, 202)).toMatchObject({ ok: false, reason: 'not-yours' })
    expect(store.confirmIntent('nope', USER)).toMatchObject({ ok: false, reason: 'unknown' })
    const ok = store.confirmIntent(i.id, USER)
    expect(ok).toMatchObject({ ok: true, intent: { status: 'confirmed' } })
    // The second press, a replayed callback, a duplicate update: nothing moves.
    expect(store.confirmIntent(i.id, USER)).toMatchObject({ ok: false, reason: 'not-open', intent: { status: 'confirmed' } })
    const late = intentFor(w.id, 1_000)
    now += 1_001
    expect(store.confirmIntent(late.id, USER)).toMatchObject({ ok: false, reason: 'expired', intent: { status: 'expired' } })
  })

  it('one intent in flight per wallet', () => {
    const { wallet: w } = store.createWallet(wallet())
    const a = intentFor(w.id)
    const b = intentFor(w.id)
    expect(store.confirmIntent(a.id, USER).ok).toBe(true)
    expect(store.confirmIntent(b.id, USER)).toMatchObject({ ok: false, reason: 'busy' })
    expect(store.setStatus(a.id, ['signing', 'submitted'], 'done')).toBe(false)
    expect(store.setStatus(a.id, ['confirmed'], 'failed', { result: { ok: false, message: 'x', hashes: [] } })).toBe(true)
    expect(store.confirmIntent(b.id, USER).ok).toBe(true)
  })

  it('saves every signed transaction before it is sent, and moves the intent to signing', () => {
    const { wallet: w } = store.createWallet(wallet())
    const i = intentFor(w.id)
    store.confirmIntent(i.id, USER)
    store.recordSigned({
      intentId: i.id,
      step: 0,
      hash: 'H1',
      signerId: w.accountId,
      receiverId: 'wrap.testnet',
      nonce: 11n,
      expiresHeight: 500,
      signed: 'AAAA',
      plan: { receiverId: 'wrap.testnet' },
    })
    expect(store.intent(i.id)?.status).toBe('signing')
    // The same step can never be signed twice.
    expect(() =>
      store.recordSigned({ intentId: i.id, step: 0, hash: 'H2', signerId: w.accountId, receiverId: 'wrap.testnet', nonce: 12n, expiresHeight: 500, signed: 'BBBB', plan: {} }),
    ).toThrow(/UNIQUE|constraint/)
    store.markTx(i.id, 0, 'success', { phase: 'success' })
    expect(store.txsOf(i.id)).toMatchObject([{ step: 0, hash: 'H1', nonce: 11n, status: 'success', outcome: { phase: 'success' } }])
    expect(store.allInFlight().map((x) => x.id)).toEqual([i.id])
  })

  it('expires quotes nobody confirmed', () => {
    const { wallet: w } = store.createWallet(wallet())
    const i = intentFor(w.id, 10)
    now += 11
    expect(store.expireQuotes()).toBe(1)
    expect(store.intent(i.id)?.status).toBe('expired')
  })
})

describe('key export requests', () => {
  it('verified once, exported once', () => {
    const { wallet: w } = store.createWallet(wallet())
    store.createRecovery({ codeHash: 'h', userId: USER, walletId: w.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    expect(store.markExported('h')).toBe(false)
    expect(store.markRecoveryVerified('h', 'alice.testnet')).toBe(true)
    expect(store.markRecoveryVerified('h', 'mallory.testnet')).toBe(false)
    expect(store.markExported('h')).toBe(true)
    expect(store.markExported('h')).toBe(false)
    expect(store.recovery('h')).toMatchObject({ verifiedAccount: 'alice.testnet', exportedAt: now })
    expect(store.countRecoveriesSince(USER, 0)).toBe(1)
  })
})

describe('persistence', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('wallets, intents and signed transactions survive a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nearkit-custody-'))
    const path = join(dir, 'db.sqlite')
    const first = await Db.open(path)
    migrate(first)
    new Store(first, () => now).upsertUser({ userId: USER, username: null, firstName: 'A', languageCode: null })
    const s1 = new CustodyStore(first, () => now)
    const { wallet: w } = s1.createWallet(wallet())
    const i = s1.createIntent({ walletId: w.id, userId: USER, chatId: USER, kind: 'withdraw', params: { to: 'bob.testnet' }, ttlMs: 60_000 })
    s1.confirmIntent(i.id, USER)
    s1.recordSigned({ intentId: i.id, step: 0, hash: 'H', signerId: w.accountId, receiverId: 'bob.testnet', nonce: 3n, expiresHeight: 9, signed: 'AA', plan: {} })
    // No close(): every committed write is already on disk, as after a crash.
    const second = await Db.open(path)
    migrate(second)
    const s2 = new CustodyStore(second, () => now)
    expect(s2.activeWallet(USER, 'testnet')).toEqual(w)
    expect(s2.allInFlight().map((x) => [x.id, x.status])).toEqual([[i.id, 'signing']])
    expect(s2.txsOf(i.id)[0]).toMatchObject({ hash: 'H', status: 'signed', nonce: 3n })
    first.close()
    second.close()
  })
})
