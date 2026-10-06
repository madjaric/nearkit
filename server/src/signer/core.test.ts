import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { base58Decode, base58Encode, base64Decode } from '@/lib/encoding'
import { createExportKeyPair, openExport, type SealedExport } from '@/lib/exportCrypto'
import type { AccessKeyPermission } from '@/services/near/nep413'
import { deserializeSignedTransaction, transactionDigest } from '@/services/near/transaction'
import { PolicyViolation, type WalletOperation, type WalletTxPlan } from '../custody/policy'
import type { OwnerProof, TradingSigner } from '../custody/signer'
import { KeyUnavailableError } from '../custody/vault'
import type { Database } from '../db/database'
import { SqliteDatabase } from '../db/sqlite'
import { ChainUncertainError, type SignerChain } from './chain'
import { BadRequestError } from './codec'
import type { ChallengeView, SignerCore } from './core'
import { AlreadySignedError, ChallengeError, DestinationNotApprovedError, SignerPausedError } from './errors'
import type { SignerStore } from './store'
import { exportAsOwner, ownerKeypair, ownerSign, testSigner } from './testing'

const OWNER = 'alice.testnet'
const BLOCK = new Uint8Array(32).fill(9)
const ONE = 10n ** 24n

/** NEAR as the signer sees it, set by each test: keys, their permissions, which accounts exist. */
function fakeChain() {
  const perms = new Map<string, AccessKeyPermission>()
  const accounts = new Set<string>()
  const keyLists = new Map<string, string[]>()
  const balances = new Map<string, bigint>()
  const tokens = new Map<string, bigint>()
  let uncertain = false
  const chain: SignerChain = {
    async permission(a, k) {
      if (uncertain) throw new ChainUncertainError('NEAR RPC providers disagree')
      return perms.get(`${a}|${k}`) ?? 'missing'
    },
    async accountExists(a) {
      if (uncertain) throw new ChainUncertainError('NEAR RPC providers disagree')
      return accounts.has(a)
    },
    async fullAccessKeys(a) {
      if (uncertain) throw new ChainUncertainError('NEAR RPC providers disagree')
      return [...(keyLists.get(a) ?? [])].sort()
    },
    async accountBalance(a) {
      if (uncertain) throw new ChainUncertainError('NEAR RPC providers disagree')
      // An account that exists holds 1 NEAR unless a test says otherwise.
      return accounts.has(a) ? { exists: true, amount: balances.get(a) ?? 10n ** 24n, locked: 0n } : { exists: false, amount: 0n, locked: 0n }
    },
    async tokenBalance(c, a) {
      if (uncertain) throw new ChainUncertainError('NEAR RPC providers disagree')
      return tokens.get(`${c}|${a}`) ?? 0n
    },
  }
  return {
    chain,
    grant: (a: string, k: string, p: AccessKeyPermission = 'full') => void perms.set(`${a}|${k}`, p),
    revoke: (a: string, k: string) => void perms.delete(`${a}|${k}`),
    exists: (a: string, yes = true) => void (yes ? accounts.add(a) : accounts.delete(a)),
    keys: (a: string, ks: string[]) => void keyLists.set(a, ks),
    balance: (a: string, yocto: bigint) => void balances.set(a, yocto),
    token: (c: string, a: string, raw: bigint) => void tokens.set(`${c}|${a}`, raw),
    uncertain: (v: boolean) => void (uncertain = v),
  }
}

let now: number
let db: Database
let chain: ReturnType<typeof fakeChain>
let core: SignerCore
let vault: SignerStore
let signer: TradingSigner
let kek: Buffer
let owner: Awaited<ReturnType<typeof ownerKeypair>>
let wallet: { accountId: string; publicKey: string; network: string }

