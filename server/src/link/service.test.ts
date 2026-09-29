import { beforeEach, describe, expect, it } from 'vitest'
import { base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { nep413Digest } from '@/services/near/nep413'
import { createFakeChain, type FakeChain } from '@/services/real/testing/fakeChain'
import { loadConfig } from '../config'
import { migrate } from '../db/schema'
import { Db } from '../db/sqlite'
import { Store } from '../db/store'
import { createServerNear } from '../near'
import { createLinkService, LinkApiError, LINK_TTL_MS } from './service'

const alice = { userId: 101, username: 'alice', firstName: 'Alice', languageCode: 'en' }
const mallory = { userId: 666, username: 'mallory', firstName: 'Mallory', languageCode: null }

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  return { pair, publicKey: `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}` }
}

let now = 5_000_000
let store: Store
let chain: FakeChain
let service: ReturnType<typeof createLinkService>
let aliceKey: Awaited<ReturnType<typeof keypair>>
let appKey: Awaited<ReturnType<typeof keypair>>

beforeEach(async () => {
  now = 5_000_000
  const db = await Db.open(null)
  migrate(db)
  store = new Store(db, () => now)
  store.upsertUser(alice)
  store.upsertUser(mallory)
  aliceKey = await keypair()
  appKey = await keypair()
  chain = createFakeChain({
    accounts: {
      'alice.testnet': { amount: 10n ** 24n, keys: { [aliceKey.publicKey]: 'full', [appKey.publicKey]: 'function-call' } },
    },
  })
  const { config } = loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_WEB_URL: 'https://nearkit.vercel.app' })
  const near = createServerNear(config, chain.fetch, () => now)
  service = createLinkService({ store, config, rpc: near.ctx.rpc, now: () => now })
})

/** What a wallet does with the describe answer. */
async function walletSign(described: { message: string; nonce: string; recipient: string }, key: CryptoKeyPair) {
  const digest = await nep413Digest({ message: described.message, nonce: base64Decode(described.nonce) as Uint8Array, recipient: described.recipient })
  return base64Encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, digest)))
}

describe('account linking', () => {
  it('issues a one-time code whose page names the Telegram account, and links on a valid full-access signature', async () => {
    const { code, url, expiresAt } = service.createRequest(alice.userId)
    expect(url).toBe(`https://nearkit.vercel.app/telegram#link=${code}`)
    expect(expiresAt).toBe(now + LINK_TTL_MS)
    // Only a hash of the code is stored.
    expect(JSON.stringify(store.db.all('SELECT * FROM link_requests'))).not.toContain(code)

    const described = service.describe(code)
    expect(described).toMatchObject({ telegram: { name: 'Alice', username: 'alice' }, network: 'testnet', recipient: 'nearkit.vercel.app' })
    expect(described.message).toContain('@alice')
    expect(described.message).toContain('testnet')

    const signature = await walletSign(described, aliceKey.pair)
    const result = await service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature })
    expect(result).toEqual({ accountId: 'alice.testnet', userId: alice.userId, previousUserId: null })
    expect(store.linksOf(alice.userId, 'testnet').map((l) => l.accountId)).toEqual(['alice.testnet'])
    // The first linked account becomes the default for trading.
    expect(store.getSettings(alice.userId).defaultAccount).toBe('alice.testnet')
  })

  it('refuses a signature from a function-call key (apps get those), even though it is valid', async () => {
    const { code } = service.createRequest(alice.userId)
    const signature = await walletSign(service.describe(code), appKey.pair)
    await expect(service.confirm({ code, accountId: 'alice.testnet', publicKey: appKey.publicKey, signature })).rejects.toMatchObject({ status: 403, code: 'function-call-key' })
    expect(store.linksOf(alice.userId, 'testnet')).toEqual([])
  })

  it('refuses a key that is not on the account', async () => {
    const stranger = await keypair()
    const { code } = service.createRequest(alice.userId)
    const signature = await walletSign(service.describe(code), stranger.pair)
    await expect(service.confirm({ code, accountId: 'alice.testnet', publicKey: stranger.publicKey, signature })).rejects.toMatchObject({ status: 403, code: 'key-not-on-account' })
  })

  it('refuses a signature over a different message: someone else’s wallet can’t claim this code', async () => {
    const { code } = service.createRequest(alice.userId)
    const described = service.describe(code)
    const signature = await walletSign({ ...described, message: described.message.replace('@alice', '@mallory') }, aliceKey.pair)
    await expect(service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature })).rejects.toMatchObject({ status: 401, code: 'bad-signature' })
  })

  it('refuses reuse and expiry', async () => {
    const { code } = service.createRequest(alice.userId)
    const signature = await walletSign(service.describe(code), aliceKey.pair)
    await service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature })
    await expect(service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature })).rejects.toMatchObject({ status: 409 })

    const second = service.createRequest(alice.userId)
    now += LINK_TTL_MS + 1
    expect(() => service.describe(second.code)).toThrow(LinkApiError)
    await expect(service.confirm({ code: second.code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature: 'x' })).rejects.toMatchObject({ status: 410 })
  })

  it('locks a code after too many bad attempts', async () => {
    const { code } = service.createRequest(alice.userId)
    for (let i = 0; i < 5; i++)
      await service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature: base64Encode(new Uint8Array(64)) }).catch(() => undefined)
    const signature = await walletSign(service.describe(code), aliceKey.pair)
    await expect(service.confirm({ code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature })).rejects.toMatchObject({ status: 429 })
  })

  it('limits how many codes one Telegram user can request', () => {
    for (let i = 0; i < 5; i++) service.createRequest(alice.userId)
    expect(() => service.createRequest(alice.userId)).toThrow(/Too many link requests/)
  })

  it('moves an account to another Telegram user only with the owner’s signature, and names the previous user', async () => {
    const first = service.createRequest(mallory.userId)
    // Mallory can't sign for alice.testnet: her attempt fails, the account stays unlinked.
    const malloryKey = await keypair()
    await expect(
      service.confirm({
        code: first.code,
        accountId: 'alice.testnet',
        publicKey: malloryKey.publicKey,
        signature: await walletSign(service.describe(first.code), malloryKey.pair),
      }),
    ).rejects.toMatchObject({ status: 403 })

    const a = service.createRequest(alice.userId)
    await service.confirm({ code: a.code, accountId: 'alice.testnet', publicKey: aliceKey.publicKey, signature: await walletSign(service.describe(a.code), aliceKey.pair) })
    // Alice herself (the key owner) later links the account to her other Telegram account: allowed, and reported.
    const b = service.createRequest(mallory.userId)
    const moved = await service.confirm({
      code: b.code,
      accountId: 'alice.testnet',
      publicKey: aliceKey.publicKey,
      signature: await walletSign(service.describe(b.code), aliceKey.pair),
    })
    expect(moved.previousUserId).toBe(alice.userId)
  })

  it('refuses accounts from the other network and malformed input', async () => {
    const { code } = service.createRequest(alice.userId)
    await expect(service.confirm({ code, accountId: 'alice.near', publicKey: aliceKey.publicKey, signature: 'x' })).rejects.toMatchObject({ status: 400, code: 'network' })
    await expect(service.confirm({ code, accountId: 'Not An Account', publicKey: aliceKey.publicKey, signature: 'x' })).rejects.toMatchObject({ status: 400 })
    expect(() => service.describe('')).toThrow(LinkApiError)
  })
})
