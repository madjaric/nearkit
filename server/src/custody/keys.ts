import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { base58Encode, hexEncode } from '@/lib/encoding'

/**
 * Ed25519 keys for NearKit trading wallets. A key is its 32-byte seed; the public
 * key and the implicit account ID (the public key in hex) follow from it. A seed
 * exists in plain form only inside the signer, for one operation, and is wiped
 * right after (best effort: Node keeps its own short-lived copy in KeyObjects).
 */

/** DER prefix of a PKCS#8 ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface GeneratedKey {
  seed: Buffer
  publicKey: Uint8Array
}

export function generateKey(): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const d = privateKey.export({ format: 'jwk' }).d
  const x = publicKey.export({ format: 'jwk' }).x
  if (typeof d !== 'string' || typeof x !== 'string') throw new Error('Could not read the generated ed25519 key')
  return { seed: Buffer.from(d, 'base64url'), publicKey: new Uint8Array(Buffer.from(x, 'base64url')) }
}

function privateKeyObject(seed: Buffer) {
  if (seed.length !== 32) throw new Error('An ed25519 seed is 32 bytes')
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed])
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } finally {
    der.fill(0)
  }
}

export function publicKeyOf(seed: Buffer): Uint8Array {
  const x = createPublicKey(privateKeyObject(seed)).export({ format: 'jwk' }).x
  if (typeof x !== 'string') throw new Error('Could not derive the public key')
  return new Uint8Array(Buffer.from(x, 'base64url'))
}

/** Ed25519 signature of `message` (for a transaction: its 32-byte SHA-256 digest). */
export function signWithSeed(seed: Buffer, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, privateKeyObject(seed)))
}

export const nearPublicKey = (raw: Uint8Array) => `ed25519:${base58Encode(raw)}`

/** NEAR implicit account: the public key in lowercase hex. It exists once it first receives NEAR. */
export const implicitAccountId = (raw: Uint8Array) => hexEncode(raw)

/** The format NEAR wallets import: `ed25519:` + base58 of seed ‖ public key. Only the recovery export uses it. */
export function secretKeyText(seed: Buffer): string {
  const full = Buffer.concat([seed, Buffer.from(publicKeyOf(seed))])
  try {
    return `ed25519:${base58Encode(full)}`
  } finally {
    full.fill(0)
  }
}