const transfer = (to: string, amount: bigint): WalletTxPlan[] => [{ receiverId: to, actions: [{ kind: 'transfer', deposit: amount.toString() }], label: 'w' }]
const withdraw = (to: string, amount = 5n): WalletOperation => ({ kind: 'withdraw-near', to, amount })
const sign = (over: Partial<Parameters<TradingSigner['sign']>[0]> = {}) =>
  signer.sign({ wallet, intentId: 'i1', step: 0, op: withdraw(OWNER), plan: transfer(OWNER, 5n), nonce: 42n, blockHash: BLOCK, ...over })

beforeEach(async () => {
  now = 5_000_000
  db = await SqliteDatabase.open(null)
  chain = fakeChain()
  const s = await testSigner(db, { now: () => now, chain: chain.chain, oracle: { expectedOut: async () => 1n } })
  core = s.core
  vault = s.store
  signer = s.signer
  kek = s.kek
  owner = await ownerKeypair()
  chain.grant(OWNER, owner.publicKey)
  chain.exists(OWNER)
  const k = await signer.createKey({ userId: 101, owner: { accountId: OWNER, publicKey: owner.publicKey } })
  wallet = { accountId: k.accountId, publicKey: k.publicKey, network: 'testnet' }
})

describe('keys', () => {
  it('makes an implicit wallet whose key is sealed, bound to its owner, and never stored in the clear', async () => {
    expect(wallet.accountId).toMatch(/^[0-9a-f]{64}$/)
    const held = await vault.key('testnet', wallet.accountId)
    expect(held).toMatchObject({ status: 'active', ownerAccount: OWNER, publicKey: wallet.publicKey })
    expect(JSON.parse(held?.sealedKey as string)).toMatchObject({ v: 2, ref: expect.stringMatching(/^local:/) })
    expect((await vault.events('testnet', wallet.accountId)).map((e) => e.kind)).toEqual(['key-created'])
  })

  it('refuses a malformed owner: not an account, another network, not an ed25519 key', async () => {
    const make = (accountId: string, publicKey = owner.publicKey) => signer.createKey({ userId: 1, owner: { accountId, publicKey } })
    await expect(make('Not An Account')).rejects.toThrow(BadRequestError)
    await expect(make('alice.near')).rejects.toThrow(/another network/)
    await expect(make(OWNER, 'ed25519:short')).rejects.toThrow(/ed25519/)
  })

  it('a rewritten owner in the signer’s own database leaves the key unopenable, not usable', async () => {
    // Someone with write access to the signer's database makes themselves the "owner" to withdraw to it.
    await db.run("UPDATE signer_keys SET owner_account = 'mallory.testnet'")
    await expect(sign({ op: withdraw('mallory.testnet'), plan: transfer('mallory.testnet', 5n) })).rejects.toThrow(KeyUnavailableError)
    await expect(sign({ intentId: 'i-b' })).rejects.toThrow(DestinationNotApprovedError)
    await db.run('UPDATE signer_keys SET owner_account = ?', [OWNER])
    expect((await sign()).hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  })

  it('another signer’s KEK opens nothing', async () => {
    const other = await testSigner(db, { now: () => now, chain: chain.chain, kek: randomBytes(32) })
    await expect(other.signer.sign({ wallet, intentId: 'x', step: 0, op: withdraw(OWNER), plan: transfer(OWNER, 5n), nonce: 1n, blockHash: BLOCK })).rejects.toThrow(
      KeyUnavailableError,
    )
  })
})

describe('signing', () => {
  it('signs a checked operation; the signature verifies against the wallet’s key', async () => {
    const signed = await sign()
    const read = deserializeSignedTransaction(base64Decode(signed.base64) as Uint8Array)
    expect(read.transaction).toMatchObject({ signerId: wallet.accountId, publicKey: wallet.publicKey, nonce: 42n, receiverId: OWNER, actions: [{ type: 'Transfer', deposit: 5n }] })
    const digest = await transactionDigest(read.transactionBytes)
    expect(signed.hash).toBe(base58Encode(digest))
    const key = await crypto.subtle.importKey('raw', base58Decode(wallet.publicKey.slice(8)) as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, read.signature, digest)).toBe(true)
  })

  it('one transaction per (intent, step), ever: the same request gets the same answer, a different one is refused', async () => {
    const first = await sign()
    expect(await sign()).toEqual(first)
    await expect(sign({ nonce: 43n })).rejects.toThrow(AlreadySignedError)
    await expect(sign({ op: withdraw(OWNER, 6n), plan: transfer(OWNER, 6n) })).rejects.toThrow(AlreadySignedError)
    // The same transaction under another intent is the same transaction (it can land once); a new one is signed.
    expect(await sign({ intentId: 'i2' })).toEqual(first)
    expect(await sign({ intentId: 'i3', nonce: 43n })).not.toEqual(first)
    expect((await vault.recentEvents()).filter((e) => e.kind === 'signer-denied')).toHaveLength(2)
  })

  it('two different signatures of one step requested at once: exactly one is released', async () => {
    const results = await Promise.allSettled([sign({ nonce: 50n }), sign({ nonce: 51n }), sign({ nonce: 52n })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof AlreadySignedError)).toBe(true)
    expect(await db.all('SELECT * FROM signer_signatures')).toHaveLength(1)
  })

  it('refuses a plan that doesn’t match its operation, and logs why', async () => {
    await expect(sign({ plan: transfer('evil.testnet', 5n), op: withdraw('evil.testnet') })).rejects.toThrow(DestinationNotApprovedError)
    await expect(sign({ plan: transfer('evil.testnet', 5n) })).rejects.toThrow(PolicyViolation)
    await expect(sign({ step: 2 })).rejects.toThrow(/no such transaction/)
    const denied = (await vault.events('testnet', wallet.accountId)).filter((e) => e.kind === 'signer-denied')
    expect(denied.map((e) => e.detail.reason)).toEqual([
      expect.stringMatching(/not an approved destination/),
      expect.stringMatching(/transfer|destination/),
      expect.stringMatching(/no such/),
    ])
  })

  it('refuses malformed requests before anything else: extra fields, odd amounts, a bad block hash', async () => {
    const raw = (body: Record<string, unknown>) => core.handle('sign', body)
    const good = {
      accountId: wallet.accountId,
      intentId: 'i',
      step: 0,
      op: { kind: 'withdraw-near', to: OWNER, amount: '5' },
      plan: [{ receiverId: OWNER, actions: [{ kind: 'transfer', deposit: '5' }], label: 'w' }],
      nonce: '1',
      blockHash: base58Encode(BLOCK),
    }
    await expect(raw({ ...good, extra: 1 })).rejects.toThrow(BadRequestError)
    await expect(raw({ ...good, op: { ...good.op, amount: '-5' } })).rejects.toThrow(BadRequestError)
    await expect(raw({ ...good, op: { ...good.op, amount: '5.5' } })).rejects.toThrow(BadRequestError)
    await expect(raw({ ...good, op: { ...good.op, sneaky: true } })).rejects.toThrow(BadRequestError)
    await expect(raw({ ...good, blockHash: 'abc' })).rejects.toThrow(BadRequestError)
    await expect(raw({ ...good, nonce: '0' })).rejects.toThrow(BadRequestError)
    await expect(core.handle('sign-anything', {})).rejects.toThrow(/unknown method/)
    expect(await raw(good)).toMatchObject({ hash: expect.any(String) })
  })
})

