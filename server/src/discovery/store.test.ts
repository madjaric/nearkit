import { describe, expect, it } from 'vitest'
import { ENGINE_TIMEOUT_MS, openTestDatabase, TEST_ENGINES } from '../db/testing'
import type { TokenAction } from './accounting'
import type { LaunchToken } from './intear'
import { DiscoveryStore, parentOf } from './store'

/** The discovery tables on SQLite and PostgreSQL (PGlite): what the indexer writes is what the routes read. */

const NET = 'mainnet'
const DAY = 86_400_000
const T0 = 20_000 * DAY // a UTC day boundary
const X = 'x.nearlytrade.near'
const Y = 'y.tkn.near'

const act = (o: Partial<TokenAction> & Pick<TokenAction, 'side' | 'qty' | 'usd' | 'ts'>): TokenAction => ({ trader: 'alice.near', token: X, tx: `tx${o.ts}`, id: o.ts, ...o })

const launch = (o: Partial<LaunchToken> & Pick<LaunchToken, 'token'>): LaunchToken => ({
  symbol: 'X',
  name: 'X',
  decimals: 18,
  createdHeight: 1,
  createdAt: T0,
  dev: 'dev.near',
  holders: 3,
  liquidityUsd: 1000,
  priceUsd: 0.01,
  marketCapUsd: null,
  priceChange5m: null,
  priceChange1h: null,
  priceChange6h: null,
  priceChange24h: null,
  volumeUsd1h: null,
  volumeUsd6h: null,
  volumeUsd24h: null,
  buys1h: null,
  sells1h: null,
  buys24h: null,
  sells24h: null,
  traders24h: null,
  mainPool: null,
  mainPoolUrl: null,
  reputation: 'Unknown',
  totalSupply: null,
  iconHash: null,
  ...o,
})

