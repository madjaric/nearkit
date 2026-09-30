import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateKey, implicitAccountId, nearPublicKey } from '../custody/keys'
import { keyring, KeyUnavailableError, localKeyWrapper, parseSealed, sealSecret } from '../custody/vault'
import { aadV1, bindOwnerKey, openWalletKey, resealWalletKey, sealWalletKey, type KeyBinding } from './envelope'
import { kmsKeyWrapper, KmsUnavailableError, parseKeyArn, probeKek, type KmsApi } from './kms'

const ARN = 'arn:aws:kms:eu-central-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab'
const ARN2 = 'arn:aws:kms:eu-central-1:123456789012:key/mrk-0123456789abcdef0123456789abcdef'

/**
 * A stand-in for AWS KMS with the properties NearKit relies on: the key never leaves it,
 * and a ciphertext decrypts only with the exact encryption context it was made with.
 */
function fakeKms(keyId = ARN) {
  const key = randomBytes(32)
  const calls = { encrypt: 0, decrypt: 0 }
  let down = false
  const aad = (ctx: Record<string, string>) =>
    Buffer.from(
      JSON.stringify(
        Object.keys(ctx)
          .sort()
          .map((k) => [k, ctx[k]]),
      ),
    )
  const api: KmsApi = {
    keyId,
    async encrypt(plain, ctx) {
      calls.encrypt++
      if (down) throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(aad(ctx))
      const ct = Buffer.concat([c.update(plain), c.final()])
      return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]))
    },
    async decrypt(blob, ctx) {
      calls.decrypt++
      if (down) throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })
      const b = Buffer.from(blob)
      try {
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
        d.setAAD(aad(ctx))
        d.setAuthTag(b.subarray(12, 28))
        return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]))
      } catch {
        throw Object.assign(new Error('invalid'), { name: 'InvalidCiphertextException' })
      }
    },
  }
  return { api, calls, setDown: (v: boolean) => void (down = v) }
}

function newKey(owner: string | null = 'alice.testnet') {
  const k = generateKey()
  const accountId = implicitAccountId(k.publicKey)
  const binding: KeyBinding = { network: 'testnet', accountId, publicKey: nearPublicKey(k.publicKey), owner }
  return { seed: k.seed, binding }
}

describe('KMS-held key-encryption key', () => {
  it('wraps each data key in the KMS, bound to its wallet by the encryption context', async () => {
    const kms = fakeKms()
    const keys = keyring(kmsKeyWrapper(kms.api))
    const { seed, binding } = newKey()
    const sealed = await sealWalletKey(keys, seed, binding)
    expect(parseSealed(sealed)).toMatchObject({ v: 2, ref: `kms:${ARN}` })
    expect(sealed).not.toContain(seed.toString('base64'))
    const opened = await openWalletKey(keys, sealed, binding)
    expect(opened.equals(seed)).toBe(true)
    expect(kms.calls).toEqual({ encrypt: 1, decrypt: 1 })
    // The same ciphertext on another wallet (or for another owner) is refused by the KMS itself.
    await expect(openWalletKey(keys, sealed, { ...binding, owner: 'mallory.testnet' })).rejects.toThrow(KeyUnavailableError)
    await expect(openWalletKey(keys, sealed, { ...binding, accountId: 'b'.repeat(64) })).rejects.toThrow(KeyUnavailableError)
  })

  it('an unreachable KMS fails closed as "unavailable", never as a wrong key', async () => {
    const kms = fakeKms()
    const keys = keyring(kmsKeyWrapper(kms.api))
    const { seed, binding } = newKey()
    const sealed = await sealWalletKey(keys, seed, binding)
    kms.setDown(true)
    await expect(openWalletKey(keys, sealed, binding)).rejects.toThrow(KmsUnavailableError)
    await expect(sealWalletKey(keys, seed, binding)).rejects.toThrow(KmsUnavailableError)
    expect(await probeKek(keys.current)).toMatch(/could not be asked|did not wrap/)
    kms.setDown(false)
    expect(await probeKek(keys.current)).toBe('ok')
  })

  it('accepts only exact AWS key ARNs (an alias could point somewhere else later)', () => {
    expect(parseKeyArn(ARN)).toEqual({ arn: ARN, region: 'eu-central-1' })
    expect(parseKeyArn(ARN2)?.region).toBe('eu-central-1')
    expect(parseKeyArn('arn:aws:kms:eu-central-1:123456789012:alias/nearkit')).toBeNull()
    expect(parseKeyArn('alias/nearkit')).toBeNull()
    expect(parseKeyArn(undefined)).toBeNull()
  })
})

