import { generateKeyPairSync, randomBytes, sign, X509Certificate, createPrivateKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Agent, request } from 'node:https'
import { join } from 'node:path'

/**
 * TLS between the app and the signer on a private network where no certificate can be
 * mounted (e.g. FadeHost's WireGuard network, where the signer is reached by an internal
 * name no public CA would sign).
 *
 * - The signer makes its own key and a self-signed certificate on its persistent disk the
 *   first time it starts (`NEARKIT_SIGNER_TLS_DIR`), and reuses them after. The key never
 *   leaves that disk: no secret has to be carried anywhere.
 * - It logs the certificate (public) as a pin: base64 of its DER encoding.
 * - The app is given that pin (`NEARKIT_SIGNER_TLS_PIN`) and trusts that one certificate
 *   and nothing else: only the holder of the signer's key can answer it. The system's
 *   certificate authorities play no part.
 *
 * Every request and answer is HMAC-signed on top of this (auth.ts); TLS adds
 * confidentiality and a second, independent check that the far end is the signer.
 */

export const SIGNER_TLS_KEY_FILE = 'signer-tls.key'
export const SIGNER_TLS_CERT_FILE = 'signer-tls.crt'

// ─── a minimal DER writer: just what one self-signed certificate needs ─────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const content = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), length(content.length), content])
}
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts)
const set = (...parts: Buffer[]) => tlv(0x31, ...parts)
const explicit = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts)
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const octets = (b: Buffer) => tlv(0x04, b)
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b)
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const out = [40 * first + second]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** A non-negative INTEGER from big-endian bytes (minimal, with a 0 byte if the top bit is set). */
function integer(b: Buffer): Buffer {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  const v = b.subarray(i)
  return tlv(0x02, (v[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v)
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). */
function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0')
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  const y = d.getUTCFullYear()
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`))
}

const extension = (id: string, critical: boolean, value: Buffer) => sequence(oid(id), ...(critical ? [bool(true)] : []), octets(value))
const ECDSA_WITH_SHA256 = () => sequence(oid('1.2.840.10045.4.3.2'))
const name = (cn: string) => sequence(set(sequence(oid('2.5.4.3'), utf8(cn))))

function pem(label: string, der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`
}

/**
 * A new P-256 key and a self-signed certificate for it: CA (its own trust anchor), server
 * authentication, the given DNS names, valid from a day ago for `validDays`.
 */
export function createSelfSignedCertificate(o: { commonName: string; dnsNames: string[]; now?: Date; validDays?: number }): {
  certPem: string
  keyPem: string
  fingerprint256: string
} {
  const now = o.now ?? new Date()
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = randomBytes(16)
  // Positive and never zero.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01
  const notBefore = new Date(now.getTime() - 86_400_000)
  const notAfter = new Date(now.getTime() + (o.validDays ?? 3650) * 86_400_000)
  const extensions = sequence(
    extension('2.5.29.17', false, sequence(...o.dnsNames.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))))),
    extension('2.5.29.19', true, sequence(bool(true))),
    // digitalSignature and keyCertSign.
    extension('2.5.29.15', true, bits(Buffer.from([0x84]), 2)),
    extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
  )
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_WITH_SHA256(),
    name(o.commonName),
    sequence(time(notBefore), time(notAfter)),
    name(o.commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, extensions),
  )
  const der = sequence(tbs, ECDSA_WITH_SHA256(), bits(sign('sha256', tbs, privateKey)))
  const certPem = pem('CERTIFICATE', der)
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, fingerprint256: new X509Certificate(certPem).fingerprint256 }
}

export interface SignerTls {
  certPath: string
  keyPath: string
  certPem: string
  keyPem: string
  /** True when this start made them. */
  created: boolean
  /** What the app pins (NEARKIT_SIGNER_TLS_PIN): base64 of the certificate's DER. Public. */
  pin: string
  fingerprint256: string
}

/**
 * The signer's key and certificate in `dir`: made the first time, reused after. Half a
 * pair, a certificate of another key, or an expired one stops the signer rather than being
 * replaced quietly (a new certificate means re-pinning the app).
 */
export function ensureSignerTls(dir: string, o: { now?: Date } = {}): SignerTls {
  const keyPath = join(dir, SIGNER_TLS_KEY_FILE)
  const certPath = join(dir, SIGNER_TLS_CERT_FILE)
  const hasKey = existsSync(keyPath)
  const hasCert = existsSync(certPath)
  let created = false
  if (!hasKey && !hasCert) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const made = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer', 'localhost'], now: o.now })
    writeFileSync(keyPath, made.keyPem, { mode: 0o600, flag: 'wx' })
    writeFileSync(certPath, made.certPem, { mode: 0o644, flag: 'wx' })
    created = true
  } else if (!hasKey || !hasCert) {
    const [have, missing] = hasKey ? [SIGNER_TLS_KEY_FILE, SIGNER_TLS_CERT_FILE] : [SIGNER_TLS_CERT_FILE, SIGNER_TLS_KEY_FILE]
    throw new Error(`The signer's TLS folder ${dir} has ${have} but not ${missing}. Restore it, or remove both to make a new certificate (the app must then pin the new one).`)
  }
  const keyPem = readFileSync(keyPath, 'utf8')
  const certPem = readFileSync(certPath, 'utf8')
  const cert = new X509Certificate(certPem)
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error(`The certificate in ${certPath} does not match the key beside it.`)
  if (Date.parse(cert.validTo) <= (o.now ?? new Date()).getTime())
    throw new Error(`The signer's TLS certificate in ${certPath} has expired. Remove both files to make a new one, then pin it on the app.`)
  return { certPath, keyPath, certPem, keyPem, created, pin: Buffer.from(cert.raw).toString('base64'), fingerprint256: cert.fingerprint256 }
}

export interface TlsPin {
  pem: string
  fingerprint256: string
}

/** The app's NEARKIT_SIGNER_TLS_PIN: base64 of the signer's certificate (DER). Null if it isn't one. */
export function parseTlsPin(value: string | undefined): TlsPin | null {
  const v = value?.trim() ?? ''
  if (!v || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null
  try {
    const cert = new X509Certificate(Buffer.from(v, 'base64'))
    return { pem: cert.toString(), fingerprint256: cert.fingerprint256 }
  } catch {
    return null
  }
}

/**
 * A `fetch` for the signer that trusts exactly the pinned certificate: it is the only
 * trust anchor, and the certificate presented must be that very one. The host name isn't
 * checked (a private network's internal names aren't in any certificate); the pin is.
 */
export function pinnedFetch(pin: TlsPin): typeof fetch {
  const agent = new Agent({
    ca: pin.pem,
    checkServerIdentity: (_host, cert) => (cert.fingerprint256 === pin.fingerprint256 ? undefined : new Error('The signer presented a certificate other than the pinned one')),
  })
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:') throw new Error('The pinned signer connection is https only')
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const body = init?.body === undefined || init.body === null ? null : String(init.body)
    const signal = init?.signal ?? null
    if (signal?.aborted) throw signal.reason ?? new Error('The request was aborted')
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: init?.method ?? 'GET', headers, agent }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, one)
          const status = res.statusCode ?? 502
          resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: h }))
        })
      })
      req.on('error', reject)
      signal?.addEventListener('abort', () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('The request was aborted')), { once: true })
      if (body !== null) req.write(body)
      req.end()
    })
  }) as typeof fetch
}
