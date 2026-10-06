import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/database'
import { anotherInstance, ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from '../db/testing'
import { migrateSigner } from './schema'
import { SignerStore } from './store'

/**
 * The rules of held exports that the signer's database keeps itself, on every engine production
 * can run (and, with NEARKIT_TEST_DATABASE_URL, on a real PostgreSQL server with two instances
 * racing): one open export per wallet, each step once, nothing after cancel or past its time.
 */

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const row = (id: string, accountId = A) => ({
  id,
  digest: `digest-${id}`,
  network: 'testnet',
  accountId,
  ownerAccount: 'alice.testnet',
  ownerKey: 'ed25519:K',
  signature: 'owner-signature',
  message: 'm',
  nonce: 'n',
  recipient: 'nearkits.com',
  userId: 4242,
  recipientKey: 'browser-key',
  releaseAt: 10_000,
  expiresAt: 20_000,
})

describe.each(TEST_ENGINES)(
  'held exports in the signer’s database on %s',
  (engine) => {
    let now = 1_000
    let db: Database
    let store: SignerStore
    /** On PostgreSQL, a second server instance with its own connections; elsewhere the same store. */
    let other: SignerStore
    beforeEach(async () => {
      now = 1_000
      db = await openTestDatabase(engine)
      await migrateSigner(db)
      store = new SignerStore(db, () => now)
      other = engine === 'postgres' ? new SignerStore(anotherInstance(db), () => now) : store
    })

    it('one open export per wallet, even when two requests race on two instances; another wallet is not affected', async () => {
      const made = await Promise.all([store.createExport(row('e1')), other.createExport(row('e2'))])
      expect(made.filter(Boolean)).toHaveLength(1)
      expect(await store.createExport(row('e3', B))).not.toBeNull()
      const open = await store.openExport('testnet', A)
      expect(open?.state).toBe('held')
      // Once it is over (cancelled here), the wallet can start a new one.
      expect(await store.cancelExport(open?.id ?? '', 'web')).toBe(true)
      expect(await store.createExport(row('e4'))).not.toBeNull()
    })

    it('released once, collected once (two instances racing), and a collected export can’t be cancelled', async () => {
      await store.createExport(row('e1'))
      expect(await store.confirmExport('e1', 'launch')).toBe(true)
      expect(await store.confirmExport('e1', 'launch')).toBe(false)
      const collected = await Promise.all([store.collectExport('e1'), other.collectExport('e1')])
      expect(collected.filter(Boolean)).toHaveLength(1)
      expect(await store.cancelExport('e1', 'telegram')).toBe(false)
      expect(await store.exportById('e1')).toMatchObject({ state: 'collected', confirmInitData: 'launch', confirmedAt: 1_000, collectedAt: 1_000 })
    })

    it('a cancel ends it for good: no release, no collection, and the owner’s signature is gone', async () => {
      await store.createExport(row('e1'))
      expect(await store.cancelExport('e1', 'telegram')).toBe(true)
      expect(await store.confirmExport('e1', 'launch')).toBe(false)
      expect(await store.collectExport('e1')).toBe(false)
      expect(await store.exportById('e1')).toMatchObject({ state: 'cancelled', cancelledBy: 'telegram', signature: '' })
      expect(await store.openExport('testnet', A)).toBeNull()
    })

    it('past its time nothing is released or collected; expiring it frees the wallet', async () => {
      await store.createExport(row('e1'))
      now = 20_001
      expect(await store.confirmExport('e1', 'launch')).toBe(false)
      expect(await store.collectExport('e1')).toBe(false)
      expect(await store.createExport(row('e2'))).toBeNull()
      expect(await store.expireExports('testnet', A)).toBe(1)
      expect((await store.exportById('e1'))?.state).toBe('expired')
      expect(await store.createExport(row('e2'))).not.toBeNull()
    })
  },
  ENGINE_TIMEOUT_MS,
)
