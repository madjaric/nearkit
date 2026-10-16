import type {
  IndexStatus,
  LaunchDetail,
  LaunchExtras,
  LaunchRow,
  LaunchesResponse,
  TradeView,
  WalletCategory,
  WalletDetail,
  WalletRow,
  WalletsResponse,
  WalletWindowKey,
} from '@/lib/discovery/api'
import { PERIOD_MS } from '@/lib/discovery/api'
import { hashString, mulberry32 } from '@/lib/prng'
import { DAY, HOUR, SEED_NOW } from '@/mocks/time'
import type { DiscoveryClient } from './discoveryApi'

/**
 * The demo's Launch Radar and Top Wallets: fictional tokens, launchpads and wallets on a `.sample.near`
 * namespace (no real project or wallet is shown with invented figures), deterministic on every load,
 * labeled as demo data on the pages. Nothing here is read from a chain or a provider.
 */

const NAMES = [
  'Moss',
  'Orbit',
  'Ember',
  'Quill',
  'Drift',
  'Pebble',
  'Lumen',
  'Tide',
  'Fable',
  'Cinder',
  'Nimbus',
  'Sprout',
  'Vale',
  'Glint',
  'Harbor',
  'Rook',
  'Sable',
  'Thistle',
  'Zephyr',
  'Wren',
  'Juniper',
  'Basalt',
  'Comet',
  'Marble',
]
const SOURCES = [
  { id: 'launchpad.sample.near', name: 'Sample Launchpad', kind: 'launchpad' as const },
  { id: 'factory.sample.near', name: null, kind: 'factory' as const },
  { id: null, name: null, kind: 'direct' as const },
]

function launches(): LaunchRow[] {
  const rand = mulberry32(hashString('nearkits-demo-launches'))
  return NAMES.map((name, i) => {
    const src = SOURCES[i % 3] as (typeof SOURCES)[number]
    const age = Math.floor((i * i * 0.9 + rand() * 2) * HOUR) + 7 * 60_000
    const market = i % 7 !== 3
    const liquidity = market ? Math.round(800 + rand() * 60_000) : null
    const buys = market ? Math.round(5 + rand() * 120) : null
    const sells = market ? Math.round(3 + rand() * 90) : null
    const token = `${name.toLowerCase()}.${src.id ?? 'sample.near'}`
    return {
      token,
      symbol: name.toUpperCase().slice(0, 6),
      name,
      decimals: 18,
      createdAt: SEED_NOW - age,
      createdHeight: 220_000_000 - Math.round(age / 1_000),
      firstSeenAt: SEED_NOW - age + 4_000,
      dev: `dev-${i + 1}.sample.near`,
      source: { ...src, launches: 8 },
      venue: market ? 'Rhea DCL' : null,
      mainPool: market ? `REFDCL-${token}|wrap.near|10000` : null,
      mainPoolUrl: null,
      priceUsd: market ? 0.00001 * (1 + rand() * 40) : null,
      priceChange5m: market ? (rand() - 0.45) * 8 : null,
      priceChange1h: market ? (rand() - 0.4) * 60 : null,
      priceChange6h: market ? (rand() - 0.35) * 150 : null,
      priceChange24h: market && age > 6 * HOUR ? (rand() - 0.3) * 400 : null,
      volume1h: market ? Math.round(rand() * 9_000) : null,
      volume6h: market ? Math.round(rand() * 40_000) : null,
      volume24h: market ? Math.round(2_000 + rand() * 120_000) : null,
      liquidityUsd: liquidity,
      marketCapUsd: null,
      buys24h: buys,
      sells24h: sells,
      traders24h: market ? Math.round(4 + rand() * 180) : null,
      holders: market ? Math.round(5 + rand() * 1_600) : 2,
      reputation: i % 11 === 5 ? 'Spam' : 'Unknown',
      top10Share: market ? 0.15 + rand() * 0.6 : null,
      devShare: market ? rand() * 0.2 : null,
      holdersAt: SEED_NOW - 20 * 60_000,
      tracked: i % 4 === 0 ? 1 + (i % 3) : 0,
      marketAt: SEED_NOW - 30_000,
    }
  })
}

const index = (): IndexStatus => ({ on: true, indexStart: SEED_NOW - 40 * DAY, tradesTo: SEED_NOW - 45_000, backfilling: false, stale: false, launchesAt: SEED_NOW - 30_000 })

