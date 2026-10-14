import { FINAL_STATUSES, LIVE_STATUSES, MAX_LIVE_PER_USER, type ExecutionStatus, type StrategyConfig, type StrategyKind, type StrategyStatus } from '@/lib/automation/config'
import { isUniqueViolation, type Database, type SqlValue } from '../db/database'
import { randomToken } from '../ids'

/**
 * Trading automation's records: strategies (limit orders, Copy Trade, Sniper, DCA), their trades
 * (executions), their audit trail (events) and what Copy Trade and Sniper saw (detections).
 *
 * Every state change is a compare-and-set on the current state, so a click, a Telegram button replayed
 * and the worker never undo each other. A trade's idem_key is unique: a trigger makes one trade at
 * most, whatever retries, restarts or second workers do. A user only ever reaches their own records:
 * every read for a person names the user.
 */

export interface Strategy {
  id: string
  userId: number
  network: string
  kind: StrategyKind
  walletId: string
  subject: string
  status: StrategyStatus
  config: StrategyConfig
  /** The worker's own memory between steps (a price seen, a cursor, counters). */
  state: Record<string, unknown>
  ocoGroup: string | null
  nextCheckAt: number | null
  expiresAt: number | null
  attempts: number
  statusReason: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export interface Execution {
  id: string
  strategyId: string
  userId: number
  walletId: string
  idemKey: string
  side: 'buy' | 'sell'
  token: string
  status: ExecutionStatus
  intentId: string | null
  nearInRaw: string | null
  amountInRaw: string | null
  expectedOutRaw: string | null
  minOutRaw: string | null
  priceYocto: string | null
  /** From chain once confirmed: NEAR in or out, and tokens in or out (raw). */
  nearRaw: string | null
  tokenRaw: string | null
  txHashes: string[]
  message: string | null
  source: string | null
  createdAt: number
  updatedAt: number
}

export interface AutoEvent {
  at: number
  kind: string
  message: string
}

export type DetectionStatus = 'detected' | 'eligible' | 'skipped' | 'executing' | 'submitted' | 'confirmed' | 'failed'

export interface Detection {
  strategyId: string
  sourceKey: string
  at: number
  side: 'buy' | 'sell' | null
  token: string | null
  tokenRaw: string | null
  nearRaw: string | null
  status: DetectionStatus
  reason: string | null
  executionId: string | null
}

type StrategyRow = {
  id: string
  user_id: number
  network: string
  kind: string
  wallet_id: string
  subject: string
  status: string
  config: string
  state: string
  oco_group: string | null
  next_check_at: number | null
  expires_at: number | null
  attempts: number
  status_reason: string | null
  created_at: number
  updated_at: number
  closed_at: number | null
}
type ExecutionRow = {
  id: string
  strategy_id: string
  user_id: number
  wallet_id: string
  idem_key: string
  side: string
  token: string
  status: string
  intent_id: string | null
  near_in_raw: string | null
  amount_in_raw: string | null
  expected_out_raw: string | null
  min_out_raw: string | null
  price_yocto: string | null
  near_raw: string | null
  token_raw: string | null
  tx_hashes: string | null
  message: string | null
  source: string | null
  created_at: number
  updated_at: number
}
type DetectionRow = {
  strategy_id: string
  source_key: string
  at: number
  side: string | null
  token: string | null
  token_raw: string | null
  near_raw: string | null
  status: string
  reason: string | null
  execution_id: string | null
}

const n = (v: number | null) => (v === null ? null : Number(v))
const toStrategy = (r: StrategyRow): Strategy => ({
  id: r.id,
  userId: Number(r.user_id),
  network: r.network,
  kind: r.kind as StrategyKind,
  walletId: r.wallet_id,
  subject: r.subject,
  status: r.status as StrategyStatus,
  config: JSON.parse(r.config) as StrategyConfig,
  state: JSON.parse(r.state) as Record<string, unknown>,
  ocoGroup: r.oco_group,
  nextCheckAt: n(r.next_check_at),
  expiresAt: n(r.expires_at),
  attempts: Number(r.attempts),
  statusReason: r.status_reason,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  closedAt: n(r.closed_at),
})
const toExecution = (r: ExecutionRow): Execution => ({
  id: r.id,
  strategyId: r.strategy_id,
  userId: Number(r.user_id),
  walletId: r.wallet_id,
  idemKey: r.idem_key,
  side: r.side as Execution['side'],
  token: r.token,
  status: r.status as ExecutionStatus,
  intentId: r.intent_id,
  nearInRaw: r.near_in_raw,
  amountInRaw: r.amount_in_raw,
  expectedOutRaw: r.expected_out_raw,
  minOutRaw: r.min_out_raw,
  priceYocto: r.price_yocto,
  nearRaw: r.near_raw,
  tokenRaw: r.token_raw,
  txHashes: r.tx_hashes ? (JSON.parse(r.tx_hashes) as string[]) : [],
  message: r.message,
  source: r.source,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})
const toDetection = (r: DetectionRow): Detection => ({
  strategyId: r.strategy_id,
  sourceKey: r.source_key,
  at: Number(r.at),
  side: r.side as Detection['side'],
  token: r.token,
  tokenRaw: r.token_raw,
  nearRaw: r.near_raw,
  status: r.status as DetectionStatus,
  reason: r.reason,
  executionId: r.execution_id,
})

const placeholders = (list: readonly unknown[]) => list.map(() => '?').join(', ')
/** An event message is short plain text: never a stack trace, a URL with a key in it, or a secret. */
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 500)