describe('parentOf', () => {
  it('names the account that created a sub-account; none for top-level or implicit accounts', () => {
    expect(parentOf('rear-3.nearlytrade.near')).toBe('nearlytrade.near')
    expect(parentOf('freemi.gaypad.j1-racing.near')).toBe('gaypad.j1-racing.near')
    expect(parentOf('wrap.near')).toBeNull()
    expect(parentOf('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBeNull()
  })
})

describe.each(TEST_ENGINES)('DiscoveryStore on %s', (engine) => {
  it(
    'tokens: each recorded once with its first sighting; market figures replaced; launch sources counted',
    async () => {
      let now = T0 + 1_000
      const s = new DiscoveryStore(await openTestDatabase(engine), () => now)
      expect(await s.upsertTokens(NET, [launch({ token: X }), launch({ token: 'z.nearlytrade.near', createdAt: T0 - DAY })])).toBe(2)
      now += 60_000
      expect(await s.upsertTokens(NET, [launch({ token: X, priceUsd: 0.02 })])).toBe(0)
      const t = await s.token(NET, X)
      expect(t).toMatchObject({ token: X, parent: 'nearlytrade.near', firstSeenAt: T0 + 1_000, createdAt: T0 })
      expect(t?.market?.priceUsd).toBe(0.02)
      expect((await s.launches(NET, T0)).map((x) => x.token)).toEqual([X])
      await s.countSources(NET)
      await s.setSourceContract(NET, 'nearlytrade.near', true)
      expect(await s.sources(NET)).toEqual([{ parent: 'nearlytrade.near', hasContract: true, launches: 2, checkedAt: now }])
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'pages of swaps: positions carry over pages, days sum, the wallet keeps its first and last trade, launch trades are kept, the cursor commits',
    async () => {
      const s = new DiscoveryStore(await openTestDatabase(engine), () => T0)
      const launches = new Map([[X, T0]])
      await s.applyPage(NET, [act({ side: 'buy', qty: 100, usd: 10, ts: T0 + 60_000 })], { launches, cursorKey: 'c', cursor: 'p1' })
      await s.applyPage(
        NET,
        [
          act({ side: 'sell', qty: 50, usd: 15, ts: T0 + DAY + 1 }),
          act({ token: Y, side: 'buy', qty: 5, usd: 2, ts: T0 + DAY + 2 }),
          act({ token: Y, side: 'sell', qty: 5, usd: 1, ts: T0 + DAY + 3 }),
        ],
        { launches, cursorKey: 'c', cursor: 'p2' },
      )
      expect(await s.getMeta('c')).toBe('p2')
      const tokens = await s.walletTokens(NET, 'alice.near')
      expect(tokens.find((t) => t.token === X)).toMatchObject({ qty: 50, cost: 5, realized: 10, closed: 1, wins: 1, earlyBuyAt: T0 + 60_000, lastSellAt: T0 + DAY + 1 })
      expect(tokens.find((t) => t.token === Y)).toMatchObject({ qty: 0, realized: -1, closed: 1, wins: 0, earlyBuyAt: null })
      const days = await s.walletDays(NET, 'alice.near')
      expect(days.map((d) => [d.day - 20_000, d.legs, d.closed, d.realized])).toEqual([
        [0, 1, 0, 0],
        [1, 3, 2, 9],
      ])
      expect((await s.wallets(NET, ['alice.near'])).get('alice.near')).toMatchObject({ firstTs: T0 + 60_000, lastTs: T0 + DAY + 3, legs: 4, lastSide: 'sell', lastToken: Y })
      const lt = await s.launchTrades(NET, { token: X, since: 0, limit: 10 })
      expect(lt.map((t) => t.side)).toEqual(['sell', 'buy'])
      // A replayed page with the same rows is a new application: the cursor, committed with it, is what prevents a replay.
      expect(await s.launchTrades(NET, { traders: ['alice.near'], since: T0 + DAY, limit: 10 })).toHaveLength(1)
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'window rows: sums from the first day, tokens sold, profitable and early tokens',
    async () => {
      const s = new DiscoveryStore(await openTestDatabase(engine), () => T0)
      const launches = new Map([[X, T0]])
      await s.applyPage(
        NET,
        [
          act({ side: 'buy', qty: 100, usd: 10, ts: T0 + 1 }),
          act({ side: 'sell', qty: 100, usd: 20, ts: T0 + 3 * DAY }),
          act({ token: Y, side: 'buy', qty: 10, usd: 10, ts: T0 + 3 * DAY + 1 }),
          act({ token: Y, side: 'sell', qty: 10, usd: 30, ts: T0 + 4 * DAY }),
          act({ trader: 'bob.near', side: 'sell', qty: 10, usd: 9, ts: T0 + 4 * DAY }),
        ],
        { launches, cursorKey: 'c', cursor: 'x' },
      )
      const rows = await s.windowRows(NET, 20_000 + 2, T0 + 2 * DAY, 1)
      const alice = rows.find((r) => r.trader === 'alice.near')
      expect(alice).toMatchObject({ realized: 30, costClosed: 20, closed: 2, wins: 2, tokensSold: 2, profitableTokens: 2, earlyTokens: 0, firstTs: T0 + 1, lastTs: T0 + 4 * DAY })
      const all = await s.windowRows(NET, 0, 0, 1)
      expect(all.find((r) => r.trader === 'alice.near')?.earlyTokens).toBe(1)
      // bob sold what he never bought here: volume, but nothing realized and nothing matched.
      expect(rows.find((r) => r.trader === 'bob.near')).toMatchObject({ realized: 0, closed: 0, sellUsd: 9, unmatchedUsd: 9 })
      expect((await s.topTokens(NET, ['alice.near'], 1)).get('alice.near')).toEqual([{ token: Y, volume: 40 }])
    },
    ENGINE_TIMEOUT_MS,
  )

  it(
    'follows: per user, alerts on or off, listed per followed account',
    async () => {
      const s = new DiscoveryStore(await openTestDatabase(engine), () => T0)
      await s.follow(1, NET, 'whale.near', true)
      await s.follow(2, NET, 'whale.near', false)
      await s.follow(1, NET, 'other.near', false)
      await s.follow(1, NET, 'other.near', true)
      expect(await s.countFollows(1, NET)).toBe(2)
      expect((await s.alertFollowers(NET)).get('whale.near')).toEqual([1])
      expect((await s.alertFollowers(NET)).get('other.near')).toEqual([1])
      await s.unfollow(1, NET, 'whale.near')
      expect((await s.follows(1, NET)).map((f) => f.account)).toEqual(['other.near'])
    },
    ENGINE_TIMEOUT_MS,
  )
})