function wallets(): WalletRow[] {
  const rand = mulberry32(hashString('nearkits-demo-wallets'))
  const list = launches()
  return Array.from({ length: 36 }, (_, i) => {
    const closed = 6 + Math.round(rand() * 80)
    const winRate = 0.35 + rand() * 0.5
    const wins = Math.round(closed * winRate)
    const realized = Math.round((rand() - 0.25) * 12_000)
    const cost = 2_000 + rand() * 30_000
    const automated = i % 13 === 7
    const qualified = closed >= 10 && i % 9 !== 4
    const categories: WalletCategory[] = ['all']
    if (!automated && qualified) categories.push('traders')
    if (!automated && qualified && winRate >= 0.55 && realized >= 250 && closed >= 20) categories.push('smart')
    if (!automated && i % 5 === 2) categories.push('early')
    const tok = list[i % list.length] as LaunchRow
    return {
      rank: i + 1,
      trader: `trader-${String(i + 1).padStart(2, '0')}.sample.near`,
      realized,
      returnPct: (realized / cost) * 100,
      winRate: wins / closed,
      closed,
      wins,
      avgGain: wins ? Math.abs(realized) / wins + 40 : null,
      avgLoss: closed - wins ? 60 + rand() * 200 : null,
      buyUsd: Math.round(cost * 1.4),
      sellUsd: Math.round(cost * 1.2),
      unmatchedUsd: Math.round(cost * 0.05 * rand()),
      coverage: 0.82 + rand() * 0.18,
      tokensSold: 2 + Math.round(rand() * 12),
      qualified,
      reasons: qualified ? [] : ['closed-trades'],
      automated,
      categories,
      firstTs: SEED_NOW - Math.round((5 + rand() * 30) * DAY),
      lastTs: SEED_NOW - Math.round(rand() * 6 * HOUR),
      last: {
        side: rand() > 0.4 ? 'buy' : 'sell',
        token: tok.token,
        symbol: tok.symbol,
        usd: Math.round(50 + rand() * 2_000),
        tx: `DemoTx${i}`,
        ts: SEED_NOW - Math.round(rand() * 6 * HOUR),
      },
      topTokens: [0, 1, 2].map((k) => {
        const t = list[(i + k * 5) % list.length] as LaunchRow
        return { token: t.token, symbol: t.symbol }
      }),
    }
  })
}

function demoTrades(token: string, symbol: string | null, n: number, seed: string, trader?: string): TradeView[] {
  const rand = mulberry32(hashString(seed))
  return Array.from({ length: n }, (_, i) => {
    const side = rand() > 0.45 ? 'buy' : 'sell'
    const near = 0.2 + rand() * 40
    return {
      ts: SEED_NOW - Math.round((i + rand()) * 11 * 60_000),
      trader: trader ?? `trader-${String(1 + Math.floor(rand() * 36)).padStart(2, '0')}.sample.near`,
      side,
      token,
      symbol,
      amount: Math.round(near * (5_000 + rand() * 90_000)),
      counterToken: 'wrap.near',
      counterSymbol: 'NEAR',
      counterAmount: near,
      usd: near * 4.8,
      tx: `DemoTx${seed.length}${i}`,
    } satisfies TradeView
  })
}

const pause = () => new Promise((r) => setTimeout(r, 120))

