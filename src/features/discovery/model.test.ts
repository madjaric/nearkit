import { describe, expect, it } from 'vitest'
import type { LaunchRow, TradeView } from '@/lib/discovery/api'
import { DEFAULT_WEIGHTS, launchScore, periodChange, radarItems, radarSummary, riskFlags, sourceLabel, tradesCsv, windowCoverage, type RadarFilter } from './model'

/** Launch Radar's page rules (DISCOVERY.md, Launch Radar). */

const row = (o: Partial<LaunchRow> & Pick<LaunchRow, 'token'>): LaunchRow => ({
  symbol: o.token.split('.')[0]?.toUpperCase() ?? null,
  name: null,
  decimals: 18,
  createdAt: 1_000,
  createdHeight: 1,
  firstSeenAt: 1_000,
  dev: 'dev.near',
  source: { id: 'nearlytrade.near', name: 'Nearly', kind: 'launchpad', launches: 10 },
  venue: 'Rhea DCL',
  mainPool: 'REFDCL-x',
  mainPoolUrl: null,
  priceUsd: 0.001,
  priceChange5m: null,
  priceChange1h: 5,
  priceChange6h: 10,
  priceChange24h: 20,
  volume1h: 10,
  volume6h: 60,
  volume24h: 100,
  liquidityUsd: 5_000,
  marketCapUsd: null,
  buys24h: 20,
  sells24h: 10,
  traders24h: 25,
  holders: 50,
  reputation: 'Unknown',
  top10Share: null,
  devShare: null,
  holdersAt: null,
  tracked: 0,
  marketAt: 1,
  ...o,
})

const filter = (o: Partial<RadarFilter> = {}): RadarFilter => ({ tab: 'last', source: 'all', q: '', spam: false, watchOnly: false, watch: new Set(), ...o })

describe('the quality score (Last Best)', () => {
  it('is 0-100 from liquidity, holders, traders, buy pressure and reputation, with the default weights', () => {
    // liquidity log10(5000)/log10(50000) ≈ 0.787, holders log10(50)/3 ≈ 0.566, traders log10(25)/log10(200) ≈ 0.608, buys 20/30, reputation 0.4
    const s = launchScore(row({ token: 'a.near' }))
    expect(s).toBeCloseTo((100 * (3 * 0.7871 + 2 * 0.5663 + 2 * 0.6075 + 1 * (2 / 3) + 1 * 0.4)) / 9, 0)
  })

  it('no market: no score; the weights change it; all weights zero: none', () => {
    expect(launchScore(row({ token: 'a.near', liquidityUsd: 0 }))).toBeNull()
    expect(launchScore(row({ token: 'a.near', mainPool: null }))).toBeNull()
    const onlyLiquidity = launchScore(row({ token: 'a.near' }), { liquidity: 1, holders: 0, traders: 0, buys: 0, reputation: 0 })
    expect(onlyLiquidity).toBeCloseTo(78.7, 0)
    expect(launchScore(row({ token: 'a.near' }), { liquidity: 0, holders: 0, traders: 0, buys: 0, reputation: 0 })).toBeNull()
  })

  it('under 5 trades the buy pressure is neutral (0.5); spam reputation scores zero there', () => {
    const quiet = launchScore(row({ token: 'a.near', buys24h: 2, sells24h: 0 }), { ...DEFAULT_WEIGHTS, liquidity: 0, holders: 0, traders: 0, reputation: 0 })
    expect(quiet).toBe(50)
    expect(launchScore(row({ token: 'a.near', reputation: 'Spam' }), { liquidity: 0, holders: 0, traders: 0, buys: 0, reputation: 1 })).toBe(0)
  })
})

