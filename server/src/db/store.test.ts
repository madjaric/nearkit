import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { SqliteDatabase } from './sqlite'
import { Store } from './store'

let now = 1_000_000
let store: Store

beforeEach(async () => {
  now = 1_000_000
  const db = await SqliteDatabase.open(null)
  await migrate(db)
  store = new Store(db, () => now)
})

const alice = { userId: 101, username: 'alice', firstName: 'Alice', languageCode: 'en' }
const bob = { userId: 202, username: null, firstName: 'Bob', languageCode: null }

describe('users and settings', () => {
  it('upserts users and keeps their settings with defaults', async () => {
    await store.upsertUser(alice)
    await store.upsertUser({ ...alice, username: 'alice2' })
    expect((await store.getUser(101))?.username).toBe('alice2')
    expect(await store.getSettings(101)).toEqual({ slippagePct: 1, buyPresets: ['0.1', '0.5', '1', '5'], sellPresets: [25, 50, 75, 100], defaultAccount: null, notifyTrades: true })
    expect(await store.updateSettings(101, { slippagePct: 3, notifyTrades: false })).toMatchObject({ slippagePct: 3, notifyTrades: false })
    expect((await store.getSettings(101)).slippagePct).toBe(3)
  })
})

describe('link requests and account links', () => {
  beforeEach(async () => {
    await store.upsertUser(alice)
    await store.upsertUser(bob)
  })

  const request = (userId: number, codeHash: string) => store.createLinkRequest({ codeHash, userId, network: 'testnet', nonce: 'bm9uY2U=', message: 'm', ttlMs: 600_000 })

  it('finds a live request, counts attempts and forgets nothing it shouldn’t', async () => {
    await request(101, 'h1')
    expect(await store.getLinkRequest('h1')).toMatchObject({ userId: 101, network: 'testnet', attempts: 0, usedAt: null, expiresAt: 1_600_000 })
    expect(await store.bumpLinkAttempt('h1')).toBe(1)
    expect(await store.countLinkRequestsSince(101, 0)).toBe(1)
  })

  it('links once: the request is used up and a second completion fails', async () => {
    await request(101, 'h1')
    expect(await store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).toEqual({ previousUserId: null })
    expect((await store.linksOf(101, 'testnet')).map((l) => l.accountId)).toEqual(['alice.testnet'])
    await expect(store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).rejects.toThrow(/already used/)
  })

  it('refuses an expired request', async () => {
    await request(101, 'h1')
    now += 600_001
    await expect(store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).rejects.toThrow(/expired/)
  })

  it('moves an account to a new Telegram user only through a completed request, and reports who lost it', async () => {
    await request(101, 'h1')
    await store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'shared.testnet', userId: 101, publicKey: 'ed25519:K' })
    await request(202, 'h2')
    expect(await store.completeLink({ codeHash: 'h2', network: 'testnet', accountId: 'shared.testnet', userId: 202, publicKey: 'ed25519:K2' })).toEqual({ previousUserId: 101 })
    expect(await store.linksOf(101, 'testnet')).toEqual([])
    expect((await store.linkOf('testnet', 'shared.testnet'))?.userId).toBe(202)
    expect((await store.linkEvents('testnet', 'shared.testnet')).map((e) => e.kind)).toEqual(['linked', 'moved-away', 'linked'])
  })

  it('refuses a request owned by someone else', async () => {
    await request(101, 'h1')
    await expect(store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'x.testnet', userId: 202, publicKey: 'ed25519:K' })).rejects.toThrow(
      /another Telegram account/,
    )
  })

  it('keeps networks apart', async () => {
    await request(101, 'h1')
    await expect(store.completeLink({ codeHash: 'h1', network: 'mainnet', accountId: 'alice.near', userId: 101, publicKey: 'ed25519:K' })).rejects.toThrow(/network/)
  })

  it('unlinks only the owner’s link and clears it as the default account', async () => {
    await request(101, 'h1')
    await store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })
    await store.updateSettings(101, { defaultAccount: 'alice.testnet' })
    expect(await store.unlink('testnet', 'alice.testnet', 202)).toBe(false)
    expect(await store.unlink('testnet', 'alice.testnet', 101)).toBe(true)
    expect(await store.linksOf(101, 'testnet')).toEqual([])
    expect((await store.getSettings(101)).defaultAccount).toBeNull()
  })
})

describe('conversation state and callbacks', () => {
  beforeEach(async () => await store.upsertUser(alice))

  it('keeps a flow until it expires', async () => {
    await store.setSession(1, 101, 'buy', { step: 'amount' }, 60_000)
    expect(await store.getSession(1, 101)).toEqual({ flow: 'buy', data: { step: 'amount' }, expiresAt: 1_060_000 })
    now += 60_001
    expect(await store.getSession(1, 101)).toBeNull()
  })

  it('stores long button payloads behind a short id, per user', async () => {
    const id = await store.putCallback({ contract: 'a'.repeat(64) }, 101, 1, 60_000)
    expect(id.length).toBeLessThanOrEqual(22)
    expect(await store.getCallback(id, 101)).toEqual({ contract: 'a'.repeat(64) })
    expect(await store.getCallback(id, 999)).toBeNull()
    now += 60_001
    expect(await store.getCallback(id, 101)).toBeNull()
  })

  it('prunes expired rows', async () => {
    await store.setSession(1, 101, 'buy', {}, 1)
    await store.putCallback({}, 101, 1, 1)
    now += 10
    await store.prune()
    expect(await store.counts()).toMatchObject({ sessions: 0, callbacks: 0 })
  })
})

describe('meta', () => {
  it('stores small values by key', async () => {
    expect(await store.getMeta('telegram_offset')).toBeNull()
    await store.setMeta('telegram_offset', '42')
    expect(await store.getMeta('telegram_offset')).toBe('42')
  })
})

describe('boots', () => {
  it('counts every start in the database file, so a restart shows the data survived', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nearkit-boot-')), 'nearkit.sqlite')
    const start = async (at: number) => {
      const db = await SqliteDatabase.open(path)
      await migrate(db)
      const boot = new Store(db, () => at).recordBoot()
      await db.close()
      return boot
    }
    expect(await start(1000)).toEqual({ boot: 1, since: 1000 })
    expect(await start(2000)).toEqual({ boot: 2, since: 1000 })
    expect(await start(3000)).toEqual({ boot: 3, since: 1000 })
  })
})
