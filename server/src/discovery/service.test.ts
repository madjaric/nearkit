import { describe, expect, it } from 'vitest'
import { HttpError } from '../api/http'
import { openTestDatabase } from '../db/testing'
import { silentLogger } from '../log'
import type { RawTrade } from './accounting'
import type { IndexerStatus } from './indexer'
import { IntearError, type Intear, type LaunchToken } from './intear'
import { discoveryRoutes } from './routes'
import { createDiscoveryService } from './service'
import { DiscoveryStore } from './store'

/**
 * Launch Radar's and Top Wallets' read side and routes, on a real database filled the way the indexer
 * fills it, with a fake Intear for what only detail views read.
 */

const DAY = 86_400_000
const NOW = 20_100 * DAY + 12 * 3_600_000
const NET = { id: 'mainnet', wrapContract: 'wrap.near', stableTokens: [{ contract: 'usdt.tether-token.near' }] }
const X = 'x.nearlytrade.near'
const Y = 'y.nearlytrade.near'
const Z = 'z.nearlytrade.near'

const token = (o: Partial<LaunchToken> & Pick<LaunchToken, 'token'>): LaunchToken =>
  ({
    symbol: o.token.split('.')[0]?.toUpperCase(),
    decimals: 18,
    createdAt: NOW - 3_600_000,
    createdHeight: 9,
    dev: 'dev.near',
    liquidityUsd: 5_000,
    priceUsd: 0.5,
    mainPool: 'REFDCL-x|wrap.near|10000',
    reputation: 'Unknown',
    ...o,
  }) as LaunchToken

const status: IndexerStatus = {
  running: true,
  indexStart: NOW - 40 * DAY,
  tradesTo: NOW - 60_000,
  tradesAt: NOW,
  backfilling: false,
  launchesAt: NOW - 30_000,
  holdersAt: null,
  error: null,
}

function fakeIntear(o: { fail?: boolean; candleCalls?: [string, string, number][] } = {}): Intear {
  const boom = async (): Promise<never> => {
    throw new IntearError(503, 'internal', 'down')
  }
  return {
    launches: async () => ({ height: 1, at: NOW, tokens: [] }),
    tokens: async (ids) => ids.map((id) => token({ token: id, createdAt: NOW - 90 * DAY })),
    thumbnails: async (ids) => new Map(ids.map((id) => [id, 'data:image/webp;base64,AAAA'])),
    trades: o.fail
      ? boom
      : async (q) => ({
          height: 1,
          at: NOW,
          nextCursor: null,
          rows: [
            {
              id: 1,
              ts: NOW - 1_000,
              height: 1,
              trader: 'buyer.near',
              poolId: 'p',
              tokenIn: 'wrap.near',
              amountIn: '1000000000000000000000000',
              tokenOut: q.token ?? X,
              amountOut: '2000000000000000000',
              usd: 4,
              tx: 'TX',
            },
          ] satisfies RawTrade[],
        }),
    holders: async () => ({ total: 3, rows: [{ account: 'dev.near', balance: '100' }] }),
    closes: async (ids) => new Map(ids.map((id) => [id, { time: [1, 2, 3], close: [1, null, 2] }])),
    candles: async (token, resolution, countBack) => {
      o.candleCalls?.push([token, resolution, countBack])
      if (o.fail) throw new IntearError(503, 'internal', 'down')
      return token === 'unknown.near' ? null : { time: [1], open: [1], high: [1], low: [1], close: [1], volume: [1] }
    },
  }
}

/** A wallet that qualifies over 30 days: 12 winning round trips across two tokens. */
async function seed(store: DiscoveryStore) {
  await store.upsertTokens('mainnet', [token({ token: X }), token({ token: Y, createdAt: NOW - 2 * DAY }), token({ token: Z, createdAt: NOW - 30 * 60_000, reputation: 'Spam' })])
  await store.countSources('mainnet')
  await store.setSourceContract('mainnet', 'nearlytrade.near', true)
  const launches = new Map([
    [X, NOW - 3_600_000],
    [Y, NOW - 2 * DAY],
  ])
  const actions = []
  for (let i = 0; i < 12; i++) {
    const t = NOW - 20 * DAY + i * DAY
    const tok = i % 2 ? X : Y
    actions.push({ trader: 'pro.near', token: tok, side: 'buy' as const, qty: 100, usd: 10, ts: t, tx: `b${i}`, id: i * 2 })
    actions.push({ trader: 'pro.near', token: tok, side: 'sell' as const, qty: 100, usd: 15, ts: t + 3_600_000, tx: `s${i}`, id: i * 2 + 1 })
  }
  // A launch trade by the qualified wallet in X, inside the last hour.
  actions.push({ trader: 'pro.near', token: X, side: 'buy' as const, qty: 5, usd: 2, ts: NOW - 10 * 60_000, tx: 'early', id: 999 })
  // A one-trade wonder: big profit, not qualified.
  actions.push({ trader: 'lucky.near', token: X, side: 'buy' as const, qty: 1, usd: 1, ts: NOW - 5 * DAY, tx: 'l1', id: 1000 })
  actions.push({ trader: 'lucky.near', token: X, side: 'sell' as const, qty: 1, usd: 5_000, ts: NOW - 4 * DAY, tx: 'l2', id: 1001 })
  await store.applyPage('mainnet', actions, { launches, cursorKey: 'c', cursor: '1' })
}