describe('rotation and migration', () => {
  it('moves keys to a new KEK: rewraps the data key only, and the old KEK can then be retired', async () => {
    const oldKms = fakeKms(ARN)
    const newKms = fakeKms(ARN2)
    const before = keyring(kmsKeyWrapper(oldKms.api))
    const { seed, binding } = newKey()
    const sealed = await sealWalletKey(before, seed, binding)
    const during = keyring(kmsKeyWrapper(newKms.api), [kmsKeyWrapper(oldKms.api)])
    // Keys not moved yet still open during the rotation.
    expect((await openWalletKey(during, sealed, binding)).equals(seed)).toBe(true)
    const moved = await resealWalletKey(during, sealed, binding)
    expect(moved.changed).toBe(true)
    expect(parseSealed(moved.sealed)).toMatchObject({ v: 2, ref: `kms:${ARN2}` })
    // The wallet key's own ciphertext is the same: only its data key was rewrapped.
    expect(parseSealed(moved.sealed).ct).toBe(parseSealed(sealed).ct)
    const after = keyring(kmsKeyWrapper(newKms.api))
    expect((await openWalletKey(after, moved.sealed, binding)).equals(seed)).toBe(true)
    await expect(openWalletKey(keyring(kmsKeyWrapper(oldKms.api)), moved.sealed, binding)).rejects.toThrow(KeyUnavailableError)
    expect(await resealWalletKey(after, moved.sealed, binding)).toEqual({ sealed: moved.sealed, changed: false })
  })

  it('moves a testnet key from the environment KEK and the v1 sealing to a KMS and the owner-bound v2 sealing', async () => {
    const local = localKeyWrapper(randomBytes(32))
    const { seed, binding } = newKey()
    const v1 = JSON.stringify(await sealSecret(local, seed, aadV1(binding.network, binding.accountId)))
    const kms = fakeKms()
    const keys = keyring(kmsKeyWrapper(kms.api), [local])
    expect((await openWalletKey(keys, v1, binding)).equals(seed)).toBe(true)
    const moved = await resealWalletKey(keys, v1, binding)
    expect(parseSealed(moved.sealed)).toMatchObject({ v: 2, ref: `kms:${ARN}` })
    expect((await openWalletKey(keyring(kmsKeyWrapper(kms.api)), moved.sealed, binding)).equals(seed)).toBe(true)
    // Now bound to its owner: another owner can't open it.
    await expect(openWalletKey(keys, moved.sealed, { ...binding, owner: 'mallory.testnet' })).rejects.toThrow(KeyUnavailableError)
  })

  it('a key made before owners were recorded stays v1, moved to the new KEK', async () => {
    const local = localKeyWrapper(randomBytes(32))
    const { seed, binding } = newKey(null)
    const v1 = JSON.stringify(await sealSecret(local, seed, aadV1(binding.network, binding.accountId)))
    const next = localKeyWrapper(randomBytes(32))
    const moved = await resealWalletKey(keyring(next, [local]), v1, binding)
    expect(parseSealed(moved.sealed)).toMatchObject({ v: 1, ref: next.ref })
    expect((await openWalletKey(keyring(next), moved.sealed, binding)).equals(seed)).toBe(true)
  })

  it('a key that isn’t the wallet’s own never opens as it', async () => {
    const keys = keyring(localKeyWrapper(randomBytes(32)))
    const a = newKey()
    const sealed = await sealWalletKey(keys, a.seed, a.binding)
    await expect(openWalletKey(keys, sealed, { ...a.binding, publicKey: newKey().binding.publicKey })).rejects.toThrow(/does not match/)
  })
})