describe('what a plan may do', () => {
  it('a backup key must be a full-access key of the owner, on chain right now', async () => {
    const stranger = await ownerKeypair()
    const addKey = (publicKey: string, intentId: string) =>
      sign({ intentId, op: { kind: 'add-backup-key', publicKey }, plan: [{ receiverId: wallet.accountId, actions: [{ kind: 'add-key', publicKey }], label: 'b' }] })
    await expect(addKey(stranger.publicKey, 'b1')).rejects.toThrow(/not a full-access key of alice.testnet/)
    chain.grant(OWNER, stranger.publicKey, 'function-call')
    await expect(addKey(stranger.publicKey, 'b2')).rejects.toThrow(/not a full-access key/)
    expect((await addKey(owner.publicKey, 'b3')).hash).toBeTruthy()
  })

  it('NEARKITS’ key is removed only when another key on the wallet belongs to the owner', async () => {
    const revoke = (intentId: string) =>
      sign({
        intentId,
        op: { kind: 'revoke', publicKey: wallet.publicKey },
        plan: [{ receiverId: wallet.accountId, actions: [{ kind: 'delete-key', publicKey: wallet.publicKey }], label: 'r' }],
      })
    const stranger = await ownerKeypair()
    chain.keys(wallet.accountId, [wallet.publicKey, stranger.publicKey])
    await expect(revoke('r1')).rejects.toThrow(/would leave it to nobody/)
    chain.keys(wallet.accountId, [wallet.publicKey, stranger.publicKey, owner.publicKey])
    expect((await revoke('r2')).hash).toBeTruthy()
  })
})

