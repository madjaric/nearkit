import type { Db } from '../db/sqlite'

/**
 * Buybot persistence. Idempotency lives in the keys: a transaction is a candidate
 * once, a buy (tx, token, buyer) is recorded once, and each (buy, chat) gets one
 * delivery row whose status only moves forward. The block cursor advances in the
 * same transaction as the candidates found in that block, so a restart resumes
 * without losing or double-counting anything.
 */

export interface BuybotConfig {
  id: number
  chatId: number
  chatTitle: string | null
  network: string
  token: string
  symbol: string
  name: string
  decimals: number
  enabled: boolean
  /** Smallest buy (NEAR value) that gets posted, in yoctoNEAR. */
  minNear: bigint
  emoji: string
  /** NEAR value per emoji in the header. */
  stepNear: bigint
  /** Post without a notification sound. */
  silent: boolean
  /** Why posting stopped on its own (e.g. the bot was removed from the chat). */
  pausedReason: string | null
  createdBy: number
  createdAt: number
  updatedAt: number
}

export interface Candidate {
  txHash: string
  network: string
  tokens: string[]
  blockHeight: number
  firstSeen: number
  attempts: number
}

export interface BuyEvent {
  eventKey: string
  network: string
  token: string
  txHash: string
  buyer: string
  amount: bigint
  paid: { asset: string; amount: bigint }[]
  blockHeight: number
  detectedAt: number
}

export type DeliveryStatus = 'pending' | 'sent' | 'skipped' | 'failed'

export const MAX_CONFIGS_PER_CHAT = 5

interface ConfigRow {
  id: number
  chat_id: number
  chat_title: string | null
  network: string
  token: string
  symbol: string
  name: string
  decimals: number
  enabled: number
  min_near: string
  emoji: string
  step_near: string
  silent: number
  paused_reason: string | null
  created_by: number
  created_at: number
  updated_at: number
}

