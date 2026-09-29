import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { base58Decode, base58Encode, base64Decode } from '@/lib/encoding'
import { deserializeSignedTransaction, transactionDigest } from '@/services/near/transaction'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { PolicyViolation, type WalletTxPlan } from './policy'
import { createLocalSigner, EXPORT_WINDOW_MS } from './signer'
import { CustodyStore, type TradingWallet } from './store'
import { KeyUnavailableError, localKeyWrapper } from './vault'

const net = NETWORKS.testnet
let now = 5_000_000
let store: CustodyStore
const kek = randomBytes(32)

async function setup() {
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  await new Store(db, () => now).upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
  store = new CustodyStore(db, () => now)
  const signer = createLocalSigner({ wrapper: localKeyWrapper(kek), network: net, store, now: () => now })
  const key = await signer.createKey('testnet')
  const { wallet } = await store.createWallet({ userId: 101, network: 'testnet', ...key, keyRef: signer.keyRef, owner: { accountId: 'alice.testnet', publicKey: 'ed25519:Owner' } })
  return { signer, wallet }
}

const transfer = (to: string, amount: bigint): WalletTxPlan[] => [{ receiverId: to, actions: [{ kind: 'transfer', deposit: amount.toString() }], label: 'w' }]
const BLOCK = new Uint8Array(32).fill(9)

beforeEach(async () => {
  now = 5_000_000
})

describe('signer', () => {
  it('creates an implicit wallet and signs a checked operation that verifies against its key', async () => {
    const { signer, wallet } = await setup()
    expect(wallet.accountId).toMatch(/^[0-9a-f]{64}$/)
    expect(base58Encode(base58Decode(wallet.publicKey.slice(8)) as Uint8Array)).toBe(wallet.publicKey.slice(8))
    const signed = await signer.sign({
      wallet,
      op: { kind: 'withdraw-near', to: 'bob.testnet', amount: 5n },
      plan: transfer('bob.testnet', 5n),
      index: 0,
      nonce: 42n,
      blockHash: BLOCK,
    })
    const read = deserializeSignedTransaction(base64Decode(signed.base64) as Uint8Array)
    expect(read.transaction).toMatchObject({
      signerId: wallet.accountId,
      publicKey: wallet.publicKey,
      nonce: 42n,
      receiverId: 'bob.testnet',
      actions: [{ type: 'Transfer', deposit: 5n }],
    })
    const digest = await transactionDigest(read.transactionBytes)
    expect(signed.hash).toBe(base58Encode(digest))
    const key = await crypto.subtle.importKey('raw', base58Decode(wallet.publicKey.slice(8)) as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, read.signature, digest)).toBe(true)
  })

  it('refuses, and logs the refusal, when the plan does not match the operation', async () => {
    const { signer, wallet } = await setup()
    await expect(
      signer.sign({ wallet, op: { kind: 'withdraw-near', to: 'bob.testnet', amount: 5n }, plan: transfer('evil.testnet', 5n), index: 0, nonce: 1n, blockHash: BLOCK }),
    ).rejects.toThrow(PolicyViolation)
    await expect(
      signer.sign({ wallet, op: { kind: 'withdraw-near', to: 'bob.testnet', amount: 5n }, plan: transfer('bob.testnet', 5n), index: 3, nonce: 1n, blockHash: BLOCK }),
    ).rejects.toThrow(/no such transaction/)
    expect((await store.auditOf(wallet.id)).filter((a) => a.action === 'policy-refused')).toHaveLength(2)
  })

  it('cannot sign for a closed wallet, or with another server’s key-encryption key', async () => {
    const { signer, wallet } = await setup()
    const other = createLocalSigner({ wrapper: localKeyWrapper(randomBytes(32)), network: net, store })
    const req = { op: { kind: 'withdraw-near' as const, to: 'bob.testnet', amount: 5n }, plan: transfer('bob.testnet', 5n), index: 0, nonce: 1n, blockHash: BLOCK }
    await expect(other.sign({ ...req, wallet })).rejects.toThrow(KeyUnavailableError)
    await store.closeWallet(wallet.id, 'deleted')
    await expect(signer.sign({ ...req, wallet: (await store.wallet(wallet.id)) as TradingWallet })).rejects.toThrow(/closed/)
  })

  it('exports the key once, only for a request the owner wallet verified in the last five minutes', async () => {
    const { signer, wallet } = await setup()
    await store.createRecovery({ codeHash: 'h0', userId: 101, walletId: wallet.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 600_000 })
    await store.markRecoveryVerified('h0', 'mallory.testnet')
    await expect(signer.exportSecret(wallet, 'h0')).rejects.toThrow(/owner wallet/)
    await store.createRecovery({ codeHash: 'h1', userId: 101, walletId: wallet.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 600_000 })
    await expect(signer.exportSecret(wallet, 'h1')).rejects.toThrow(/verified/)
    await store.markRecoveryVerified('h1', 'alice.testnet')
    const secret = await signer.exportSecret(wallet, 'h1')
    const raw = base58Decode(secret.slice(8)) as Uint8Array
    expect(base58Encode(raw.subarray(32))).toBe(wallet.publicKey.slice(8))
    await expect(signer.exportSecret(wallet, 'h1')).rejects.toThrow(/already used/)

    await store.createRecovery({ codeHash: 'h2', userId: 101, walletId: wallet.id, network: 'testnet', nonce: 'n', message: 'm', ttlMs: 600_000 })
    await store.markRecoveryVerified('h2', 'alice.testnet')
    now += EXPORT_WINDOW_MS + 1
    await expect(signer.exportSecret(wallet, 'h2')).rejects.toThrow(/fresh request/)
    const actions = (await store.auditOf(wallet.id)).map((a) => a.action)
    expect(actions.filter((a) => a === 'key-exported')).toHaveLength(1)
    // The security log never holds the key.
    expect(JSON.stringify(await store.auditOf(wallet.id))).not.toContain(secret.slice(8))
  })
})

describe('restart', () => {
  it('a wallet saved to disk still signs after the process restarts with the same key-encryption key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-'))
    try {
      const path = join(dir, 'db.sqlite')
      const first = await SqliteDatabase.open(path)
      await migrate(first)
      await new Store(first, () => now).upsertUser({ userId: 101, username: null, firstName: 'A', languageCode: null })
      const s1 = new CustodyStore(first, () => now)
      const signer1 = createLocalSigner({ wrapper: localKeyWrapper(kek), network: net, store: s1 })
      const { wallet } = await s1.createWallet({ userId: 101, network: 'testnet', ...(await signer1.createKey('testnet')), keyRef: signer1.keyRef })
      await first.close()

      const second = await SqliteDatabase.open(path)
      await migrate(second)
      const s2 = new CustodyStore(second, () => now)
      const reopened = (await s2.activeWallets(101, 'testnet'))[0] as TradingWallet
      expect(reopened).toEqual(wallet)
      const signer2 = createLocalSigner({ wrapper: localKeyWrapper(Buffer.from(kek)), network: net, store: s2 })
      const signed = await signer2.sign({
        wallet: reopened,
        op: { kind: 'withdraw-near', to: 'bob.testnet', amount: 5n },
        plan: transfer('bob.testnet', 5n),
        index: 0,
        nonce: 1n,
        blockHash: BLOCK,
      })
      expect(deserializeSignedTransaction(base64Decode(signed.base64) as Uint8Array).transaction.signerId).toBe(wallet.accountId)
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
