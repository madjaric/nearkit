import { describe, expect, it } from 'vitest'
import { openTestDatabase } from '../db/testing'
import { silentLogger } from '../log'
import type { RawTrade, TokenAction } from './accounting'
import { createDiscoveryIndexer } from './indexer'
import { IntearError, type Intear, type LaunchToken } from './intear'
import { DiscoveryStore } from './store'

/**
 * The indexer against a fake Intear that pages like the real one (oldest first, a cursor until the
 * last page): launches recorded with their sources checked, swaps applied page by page with the cursor,
 * a restart going on from where it stopped, live swaps handed to alerts, holders read for launches.
 */

const DAY = 86_400_000
const NOW = 20_100 * DAY
const NETWORK = { id: 'mainnet', wrapContract: 'wrap.near', stableTokens: [{ contract: 'usdt.tether-token.near' }] }
const X = 'x.nearlytrade.near'

const token = (o: Partial<LaunchToken> & Pick<LaunchToken, 'token'>): LaunchToken =>
  ({
    symbol: 'X',
    name: 'X',
    decimals: 18,
    createdHeight: 1,
    createdAt: NOW - DAY,
    dev: 'dev.near',
    holders: 4,
    liquidityUsd: 5_000,
    priceUsd: 0.1,
    totalSupply: '1000',
    mainPool: 'REFDCL-x|wrap.near|10000',
    reputation: 'Unknown',
    ...o,
  }) as LaunchToken

function fakeIntear(trades: RawTrade[], opts: { pageSize?: number } = {}) {
  const size = opts.pageSize ?? 2
  const calls: string[] = []
  const intear: Intear = {
    launches: async () => {
      calls.push('launches')
      return { height: 1, at: NOW, tokens: [token({ token: X }), token({ token: 'y.nearlytrade.near' }), token({ token: 'z.nearlytrade.near' })] }
    },
    tokens: async () => [],
    thumbnails: async () => new Map(),
    trades: async (q) => {
      calls.push(`trades after=${q.afterMillis} cursor=${q.cursor ?? '-'}`)
      const start = q.cursor ? Number(q.cursor) : 0
      const from = trades.filter((t) => t.ts >= (q.afterMillis ?? 0))
      const rows = from.slice(start, start + size)
      return { height: 1, at: NOW, rows, nextCursor: start + size < from.length ? String(start + size) : null }
    },
    holders: async () => ({
      total: 4,
      rows: [
        { account: 'dclv2.ref-labs.near', balance: '600' },
        { account: 'dev.near', balance: '200' },
        { account: 'a.near', balance: '100' },
      ],
    }),
    closes: async () => new Map(),
    candles: async () => null,
  }
  return { intear, calls }
}

let id = 0
const trade = (o: Partial<RawTrade> & Pick<RawTrade, 'ts' | 'tokenIn' | 'tokenOut'>): RawTrade => ({
  id: ++id,
  height: 1,
  trader: 'alice.near',
  poolId: 'p',
  amountIn: '100',
  amountOut: '100',
  usd: 10,
  tx: `tx${id}`,
  ...o,
})

async function setup(trades: RawTrade[], o: { live?: TokenAction[][] } = {}) {
  const db = await openTestDatabase('sqlite')
  const store = new DiscoveryStore(db, () => NOW)
  const fake = fakeIntear(trades)
  const make = () =>
    createDiscoveryIndexer({
      store,
      intear: fake.intear,
      network: NETWORK,
      hasContract: async (a) => a === 'nearlytrade.near',
      lease: { hold: async () => true, release: async () => undefined },
      log: silentLogger,
      now: () => NOW,
      startAt: NOW - 10 * DAY,
      onLive: async (a) => void o.live?.push([...a]),
    })
  return { store, fake, make }
}

describe('discovery indexer', () => {
  it('records launches and checks their launchpad for a contract', async () => {
    const { store, make } = await setup([])
    await make().step()
    expect((await store.launches('mainnet', NOW - 7 * DAY)).map((t) => t.token).sort()).toEqual([X, 'y.nearlytrade.near', 'z.nearlytrade.near'])
    expect(await store.sources('mainnet')).toEqual([expect.objectContaining({ parent: 'nearlytrade.near', hasContract: true, launches: 3 })])
  })

  it('applies swaps page by page; a restart goes on from the cursor; nothing is applied twice', async () => {
    const trades = [
      trade({ ts: NOW - 5 * DAY, tokenIn: 'wrap.near', tokenOut: X, amountOut: '100', usd: 10 }),
      trade({ ts: NOW - 4 * DAY, tokenIn: X, tokenOut: 'wrap.near', amountIn: '100', usd: 30 }),
      trade({ ts: NOW - 3 * DAY, tokenIn: 'wrap.near', tokenOut: X, amountOut: '50', usd: 5 }),
    ]
    const { store, fake, make } = await setup(trades)
    const a = make()
    expect(await a.step()).toBe(2)
    expect(a.status()).toMatchObject({ backfilling: true, tradesTo: NOW - 4 * DAY })
    // A new process (a restart) picks up the cursor.
    const b = make()
    expect(await b.step()).toBe(1)
    expect(fake.calls.filter((c) => c.startsWith('trades'))).toEqual([`trades after=${NOW - 10 * DAY} cursor=-`, `trades after=${NOW - 10 * DAY} cursor=2`])
    // At the head: the next read starts at the last swap's time, and the swaps already applied are skipped.
    expect(await b.step()).toBe(1)
    const pos = (await store.walletTokens('mainnet', 'alice.near')).find((t) => t.token === X)
    expect(pos).toMatchObject({ realized: 20, closed: 1, buys: 2, sells: 1, qty: 50 })
  })

  it('live swaps (the last 15 minutes) are handed to alerts after they are stored', async () => {
    const live: TokenAction[][] = []
    const { make } = await setup([trade({ ts: NOW - 60_000, tokenIn: 'wrap.near', tokenOut: X }), trade({ ts: NOW - 2 * DAY, tokenIn: 'wrap.near', tokenOut: X })], { live })
    // Oldest first: the old one, then the live one.
    await make().step()
    expect(live.flat().map((a) => a.ts)).toEqual([NOW - 60_000])
  })

  it('reads holder concentration for recent launches with a market', async () => {
    const { store, make } = await setup([])
    await make().step()
    const t = await store.token('mainnet', X)
    expect(t?.holders).toMatchObject({ total: 4, devShare: 0.2, excluded: ['dclv2.ref-labs.near'] })
    expect(t?.holders?.top10Share).toBeCloseTo(0.3)
  })

  it('a failed step is reported, and the loop keeps running (back-off on 429)', async () => {
    const db = await openTestDatabase('sqlite')
    const fake = fakeIntear([])
    fake.intear.launches = async () => {
      throw new IntearError(429, 'rate_limited', 'slow down')
    }
    const pauses: number[] = []
    const idx = createDiscoveryIndexer({
      store: new DiscoveryStore(db, () => NOW),
      intear: fake.intear,
      network: NETWORK,
      hasContract: async () => true,
      lease: { hold: async () => true, release: async () => undefined },
      log: silentLogger,
      now: () => NOW,
      startAt: NOW - DAY,
      sleep: async (ms) => {
        pauses.push(ms)
        await idx.stop()
      },
    })
    idx.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(pauses).toEqual([60_000])
    expect(idx.status().error).toBe('slow down')
  })
})
