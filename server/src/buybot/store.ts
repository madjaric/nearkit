import type { Database } from '../db/database'

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
  /** The unit of the minimum and the emoji step. */
  unit: 'NEAR' | 'USD'
  /** Smallest trade (NEAR value) that gets posted, in yoctoNEAR, when unit is NEAR. */
  minNear: bigint
  /** Smallest trade in USD, when unit is USD. A trade whose USD value is unknown passes only a 0 minimum. */
  minUsd: number
  emoji: string
  /** NEAR value per emoji in the header (unit NEAR). */
  stepNear: bigint
  /** USD value per emoji in the header (unit USD). */
  stepUsd: number
  /** Most emoji in one header. */
  maxEmoji: number
  /** Posted with every alert, the text as its caption. */
  media: { kind: MediaKind; fileId: string } | null
  /** Post sells too, not just buys. */
  sells: boolean
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

export type MediaKind = 'photo' | 'animation' | 'video'

export interface BuyEvent {
  eventKey: string
  network: string
  token: string
  side: 'buy' | 'sell'
  txHash: string
  /** The account that bought (or sold). */
  buyer: string
  amount: bigint
  /** The other side of the trade: what a buyer paid, or what a seller received. */
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
  unit: string
  min_usd: number
  step_usd: number
  max_emoji: number
  media_kind: string | null
  media_file_id: string | null
  sells: number
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
  unit: r.unit === 'USD' ? 'USD' : 'NEAR',
  minNear: BigInt(r.min_near),
  minUsd: r.min_usd,
  emoji: r.emoji,
  stepNear: BigInt(r.step_near),
  stepUsd: r.step_usd,
  maxEmoji: r.max_emoji,
  media: r.media_file_id && (r.media_kind === 'photo' || r.media_kind === 'animation' || r.media_kind === 'video') ? { kind: r.media_kind, fileId: r.media_file_id } : null,
  sells: r.sells === 1,
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
  side: string
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
  side: r.side === 'sell' ? 'sell' : 'buy',
  txHash: r.tx_hash,
  buyer: r.buyer,
  amount: BigInt(r.amount),
  paid: (JSON.parse(r.paid) as { asset: string; amount: string }[]).map((p) => ({ asset: p.asset, amount: BigInt(p.amount) })),
  blockHeight: r.block_height,
  detectedAt: r.detected_at,
})

