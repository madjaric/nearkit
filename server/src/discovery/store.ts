import type { Database, SqlValue } from '../db/database'
import { applyAction, dayOf, emptyPosition, type Effect, type Position, type TokenAction } from './accounting'
import type { LaunchToken } from './intear'
import { EARLY_MS, type WalletWindow } from './ranking'

/**
 * Launch Radar's and Top Wallets' tables (migration v20 / PG v11, DISCOVERY.md). The indexer writes;
 * the routes read. A page of swaps is applied in one transaction together with the cursor that names
 * it, so a restart never applies a page twice.
 */

/** Holder concentration as last read (holders.ts). */
export interface HolderSnapshot {
  total: number | null
  /** Share of supply (0-1) of the ten largest holders, infrastructure accounts left out. */
  top10Share: number | null
  devShare: number | null
  excluded: string[]
  top: { account: string; share: number }[]
}

export interface StoredToken {
  token: string
  symbol: string | null
  name: string | null
  decimals: number | null
  createdHeight: number | null
  createdAt: number | null
  dev: string | null
  parent: string | null
  firstSeenAt: number
  market: LaunchToken | null
  marketAt: number | null
  holders: HolderSnapshot | null
  holdersAt: number | null
}

export interface Source {
  parent: string
  hasContract: boolean | null
  launches: number
  checkedAt: number | null
}

export interface LaunchTrade {
  token: string
  trader: string
  side: 'buy' | 'sell'
  qty: number
  usd: number | null
  ts: number
  tx: string
}

export interface WalletMeta {
  trader: string
  firstTs: number
  lastTs: number
  legs: number
  lastSide: string | null
  lastToken: string | null
  lastUsd: number | null
  lastTx: string | null
}

export interface WalletToken extends Position {
  token: string
  lastSellAt: number | null
  earlyBuyAt: number | null
}

export interface WalletDay {
  day: number
  realized: number
  costClosed: number
  closed: number
  wins: number
  gains: number
  losses: number
  buyUsd: number
  sellUsd: number
  unmatchedUsd: number
  unpriced: number
  legs: number
}

/** The parent account of a NEAR account (`a.b.near` → `b.near`); null for a top-level or implicit account. */
export function parentOf(account: string): string | null {
  const i = account.indexOf('.')
  if (i < 0) return null
  const parent = account.slice(i + 1)
  return parent.includes('.') ? parent : null
}

const n = (v: unknown): number => Number(v ?? 0)
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const json = <T>(v: unknown): T | null => {
  if (typeof v !== 'string' || v === '') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/** Rows per multi-row statement. */
const BATCH = 100

async function insertMany(db: Database, head: string, cols: number, rows: SqlValue[][], tail: string): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values = chunk.map(() => `(${Array.from({ length: cols }, () => '?').join(', ')})`).join(', ')
    await db.run(`${head} VALUES ${values} ${tail}`, chunk.flat())
  }
}

type TokenRow = Record<string, unknown>
const toStored = (r: TokenRow): StoredToken => ({
  token: String(r.token),
  symbol: (r.symbol as string | null) ?? null,
  name: (r.name as string | null) ?? null,
  decimals: nn(r.decimals),
  createdHeight: nn(r.created_height),
  createdAt: nn(r.created_at),
  dev: (r.dev as string | null) ?? null,
  parent: (r.parent as string | null) ?? null,
  firstSeenAt: n(r.first_seen_at),
  market: json<LaunchToken>(r.market),
  marketAt: nn(r.market_at),
  holders: json<HolderSnapshot>(r.holders),
  holdersAt: nn(r.holders_at),
})

const toWalletToken = (r: Record<string, unknown>): WalletToken => ({
  token: String(r.token),
  qty: n(r.qty),
  cost: n(r.cost),
  unknownQty: n(r.unknown_qty),
  openSince: nn(r.open_since),
  realized: n(r.realized),
  closed: n(r.closed),
  wins: n(r.wins),
  holdMs: n(r.hold_ms),
  holds: n(r.holds),
  buys: n(r.buys),
  sells: n(r.sells),
  buyUsd: n(r.buy_usd),
  sellUsd: n(r.sell_usd),
  firstBuyAt: nn(r.first_buy_at),
  lastAt: nn(r.last_at),
  lastSellAt: nn(r.last_sell_at),
  earlyBuyAt: nn(r.early_buy_at),
})