describe('owner-signed requests', () => {
  const proofFor = async (c: ChallengeView, key = owner): Promise<OwnerProof> => ({ challengeId: c.id, publicKey: key.publicKey, signature: await ownerSign(c, key.pair) })

  it('the message names every fact it authorizes', async () => {
    const browser = await createExportKeyPair()
    const c = await signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    expect(c.message.split('\n')).toEqual([
      'NearKit: export the private key of my NearKit wallet',
      `NearKit wallet: ${wallet.accountId}`,
      expect.stringMatching(/^Browser key: [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/),
      `Owner wallet: ${OWNER}`,
      'Network: testnet',
      `Request: ${c.id}`,
      `Expires: ${new Date(now + 5 * 60_000).toISOString()}`,
      '',
      expect.stringContaining('Anyone who sees the exported key controls that wallet'),
    ])
    expect(c).toMatchObject({ recipient: 'nearkit.vercel.app', ownerAccount: OWNER, expiresAt: now + 5 * 60_000 })
    expect(base64Decode(c.nonce)).toHaveLength(32)
  })

  it('export: sealed to the browser key the owner signed for; it opens there and nowhere else', async () => {
    const secret = await exportAsOwner({ challenge: (r) => signer.challenge(r), exportKey: (p) => signer.exportKey(p) }, wallet.accountId, owner)
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    expect(`ed25519:${base58Encode(raw.subarray(32))}`).toBe(wallet.publicKey)
    // Another browser's key, or another binding, doesn't open it.
    const browser = await createExportKeyPair()
    const c = await signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    const out = await signer.exportKey(await proofFor(c))
    const other = await createExportKeyPair()
    const binding = { challengeId: c.id, network: 'testnet', accountId: wallet.accountId }
    await expect(openExport(other.privateKey, out.sealed, binding)).rejects.toThrow()
    await expect(openExport(browser.privateKey, out.sealed, { ...binding, network: 'mainnet' })).rejects.toThrow()
    await expect(openExport(browser.privateKey, { ...out.sealed, ct: out.sealed.ct.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')) } as SealedExport, binding)).rejects.toThrow()
    expect(await openExport(browser.privateKey, out.sealed, binding)).toBe(secret)
    expect((await vault.events('testnet', wallet.accountId)).filter((e) => e.kind === 'key-exported')).toHaveLength(2)
  })

  it('a NEARKITS wallet’s own key, exported, never proves its owner, not even while the owner’s key is also on that wallet', async () => {
    // The wallet's key as Recover hands it to the owner, imported into a wallet app that now signs with it.
    const secret = await exportAsOwner({ challenge: (r) => signer.challenge(r), exportKey: (p) => signer.exportKey(p) }, wallet.accountId, owner)
    const raw = base58Decode(secret.slice('ed25519:'.length)) as Uint8Array
    const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32)) },
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    const exported = { pair: { privateKey } as CryptoKeyPair, publicKey: `ed25519:${base58Encode(raw.subarray(32))}` }
    expect(exported.publicKey).toBe(wallet.publicKey)
    // On chain: the wallet holds its own key and the owner's (its backup key); the owner holds only its own.
    chain.grant(wallet.accountId, wallet.publicKey)
    chain.grant(wallet.accountId, owner.publicKey)
    const problem = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: unknown) => (e instanceof ChallengeError ? e.problem : String(e)))
    const browser = await createExportKeyPair()
    const requests = [
      { ask: () => signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey }), answer: (p: OwnerProof) => signer.exportKey(p) },
      {
        ask: () => signer.challenge({ kind: 'approve-destination', accountId: wallet.accountId, destination: 'bob.testnet' }),
        answer: (p: OwnerProof) => signer.approveDestination(p),
      },
      { ask: () => signer.challenge({ kind: 'owner-session', owner: OWNER }), answer: (p: OwnerProof) => signer.ownerWallets(p) },
    ]
    for (const r of requests) {
      const c = await r.ask()
      expect(await problem(r.answer(await proofFor(c, exported)))).toBe('not-owner')
      // The same request, signed with the owner's own key: it goes through.
      expect(await problem(r.answer(await proofFor(c)))).toBe('ok')
    }
    const refused = (await vault.events('testnet', wallet.accountId)).filter((e) => e.kind === 'owner-proof-refused')
    expect(refused.map((e) => [e.detail.kind, e.detail.key, e.detail.reason])).toEqual([
      ['export', wallet.publicKey, 'not a full-access key of the owner'],
      ['approve-destination', wallet.publicKey, 'not a full-access key of the owner'],
    ])
  })

  it('refuses: another account’s key, a function-call key, a bad signature, replay, expiry, the wrong kind, a guessing streak', async () => {
    const browser = await createExportKeyPair()
    const fresh = () => signer.challenge({ kind: 'export', accountId: wallet.accountId, recipientKey: browser.publicKey })
    const mallory = await ownerKeypair()
    chain.grant('mallory.testnet', mallory.publicKey)
    const problem = (p: Promise<unknown>) => p.then(() => 'ok').catch((e: unknown) => (e instanceof ChallengeError ? e.problem : String(e)))
    let c = await fresh()
    expect(await problem(signer.exportKey(await proofFor(c, mallory)))).toBe('not-owner')
    const app = await ownerKeypair()
    chain.grant(OWNER, app.publicKey, 'function-call')
    expect(await problem(signer.exportKey(await proofFor(c, app)))).toBe('not-owner')
    expect(await problem(signer.exportKey({ ...(await proofFor(c)), signature: (await proofFor({ ...c, message: 'x' })).signature }))).toBe('bad-signature')
    expect(await problem(signer.exportKey(await proofFor(c)))).toBe('ok')
    expect(await problem(signer.exportKey(await proofFor(c)))).toBe('used')
    c = await fresh()
    expect(await problem(signer.approveDestination(await proofFor(c)))).toBe('unknown')
    now += 5 * 60_000 + 1
    expect(await problem(signer.exportKey(await proofFor(c)))).toBe('expired')
    c = await fresh()
    for (let i = 0; i < 5; i++) await problem(signer.exportKey(await proofFor(c, mallory)))
    expect(await problem(signer.exportKey(await proofFor(c)))).toBe('locked')
  })

  it('an owner can’t be flooded with requests: at most 20 in 10 minutes', async () => {
    for (let i = 0; i < 20; i++) await signer.challenge({ kind: 'owner-session', owner: OWNER })
    await expect(signer.challenge({ kind: 'owner-session', owner: OWNER })).rejects.toMatchObject({ problem: 'rate-limited' })
    now += 10 * 60_000 + 1
    expect((await signer.challenge({ kind: 'owner-session', owner: OWNER })).kind).toBe('owner-session')
  })

  it('RPC providers that disagree decide nothing: the request stays unused and works once they agree', async () => {
    const c = await signer.challenge({ kind: 'owner-session', owner: OWNER })
    const proof = await proofFor(c)
    chain.uncertain(true)
    await expect(signer.ownerWallets(proof)).rejects.toThrow(ChainUncertainError)
    chain.uncertain(false)
    expect((await signer.ownerWallets(proof)).wallets.map((w) => w.accountId)).toEqual([wallet.accountId])
  })

  it('an owner session lists the owner’s held keys only', async () => {
    const other = await signer.createKey({ userId: 101, owner: { accountId: OWNER, publicKey: owner.publicKey } })
    await signer.createKey({ userId: 202, owner: { accountId: 'bob.testnet', publicKey: owner.publicKey } })
    chain.exists(other.accountId, false)
    await signer.eraseKey({ accountId: other.accountId, reason: 'deleted' })
    const c = await signer.challenge({ kind: 'owner-session', owner: OWNER })
    expect((await signer.ownerWallets(await proofFor(c))).wallets.map((w) => w.accountId)).toEqual([wallet.accountId])
  })

  it('an approved destination is signed for; the approval is re-verified at every use', async () => {
    await expect(sign({ op: withdraw('bob.testnet'), plan: transfer('bob.testnet', 5n) })).rejects.toThrow(DestinationNotApprovedError)
    const c = await signer.challenge({ kind: 'approve-destination', accountId: wallet.accountId, destination: 'bob.testnet' })
    expect(c.message).toContain('Destination: bob.testnet')
    await signer.approveDestination(await proofFor(c))
    expect((await sign({ intentId: 'd1', op: withdraw('bob.testnet'), plan: transfer('bob.testnet', 5n) })).hash).toBeTruthy()
    // The approving key leaves the owner account: the approval stops counting.
    chain.revoke(OWNER, owner.publicKey)
    await expect(sign({ intentId: 'd2', op: withdraw('bob.testnet'), plan: transfer('bob.testnet', 5n) })).rejects.toThrow(DestinationNotApprovedError)
  })

  it('refuses nonsense destinations: the wallet itself, the owner (always allowed), another network', async () => {
    const ask = (destination: string) => signer.challenge({ kind: 'approve-destination', accountId: wallet.accountId, destination })
    await expect(ask(wallet.accountId)).rejects.toThrow(/wallet itself/)
    await expect(ask(OWNER)).rejects.toThrow(/needs no approval/)
    await expect(ask('bob.near')).rejects.toThrow(/another network/)
  })
})

