import type { RawTrade } from './accounting'

/**
 * Intear's public API (https://api.intea.rs, docs.intear.tech): free, keyless, no published rate
 * limit or terms. NEARKITS reads it from its server only, one request at a time with a little space
 * between them, and caches what it reads (DISCOVERY.md). Responses are column/row tables; this client
 * turns them into typed records and never invents a missing figure (null stays null).
 */

export class IntearError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IntearError'
  }
  get rateLimited(): boolean {
    return this.status === 429
  }
}

/** A token as Launch Radar lists it. */
export interface LaunchToken {
  token: string
  symbol: string | null
  name: string | null
  decimals: number | null
  /** The block and time Intear first saw the token (its creation, for tokens created since 2026-08-05). */
  createdHeight: number | null
  createdAt: number | null
  /** The account Intear saw deploy it. */
  dev: string | null
  holders: number | null
  liquidityUsd: number | null
  priceUsd: number | null
  marketCapUsd: number | null
  priceChange5m: number | null
  priceChange1h: number | null
  priceChange6h: number | null
  priceChange24h: number | null
  volumeUsd1h: number | null
  volumeUsd6h: number | null
  volumeUsd24h: number | null
  buys1h: number | null
  sells1h: number | null
  buys24h: number | null
  sells24h: number | null
  traders24h: number | null
  mainPool: string | null
  mainPoolUrl: string | null
  reputation: 'Spam' | 'Unknown' | 'NotFake' | 'Reputable' | null
  totalSupply: string | null
  iconHash: string | null
}

export const LAUNCH_FIELDS = [
  'symbol',
  'name',
  'decimals',
  'created_at',
  'created_at_millis',
  'dev',
  'holders',
  'liquidity_usd',
  'price_usd',
  'market_cap_usd',
  'price_change_5m',
  'price_change_1h',
  'price_change_6h',
  'price_change_24h',
  'volume_usd_1h',
  'volume_usd_6h',
  'volume_usd_24h',
  'buys_1h',
  'sells_1h',
  'buys_24h',
  'sells_24h',
  'traders_24h',
  'main_pool',
  'main_pool_url',
  'reputation',
  'total_supply',
  'icon_hash',
] as const

const TRADE_FIELDS = ['height', 'timestamp_millis', 'trader', 'pool_id', 'token_in', 'amount_in', 'token_out', 'amount_out', 'usd_value', 'transaction_id'] as const

export interface Closes {
  time: number[]
  close: (number | null)[]
}

export interface Intear {
  /** Tokens created after `createdAfter`, newest first, with their market fields. */
  launches(q: { createdAfter: number; limit: number }): Promise<{ height: number; at: number; tokens: LaunchToken[] }>
  /** Given tokens' fields (up to 2,000 ids). */
  tokens(ids: readonly string[]): Promise<LaunchToken[]>
  /** Small token pictures (Intear's thumbnails of the tokens' own metadata icons). */
  thumbnails(ids: readonly string[]): Promise<Map<string, string>>
  /** One page of swaps. */
  trades(q: { afterMillis?: number; beforeMillis?: number; cursor?: string | null; order: 'oldest' | 'newest'; limit: number; trader?: string; token?: string }): Promise<{
    height: number
    at: number
    rows: RawTrade[]
    nextCursor: string | null
  }>
  holders(token: string, limit: number): Promise<{ total: number | null; rows: { account: string; balance: string }[] }>
  /** Closing prices in USD per token, oldest first. */
  closes(tokens: readonly string[], resolution: '1' | '5' | '15' | '60' | '240' | 'D', countBack: number): Promise<Map<string, Closes>>
  /** OHLCV candles in USD for one token, oldest first. */
  candles(
    token: string,
    resolution: '1' | '5' | '15' | '60' | '240' | 'D',
    countBack: number,
  ): Promise<{ time: number[]; open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] } | null>
}

type Table = { height: number; timestamp_millis: number; columns: string[]; rows: unknown[][]; next_cursor?: string | null; total?: number }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const REPUTATIONS = new Set(['Spam', 'Unknown', 'NotFake', 'Reputable'])

function records(t: Table): Record<string, unknown>[] {
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])))
}

function toLaunch(r: Record<string, unknown>): LaunchToken {
  const rep = str(r.reputation)
  return {
    token: String(r.account_id),
    symbol: str(r.symbol),
    name: str(r.name),
    decimals: num(r.decimals),
    createdHeight: num(r.created_at),
    createdAt: num(r.created_at_millis) || null,
    dev: str(r.dev),
    holders: num(r.holders),
    liquidityUsd: num(r.liquidity_usd),
    priceUsd: num(r.price_usd),
    marketCapUsd: num(r.market_cap_usd),
    priceChange5m: num(r.price_change_5m),
    priceChange1h: num(r.price_change_1h),
    priceChange6h: num(r.price_change_6h),
    priceChange24h: num(r.price_change_24h),
    volumeUsd1h: num(r.volume_usd_1h),
    volumeUsd6h: num(r.volume_usd_6h),
    volumeUsd24h: num(r.volume_usd_24h),
    buys1h: num(r.buys_1h),
    sells1h: num(r.sells_1h),
    buys24h: num(r.buys_24h),
    sells24h: num(r.sells_24h),
    traders24h: num(r.traders_24h),
    mainPool: str(r.main_pool),
    mainPoolUrl: str(r.main_pool_url),
    reputation: rep && REPUTATIONS.has(rep) ? (rep as LaunchToken['reputation']) : null,
    totalSupply: str(r.total_supply),
    iconHash: str(r.icon_hash),
  }
}