async function setup(o: { fail?: boolean; candleCalls?: [string, string, number][] } = {}) {
  const store = new DiscoveryStore(await openTestDatabase('sqlite'), () => NOW)
  await seed(store)
  const service = createDiscoveryService({ store, intear: fakeIntear(o), indexer: { status: () => status }, network: NET, log: silentLogger, now: () => NOW })
  const routes = discoveryRoutes({ service, store, network: 'mainnet', sessions: null })
  const call = (path: string, body: unknown) => (routes[path] as (b: unknown, r: never) => Promise<unknown>)(body, {} as never)
  return { store, service, call }
}

describe('Launch Radar read side', () => {
  it('launches in the period with their validated source, venue, figures and tracked-wallet count', async () => {
    const { service } = await setup()
    const r = await service.launches('24h')
    expect(r.launches.map((l) => l.token)).toEqual([Z, X])
    const x = r.launches.find((l) => l.token === X)
    expect(x).toMatchObject({ source: { id: 'nearlytrade.near', name: 'Nearly', kind: 'launchpad' }, venue: 'Rhea DCL', priceUsd: 0.5, tracked: 1 })
    expect(r.launches.find((l) => l.token === Z)?.reputation).toBe('Spam')
    expect(r.sources).toEqual([{ id: 'nearlytrade.near', name: 'Nearly', kind: 'launchpad', launches: 2 }])
    expect(r).toMatchObject({ trackedWallets: 1, stale: false, index: { on: true, stale: false } })
  })

  it('row extras: 24h closes (gaps dropped) and the token’s own icon', async () => {
    const { service } = await setup()
    expect(await service.extras([X])).toEqual({ [X]: { spark: [1, 2], thumb: 'data:image/webp;base64,AAAA' } })
  })

  it('launch detail: holders read when missing, candles, latest trades seen from the token, tracked wallets’ evidence', async () => {
    const { service } = await setup()
    const d = await service.launch(X)
    expect(d?.holders).toMatchObject({ total: 3 })
    expect(d?.candles?.close).toEqual([1])
    expect(d?.trades[0]).toMatchObject({ side: 'buy', token: X, symbol: 'X', amount: 2, counterSymbol: 'NEAR', counterAmount: 1, usd: 4, tx: 'TX' })
    expect(d?.signals).toEqual([
      expect.objectContaining({ trader: 'pro.near', qualified: true, trades: expect.arrayContaining([expect.objectContaining({ side: 'buy', tx: 'early' })]) }),
    ])
  })
})

describe('Top Wallets read side', () => {
  it('the 30-day PnL ranking lists qualified wallets only; activity lists everyone', async () => {
    const { service } = await setup()
    const pnl = await service.wallets({ window: '30d', metric: 'pnl', category: 'all', limit: 100 })
    expect(pnl.rows.map((r) => r.trader)).toEqual(['pro.near'])
    expect(pnl.rows[0]).toMatchObject({
      rank: 1,
      realized: 60,
      closed: 12,
      winRate: 1,
      coverage: 1,
      qualified: true,
      topTokens: [
        { token: X, symbol: 'X' },
        { token: Y, symbol: 'Y' },
      ],
    })
    expect(pnl.rows[0]?.last).toMatchObject({ side: 'buy', token: X, tx: 'early' })
    expect(pnl.counts).toEqual({ wallets: 2, qualified: 1 })
    const act = await service.wallets({ window: '30d', metric: 'activity', category: 'all', limit: 100 })
    expect(act.rows.map((r) => r.trader)).toEqual(['lucky.near', 'pro.near'])
    expect(act.rows[0]).toMatchObject({ qualified: false, reasons: expect.arrayContaining(['closed-trades', 'one-token']) })
  })

  it('wallet detail: windows, the daily realized curve and its drawdown, token performance with an unrealized estimate, recent trades', async () => {
    const { service } = await setup()
    const w = await service.wallet('pro.near')
    expect(w?.windows['30d']).toMatchObject({ realized: 60, qualified: true })
    expect(w?.days.at(-1)?.cumulative).toBe(60)
    expect(w?.maxDrawdown).toBe(0)
    const x = w?.tokens.find((t) => t.token === X)
    expect(x).toMatchObject({ symbol: 'X', realized: 30, closed: 6, open: true, cost: 2 })
    // 5 raw units of an 18-decimal token at $0.5: worth ~0, so the estimate is about −$2.
    expect(x?.unrealized).toBeCloseTo(-2)
    expect(w?.holding.closedPositions).toBe(12)
    expect(w?.trades).toHaveLength(1)
    expect(await service.wallet('nobody.near')).toBeNull()
  })
})