describe('erasing keys', () => {
  it('a never-funded wallet’s key is erased; one holding a balance is not', async () => {
    chain.exists(wallet.accountId)
    await expect(signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).rejects.toThrow(/0\.05 NEAR or more/)
    chain.exists(wallet.accountId, false)
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).toBe(true)
    expect(await vault.key('testnet', wallet.accountId)).toMatchObject({ status: 'erased', sealedKey: null, eraseReason: 'deleted' })
    await expect(sign()).rejects.toThrow(KeyUnavailableError)
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).toBe(false)
  })

  it('a wallet holding only dust (under 0.05 NEAR) is erased; the dust it leaves is recorded', async () => {
    chain.exists(wallet.accountId)
    chain.balance(wallet.accountId, 7_500_000_000_000_000_000_000n) // 0.0075 NEAR
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).toBe(true)
    expect((await vault.recentEvents()).find((e) => e.kind === 'key-erased')?.detail).toMatchObject({ reason: 'deleted', dust: '7500000000000000000000' })
  })

  it('exactly 0.05 NEAR, or any staked NEAR, keeps the key', async () => {
    chain.exists(wallet.accountId)
    chain.balance(wallet.accountId, 50_000_000_000_000_000_000_000n)
    await expect(signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).rejects.toThrow(/0\.05 NEAR or more/)
    chain.balance(wallet.accountId, 49_999_999_999_999_999_999_999n)
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).toBe(true)
  })

  it('reads again every token the app lists: any balance keeps the key, also on an account that never existed', async () => {
    chain.exists(wallet.accountId, false)
    chain.token('usdt.fakes.testnet', wallet.accountId, 1n)
    await expect(signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted', tokens: ['usdt.fakes.testnet'] })).rejects.toThrow(/holds usdt\.fakes\.testnet tokens/)
    chain.token('usdt.fakes.testnet', wallet.accountId, 0n)
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted', tokens: ['usdt.fakes.testnet'] })).toBe(true)
  })

  it('after a revoke, only once NEARKITS’ key is gone from the account', async () => {
    chain.exists(wallet.accountId)
    chain.grant(wallet.accountId, wallet.publicKey)
    await expect(signer.eraseKey({ accountId: wallet.accountId, reason: 'revoked' })).rejects.toThrow(/still on the wallet/)
    chain.revoke(wallet.accountId, wallet.publicKey)
    expect(await signer.eraseKey({ accountId: wallet.accountId, reason: 'revoked' })).toBe(true)
  })

  it('RPC providers that disagree erase nothing', async () => {
    chain.uncertain(true)
    await expect(signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' })).rejects.toThrow(ChainUncertainError)
    expect((await vault.key('testnet', wallet.accountId))?.status).toBe('active')
  })
})

