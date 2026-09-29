import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { base58Decode, base64Decode } from '@/lib/encoding'
import { deserializeSignedTransaction, transactionDigest } from '@/services/near/transaction'
import { createSignerClient, type TradingSigner } from '../custody/signer'
import { createLogger, silentLogger } from '../log'
import { signRequest } from './auth'
import { httpSignerTransport } from './client'
import { DestinationNotApprovedError, SignerPausedError, SignerUnavailableError } from './errors'
import { startSignerService } from './service'
import { TEST_OWNER_KEY } from './testing'
import { ensureSignerTls, parseTlsPin, pinnedFetch } from './tls'

const AUTH = randomBytes(32)
const OWNER = 'alice.testnet'
const BLOCK = new Uint8Array(32).fill(4)
let stops: (() => Promise<void>)[] = []
let dirs: string[] = []

afterEach(async () => {
  for (const s of stops) await s()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  stops = []
  dirs = []
})

async function service(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-http-'))
  dirs.push(dir)
  const s = await startSignerService({
    env: {
      NEAR_NETWORK: 'testnet',
      NEARKIT_SIGNER_AUTH_KEY: AUTH.toString('base64'),
      NEARKIT_SIGNER_KEK: randomBytes(32).toString('base64'),
      NEARKIT_SIGNER_DB_PATH: join(dir, 'signer.sqlite'),
      NEARKIT_SIGNER_RECIPIENT: 'nearkit.vercel.app',
      NEARKIT_SIGNER_PORT: '0',
      ...extra,
    },
    log: silentLogger,
    // No chain or Rhea is needed for what these tests sign.
    fetch: (async () => {
      throw new Error('offline')
    }) as typeof fetch,
  })
  stops.push(s.stop)
  const url = `http://127.0.0.1:${s.port}`
  return { ...s, url, client: (key = AUTH, f: typeof fetch = globalThis.fetch) => createSignerClient(httpSignerTransport({ url, authKey: key, fetch: f, timeoutMs: 5_000 })) }
}

const withdrawToOwner = (signer: TradingSigner, accountId: string, intentId = 'i1', nonce = 7n) =>
  signer.sign({
    wallet: { accountId, network: 'testnet' },
    intentId,
    step: 0,
    op: { kind: 'withdraw-near', to: OWNER, amount: 5n },
    plan: [{ receiverId: OWNER, actions: [{ kind: 'transfer', deposit: '5' }], label: 'w' }],
    nonce,
    blockHash: BLOCK,
  })