describe('routes', () => {
  it('validate their input and answer 400, 404 or 503 as such', async () => {
    const { call } = await setup()
    await expect(call('/api/discovery/wallet', { account: 'NOT AN ACCOUNT' })).rejects.toMatchObject({ status: 400 })
    await expect(call('/api/discovery/wallet', { account: 'nobody.near' })).rejects.toMatchObject({ status: 404 })
    await expect(call('/api/discovery/launch', { token: 'never.seen.near' })).resolves.toMatchObject({ launch: { token: 'never.seen.near' } })
    expect(await call('/api/discovery/launches', { period: 'weird' })).toMatchObject({ period: '24h' })
    await expect(call('/api/web/discovery/follows', { session: 'x'.repeat(43) })).rejects.toBeInstanceOf(HttpError)
    const down = await setup({ fail: true })
    await expect(down.call('/api/discovery/wallet/trades', { account: 'pro.near' })).rejects.toMatchObject({ status: 503, code: 'source' })
  })

  it('candles: each interval is the Intear resolution it names, with as much history as one request holds', async () => {
    const candleCalls: [string, string, number][] = []
    const { call } = await setup({ candleCalls })
    const want: [string, string, number, number][] = [
      ['1m', '1', 360, 60],
      ['5m', '5', 576, 300],
      ['15m', '15', 672, 900],
      ['1h', '60', 720, 3_600],
      ['4h', '240', 540, 14_400],
      ['1d', 'D', 365, 86_400],
    ]
    for (const [interval, resolution, countBack, intervalSec] of want) {
      const r = await call('/api/discovery/candles', { token: X, interval })
      expect(r).toEqual({ token: X, interval, intervalSec, candles: { time: [1], open: [1], high: [1], low: [1], close: [1], volume: [1] }, at: NOW })
      expect(candleCalls.at(-1)).toEqual([X, resolution, countBack])
    }
  })

  it('candles: one read per token and interval while fresh; 400 for a bad interval or token, 404 for a token Intear has no candles for, 503 when it is down', async () => {
    const candleCalls: [string, string, number][] = []
    const { call } = await setup({ candleCalls })
    await call('/api/discovery/candles', { token: X, interval: '5m' })
    await call('/api/discovery/candles', { token: X, interval: '5m' })
    expect(candleCalls).toHaveLength(1)
    await call('/api/discovery/candles', { token: X, interval: '15m' })
    expect(candleCalls).toHaveLength(2)
    await expect(call('/api/discovery/candles', { token: X, interval: '3m' })).rejects.toMatchObject({ status: 400 })
    await expect(call('/api/discovery/candles', { token: X })).rejects.toMatchObject({ status: 400 })
    await expect(call('/api/discovery/candles', { token: 'NOT A TOKEN', interval: '1h' })).rejects.toMatchObject({ status: 400 })
    await expect(call('/api/discovery/candles', { token: 'unknown.near', interval: '1h' })).rejects.toMatchObject({ status: 404 })
    const down = await setup({ fail: true })
    await expect(down.call('/api/discovery/candles', { token: X, interval: '1h' })).rejects.toMatchObject({ status: 503, code: 'source' })
  })

  it('signals: followed wallets’ swaps in recent launches', async () => {
    const { call } = await setup()
    const r = (await call('/api/discovery/signals', { wallets: ['pro.near', 'BAD ONE'], since: NOW - DAY })) as { trades: { token: string; tx: string }[] }
    expect(r.trades.map((t) => [t.token, t.tx])).toEqual([[X, 'early']])
  })
})

describe('units', () => {
  it('price changes are percent in the API (Intear reports fractions)', async () => {
    const store = new DiscoveryStore(await openTestDatabase('sqlite'), () => NOW)
    await store.upsertTokens('mainnet', [token({ token: X, priceChange24h: 0.117, priceChange1h: -0.5 })])
    const service = createDiscoveryService({ store, intear: fakeIntear(), indexer: { status: () => status }, network: NET, log: silentLogger, now: () => NOW })
    const x = (await service.launches('24h')).launches[0]
    expect(x?.priceChange24h).toBeCloseTo(11.7)
    expect(x?.priceChange1h).toBeCloseTo(-50)
  })
})