export class LiveLimitError extends Error {
  constructor(readonly kind: StrategyKind) {
    super(`At most ${MAX_LIVE_PER_USER[kind]} live ${kind === 'limit' ? 'orders' : kind === 'copy' ? 'Copy Trade rules' : kind === 'sniper' ? 'snipers' : 'DCA plans'} per user`)
  }
}

/** A create request's key used again for a different request. */
export class RequestKeyReused extends Error {
  constructor() {
    super('This request key was used for a different request')
  }
}

export interface NewStrategy {
  userId: number
  network: string
  walletId: string
  config: StrategyConfig
  subject: string
  status: 'draft' | 'active'
  ocoGroup?: string | null
  nextCheckAt: number | null
  expiresAt: number | null
  state?: Record<string, unknown>
}

export class AutomationStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── strategies ───────────────────────────────────────────────────────────

  /** A new strategy (createAll with one). */
  async create(s: NewStrategy): Promise<Strategy> {
    return (await this.createAll([s], null)).strategies[0] as Strategy
  }

  /**
   * New strategies, all or none, in one transaction: each checked against the per-user live limit (a
   * second live Copy Trade rule on the same account is refused by the database), a take profit and its
   * stop loss together. With a request key the request is recorded in the same transaction: the same
   * key again returns what the first request made (`replay`), whatever ran at the same time (the
   * database lets one of two concurrent requests in); the same key with another request is refused.
   */
  async createAll(rows: readonly NewStrategy[], request: { userId: number; key: string; fingerprint: string } | null): Promise<{ strategies: Strategy[]; replay: boolean }> {
    const ids = rows.map(() => randomToken(12))
    const t = this.now()
    try {
      await this.db.tx(async () => {
        if (request)
          await this.db.run('INSERT INTO auto_create_requests (user_id, request_key, fingerprint, strategy_ids, created_at) VALUES (?, ?, ?, ?, ?)', [
            request.userId,
            request.key,
            request.fingerprint,
            JSON.stringify(ids),
            t,
          ])
        for (const [i, s] of rows.entries()) {
          const id = ids[i] as string
          const live = await this.db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM auto_strategies WHERE user_id = ? AND network = ? AND kind = ? AND status NOT IN (${placeholders(FINAL_STATUSES)})`,
            [s.userId, s.network, s.config.kind, ...FINAL_STATUSES],
          )
          if (Number(live?.c ?? 0) >= MAX_LIVE_PER_USER[s.config.kind]) throw new LiveLimitError(s.config.kind)
          await this.db.run(
            `INSERT INTO auto_strategies (id, user_id, network, kind, wallet_id, subject, status, config, state, oco_group, next_check_at, expires_at, attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [
              id,
              s.userId,
              s.network,
              s.config.kind,
              s.walletId,
              s.subject,
              s.status,
              JSON.stringify(s.config),
              JSON.stringify(s.state ?? {}),
              s.ocoGroup ?? null,
              s.nextCheckAt,
              s.expiresAt,
              t,
              t,
            ],
          )
          await this.event(id, 'created', `Created ${s.status === 'active' ? 'and active' : 'as a draft'}`)
        }
      })
    } catch (err) {
      if (request && isUniqueViolation(err)) {
        const prior = await this.db.get<{ fingerprint: string; strategy_ids: string }>(
          'SELECT fingerprint, strategy_ids FROM auto_create_requests WHERE user_id = ? AND request_key = ?',
          [request.userId, request.key],
        )
        if (prior) {
          if (prior.fingerprint !== request.fingerprint) throw new RequestKeyReused()
          const made = await Promise.all((JSON.parse(prior.strategy_ids) as string[]).map((id) => this.get(id)))
          return { strategies: made.filter((s): s is Strategy => s !== null), replay: true }
        }
      }
      throw err
    }
    const made = await Promise.all(ids.map((id) => this.get(id)))
    return { strategies: made.filter((s): s is Strategy => s !== null), replay: false }
  }

  /** Whether a live strategy of this kind and subject exists (a new-pools sniper: the pool feed runs). */
  async liveWithSubject(network: string, kind: StrategyKind, subject: string): Promise<boolean> {
    const r = await this.db.get<{ id: string }>(
      `SELECT id FROM auto_strategies WHERE network = ? AND kind = ? AND subject = ? AND status IN (${placeholders(LIVE_STATUSES)}) LIMIT 1`,
      [network, kind, subject, ...LIVE_STATUSES],
    )
    return Boolean(r)
  }

  /** Active strategies of this kind and subject look again now (a sniper on a token whose pool just became ready). */
  async wake(network: string, kind: StrategyKind, subject: string): Promise<void> {
    await this.db.run(`UPDATE auto_strategies SET next_check_at = ? WHERE network = ? AND kind = ? AND subject = ? AND status = 'active'`, [this.now(), network, kind, subject])
  }

  /** Live, paused or draft strategies whose end (an expiry, a DCA's end) has passed: ended by the worker. */
  async lapsed(limit: number): Promise<Strategy[]> {
    return (
      await this.db.all<StrategyRow>(
        `SELECT * FROM auto_strategies WHERE status IN ('draft', 'active', 'paused') AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
        [this.now(), limit],
      )
    ).map(toStrategy)
  }

  async get(id: string): Promise<Strategy | null> {
    const r = await this.db.get<StrategyRow>('SELECT * FROM auto_strategies WHERE id = ?', [id])
    return r ? toStrategy(r) : null
  }

  /** One of this user's strategies, or null for anyone else's (or none). */
  async own(userId: number, id: string): Promise<Strategy | null> {
    const r = await this.db.get<StrategyRow>('SELECT * FROM auto_strategies WHERE id = ? AND user_id = ?', [id, userId])
    return r ? toStrategy(r) : null
  }

  async forUser(userId: number, network: string, opts: { kinds?: readonly StrategyKind[]; limit?: number } = {}): Promise<Strategy[]> {
    const kinds = opts.kinds ?? ['limit', 'copy', 'sniper', 'dca']
    return (
      await this.db.all<StrategyRow>(`SELECT * FROM auto_strategies WHERE user_id = ? AND network = ? AND kind IN (${placeholders(kinds)}) ORDER BY created_at DESC LIMIT ?`, [
        userId,
        network,
        ...kinds,
        Math.min(opts.limit ?? 100, 200),
      ])
    ).map(toStrategy)
  }

  /** Strategies the worker should look at now, whose lease is free. */
  async due(limit: number): Promise<Strategy[]> {
    const t = this.now()
    return (
      await this.db.all<StrategyRow>(
        `SELECT * FROM auto_strategies WHERE status IN (${placeholders(LIVE_STATUSES)}) AND next_check_at IS NOT NULL AND next_check_at <= ?
         AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_check_at LIMIT ?`,
        [...LIVE_STATUSES, t, t, limit],
      )
    ).map(toStrategy)
  }

  /** Takes the strategy's lease (compare-and-set: two workers never act on the same strategy). */
  async claim(id: string, owner: string, ms: number): Promise<boolean> {
    const t = this.now()
    return (
      (await this.db.run('UPDATE auto_strategies SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)', [
        owner,
        t + ms,
        id,
        t,
        owner,
      ])) === 1
    )
  }

  async release(id: string, owner: string): Promise<void> {
    await this.db.run('UPDATE auto_strategies SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?', [id, owner])
  }

  /**
   * Moves a strategy from one of `from` to `to`, only if it is in one of `from` now. Returns whether it
   * moved: the caller that loses a race (a Cancel against a trigger) learns it here.
   */
  async transition(
    id: string,
    from: readonly StrategyStatus[],
    to: StrategyStatus,
    patch: { reason?: string | null; nextCheckAt?: number | null; attempts?: number; state?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    const t = this.now()
    const sets = ['status = ?', 'updated_at = ?']
    const args: SqlValue[] = [to, t]
    if (patch.reason !== undefined) {
      sets.push('status_reason = ?')
      args.push(patch.reason === null ? null : clip(patch.reason))
    }
    if (patch.nextCheckAt !== undefined) {
      sets.push('next_check_at = ?')
      args.push(patch.nextCheckAt)
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?')
      args.push(patch.attempts)
    }
    if (patch.state !== undefined) {
      sets.push('state = ?')
      args.push(JSON.stringify(patch.state))
    }
    if (FINAL_STATUSES.includes(to)) {
      sets.push('closed_at = ?', 'next_check_at = NULL')
      args.push(t)
    }
    return (await this.db.run(`UPDATE auto_strategies SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from)})`, [...args, id, ...from])) === 1
  }

  /** When the worker looks next, while the strategy is live. */
  async setNext(id: string, at: number, state?: Record<string, unknown>): Promise<void> {
    if (state === undefined)
      await this.db.run(`UPDATE auto_strategies SET next_check_at = ? WHERE id = ? AND status IN (${placeholders(LIVE_STATUSES)})`, [at, id, ...LIVE_STATUSES])
    else
      await this.db.run(`UPDATE auto_strategies SET next_check_at = ?, state = ? WHERE id = ? AND status IN (${placeholders(LIVE_STATUSES)})`, [
        at,
        JSON.stringify(state),
        id,
        ...LIVE_STATUSES,
      ])
  }

  async setAttempts(id: string, attempts: number): Promise<void> {
    await this.db.run('UPDATE auto_strategies SET attempts = ?, updated_at = ? WHERE id = ?', [attempts, this.now(), id])
  }

  /**
   * An order of a take profit / stop loss pair triggers only while no other order of its pair is
   * trading (triggered, executing or submitted), checked and set in one transaction with the pair's
   * rows locked: the two never trade at once. Without a pair, a plain transition.
   */
  async triggerOrder(
    s: Pick<Strategy, 'id' | 'ocoGroup'>,
    patch: { attempts: number; state: Record<string, unknown>; reason: string | null },
  ): Promise<'triggered' | 'pair-busy' | 'moved'> {
    if (!s.ocoGroup) return (await this.transition(s.id, ['active'], 'triggered', patch)) ? 'triggered' : 'moved'
    const group = s.ocoGroup
    return this.db.tx(async () => {
      const lock = this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''
      const rows = await this.db.all<{ id: string; status: string }>(`SELECT id, status FROM auto_strategies WHERE oco_group = ? ORDER BY id${lock}`, [group])
      if (rows.some((r) => r.id !== s.id && ['triggered', 'executing', 'submitted'].includes(r.status))) return 'pair-busy'
      return (await this.transition(s.id, ['active'], 'triggered', patch)) ? 'triggered' : 'moved'
    })
  }

  /** Whether another order of this pair is trading now (its result decides this one). */
  async pairTrading(group: string, exceptId: string): Promise<boolean> {
    const r = await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM auto_strategies WHERE oco_group = ? AND id <> ? AND status IN ('triggered', 'executing', 'submitted')`, [
      group,
      exceptId,
    ])
    return Number(r?.c ?? 0) > 0
  }

  /** The other orders of a take profit / stop loss pair, cancelled (once one of them filled, or was cancelled by its owner). */
  async cancelOcoSiblings(group: string, exceptId: string, reason: string): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(`SELECT id FROM auto_strategies WHERE oco_group = ? AND id <> ? AND status IN ('draft', 'active', 'paused')`, [group, exceptId])
    const cancelled: string[] = []
    for (const r of rows) {
      if (await this.transition(r.id, ['draft', 'active', 'paused'], 'cancelled', { reason })) {
        cancelled.push(r.id)
        await this.event(r.id, 'cancelled', reason)
      }
    }
    return cancelled
  }

  // ─── audit trail ──────────────────────────────────────────────────────────

  async event(strategyId: string, kind: string, message: string): Promise<void> {
    await this.db.run('INSERT INTO auto_events (strategy_id, at, kind, message) VALUES (?, ?, ?, ?)', [strategyId, this.now(), kind, clip(message)])
  }

  async events(strategyId: string, limit = 50): Promise<AutoEvent[]> {
    return (
      await this.db.all<{ at: number; kind: string; message: string }>('SELECT at, kind, message FROM auto_events WHERE strategy_id = ? ORDER BY at DESC, id DESC LIMIT ?', [
        strategyId,
        Math.min(limit, 200),
      ])
    ).map((r) => ({ at: Number(r.at), kind: r.kind, message: r.message }))
  }

  // ─── trades ───────────────────────────────────────────────────────────────

  /**
   * A trade, saved before anything is signed. Null when a trade with this idem_key exists already:
   * the trigger was handled (by this worker before a restart, or by another one).
   */
  async addExecution(e: {
    strategyId: string
    userId: number
    walletId: string
    idemKey: string
    side: 'buy' | 'sell'
    token: string
    nearInRaw?: string | null
    amountInRaw?: string | null
    expectedOutRaw?: string | null
    minOutRaw?: string | null
    priceYocto?: string | null
    source?: string | null
    message?: string | null
  }): Promise<Execution | null> {
    const id = randomToken(12)
    const t = this.now()
    try {
      await this.db.attempt(() =>
        this.db.run(
          `INSERT INTO auto_executions (id, strategy_id, user_id, wallet_id, idem_key, side, token, status, near_in_raw, amount_in_raw, expected_out_raw, min_out_raw, price_yocto, source, message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            e.strategyId,
            e.userId,
            e.walletId,
            e.idemKey,
            e.side,
            e.token,
            e.nearInRaw ?? null,
            e.amountInRaw ?? null,
            e.expectedOutRaw ?? null,
            e.minOutRaw ?? null,
            e.priceYocto ?? null,
            e.source ?? null,
            e.message ? clip(e.message) : null,
            t,
            t,
          ],
        ),
      )
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
    }
    return this.execution(id)
  }

  async execution(id: string): Promise<Execution | null> {
    const r = await this.db.get<ExecutionRow>('SELECT * FROM auto_executions WHERE id = ?', [id])
    return r ? toExecution(r) : null
  }

  async executionByKey(idemKey: string): Promise<Execution | null> {
    const r = await this.db.get<ExecutionRow>('SELECT * FROM auto_executions WHERE idem_key = ?', [idemKey])
    return r ? toExecution(r) : null
  }

  async executionsOf(strategyId: string, limit = 50): Promise<Execution[]> {
    return (await this.db.all<ExecutionRow>('SELECT * FROM auto_executions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?', [strategyId, Math.min(limit, 200)])).map(
      toExecution,
    )
  }

  /** Trades sent and not settled yet, oldest first (the worker settles them from their intents). */
  async openExecutions(limit = 50): Promise<Execution[]> {
    return (await this.db.all<ExecutionRow>(`SELECT * FROM auto_executions WHERE status IN ('executing', 'submitted') ORDER BY updated_at LIMIT ?`, [limit])).map(toExecution)
  }

  async openExecutionsOf(strategyId: string): Promise<Execution[]> {
    return (await this.db.all<ExecutionRow>(`SELECT * FROM auto_executions WHERE strategy_id = ? AND status IN ('executing', 'submitted')`, [strategyId])).map(toExecution)
  }

  /** NEAR in this strategy's buys under way (saved or sent, not settled): exposure they will add once confirmed. */
  async openBuyNear(strategyId: string): Promise<bigint> {
    return (await this.openExecutionsOf(strategyId)).filter((e) => e.side === 'buy').reduce((s, e) => s + (e.nearInRaw && /^\d+$/.test(e.nearInRaw) ? BigInt(e.nearInRaw) : 0n), 0n)
  }

  /** Moves a trade on, only from one of `from` (compare-and-set). */
  async updateExecution(
    id: string,
    from: readonly ExecutionStatus[],
    to: ExecutionStatus,
    patch: { intentId?: string; nearRaw?: string | null; tokenRaw?: string | null; txHashes?: string[]; message?: string | null } = {},
  ): Promise<boolean> {
    const sets = ['status = ?', 'updated_at = ?']
    const args: SqlValue[] = [to, this.now()]
    if (patch.intentId !== undefined) {
      sets.push('intent_id = ?')
      args.push(patch.intentId)
    }
    if (patch.nearRaw !== undefined) {
      sets.push('near_raw = ?')
      args.push(patch.nearRaw)
    }
    if (patch.tokenRaw !== undefined) {
      sets.push('token_raw = ?')
      args.push(patch.tokenRaw)
    }
    if (patch.txHashes !== undefined) {
      sets.push('tx_hashes = ?')
      args.push(JSON.stringify(patch.txHashes))
    }
    if (patch.message !== undefined) {
      sets.push('message = ?')
      args.push(patch.message === null ? null : clip(patch.message))
    }
    return (await this.db.run(`UPDATE auto_executions SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from)})`, [...args, id, ...from])) === 1
  }

  /**
   * NEAR put into automated buys since `since`, by this user or by everyone (the daily limits). A
   * trade still under way counts at what it would spend; failed and cancelled ones don't.
   */
  async nearSpentSince(since: number, userId: number | null): Promise<bigint> {
    const rows = await this.db.all<{ near_in_raw: string | null }>(
      `SELECT near_in_raw FROM auto_executions WHERE side = 'buy' AND status IN ('executing', 'submitted', 'confirmed') AND created_at >= ?${userId === null ? '' : ' AND user_id = ?'}`,
      userId === null ? [since] : [since, userId],
    )
    return rows.reduce((s, r) => s + (r.near_in_raw && /^\d+$/.test(r.near_in_raw) ? BigInt(r.near_in_raw) : 0n), 0n)
  }

  // ─── detections ───────────────────────────────────────────────────────────

  /** What Copy Trade or Sniper saw, once per strategy: false when it was seen already. */
  async addDetection(d: Omit<Detection, 'at' | 'executionId'> & { at?: number }): Promise<boolean> {
    try {
      await this.db.attempt(() =>
        this.db.run('INSERT INTO auto_detections (strategy_id, source_key, at, side, token, token_raw, near_raw, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          d.strategyId,
          d.sourceKey,
          d.at ?? this.now(),
          d.side,
          d.token,
          d.tokenRaw,
          d.nearRaw,
          d.status,
          d.reason === null ? null : clip(d.reason),
        ]),
      )
      return true
    } catch (err) {
      if (isUniqueViolation(err)) return false
      throw err
    }
  }

  async updateDetection(strategyId: string, sourceKey: string, status: DetectionStatus, patch: { reason?: string | null; executionId?: string | null } = {}): Promise<void> {
    const sets = ['status = ?']
    const args: SqlValue[] = [status]
    if (patch.reason !== undefined) {
      sets.push('reason = ?')
      args.push(patch.reason === null ? null : clip(patch.reason))
    }
    if (patch.executionId !== undefined) {
      sets.push('execution_id = ?')
      args.push(patch.executionId)
    }
    await this.db.run(`UPDATE auto_detections SET ${sets.join(', ')} WHERE strategy_id = ? AND source_key = ?`, [...args, strategyId, sourceKey])
  }

  async detectionsOf(strategyId: string, limit = 50): Promise<Detection[]> {
    return (await this.db.all<DetectionRow>('SELECT * FROM auto_detections WHERE strategy_id = ? ORDER BY at DESC LIMIT ?', [strategyId, Math.min(limit, 200)])).map(toDetection)
  }

  async detection(strategyId: string, sourceKey: string): Promise<Detection | null> {
    const r = await this.db.get<DetectionRow>('SELECT * FROM auto_detections WHERE strategy_id = ? AND source_key = ?', [strategyId, sourceKey])
    return r ? toDetection(r) : null
  }

  /**
   * Keeps the tables bounded: the audit trail and detections of strategies closed over 90 days ago,
   * and skipped detections over 30 days old. Trades are kept (they are the financial record).
   */
  async prune(): Promise<void> {
    const t = this.now()
    await this.db.run(`DELETE FROM auto_detections WHERE status = 'skipped' AND at < ?`, [t - 30 * 86_400_000])
    await this.db.run(`DELETE FROM auto_events WHERE strategy_id IN (SELECT id FROM auto_strategies WHERE closed_at IS NOT NULL AND closed_at < ?)`, [t - 90 * 86_400_000])
    // A request key protects its retries for a week.
    await this.db.run('DELETE FROM auto_create_requests WHERE created_at < ?', [t - 7 * 86_400_000])
  }
}
