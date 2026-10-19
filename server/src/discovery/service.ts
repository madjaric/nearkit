import {
  CANDLE_INTERVAL_SEC,
  PERIOD_MS,
  type CandleInterval,
  type CandlesResponse,
  type IndexStatus,
  type LaunchDetail,
  type LaunchExtras,
  type LaunchPeriod,
  type LaunchRow,
  type LaunchesResponse,
  type LaunchSourceView,
  type SignalView,
  type TradeView,
  type WalletCategory,
  type WalletDetail,
  type WalletMetric,
  type WalletRow,
  type WalletsResponse,
  type WalletTradesPage,
  type WalletWindowKey,
} from '@/lib/discovery/api'
import type { Logger } from '../log'
import { dayOf, type RawTrade } from './accounting'
import { STALE_MS, type DiscoveryIndexer } from './indexer'
import type { Intear } from './intear'
import { assess, maxDrawdown, rank, smartMoney, WINDOW_DAYS, windowCoverage, type Assessed, type WindowKey } from './ranking'
import { concentration, sourceOf, venueOf } from './sources'
import { parentOf, type DiscoveryStore, type StoredToken } from './store'

/**
 * Launch Radar's and Top Wallets' read side: what the routes answer, from the indexer's tables plus a
 * few reads of Intear that only a detail view needs (cached, through the same one-at-a-time client).
 * Everything is computed once for everyone and cached for a short while.
 */

const RANKING_TTL = 120_000
const LAUNCHES_TTL = 20_000
const DETAIL_TTL = 30_000
const CANDLES_TTL = 300_000
/** Each interval as Intear's resolution, with the history one request holds and how long a read stays fresh. */
const CANDLE_READ: Readonly<Record<CandleInterval, { resolution: '1' | '5' | '15' | '60' | '240' | 'D'; countBack: number; ttl: number }>> = {
  '1m': { resolution: '1', countBack: 360, ttl: 30_000 },
  '5m': { resolution: '5', countBack: 576, ttl: 60_000 },
  '15m': { resolution: '15', countBack: 672, ttl: 120_000 },
  '1h': { resolution: '60', countBack: 720, ttl: 300_000 },
  '4h': { resolution: '240', countBack: 540, ttl: 600_000 },
  '1d': { resolution: 'D', countBack: 365, ttl: 1_800_000 },
}
const SPARK_TTL = 600_000
const THUMB_TTL = 6 * 3_600_000
const META_TTL = 3_600_000
const HOLDERS_FRESH_MS = 30 * 60_000
/** Tracked wallets: the 30-day PnL ranking's first 200, and Smart Money. */
const TRACKED_TOP = 200
/** Wallets listed in a window: at least this volume, or a closed trade. */
const MIN_VOLUME = 100
const MARKET_STALE_MS = 5 * 60_000

type Entry<T> = { at: number; value?: T; pending?: Promise<T> }

function cache(now: () => number) {
  const m = new Map<string, Entry<unknown>>()
  return async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const e = m.get(key) as Entry<T> | undefined
    if (e?.value !== undefined && now() - e.at < ttl) return e.value
    if (e?.pending) return e.pending
    const pending = fn().then(
      (value) => {
        m.set(key, { at: now(), value })
        if (m.size > 5_000) m.delete(m.keys().next().value as string)
        return value
      },
      (err: unknown) => {
        // Serve the last good value if there is one; otherwise fail.
        if (e?.value !== undefined) {
          m.set(key, { at: e.at, value: e.value })
          return e.value
        }
        m.delete(key)
        throw err
      },
    )
    m.set(key, { at: e?.at ?? 0, value: e?.value, pending })
    return pending
  }
}

export interface DiscoveryService {
  status(): IndexStatus
  launches(period: LaunchPeriod): Promise<LaunchesResponse>
  extras(tokens: readonly string[]): Promise<LaunchExtras>
  launch(token: string): Promise<LaunchDetail | null>
  /** A token's USD candles at one interval, as Intear serves them; null when it has none. */
  candles(token: string, interval: CandleInterval): Promise<CandlesResponse | null>
  wallets(q: { window: WalletWindowKey; metric: WalletMetric; category: WalletCategory; limit: number; search?: string }): Promise<WalletsResponse>
  wallet(account: string): Promise<WalletDetail | null>
  walletTrades(account: string, cursor: string | null): Promise<WalletTradesPage>
  /** Given wallets' swaps in recent launches (followed wallets' evidence). */
  signals(wallets: readonly string[], since: number): Promise<{ token: string; trader: string; side: 'buy' | 'sell'; usd: number | null; ts: number; tx: string }[]>
}