export function createDemoDiscovery(): DiscoveryClient {
  return {
    status: async () => index(),
    async launches(period): Promise<LaunchesResponse> {
      await pause()
      const rows = launches().filter((l) => (l.createdAt ?? 0) >= SEED_NOW - PERIOD_MS[period])
      const per = new Map<string, LaunchRow['source']>()
      for (const r of rows) {
        const k = r.source.id ?? 'direct'
        per.set(k, { ...r.source, launches: (per.get(k)?.launches ?? 0) + 1 })
      }
      return { period, asOf: SEED_NOW, marketAt: SEED_NOW - 30_000, stale: false, launches: rows, sources: [...per.values()], trackedWallets: 24, index: index() }
    },
    async extras(tokens): Promise<LaunchExtras> {
      const out: LaunchExtras = {}
      for (const t of tokens) {
        const rand = mulberry32(hashString(`spark-${t}`))
        let v = 1
        out[t] = { spark: Array.from({ length: 24 }, () => (v *= 0.92 + rand() * 0.18)), thumb: null }
      }
      return out
    },
    async launch(token): Promise<LaunchDetail> {
      await pause()
      const row = launches().find((l) => l.token === token) ?? (launches()[0] as LaunchRow)
      const rand = mulberry32(hashString(`candles-${token}`))
      let p = row.priceUsd ?? 0.0001
      const time: number[] = []
      const open: number[] = []
      const high: number[] = []
      const low: number[] = []
      const close: number[] = []
      const volume: number[] = []
      const hours = Math.min(168, Math.max(2, Math.floor((SEED_NOW - (row.createdAt ?? SEED_NOW)) / HOUR)))
      for (let i = hours; i > 0; i--) {
        const o = p
        p = o * (0.9 + rand() * 0.22)
        time.push(Math.floor((SEED_NOW - i * HOUR) / HOUR) * HOUR)
        open.push(o)
        close.push(p)
        high.push(Math.max(o, p) * (1 + rand() * 0.05))
        low.push(Math.min(o, p) * (1 - rand() * 0.05))
        volume.push(Math.round(rand() * 5_000))
      }
      const ws = wallets().slice(0, 3)
      return {
        launch: row,
        holders:
          row.top10Share === null
            ? null
            : {
                total: row.holders,
                top: Array.from({ length: 10 }, (_, i) => ({ account: `holder-${i + 1}.sample.near`, share: (row.top10Share as number) / (i + 2) })),
                excluded: ['dclv2.ref-labs.near'],
                at: SEED_NOW - 20 * 60_000,
              },
        candles: { time, open, high, low, close, volume },
        trades: demoTrades(row.token, row.symbol, 20, `t-${token}`),
        tradesAt: SEED_NOW,
        signals: ws.map((w, i) => ({
          trader: w.trader,
          qualified: w.qualified,
          smart: w.categories.includes('smart'),
          stats30d: { realized: w.realized, returnPct: w.returnPct, winRate: w.winRate, closed: w.closed, coverage: w.coverage, qualified: w.qualified },
          trades: [{ side: 'buy', usd: 120 + i * 80, ts: SEED_NOW - (i + 1) * 17 * 60_000, tx: `DemoSignal${i}` }],
        })),
        index: index(),
      }
    },
    async wallets(q): Promise<WalletsResponse> {
      await pause()
      const s = q.search?.trim().toLowerCase()
      let rows = wallets().filter((w) => w.categories.includes(q.category) && (q.metric === 'activity' || w.qualified) && (!s || w.trader.includes(s)))
      const by = {
        pnl: (w: WalletRow) => w.realized,
        return: (w: WalletRow) => w.returnPct ?? 0,
        winrate: (w: WalletRow) => w.winRate ?? 0,
        activity: (w: WalletRow) => w.buyUsd + w.sellUsd,
      }[q.metric]
      rows = rows.sort((a, b) => by(b) - by(a)).map((w, i) => ({ ...w, rank: i + 1 }))
      const days = { all: null, '7d': 7, '30d': 30, '90d': 90 }[q.window]
      return {
        window: q.window,
        metric: q.metric,
        category: q.category,
        asOf: SEED_NOW,
        coverage: { days, covered: Math.min(days ?? 40, 40) },
        rows,
        counts: { wallets: 36, qualified: wallets().filter((w) => w.qualified).length },
        freshAvailable: true,
        index: index(),
      }
    },
    async wallet(account): Promise<WalletDetail> {
      await pause()
      const w = wallets().find((x) => x.trader === account) ?? (wallets()[0] as WalletRow)
      const rand = mulberry32(hashString(`days-${account}`))
      let run = 0
      const today = Math.floor(SEED_NOW / DAY)
      const days = Array.from({ length: 30 }, (_, i) => {
        const realized = (rand() - 0.42) * (Math.abs(w.realized) / 8 + 50)
        run += realized
        return { day: today - 29 + i, realized, cumulative: run, closed: Math.round(rand() * 6), wins: Math.round(rand() * 4), legs: Math.round(rand() * 20) }
      })
      const { rank: _rank, last: _last, topTokens, ...row } = w
      const windows = {} as Record<WalletWindowKey, typeof row>
      for (const k of ['all', '7d', '30d', '90d'] as const) windows[k] = { ...row, realized: k === '7d' ? Math.round(w.realized / 4) : w.realized }
      let peak = 0
      let dd = 0
      for (const d of days) {
        peak = Math.max(peak, d.cumulative)
        dd = Math.max(dd, peak - d.cumulative)
      }
      return {
        trader: w.trader,
        windows,
        days,
        maxDrawdown: dd,
        tokens: topTokens.map((t, i) => ({
          token: t.token,
          symbol: t.symbol,
          realized: Math.round((rand() - 0.3) * 3_000),
          closed: 2 + i,
          wins: 1 + (i % 2),
          buys: 3 + i,
          sells: 2 + i,
          buyUsd: 1_000 + i * 700,
          sellUsd: 900 + i * 650,
          open: i === 0,
          cost: i === 0 ? 420 : 0,
          valueUsd: i === 0 ? 515 : null,
          unrealized: i === 0 ? 95 : null,
          unknownCost: false,
          avgHoldMs: (3 + i * 5) * HOUR,
          firstBuyAt: SEED_NOW - (10 - i) * DAY,
          lastAt: SEED_NOW - i * DAY,
        })),
        unrealized: { value: 95, positions: 1, unknown: 0 },
        holding: { avgMs: 7 * HOUR, closedPositions: 6 },
        trades: topTokens.flatMap((t, i) => demoTrades(t.token, t.symbol, 4, `w-${account}-${i}`, w.trader)).sort((a, b) => b.ts - a.ts),
        firstTs: w.firstTs,
        lastTs: w.lastTs,
        automated: w.automated,
        smart: w.categories.includes('smart'),
        index: index(),
      }
    },
    async walletTrades(account) {
      const d = await this.wallet(account)
      return { trades: d.trades, nextCursor: null }
    },
    async signals(wallets) {
      const rows = launches()
      return wallets.slice(0, 50).flatMap((w, i) => {
        const r = rows[(hashString(w) + i) % rows.length] as LaunchRow
        return [{ token: r.token, trader: w, side: 'buy' as const, usd: 150, ts: SEED_NOW - (i + 1) * 23 * 60_000, tx: `DemoFollow${i}` }]
      })
    },
  }
}
