import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './schema'
import { Db } from './sqlite'
import { Store } from './store'

let now = 1_000_000
let store: Store

beforeEach(async () => {
  now = 1_000_000
  const db = await Db.open(null)
  migrate(db)
  store = new Store(db, () => now)
})

const alice = { userId: 101, username: 'alice', firstName: 'Alice', languageCode: 'en' }
const bob = { userId: 202, username: null, firstName: 'Bob', languageCode: null }

describe('users and settings', () => {
  it('upserts users and keeps their settings with defaults', () => {
    store.upsertUser(alice)
    store.upsertUser({ ...alice, username: 'alice2' })
    expect(store.getUser(101)?.username).toBe('alice2')
    expect(store.getSettings(101)).toEqual({ slippagePct: 1, buyPresets: ['0.1', '0.5', '1', '5'], sellPresets: [25, 50, 75, 100], defaultAccount: null, notifyTrades: true })
    expect(store.updateSettings(101, { slippagePct: 3, notifyTrades: false })).toMatchObject({ slippagePct: 3, notifyTrades: false })
    expect(store.getSettings(101).slippagePct).toBe(3)
  })
})

describe('link requests and account links', () => {
  beforeEach(() => {
    store.upsertUser(alice)
    store.upsertUser(bob)
  })

  const request = (userId: number, codeHash: string) => store.createLinkRequest({ codeHash, userId, network: 'testnet', nonce: 'bm9uY2U=', message: 'm', ttlMs: 600_000 })

  it('finds a live request, counts attempts and forgets nothing it shouldn’t', () => {
    request(101, 'h1')
    expect(store.getLinkRequest('h1')).toMatchObject({ userId: 101, network: 'testnet', attempts: 0, usedAt: null, expiresAt: 1_600_000 })
    expect(store.bumpLinkAttempt('h1')).toBe(1)
    expect(store.countLinkRequestsSince(101, 0)).toBe(1)
  })

  it('links once: the request is used up and a second completion fails', () => {
    request(101, 'h1')
    expect(store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).toEqual({ previousUserId: null })
    expect(store.linksOf(101, 'testnet').map((l) => l.accountId)).toEqual(['alice.testnet'])
    expect(() => store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).toThrow(/already used/)
  })

  it('refuses an expired request', () => {
    request(101, 'h1')
    now += 600_001
    expect(() => store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })).toThrow(/expired/)
  })

  it('moves an account to a new Telegram user only through a completed request, and reports who lost it', () => {
    request(101, 'h1')
    store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'shared.testnet', userId: 101, publicKey: 'ed25519:K' })
    request(202, 'h2')
    expect(store.completeLink({ codeHash: 'h2', network: 'testnet', accountId: 'shared.testnet', userId: 202, publicKey: 'ed25519:K2' })).toEqual({ previousUserId: 101 })
    expect(store.linksOf(101, 'testnet')).toEqual([])
    expect(store.linkOf('testnet', 'shared.testnet')?.userId).toBe(202)
    expect(store.linkEvents('testnet', 'shared.testnet').map((e) => e.kind)).toEqual(['linked', 'moved-away', 'linked'])
  })

  it('refuses a request owned by someone else', () => {
    request(101, 'h1')
    expect(() => store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'x.testnet', userId: 202, publicKey: 'ed25519:K' })).toThrow(/another Telegram account/)
  })

  it('keeps networks apart', () => {
    request(101, 'h1')
    expect(() => store.completeLink({ codeHash: 'h1', network: 'mainnet', accountId: 'alice.near', userId: 101, publicKey: 'ed25519:K' })).toThrow(/network/)
  })

  it('unlinks only the owner’s link and clears it as the default account', () => {
    request(101, 'h1')
    store.completeLink({ codeHash: 'h1', network: 'testnet', accountId: 'alice.testnet', userId: 101, publicKey: 'ed25519:K' })
    store.updateSettings(101, { defaultAccount: 'alice.testnet' })
    expect(store.unlink('testnet', 'alice.testnet', 202)).toBe(false)
    expect(store.unlink('testnet', 'alice.testnet', 101)).toBe(true)
    expect(store.linksOf(101, 'testnet')).toEqual([])
    expect(store.getSettings(101).defaultAccount).toBeNull()
  })
})

describe('conversation state and callbacks', () => {
  beforeEach(() => store.upsertUser(alice))

  it('keeps a flow until it expires', () => {
    store.setSession(1, 101, 'buy', { step: 'amount' }, 60_000)
    expect(store.getSession(1, 101)).toEqual({ flow: 'buy', data: { step: 'amount' }, expiresAt: 1_060_000 })
    now += 60_001
    expect(store.getSession(1, 101)).toBeNull()
  })

  it('stores long button payloads behind a short id, per user', () => {
    const id = store.putCallback({ contract: 'a'.repeat(64) }, 101, 1, 60_000)
    expect(id.length).toBeLessThanOrEqual(22)
    expect(store.getCallback(id, 101)).toEqual({ contract: 'a'.repeat(64) })
    expect(store.getCallback(id, 999)).toBeNull()
    now += 60_001
    expect(store.getCallback(id, 101)).toBeNull()
  })

  it('prunes expired rows', () => {
    store.setSession(1, 101, 'buy', {}, 1)
    store.putCallback({}, 101, 1, 1)
    now += 10
    store.prune()
    expect(store.counts()).toMatchObject({ sessions: 0, callbacks: 0 })
  })
})

describe('meta', () => {
  it('stores small values by key', () => {
    expect(store.getMeta('telegram_offset')).toBeNull()
    store.setMeta('telegram_offset', '42')
    expect(store.getMeta('telegram_offset')).toBe('42')
  })
})

describe('boots', () => {
  it('counts every start in the database file, so a restart shows the data survived', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nearkit-boot-')), 'nearkit.sqlite')
    const start = async (at: number) => {
      const db = await Db.open(path)
      migrate(db)
      const boot = new Store(db, () => at).recordBoot()
      db.close()
      return boot
    }
    expect(await start(1000)).toEqual({ boot: 1, since: 1000 })
    expect(await start(2000)).toEqual({ boot: 2, since: 1000 })
    expect(await start(3000)).toEqual({ boot: 3, since: 1000 })
  })
})
