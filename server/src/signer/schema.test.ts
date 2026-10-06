import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateKey, implicitAccountId, nearPublicKey } from '../custody/keys'
import { keyring, localKeyWrapper, parseSealed, sealSecret } from '../custody/vault'
import { postgresShape, sqliteShape } from '../db/shape'
import { ENGINE_TIMEOUT_MS, openTestDatabase } from '../db/testing'
import { Store } from '../db/store'
import { aadV1, resealWalletKey } from './envelope'
import { importLegacyKeys } from './legacy'
import { LATEST_SIGNER_SCHEMA, migrateSigner } from './schema'
import { SignerStore } from './store'
import { testSigner } from './testing'

describe('the signer’s tables', () => {
  it(
    'SQLite and PostgreSQL describe the same signer tables, columns and unique rules',
    async () => {
      const sqlite = await openTestDatabase('sqlite')
      const pg = await openTestDatabase('pglite')
      expect(await migrateSigner(sqlite)).toBe(LATEST_SIGNER_SCHEMA)
      expect(await migrateSigner(pg)).toBe(LATEST_SIGNER_SCHEMA)
      const only = (s: Awaited<ReturnType<typeof sqliteShape>>) => ({
        tables: Object.fromEntries(Object.entries(s.tables).filter(([t]) => t.startsWith('signer_'))),
        unique: s.unique.filter((u) => u.startsWith('signer_')),
      })
      const [a, b] = [only(await sqliteShape(sqlite)), only(await postgresShape(pg))]
      expect(Object.keys(a.tables).sort()).toEqual([
        'signer_challenges',
        'signer_destinations',
        'signer_events',
        'signer_exports',
        'signer_keys',
        'signer_request_nonces',
        'signer_signatures',
        'signer_state',
        'signer_tg_approvals',
        'signer_tg_requests',
      ])
      expect(b).toEqual(a)
      // Again: nothing changes.
      expect(await migrateSigner(pg)).toBe(LATEST_SIGNER_SCHEMA)
    },
    ENGINE_TIMEOUT_MS,
  )

  it('a held key always has its sealed form, an erased one never does (the database enforces it)', async () => {
    const db = await openTestDatabase('sqlite')
    await migrateSigner(db)
    const insert = (status: string, sealed: string | null) =>
      db.run("INSERT INTO signer_keys (network, account_id, public_key, key_ref, status, sealed_key, created_at, updated_at) VALUES ('testnet', ?, 'k', 'r', ?, ?, 1, 1)", [
        `${status}${sealed ?? 'null'}`,
        status,
        sealed,
      ])
    await expect(insert('active', null)).rejects.toThrow(/CHECK/i)
    await expect(insert('erased', '{}')).rejects.toThrow(/CHECK/i)
    await insert('active', '{}')
    await insert('erased', null)
  })
})

describe('keys from before the signer', () => {
  it('move into the signer’s vault once, still sign, and reseal to the owner-bound form', async () => {
    const db = await openTestDatabase('sqlite')
    const kek = randomBytes(32)
    await new Store(db).upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
    // A testnet wallet as the app stored it before the signer: v1 sealing in the app's own table.
    const k = generateKey()
    const accountId = implicitAccountId(k.publicKey)
    const publicKey = nearPublicKey(k.publicKey)
    const v1 = JSON.stringify(await sealSecret(localKeyWrapper(kek), k.seed, aadV1('testnet', accountId)))
    await db.run(
      "INSERT INTO trading_wallets (id, user_id, network, account_id, public_key, sealed_key, key_ref, status, owner_account, owner_key, slot, created_at, updated_at) VALUES ('w1', 101, 'testnet', ?, ?, ?, 'local:x', 'active', 'alice.testnet', 'ed25519:O', 1, 1, 1)",
      [accountId, publicKey, v1],
    )
    await migrateSigner(db)
    expect(await importLegacyKeys(db)).toBe(1)
    expect(await importLegacyKeys(db)).toBe(0)
    expect((await db.get<{ sealed_key: string | null }>("SELECT sealed_key FROM trading_wallets WHERE id = 'w1'"))?.sealed_key).toBeNull()
    const vault = new SignerStore(db)
    expect(await vault.key('testnet', accountId)).toMatchObject({ status: 'active', ownerAccount: 'alice.testnet', walletId: 'w1', sealedKey: v1 })
    // It still signs.
    const { signer } = await testSigner(db, { kek })
    const signed = await signer.sign({
      wallet: { accountId, network: 'testnet' },
      intentId: 'legacy',
      step: 0,
      op: { kind: 'withdraw-near', to: 'alice.testnet', amount: 5n },
      plan: [{ receiverId: 'alice.testnet', actions: [{ kind: 'transfer', deposit: '5' }], label: 'w' }],
      nonce: 1n,
      blockHash: new Uint8Array(32).fill(3),
    })
    expect(signed.hash).toBeTruthy()
    // Resealed: bound to its owner from now on.
    const r = await resealWalletKey(keyring(localKeyWrapper(kek)), v1, { network: 'testnet', accountId, publicKey, owner: 'alice.testnet' })
    expect(r.changed).toBe(true)
    expect(parseSealed(r.sealed).v).toBe(2)
    expect(await vault.resealed('testnet', accountId, v1, r.sealed, 'local:x')).toBe(true)
    expect(await vault.resealed('testnet', accountId, v1, r.sealed, 'local:x')).toBe(false)
  })
})