describe('the signer service over HTTP', { timeout: 60_000 }, () => {
  it('serves TLS with a certificate it makes on its own disk; an app pinned to it talks to it, and the pin is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nearkit-signer-tlsdir-'))
    dirs.push(dir)
    const lines: string[] = []
    const s = await startSignerService({
      env: {
        NEAR_NETWORK: 'testnet',
        NEARKIT_SIGNER_AUTH_KEY: AUTH.toString('base64'),
        NEARKIT_SIGNER_KEK: randomBytes(32).toString('base64'),
        NEARKIT_SIGNER_DB_PATH: join(dir, 'signer.sqlite'),
        NEARKIT_SIGNER_RECIPIENT: 'nearkit.vercel.app',
        NEARKIT_SIGNER_PORT: '0',
        NEARKIT_SIGNER_TLS_DIR: join(dir, 'tls'),
      },
      log: createLogger({ sink: (line) => lines.push(line) }),
      fetch: (async () => {
        throw new Error('offline')
      }) as typeof fetch,
    })
    stops.push(s.stop)
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'signer TLS certificate')
    const pin = ensureSignerTls(join(dir, 'tls')).pin
    expect(logged).toMatchObject({ pin, created: true })
    // The key itself never reaches the log.
    expect(lines.join('\n')).not.toContain('PRIVATE KEY')
    const url = `https://127.0.0.1:${s.port}`
    const pinned = createSignerClient(httpSignerTransport({ url, authKey: AUTH, fetch: pinnedFetch(parseTlsPin(pin)!), timeoutMs: 5_000 }))
    expect(await pinned.health()).toMatchObject({ ok: true, network: 'testnet' })
    // Nothing that doesn't hold the pin gets an answer.
    const unpinned = createSignerClient(httpSignerTransport({ url, authKey: AUTH, timeoutMs: 5_000 }))
    await expect(unpinned.health()).rejects.toBeInstanceOf(SignerUnavailableError)
  })

  it('makes a key and signs for the app, answering only signed requests with signed answers', async () => {
    const s = await service()
    const signer = s.client()
    const k = await signer.createKey({ userId: 1, owner: { accountId: OWNER, publicKey: TEST_OWNER_KEY } })
    const signed = await withdrawToOwner(signer, k.accountId)
    const read = deserializeSignedTransaction(base64Decode(signed.base64) as Uint8Array)
    const key = await crypto.subtle.importKey('raw', base58Decode(k.publicKey.slice(8)) as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, read.signature, await transactionDigest(read.transactionBytes))).toBe(true)
    expect(await signer.health()).toMatchObject({ ok: true, paused: false, network: 'testnet', kek: 'ok' })
    // Liveness is open, and says nothing else.
    expect(await (await fetch(`${s.url}/livez`)).json()).toEqual({ ok: true })
  })

  it('refuses unsigned, wrongly signed, stale, replayed and altered requests', async () => {
    const s = await service()
    const body = JSON.stringify({})
    const post = (headers: Record<string, string>, text = body) =>
      fetch(`${s.url}/v1/health`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text })
    expect((await post({})).status).toBe(401)
    expect((await post({ ...signRequest(randomBytes(32), '/v1/health', body, Date.now()) })).status).toBe(401)
    expect((await post({ ...signRequest(AUTH, '/v1/health', body, Date.now() - 31_000) })).status).toBe(401)
    expect((await post({ ...signRequest(AUTH, '/v1/key-info', body, Date.now()) })).status).toBe(401)
    const once = { ...signRequest(AUTH, '/v1/health', body, Date.now()) }
    expect((await post(once)).status).toBe(200)
    expect((await post(once)).status).toBe(401)
    const fresh = { ...signRequest(AUTH, '/v1/health', body, Date.now()) }
    expect((await post(fresh, JSON.stringify({ tampered: true }))).status).toBe(401)
    // And the app's client with the wrong key gets nothing done.
    await expect(s.client(randomBytes(32)).health()).rejects.toThrow(SignerUnavailableError)
  })

  it('the app refuses an answer that isn’t the signer’s own (altered on the way)', async () => {
    const s = await service()
    const k = await s.client().createKey({ userId: 1, owner: { accountId: OWNER, publicKey: TEST_OWNER_KEY } })
    const tampering = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init)
      const text = (await res.text()).replace(/"hash":"[^"]+"/, '"hash":"forged"')
      return new Response(text, { status: res.status, headers: res.headers })
    }) as typeof fetch
    await expect(withdrawToOwner(s.client(AUTH, tampering), k.accountId)).rejects.toThrow(/not the signer’s own/)
  })

  it('refusals cross the wire as the same errors', async () => {
    const s = await service()
    const signer = s.client()
    const k = await signer.createKey({ userId: 1, owner: { accountId: OWNER, publicKey: TEST_OWNER_KEY } })
    await expect(
      signer.sign({
        wallet: { accountId: k.accountId, network: 'testnet' },
        intentId: 'x',
        step: 0,
        op: { kind: 'withdraw-near', to: 'evil.testnet', amount: 5n },
        plan: [{ receiverId: 'evil.testnet', actions: [{ kind: 'transfer', deposit: '5' }], label: 'w' }],
        nonce: 1n,
        blockHash: BLOCK,
      }),
    ).rejects.toThrow(DestinationNotApprovedError)
    await signer.pause('drill')
    await expect(withdrawToOwner(signer, k.accountId)).rejects.toThrow(SignerPausedError)
  })

  it('a signature whose answer was lost is asked again and comes back the same: never a second one', async () => {
    const s = await service()
    const k = await s.client().createKey({ userId: 1, owner: { accountId: OWNER, publicKey: TEST_OWNER_KEY } })
    let dropped = 0
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init)
      if (String(input).endsWith('/v1/sign') && dropped++ === 0) throw new Error('connection reset')
      return res
    }) as typeof fetch
    const first = await withdrawToOwner(s.client(AUTH, lossy), k.accountId)
    expect(dropped).toBe(2)
    expect(await withdrawToOwner(s.client(), k.accountId)).toEqual(first)
    expect(await s.store.db.all('SELECT * FROM signer_signatures')).toHaveLength(1)
  })

  it('refuses an oversized body', async () => {
    const s = await service()
    const body = JSON.stringify({ pad: 'x'.repeat(300 * 1024) })
    const res = await fetch(`${s.url}/v1/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest(AUTH, '/v1/health', body, Date.now()) },
      body,
    }).catch(() => null)
    expect(res === null || res.status === 413).toBe(true)
  })
})
