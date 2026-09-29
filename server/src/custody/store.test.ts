import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import type { Database } from '../db/database'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from '../db/testing'
import { MAX_ACTIVE_WALLETS_PER_USER, walletName } from './limits'
import { ActiveWalletLimitError, CustodyStore, type TradingWallet } from './store'

let now = 1_000_000
let db: SqliteDatabase
let store: CustodyStore

const USER = 101
const wallet = (userId = USER, accountId = 'a'.repeat(64)) => ({ userId, network: 'testnet', accountId, publicKey: 'ed25519:K', keyRef: 'local:x' })

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
  it('closing ends a wallet once; its slot is free again (the signer erases the key itself)', async () => {
    const { wallet: w } = await store.createWallet(wallet())
    expect(await store.closeWallet(w.id, 'revoked', { tx: 'h' })).toBe(true)
    expect(await store.wallet(w.id)).toMatchObject({ status: 'revoked', closedAt: now })
    expect(await store.closedSince(now)).toMatchObject([{ id: w.id }])
    expect(await store.closeWallet(w.id, 'deleted')).toBe(false)
    expect(await store.activeWallets(USER, 'testnet')).toEqual([])
    expect(await store.createWallet(wallet(USER, 'd'.repeat(64)))).toMatchObject({ created: true, wallet: { slot: 1 } })
  })
})

