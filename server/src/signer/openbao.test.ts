import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyUnavailableError } from '../custody/vault'
import { KmsUnavailableError, kmsKeyWrapper } from './kms'
import { createLogger } from '../log'
import { openBaoTransitApi } from './openbao'
import { startSignerService } from './service'
import { createSelfSignedCertificate, parseTlsPin } from './tls'

const TOKEN = 'test-openbao-token-for-a-fake-server'
let servers: Server[] = []

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  servers = []
})

/**
 * A stand-in for OpenBao's transit API that checks the contract only: paths, the token
 * header, JSON shapes, the derivation context and OpenBao's error answers. It does no
 * cryptography: a "ciphertext" is a reference to what it was given.
 */
function fakeTransit(state: { sealed?: boolean; requests: { path: string; token: string | undefined; body: Record<string, unknown> }[] }) {
  const stored = new Map<string, { plaintext: string; context: string }>()
  return (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>
      const token = req.headers['x-vault-token'] as string | undefined
      state.requests.push({ path: req.url ?? '', token, body })
      if (state.sealed) return answer(503, { errors: ['Vault is sealed'] })
      if (token !== TOKEN) return answer(403, { errors: ['permission denied'] })
      if (req.url === '/v1/auth/token/renew-self') return answer(200, { auth: { lease_duration: 2_764_800, renewable: true } })
      if (req.url === '/v1/transit/encrypt/nearkit-wallets') {
        if (typeof body.context !== 'string' || !body.context) return answer(400, { errors: ["missing 'context' for key derivation; the key was created using a derived key"] })
        const id = randomBytes(8).toString('hex')
        stored.set(id, { plaintext: String(body.plaintext), context: body.context })
        return answer(200, { data: { ciphertext: `vault:v1:${id}`, key_version: 1 } })
      }
      if (req.url === '/v1/transit/decrypt/nearkit-wallets') {
        const id = String(body.ciphertext ?? '').replace(/^vault:v1:/, '')
        const hit = stored.get(id)
        if (!hit) return answer(400, { errors: ['invalid ciphertext: unable to decrypt'] })
        if (hit.context !== body.context) return answer(400, { errors: ['cipher: message authentication failed'] })
        return answer(200, { data: { plaintext: hit.plaintext } })
      }
      return answer(404, { errors: [] })
    })
  }
}

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as AddressInfo).port
}

const settings = (addr: string, token = TOKEN) => ({ addr, mount: 'transit', key: 'nearkit-wallets', token, tlsPin: null })

