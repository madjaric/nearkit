import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { BuybotStore, MAX_CONFIGS_PER_CHAT } from './store'

let now = 1_000
let store: BuybotStore

beforeEach(async () => {
  now = 1_000
  const db = await SqliteDatabase.open(null)
  await migrate(db)
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
  it('follows a token once per chat, and only active ones count', async () => {
    const a = await cfg(-1)
    await cfg(-2)
    await expect(cfg(-1)).rejects.toThrow(/UNIQUE/)
    expect(await store.activeTokens('mainnet')).toEqual(['sing.near'])
    await store.updateConfig(a.id, { enabled: false })
    expect((await store.activeConfigsFor('mainnet', 'sing.near')).map((c) => c.chatId)).toEqual([-2])
    await store.pauseChat(-2, 'bot removed')
    expect(await store.activeTokens('mainnet')).toEqual([])
    await store.resumeChat(-2)
    expect(await store.activeTokens('mainnet')).toEqual(['sing.near'])
  })

  it('limits how many tokens one chat follows', async () => {
    for (let i = 0; i < MAX_CONFIGS_PER_CHAT; i++) await cfg(-1, `t${i}.near`)
    await expect(cfg(-1, 'more.near')).rejects.toThrow(/at most/)
  })

  it('keeps settings as exact amounts and follows a chat that migrated', async () => {
    const c = await cfg(-1)
    expect(await store.updateConfig(c.id, { minNear: 5n * 10n ** 23n, emoji: '🚀', silent: true })).toMatchObject({ minNear: 5n * 10n ** 23n, emoji: '🚀', silent: true })
    await store.migrateChat(-1, -100999)
    expect((await store.config(c.id))?.chatId).toBe(-100999)
  })
})

describe('cursors and candidates', () => {
  it('moves a token’s cursor with its candidates, merges tokens, and never re-reads a done one', async () => {
    expect(await store.tokenCursor('mainnet', 'x.near')).toBeNull()
    await store.advanceToken('mainnet', 'x.near', 100, [{ txHash: 'h1', blockHeight: 99 }])
    await store.advanceToken('mainnet', 'y.near', 101, [{ txHash: 'h1', blockHeight: 99 }])
    expect(await store.tokenCursor('mainnet', 'x.near')).toBe(100)
    expect((await store.tokenCursors('mainnet')).sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: 'x.near', height: 100 },
      { token: 'y.near', height: 101 },
    ])
    const due = await store.dueCandidates('mainnet')
    expect(due).toHaveLength(1)
    expect(due[0]?.tokens.sort()).toEqual(['x.near', 'y.near'])
    expect(await store.retryCandidate('h1', 5_000)).toBe(1)
    expect(await store.dueCandidates('mainnet')).toEqual([])
    now += 5_000
    expect(await store.dueCandidates('mainnet')).toHaveLength(1)
    await store.finishCandidate('h1')
    expect(await store.dueCandidates('mainnet')).toEqual([])
    // The index shows it again: still done.
    await store.advanceToken('mainnet', 'x.near', 102, [{ txHash: 'h1', blockHeight: 99 }])
    expect(await store.dueCandidates('mainnet')).toEqual([])
    now += 3_600_001
    await store.prune(7 * 86_400_000)
    await store.advanceToken('mainnet', 'x.near', 103, [{ txHash: 'h1', blockHeight: 99 }])
    expect(await store.dueCandidates('mainnet')).toHaveLength(1)
  })
})

describe('buys and deliveries', () => {
  it('records a buy once and queues one delivery per chat, even when read twice', async () => {
    const a = await cfg(-1)
    const b = await cfg(-2)
    expect(await store.recordBuy(buy(), [a.id, b.id])).toBe(true)
    expect(await store.recordBuy(buy(), [a.id, b.id])).toBe(false)
    expect(await store.dueDeliveries()).toHaveLength(2)
    expect((await store.event(buy().eventKey))?.paid).toEqual([{ asset: 'near', amount: 10n ** 24n }])
  })

  it('moves a delivery forward only: sent stays sent', async () => {
    const a = await cfg(-1)
    await store.recordBuy(buy(), [a.id])
    await store.markRetry(buy().eventKey, a.id, 3_000, 'Too Many Requests')
    expect(await store.dueDeliveries()).toEqual([])
    now += 3_000
    expect(await store.dueDeliveries()).toHaveLength(1)
    await store.markSent(buy().eventKey, a.id, 77)
    await store.markDone(buy().eventKey, a.id, 'failed', 'late error')
    expect(await store.delivery(buy().eventKey, a.id)).toMatchObject({ status: 'sent', messageId: 77, attempts: 2 })
    expect(await store.dueDeliveries()).toEqual([])
    expect(await store.stats('mainnet', [a.id])).toMatchObject({ sent: 1, pending: 0, lastBuyAt: 1_000 })
  })

  it('prunes old buys with their deliveries', async () => {
    const a = await cfg(-1)
    await store.recordBuy(buy(), [a.id])
    now += 8 * 86_400_000
    await store.prune(7 * 86_400_000)
    expect(await store.event(buy().eventKey)).toBeNull()
    expect(await store.delivery(buy().eventKey, a.id)).toBeNull()
  })
})

describe('buybot V2 settings', () => {
  it('a followed token starts with the old behavior: NEAR minimum, 30 emoji, no media, no sells', async () => {
    expect(await cfg(-9)).toMatchObject({ unit: 'NEAR', minUsd: 0, stepUsd: 10, maxEmoji: 30, media: null, sells: false })
  })

  it('keeps media, unit and sells, and switches a whole chat on or off', async () => {
    const a = await cfg(-10)
    await store.updateConfig(a.id, { unit: 'USD', minUsd: 25, media: { kind: 'video', fileId: 'v1' }, sells: true })
    expect(await store.config(a.id)).toMatchObject({ unit: 'USD', minUsd: 25, media: { kind: 'video', fileId: 'v1' }, sells: true })
    expect(await store.setChatEnabled(-10, false)).toBe(1)
    expect((await store.config(a.id))?.enabled).toBe(false)
    expect(await store.setChatEnabled(-10, true)).toBe(1)
    expect((await store.config(a.id))?.enabled).toBe(true)
  })

  it('records a sell as a sell', async () => {
    const a = await cfg(-11)
    expect(await store.recordBuy({ ...buy('tx9:sing.near:bob.near'), side: 'sell' }, [a.id])).toBe(true)
    expect((await store.event('tx9:sing.near:bob.near'))?.side).toBe('sell')
  })
})