const toConfig = (r: ConfigRow): BuybotConfig => ({
  id: r.id,
  chatId: r.chat_id,
  chatTitle: r.chat_title,
  network: r.network,
  token: r.token,
  symbol: r.symbol,
  name: r.name,
  decimals: r.decimals,
  enabled: r.enabled === 1,
  minNear: BigInt(r.min_near),
  emoji: r.emoji,
  stepNear: BigInt(r.step_near),
  silent: r.silent === 1,
  pausedReason: r.paused_reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toEvent = (r: {
  event_key: string
  network: string
  token: string
  tx_hash: string
  buyer: string
  amount: string
  paid: string
  block_height: number
  detected_at: number
}): BuyEvent => ({
  eventKey: r.event_key,
  network: r.network,
  token: r.token,
  txHash: r.tx_hash,
  buyer: r.buyer,
  amount: BigInt(r.amount),
  paid: (JSON.parse(r.paid) as { asset: string; amount: string }[]).map((p) => ({ asset: p.asset, amount: BigInt(p.amount) })),
  blockHeight: r.block_height,
  detectedAt: r.detected_at,
})

export class BuybotStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── configurations ───────────────────────────────────────────────────────

  addConfig(c: { chatId: number; chatTitle: string | null; network: string; token: string; symbol: string; name: string; decimals: number; createdBy: number }): BuybotConfig {
    return this.db.tx(() => {
      if (this.configsForChat(c.chatId).length >= MAX_CONFIGS_PER_CHAT) throw new Error(`A chat can follow at most ${MAX_CONFIGS_PER_CHAT} tokens`)
      const t = this.now()
      this.db.run(
        `INSERT INTO buybot_configs (chat_id, chat_title, network, token, symbol, name, decimals, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.chatId, c.chatTitle, c.network, c.token, c.symbol, c.name, c.decimals, c.createdBy, t, t],
      )
      const id = this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0
      return this.config(id) as BuybotConfig
    })
  }

  config(id: number): BuybotConfig | null {
    const r = this.db.get<ConfigRow>('SELECT * FROM buybot_configs WHERE id = ?', [id])
    return r ? toConfig(r) : null
  }

  findConfig(chatId: number, network: string, token: string): BuybotConfig | null {
    const r = this.db.get<ConfigRow>('SELECT * FROM buybot_configs WHERE chat_id = ? AND network = ? AND token = ?', [chatId, network, token])
    return r ? toConfig(r) : null
  }

  configsForChat(chatId: number): BuybotConfig[] {
    return this.db.all<ConfigRow>('SELECT * FROM buybot_configs WHERE chat_id = ? ORDER BY id', [chatId]).map(toConfig)
  }

  updateConfig(id: number, patch: Partial<Pick<BuybotConfig, 'enabled' | 'minNear' | 'emoji' | 'stepNear' | 'silent' | 'chatTitle' | 'pausedReason'>>): BuybotConfig | null {
    const cur = this.config(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    this.db.run(`UPDATE buybot_configs SET enabled = ?, min_near = ?, emoji = ?, step_near = ?, silent = ?, chat_title = ?, paused_reason = ?, updated_at = ? WHERE id = ?`, [
      next.enabled ? 1 : 0,
      next.minNear.toString(),
      next.emoji,
      next.stepNear.toString(),
      next.silent ? 1 : 0,
      next.chatTitle,
      next.pausedReason,
      this.now(),
      id,
    ])
    return this.config(id)
  }

  removeConfig(id: number): void {
    this.db.run('DELETE FROM buybot_configs WHERE id = ?', [id])
  }

  /** Tokens at least one chat wants posts for right now. */
  activeTokens(network: string): string[] {
    return this.db
      .all<{ token: string }>('SELECT DISTINCT token FROM buybot_configs WHERE network = ? AND enabled = 1 AND paused_reason IS NULL ORDER BY token', [network])
      .map((r) => r.token)
  }

  activeConfigsFor(network: string, token: string): BuybotConfig[] {
    return this.db
      .all<ConfigRow>('SELECT * FROM buybot_configs WHERE network = ? AND token = ? AND enabled = 1 AND paused_reason IS NULL ORDER BY id', [network, token])
      .map(toConfig)
  }

  /** The bot can't post there any more (removed, blocked): stop until someone re-enables it. */
  pauseChat(chatId: number, reason: string): void {
    this.db.run('UPDATE buybot_configs SET paused_reason = ?, updated_at = ? WHERE chat_id = ?', [reason, this.now(), chatId])
  }

  resumeChat(chatId: number): void {
    this.db.run('UPDATE buybot_configs SET paused_reason = NULL, updated_at = ? WHERE chat_id = ?', [this.now(), chatId])
  }

  /** A group became a supergroup and got a new ID. */
  migrateChat(from: number, to: number): void {
    this.db.run('UPDATE buybot_configs SET chat_id = ?, updated_at = ? WHERE chat_id = ?', [to, this.now(), from])
  }

  // ─── cursors and candidates ───────────────────────────────────────────────

  /** Height up to which a token's history has been read. */
  tokenCursor(network: string, token: string): number | null {
    const v = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [`buybot_cursor_${network}_${token}`])?.value
    return v === undefined ? null : Number(v)
  }

  tokenCursors(network: string): { token: string; height: number }[] {
    const prefix = `buybot_cursor_${network}_`
    return this.db
      .all<{ key: string; value: string }>('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?', [prefix.length, prefix])
      .map((r) => ({ token: r.key.slice(prefix.length), height: Number(r.value) }))
  }

  /** Records a token's new transactions and moves its cursor, all at once. Known transactions are skipped. */
  advanceToken(network: string, token: string, height: number, found: { txHash: string; blockHeight: number }[]): void {
    this.db.tx(() => {
      const t = this.now()
      for (const c of found) {
        const existing = this.db.get<{ tokens: string; done_at: number | null }>('SELECT tokens, done_at FROM buybot_candidates WHERE tx_hash = ?', [c.txHash])
        if (!existing) {
          this.db.run('INSERT INTO buybot_candidates (tx_hash, network, tokens, block_height, first_seen, next_at) VALUES (?, ?, ?, ?, ?, ?)', [
            c.txHash,
            network,
            JSON.stringify([token]),
            c.blockHeight,
            t,
            t,
          ])
        } else if (existing.done_at === null) {
          const tokens = JSON.parse(existing.tokens) as string[]
          if (!tokens.includes(token)) this.db.run('UPDATE buybot_candidates SET tokens = ? WHERE tx_hash = ?', [JSON.stringify([...tokens, token]), c.txHash])
        }
      }
      this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`buybot_cursor_${network}_${token}`, String(height)])
    })
  }

  dueCandidates(network: string, limit = 10): Candidate[] {
    return this.db
      .all<{
        tx_hash: string
        network: string
        tokens: string
        block_height: number
        first_seen: number
        attempts: number
      }>('SELECT * FROM buybot_candidates WHERE network = ? AND done_at IS NULL AND next_at <= ? ORDER BY block_height, first_seen LIMIT ?', [network, this.now(), limit])
      .map((r) => ({
        txHash: r.tx_hash,
        network: r.network,
        tokens: JSON.parse(r.tokens) as string[],
        blockHeight: r.block_height,
        firstSeen: r.first_seen,
        attempts: r.attempts,
      }))
  }

  retryCandidate(txHash: string, delayMs: number): number {
    this.db.run('UPDATE buybot_candidates SET attempts = attempts + 1, next_at = ? WHERE tx_hash = ?', [this.now() + delayMs, txHash])
    return this.db.get<{ attempts: number }>('SELECT attempts FROM buybot_candidates WHERE tx_hash = ?', [txHash])?.attempts ?? 0
  }

  /** Read (or given up on): kept as a marker so the same transaction isn't read again. */
  finishCandidate(txHash: string): void {
    this.db.run('UPDATE buybot_candidates SET done_at = ? WHERE tx_hash = ?', [this.now(), txHash])
  }

  // ─── buys and deliveries ──────────────────────────────────────────────────

  /**
   * Records a buy once and queues one delivery per chat that wants it. Returns
   * false when this buy was already recorded (a restart re-read the block).
   */
  recordBuy(event: Omit<BuyEvent, 'detectedAt'>, configIds: number[]): boolean {
    return this.db.tx(() => {
      const t = this.now()
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO buybot_events (event_key, network, token, tx_hash, buyer, amount, paid, block_height, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.eventKey,
          event.network,
          event.token,
          event.txHash,
          event.buyer,
          event.amount.toString(),
          JSON.stringify(event.paid.map((p) => ({ asset: p.asset, amount: p.amount.toString() }))),
          event.blockHeight,
          t,
        ],
      )
      if (inserted === 0) return false
      for (const id of configIds) {
        this.db.run(`INSERT OR IGNORE INTO buybot_deliveries (event_key, config_id, status, next_at, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)`, [
          event.eventKey,
          id,
          t,
          t,
          t,
        ])
      }
      return true
    })
  }

  event(eventKey: string): BuyEvent | null {
    const r = this.db.get<Parameters<typeof toEvent>[0]>('SELECT * FROM buybot_events WHERE event_key = ?', [eventKey])
    return r ? toEvent(r) : null
  }

  dueDeliveries(limit = 20): { eventKey: string; configId: number; attempts: number }[] {
    return this.db
      .all<{ event_key: string; config_id: number; attempts: number }>(
        `SELECT event_key, config_id, attempts FROM buybot_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?`,
        [this.now(), limit],
      )
      .map((r) => ({ eventKey: r.event_key, configId: r.config_id, attempts: r.attempts }))
  }

  markSent(eventKey: string, configId: number, messageId: number): void {
    this.db.run(
      `UPDATE buybot_deliveries SET status = 'sent', message_id = ?, attempts = attempts + 1, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`,
      [messageId, this.now(), eventKey, configId],
    )
  }

  markRetry(eventKey: string, configId: number, delayMs: number, error: string): void {
    this.db.run(`UPDATE buybot_deliveries SET attempts = attempts + 1, next_at = ?, error = ?, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`, [
      this.now() + delayMs,
      error.slice(0, 300),
      this.now(),
      eventKey,
      configId,
    ])
  }

  markDone(eventKey: string, configId: number, status: 'skipped' | 'failed', reason: string): void {
    this.db.run(`UPDATE buybot_deliveries SET status = ?, error = ?, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`, [
      status,
      reason.slice(0, 300),
      this.now(),
      eventKey,
      configId,
    ])
  }

  delivery(eventKey: string, configId: number): { status: DeliveryStatus; attempts: number; messageId: number | null; error: string | null } | null {
    const r = this.db.get<{ status: DeliveryStatus; attempts: number; message_id: number | null; error: string | null }>(
      'SELECT status, attempts, message_id, error FROM buybot_deliveries WHERE event_key = ? AND config_id = ?',
      [eventKey, configId],
    )
    return r ? { status: r.status, attempts: r.attempts, messageId: r.message_id, error: r.error } : null
  }

  // ─── status and housekeeping ──────────────────────────────────────────────

  stats(network: string, configIds: number[]): { candidates: number; pending: number; sent: number; failed: number; lastBuyAt: number | null } {
    const ids = configIds.length ? configIds : [-1]
    const marks = ids.map(() => '?').join(',')
    const count = (status: string) =>
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM buybot_deliveries WHERE status = ? AND config_id IN (${marks})`, [status, ...ids])?.n ?? 0
    return {
      candidates: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM buybot_candidates WHERE network = ? AND done_at IS NULL', [network])?.n ?? 0,
      pending: count('pending'),
      sent: count('sent'),
      failed: count('failed'),
      lastBuyAt:
        this.db.get<{ at: number | null }>(
          `SELECT MAX(e.detected_at) AS at FROM buybot_events e JOIN buybot_deliveries d ON d.event_key = e.event_key WHERE d.config_id IN (${marks})`,
          ids,
        )?.at ?? null,
    }
  }

  /** Forgets buys (and their deliveries) older than `ageMs`, and done candidates after an hour. */
  prune(ageMs: number): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM buybot_events WHERE detected_at < ?', [this.now() - ageMs])
      this.db.run('DELETE FROM buybot_candidates WHERE done_at IS NOT NULL AND done_at < ?', [this.now() - 3_600_000])
    })
  }
}