function toTrade(r: Record<string, unknown>): RawTrade {
  return {
    id: Number(r.id),
    ts: Number(r.timestamp_millis),
    height: Number(r.height),
    trader: String(r.trader),
    poolId: String(r.pool_id ?? ''),
    tokenIn: str(r.token_in),
    amountIn: str(r.amount_in),
    tokenOut: str(r.token_out),
    amountOut: str(r.amount_out),
    usd: num(r.usd_value),
    tx: String(r.transaction_id ?? ''),
  }
}

export function createIntear(deps: { baseUrl: string; fetch: typeof fetch; timeoutMs?: number; spacingMs?: number }): Intear {
  const timeoutMs = deps.timeoutMs ?? 20_000
  const spacingMs = deps.spacingMs ?? 250
  // One request in flight, with a little space after each: Intear publishes no rate limit, so be gentle.
  let queue: Promise<unknown> = Promise.resolve()
  const get = <T>(path: string, params: Record<string, string | number | undefined | null>): Promise<T> => {
    const run = async (): Promise<T> => {
      const url = new URL(path, deps.baseUrl)
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
      let res: Response
      try {
        res = await deps.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        throw new IntearError(0, 'unreachable', e instanceof Error ? e.message : 'Intear did not answer')
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
      if (!res.ok || !body || body.error) {
        throw new IntearError(
          res.ok ? 502 : res.status,
          body?.error?.code ?? (res.status === 429 ? 'rate_limited' : 'error'),
          body?.error?.message ?? `Intear answered ${res.status}`,
        )
      }
      if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs))
      return body as T
    }
    const p = queue.then(run, run)
    queue = p.catch(() => undefined)
    return p
  }
  return {
    async launches(q) {
      const t = await get<Table>('/tokens', { fields: LAUNCH_FIELDS.join(','), sort: '-created_at_millis', limit: q.limit, created_after_millis: q.createdAfter })
      return { height: t.height, at: t.timestamp_millis, tokens: records(t).map(toLaunch) }
    },
    async tokens(ids) {
      if (ids.length === 0) return []
      const t = await get<Table>('/tokens', { fields: LAUNCH_FIELDS.join(','), ids: ids.join(',') })
      return records(t).map(toLaunch)
    },
    async thumbnails(ids) {
      const out = new Map<string, string>()
      if (ids.length === 0) return out
      const t = await get<Table>('/tokens', { fields: 'thumbnail', ids: ids.join(',') })
      for (const r of records(t)) {
        const thumb = str(r.thumbnail)
        if (thumb && thumb.startsWith('data:image/') && thumb.length <= 4_000) out.set(String(r.account_id), thumb)
      }
      return out
    },
    async trades(q) {
      const t = await get<Table>('/trades', {
        fields: TRADE_FIELDS.join(','),
        order: q.order,
        limit: q.limit,
        cursor: q.cursor ?? undefined,
        after_millis: q.afterMillis,
        before_millis: q.beforeMillis,
        trader: q.trader,
        token: q.token,
      })
      return { height: t.height, at: t.timestamp_millis, rows: records(t).map(toTrade), nextCursor: t.next_cursor ?? null }
    },
    async holders(token, limit) {
      const t = await get<Table>('/holders', { token, limit })
      return { total: num(t.total), rows: t.rows.map((r) => ({ account: String(r[0]), balance: String(r[1]) })) }
    },
    async closes(tokens, resolution, countBack) {
      const out = new Map<string, Closes>()
      if (tokens.length === 0) return out
      const t = await get<{ tokens: Record<string, { time: number[]; usd?: { close?: (number | null)[] } }> }>('/candles', {
        tokens: tokens.join(','),
        resolution,
        count_back: countBack,
        series: 'close',
      })
      for (const [id, c] of Object.entries(t.tokens ?? {})) out.set(id, { time: c.time ?? [], close: (c.usd?.close ?? []).map((v) => num(v)) })
      return out
    },
    async candles(token, resolution, countBack) {
      const t = await get<{ tokens: Record<string, { time: number[]; usd?: Record<string, (number | null)[]> }> }>('/candles', { tokens: token, resolution, count_back: countBack })
      const c = t.tokens?.[token]
      if (!c) return null
      const s = (k: string) => (c.usd?.[k] ?? []).map((v) => num(v))
      return { time: c.time ?? [], open: s('open'), high: s('high'), low: s('low'), close: s('close'), volume: s('volume') }
    },
  }
}
