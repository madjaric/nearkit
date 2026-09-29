import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Envelope encryption for trading-wallet keys.
 *
 * - Each wallet key is encrypted (AES-256-GCM) with its own random data key (DEK).
 * - The DEK is encrypted by a key-encryption key (KEK) through a `KeyWrapper`. The
 *   database stores only ciphertexts and the KEK's reference, never the KEK.
 * - Both layers carry additional data naming the network and the account, so a
 *   ciphertext copied onto another wallet's row fails to open.
 *
 * On testnet the KEK is a 32-byte secret from the server's environment
 * (`localKeyWrapper`). Before mainnet it must live in a KMS or HSM (AWS KMS, GCP
 * KMS, Vault transit): a `KeyWrapper` whose wrap/unwrap call the KMS, so the KEK
 * never exists in this process. Nothing else here changes.
 */

export interface KeyWrapper {
  /** Names the KEK (a fingerprint, never the key); stored with every wallet it sealed. */
  readonly ref: string
  wrap(dek: Buffer, aad: string): Promise<string>
  unwrap(wrapped: string, aad: string): Promise<Buffer>
}

export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyUnavailableError'
  }
}

/** A sealed wallet key as stored (JSON). Every field is ciphertext or public metadata. */
export interface SealedSecret {
  v: 1
  /** KeyWrapper.ref of the KEK that wrapped the DEK. */
  ref: string
  /** The DEK, encrypted by the KEK. */
  dek: string
  iv: string
  tag: string
  ct: string
}

const GCM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function seal(key: Buffer, plain: Buffer, aad: string) {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv(GCM, key, iv)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv, ct, tag: c.getAuthTag() }
}

/** Throws on a wrong key, wrong additional data or any tampering. */
function unseal(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: string): Buffer {
  const d = createDecipheriv(GCM, key, iv)
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/** Testnet KEK held in memory, from the server environment. */
export function localKeyWrapper(kek: Buffer): KeyWrapper {
  if (kek.length !== 32) throw new Error('The wallet key-encryption key must be 32 bytes')
  const key = Buffer.from(kek)
  const ref = `local:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
  const context = (aad: string) => `nearkit:dek:v1|${aad}`
  return {
    ref,
    async wrap(dek, aad) {
      const s = seal(key, dek, context(aad))
      return Buffer.concat([s.iv, s.tag, s.ct]).toString('base64')
    },
    async unwrap(wrapped, aad) {
      const b = Buffer.from(wrapped, 'base64')
      if (b.length <= IV_BYTES + TAG_BYTES) throw new KeyUnavailableError('A wrapped wallet data key is malformed')
      try {
        return unseal(key, b.subarray(0, IV_BYTES), b.subarray(IV_BYTES + TAG_BYTES), b.subarray(IV_BYTES, IV_BYTES + TAG_BYTES), context(aad))
      } catch {
        throw new KeyUnavailableError('A wallet data key did not open with this server’s key-encryption key')
      }
    },
  }
}

const secretContext = (aad: string) => `nearkit:secret:v1|${aad}`

export async function sealSecret(wrapper: KeyWrapper, secret: Buffer, aad: string): Promise<SealedSecret> {
  const dek = randomBytes(32)
  try {
    const s = seal(dek, secret, secretContext(aad))
    return { v: 1, ref: wrapper.ref, dek: await wrapper.wrap(dek, aad), iv: s.iv.toString('base64'), tag: s.tag.toString('base64'), ct: s.ct.toString('base64') }
  } finally {
    dek.fill(0)
  }
}

/** The plain secret. The caller wipes it (`fill(0)`) as soon as it is done. */
export async function openSecret(wrapper: KeyWrapper, sealed: SealedSecret, aad: string): Promise<Buffer> {
  if (sealed.v !== 1) throw new KeyUnavailableError('Unknown sealed wallet key format')
  if (sealed.ref !== wrapper.ref) throw new KeyUnavailableError(`This wallet key was sealed with another key-encryption key (${sealed.ref})`)
  const dek = await wrapper.unwrap(sealed.dek, aad)
  try {
    return unseal(dek, Buffer.from(sealed.iv, 'base64'), Buffer.from(sealed.ct, 'base64'), Buffer.from(sealed.tag, 'base64'), secretContext(aad))
  } catch {
    throw new KeyUnavailableError('A wallet key failed its integrity check')
  } finally {
    dek.fill(0)
  }
}

/** Moves a sealed key to a new KEK (rotation, or the move to a KMS) without decrypting the key itself. */
export async function rewrapSecret(from: KeyWrapper, to: KeyWrapper, sealed: SealedSecret, aad: string): Promise<SealedSecret> {
  if (sealed.ref !== from.ref) throw new KeyUnavailableError(`This wallet key was sealed with another key-encryption key (${sealed.ref})`)
  const dek = await from.unwrap(sealed.dek, aad)
  try {
    return { ...sealed, ref: to.ref, dek: await to.wrap(dek, aad) }
  } finally {
    dek.fill(0)
  }
}

export function parseSealed(text: string): SealedSecret {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new KeyUnavailableError('A stored wallet key is not readable')
  }
  const v = value as Partial<SealedSecret>
  if (v?.v !== 1 || [v.ref, v.dek, v.iv, v.tag, v.ct].some((f) => typeof f !== 'string' || !f)) throw new KeyUnavailableError('A stored wallet key is malformed')
  return v as SealedSecret
}

/** Parses a KEK from its base64 form; null when it isn't exactly 32 bytes. */
export function parseKek(text: string | undefined): Buffer | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null
  const bytes = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return bytes.length === 32 ? bytes : null
}
