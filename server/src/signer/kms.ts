import { randomBytes } from 'node:crypto'
import { KeyUnavailableError, type KeyWrapper } from '../custody/vault'

/**
 * Key-encryption keys held in a KMS: the KEK never exists in the signer's memory. The
 * signer asks the KMS to wrap each wallet's own data key, and to unwrap it for one
 * signature. The additional data (network, account, owner) travels as the KMS
 * encryption context: a wrapped data key opens only for the wallet it was made for, and
 * the KMS audit log names the wallet behind every unwrap (public data, never a secret).
 *
 * Rotation: the KMS's automatic key rotation needs nothing here (it keeps every version
 * and decrypts with the right one). Moving to another KMS key: make it the current key,
 * keep the old one among the previous keys, and run the reseal tool.
 */

export interface KmsApi {
  /** The KMS key (an AWS key ARN): stable, public, stored with every data key it wrapped. */
  readonly keyId: string
  encrypt(plaintext: Uint8Array, context: Record<string, string>): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array, context: Record<string, string>): Promise<Uint8Array>
}

/** The KMS could not be asked (network, throttling, outage): nothing is known about the key. Fails closed. */
export class KmsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KmsUnavailableError'
  }
}

const context = (aad: string) => ({ purpose: 'nearkit-wallet-dek', wallet: aad })

/** Errors meaning "this data key will never open here", as opposed to "ask again later". */
const REFUSALS = new Set(['InvalidCiphertextException', 'IncorrectKeyException', 'AccessDeniedException', 'NotFoundException', 'DisabledException', 'KMSInvalidStateException'])

function errorName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e && typeof e.name === 'string' ? e.name : 'error'
}

export function kmsKeyWrapper(api: KmsApi): KeyWrapper {
  return {
    ref: `kms:${api.keyId}`,
    async wrap(dek, aad) {
      let wrapped: Uint8Array
      try {
        wrapped = await api.encrypt(dek, context(aad))
      } catch (e) {
        throw new KmsUnavailableError(`The KMS did not wrap a wallet data key (${errorName(e)})`)
      }
      return Buffer.from(wrapped).toString('base64')
    },
    async unwrap(wrapped, aad) {
      let plain: Uint8Array
      try {
        plain = await api.decrypt(Buffer.from(wrapped, 'base64'), context(aad))
      } catch (e) {
        if (REFUSALS.has(errorName(e))) throw new KeyUnavailableError(`The KMS refused to open a wallet data key (${errorName(e)})`)
        throw new KmsUnavailableError(`The KMS could not be asked to open a wallet data key (${errorName(e)})`)
      }
      if (plain.length !== 32) throw new KeyUnavailableError('The KMS returned a malformed wallet data key')
      return Buffer.from(plain)
    },
  }
}

const KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** An AWS KMS key ARN; aliases are refused, since a sealed key must name the exact KMS key. */
export function parseKeyArn(text: string | undefined): { arn: string; region: string } | null {
  const arn = text?.trim() ?? ''
  const m = KEY_ARN.exec(arn)
  return m ? { arn, region: m[1] as string } : null
}

/**
 * AWS KMS (a symmetric encryption key) through the official SDK. Credentials come from
 * the host: an IAM role of the signer's machine or task, allowed kms:Encrypt and
 * kms:Decrypt on this key only. Nothing here holds or logs them. The SDK loads only
 * when an AWS key is configured.
 */
export async function awsKmsApi(keyArn: string): Promise<KmsApi> {
  const parsed = parseKeyArn(keyArn)
  if (!parsed) throw new Error('Not an AWS KMS key ARN')
  const sdk = await import('@aws-sdk/client-kms')
  const client = new sdk.KMSClient({ region: parsed.region, maxAttempts: 3 })
  return {
    keyId: parsed.arn,
    async encrypt(plaintext, ctx) {
      const r = await client.send(new sdk.EncryptCommand({ KeyId: parsed.arn, Plaintext: plaintext, EncryptionContext: ctx }))
      if (!r.CiphertextBlob) throw new KmsUnavailableError('The KMS returned no ciphertext')
      return r.CiphertextBlob
    },
    async decrypt(ciphertext, ctx) {
      const r = await client.send(new sdk.DecryptCommand({ KeyId: parsed.arn, CiphertextBlob: ciphertext, EncryptionContext: ctx }))
      if (!r.Plaintext) throw new KmsUnavailableError('The KMS returned no plaintext')
      return r.Plaintext
    },
  }
}

/** A round trip through the KEK with a throwaway value: the signer's health check. Never a wallet key. */
export async function probeKek(wrapper: KeyWrapper): Promise<'ok' | string> {
  const probe = randomBytes(32)
  try {
    const back = await wrapper.unwrap(await wrapper.wrap(probe, 'nearkit:health'), 'nearkit:health')
    return back.equals(probe) ? 'ok' : 'the KEK returned a different value'
  } catch (e) {
    return e instanceof Error ? e.message : 'unavailable'
  } finally {
    probe.fill(0)
  }
}
