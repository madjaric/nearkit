import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_LIVE_BOTS_PER_USER, defaultBotConfig } from '@/lib/volumeBot/config'
import { emptyBook } from '@/lib/volumeBot/inventory'
import { CustodyStore } from '../custody/store'
import type { Database } from '../db/database'
import { Store } from '../db/store'
import { anotherInstance, ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from '../db/testing'
import { VolumeBotStore, type RunState } from './store'

const USER = 101
const TOKEN = { id: 'tkn.testnet', symbol: 'TKN', decimals: 18 }
const state = (): RunState => ({
  progress: { startedAt: 0, trades: 0, boughtNear: 0, soldTokens: 0, lastTradeAt: null, inFlight: 0 },
  fair: null,
  books: { w: emptyBook() },
  expected: [],
  baselineLiquidityUsd: null,
  prevMarket: null,
  health: { consecutiveFailures: 0, rpcErrors: 0, providerErrors: 0 },
  equity: { startNear: null, peakNear: null, dayStartNear: null, day: null },
  lastMetricAt: null,
  waiting: null,
})

describe.each(TEST_ENGINES)(
  'the Volume Bot store on %s',
  (engine) => {
    let now = 1_000_000
    let db: Database
    let bots: VolumeBotStore
    let walletId = ''
    beforeEach(async () => {
      now = 1_000_000
      db = await openTestDatabase(engine)
      await new Store(db, () => now).upsertUser({ userId: USER, username: 'alice', firstName: 'Alice', languageCode: null })
      const custody = new CustodyStore(db, () => now)
      walletId = (await custody.createWallet({ userId: USER, network: 'testnet', accountId: 'a'.repeat(64), publicKey: 'ed25519:K', keyRef: 'local:x' })).wallet.id
      bots = new VolumeBotStore(db, () => now)
    })
    const make = () => bots.create({ userId: USER, network: 'testnet', config: defaultBotConfig('market-maker', TOKEN, [walletId]) })

    it('keeps a bot’s configuration and wallets; edits only while it isn’t live', async () => {
      const b = await make()
      expect(b).toMatchObject({ userId: USER, token: TOKEN.id, strategy: 'market-maker', status: 'draft', config: { walletIds: [walletId] } })
      const next = { ...b.config, risk: { ...b.config.risk, maxTradeNear: 2 } }
      expect((await bots.update(b.id, USER, next))?.config.risk.maxTradeNear).toBe(2)
      expect(await bots.update(b.id, 202, next)).toBeNull()
      expect(await bots.start(b.id, state())).toMatchObject({ ok: true })
      expect(await bots.update(b.id, USER, next)).toBeNull()
    })

    it('starts once; a second live bot of the same user on the same token is refused', async () => {
      const a = await make()
      const b = await make()
      expect(await bots.start(a.id, state())).toMatchObject({ ok: true })
      expect(await bots.start(a.id, state())).toEqual({ ok: false, reason: 'not-idle' })
      expect(await bots.start(b.id, state())).toEqual({ ok: false, reason: 'busy-token' })
      expect((await bots.get(b.id))?.status).toBe('draft')
    })

    it('starts racing (two instances, one user, every bot on its own token) never make more than MAX_LIVE_BOTS_PER_USER live', async () => {
      const list = []
      for (let i = 0; i <= MAX_LIVE_BOTS_PER_USER; i++)
        list.push(
          await bots.create({ userId: USER, network: 'testnet', config: defaultBotConfig('market-maker', { id: `r${i}.testnet`, symbol: `R${i}`, decimals: 6 }, [walletId]) }),
        )
      // On a real server each start runs on its own connection pool, like two app instances at once.
      const other = engine === 'postgres' ? new VolumeBotStore(anotherInstance(db), () => now) : bots
      const results = await Promise.all(list.map((b, i) => (i % 2 ? other : bots).start(b.id, state())))
      expect(results.filter((r) => r.ok)).toHaveLength(MAX_LIVE_BOTS_PER_USER)
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'too-many' }])
    })

    it('a user has at most MAX_LIVE_BOTS_PER_USER live bots at once (each on its own token); another starts once one has stopped', async () => {
      const tokens = Array.from({ length: MAX_LIVE_BOTS_PER_USER + 1 }, (_, i) => ({ id: `t${i}.testnet`, symbol: `T${i}`, decimals: 6 }))
      const list = []
      for (const t of tokens) list.push(await bots.create({ userId: USER, network: 'testnet', config: defaultBotConfig('market-maker', t, [walletId]) }))
      for (const b of list.slice(0, MAX_LIVE_BOTS_PER_USER)) expect(await bots.start(b.id, state())).toMatchObject({ ok: true })
      const last = list[MAX_LIVE_BOTS_PER_USER] as { id: string }
      expect(await bots.start(last.id, state())).toEqual({ ok: false, reason: 'too-many' })
      const first = list[0] as { id: string }
      await bots.stop(first.id, 'test')
      await bots.end(first.id, 'stopped', 'test')
      expect(await bots.start(last.id, state())).toMatchObject({ ok: true })
    })

    it('pauses with its reason, resumes, stops through stopping, and ends the run', async () => {
      const b = await make()
      await bots.start(b.id, state())
      expect(await bots.pause(b.id, 'drawdown', 'Value 21% below its peak')).toBe(true)
      expect(await bots.get(b.id)).toMatchObject({ status: 'paused', pauseCode: 'drawdown', pauseReason: 'Value 21% below its peak', nextTickAt: null })
      expect(await bots.pause(b.id, 'owner', 'again')).toBe(false)
      expect(await bots.resume(b.id)).toBe(true)
      expect(await bots.get(b.id)).toMatchObject({ status: 'running', pauseCode: null })
      expect(await bots.stop(b.id, 'Stopped by its owner')).toBe(true)
      expect((await bots.get(b.id))?.status).toBe('stopping')
      expect(await bots.end(b.id, 'stopped', 'Stopped by its owner')).toBe(true)
      expect(await bots.get(b.id)).toMatchObject({ status: 'stopped', stoppedAt: now })
      // Stopped: startable again, with a new run.
      expect(await bots.start(b.id, state())).toMatchObject({ ok: true })
    })

    it('hands a due bot to one worker at a time (its lease)', async () => {
      const b = await make()
      await bots.start(b.id, state())
      expect((await bots.due(10)).map((x) => x.id)).toEqual([b.id])
      expect(await bots.claim(b.id, 'w1', 30_000)).toBe(true)
      expect(await bots.claim(b.id, 'w2', 30_000)).toBe(false)
      expect(await bots.due(10)).toEqual([])
      now += 31_000
      expect(await bots.claim(b.id, 'w2', 30_000)).toBe(true)
      await bots.release(b.id, 'w2')
      await bots.setNextTick(b.id, now + 60_000)
      expect(await bots.due(10)).toEqual([])
    })

    it('two trades recorded at once (two instances) each get their own id', async () => {
      const b = await make()
      const started = await bots.start(b.id, state())
      if (!started.ok) throw new Error('not started')
      const other = engine === 'postgres' ? new VolumeBotStore(anotherInstance(db), () => now) : bots
      const trade = (intentId: string) => ({
        botId: b.id,
        runId: started.runId,
        walletId,
        intentId,
        side: 'buy' as const,
        status: 'submitted' as const,
        nearRaw: '1',
        tokenRaw: '1',
        priceNear: 1,
        impactBps: null,
        feeNear: null,
        gasNear: null,
        nearUsd: null,
        txHash: null,
        message: '',
      })
      const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? other : bots).addTrade(trade(`r${i}`))))
      expect(new Set(ids).size).toBe(6)
      const rows = await bots.trades(b.id)
      for (const [i, id] of ids.entries()) expect(rows.find((r) => r.id === id)?.intentId).toBe(`r${i}`)
    })

    it('records runs, trades, events and metrics', async () => {
      const b = await make()
      const started = await bots.start(b.id, state())
      if (!started.ok) throw new Error('not started')
      const run = await bots.currentRun(b.id)
      expect(run?.id).toBe(started.runId)
      await bots.saveRunState(started.runId, { ...state(), waiting: 'Learning fair value' })
      expect((await bots.currentRun(b.id))?.state.waiting).toBe('Learning fair value')
      const id = await bots.addTrade({
        botId: b.id,
        runId: started.runId,
        walletId,
        intentId: 'i1',
        side: 'buy',
        status: 'submitted',
        nearRaw: '1000',
        tokenRaw: null,
        priceNear: 0.01,
        impactBps: 12,
        feeNear: null,
        gasNear: null,
        nearUsd: 5,
        txHash: null,
        message: null,
      })
      expect((await bots.openTrades(b.id)).map((t) => t.id)).toEqual([id])
      await bots.settleTrade(id, { status: 'confirmed', tokenRaw: '99', txHash: 'h' })
      expect(await bots.openTrades(b.id)).toEqual([])
      expect((await bots.trades(b.id))[0]).toMatchObject({ status: 'confirmed', nearRaw: '1000', tokenRaw: '99', txHash: 'h', priceNear: 0.01 })
      await bots.event(b.id, 'guardian', 'Abnormal price movement', 'abnormal-price')
      expect((await bots.events(b.id))[0]).toMatchObject({ kind: 'guardian', code: 'abnormal-price' })
      await bots.addMetric(b.id, { at: now, priceNear: 0.01, equityNear: 10, pnlNear: 0, tokenPct: 50, inventoryTokens: 40, volumeNear: 1, trades: 1 })
      expect(await bots.metrics(b.id, 0)).toEqual([{ at: now, priceNear: 0.01, equityNear: 10, pnlNear: 0, tokenPct: 50, inventoryTokens: 40, volumeNear: 1, trades: 1 }])
      now += 40 * 86_400_000
      await bots.prune()
      expect(await bots.metrics(b.id, 0)).toEqual([])
      expect(await bots.trades(b.id)).toHaveLength(1)
    })

    it('deletes only a bot that isn’t live, and only its owner’s', async () => {
      const b = await make()
      expect(await bots.remove(b.id, 202)).toBe(false)
      await bots.start(b.id, state())
      expect(await bots.remove(b.id, USER)).toBe(false)
      await bots.stop(b.id, 'x')
      await bots.end(b.id, 'stopped', 'x')
      expect(await bots.remove(b.id, USER)).toBe(true)
      expect(await bots.get(b.id)).toBeNull()
    })
  },
  ENGINE_TIMEOUT_MS,
)