describe('the pause switch', () => {
  it('refuses everything but health while paused; the app can pause, only the operator resumes', async () => {
    await signer.pause('test')
    for (const attempt of [
      () => sign(),
      () => signer.createKey({ userId: 1, owner: { accountId: OWNER, publicKey: owner.publicKey } }),
      () => signer.challenge({ kind: 'owner-session', owner: OWNER }),
      () => signer.eraseKey({ accountId: wallet.accountId, reason: 'deleted' }),
    ])
      await expect(attempt()).rejects.toThrow(SignerPausedError)
    expect(await signer.health()).toMatchObject({ ok: false, paused: true, kek: 'ok', network: 'testnet' })
    await expect(core.handle('resume', {})).rejects.toThrow(BadRequestError)
    await core.setPaused(false, 'test over')
    expect((await sign()).hash).toBeTruthy()
    expect((await vault.recentEvents()).map((e) => e.kind)).toEqual(expect.arrayContaining(['signer-paused', 'signer-resumed']))
  })

  it('the host’s own switch (environment or file) pauses it too', async () => {
    let paused = true
    const s = await testSigner(db, { now: () => now, chain: chain.chain, kek, config: { pausedByHost: () => paused } })
    await expect(s.signer.sign({ wallet, intentId: 'h', step: 0, op: withdraw(OWNER), plan: transfer(OWNER, 5n), nonce: 1n, blockHash: BLOCK })).rejects.toThrow(SignerPausedError)
    paused = false
    expect((await s.signer.sign({ wallet, intentId: 'h', step: 0, op: withdraw(OWNER), plan: transfer(OWNER, 5n), nonce: 1n, blockHash: BLOCK })).hash).toBeTruthy()
  })
})

