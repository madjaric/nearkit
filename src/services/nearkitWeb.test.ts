import { describe, expect, it } from 'vitest'
import { createNearKitWeb, newCreateKey, readLoginCode, type SessionStore } from './nearkitWeb'

/**
 * NearKit web's session with the NearKit server: signed in from the bot's one-time link,
 * kept per network, dropped the moment the server says it ended. Nothing here signs or
 * moves anything: the server prepares, the user confirms in Telegram.
 */

const API = 'https://api.nearkit.test'
const TOKEN = 'T'.repeat(43)
const CODE = 'c'.repeat(43)

function memoryStorage(): SessionStore {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) }
}

type Handler = (body: Record<string, unknown>) => { status: number; json: unknown }

function server(routes: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(API.length)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ path, body })
    const handler = routes[path]
    const r = handler ? handler(body) : { status: 404, json: { error: { code: 'not-found', message: 'Not found' } } }
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const wallet = { id: 'w1', accountId: 'a'.repeat(64), name: 'Main', slot: 1, owner: null, frozen: false, createdAt: 1 }

describe('the sign-in link', () => {
  it('reads only a well-formed #login= code', () => {
    expect(readLoginCode(`#login=${CODE}`)).toBe(CODE)
    expect(readLoginCode('#login=short')).toBeNull()
    expect(readLoginCode(`#link=${CODE}`)).toBeNull()
    expect(readLoginCode(`#login=${CODE}&x=1`)).toBeNull()
  })
})

describe('NEARKITS web session', () => {
  it('signs in once with the code, keeps the session per network, and sends it with every call', async () => {
    const storage = memoryStorage()
    const { calls, fetchImpl } = server({
      '/api/web/login': () => ({ status: 200, json: { token: TOKEN, expiresAt: Date.now() + 60_000, user: { name: 'Alice' } } }),
      '/api/web/wallets': () => ({ status: 200, json: { wallets: [wallet], limit: 10, canCreate: true } }),
    })
    const web = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl, store: storage })
    expect(web.session()).toBeNull()
    await web.login(CODE)
    expect(web.session()).toMatchObject({ userName: 'Alice' })
    // One object while nothing changes (React reads it as a store snapshot).
    expect(web.session()).toBe(web.session())
    // Another network's page doesn't see it.
    expect(createNearKitWeb({ apiUrl: API, network: 'mainnet', fetchImpl, store: storage }).session()).toBeNull()
    expect(createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl, store: storage }).session()).toMatchObject({ userName: 'Alice' })
    const list = await web.wallets()
    expect(list?.wallets).toEqual([wallet])
    expect(calls.at(-1)).toEqual({ path: '/api/web/wallets', body: { session: TOKEN } })
  })

  it('a session the server ended is dropped at once, and listeners hear about it', async () => {
    const storage = memoryStorage()
    const { fetchImpl } = server({
      '/api/web/login': () => ({ status: 200, json: { token: TOKEN, expiresAt: Date.now() + 60_000, user: { name: 'Alice' } } }),
      '/api/web/wallets': () => ({ status: 401, json: { error: { code: 'session', message: 'Your NEARKITS web session has ended.' } } }),
    })
    const web = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl, store: storage })
    await web.login(CODE)
    let heard = 0
    web.subscribe(() => heard++)
    await expect(web.wallets()).rejects.toMatchObject({ status: 401 })
    expect(web.session()).toBeNull()
    expect(heard).toBe(1)
    // Signed out, nothing is asked of the server.
    expect(await web.wallets()).toBeNull()
  })

  it('an expired session is not used', async () => {
    const storage = memoryStorage()
    storage.set('nearkit:web-session:testnet', JSON.stringify({ token: TOKEN, expiresAt: Date.now() - 1, userName: 'Alice' }))
    const web = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl: server({}).fetchImpl, store: storage })
    expect(web.session()).toBeNull()
  })

  it('without a NEARKITS server there is no session and no wallet', async () => {
    const web = createNearKitWeb({ apiUrl: null, network: 'testnet', fetchImpl: server({}).fetchImpl, store: memoryStorage() })
    expect(web.available).toBe(false)
    expect(await web.wallets()).toBeNull()
    await expect(web.login(CODE)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('creating a wallet sends its name and the one key of this Create press, and refreshes the list', async () => {
    const storage = memoryStorage()
    let listed = 0
    const { calls, fetchImpl } = server({
      '/api/web/login': () => ({ status: 200, json: { token: TOKEN, expiresAt: Date.now() + 60_000, user: { name: 'Alice' } } }),
      '/api/web/wallets': () => (listed++, { status: 200, json: { wallets: [wallet], limit: 10, canCreate: true } }),
      '/api/web/wallets/create': () => ({ status: 200, json: { wallet: { ...wallet, id: 'w2', name: 'Degen 1', slot: 2 } } }),
    })
    const web = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl, store: storage })
    await web.login(CODE)
    await web.wallets()
    await web.wallets()
    // Reads within a moment of each other share one answer.
    expect(listed).toBe(1)
    const key = newCreateKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const created = await web.createWallet('Degen 1', key)
    expect(created).toMatchObject({ name: 'Degen 1' })
    expect(calls.at(-1)).toEqual({ path: '/api/web/wallets/create', body: { session: TOKEN, name: 'Degen 1', createKey: key } })
    await web.wallets()
    expect(listed).toBe(2)
  })

  it('signing out forgets the session here even when the server can’t be reached', async () => {
    const storage = memoryStorage()
    const ok = server({ '/api/web/login': () => ({ status: 200, json: { token: TOKEN, expiresAt: Date.now() + 60_000, user: { name: 'Alice' } } }) })
    const web = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl: ok.fetchImpl, store: storage })
    await web.login(CODE)
    const offline = createNearKitWeb({ apiUrl: API, network: 'testnet', fetchImpl: (async () => Promise.reject(new Error('offline'))) as typeof fetch, store: storage })
    await offline.logout()
    expect(offline.session()).toBeNull()
    expect(storage.get('nearkit:web-session:testnet')).toBeNull()
  })
})
