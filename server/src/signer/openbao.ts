import type { KmsApi } from './kms'
import { pinnedFetch, type TlsPin } from './tls'

/**
 * The key-encryption key held in OpenBao (the open-source fork of HashiCorp Vault), through
 * its transit engine: encryption as a service. The KEK never leaves OpenBao; the signer
 * asks it to wrap each wallet's own data key and to unwrap it for one signature, exactly as
 * with a cloud KMS (kms.ts).
 *
 * - The transit key is created derived (`derived=true`): every call names a context, and
 *   OpenBao derives the key for that context. The context is the wallet's additional data
 *   (network, account, owner), so a wrapped data key opens only for the wallet it was made
 *   for, like a KMS encryption context. Not exportable, and never deletable.
 * - The signer's token carries a policy that allows encrypt and decrypt on this one key,
 *   and renewing itself. Nothing else: no reading, exporting, rotating or configuring keys.
 * - OpenBao stores its keys encrypted under its master key, which only the owner's unseal
 *   key opens. A copy of its storage, or of this server's disk, opens nothing.
 * - Rotation is OpenBao's own (key versions): older ciphertexts keep opening.
 *
 * The cryptography is OpenBao's; this file only speaks its HTTP API.
 */

export interface OpenBaoSettings {
  /** e.g. https://openbao:8200 */
  addr: string
  /** The transit mount, e.g. "transit". */
  mount: string
  /** The transit key's name, e.g. "nearkit-wallets". */
  key: string
  /** SECRET: the signer's token. Never logged, never in an error. */
  token: string
  /** OpenBao's own certificate on a private network: the only one trusted. */
  tlsPin: TlsPin | null
}

/** OpenBao's answer, named so kms.ts can tell a refusal ("never opens here") from an outage. */
class OpenBaoError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

function classify(status: number, errors: string[]): OpenBaoError {
  const text = errors.join('; ').slice(0, 200)
  if (status === 503) return new OpenBaoError('KmsUnavailable', `OpenBao is sealed or unavailable (${text || status})`)
  if (status === 403) return new OpenBaoError('AccessDeniedException', 'OpenBao refused the signer’s token for this key')
  if (status === 404) return new OpenBaoError('NotFoundException', 'OpenBao has no such transit key')
  if (status === 400 && /message authentication failed|invalid ciphertext|unable to decrypt/i.test(text))
    return new OpenBaoError('InvalidCiphertextException', 'OpenBao could not open this ciphertext with this context')
  return new OpenBaoError('OpenBaoError', `OpenBao answered ${status}${text ? ` (${text})` : ''}`)
}

/** The derivation context: the KMS-style context, serialized canonically (sorted keys). */
function context(ctx: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.keys(ctx)
      .sort()
      .map((k) => [k, ctx[k]]),
  )
  return Buffer.from(JSON.stringify(sorted), 'utf8').toString('base64')
}

const CIPHERTEXT = /^vault:v\d+:[A-Za-z0-9+/=]+$/

export function openBaoTransitApi(s: OpenBaoSettings, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): KmsApi & { renewToken(): Promise<number> } {
  const f = s.tlsPin ? pinnedFetch(s.tlsPin) : (o.fetch ?? globalThis.fetch.bind(globalThis))
  const base = s.addr.replace(/\/$/, '')
  const timeoutMs = o.timeoutMs ?? 10_000

  async function call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    let text: string
    try {
      res = await f(`${base}/v1/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vault-token': s.token },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
      text = await res.text()
    } catch (e) {
      // Network, TLS or timeout: nothing is known about the key. The token is never in the message.
      throw new OpenBaoError('KmsUnavailable', `OpenBao could not be reached (${e instanceof Error ? e.name : 'error'})`)
    } finally {
      clearTimeout(timer)
    }
    let json: { data?: unknown; auth?: unknown; errors?: string[] } = {}
    try {
      json = text ? (JSON.parse(text) as typeof json) : {}
    } catch {
      throw new OpenBaoError('OpenBaoError', `OpenBao answered ${res.status} with something that is not JSON`)
    }
    if (!res.ok) throw classify(res.status, Array.isArray(json.errors) ? json.errors.map(String) : [])
    return json as T
  }

  return {
    keyId: `openbao:${s.mount}/${s.key}`,
    async encrypt(plaintext, ctx) {
      const r = await call<{ data?: { ciphertext?: unknown } }>(`${s.mount}/encrypt/${s.key}`, {
        plaintext: Buffer.from(plaintext).toString('base64'),
        context: context(ctx),
      })
      const ciphertext = r.data?.ciphertext
      if (typeof ciphertext !== 'string' || !CIPHERTEXT.test(ciphertext)) throw new OpenBaoError('OpenBaoError', 'OpenBao returned no ciphertext')
      return Buffer.from(ciphertext, 'utf8')
    },
    async decrypt(ciphertext, ctx) {
      const text = Buffer.from(ciphertext).toString('utf8')
      if (!CIPHERTEXT.test(text)) throw new OpenBaoError('InvalidCiphertextException', 'Not an OpenBao transit ciphertext')
      const r = await call<{ data?: { plaintext?: unknown } }>(`${s.mount}/decrypt/${s.key}`, { ciphertext: text, context: context(ctx) })
      const plain = r.data?.plaintext
      if (typeof plain !== 'string') throw new OpenBaoError('OpenBaoError', 'OpenBao returned no plaintext')
      return Buffer.from(plain, 'base64')
    },
    /** Keeps the signer's periodic token alive; returns its new lifetime in seconds. */
    async renewToken() {
      const r = await call<{ auth?: { lease_duration?: unknown } }>('auth/token/renew-self', {})
      return typeof r.auth?.lease_duration === 'number' ? r.auth.lease_duration : 0
    },
  }
}