export function createDiscoveryService(deps: {
  store: DiscoveryStore
  intear: Intear
  indexer: Pick<DiscoveryIndexer, 'status'>
  network: { id: string; wrapContract: string; stableTokens: readonly { contract: string }[] }
  log: Logger
  now?: () => number
}): DiscoveryService {
  const now = deps.now ?? Date.now
  const net = deps.network.id
  const cached = cache(now)
  const currency = new Set([deps.network.wrapContract, ...deps.network.stableTokens.map((s) => s.contract)])
  // Row extras, per token: the 24h trace and the icon (kept a while; the list repeats the same tokens).
  const sparks = new Map<string, { at: number; v: number[] | null }>()
  const thumbs = new Map<string, { at: number; v: string | null }>()
  const remember = <T>(m: Map<string, { at: number; v: T }>, id: string, e: { at: number; v: T }) => {
    m.delete(id)
    m.set(id, e)
    if (m.size > 10_000) m.delete(m.keys().next().value as string)
  }

  function status(): IndexStatus {
    const s = deps.indexer.status()
    return {
      on: s.running,
      indexStart: s.indexStart,
      tradesTo: s.tradesTo,
      backfilling: s.backfilling,
      stale: s.tradesTo === null || now() - s.tradesTo > STALE_MS,
      launchesAt: s.launchesAt,
    }
  }

  // ─── token metadata (symbols, decimals, prices) ─────────────────────────────

  async function meta(ids: readonly string[]): Promise<Map<string, StoredToken>> {
    const want = [...new Set(ids)]
    const known = await deps.store.tokens(net, want)
    const t = now()
    const missing = want.filter((id) => {
      const k = known.get(id)
      return !k || k.marketAt === null || t - k.marketAt > META_TTL
    })
    if (missing.length) {
      try {
        const fresh = await cached(`meta:${missing.sort().join(',')}`, META_TTL, () => deps.intear.tokens(missing.slice(0, 2_000)))
        await deps.store.upsertTokens(net, fresh)
        for (const [k, v] of await deps.store.tokens(net, missing)) known.set(k, v)
      } catch (e) {
        deps.log.warn('discovery: token metadata not read', { error: e instanceof Error ? e.message : String(e) })
      }
    }
    return known
  }

  const whole = (raw: string | null, decimals: number | null | undefined): number | null =>
    raw === null || decimals === null || decimals === undefined || !/^\d+$/.test(raw) ? null : Number(raw) / 10 ** decimals

  /** Legs as trades, seen from the token that isn't money (or from the one sold, token for token). */
  async function tradeViews(rows: readonly RawTrade[], focus?: string): Promise<TradeView[]> {
    const ids = rows.flatMap((r) => [r.tokenIn, r.tokenOut]).filter((x): x is string => Boolean(x))
    const m = await meta(ids)
    // wNEAR is NEAR here (24 decimals), whatever its metadata calls it.
    const sym = (id: string) => (id === deps.network.wrapContract ? 'NEAR' : (m.get(id)?.symbol ?? null))
    const dec = (id: string) => (id === deps.network.wrapContract ? 24 : m.get(id)?.decimals)
    const out: TradeView[] = []
    for (const r of rows) {
      if (!r.tokenIn || !r.tokenOut) continue
      const buy = focus ? r.tokenOut === focus : currency.has(r.tokenIn) && !currency.has(r.tokenOut)
      const token = buy ? r.tokenOut : r.tokenIn
      const counter = buy ? r.tokenIn : r.tokenOut
      const [amt, camt] = buy ? [r.amountOut, r.amountIn] : [r.amountIn, r.amountOut]
      out.push({
        ts: r.ts,
        trader: r.trader,
        side: buy ? 'buy' : 'sell',
        token,
        symbol: sym(token),
        amount: whole(amt, dec(token)),
        counterToken: counter,
        counterSymbol: sym(counter),
        counterAmount: whole(camt, dec(counter)),
        usd: r.usd,
        tx: r.tx,
      })
    }
    return out
  }

  // ─── Top Wallets ───────────────────────────────────────────────────────────

  const dayStart = (day: number) => day * 86_400_000

  async function assessed(window: WindowKey): Promise<Assessed[]> {
    return cached(`rank:${window}`, RANKING_TTL, async () => {
      const smart = window === '30d' ? undefined : smartMoney(await assessed('30d'))
      const days = WINDOW_DAYS[window]
      const fromDay = days === null ? 0 : dayOf(now()) - (days - 1)
      const rows = await deps.store.windowRows(net, fromDay, dayStart(fromDay), MIN_VOLUME)
      const ctx = { now: now(), indexStart: status().indexStart, ...(smart ? { smart } : {}) }
      const first = rows.map((r) => assess(r, window, ctx))
      if (window !== '30d') return first
      // The 30-day window names Smart Money from itself.
      const s = smartMoney(first)
      return rows.map((r) => assess(r, window, { ...ctx, smart: s }))
    })
  }

  async function tracked(): Promise<{ set: Set<string>; byTrader: Map<string, Assessed> }> {
    const rows = await assessed('30d')
    const top = rank(rows, { metric: 'pnl', category: 'all', limit: TRACKED_TOP })
    const set = new Set([...top.map((r) => r.trader), ...rows.filter((r) => r.categories.includes('smart')).map((r) => r.trader)])
    return { set, byTrader: new Map(rows.map((r) => [r.trader, r])) }
  }

  const statsOf = (a: Assessed | undefined): SignalView['stats30d'] =>
    a ? { realized: a.realized, returnPct: a.returnPct, winRate: a.winRate, closed: a.closed, coverage: a.coverage, qualified: a.qualified } : null

  const rowOf = (a: Assessed): Omit<WalletRow, 'rank' | 'last' | 'topTokens'> => ({
    trader: a.trader,
    realized: a.realized,
    returnPct: a.returnPct,
    winRate: a.winRate,
    closed: a.closed,
    wins: a.wins,
    avgGain: a.avgGain,
    avgLoss: a.avgLoss,
    buyUsd: a.buyUsd,
    sellUsd: a.sellUsd,
    unmatchedUsd: a.unmatchedUsd,
    coverage: a.coverage,
    tokensSold: a.tokensSold,
    qualified: a.qualified,
    reasons: a.reasons,
    automated: a.automated,
    categories: a.categories,
    firstTs: a.firstTs,
    lastTs: a.lastTs,
  })

  // ─── Launch Radar ──────────────────────────────────────────────────────────

  async function sourceViews(): Promise<Map<string, LaunchSourceView & { validated: boolean }>> {
    const out = new Map<string, LaunchSourceView & { validated: boolean }>()
    for (const s of await deps.store.sources(net)) {
      const v = sourceOf(s.parent, s)
      out.set(s.parent, { id: s.parent, name: v.name, kind: v.kind, launches: s.launches, validated: v.validated })
    }
    return out
  }

  const pct = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v * 100)

  function launchRow(t: StoredToken, sources: Map<string, LaunchSourceView & { validated: boolean }>, trackedCount: number): LaunchRow {
    const m = t.market
    const parent = t.parent ?? parentOf(t.token)
    const src = parent ? sources.get(parent) : undefined
    const source: LaunchSourceView = src?.validated ? { id: src.id, name: src.name, kind: src.kind, launches: src.launches } : { id: null, name: null, kind: 'direct', launches: 0 }
    return {
      token: t.token,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      createdAt: t.createdAt,
      createdHeight: t.createdHeight,
      firstSeenAt: t.firstSeenAt,
      dev: t.dev,
      source,
      venue: venueOf(m?.mainPool ?? null),
      mainPool: m?.mainPool ?? null,
      mainPoolUrl: m?.mainPoolUrl ?? null,
      priceUsd: m?.priceUsd ?? null,
      // Intear reports changes as fractions (0.117 = +11.7%); the API carries percent.
      priceChange5m: pct(m?.priceChange5m),
      priceChange1h: pct(m?.priceChange1h),
      priceChange6h: pct(m?.priceChange6h),
      priceChange24h: pct(m?.priceChange24h),
      volume1h: m?.volumeUsd1h ?? null,
      volume6h: m?.volumeUsd6h ?? null,
      volume24h: m?.volumeUsd24h ?? null,
      liquidityUsd: m?.liquidityUsd ?? null,
      marketCapUsd: m?.marketCapUsd ?? null,
      buys24h: m?.buys24h ?? null,
      sells24h: m?.sells24h ?? null,
      traders24h: m?.traders24h ?? null,
      holders: m?.holders ?? null,
      reputation: m?.reputation ?? null,
      top10Share: t.holders?.top10Share ?? null,
      devShare: t.holders?.devShare ?? null,
      holdersAt: t.holdersAt,
      tracked: trackedCount,
      marketAt: t.marketAt,
    }
  }

  async function trackedCounts(since: number, tokens?: string): Promise<Map<string, number>> {
    const { set } = await tracked()
    const rows = await deps.store.launchTrades(net, { ...(tokens ? { token: tokens } : {}), traders: [...set], since, limit: 50_000 })
    const per = new Map<string, Set<string>>()
    for (const r of rows) per.set(r.token, (per.get(r.token) ?? new Set()).add(r.trader))
    return new Map([...per].map(([k, v]) => [k, v.size]))
  }

  return {
    status,

    launches: (period) =>
      cached(`launches:${period}`, LAUNCHES_TTL, async () => {
        const t = now()
        const since = t - PERIOD_MS[period]
        const [tokens, sources, counts, tr] = await Promise.all([deps.store.launches(net, since), sourceViews(), trackedCounts(since), tracked()])
        const launches = tokens.map((x) => launchRow(x, sources, counts.get(x.token) ?? 0))
        const used = new Map<string, LaunchSourceView>()
        for (const l of launches) {
          const key = l.source.id ?? 'direct'
          const prev = used.get(key)
          used.set(key, { ...l.source, launches: (prev?.launches ?? 0) + 1 })
        }
        const s = status()
        return {
          period,
          asOf: t,
          marketAt: s.launchesAt,
          stale: s.launchesAt === null || t - s.launchesAt > MARKET_STALE_MS,
          launches,
          sources: [...used.values()].sort((a, b) => b.launches - a.launches),
          trackedWallets: tr.set.size,
          index: s,
        }
      }),

    async extras(tokens) {
      const ids = [...new Set(tokens)].slice(0, 60)
      const t = now()
      const fresh =
        <T>(m: Map<string, { at: number; v: T }>, ttl: number) =>
        (id: string) => {
          const e = m.get(id)
          return e !== undefined && t - e.at < ttl
        }
      // What isn't cached is read in one request each (24 hourly closes; the thumbnails).
      const needSpark = ids.filter((id) => !fresh(sparks, SPARK_TTL)(id))
      if (needSpark.length) {
        const closes = await deps.intear.closes(needSpark, '60', 24).catch(() => null)
        if (closes)
          for (const id of needSpark) {
            const c = closes.get(id)?.close.filter((v): v is number => v !== null) ?? []
            remember(sparks, id, { at: t, v: c.length >= 2 ? c : null })
          }
      }
      const needThumb = ids.filter((id) => !fresh(thumbs, THUMB_TTL)(id))
      if (needThumb.length) {
        const got = await deps.intear.thumbnails(needThumb).catch(() => null)
        if (got) for (const id of needThumb) remember(thumbs, id, { at: t, v: got.get(id) ?? null })
      }
      const out: LaunchExtras = {}
      for (const id of ids) out[id] = { spark: sparks.get(id)?.v ?? null, thumb: thumbs.get(id)?.v ?? null }
      return out
    },

    launch: (token) =>
      cached(`launch:${token}`, DETAIL_TTL, async () => {
        let t = await deps.store.token(net, token)
        if (!t) {
          const m = await meta([token])
          t = m.get(token) ?? null
        }
        if (!t) return null
        const sources = await sourceViews()
        // Holders: the indexer's snapshot when recent; otherwise read now (one request).
        if ((t.holdersAt === null || now() - t.holdersAt > HOLDERS_FRESH_MS) && (t.market?.liquidityUsd ?? 0) > 0) {
          try {
            const h = await deps.intear.holders(token, 25)
            await deps.store.setHolders(
              net,
              token,
              concentration(h.rows, t.market?.totalSupply ?? null, { token, parent: parentOf(token), dev: t.dev, total: h.total, listed: 25 }),
            )
            t = (await deps.store.token(net, token)) ?? t
          } catch (e) {
            deps.log.warn('discovery: holders not read', { token, error: e instanceof Error ? e.message : String(e) })
          }
        }
        const created = t.createdAt ?? now() - 7 * 86_400_000
        const [candles, trades, counts, tr] = await Promise.all([
          cached(`candles:${token}`, CANDLES_TTL, () => deps.intear.candles(token, '60', 168)).catch(() => null),
          cached(`trades:${token}`, DETAIL_TTL, async () => ({ at: now(), rows: (await deps.intear.trades({ token, order: 'newest', limit: 50 })).rows })).catch(() => null),
          trackedCounts(created, token),
          tracked(),
        ])
        const evidence = await deps.store.launchTrades(net, { token, since: created, limit: 5_000 })
        const byTrader = new Map<string, SignalView>()
        for (const r of evidence) {
          if (!tr.set.has(r.trader)) continue
          const a = tr.byTrader.get(r.trader)
          const v = byTrader.get(r.trader) ?? {
            trader: r.trader,
            qualified: a?.qualified ?? false,
            smart: a?.categories.includes('smart') ?? false,
            stats30d: statsOf(a),
            trades: [],
          }
          v.trades.push({ side: r.side, usd: r.usd, ts: r.ts, tx: r.tx })
          byTrader.set(r.trader, v)
        }
        return {
          launch: launchRow(t, sources, counts.get(token) ?? 0),
          holders: t.holders && t.holdersAt !== null ? { total: t.holders.total, top: t.holders.top, excluded: t.holders.excluded, at: t.holdersAt } : null,
          candles,
          trades: trades ? await tradeViews(trades.rows, token) : [],
          tradesAt: trades?.at ?? null,
          signals: [...byTrader.values()].sort((a, b) => (b.stats30d?.realized ?? 0) - (a.stats30d?.realized ?? 0)),
          index: status(),
        }
      }),

    candles: (token, interval) => {
      const r = CANDLE_READ[interval]
      return cached(`candles:${token}:${interval}`, r.ttl, async () => {
        const c = await deps.intear.candles(token, r.resolution, r.countBack)
        return c ? { token, interval, intervalSec: CANDLE_INTERVAL_SEC[interval], candles: c, at: now() } : null
      })
    },

    async wallets(q) {
      const rows = await assessed(q.window)
      const search = q.search?.trim().toLowerCase()
      const pool = search ? rows.filter((r) => r.trader.toLowerCase().includes(search)) : rows
      const ranked = rank(pool, { metric: q.metric, category: q.category, limit: q.limit })
      const traders = ranked.map((r) => r.trader)
      const [metaW, top] = await Promise.all([deps.store.wallets(net, traders), deps.store.topTokens(net, traders, 3)])
      const tokenIds = [...top.values()].flatMap((l) => l.map((x) => x.token)).concat([...metaW.values()].map((w) => w.lastToken).filter((x): x is string => Boolean(x)))
      const m = await meta(tokenIds)
      const s = status()
      return {
        window: q.window,
        metric: q.metric,
        category: q.category,
        asOf: now(),
        coverage: windowCoverage(q.window, { now: now(), indexStart: s.indexStart }),
        rows: ranked.map((a, i) => {
          const w = metaW.get(a.trader)
          return {
            ...rowOf(a),
            rank: i + 1,
            last:
              w && w.lastToken && w.lastTx && (w.lastSide === 'buy' || w.lastSide === 'sell')
                ? { side: w.lastSide, token: w.lastToken, symbol: m.get(w.lastToken)?.symbol ?? null, usd: w.lastUsd, tx: w.lastTx, ts: w.lastTs }
                : null,
            topTokens: (top.get(a.trader) ?? []).map((x) => ({ token: x.token, symbol: m.get(x.token)?.symbol ?? null })),
          }
        }),
        counts: { wallets: rows.length, qualified: rows.filter((r) => r.qualified).length },
        freshAvailable: now() - s.indexStart >= 28 * 86_400_000,
        index: s,
      }
    },

    wallet: (account) =>
      cached(`wallet:${account}`, DETAIL_TTL, async () => {
        const [days, tokens, metaW] = await Promise.all([deps.store.walletDays(net, account), deps.store.walletTokens(net, account), deps.store.wallets(net, [account])])
        const w = metaW.get(account)
        if (!w && days.length === 0) return null
        const windows = {} as WalletDetail['windows']
        let automated = false
        let smart = false
        for (const k of ['7d', '30d', '90d', 'all'] as const) {
          const a = (await assessed(k)).find((r) => r.trader === account)
          windows[k] = a ? rowOf(a) : null
          if (a?.automated) automated = true
          if (a?.categories.includes('smart')) smart = true
        }
        let run = 0
        const series = days.map((d) => {
          run += d.realized
          return { day: d.day, realized: d.realized, cumulative: run, closed: d.closed, wins: d.wins, legs: d.legs }
        })
        const m = await meta(tokens.map((t) => t.token))
        let unrealized = 0
        let priced = 0
        let unknown = 0
        const views = tokens.map((t) => {
          const info = m.get(t.token)
          const open = t.qty > 0 || t.unknownQty > 0
          const price = info?.market?.priceUsd ?? null
          const value = open && price !== null && info?.decimals !== null && info?.decimals !== undefined ? (t.qty / 10 ** info.decimals) * price : null
          const u = value === null ? null : value - t.cost
          if (open) {
            if (u === null) unknown += 1
            else {
              unrealized += u
              priced += 1
            }
          }
          return {
            token: t.token,
            symbol: info?.symbol ?? null,
            realized: t.realized,
            closed: t.closed,
            wins: t.wins,
            buys: t.buys,
            sells: t.sells,
            buyUsd: t.buyUsd,
            sellUsd: t.sellUsd,
            open,
            cost: t.cost,
            valueUsd: value,
            unrealized: u,
            unknownCost: t.unknownQty > 0,
            avgHoldMs: t.holds > 0 ? t.holdMs / t.holds : null,
            firstBuyAt: t.firstBuyAt,
            lastAt: t.lastAt,
          }
        })
        const holds = tokens.reduce((s, t) => s + t.holds, 0)
        const trades = await cached(`wtrades:${account}`, DETAIL_TTL, async () => (await deps.intear.trades({ trader: account, order: 'newest', limit: 100 })).rows).catch(() => [])
        return {
          trader: account,
          windows,
          days: series,
          maxDrawdown: maxDrawdown(series.map((d) => d.cumulative)),
          tokens: views,
          unrealized: { value: priced > 0 ? unrealized : null, positions: priced, unknown },
          holding: { avgMs: holds > 0 ? tokens.reduce((s, t) => s + t.holdMs, 0) / holds : null, closedPositions: holds },
          trades: await tradeViews(trades),
          firstTs: w?.firstTs ?? null,
          lastTs: w?.lastTs ?? null,
          automated,
          smart,
          index: status(),
        }
      }),

    async walletTrades(account, cursor) {
      const page = await deps.intear.trades({ trader: account, order: 'newest', limit: 200, cursor })
      return { trades: await tradeViews(page.rows), nextCursor: page.nextCursor }
    },

    async signals(wallets, since) {
      const list = [...new Set(wallets)].slice(0, 50)
      return (await deps.store.launchTrades(net, { traders: list, since: Math.max(since, now() - 8 * 86_400_000), limit: 5_000 })).map((r) => ({
        token: r.token,
        trader: r.trader,
        side: r.side,
        usd: r.usd,
        ts: r.ts,
        tx: r.tx,
      }))
    },
  }
}
