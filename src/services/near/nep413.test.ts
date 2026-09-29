import { describe, expect, it } from 'vitest'
import { base58Encode, base64Encode } from '@/lib/encoding'
import { accessKeyPermission, decodeEd25519Signature, nep413Digest, NEP413_TAG, parseEd25519PublicKey, serializeNep413, verifyNep413 } from './nep413'
import { RpcError, type RpcClient } from './rpc'

const nonce = Uint8Array.from({ length: 32 }, (_, i) => i)

async function keypair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { pair, publicKey: `ed25519:${base58Encode(raw)}` }
}

async function sign(pair: CryptoKeyPair, payload: Parameters<typeof nep413Digest>[0]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, await nep413Digest(payload)))
}

describe('NEP-413 payload', () => {
  it('serializes tag, message, nonce, recipient and an absent callback exactly as borsh does', () => {
    const bytes = serializeNep413({ message: 'hi', nonce, recipient: 'ab' })
    const expected = [
      ...[0x9d, 0x01, 0x00, 0x80], // u32 tag 2^31 + 413, little-endian
      ...[2, 0, 0, 0, 0x68, 0x69], // "hi"
      ...nonce,
      ...[2, 0, 0, 0, 0x61, 0x62], // "ab"
      0, // callbackUrl: None
    ]
    expect(NEP413_TAG).toBe(2 ** 31 + 413)
    expect([...bytes]).toEqual(expected)
  })

  it('serializes a callback URL as Some(string)', () => {
    const bytes = serializeNep413({ message: '', nonce, recipient: '', callbackUrl: 'x' })
    expect([...bytes.slice(-6)]).toEqual([1, 1, 0, 0, 0, 0x78])
  })

  it('encodes UTF-8 messages by byte length', () => {
    const bytes = serializeNep413({ message: 'ž', nonce, recipient: '' })
    expect([...bytes.slice(4, 10)]).toEqual([2, 0, 0, 0, 0xc5, 0xbe])
  })

  it('refuses a nonce that is not 32 bytes', () => {
    expect(() => serializeNep413({ message: 'x', nonce: new Uint8Array(31), recipient: 'r' })).toThrow(/32 bytes/)
  })
})

describe('NEP-413 signatures', () => {
  const payload = { message: 'Link Telegram @alice to NearKit', nonce, recipient: 'nearkit.vercel.app' }

  it('accepts a signature by the key, in base64 or base58', async () => {
    const { pair, publicKey } = await keypair()
    const signature = await sign(pair, payload)
    expect(await verifyNep413(payload, publicKey, base64Encode(signature))).toBe(true)
    expect(await verifyNep413(payload, publicKey, base58Encode(signature))).toBe(true)
  })

  it('refuses a changed message, nonce or recipient, and another key', async () => {
    const { pair, publicKey } = await keypair()
    const other = await keypair()
    const signature = base64Encode(await sign(pair, payload))
    expect(await verifyNep413({ ...payload, message: payload.message + '!' }, publicKey, signature)).toBe(false)
    expect(await verifyNep413({ ...payload, nonce: new Uint8Array(32) }, publicKey, signature)).toBe(false)
    expect(await verifyNep413({ ...payload, recipient: 'evil.example' }, publicKey, signature)).toBe(false)
    expect(await verifyNep413(payload, other.publicKey, signature)).toBe(false)
  })

  it('refuses malformed keys and signatures instead of throwing', async () => {
    expect(parseEd25519PublicKey('secp256k1:abc')).toBeNull()
    expect(parseEd25519PublicKey('ed25519:abc')).toBeNull()
    expect(decodeEd25519Signature('short')).toBeNull()
    expect(await verifyNep413(payload, 'ed25519:abc', 'short')).toBe(false)
  })
})

describe('access key permission', () => {
  const rpcAnswering = (answer: () => unknown): RpcClient =>
    ({
      urls: ['fake'],
      call: async () => answer(),
    }) as unknown as RpcClient

  it('tells a full-access key from a function-call key and a missing one', async () => {
    expect(
      await accessKeyPermission(
        rpcAnswering(() => ({ nonce: 1, permission: 'FullAccess' })),
        'a.near',
        'ed25519:k',
      ),
    ).toBe('full')
    expect(
      await accessKeyPermission(
        rpcAnswering(() => ({ nonce: 1, permission: { FunctionCall: { receiver_id: 'x', method_names: [] } } })),
        'a.near',
        'ed25519:k',
      ),
    ).toBe('function-call')
    expect(
      await accessKeyPermission(
        rpcAnswering(() => {
          throw new RpcError('handler', 'no key', 'UNKNOWN_ACCESS_KEY')
        }),
        'a.near',
        'ed25519:k',
      ),
    ).toBe('missing')
    expect(
      await accessKeyPermission(
        rpcAnswering(() => ({ error: 'access key ed25519:k does not exist while viewing' })),
        'a.near',
        'ed25519:k',
      ),
    ).toBe('missing')
  })

  it('lets transport failures through, so the caller can say "try again"', async () => {
    const rpc = rpcAnswering(() => {
      throw new RpcError('transport', 'All RPC endpoints failed')
    })
    await expect(accessKeyPermission(rpc, 'a.near', 'ed25519:k')).rejects.toThrow(/All RPC endpoints failed/)
  })
})