describe('wallet keys sealed through OpenBao transit', () => {
  it('wraps and opens a data key, bound to its wallet by the derivation context, with the signer’s token', async () => {
    const state = { requests: [] as { path: string; token: string | undefined; body: Record<string, unknown> }[] }
    const port = await listen(createHttpServer(fakeTransit(state)))
    const api = openBaoTransitApi(settings(`http://127.0.0.1:${port}`))
    expect(api.keyId).toBe('openbao:transit/nearkit-wallets')
    const wrapper = kmsKeyWrapper(api)
    const dek = randomBytes(32)
    const wrapped = await wrapper.wrap(dek, 'nearkit:wallet:v2|mainnet|abc|owner:alice.near')
    expect((await wrapper.unwrap(wrapped, 'nearkit:wallet:v2|mainnet|abc|owner:alice.near')).equals(dek)).toBe(true)
    const enc = state.requests.find((r) => r.path.endsWith('/encrypt/nearkit-wallets'))
    expect(enc?.token).toBe(TOKEN)
    expect(Buffer.from(String(enc?.body.context), 'base64').toString()).toBe('{"purpose":"nearkit-wallet-dek","wallet":"nearkit:wallet:v2|mainnet|abc|owner:alice.near"}')
  })

  it('another wallet’s context never opens it: a refusal, not an outage', async () => {
    const port = await listen(createHttpServer(fakeTransit({ requests: [] })))
    const wrapper = kmsKeyWrapper(openBaoTransitApi(settings(`http://127.0.0.1:${port}`)))
    const wrapped = await wrapper.wrap(randomBytes(32), 'nearkit:wallet:v2|mainnet|abc|owner:alice.near')
    await expect(wrapper.unwrap(wrapped, 'nearkit:wallet:v2|mainnet|abc|owner:mallory.near')).rejects.toBeInstanceOf(KeyUnavailableError)
    // Something that isn't an OpenBao ciphertext never reaches it as one.
    await expect(wrapper.unwrap(Buffer.from('not a transit ciphertext').toString('base64'), 'x')).rejects.toBeInstanceOf(KeyUnavailableError)
  })

  it('a sealed or unreachable OpenBao fails closed as unavailable', async () => {
    const state = { sealed: false, requests: [] as { path: string; token: string | undefined; body: Record<string, unknown> }[] }
    const port = await listen(createHttpServer(fakeTransit(state)))
    const wrapper = kmsKeyWrapper(openBaoTransitApi(settings(`http://127.0.0.1:${port}`)))
    const wrapped = await wrapper.wrap(randomBytes(32), 'w')
    state.sealed = true
    await expect(wrapper.unwrap(wrapped, 'w')).rejects.toBeInstanceOf(KmsUnavailableError)
    await expect(wrapper.wrap(randomBytes(32), 'w')).rejects.toBeInstanceOf(KmsUnavailableError)
    const down = kmsKeyWrapper(openBaoTransitApi(settings('http://127.0.0.1:1'), { timeoutMs: 2_000 }))
    await expect(down.unwrap(wrapped, 'w')).rejects.toBeInstanceOf(KmsUnavailableError)
  })

  it('a token without permission opens nothing, and no error ever repeats the token', async () => {
    const port = await listen(createHttpServer(fakeTransit({ requests: [] })))
    const good = kmsKeyWrapper(openBaoTransitApi(settings(`http://127.0.0.1:${port}`)))
    const wrapped = await good.wrap(randomBytes(32), 'w')
    const wrong = openBaoTransitApi(settings(`http://127.0.0.1:${port}`, 'a-token-without-that-policy'))
    const e = await kmsKeyWrapper(wrong)
      .unwrap(wrapped, 'w')
      .catch((x: unknown) => x as Error)
    expect(e).toBeInstanceOf(KeyUnavailableError)
    expect(String((e as Error).message)).not.toContain('a-token-without-that-policy')
    const direct = await wrong.decrypt(Buffer.from('vault:v1:00'), { a: 'b' }).catch((x: unknown) => x as Error)
    expect(String((direct as Error).message)).not.toContain('a-token-without-that-policy')
  })

  it('renews its own token, and says for how long', async () => {
    const state = { requests: [] as { path: string; token: string | undefined; body: Record<string, unknown> }[] }
    const port = await listen(createHttpServer(fakeTransit(state)))
    expect(await openBaoTransitApi(settings(`http://127.0.0.1:${port}`)).renewToken()).toBe(2_764_800)
    expect(state.requests.at(-1)?.path).toBe('/v1/auth/token/renew-self')
  })

  it('reaches OpenBao over https pinned to its own certificate, and no other', async () => {
    const cert = createSelfSignedCertificate({ commonName: 'openbao', dnsNames: ['openbao'] })
    const other = createSelfSignedCertificate({ commonName: 'openbao', dnsNames: ['openbao'] })
    const pin = (c: { certPem: string }) => parseTlsPin(new X509Certificate(c.certPem).raw.toString('base64'))
    const port = await listen(createHttpsServer({ cert: cert.certPem, key: cert.keyPem }, fakeTransit({ requests: [] })))
    const pinned = kmsKeyWrapper(openBaoTransitApi({ ...settings(`https://127.0.0.1:${port}`), tlsPin: pin(cert) }))
    const dek = randomBytes(32)
    expect((await pinned.unwrap(await pinned.wrap(dek, 'w'), 'w')).equals(dek)).toBe(true)
    const impostor = kmsKeyWrapper(openBaoTransitApi({ ...settings(`https://127.0.0.1:${port}`), tlsPin: pin(other) }))
    await expect(impostor.wrap(dek, 'w')).rejects.toBeInstanceOf(KmsUnavailableError)
  })

  it('the signer service seals with OpenBao, renews its token at start, and never logs it', async () => {
    const state = { requests: [] as { path: string; token: string | undefined; body: Record<string, unknown> }[] }
    const port = await listen(createHttpServer(fakeTransit(state)))
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-bao-'))
    const lines: string[] = []
    const s = await startSignerService({
      env: {
        NEAR_NETWORK: 'testnet',
        NEARKIT_SIGNER_AUTH_KEY: randomBytes(32).toString('base64'),
        NEARKIT_OPENBAO_ADDR: `http://127.0.0.1:${port}`,
        NEARKIT_OPENBAO_TOKEN: TOKEN,
        NEARKIT_SIGNER_DB_PATH: join(dir, 'signer.sqlite'),
        NEARKIT_SIGNER_RECIPIENT: 'nearkit.vercel.app',
        NEARKIT_SIGNER_PORT: '0',
      },
      log: createLogger({ sink: (l) => lines.push(l), secrets: [TOKEN] }),
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
    })
    try {
      expect(await s.core.handle('health', {})).toMatchObject({ ok: true, kek: 'ok', keyRef: 'kms:openbao:transit/nearkit-wallets' })
      expect(state.requests.some((r) => r.path === '/v1/auth/token/renew-self')).toBe(true)
      expect(lines.join('\n')).toContain('OpenBao token renewed')
      expect(lines.join('\n')).not.toContain(TOKEN)
    } finally {
      await s.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
