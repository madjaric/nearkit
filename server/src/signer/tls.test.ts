import { createPrivateKey, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSelfSignedCertificate, ensureSignerTls, parseTlsPin, pinnedFetch, SIGNER_TLS_CERT_FILE, SIGNER_TLS_KEY_FILE } from './tls'

let dirs: string[] = []
let servers: Server[] = []

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  servers = []
  dirs = []
})

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'nearkit-signer-tls-'))
  dirs.push(d)
  return d
}

async function serve(cert: { certPem: string; keyPem: string }): Promise<string> {
  const server = createServer({ cert: cert.certPem, key: cert.keyPem, minVersion: 'TLSv1.2' }, (req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-answer': 'signed' })
      res.end(JSON.stringify({ method: req.method, got: body }))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('the signer’s own TLS certificate', () => {
  it('is a self-signed P-256 certificate that parses, verifies itself, matches its key and names the signer', () => {
    const c = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer', 'localhost'], now: new Date('2026-09-30T00:00:00Z') })
    const x = new X509Certificate(c.certPem)
    expect(x.subject).toBe('CN=nearkit-signer')
    expect(x.issuer).toBe('CN=nearkit-signer')
    expect(x.verify(x.publicKey)).toBe(true)
    expect(x.checkPrivateKey(createPrivateKey(c.keyPem))).toBe(true)
    expect(x.subjectAltName).toBe('DNS:nearkit-signer, DNS:localhost')
    expect(x.ca).toBe(true)
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(new Date(x.validFrom).getTime()).toBeLessThan(Date.parse('2026-09-30T00:00:00Z'))
    expect(new Date(x.validTo).getTime()).toBeGreaterThan(Date.parse('2036-01-01T00:00:00Z'))
    expect(x.fingerprint256).toBe(c.fingerprint256)
    // Every certificate is new: its own key and serial.
    const d = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    expect(new X509Certificate(d.certPem).serialNumber).not.toBe(x.serialNumber)
    expect(d.fingerprint256).not.toBe(c.fingerprint256)
  })

  it('is made once on the signer’s disk and reused: the pin stays the same across restarts', () => {
    const dir = join(tempDir(), 'tls')
    const first = ensureSignerTls(dir)
    expect(first.created).toBe(true)
    expect(existsSync(join(dir, SIGNER_TLS_KEY_FILE))).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(dir, SIGNER_TLS_KEY_FILE)).mode & 0o077).toBe(0)
    const again = ensureSignerTls(dir)
    expect(again.created).toBe(false)
    expect(again.pin).toBe(first.pin)
    expect(again.fingerprint256).toBe(first.fingerprint256)
    expect(parseTlsPin(first.pin)?.fingerprint256).toBe(first.fingerprint256)
  })

  it('never silently replaces a key: half a pair, or a certificate of another key, stops the signer', () => {
    const dir = tempDir()
    ensureSignerTls(dir)
    unlinkSync(join(dir, SIGNER_TLS_CERT_FILE))
    expect(() => ensureSignerTls(dir)).toThrow(/signer-tls\.crt/)
    const other = tempDir()
    const a = ensureSignerTls(other)
    const b = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    writeFileSync(join(other, SIGNER_TLS_CERT_FILE), b.certPem)
    expect(() => ensureSignerTls(other)).toThrow(/does not match/)
    expect(a.created).toBe(true)
  })

  it('a pin is a certificate; anything else is refused', () => {
    const c = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    const pin = parseTlsPin(Buffer.from(new X509Certificate(c.certPem).raw).toString('base64'))
    expect(pin?.fingerprint256).toBe(c.fingerprint256)
    expect(pin?.pem).toContain('BEGIN CERTIFICATE')
    expect(parseTlsPin('')).toBeNull()
    expect(parseTlsPin('not base64 at all!')).toBeNull()
    expect(parseTlsPin(Buffer.from('hello, not a certificate').toString('base64'))).toBeNull()
  })
})

describe('a client pinned to the signer’s certificate', () => {
  it('reaches the signer, with the status, headers and body intact', async () => {
    const c = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    const url = await serve(c)
    const f = pinnedFetch(parseTlsPin(Buffer.from(new X509Certificate(c.certPem).raw).toString('base64'))!)
    const res = await f(`${url}/v1/health`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nearkit-time': '1' }, body: '{"a":1}' })
    expect(res.status).toBe(200)
    expect(res.ok).toBe(true)
    expect(res.headers.get('x-answer')).toBe('signed')
    expect(JSON.parse(await res.text())).toEqual({ method: 'POST', got: '{"a":1}' })
  })

  it('refuses any other certificate, and nothing else trusts the signer’s own', async () => {
    const c = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    const impostor = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    const url = await serve(impostor)
    const pinned = pinnedFetch(parseTlsPin(Buffer.from(new X509Certificate(c.certPem).raw).toString('base64'))!)
    await expect(pinned(`${url}/v1/health`, { method: 'POST', body: '{}' })).rejects.toThrow()
    await expect(globalThis.fetch(`${url}/v1/health`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('speaks https only, and an aborted request fails', async () => {
    const c = createSelfSignedCertificate({ commonName: 'nearkit-signer', dnsNames: ['nearkit-signer'] })
    const url = await serve(c)
    const pin = parseTlsPin(Buffer.from(new X509Certificate(c.certPem).raw).toString('base64'))!
    await expect(pinnedFetch(pin)('http://127.0.0.1:1/v1/health', { method: 'POST', body: '{}' })).rejects.toThrow(/https/)
    const controller = new AbortController()
    controller.abort()
    await expect(pinnedFetch(pin)(`${url}/v1/health`, { method: 'POST', body: '{}', signal: controller.signal })).rejects.toThrow()
  })
})
