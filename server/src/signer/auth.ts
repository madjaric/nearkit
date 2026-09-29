import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * How the app and the signer service prove themselves to each other: HMAC-SHA-256 with
 * a shared 32-byte secret (NEARKIT_SIGNER_AUTH_KEY, on both hosts, never logged).
 *
 * - A request signs its method, path, time, a one-time nonce and a hash of its body. The
 *   signer accepts it within 30 seconds of its time, once (nonces are remembered in the
 *   signer's own database, so a replay is refused even on another signer instance).
 * - A response signs the request's nonce, its status and a hash of its body: the app
 *   accepts only answers to its own request, unaltered.
 *
 * This is on top of TLS (or a private network between the two), not instead of it.
 */

export const AUTH_WINDOW_MS = 30_000
const REQUEST_CONTEXT = 'nearkit-signer-request-v1'
const RESPONSE_CONTEXT = 'nearkit-signer-response-v1'

const b64u = (b: Buffer) => b.toString('base64url')
const sha256 = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex')

export function parseAuthKey(text: string | undefined): Buffer | null {
  const t = text?.trim() ?? ''
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null
  const b = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return b.length === 32 ? b : null
}

function mac(key: Buffer, parts: readonly string[]): string {
  return b64u(createHmac('sha256', key).update(parts.join('\n'), 'utf8').digest())
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface SignedHeaders {
  'x-nearkit-time': string
  'x-nearkit-nonce': string
  'x-nearkit-signature': string
}

export function signRequest(key: Buffer, path: string, body: string, now: number): SignedHeaders {
  const nonce = b64u(randomBytes(16))
  const time = String(now)
  return { 'x-nearkit-time': time, 'x-nearkit-nonce': nonce, 'x-nearkit-signature': mac(key, [REQUEST_CONTEXT, 'POST', path, time, nonce, sha256(body)]) }
}

export type RequestCheck = { ok: true; nonce: string; time: number } | { ok: false; reason: string }

/** Checks the signature and freshness; the caller then records the nonce once (replay protection). */
export function checkRequest(key: Buffer, path: string, body: string, headers: Record<string, string | string[] | undefined>, now: number): RequestCheck {
  const one = (name: string) => {
    const v = headers[name]
    return typeof v === 'string' ? v : null
  }
  const time = one('x-nearkit-time')
  const nonce = one('x-nearkit-nonce')
  const signature = one('x-nearkit-signature')
  if (!time || !nonce || !signature) return { ok: false, reason: 'unsigned request' }
  if (!/^\d{1,16}$/.test(time) || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return { ok: false, reason: 'malformed signature headers' }
  const t = Number(time)
  if (Math.abs(now - t) > AUTH_WINDOW_MS) return { ok: false, reason: 'request time outside the window' }
  if (!same(signature, mac(key, [REQUEST_CONTEXT, 'POST', path, time, nonce, sha256(body)]))) return { ok: false, reason: 'bad signature' }
  return { ok: true, nonce, time: t }
}

export function signResponse(key: Buffer, requestNonce: string, status: number, body: string): string {
  return mac(key, [RESPONSE_CONTEXT, requestNonce, String(status), sha256(body)])
}

export function checkResponse(key: Buffer, requestNonce: string, status: number, body: string, signature: string | null): boolean {
  return signature !== null && /^[A-Za-z0-9_-]{43}$/.test(signature) && same(signature, signResponse(key, requestNonce, status, body))
}
