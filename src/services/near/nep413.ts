import { base58Decode, base64Decode } from '@/lib/encoding'
import { RpcError, type RpcClient } from './rpc'

/**
 * NEP-413 signed messages: how a wallet proves "this account agreed to this text"
 * without a transaction. The wallet signs SHA-256 of the borsh encoding of
 * { tag: u32 = 2^31 + 413, message, nonce: [u8; 32], recipient, callbackUrl: Option<string> }.
 * A signature only proves ownership when its key is a FULL-ACCESS key of the
 * account (function-call keys can be handed to any app), so callers must check
 * that on chain too; see `accessKeyPermission`.
 */

export const NEP413_TAG = 2 ** 31 + 413

export interface Nep413Payload {
  message: string
  /** 32 random bytes chosen by the verifier; single use. */
  nonce: Uint8Array
  /** Who the message is for, e.g. the app's host name. */
  recipient: string
  callbackUrl?: string | null
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function borshString(text: string): number[] {
  const bytes = new TextEncoder().encode(text)
  return [...u32(bytes.length), ...bytes]
}

export function serializeNep413(payload: Nep413Payload): Uint8Array<ArrayBuffer> {
  if (payload.nonce.length !== 32) throw new Error('The NEP-413 nonce must be 32 bytes')
  const callback = payload.callbackUrl == null ? [0] : [1, ...borshString(payload.callbackUrl)]
  return Uint8Array.from([...u32(NEP413_TAG), ...borshString(payload.message), ...payload.nonce, ...borshString(payload.recipient), ...callback])
}

/** The 32 bytes the wallet signs. */
export async function nep413Digest(payload: Nep413Payload): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', serializeNep413(payload)))
}

/** `ed25519:<base58>` → 32 raw bytes; null for any other key type or length. */
export function parseEd25519PublicKey(key: string): Uint8Array<ArrayBuffer> | null {
  if (!key.startsWith('ed25519:')) return null
  const raw = base58Decode(key.slice('ed25519:'.length))
  return raw && raw.length === 32 ? raw : null
}

/** Wallets return base64 (per NEP-413); a few return base58. Either must decode to 64 bytes. */
export function decodeEd25519Signature(signature: string): Uint8Array<ArrayBuffer> | null {
  const text = signature.trim().replace(/^ed25519:/, '')
  const b64 = base64Decode(text)
  if (b64 && b64.length === 64) return b64
  const b58 = base58Decode(text)
  return b58 && b58.length === 64 ? b58 : null
}

/** True only when `signature` is `publicKey`'s ed25519 signature of this exact payload. */
export async function verifyNep413(payload: Nep413Payload, publicKey: string, signature: string): Promise<boolean> {
  const key = parseEd25519PublicKey(publicKey)
  const sig = decodeEd25519Signature(signature)
  if (!key || !sig || payload.nonce.length !== 32) return false
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sig, await nep413Digest(payload))
  } catch {
    return false
  }
}

export type AccessKeyPermission = 'full' | 'function-call' | 'missing'

/**
 * What `publicKey` may do on `accountId`, read at final. Transport failures
 * propagate: "the RPC didn't answer" is not "the key doesn't exist".
 */
export async function accessKeyPermission(rpc: RpcClient, accountId: string, publicKey: string): Promise<AccessKeyPermission> {
  let result: { permission?: unknown; error?: unknown } | null
  try {
    result = await rpc.call<{ permission?: unknown; error?: unknown } | null>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    })
  } catch (e) {
    if (e instanceof RpcError && e.kind !== 'transport' && (e.causeName === 'UNKNOWN_ACCESS_KEY' || e.causeName === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(e.message)))
      return 'missing'
    throw e
  }
  if (!result || typeof result.error === 'string') return 'missing'
  if (result.permission === 'FullAccess') return 'full'
  return typeof result.permission === 'object' && result.permission !== null ? 'function-call' : 'missing'
}