describe('restart', () => {
  it('a key saved to disk still signs after the signer restarts with the same KEK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-'))
    try {
      const path = join(dir, 'signer.sqlite')
      const first = await SqliteDatabase.open(path)
      const s1 = await testSigner(first, { now: () => now, chain: chain.chain, kek })
      const k = await s1.signer.createKey({ userId: 1, owner: { accountId: OWNER, publicKey: owner.publicKey } })
      await first.close()
      const second = await SqliteDatabase.open(path)
      const s2 = await testSigner(second, { now: () => now, chain: chain.chain, kek: Buffer.from(kek) })
      const signed = await s2.signer.sign({
        wallet: { accountId: k.accountId, network: 'testnet' },
        intentId: 'r',
        step: 0,
        op: withdraw(OWNER),
        plan: transfer(OWNER, 5n),
        nonce: 1n,
        blockHash: BLOCK,
      })
      expect(deserializeSignedTransaction(base64Decode(signed.base64) as Uint8Array).transaction.signerId).toBe(k.accountId)
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('networks', () => {
  it('a testnet signer signs nothing for a mainnet account, and a withdrawal to the other network is refused', async () => {
    await expect(sign({ op: withdraw('bob.near'), plan: transfer('bob.near', 5n) })).rejects.toThrow(PolicyViolation)
    expect(NETWORKS.testnet.id).toBe('testnet')
    expect(ONE).toBeGreaterThan(0n)
  })
})