describe('the tabs', () => {
  const rows = [
    row({ token: 'old.near', createdAt: 1, priceChange24h: 90 }),
    row({ token: 'new.near', createdAt: 3, liquidityUsd: 100, priceChange24h: 500 }),
    row({ token: 'mid.near', createdAt: 2, liquidityUsd: 40_000, holders: 900, priceChange24h: 30 }),
    row({ token: 'spam.near', createdAt: 4, reputation: 'Spam' }),
    row({ token: 'dry.near', createdAt: 5, mainPool: null, liquidityUsd: null }),
  ]

  it('Last: newest first, spam hidden unless asked', () => {
    expect(radarItems(rows, filter(), '24h').map((i) => i.row.token)).toEqual(['dry.near', 'new.near', 'mid.near', 'old.near'])
    expect(radarItems(rows, filter({ spam: true }), '24h')[1]?.row.token).toBe('spam.near')
  })

  it('Last Best: only launches with a market, by score', () => {
    expect(radarItems(rows, filter({ tab: 'best' }), '24h').map((i) => i.row.token)).toEqual(['mid.near', 'old.near', 'new.near'])
  })

  it('Top: at least $1,000 liquidity and 10 trades, by the period’s change', () => {
    expect(radarItems(rows, filter({ tab: 'top' }), '24h').map((i) => i.row.token)).toEqual(['old.near', 'mid.near'])
    expect(radarItems(rows, filter({ tab: 'top' }), '1h').map((i) => i.row.token)).toEqual(['old.near', 'mid.near'])
  })

  it('Top keeps launches younger than the period (no change that old reported), by their longest reported window', () => {
    // As on mainnet 2026-10-16: launches under 24h old carry no 24h change, so Top on 24h was always empty.
    const young = [
      row({ token: 'a.near', priceChange24h: null, priceChange6h: null, priceChange1h: 8 }),
      row({ token: 'b.near', priceChange24h: null, priceChange6h: 40 }),
      row({ token: 'c.near', priceChange24h: null, priceChange6h: null, priceChange1h: null, priceChange5m: null }),
    ]
    expect(radarItems(young, filter({ tab: 'top' }), '24h').map((i) => i.row.token)).toEqual(['b.near', 'a.near'])
    expect(radarItems(young, filter({ tab: 'top' }), '6h').map((i) => i.row.token)).toEqual(['b.near', 'a.near'])
  })

  it('source, search and watchlist filters', () => {
    const more = [...rows, row({ token: 'pad.other.near', source: { id: null, name: null, kind: 'direct', launches: 0 }, symbol: 'PADX', createdAt: 9 })]
    expect(radarItems(more, filter({ source: 'direct' }), '24h').map((i) => i.row.token)).toEqual(['pad.other.near'])
    expect(radarItems(more, filter({ q: 'padx' }), '24h').map((i) => i.row.token)).toEqual(['pad.other.near'])
    expect(radarItems(more, filter({ q: 'mid.near' }), '24h').map((i) => i.row.token)).toEqual(['mid.near'])
    expect(radarItems(more, filter({ watchOnly: true, watch: new Set(['old.near']) }), '24h').map((i) => i.row.token)).toEqual(['old.near'])
  })
})

describe('the period’s price change', () => {
  it('is the period’s own window when Intear reports it', () => {
    expect(periodChange(row({ token: 'a.near' }), '24h')).toEqual({ value: 20, window: '24h' })
    expect(periodChange(row({ token: 'a.near' }), '7d')).toEqual({ value: 20, window: '24h' })
    expect(periodChange(row({ token: 'a.near' }), '6h')).toEqual({ value: 10, window: '6h' })
    expect(periodChange(row({ token: 'a.near' }), '1h')).toEqual({ value: 5, window: '1h' })
  })

  it('falls back to the longest shorter window, never a longer one; none reported: null', () => {
    expect(periodChange(row({ token: 'a.near', priceChange24h: null }), '24h')).toEqual({ value: 10, window: '6h' })
    expect(periodChange(row({ token: 'a.near', priceChange24h: null, priceChange6h: null }), '24h')).toEqual({ value: 5, window: '1h' })
    expect(periodChange(row({ token: 'a.near', priceChange1h: null, priceChange5m: 2 }), '1h')).toEqual({ value: 2, window: '5m' })
    expect(periodChange(row({ token: 'a.near', priceChange6h: null, priceChange1h: null }), '6h')).toBeNull()
  })
})

