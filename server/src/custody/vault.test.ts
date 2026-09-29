import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base58Decode } from '@/lib/encoding'
import { deserializeSignedTransaction, serializeSignedTransaction, serializeTransaction, transactionDigest } from '@/services/near/transaction'
import { generateKey, implicitAccountId, nearPublicKey, publicKeyOf, secretKeyText, signWithSeed } from './keys'
import { KeyUnavailableError, localKeyWrapper, openSecret, parseKek, parseSealed, rewrapSecret, sealSecret } from './vault'

const AAD = 'testnet:' + 'a'.repeat(64)

describe('trading wallet keys', () => {
  it('generates an ed25519 key whose implicit account is its public key in hex', () => {
    const k = generateKey()
    expect(k.seed).toHaveLength(32)
    expect(k.publicKey).toHaveLength(32)
    expect(publicKeyOf(k.seed)).toEqual(k.publicKey)
    expect(implicitAccountId(k.publicKey)).toMatch(/^[0-9a-f]{64}$/)
    expect(nearPublicKey(k.publicKey)).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  })

  it('signs what WebCrypto verifies: a real NEAR transaction signature', async () => {
    const k = generateKey()
    const tx = {
      signerId: implicitAccountId(k.publicKey),
      publicKey: nearPublicKey(k.publicKey),
      nonce: 5n,
      receiverId: 'bob.testnet',
      blockHash: new Uint8Array(32).fill(7),
      actions: [{ type: 'Transfer' as const, deposit: 1n }],
    }
    const digest = await transactionDigest(serializeTransaction(tx))
    const signed = serializeSignedTransaction(tx, signWithSeed(k.seed, digest))
    const read = deserializeSignedTransaction(signed)
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(k.publicKey), { name: 'Ed25519' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, read.signature, await transactionDigest(read.transactionBytes))).toBe(true)
  })

  it('exports in the format wallets import: seed ‖ public key, base58', () => {
    const k = generateKey()
    const text = secretKeyText(k.seed)
    const raw = base58Decode(text.slice('ed25519:'.length)) as Uint8Array
    expect(raw).toHaveLength(64)
    expect(Buffer.from(raw.subarray(0, 32)).equals(k.seed)).toBe(true)
    expect(raw.subarray(32)).toEqual(k.publicKey)
  })
})

describe('envelope encryption', () => {
  const kek = randomBytes(32)
  const wrapper = localKeyWrapper(kek)

  it('stores nothing that reveals the key: the sealed form holds ciphertexts and the KEK reference only', async () => {
    const k = generateKey()
    const sealed = await sealSecret(wrapper, k.seed, AAD)
    const stored = JSON.stringify(sealed)
    expect(stored).not.toContain(k.seed.toString('base64'))
    expect(stored).not.toContain(k.seed.toString('hex'))
    expect(stored).not.toContain(secretKeyText(k.seed).slice(8, 40))
    expect(stored).not.toContain(kek.toString('base64'))
    expect(sealed.ref).toBe(wrapper.ref)
    expect(wrapper.ref).toMatch(/^local:[0-9a-f]{16}$/)
    expect((await openSecret(wrapper, parseSealed(stored), AAD)).equals(k.seed)).toBe(true)
  })

  it('refuses a wrong KEK, another wallet’s additional data and any tampering', async () => {
    const seed = generateKey().seed
    const sealed = await sealSecret(wrapper, seed, AAD)
    const other = localKeyWrapper(randomBytes(32))
    await expect(openSecret(other, sealed, AAD)).rejects.toThrow(KeyUnavailableError)
    // Same reference but a different key: the KEK itself decides, not the label.
    await expect(openSecret({ ...other, ref: wrapper.ref }, sealed, AAD)).rejects.toThrow(/did not open/)
    await expect(openSecret(wrapper, sealed, 'testnet:' + 'b'.repeat(64))).rejects.toThrow(KeyUnavailableError)
    const flipped = Buffer.from(sealed.ct, 'base64')
    flipped[0] = (flipped[0] as number) ^ 1
    await expect(openSecret(wrapper, { ...sealed, ct: flipped.toString('base64') }, AAD)).rejects.toThrow(/integrity/)
    await expect(openSecret(wrapper, { ...sealed, tag: Buffer.alloc(16).toString('base64') }, AAD)).rejects.toThrow(KeyUnavailableError)
  })

  it('moves a key to a new KEK without opening it; the old KEK no longer opens the result', async () => {
    const seed = generateKey().seed
    const sealed = await sealSecret(wrapper, seed, AAD)
    const next = localKeyWrapper(randomBytes(32))
    const moved = await rewrapSecret(wrapper, next, sealed, AAD)
    expect(moved.ct).toBe(sealed.ct)
    expect((await openSecret(next, moved, AAD)).equals(seed)).toBe(true)
    await expect(openSecret(wrapper, moved, AAD)).rejects.toThrow(/another key-encryption key/)
  })

  it('reads a KEK only when it is exactly 32 bytes of base64', () => {
    expect(parseKek(randomBytes(32).toString('base64'))?.length).toBe(32)
    expect(parseKek(randomBytes(32).toString('base64url'))?.length).toBe(32)
    expect(parseKek(randomBytes(16).toString('base64'))).toBeNull()
    expect(parseKek('not base64!')).toBeNull()
    expect(parseKek(undefined)).toBeNull()
    expect(() => localKeyWrapper(randomBytes(31))).toThrow(/32 bytes/)
    expect(() => parseSealed('{"v":2}')).toThrow(/malformed/)
  })
})
