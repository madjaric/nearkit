import { describe, expect, it } from 'vitest'
import { createExportKeyPair } from '@/lib/exportCrypto'
import { createExportStore, type StoredExport } from './exportStore'

/**
 * A held export outlives the page that asked for it (24 hours by default): this browser keeps
 * the export's own key, not extractable, until the key is collected or the export is over.
 * Without IndexedDB (here, Node) it is kept for the page's lifetime only, and says so.
 */

const record = async (over: Partial<StoredExport> = {}): Promise<StoredExport> => ({
  exportId: 'req1',
  network: 'testnet',
  accountId: 'a'.repeat(64),
  ownerAccount: 'alice.testnet',
  browserKey: 'abcd ef01 2345 6789',
  releaseAt: 2_000,
  expiresAt: 3_000,
  createdAt: 1_000,
  privateKey: (await createExportKeyPair()).privateKey,
  ...over,
})

describe('this browser’s held exports', () => {
  it('keeps each export with its key, per network, until it is forgotten', async () => {
    const store = createExportStore(null)
    expect(store.persistent).toBe(false)
    const a = await record()
    const b = await record({ exportId: 'req2', network: 'mainnet' })
    await store.save(a)
    await store.save(b)
    expect((await store.list('testnet')).map((r) => r.exportId)).toEqual(['req1'])
    expect((await store.list('mainnet')).map((r) => r.exportId)).toEqual(['req2'])
    expect((await store.get('req1'))?.privateKey).toBe(a.privateKey)
    await store.remove('req1')
    expect(await store.get('req1')).toBeNull()
    expect(await store.list('testnet')).toEqual([])
  })

  it('finds the open export of one wallet, newest first', async () => {
    const store = createExportStore(null)
    await store.save(await record({ exportId: 'old', createdAt: 1 }))
    await store.save(await record({ exportId: 'new', createdAt: 2 }))
    await store.save(await record({ exportId: 'other', accountId: 'b'.repeat(64), createdAt: 3 }))
    expect((await store.ofWallet('testnet', 'a'.repeat(64)))?.exportId).toBe('new')
    expect(await store.ofWallet('mainnet', 'a'.repeat(64))).toBeNull()
  })
})
