import { MAX_LIVE_BOTS_PER_USER } from '@/lib/volumeBot/config'
import { isUniqueViolation, type Database } from '../db/database'
import { randomToken } from '../ids'
import type { Book } from '@/lib/volumeBot/inventory'
import type { Health } from '@/lib/volumeBot/risk'
import type { BotConfig, BotStatus, FairValue, MarketSnapshot, RunProgress } from '@/lib/volumeBot/types'

/**
 * The Volume Bot's persistence: each bot (its configuration and status), the wallets it trades from,
 * its runs (and the state a run carries across ticks and restarts), its trades, its events and its
 * metrics over time. Status changes are compare-and-set, so a click and the worker never both win.
 */

export interface VolumeBot {
  id: string
  userId: number
  network: string
  token: string
  strategy: BotConfig['strategy']
  config: BotConfig
  status: BotStatus
  /** Why it is paused: `owner`, or the guardian's code. */
  pauseCode: string | null
  pauseReason: string | null
  nextTickAt: number | null
  startedAt: number | null
  stoppedAt: number | null
  createdAt: number
  updatedAt: number
}

/** What a run carries from tick to tick, and across a restart of the worker. */
export interface RunState {
  progress: RunProgress
  fair: FairValue | null
  /** Each wallet's book (average cost, PnL), by wallet id. */
  books: Record<string, Book>
  /** What each wallet should hold after the bot's own trades (the guardian's baseline). */
  expected: { walletId: string; near: number; tokens: number }[]
  baselineLiquidityUsd: number | null
  prevMarket: MarketSnapshot | null
  health: Health
  equity: { startNear: number | null; peakNear: number | null; dayStartNear: number | null; day: string | null }
  lastMetricAt: number | null
  /** The reason it last waited or skipped, for the dashboard. */
  waiting: string | null
}

export interface BotTrade {
  id: number
  botId: string
  runId: string
  walletId: string
  intentId: string | null
  side: 'buy' | 'sell'
  status: 'submitted' | 'confirmed' | 'failed'
  nearRaw: string | null
  tokenRaw: string | null
  priceNear: number | null
  impactBps: number | null
  feeNear: number | null
  gasNear: number | null
  nearUsd: number | null
  txHash: string | null
  message: string | null
  createdAt: number
  updatedAt: number
}

export interface BotEvent {
  id: number
  botId: string
  kind: string
  code: string | null
  message: string
  at: number
}

export interface BotMetricPoint {
  at: number
  priceNear: number | null
  equityNear: number | null
  pnlNear: number | null
  tokenPct: number | null
  volumeNear: number
  trades: number
}

interface BotRow {
  id: string
  user_id: number
  network: string
  token: string
  strategy: string
  config: string
  status: string
  pause_code: string | null
  pause_reason: string | null
  next_tick_at: number | null
  started_at: number | null
  stopped_at: number | null
  created_at: number
  updated_at: number
}

interface TradeRow {
  id: number
  bot_id: string
  run_id: string
  wallet_id: string
  intent_id: string | null
  side: string
  status: string
  near_raw: string | null
  token_raw: string | null
  price_near: number | null
  impact_bps: number | null
  fee_near: number | null
  gas_near: number | null
  near_usd: number | null
  tx_hash: string | null
  message: string | null
  created_at: number
  updated_at: number
}

const toBot = (r: BotRow): VolumeBot => ({
  id: r.id,
  userId: Number(r.user_id),
  network: r.network,
  token: r.token,
  strategy: r.strategy as BotConfig['strategy'],
  config: JSON.parse(r.config) as BotConfig,
  status: r.status as BotStatus,
  pauseCode: r.pause_code,
  pauseReason: r.pause_reason,
  nextTickAt: r.next_tick_at === null ? null : Number(r.next_tick_at),
  startedAt: r.started_at === null ? null : Number(r.started_at),
  stoppedAt: r.stopped_at === null ? null : Number(r.stopped_at),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})

const num = (v: number | null) => (v === null ? null : Number(v))
const toTrade = (r: TradeRow): BotTrade => ({
  id: Number(r.id),
  botId: r.bot_id,
  runId: r.run_id,
  walletId: r.wallet_id,
  intentId: r.intent_id,
  side: r.side as 'buy' | 'sell',
  status: r.status as BotTrade['status'],
  nearRaw: r.near_raw,
  tokenRaw: r.token_raw,
  priceNear: num(r.price_near),
  impactBps: num(r.impact_bps),
  feeNear: num(r.fee_near),
  gasNear: num(r.gas_near),
  nearUsd: num(r.near_usd),
  txHash: r.tx_hash,
  message: r.message,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})