export class DiscoveryStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── tokens and launches ───────────────────────────────────────────────────

  /** Records tokens (each first seen once) with their latest market figures; returns how many were new. */
  async upsertTokens(network: string, tokens: readonly LaunchToken[]): Promise<number> {
    if (tokens.length === 0) return 0
    const t = this.now()
    const known = new Set(
      (
        await this.db.all<{ token: string }>(`SELECT token FROM disc_tokens WHERE network = ? AND token IN (${tokens.map(() => '?').join(', ')})`, [
          network,
          ...tokens.map((x) => x.token),
        ])
      ).map((r) => r.token),
    )
    await insertMany(
      this.db,
      'INSERT INTO disc_tokens (network, token, symbol, name, decimals, created_height, created_at, dev, parent, first_seen_at, market, market_at)',
      12,
      tokens.map((x) => [
        network,
        x.token,
        x.symbol ?? null,
        x.name ?? null,
        x.decimals ?? null,
        x.createdHeight ?? null,
        x.createdAt ?? null,
        x.dev ?? null,
        parentOf(x.token),
        t,
        JSON.stringify(x),
        t,
      ]),
      `ON CONFLICT (network, token) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
         created_height = COALESCE(disc_tokens.created_height, excluded.created_height), created_at = COALESCE(disc_tokens.created_at, excluded.created_at),
         dev = COALESCE(disc_tokens.dev, excluded.dev), market = excluded.market, market_at = excluded.market_at`,
    )
    return tokens.filter((x) => !known.has(x.token)).length
  }

  /** Tokens created at or after `since` (launches), newest first. */
  async launches(network: string, since: number, limit = 5000): Promise<StoredToken[]> {
    return (await this.db.all<TokenRow>('SELECT * FROM disc_tokens WHERE network = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?', [network, since, limit])).map(toStored)
  }

  async token(network: string, token: string): Promise<StoredToken | null> {
    const r = await this.db.get<TokenRow>('SELECT * FROM disc_tokens WHERE network = ? AND token = ?', [network, token])
    return r ? toStored(r) : null
  }

  async tokens(network: string, ids: readonly string[]): Promise<Map<string, StoredToken>> {
    const out = new Map<string, StoredToken>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      if (chunk.length === 0) continue
      for (const r of await this.db.all<TokenRow>(`SELECT * FROM disc_tokens WHERE network = ? AND token IN (${chunk.map(() => '?').join(', ')})`, [network, ...chunk]))
        out.set(String(r.token), toStored(r))
    }
    return out
  }

  /** Creation times of tokens created at or after `since` (the indexer's launch set). */
  async createdSince(network: string, since: number): Promise<Map<string, number>> {
    const rows = await this.db.all<{ token: string; created_at: number }>('SELECT token, created_at FROM disc_tokens WHERE network = ? AND created_at >= ?', [network, since])
    return new Map(rows.map((r) => [r.token, Number(r.created_at)]))
  }

  async setHolders(network: string, token: string, h: HolderSnapshot): Promise<void> {
    await this.db.run('UPDATE disc_tokens SET holders = ?, holders_at = ? WHERE network = ? AND token = ?', [JSON.stringify(h), this.now(), network, token])
  }

  // ─── launch sources ────────────────────────────────────────────────────────

  async sources(network: string): Promise<Source[]> {
    return (await this.db.all<Record<string, unknown>>('SELECT * FROM disc_sources WHERE network = ? ORDER BY launches DESC', [network])).map((r) => ({
      parent: String(r.parent),
      hasContract: r.has_contract === null || r.has_contract === undefined ? null : Number(r.has_contract) === 1,
      launches: n(r.launches),
      checkedAt: nn(r.checked_at),
    }))
  }

  /** Counts every parent account's tokens again (from the recorded tokens). */
  async countSources(network: string): Promise<void> {
    const counts = await this.db.all<{ parent: string; c: number }>('SELECT parent, COUNT(*) AS c FROM disc_tokens WHERE network = ? AND parent IS NOT NULL GROUP BY parent', [
      network,
    ])
    await insertMany(
      this.db,
      'INSERT INTO disc_sources (network, parent, launches)',
      3,
      counts.map((c) => [network, c.parent, Number(c.c)]),
      'ON CONFLICT (network, parent) DO UPDATE SET launches = excluded.launches',
    )
  }

  async setSourceContract(network: string, parent: string, hasContract: boolean): Promise<void> {
    await this.db.run('UPDATE disc_sources SET has_contract = ?, checked_at = ? WHERE network = ? AND parent = ?', [hasContract ? 1 : 0, this.now(), network, parent])
  }

  // ─── swaps ─────────────────────────────────────────────────────────────────

  /**
   * One page of token actions, applied in order, with the cursor that names the page (meta), in one
   * transaction. `launches`: creation times of tokens launched recently (early buys, launch trades).
   * Returns the actions applied (for alerts).
   */
  async applyPage(network: string, actions: readonly TokenAction[], ctx: { launches: ReadonlyMap<string, number>; cursorKey: string; cursor: string }): Promise<void> {
    await this.db.tx(async () => {
      const traders = [...new Set(actions.map((a) => a.trader))]
      const positions = new Map<string, WalletToken>()
      for (let i = 0; i < traders.length; i += 200) {
        const chunk = traders.slice(i, i + 200)
        if (chunk.length === 0) continue
        const tokens = new Set(actions.filter((a) => chunk.includes(a.trader)).map((a) => a.token))
        const rows = await this.db.all<Record<string, unknown>>(
          `SELECT * FROM disc_wallet_tokens WHERE network = ? AND trader IN (${chunk.map(() => '?').join(', ')}) AND token IN (${[...tokens].map(() => '?').join(', ')})`,
          [network, ...chunk, ...tokens],
        )
        for (const r of rows) positions.set(`${String(r.trader)}\u0000${String(r.token)}`, toWalletToken(r))
      }
      const days = new Map<string, WalletDay & { trader: string }>()
      const wallets = new Map<string, WalletMeta>()
      const launchRows: SqlValue[][] = []
      const touched = new Set<string>()
      for (const a of actions) {
        const key = `${a.trader}\u0000${a.token}`
        const before = positions.get(key) ?? { ...emptyPosition(), token: a.token, lastSellAt: null, earlyBuyAt: null }
        const { position, effect } = applyAction(before, a)
        const created = ctx.launches.get(a.token)
        const early = a.side === 'buy' && before.earlyBuyAt === null && created !== undefined && a.ts >= created && a.ts - created <= EARLY_MS
        positions.set(key, { ...position, token: a.token, lastSellAt: a.side === 'sell' ? a.ts : before.lastSellAt, earlyBuyAt: early ? a.ts : before.earlyBuyAt })
        touched.add(key)
        this.addDay(days, a, effect)
        const w = wallets.get(a.trader)
        if (!w) wallets.set(a.trader, { trader: a.trader, firstTs: a.ts, lastTs: a.ts, legs: 1, lastSide: a.side, lastToken: a.token, lastUsd: a.usd, lastTx: a.tx })
        else {
          w.firstTs = Math.min(w.firstTs, a.ts)
          w.legs += 1
          if (a.ts >= w.lastTs) Object.assign(w, { lastTs: a.ts, lastSide: a.side, lastToken: a.token, lastUsd: a.usd, lastTx: a.tx })
        }
        if (created !== undefined) launchRows.push([network, a.token, a.trader, a.side, a.qty, a.usd, a.ts, a.tx])
      }
      await insertMany(
        this.db,
        'INSERT INTO disc_wallet_tokens (network, trader, token, qty, cost, unknown_qty, open_since, realized, closed, wins, hold_ms, holds, buys, sells, buy_usd, sell_usd, first_buy_at, last_at, last_sell_at, early_buy_at)',
        20,
        [...touched].map((key) => {
          const [trader] = key.split('\u0000')
          const p = positions.get(key) as WalletToken
          return [
            network,
            trader as string,
            p.token,
            p.qty,
            p.cost,
            p.unknownQty,
            p.openSince,
            p.realized,
            p.closed,
            p.wins,
            p.holdMs,
            p.holds,
            p.buys,
            p.sells,
            p.buyUsd,
            p.sellUsd,
            p.firstBuyAt,
            p.lastAt,
            p.lastSellAt,
            p.earlyBuyAt,
          ]
        }),
        `ON CONFLICT (network, trader, token) DO UPDATE SET qty = excluded.qty, cost = excluded.cost, unknown_qty = excluded.unknown_qty,
           open_since = excluded.open_since, realized = excluded.realized, closed = excluded.closed, wins = excluded.wins, hold_ms = excluded.hold_ms,
           holds = excluded.holds, buys = excluded.buys, sells = excluded.sells, buy_usd = excluded.buy_usd, sell_usd = excluded.sell_usd,
           first_buy_at = excluded.first_buy_at, last_at = excluded.last_at, last_sell_at = excluded.last_sell_at, early_buy_at = excluded.early_buy_at`,
      )
      await insertMany(
        this.db,
        'INSERT INTO disc_wallet_days (network, trader, day, realized, cost_closed, closed, wins, gains, losses, buy_usd, sell_usd, unmatched_usd, unpriced, legs)',
        14,
        [...days.values()].map((d) => [
          network,
          d.trader,
          d.day,
          d.realized,
          d.costClosed,
          d.closed,
          d.wins,
          d.gains,
          d.losses,
          d.buyUsd,
          d.sellUsd,
          d.unmatchedUsd,
          d.unpriced,
          d.legs,
        ]),
        `ON CONFLICT (network, trader, day) DO UPDATE SET realized = disc_wallet_days.realized + excluded.realized,
           cost_closed = disc_wallet_days.cost_closed + excluded.cost_closed, closed = disc_wallet_days.closed + excluded.closed,
           wins = disc_wallet_days.wins + excluded.wins, gains = disc_wallet_days.gains + excluded.gains, losses = disc_wallet_days.losses + excluded.losses,
           buy_usd = disc_wallet_days.buy_usd + excluded.buy_usd, sell_usd = disc_wallet_days.sell_usd + excluded.sell_usd,
           unmatched_usd = disc_wallet_days.unmatched_usd + excluded.unmatched_usd, unpriced = disc_wallet_days.unpriced + excluded.unpriced,
           legs = disc_wallet_days.legs + excluded.legs`,
      )
      await insertMany(
        this.db,
        'INSERT INTO disc_wallets (network, trader, first_ts, last_ts, legs, last_side, last_token, last_usd, last_tx)',
        9,
        [...wallets.values()].map((w) => [network, w.trader, w.firstTs, w.lastTs, w.legs, w.lastSide, w.lastToken, w.lastUsd, w.lastTx]),
        `ON CONFLICT (network, trader) DO UPDATE SET
           first_ts = CASE WHEN excluded.first_ts < disc_wallets.first_ts THEN excluded.first_ts ELSE disc_wallets.first_ts END,
           legs = disc_wallets.legs + excluded.legs,
           last_side = CASE WHEN excluded.last_ts >= disc_wallets.last_ts THEN excluded.last_side ELSE disc_wallets.last_side END,
           last_token = CASE WHEN excluded.last_ts >= disc_wallets.last_ts THEN excluded.last_token ELSE disc_wallets.last_token END,
           last_usd = CASE WHEN excluded.last_ts >= disc_wallets.last_ts THEN excluded.last_usd ELSE disc_wallets.last_usd END,
           last_tx = CASE WHEN excluded.last_ts >= disc_wallets.last_ts THEN excluded.last_tx ELSE disc_wallets.last_tx END,
           last_ts = CASE WHEN excluded.last_ts > disc_wallets.last_ts THEN excluded.last_ts ELSE disc_wallets.last_ts END`,
      )
      await insertMany(
        this.db,
        'INSERT INTO disc_launch_trades (network, token, trader, side, qty, usd, ts, tx)',
        8,
        launchRows,
        'ON CONFLICT (network, tx, trader, token, side) DO NOTHING',
      )
      await this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [ctx.cursorKey, ctx.cursor])
    })
  }

  private addDay(days: Map<string, WalletDay & { trader: string }>, a: TokenAction, e: Effect): void {
    const day = dayOf(a.ts)
    const key = `${a.trader}\u0000${day}`
    const d = days.get(key) ?? {
      trader: a.trader,
      day,
      realized: 0,
      costClosed: 0,
      closed: 0,
      wins: 0,
      gains: 0,
      losses: 0,
      buyUsd: 0,
      sellUsd: 0,
      unmatchedUsd: 0,
      unpriced: 0,
      legs: 0,
    }
    d.realized += e.realized
    d.costClosed += e.costClosed
    d.closed += e.closed
    d.wins += e.win
    d.gains += e.gain
    d.losses += e.loss
    d.buyUsd += e.buyUsd
    d.sellUsd += e.sellUsd
    d.unmatchedUsd += e.unmatchedUsd
    d.unpriced += e.unpriced
    d.legs += 1
    days.set(key, d)
  }

  async getMeta(key: string): Promise<string | null> {
    return (await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  // ─── rankings ──────────────────────────────────────────────────────────────

  /**
   * Every wallet's window figures from `fromDay` (inclusive), for wallets with a closed trade or at
   * least `minVolume` traded in the window.
   */
  async windowRows(network: string, fromDay: number, fromTs: number, minVolume: number): Promise<WalletWindow[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT d.trader AS trader, SUM(d.realized) AS realized, SUM(d.cost_closed) AS cost_closed, SUM(d.closed) AS closed, SUM(d.wins) AS wins,
              SUM(d.gains) AS gains, SUM(d.losses) AS losses, SUM(d.buy_usd) AS buy_usd, SUM(d.sell_usd) AS sell_usd,
              SUM(d.unmatched_usd) AS unmatched_usd, SUM(d.unpriced) AS unpriced, SUM(d.legs) AS legs, MAX(d.legs) AS peak, COUNT(*) AS active_days,
              MIN(w.first_ts) AS first_ts, MAX(w.last_ts) AS last_ts
         FROM disc_wallet_days d JOIN disc_wallets w ON w.network = d.network AND w.trader = d.trader
        WHERE d.network = ? AND d.day >= ?
        GROUP BY d.trader
       HAVING SUM(d.closed) > 0 OR SUM(d.buy_usd) + SUM(d.sell_usd) >= ?`,
      [network, fromDay, minVolume],
    )
    const counts = new Map<string, { sold: number; profitable: number; early: number }>()
    for (const r of await this.db.all<Record<string, unknown>>(
      `SELECT trader, SUM(CASE WHEN last_sell_at >= ? THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN realized > 0 THEN 1 ELSE 0 END) AS profitable,
              SUM(CASE WHEN early_buy_at >= ? THEN 1 ELSE 0 END) AS early
         FROM disc_wallet_tokens WHERE network = ? AND (last_sell_at >= ? OR early_buy_at >= ? OR realized > 0) GROUP BY trader`,
      [fromTs, fromTs, network, fromTs, fromTs],
    ))
      counts.set(String(r.trader), { sold: n(r.sold), profitable: n(r.profitable), early: n(r.early) })
    return rows.map((r) => {
      const c = counts.get(String(r.trader))
      return {
        trader: String(r.trader),
        realized: n(r.realized),
        costClosed: n(r.cost_closed),
        closed: n(r.closed),
        wins: n(r.wins),
        gains: n(r.gains),
        losses: n(r.losses),
        buyUsd: n(r.buy_usd),
        sellUsd: n(r.sell_usd),
        unmatchedUsd: n(r.unmatched_usd),
        unpriced: n(r.unpriced),
        legs: n(r.legs),
        peakDayLegs: n(r.peak),
        activeDays: n(r.active_days),
        tokensSold: c?.sold ?? 0,
        profitableTokens: c?.profitable ?? 0,
        earlyTokens: c?.early ?? 0,
        firstTs: n(r.first_ts),
        lastTs: n(r.last_ts),
      }
    })
  }

  async wallets(network: string, traders: readonly string[]): Promise<Map<string, WalletMeta>> {
    const out = new Map<string, WalletMeta>()
    for (let i = 0; i < traders.length; i += 500) {
      const chunk = traders.slice(i, i + 500)
      if (chunk.length === 0) continue
      for (const r of await this.db.all<Record<string, unknown>>(`SELECT * FROM disc_wallets WHERE network = ? AND trader IN (${chunk.map(() => '?').join(', ')})`, [
        network,
        ...chunk,
      ]))
        out.set(String(r.trader), {
          trader: String(r.trader),
          firstTs: n(r.first_ts),
          lastTs: n(r.last_ts),
          legs: n(r.legs),
          lastSide: (r.last_side as string | null) ?? null,
          lastToken: (r.last_token as string | null) ?? null,
          lastUsd: nn(r.last_usd),
          lastTx: (r.last_tx as string | null) ?? null,
        })
    }
    return out
  }

  /** Each listed wallet's most traded tokens (by volume), up to `per` each. */
  async topTokens(network: string, traders: readonly string[], per: number): Promise<Map<string, { token: string; volume: number }[]>> {
    const out = new Map<string, { token: string; volume: number }[]>()
    if (traders.length === 0) return out
    const rows = await this.db.all<{ trader: string; token: string; v: number }>(
      `SELECT trader, token, buy_usd + sell_usd AS v FROM disc_wallet_tokens WHERE network = ? AND trader IN (${traders.map(() => '?').join(', ')}) ORDER BY trader, v DESC`,
      [network, ...traders],
    )
    for (const r of rows) {
      const list = out.get(r.trader) ?? []
      if (list.length < per) list.push({ token: r.token, volume: Number(r.v) })
      out.set(r.trader, list)
    }
    return out
  }

  async walletDays(network: string, trader: string): Promise<WalletDay[]> {
    return (await this.db.all<Record<string, unknown>>('SELECT * FROM disc_wallet_days WHERE network = ? AND trader = ? ORDER BY day', [network, trader])).map((r) => ({
      day: n(r.day),
      realized: n(r.realized),
      costClosed: n(r.cost_closed),
      closed: n(r.closed),
      wins: n(r.wins),
      gains: n(r.gains),
      losses: n(r.losses),
      buyUsd: n(r.buy_usd),
      sellUsd: n(r.sell_usd),
      unmatchedUsd: n(r.unmatched_usd),
      unpriced: n(r.unpriced),
      legs: n(r.legs),
    }))
  }

  async walletTokens(network: string, trader: string): Promise<WalletToken[]> {
    return (
      await this.db.all<Record<string, unknown>>('SELECT * FROM disc_wallet_tokens WHERE network = ? AND trader = ? ORDER BY buy_usd + sell_usd DESC', [network, trader])
    ).map(toWalletToken)
  }

  // ─── launch-to-wallet evidence ─────────────────────────────────────────────

  async launchTrades(network: string, q: { token?: string; traders?: readonly string[]; since: number; limit: number }): Promise<LaunchTrade[]> {
    const where = ['network = ?', 'ts >= ?']
    const args: SqlValue[] = [network, q.since]
    if (q.token) {
      where.push('token = ?')
      args.push(q.token)
    }
    if (q.traders) {
      if (q.traders.length === 0) return []
      where.push(`trader IN (${q.traders.map(() => '?').join(', ')})`)
      args.push(...q.traders)
    }
    return (await this.db.all<Record<string, unknown>>(`SELECT * FROM disc_launch_trades WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`, [...args, q.limit])).map((r) => ({
      token: String(r.token),
      trader: String(r.trader),
      side: r.side as 'buy' | 'sell',
      qty: n(r.qty),
      usd: nn(r.usd),
      ts: n(r.ts),
      tx: String(r.tx),
    }))
  }

  // ─── follows ───────────────────────────────────────────────────────────────

  async follows(userId: number, network: string): Promise<{ account: string; alerts: boolean; createdAt: number }[]> {
    return (await this.db.all<Record<string, unknown>>('SELECT * FROM disc_follows WHERE user_id = ? AND network = ? ORDER BY created_at', [userId, network])).map((r) => ({
      account: String(r.account),
      alerts: Number(r.alerts) === 1,
      createdAt: n(r.created_at),
    }))
  }

  async countFollows(userId: number, network: string): Promise<number> {
    return n((await this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM disc_follows WHERE user_id = ? AND network = ?', [userId, network]))?.c)
  }

  async follow(userId: number, network: string, account: string, alerts: boolean): Promise<void> {
    await this.db.run(
      'INSERT INTO disc_follows (user_id, network, account, alerts, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, network, account) DO UPDATE SET alerts = excluded.alerts',
      [userId, network, account, alerts ? 1 : 0, this.now()],
    )
  }

  async unfollow(userId: number, network: string, account: string): Promise<void> {
    await this.db.run('DELETE FROM disc_follows WHERE user_id = ? AND network = ? AND account = ?', [userId, network, account])
  }

  /** Followers who asked for alerts, per followed account. */
  async alertFollowers(network: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>()
    for (const r of await this.db.all<{ account: string; user_id: number }>('SELECT account, user_id FROM disc_follows WHERE network = ? AND alerts = 1', [network])) {
      out.set(r.account, [...(out.get(r.account) ?? []), Number(r.user_id)])
    }
    return out
  }

  // ─── housekeeping ──────────────────────────────────────────────────────────

  async prune(network: string): Promise<void> {
    const t = this.now()
    await this.db.run('DELETE FROM disc_launch_trades WHERE network = ? AND ts < ?', [network, t - 8 * 86_400_000])
    await this.db.run('DELETE FROM disc_wallet_days WHERE network = ? AND day < ?', [network, dayOf(t) - 120])
  }
}
