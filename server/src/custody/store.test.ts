import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { CustodyStore } from './store'

let now = 1_000_000
let db: SqliteDatabase
let store: CustodyStore

const USER = 101
const wallet = (userId = USER, accountId = 'a'.repeat(64)) => ({ userId, network: 'testnet', accountId, publicKey: 'ed25519:K', sealedKey: '{"v":1}', keyRef: 'local:x' })

beforeEach(async () => {
  now = 1_000_000
  db = await SqliteDatabase.open(null)
  await migrate(db)
  const users = new Store(db, () => now)
  await users.upsertUser({ userId: USER, username: 'alice', firstName: 'Alice', languageCode: null })
  await users.upsertUser({ userId: 202, username: 'bob', firstName: 'Bob', languageCode: null })
  store = new CustodyStore(db, () => now)
})

describe('trading wallets', () => {
  it('one live wallet per user and network: creating again returns the same wallet', async () => {
    const first = await store.createWallet(wallet())
    const again = await store.createWallet(wallet(USER, 'b'.repeat(64)))
    expect(first.created).toBe(true)
    expect(again).toEqual({ wallet: first.wallet, created: false })
    expect((await store.auditOf(first.wallet.id)).map((a) => a.action)).toEqual(['wallet-created'])
    // Even a direct insert can't make a second live wallet.
    await expect(
      db.run(
        "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, created_at, updated_at) VALUES ('x', ?, 'testnet', ?, 'k', 's', 'r', 'active', 1, 1)",
        [USER, 'c'.repeat(64)],
      ),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('closing erases the sealed key for good; a new wallet can then be created', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    expect(await store.closeWallet(w.id, 'revoked', { tx: 'h' })).toBe(true)
    expect(await store.wallet(w.id)).toMatchObject({ status: 'revoked', sealedKey: null, closedAt: now })
    expect(await store.closeWallet(w.id, 'deleted')).toBe(false)
    expect(await store.activeWallet(USER, 'testnet')).toBeNull()
    expect((await store.createWallet(wallet(USER, 'd'.repeat(64)))).created).toBe(true)
  })
})

describe('the owner of wallets made before owners were recorded', () => {
  it('is the wallet linked when it was made (the default first), with its current key; a backup key of another wallet is forgotten', async () => {
    const old = await SqliteDatabase.open(null)
    await migrate(old, 5)
    const users = new Store(old, () => now)
    for (const userId of [USER, 202, 303]) await users.upsertUser({ userId, username: null, firstName: 'U', languageCode: null })
    const link = async (userId: number, accountId: string, publicKey: string) => {
      const codeHash = `${userId}:${accountId}:${publicKey}`
      await users.createLinkRequest({ codeHash, userId, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
      await users.completeLink({ codeHash, network: 'testnet', accountId, userId, publicKey })
    }
    const made = (id: string, userId: number, backupKey: string | null) =>
      old.run(
        "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, backup_key, created_at, updated_at) VALUES (?, ?, 'testnet', ?, 'ed25519:N', '{}', 'local:x', 'active', ?, ?, ?)",
        [id, userId, id.repeat(64).slice(0, 64), backupKey, now, now],
      )
    await link(USER, 'first.testnet', 'ed25519:F')
    await link(303, 'carol.testnet', 'ed25519:C')
    now += 1
    await link(USER, 'main.testnet', 'ed25519:M1')
    await users.updateSettings(USER, { defaultAccount: 'main.testnet' })
    now += 1
    await made('a', USER, 'ed25519:F')
    await made('b', 202, null)
    await made('c', 303, 'ed25519:C')
    now += 1
    // Later: the default linked again with a new key, another wallet linked, Bob's first link.
    await link(USER, 'main.testnet', 'ed25519:M2')
    await link(USER, 'later.testnet', 'ed25519:L')
    await link(202, 'bob.testnet', 'ed25519:B')
    await migrate(old)
    const s = new CustodyStore(old, () => now)
    expect(await s.wallet('a')).toMatchObject({ ownerAccount: 'main.testnet', ownerKey: 'ed25519:M2', backupKey: null })
    // Nothing was linked when Bob's was made: no owner, so no export and no revoke.
    expect(await s.wallet('b')).toMatchObject({ ownerAccount: null, ownerKey: null })
    expect(await s.wallet('c')).toMatchObject({ ownerAccount: 'carol.testnet', ownerKey: 'ed25519:C', backupKey: 'ed25519:C' })
    await old.close()
  })
})

describe('intents', () => {
  const intentFor = (walletId: string, ttlMs = 60_000) =>
    store.createIntent({ walletId, userId: USER, chatId: USER, kind: 'buy', params: { token: 't' }, quote: { min: '1' }, ttlMs })

  it('Confirm works once, for its owner, before it expires', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    const i = await intentFor(w.id)
    expect(await store.confirmIntent(i.id, 202)).toMatchObject({ ok: false, reason: 'not-yours' })
    expect(await store.confirmIntent('nope', USER)).toMatchObject({ ok: false, reason: 'unknown' })
    const ok = await store.confirmIntent(i.id, USER)
    expect(ok).toMatchObject({ ok: true, intent: { status: 'confirmed' } })
    // The second press, a replayed callback, a duplicate update: nothing moves.
    expect(await store.confirmIntent(i.id, USER)).toMatchObject({ ok: false, reason: 'not-open', intent: { status: 'confirmed' } })
    const late = await intentFor(w.id, 1_000)
    now += 1_001
    expect(await store.confirmIntent(late.id, USER)).toMatchObject({ ok: false, reason: 'expired', intent: { status: 'expired' } })
  })

  it('one intent in flight per wallet', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    const a = await intentFor(w.id)
    const b = await intentFor(w.id)
    expect((await store.confirmIntent(a.id, USER)).ok).toBe(true)
    expect(await store.confirmIntent(b.id, USER)).toMatchObject({ ok: false, reason: 'busy' })
    expect(await store.setStatus(a.id, ['signing', 'submitted'], 'done')).toBe(false)
    expect(await store.setStatus(a.id, ['confirmed'], 'failed', { result: { ok: false, message: 'x', hashes: [] } })).toBe(true)
    expect((await store.confirmIntent(b.id, USER)).ok).toBe(true)
  })

  it('saves every signed transaction before it is sent, and moves the intent to signing', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    const i = await intentFor(w.id)
    await store.confirmIntent(i.id, USER)
    await store.recordSigned({
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
    expect((await store.intent(i.id))?.status).toBe('signing')
    // The same step can never be signed twice.
    await expect(
      store.recordSigned({
        intentId: i.id,
        step: 0,
        hash: 'H2',
        signerId: w.accountId,
        receiverId: 'wrap.testnet',
        nonce: 12n,
        expiresHeight: 500,
        signed: 'BBBB',
        plan: {},
      }),
    ).rejects.toThrow(/UNIQUE|constraint/)
    await store.markTx(i.id, 0, 'success', { phase: 'success' })
    expect(await store.txsOf(i.id)).toMatchObject([{ step: 0, hash: 'H1', nonce: 11n, status: 'success', outcome: { phase: 'success' } }])
    expect((await store.allInFlight()).map((x) => x.id)).toEqual([i.id])
  })

  it('expires quotes nobody confirmed', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    const i = await intentFor(w.id, 10)
    now += 11
    expect(await store.expireQuotes()).toBe(1)
    expect((await store.intent(i.id))?.status).toBe('expired')
  })
})

describe('key export requests', () => {
  it('verified once, exported once', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    await store.createRecovery({ codeHash: 'h', userId: USER, walletId: w.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 60_000 })
    expect(await store.markExported('h')).toBe(false)
    expect(await store.markRecoveryVerified('h', 'alice.testnet')).toBe(true)
    expect(await store.markRecoveryVerified('h', 'mallory.testnet')).toBe(false)
    expect(await store.markExported('h')).toBe(true)
    expect(await store.markExported('h')).toBe(false)
    expect(await store.recovery('h')).toMatchObject({ verifiedAccount: 'alice.testnet', exportedAt: now })
    expect(await store.countRecoveriesSince(USER, 0)).toBe(1)
  })
})

describe('persistence', () => {
  let dir: string
  afterEach(async () => rmSync(dir, { recursive: true, force: true }))

  it('wallets, intents and signed transactions survive a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nearkit-custody-'))
    const path = join(dir, 'db.sqlite')
    const first = await SqliteDatabase.open(path)
    await migrate(first)
    await new Store(first, () => now).upsertUser({ userId: USER, username: null, firstName: 'A', languageCode: null })
    const s1 = new CustodyStore(first, () => now)
    const { wallet: w } = await s1.createWallet(wallet())
    const i = await s1.createIntent({ walletId: w.id, userId: USER, chatId: USER, kind: 'withdraw', params: { to: 'bob.testnet' }, ttlMs: 60_000 })
    await s1.confirmIntent(i.id, USER)
    await s1.recordSigned({ intentId: i.id, step: 0, hash: 'H', signerId: w.accountId, receiverId: 'bob.testnet', nonce: 3n, expiresHeight: 9, signed: 'AA', plan: {} })
    // No close(): every committed write is already on disk, as after a crash.
    const second = await SqliteDatabase.open(path)
    await migrate(second)
    const s2 = new CustodyStore(second, () => now)
    expect(await s2.activeWallet(USER, 'testnet')).toEqual(w)
    expect((await s2.allInFlight()).map((x) => [x.id, x.status])).toEqual([[i.id, 'signing']])
    expect((await s2.txsOf(i.id))[0]).toMatchObject({ hash: 'H', status: 'signed', nonce: 3n })
    await first.close()
    await second.close()
  })
})