/** The states in which a bot holds its token (the one-live-bot-per-token index). */
export const LIVE: readonly BotStatus[] = ['running', 'paused', 'stopping']
/** The states a bot can be started from (and edited in). */
export const IDLE: readonly BotStatus[] = ['draft', 'stopped', 'completed']

/** A constant list of statuses for SQL (`IN (...)`): only plain status words ever reach the query text. */
const inList = (list: readonly BotStatus[]) =>
  list
    .map((s) => {
      if (!/^[a-z]+$/.test(s)) throw new Error(`not a bot status: ${s}`)
      return `'${s}'`
    })
    .join(', ')

export class VolumeBotStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private async setWallets(botId: string, walletIds: readonly string[]): Promise<void> {
    await this.db.run('DELETE FROM volume_bot_wallets WHERE bot_id = ?', [botId])
    for (const w of walletIds) await this.db.run('INSERT INTO volume_bot_wallets (bot_id, wallet_id) VALUES (?, ?)', [botId, w])
  }

  /** Whether a live bot (running, paused or stopping) trades from this wallet. */
  async usesWallet(walletId: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM volume_bot_wallets w JOIN volume_bots b ON b.id = w.bot_id WHERE w.wallet_id = ? AND b.status IN (${inList(LIVE)})`,
      [walletId],
    )
    return Number(row?.n ?? 0) > 0
  }

  async create(i: { userId: number; network: string; config: BotConfig }): Promise<VolumeBot> {
    const id = randomToken(12)
    const t = this.now()
    await this.db.tx(async () => {
      await this.db.run(`INSERT INTO volume_bots (id, user_id, network, token, strategy, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`, [
        id,
        i.userId,
        i.network,
        i.config.tokenId,
        i.config.strategy,
        JSON.stringify(i.config),
        t,
        t,
      ])
      await this.setWallets(id, i.config.walletIds)
    })
    return (await this.get(id)) as VolumeBot
  }

  /** A new configuration, only while the bot isn't live (stop it first). */
  async update(id: string, userId: number, config: BotConfig): Promise<VolumeBot | null> {
    const t = this.now()
    const changed = await this.db.tx(async () => {
      const n = await this.db.run(`UPDATE volume_bots SET config = ?, token = ?, strategy = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN (${inList(IDLE)})`, [
        JSON.stringify(config),
        config.tokenId,
        config.strategy,
        t,
        id,
        userId,
      ])
      if (n === 1) await this.setWallets(id, config.walletIds)
      return n === 1
    })
    return changed ? this.get(id) : null
  }

  async get(id: string): Promise<VolumeBot | null> {
    const r = await this.db.get<BotRow>('SELECT * FROM volume_bots WHERE id = ?', [id])
    return r ? toBot(r) : null
  }

  async owned(userId: number, id: string): Promise<VolumeBot | null> {
    const b = await this.get(id)
    return b && b.userId === userId ? b : null
  }

  async ofUser(userId: number, network: string): Promise<VolumeBot[]> {
    return (await this.db.all<BotRow>('SELECT * FROM volume_bots WHERE user_id = ? AND network = ? ORDER BY created_at DESC', [userId, network])).map(toBot)
  }

  /** Deletes a bot that isn't live (its trades, events and metrics go with it). */
  async remove(id: string, userId: number): Promise<boolean> {
    return (await this.db.run(`DELETE FROM volume_bots WHERE id = ? AND user_id = ? AND status IN (${inList(IDLE)})`, [id, userId])) === 1
  }

  /**
   * Starts a run: idle → running, with a fresh run and its state. `busy-token`: another live bot of
   * this user trades the token; `not-idle`: it is already live.
   */
  async start(id: string, state: RunState): Promise<{ ok: true; runId: string } | { ok: false; reason: 'busy-token' | 'not-idle' | 'too-many' }> {
    const t = this.now()
    const runId = randomToken(12)
    try {
      return await this.db.tx(async () => {
        const live = await this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM volume_bots WHERE user_id = (SELECT user_id FROM volume_bots WHERE id = ?) AND id <> ? AND status IN (${inList(LIVE)})`,
          [id, id],
        )
        if (Number(live?.n ?? 0) >= MAX_LIVE_BOTS_PER_USER) return { ok: false as const, reason: 'too-many' as const }
        const n = await this.db.attempt(() =>
          this.db.run(
            `UPDATE volume_bots SET status = 'running', pause_code = NULL, pause_reason = NULL, next_tick_at = ?, started_at = ?, stopped_at = NULL, updated_at = ? WHERE id = ? AND status IN (${inList(IDLE)})`,
            [t, t, t, id],
          ),
        )
        if (n !== 1) return { ok: false as const, reason: 'not-idle' as const }
        await this.db.run('INSERT INTO volume_bot_runs (id, bot_id, started_at, state) VALUES (?, ?, ?, ?)', [runId, id, t, JSON.stringify(state)])
        return { ok: true as const, runId }
      })
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, reason: 'busy-token' }
      throw e
    }
  }

  /** running → paused, with who paused it and why. */
  async pause(id: string, code: string, reason: string): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run(`UPDATE volume_bots SET status = 'paused', pause_code = ?, pause_reason = ?, next_tick_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'`, [
        code,
        reason,
        t,
        id,
      ])) === 1
    )
  }

  /** paused → running, at once. */
  async resume(id: string): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run(`UPDATE volume_bots SET status = 'running', pause_code = NULL, pause_reason = NULL, next_tick_at = ?, updated_at = ? WHERE id = ? AND status = 'paused'`, [
        t,
        t,
        id,
      ])) === 1
    )
  }

  /** running or paused → stopping: nothing new is sent; the worker settles what was sent, then stops it. */
  async stop(id: string, reason: string): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run(`UPDATE volume_bots SET status = 'stopping', pause_reason = ?, next_tick_at = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'paused')`, [
        reason,
        t,
        t,
        id,
      ])) === 1
    )
  }

  /** stopping → stopped, or running → completed: the run ends with its reason. */
  async end(id: string, status: 'stopped' | 'completed', reason: string): Promise<boolean> {
    const t = this.now()
    return this.db.tx(async () => {
      const from = status === 'stopped' ? `'stopping'` : `'running'`
      const n = await this.db.run(`UPDATE volume_bots SET status = ?, pause_reason = ?, next_tick_at = NULL, stopped_at = ?, updated_at = ? WHERE id = ? AND status = ${from}`, [
        status,
        reason,
        t,
        t,
        id,
      ])
      if (n === 1) await this.db.run('UPDATE volume_bot_runs SET ended_at = ?, end_reason = ? WHERE bot_id = ? AND ended_at IS NULL', [t, reason, id])
      return n === 1
    })
  }

  /** Live bots whose next tick is due and whose lease is free, the most overdue first. */
  async due(limit: number): Promise<VolumeBot[]> {
    const t = this.now()
    return (
      await this.db.all<BotRow>(
        `SELECT * FROM volume_bots WHERE status IN ('running', 'stopping') AND next_tick_at IS NOT NULL AND next_tick_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_tick_at LIMIT ?`,
        [t, t, limit],
      )
    ).map(toBot)
  }

  /** Takes the bot's lease for one tick (compare-and-set: two workers never step the same bot). */
  async claim(id: string, owner: string, ms: number): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run('UPDATE volume_bots SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)', [
        owner,
        t + ms,
        id,
        t,
        owner,
      ])) === 1
    )
  }

  async release(id: string, owner: string): Promise<void> {
    await this.db.run('UPDATE volume_bots SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', [id, owner])
  }

  async setNextTick(id: string, at: number): Promise<void> {
    await this.db.run(`UPDATE volume_bots SET next_tick_at = ? WHERE id = ? AND status IN ('running', 'stopping')`, [at, id])
  }

  async currentRun(botId: string): Promise<{ id: string; startedAt: number; state: RunState } | null> {
    const r = await this.db.get<{ id: string; started_at: number; state: string }>(
      'SELECT id, started_at, state FROM volume_bot_runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1',
      [botId],
    )
    return r ? { id: r.id, startedAt: Number(r.started_at), state: JSON.parse(r.state) as RunState } : null
  }

  /** A trade settled together with the run state that counts it: a crash between the two never drops a fill from the books. */
  async settleTradeWithState(id: number, patch: Parameters<VolumeBotStore['settleTrade']>[1], runId: string, state: RunState): Promise<void> {
    await this.db.tx(async () => {
      await this.settleTrade(id, patch)
      await this.saveRunState(runId, state)
    })
  }

  async saveRunState(runId: string, state: RunState): Promise<void> {
    await this.db.run('UPDATE volume_bot_runs SET state = ? WHERE id = ?', [JSON.stringify(state), runId])
  }

  async addTrade(t: Omit<BotTrade, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const at = this.now()
    await this.db.run(
      `INSERT INTO volume_bot_trades (bot_id, run_id, wallet_id, intent_id, side, status, near_raw, token_raw, price_near, impact_bps, fee_near, gas_near, near_usd, tx_hash, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.botId, t.runId, t.walletId, t.intentId, t.side, t.status, t.nearRaw, t.tokenRaw, t.priceNear, t.impactBps, t.feeNear, t.gasNear, t.nearUsd, t.txHash, t.message, at, at],
    )
    const r = await this.db.get<{ id: number }>('SELECT id FROM volume_bot_trades WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [t.botId])
    return Number(r?.id)
  }

  /** What a trade turned out to be once it settled. */
  async settleTrade(
    id: number,
    patch: Pick<BotTrade, 'status'> & Partial<Pick<BotTrade, 'nearRaw' | 'tokenRaw' | 'priceNear' | 'feeNear' | 'gasNear' | 'txHash' | 'message'>>,
  ): Promise<void> {
    const cur = await this.db.get<TradeRow>('SELECT * FROM volume_bot_trades WHERE id = ?', [id])
    if (!cur) return
    await this.db.run(
      'UPDATE volume_bot_trades SET status = ?, near_raw = ?, token_raw = ?, price_near = ?, fee_near = ?, gas_near = ?, tx_hash = ?, message = ?, updated_at = ? WHERE id = ?',
      [
        patch.status,
        patch.nearRaw ?? cur.near_raw,
        patch.tokenRaw ?? cur.token_raw,
        patch.priceNear ?? cur.price_near,
        patch.feeNear ?? cur.fee_near,
        patch.gasNear ?? cur.gas_near,
        patch.txHash ?? cur.tx_hash,
        patch.message ?? cur.message,
        this.now(),
        id,
      ],
    )
  }

  /** A trade that never ran (refused, or re-quoted before anything was signed): no record of it stays. */
  async dropTrade(id: number): Promise<void> {
    await this.db.run(`DELETE FROM volume_bot_trades WHERE id = ? AND status = 'submitted'`, [id])
  }

  async trades(botId: string, limit = 50): Promise<BotTrade[]> {
    return (await this.db.all<TradeRow>('SELECT * FROM volume_bot_trades WHERE bot_id = ? ORDER BY id DESC LIMIT ?', [botId, limit])).map(toTrade)
  }

  async tradesOfRun(runId: string): Promise<BotTrade[]> {
    return (await this.db.all<TradeRow>('SELECT * FROM volume_bot_trades WHERE run_id = ? ORDER BY id', [runId])).map(toTrade)
  }

  async openTrades(botId: string): Promise<BotTrade[]> {
    return (await this.db.all<TradeRow>(`SELECT * FROM volume_bot_trades WHERE bot_id = ? AND status = 'submitted' ORDER BY id`, [botId])).map(toTrade)
  }

  async event(botId: string, kind: string, message: string, code: string | null = null): Promise<void> {
    await this.db.run('INSERT INTO volume_bot_events (bot_id, kind, code, message, at) VALUES (?, ?, ?, ?, ?)', [botId, kind, code, message, this.now()])
  }

  async events(botId: string, limit = 50): Promise<BotEvent[]> {
    return (
      await this.db.all<{ id: number; bot_id: string; kind: string; code: string | null; message: string; at: number }>(
        'SELECT * FROM volume_bot_events WHERE bot_id = ? ORDER BY id DESC LIMIT ?',
        [botId, limit],
      )
    ).map((r) => ({ id: Number(r.id), botId: r.bot_id, kind: r.kind, code: r.code, message: r.message, at: Number(r.at) }))
  }

  async addMetric(botId: string, m: BotMetricPoint): Promise<void> {
    await this.db.run(
      'INSERT INTO volume_bot_metrics (bot_id, at, price_near, equity_near, pnl_near, token_pct, volume_near, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [botId, m.at, m.priceNear, m.equityNear, m.pnlNear, m.tokenPct, m.volumeNear, m.trades],
    )
  }

  async metrics(botId: string, since: number): Promise<BotMetricPoint[]> {
    return (
      await this.db.all<{
        at: number
        price_near: number | null
        equity_near: number | null
        pnl_near: number | null
        token_pct: number | null
        volume_near: number
        trades: number
      }>('SELECT at, price_near, equity_near, pnl_near, token_pct, volume_near, trades FROM volume_bot_metrics WHERE bot_id = ? AND at >= ? ORDER BY at', [botId, since])
    ).map((r) => ({
      at: Number(r.at),
      priceNear: num(r.price_near),
      equityNear: num(r.equity_near),
      pnlNear: num(r.pnl_near),
      tokenPct: num(r.token_pct),
      volumeNear: Number(r.volume_near),
      trades: Number(r.trades),
    }))
  }

  /** Bots that are running or settling a stop: the worker's work. */
  async liveCount(): Promise<number> {
    return Number((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM volume_bots WHERE status IN ('running', 'stopping')`))?.n ?? 0)
  }

  /** Metrics and events older than `ageMs` go (trades stay: they are the record). */
  async prune(ageMs = 30 * 86_400_000): Promise<void> {
    const before = this.now() - ageMs
    await this.db.run('DELETE FROM volume_bot_metrics WHERE at < ?', [before])
    await this.db.run('DELETE FROM volume_bot_events WHERE at < ?', [before])
  }
}
