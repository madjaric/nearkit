import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { Db } from '../db/sqlite'
import { BuybotStore, MAX_CONFIGS_PER_CHAT } from './store'

let now = 1_000
let store: BuybotStore

beforeEach(async () => {
  now = 1_000
  const db = await Db.open(null)
  migrate(db)
  store = new BuybotStore(db, () => now)
})

const cfg = (chatId: number, token = 'sing.near') =>
  store.addConfig({ chatId, chatTitle: 'G', network: 'mainnet', token, symbol: 'SING', name: 'Sing', decimals: 18, createdBy: 1 })
const buy = (key = 'tx1:sing.near:alice.near') => ({
  eventKey: key,
  network: 'mainnet',
  token: 'sing.near',
  side: 'buy' as const,
  txHash: 'tx1',
  buyer: 'alice.near',
  amount: 10n ** 21n,
  paid: [{ asset: 'near', amount: 10n ** 24n }],
  blockHeight: 5,
})

describe('buybot configurations', () => {
  it('follows a token once per chat, and only active ones count', () => {
    const a = cfg(-1)
    cfg(-2)
    expect(() => cfg(-1)).toThrow(/UNIQUE/)
    expect(store.activeTokens('mainnet')).toEqual(['sing.near'])
    store.updateConfig(a.id, { enabled: false })
    expect(store.activeConfigsFor('mainnet', 'sing.near').map((c) => c.chatId)).toEqual([-2])
    store.pauseChat(-2, 'bot removed')
    expect(store.activeTokens('mainnet')).toEqual([])
    store.resumeChat(-2)
    expect(store.activeTokens('mainnet')).toEqual(['sing.near'])
  })

  it('limits how many tokens one chat follows', () => {
    for (let i = 0; i < MAX_CONFIGS_PER_CHAT; i++) cfg(-1, `t${i}.near`)
    expect(() => cfg(-1, 'more.near')).toThrow(/at most/)
  })

  it('keeps settings as exact amounts and follows a chat that migrated', () => {
    const c = cfg(-1)
    expect(store.updateConfig(c.id, { minNear: 5n * 10n ** 23n, emoji: '🚀', silent: true })).toMatchObject({ minNear: 5n * 10n ** 23n, emoji: '🚀', silent: true })
    store.migrateChat(-1, -100999)
    expect(store.config(c.id)?.chatId).toBe(-100999)
  })
})

describe('cursors and candidates', () => {
  it('moves a token’s cursor with its candidates, merges tokens, and never re-reads a done one', () => {
    expect(store.tokenCursor('mainnet', 'x.near')).toBeNull()
    store.advanceToken('mainnet', 'x.near', 100, [{ txHash: 'h1', blockHeight: 99 }])
    store.advanceToken('mainnet', 'y.near', 101, [{ txHash: 'h1', blockHeight: 99 }])
    expect(store.tokenCursor('mainnet', 'x.near')).toBe(100)
    expect(store.tokenCursors('mainnet').sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: 'x.near', height: 100 },
      { token: 'y.near', height: 101 },
    ])
    const due = store.dueCandidates('mainnet')
    expect(due).toHaveLength(1)
    expect(due[0]?.tokens.sort()).toEqual(['x.near', 'y.near'])
    expect(store.retryCandidate('h1', 5_000)).toBe(1)
    expect(store.dueCandidates('mainnet')).toEqual([])
    now += 5_000
    expect(store.dueCandidates('mainnet')).toHaveLength(1)
    store.finishCandidate('h1')
    expect(store.dueCandidates('mainnet')).toEqual([])
    // The index shows it again: still done.
    store.advanceToken('mainnet', 'x.near', 102, [{ txHash: 'h1', blockHeight: 99 }])
    expect(store.dueCandidates('mainnet')).toEqual([])
    now += 3_600_001
    store.prune(7 * 86_400_000)
    store.advanceToken('mainnet', 'x.near', 103, [{ txHash: 'h1', blockHeight: 99 }])
    expect(store.dueCandidates('mainnet')).toHaveLength(1)
  })
})

describe('buys and deliveries', () => {
  it('records a buy once and queues one delivery per chat, even when read twice', () => {
    const a = cfg(-1)
    const b = cfg(-2)
    expect(store.recordBuy(buy(), [a.id, b.id])).toBe(true)
    expect(store.recordBuy(buy(), [a.id, b.id])).toBe(false)
    expect(store.dueDeliveries()).toHaveLength(2)
    expect(store.event(buy().eventKey)?.paid).toEqual([{ asset: 'near', amount: 10n ** 24n }])
  })

  it('moves a delivery forward only: sent stays sent', () => {
    const a = cfg(-1)
    store.recordBuy(buy(), [a.id])
    store.markRetry(buy().eventKey, a.id, 3_000, 'Too Many Requests')
    expect(store.dueDeliveries()).toEqual([])
    now += 3_000
    expect(store.dueDeliveries()).toHaveLength(1)
    store.markSent(buy().eventKey, a.id, 77)
    store.markDone(buy().eventKey, a.id, 'failed', 'late error')
    expect(store.delivery(buy().eventKey, a.id)).toMatchObject({ status: 'sent', messageId: 77, attempts: 2 })
    expect(store.dueDeliveries()).toEqual([])
    expect(store.stats('mainnet', [a.id])).toMatchObject({ sent: 1, pending: 0, lastBuyAt: 1_000 })
  })

  it('prunes old buys with their deliveries', () => {
    const a = cfg(-1)
    store.recordBuy(buy(), [a.id])
    now += 8 * 86_400_000
    store.prune(7 * 86_400_000)
    expect(store.event(buy().eventKey)).toBeNull()
    expect(store.delivery(buy().eventKey, a.id)).toBeNull()
  })
})

describe('buybot V2 settings', () => {
  it('a followed token starts with the old behavior: NEAR minimum, 30 emoji, no media, no sells', () => {
    expect(cfg(-9)).toMatchObject({ unit: 'NEAR', minUsd: 0, stepUsd: 10, maxEmoji: 30, media: null, sells: false })
  })

  it('keeps media, unit and sells, and switches a whole chat on or off', () => {
    const a = cfg(-10)
    store.updateConfig(a.id, { unit: 'USD', minUsd: 25, media: { kind: 'video', fileId: 'v1' }, sells: true })
    expect(store.config(a.id)).toMatchObject({ unit: 'USD', minUsd: 25, media: { kind: 'video', fileId: 'v1' }, sells: true })
    expect(store.setChatEnabled(-10, false)).toBe(1)
    expect(store.config(a.id)?.enabled).toBe(false)
    expect(store.setChatEnabled(-10, true)).toBe(1)
    expect(store.config(a.id)?.enabled).toBe(true)
  })

  it('records a sell as a sell', () => {
    const a = cfg(-11)
    expect(store.recordBuy({ ...buy('tx9:sing.near:bob.near'), side: 'sell' }, [a.id])).toBe(true)
    expect(store.event('tx9:sing.near:bob.near')?.side).toBe('sell')
  })
})