export class BuybotStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── configurations ───────────────────────────────────────────────────────

  async addConfig(c: {
    chatId: number
    chatTitle: string | null
    network: string
    token: string
    symbol: string
    name: string
    decimals: number
    createdBy: number
  }): Promise<BuybotConfig> {
    return this.db.tx(async () => {
      if ((await this.configsForChat(c.chatId)).length >= MAX_CONFIGS_PER_CHAT) throw new Error(`A chat can follow at most ${MAX_CONFIGS_PER_CHAT} tokens`)
      const t = this.now()
      const row = await this.db.get<{ id: number }>(
        `INSERT INTO buybot_configs (chat_id, chat_title, network, token, symbol, name, decimals, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [c.chatId, c.chatTitle, c.network, c.token, c.symbol, c.name, c.decimals, c.createdBy, t, t],
      )
      return (await this.config(row?.id ?? 0)) as BuybotConfig
    })
  }

  async config(id: number): Promise<BuybotConfig | null> {
    const r = await this.db.get<ConfigRow>('SELECT * FROM buybot_configs WHERE id = ?', [id])
    return r ? toConfig(r) : null
  }

  async findConfig(chatId: number, network: string, token: string): Promise<BuybotConfig | null> {
    const r = await this.db.get<ConfigRow>('SELECT * FROM buybot_configs WHERE chat_id = ? AND network = ? AND token = ?', [chatId, network, token])
    return r ? toConfig(r) : null
  }

  async configsForChat(chatId: number): Promise<BuybotConfig[]> {
    return (await this.db.all<ConfigRow>('SELECT * FROM buybot_configs WHERE chat_id = ? ORDER BY id', [chatId])).map(toConfig)
  }

  async updateConfig(
    id: number,
    patch: Partial<
      Pick<BuybotConfig, 'enabled' | 'unit' | 'minNear' | 'minUsd' | 'emoji' | 'stepNear' | 'stepUsd' | 'maxEmoji' | 'media' | 'sells' | 'silent' | 'chatTitle' | 'pausedReason'>
    >,
  ): Promise<BuybotConfig | null> {
    const cur = await this.config(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    await this.db.run(
      `UPDATE buybot_configs SET enabled = ?, unit = ?, min_near = ?, min_usd = ?, emoji = ?, step_near = ?, step_usd = ?, max_emoji = ?, media_kind = ?, media_file_id = ?,
         sells = ?, silent = ?, chat_title = ?, paused_reason = ?, updated_at = ? WHERE id = ?`,
      [
        next.enabled ? 1 : 0,
        next.unit,
        next.minNear.toString(),
        next.minUsd,
        next.emoji,
        next.stepNear.toString(),
        next.stepUsd,
        next.maxEmoji,
        next.media?.kind ?? null,
        next.media?.fileId ?? null,
        next.sells ? 1 : 0,
        next.silent ? 1 : 0,
        next.chatTitle,
        next.pausedReason,
        this.now(),
        id,
      ],
    )
    return this.config(id)
  }

  /** Every token a chat follows: on (true) or off (false) at once. */
  async setChatEnabled(chatId: number, enabled: boolean): Promise<number> {
    return this.db.run('UPDATE buybot_configs SET enabled = ?, paused_reason = NULL, updated_at = ? WHERE chat_id = ?', [enabled ? 1 : 0, this.now(), chatId])
  }

  async removeConfig(id: number): Promise<void> {
    await this.db.run('DELETE FROM buybot_configs WHERE id = ?', [id])
  }

  /** Tokens at least one chat wants posts for right now. */
  async activeTokens(network: string): Promise<string[]> {
    return (
      await this.db.all<{ token: string }>('SELECT DISTINCT token FROM buybot_configs WHERE network = ? AND enabled = 1 AND paused_reason IS NULL ORDER BY token', [network])
    ).map((r) => r.token)
  }

  async activeConfigsFor(network: string, token: string): Promise<BuybotConfig[]> {
    return (
      await this.db.all<ConfigRow>('SELECT * FROM buybot_configs WHERE network = ? AND token = ? AND enabled = 1 AND paused_reason IS NULL ORDER BY id', [network, token])
    ).map(toConfig)
  }

  /** The bot can't post there any more (removed, blocked): stop until someone re-enables it. */
  async pauseChat(chatId: number, reason: string): Promise<void> {
    await this.db.run('UPDATE buybot_configs SET paused_reason = ?, updated_at = ? WHERE chat_id = ?', [reason, this.now(), chatId])
  }

  async resumeChat(chatId: number): Promise<void> {
    await this.db.run('UPDATE buybot_configs SET paused_reason = NULL, updated_at = ? WHERE chat_id = ?', [this.now(), chatId])
  }

  /** A group became a supergroup and got a new ID. */
  async migrateChat(from: number, to: number): Promise<void> {
    await this.db.run('UPDATE buybot_configs SET chat_id = ?, updated_at = ? WHERE chat_id = ?', [to, this.now(), from])
  }

  // ─── cursors and candidates ───────────────────────────────────────────────

  /** Height up to which a token's history has been read. */
  async tokenCursor(network: string, token: string): Promise<number | null> {
    const v = (await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [`buybot_cursor_${network}_${token}`]))?.value
    return v === undefined ? null : Number(v)
  }

  async tokenCursors(network: string): Promise<{ token: string; height: number }[]> {
    const prefix = `buybot_cursor_${network}_`
    return (await this.db.all<{ key: string; value: string }>('SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?', [prefix.length, prefix])).map((r) => ({
      token: r.key.slice(prefix.length),
      height: Number(r.value),
    }))
  }

  /** Records a token's new transactions and moves its cursor, all at once. Known transactions are skipped. */
  async advanceToken(network: string, token: string, height: number, found: { txHash: string; blockHeight: number }[]): Promise<void> {
    await this.db.tx(async () => {
      const t = this.now()
      for (const c of found) {
        const existing = await this.db.get<{ tokens: string; done_at: number | null }>('SELECT tokens, done_at FROM buybot_candidates WHERE tx_hash = ?', [c.txHash])
        if (!existing) {
          await this.db.run('INSERT INTO buybot_candidates (tx_hash, network, tokens, block_height, first_seen, next_at) VALUES (?, ?, ?, ?, ?, ?)', [
            c.txHash,
            network,
            JSON.stringify([token]),
            c.blockHeight,
            t,
            t,
          ])
        } else if (existing.done_at === null) {
          const tokens = JSON.parse(existing.tokens) as string[]
          if (!tokens.includes(token)) await this.db.run('UPDATE buybot_candidates SET tokens = ? WHERE tx_hash = ?', [JSON.stringify([...tokens, token]), c.txHash])
        }
      }
      await this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`buybot_cursor_${network}_${token}`, String(height)])
    })
  }

  async dueCandidates(network: string, limit = 10): Promise<Candidate[]> {
    return (
      await this.db.all<{
        tx_hash: string
        network: string
        tokens: string
        block_height: number
        first_seen: number
        attempts: number
      }>('SELECT * FROM buybot_candidates WHERE network = ? AND done_at IS NULL AND next_at <= ? ORDER BY block_height, first_seen LIMIT ?', [network, this.now(), limit])
    ).map((r) => ({
      txHash: r.tx_hash,
      network: r.network,
      tokens: JSON.parse(r.tokens) as string[],
      blockHeight: r.block_height,
      firstSeen: r.first_seen,
      attempts: r.attempts,
    }))
  }

  async retryCandidate(txHash: string, delayMs: number): Promise<number> {
    await this.db.run('UPDATE buybot_candidates SET attempts = attempts + 1, next_at = ? WHERE tx_hash = ?', [this.now() + delayMs, txHash])
    return (await this.db.get<{ attempts: number }>('SELECT attempts FROM buybot_candidates WHERE tx_hash = ?', [txHash]))?.attempts ?? 0
  }

  /** Read (or given up on): kept as a marker so the same transaction isn't read again. */
  async finishCandidate(txHash: string): Promise<void> {
    await this.db.run('UPDATE buybot_candidates SET done_at = ? WHERE tx_hash = ?', [this.now(), txHash])
  }

  // ─── buys and deliveries ──────────────────────────────────────────────────

  /**
   * Records a buy once and queues one delivery per chat that wants it. Returns
   * false when this buy was already recorded (a restart re-read the block).
   */
  async recordBuy(event: Omit<BuyEvent, 'detectedAt'>, configIds: number[]): Promise<boolean> {
    return this.db.tx(async () => {
      const t = this.now()
      const inserted = await this.db.run(
        `INSERT INTO buybot_events (event_key, network, token, side, tx_hash, buyer, amount, paid, block_height, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          event.eventKey,
          event.network,
          event.token,
          event.side,
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
        await this.db.run(
          `INSERT INTO buybot_deliveries (event_key, config_id, status, next_at, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`,
          [event.eventKey, id, t, t, t],
        )
      }
      return true
    })
  }

  async event(eventKey: string): Promise<BuyEvent | null> {
    const r = await this.db.get<Parameters<typeof toEvent>[0]>('SELECT * FROM buybot_events WHERE event_key = ?', [eventKey])
    return r ? toEvent(r) : null
  }

  async dueDeliveries(limit = 20): Promise<{ eventKey: string; configId: number; attempts: number }[]> {
    return (
      await this.db.all<{ event_key: string; config_id: number; attempts: number }>(
        `SELECT event_key, config_id, attempts FROM buybot_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY created_at LIMIT ?`,
        [this.now(), limit],
      )
    ).map((r) => ({ eventKey: r.event_key, configId: r.config_id, attempts: r.attempts }))
  }

  async markSent(eventKey: string, configId: number, messageId: number): Promise<void> {
    await this.db.run(
      `UPDATE buybot_deliveries SET status = 'sent', message_id = ?, attempts = attempts + 1, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`,
      [messageId, this.now(), eventKey, configId],
    )
  }

  async markRetry(eventKey: string, configId: number, delayMs: number, error: string): Promise<void> {
    await this.db.run(`UPDATE buybot_deliveries SET attempts = attempts + 1, next_at = ?, error = ?, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`, [
      this.now() + delayMs,
      error.slice(0, 300),
      this.now(),
      eventKey,
      configId,
    ])
  }

  async markDone(eventKey: string, configId: number, status: 'skipped' | 'failed', reason: string): Promise<void> {
    await this.db.run(`UPDATE buybot_deliveries SET status = ?, error = ?, updated_at = ? WHERE event_key = ? AND config_id = ? AND status = 'pending'`, [
      status,
      reason.slice(0, 300),
      this.now(),
      eventKey,
      configId,
    ])
  }

  async delivery(eventKey: string, configId: number): Promise<{ status: DeliveryStatus; attempts: number; messageId: number | null; error: string | null } | null> {
    const r = await this.db.get<{ status: DeliveryStatus; attempts: number; message_id: number | null; error: string | null }>(
      'SELECT status, attempts, message_id, error FROM buybot_deliveries WHERE event_key = ? AND config_id = ?',
      [eventKey, configId],
    )
    return r ? { status: r.status, attempts: r.attempts, messageId: r.message_id, error: r.error } : null
  }

  // ─── status and housekeeping ──────────────────────────────────────────────

  async stats(network: string, configIds: number[]): Promise<{ candidates: number; pending: number; sent: number; failed: number; lastBuyAt: number | null }> {
    const ids = configIds.length ? configIds : [-1]
    const marks = ids.map(() => '?').join(',')
    const count = async (status: string) =>
      (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM buybot_deliveries WHERE status = ? AND config_id IN (${marks})`, [status, ...ids]))?.n ?? 0
    return {
      candidates: (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM buybot_candidates WHERE network = ? AND done_at IS NULL', [network]))?.n ?? 0,
      pending: await count('pending'),
      sent: await count('sent'),
      failed: await count('failed'),
      lastBuyAt:
        (
          await this.db.get<{ at: number | null }>(
            `SELECT MAX(e.detected_at) AS at FROM buybot_events e JOIN buybot_deliveries d ON d.event_key = e.event_key WHERE d.config_id IN (${marks})`,
            ids,
          )
        )?.at ?? null,
    }
  }

  /** Forgets buys (and their deliveries) older than `ageMs`, and done candidates after an hour. */
  async prune(ageMs: number): Promise<void> {
    await this.db.tx(async () => {
      await this.db.run('DELETE FROM buybot_events WHERE detected_at < ?', [this.now() - ageMs])
      await this.db.run('DELETE FROM buybot_candidates WHERE done_at IS NOT NULL AND done_at < ?', [this.now() - 3_600_000])
    })
  }
}
