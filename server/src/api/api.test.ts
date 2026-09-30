import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { base58Encode, base64Decode, base64Encode } from '@/lib/encoding'
import { nep413Digest } from '@/services/near/nep413'
import { createFakeChain } from '@/services/real/testing/fakeChain'
import { loadConfig } from '../config'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { createLinkService } from '../link/service'
import { silentLogger } from '../log'
import { createServerNear } from '../near'
import { createApiServer, listen } from './http'
import { linkRoutes } from './linkRoutes'

const ORIGIN = 'https://nearkit.vercel.app'
let server: Server
let base: string
let store: Store
let linked: { accountId: string; userId: number }[]
let key: CryptoKeyPair
let publicKey: string
let link: ReturnType<typeof createLinkService>

beforeEach(async () => {
  key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  publicKey = `ed25519:${base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)))}`
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  store = new Store(db)
  await store.upsertUser({ userId: 7, username: 'alice', firstName: 'Alice', languageCode: null })
  const { config } = loadConfig({ NEAR_NETWORK: 'testnet' })
  const chain = createFakeChain({ accounts: { 'alice.testnet': { amount: 1n, keys: { [publicKey]: 'full' } } } })
  link = createLinkService({ store, config, rpc: createServerNear(config, chain.fetch).ctx.rpc })
  linked = []
  server = createApiServer({
    config,
    log: silentLogger,
    routes: linkRoutes({ link, onLinked: async (r) => void linked.push(r) }),
    limits: { '/api/link/confirm': 20 },
    health: () => ({ bot: 'NearKitBot' }),
  })
  base = `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`
})

afterEach(async () => new Promise<void>((resolve) => server.close(() => resolve())))

const post = (path: string, body: unknown, origin = ORIGIN) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('API', () => {
  it('links end to end: describe, sign as a wallet would, confirm, and tell the bot', async () => {
    const { code } = await link.createRequest(7)
    const described = (await (await post('/api/link/describe', { code })).json()) as { message: string; nonce: string; recipient: string }
    const digest = await nep413Digest({ message: described.message, nonce: base64Decode(described.nonce) as Uint8Array, recipient: described.recipient })
    const signature = base64Encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, digest)))
    const res = await post('/api/link/confirm', { code, accountId: 'alice.testnet', publicKey, signature })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ accountId: 'alice.testnet', telegram: { name: 'Alice', username: 'alice' }, network: 'testnet' })
    expect(linked).toEqual([{ accountId: 'alice.testnet', userId: 7, previousUserId: null }])
  })

  it('answers errors as JSON with the right status', async () => {
    const unknown = await post('/api/link/describe', { code: 'A'.repeat(22) })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('unknown')
    expect((await post('/api/link/describe', {})).status).toBe(400)
    expect((await post('/api/link/describe', '{not json')).status).toBe(400)
    expect((await post('/api/nope', {})).status).toBe(404)
    expect((await post('/api/link/describe', { code: 'x'.repeat(20_000) })).status).toBe(413)
  })

  it('refuses browsers from other origins, and answers preflights from allowed ones', async () => {
    expect((await post('/api/link/describe', { code: 'x' }, 'https://evil.example')).status).toBe(403)
    const pre = await fetch(base + '/api/link/confirm', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('reports health without secrets', async () => {
    const res = await fetch(base + '/health')
    expect(await res.json()).toEqual({ ok: true, network: 'testnet', bot: 'NearKitBot' })
  })

  it('rate-limits confirmations per IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 25; i++) statuses.push((await post('/api/link/confirm', { code: 'B'.repeat(22), accountId: 'a.testnet', publicKey: 'k', signature: 's' })).status)
    expect(statuses).toContain(429)
  })

  it('ignores X-Forwarded-For unless told a proxy is in front: a spoofed header escapes no limit', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 25; i++)
      statuses.push(
        (
          await fetch(base + '/api/link/confirm', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': `198.51.100.${i}` },
            body: JSON.stringify({ code: 'B'.repeat(22), accountId: 'a.testnet', publicKey: 'k', signature: 's' }),
          })
        ).status,
      )
    expect(statuses).toContain(429)
  })

  it('behind its reverse proxy (NEARKIT_API_TRUST_PROXY), each client has its own limit, by the address the proxy saw', async () => {
    const { config: proxied } = loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_API_TRUST_PROXY: 'true' })
    const behind = createApiServer({ config: proxied, log: silentLogger, routes: linkRoutes({ link, onLinked: async () => {} }), limits: { '/api/link/confirm': 20 } })
    const url = `http://127.0.0.1:${await listen(behind, 0, '127.0.0.1')}`
    try {
      const confirm = (client: string) =>
        fetch(url + '/api/link/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': client },
          body: JSON.stringify({ code: 'B'.repeat(22), accountId: 'a.testnet', publicKey: 'k', signature: 's' }),
        })
      const noisy: number[] = []
      for (let i = 0; i < 25; i++) noisy.push((await confirm('203.0.113.7')).status)
      expect(noisy).toContain(429)
      // Another client is unaffected by the first one's limit.
      expect((await confirm('203.0.113.8')).status).not.toBe(429)
      // The proxy's own address is the last entry: what a client wrote before it counts for nothing.
      expect((await confirm('203.0.113.8, 203.0.113.7')).status).toBe(429)
    } finally {
      await new Promise<void>((resolve) => behind.close(() => resolve()))
    }
  })

  it('the proxy setting is true or false, nothing else', () => {
    expect(loadConfig({ NEAR_NETWORK: 'testnet' }).config.api.trustProxy).toBe(false)
    expect(loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_API_TRUST_PROXY: 'true' }).config.api.trustProxy).toBe(true)
    expect(loadConfig({ NEAR_NETWORK: 'testnet', NEARKIT_API_TRUST_PROXY: 'yes' }).issues.map((i) => i.key)).toEqual(['NEARKIT_API_TRUST_PROXY'])
  })
})