describe('wallets with no owner wallet: sealed to the Telegram account that controls them', () => {
  const unowned = () => {
    const k = newKey(null)
    return { seed: k.seed, binding: { ...k.binding, controller: 101 } as KeyBinding }
  }

  it('opens only for that Telegram account: not another one, not an owner wallet, not with no binding', async () => {
    const kms = fakeKms()
    const keys = keyring(kmsKeyWrapper(kms.api))
    const { seed, binding } = unowned()
    const sealed = await sealWalletKey(keys, seed, binding)
    expect(parseSealed(sealed)).toMatchObject({ v: 3, ref: `kms:${ARN}` })
    expect((await openWalletKey(keys, sealed, binding)).equals(seed)).toBe(true)
    // A rewritten controller or owner in a database makes the key unopenable, never usable by someone else.
    await expect(openWalletKey(keys, sealed, { ...binding, controller: 102 })).rejects.toThrow(KeyUnavailableError)
    await expect(openWalletKey(keys, sealed, { ...binding, controller: null, owner: 'mallory.testnet' })).rejects.toThrow(KeyUnavailableError)
    await expect(openWalletKey(keys, sealed, { ...binding, controller: null })).rejects.toThrow(KeyUnavailableError)
  })

  it('a new key is always bound to an owner wallet or to a Telegram account', async () => {
    const keys = keyring(localKeyWrapper(randomBytes(32)))
    const { seed, binding } = newKey(null)
    await expect(sealWalletKey(keys, seed, binding)).rejects.toThrow(KeyUnavailableError)
    await expect(sealWalletKey(keys, seed, { ...binding, controller: 0 })).rejects.toThrow(KeyUnavailableError)
  })

  it('binding its first owner moves it to the owner sealing: from then on only that owner binding opens it', async () => {
    const keys = keyring(localKeyWrapper(randomBytes(32)))
    const { seed, binding } = unowned()
    const sealed = await sealWalletKey(keys, seed, binding)
    const owned = await bindOwnerKey(keys, sealed, binding, 'alice.testnet')
    expect(parseSealed(owned)).toMatchObject({ v: 2 })
    const asOwned: KeyBinding = { ...binding, owner: 'alice.testnet', controller: null }
    expect((await openWalletKey(keys, owned, asOwned)).equals(seed)).toBe(true)
    await expect(openWalletKey(keys, owned, binding)).rejects.toThrow(KeyUnavailableError)
    await expect(openWalletKey(keys, owned, { ...asOwned, owner: 'mallory.testnet' })).rejects.toThrow(KeyUnavailableError)
    // An owned key is never bound again.
    await expect(bindOwnerKey(keys, owned, asOwned, 'mallory.testnet')).rejects.toThrow(KeyUnavailableError)
  })

  it('rotation rewraps a controller-bound key’s data key without opening the key', async () => {
    const oldKms = fakeKms(ARN)
    const newKms = fakeKms(ARN2)
    const { seed, binding } = unowned()
    const sealed = await sealWalletKey(keyring(kmsKeyWrapper(oldKms.api)), seed, binding)
    const moved = await resealWalletKey(keyring(kmsKeyWrapper(newKms.api), [kmsKeyWrapper(oldKms.api)]), sealed, binding)
    expect(parseSealed(moved.sealed)).toMatchObject({ v: 3, ref: `kms:${ARN2}` })
    expect(parseSealed(moved.sealed).ct).toBe(parseSealed(sealed).ct)
    expect((await openWalletKey(keyring(kmsKeyWrapper(newKms.api)), moved.sealed, binding)).equals(seed)).toBe(true)
  })

  it('a key made before owners were recorded, whose Telegram account is known, moves to the controller sealing', async () => {
    const local = localKeyWrapper(randomBytes(32))
    const { seed, binding } = unowned()
    const v1 = JSON.stringify(await sealSecret(local, seed, aadV1(binding.network, binding.accountId)))
    const moved = await resealWalletKey(keyring(local), v1, binding)
    expect(parseSealed(moved.sealed)).toMatchObject({ v: 3 })
    expect((await openWalletKey(keyring(local), moved.sealed, binding)).equals(seed)).toBe(true)
    await expect(openWalletKey(keyring(local), moved.sealed, { ...binding, controller: 102 })).rejects.toThrow(KeyUnavailableError)
  })
})