describe('the window Top Wallets’ index covers', () => {
  const day = 86_400_000
  const start = Date.UTC(2026, 8, 18)
  const now = Date.UTC(2026, 9, 16, 8)

  it('while catching up, counts only up to the newest indexed swap, never to now', () => {
    const index = { indexStart: start, tradesTo: start + 2.5 * day, backfilling: true }
    expect(windowCoverage('all', index, now)).toEqual({ days: null, covered: 2, state: 'catching-up' })
    expect(windowCoverage('7d', index, now)).toEqual({ days: 7, covered: 0, state: 'catching-up' })
    expect(windowCoverage('30d', index, now)).toEqual({ days: 30, covered: 2, state: 'catching-up' })
    expect(windowCoverage('all', { indexStart: start, tradesTo: null, backfilling: false }, now)).toEqual({ days: null, covered: 0, state: 'catching-up' })
  })

  it('live: full when the index is older than the window, partial when it is younger', () => {
    const index = { indexStart: start, tradesTo: now - 60_000, backfilling: false }
    expect(windowCoverage('7d', index, now)).toEqual({ days: 7, covered: 7, state: 'full' })
    expect(windowCoverage('90d', index, now)).toEqual({ days: 90, covered: 28, state: 'young' })
    expect(windowCoverage('all', index, now)).toEqual({ days: null, covered: 28, state: 'full' })
  })
})

describe('summary, risk flags, labels, export', () => {
  it('summary: launches, with a market, their 24h volume and liquidity; unknown stays unknown', () => {
    expect(radarSummary([row({ token: 'a.near' }), row({ token: 'b.near', mainPool: null, volume24h: null })])).toEqual({
      launches: 2,
      withMarket: 1,
      volume24h: 100,
      liquidity: 5_000,
    })
    expect(radarSummary([row({ token: 'a.near', volume24h: null, mainPool: null })])).toMatchObject({ volume24h: null, liquidity: null })
  })

  it('risk flags carry their evidence; missing data raises none (and is not a pass)', () => {
    expect(riskFlags(row({ token: 'a.near', liquidityUsd: 500, top10Share: 0.62, devShare: 0.15, reputation: 'Spam' })).map((f) => [f.key, f.evidence])).toEqual([
      ['spam', 'Intear’s token reputation is Spam.'],
      ['low-liquidity', 'Liquidity is under $1,000.'],
      ['concentrated', 'The 10 largest holders own 62% of supply (pools and the launchpad left out).'],
      ['dev-heavy', 'The deploying account holds 15% of supply.'],
    ])
    expect(riskFlags(row({ token: 'a.near' }))).toEqual([])
    expect(riskFlags(row({ token: 'a.near', mainPool: null }))[0]?.key).toBe('no-market')
  })

  it('a source reads as its product, its account, or Direct', () => {
    expect(sourceLabel({ id: 'nearlytrade.near', name: 'Nearly', kind: 'launchpad', launches: 1 })).toBe('Nearly')
    expect(sourceLabel({ id: 'tknport.near', name: null, kind: 'factory', launches: 1 })).toBe('tknport.near')
    expect(sourceLabel({ id: null, name: null, kind: 'direct', launches: 0 })).toBe('Direct')
  })

  it('CSV export: one line per trade, quoted where needed, empty where unknown', () => {
    const t: TradeView = {
      ts: Date.UTC(2026, 9, 16, 1, 2, 3),
      trader: 'a.near',
      side: 'buy',
      token: 'x.near',
      symbol: 'X,Y',
      amount: 2,
      counterToken: 'wrap.near',
      counterSymbol: 'NEAR',
      counterAmount: null,
      usd: 4.5,
      tx: 'TX',
    }
    expect(tradesCsv([t])).toBe(
      'time_utc,side,token,symbol,amount,counter_token,counter_symbol,counter_amount,usd_value,transaction\n2026-10-16T01:02:03.000Z,buy,x.near,"X,Y",2,wrap.near,NEAR,,4.5,TX\n',
    )
  })
})