describe.each(TEST_ENGINES)(
  'multi-wallet on %s',
  (engine) => {
    let cs: CustodyStore
    let edb: Database
    let n = 0
    const fresh = () => ({ ...wallet(USER, (n++).toString(16).padStart(64, 'a')), publicKey: `ed25519:K${n}` })
    beforeEach(async () => {
      edb = await openTestDatabase(engine)
      const users = new Store(edb, () => now)
      await users.upsertUser({ userId: USER, username: 'alice', firstName: 'Alice', languageCode: null })
      await users.upsertUser({ userId: 202, username: 'bob', firstName: 'Bob', languageCode: null })
      cs = new CustodyStore(edb, () => now)
    })

    it(`up to ${MAX_ACTIVE_WALLETS_PER_USER} active wallets per user, each in its own slot; the next is refused`, async () => {
      const made = []
      for (let i = 0; i < MAX_ACTIVE_WALLETS_PER_USER; i++) made.push((await cs.createWallet(fresh())).wallet)
      expect(made.map((w) => w.slot)).toEqual(Array.from({ length: MAX_ACTIVE_WALLETS_PER_USER }, (_, i) => i + 1))
      expect(new Set(made.map((w) => w.accountId)).size).toBe(MAX_ACTIVE_WALLETS_PER_USER)
      await expect(cs.createWallet(fresh())).rejects.toThrow(ActiveWalletLimitError)
      // Another user is not limited by Alice's wallets.
      expect((await cs.createWallet({ ...fresh(), userId: 202 })).wallet.slot).toBe(1)
      // Deleting one frees exactly its slot, which the next wallet takes.
      await cs.closeWallet(made[3]?.id as string, 'deleted')
      expect((await cs.createWallet(fresh())).wallet.slot).toBe(4)
      await expect(cs.createWallet(fresh())).rejects.toThrow(ActiveWalletLimitError)
    })

    it('the database itself refuses an 11th active wallet and two wallets in one slot, whatever the code does', async () => {
      const insert = (slot: number, account: string) =>
        edb.run(
          "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, slot, created_at, updated_at) VALUES (?, ?, 'testnet', ?, 'k', 's', 'r', 'active', ?, 1, 1)",
          [`x${slot}${account.slice(0, 4)}`, USER, account, slot],
        )
      await insert(1, 'e'.repeat(64))
      await expect(insert(1, 'f'.repeat(64))).rejects.toThrow(/UNIQUE|duplicate/i)
      await expect(insert(MAX_ACTIVE_WALLETS_PER_USER + 1, '1'.repeat(64))).rejects.toThrow(/CHECK|check constraint/i)
      await expect(insert(0, '2'.repeat(64))).rejects.toThrow(/CHECK|check constraint/i)
    })

    it('the Create button’s key makes creation idempotent: a double tap or two instances make one wallet', async () => {
      const [a, b] = await Promise.all([cs.createWallet({ ...fresh(), createKey: 'k1' }), cs.createWallet({ ...fresh(), createKey: 'k1' })])
      expect(a.wallet.id).toBe(b.wallet.id)
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1)
      expect(await cs.activeWallets(USER, 'testnet')).toHaveLength(1)
      // A new press (a new key) is a new wallet.
      expect((await cs.createWallet({ ...fresh(), createKey: 'k2' })).wallet.slot).toBe(2)
    })

    it('racing creations with different keys each get a slot of their own', async () => {
      const results = await Promise.all([1, 2, 3, 4].map((i) => cs.createWallet({ ...fresh(), createKey: `r${i}` })))
      expect(results.every((r) => r.created)).toBe(true)
      expect(results.map((r) => r.wallet.slot).sort()).toEqual([1, 2, 3, 4])
    })

    it('a wallet is owned: another user, a closed wallet or an unknown ID is refused', async () => {
      const { wallet: w } = await cs.createWallet(fresh())
      expect((await cs.ownedWallet(USER, w.id))?.id).toBe(w.id)
      expect(await cs.ownedWallet(202, w.id)).toBeNull()
      expect(await cs.ownedWallet(USER, 'nope')).toBeNull()
      await cs.closeWallet(w.id, 'deleted')
      expect(await cs.ownedWallet(USER, w.id)).toBeNull()
    })

    it('each wallet has its own intents: one in flight per wallet, and wallets don’t block each other', async () => {
      const a = (await cs.createWallet(fresh())).wallet
      const b = (await cs.createWallet(fresh())).wallet
      const ia = await cs.createIntent({ walletId: a.id, userId: USER, chatId: USER, kind: 'withdraw', params: {}, ttlMs: 60_000 })
      const ia2 = await cs.createIntent({ walletId: a.id, userId: USER, chatId: USER, kind: 'withdraw', params: {}, ttlMs: 60_000 })
      const ib = await cs.createIntent({ walletId: b.id, userId: USER, chatId: USER, kind: 'withdraw', params: {}, ttlMs: 60_000 })
      expect((await cs.confirmIntent(ia.id, USER)).ok).toBe(true)
      expect(await cs.confirmIntent(ia2.id, USER)).toMatchObject({ ok: false, reason: 'busy' })
      expect((await cs.confirmIntent(ib.id, USER)).ok).toBe(true)
    })

    it('labels: set, shown in place of the default name, and reset', async () => {
      const w = (await cs.createWallet(fresh())).wallet
      const w2 = (await cs.createWallet(fresh())).wallet
      expect([walletName(w), walletName(w2)]).toEqual(['Main', 'Wallet 2'])
      await cs.setLabel(w2.id, 'Sniping')
      expect(walletName((await cs.wallet(w2.id)) as TradingWallet)).toBe('Sniping')
      await cs.setLabel(w2.id, null)
      expect(walletName((await cs.wallet(w2.id)) as TradingWallet)).toBe('Wallet 2')
    })
  },
  ENGINE_TIMEOUT_MS,
)

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
    // Settings as a v5 database held them (today's Store writes columns that came later).
    await old.run(
      "INSERT INTO user_settings (user_id, slippage_pct, buy_presets, sell_presets, default_account, notify_trades, updated_at) VALUES (?, 1, '[]', '[]', 'main.testnet', 1, ?)",
      [USER, now],
    )
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
      owner: 'local',
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
        owner: 'local',
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
    await s1.recordSigned({
      owner: 'local',
      intentId: i.id,
      step: 0,
      hash: 'H',
      signerId: w.accountId,
      receiverId: 'bob.testnet',
      nonce: 3n,
      expiresHeight: 9,
      signed: 'AA',
      plan: {},
    })
    // No close(): every committed write is already on disk, as after a crash.
    const second = await SqliteDatabase.open(path)
    await migrate(second)
    const s2 = new CustodyStore(second, () => now)
    expect(await s2.activeWallets(USER, 'testnet')).toEqual([w])
    expect((await s2.allInFlight()).map((x) => [x.id, x.status])).toEqual([[i.id, 'signing']])
    expect((await s2.txsOf(i.id))[0]).toMatchObject({ hash: 'H', status: 'signed', nonce: 3n })
    await first.close()
    await second.close()
  })
})
