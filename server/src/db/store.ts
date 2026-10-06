import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { randomToken } from '../ids'
import type { Database } from './database'

/**
 * Everything the bot keeps, behind typed methods. Nothing secret is stored:
 * Telegram IDs and names, public NEAR account IDs and keys, preferences, and
 * short-lived conversation state. Link codes are stored only as SHA-256.
 */

export interface TelegramUser {
  userId: number
  username: string | null
  firstName: string
  languageCode: string | null
}

export interface Settings {
  slippagePct: number
  /** NEAR amounts for the buy buttons, as exact decimal strings. */
  buyPresets: string[]
  /** Percentages for the sell buttons. */
  sellPresets: number[]
  /** Linked account trades use unless the user picks another. */
  defaultAccount: string | null
  /** Message the user when a trade prepared here is confirmed or fails. */
  notifyTrades: boolean
  /** The NearKit wallet Telegram trades from (its ID); the first active one when unset or closed. */
  activeWallet: string | null
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  slippagePct: DEFAULT_SLIPPAGE,
  buyPresets: ['0.1', '0.5', '1', '5'],
  sellPresets: [25, 50, 75, 100],
  defaultAccount: null,
  notifyTrades: true,
  activeWallet: null,
})

export interface LinkRequest {
  codeHash: string
  userId: number
  network: string
  /** Base64 of the 32-byte NEP-413 nonce. */
  nonce: string
  /** The exact message the wallet signs. */
  message: string
  createdAt: number
  expiresAt: number
  attempts: number
  usedAt: number | null
  linkedAccount: string | null
}

export interface AccountLink {
  network: string
  accountId: string
  userId: number
  publicKey: string
  linkedAt: number
}

export class LinkError extends Error {
  constructor(
    readonly code: 'unknown' | 'expired' | 'used' | 'owner' | 'network',
    message: string,
  ) {
    super(message)
    this.name = 'LinkError'
  }
}

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export class Store {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ─── users ────────────────────────────────────────────────────────────────

  async upsertUser(u: TelegramUser): Promise<void> {
    const t = this.now()
    await this.db.run(
      `INSERT INTO telegram_users (user_id, username, first_name, language_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, language_code = excluded.language_code, updated_at = excluded.updated_at, blocked_at = NULL`,
      [u.userId, u.username, u.firstName, u.languageCode, t, t],
    )
  }

  async getUser(userId: number): Promise<(TelegramUser & { blockedAt: number | null }) | null> {
    const r = await this.db.get<{ user_id: number; username: string | null; first_name: string; language_code: string | null; blocked_at: number | null }>(
      'SELECT user_id, username, first_name, language_code, blocked_at FROM telegram_users WHERE user_id = ?',
      [userId],
    )
    return r ? { userId: r.user_id, username: r.username, firstName: r.first_name, languageCode: r.language_code, blockedAt: r.blocked_at } : null
  }

  /** The user blocked the bot (Telegram answered 403): stop messaging them until they return. */
  async markBlocked(userId: number): Promise<void> {
    await this.db.run('UPDATE telegram_users SET blocked_at = ? WHERE user_id = ?', [this.now(), userId])
  }

  // ─── settings ─────────────────────────────────────────────────────────────

  async getSettings(userId: number): Promise<Settings> {
    const r = await this.db.get<{
      slippage_pct: number
      buy_presets: string
      sell_presets: string
      default_account: string | null
      notify_trades: number
      active_wallet: string | null
    }>('SELECT slippage_pct, buy_presets, sell_presets, default_account, notify_trades, active_wallet FROM user_settings WHERE user_id = ?', [userId])
    if (!r) return { ...DEFAULT_SETTINGS, buyPresets: [...DEFAULT_SETTINGS.buyPresets], sellPresets: [...DEFAULT_SETTINGS.sellPresets] }
    return {
      slippagePct: r.slippage_pct,
      buyPresets: json<string[]>(r.buy_presets, [...DEFAULT_SETTINGS.buyPresets]),
      sellPresets: json<number[]>(r.sell_presets, [...DEFAULT_SETTINGS.sellPresets]),
      defaultAccount: r.default_account,
      notifyTrades: r.notify_trades === 1,
      activeWallet: r.active_wallet,
    }
  }

  async updateSettings(userId: number, patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings(userId)), ...patch }
    await this.db.run(
      `INSERT INTO user_settings (user_id, slippage_pct, buy_presets, sell_presets, default_account, notify_trades, active_wallet, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET slippage_pct = excluded.slippage_pct, buy_presets = excluded.buy_presets, sell_presets = excluded.sell_presets,
         default_account = excluded.default_account, notify_trades = excluded.notify_trades, active_wallet = excluded.active_wallet, updated_at = excluded.updated_at`,
      [userId, next.slippagePct, JSON.stringify(next.buyPresets), JSON.stringify(next.sellPresets), next.defaultAccount, next.notifyTrades ? 1 : 0, next.activeWallet, this.now()],
    )
    return next
  }

  // ─── link requests ────────────────────────────────────────────────────────

  async createLinkRequest(r: { codeHash: string; userId: number; network: string; nonce: string; message: string; ttlMs: number }): Promise<LinkRequest> {
    const t = this.now()
    await this.db.run('INSERT INTO link_requests (code_hash, user_id, network, nonce, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      r.codeHash,
      r.userId,
      r.network,
      r.nonce,
      r.message,
      t,
      t + r.ttlMs,
    ])
    return (await this.getLinkRequest(r.codeHash)) as LinkRequest
  }

  async getLinkRequest(codeHash: string): Promise<LinkRequest | null> {
    const r = await this.db.get<{
      code_hash: string
      user_id: number
      network: string
      nonce: string
      message: string
      created_at: number
      expires_at: number
      attempts: number
      used_at: number | null
      linked_account: string | null
    }>('SELECT * FROM link_requests WHERE code_hash = ?', [codeHash])
    return r
      ? {
          codeHash: r.code_hash,
          userId: r.user_id,
          network: r.network,
          nonce: r.nonce,
          message: r.message,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          attempts: r.attempts,
          usedAt: r.used_at,
          linkedAccount: r.linked_account,
        }
      : null
  }

  async bumpLinkAttempt(codeHash: string): Promise<number> {
    await this.db.run('UPDATE link_requests SET attempts = attempts + 1 WHERE code_hash = ?', [codeHash])
    return (await this.getLinkRequest(codeHash))?.attempts ?? 0
  }

  async countLinkRequestsSince(userId: number, since: number): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM link_requests WHERE user_id = ? AND created_at >= ?', [userId, since]))?.n ?? 0
  }

  // ─── account links ────────────────────────────────────────────────────────

  async linksOf(userId: number, network: string): Promise<AccountLink[]> {
    return (
      await this.db.all<{
        network: string
        account_id: string
        user_id: number
        public_key: string
        linked_at: number
      }>('SELECT * FROM account_links WHERE user_id = ? AND network = ? ORDER BY linked_at', [userId, network])
    ).map((r) => ({ network: r.network, accountId: r.account_id, userId: r.user_id, publicKey: r.public_key, linkedAt: r.linked_at }))
  }

  async linkOf(network: string, accountId: string): Promise<AccountLink | null> {
    const r = await this.db.get<{ network: string; account_id: string; user_id: number; public_key: string; linked_at: number }>(
      'SELECT * FROM account_links WHERE network = ? AND account_id = ?',
      [network, accountId],
    )
    return r ? { network: r.network, accountId: r.account_id, userId: r.user_id, publicKey: r.public_key, linkedAt: r.linked_at } : null
  }

  /**
   * Uses up a verified link request and links the account, all at once. If the
   * account was linked to another Telegram user, that link ends here and the
   * caller is told whom to notify. Signature checks happen before this call.
   */
  async completeLink(r: { codeHash: string; network: string; accountId: string; userId: number; publicKey: string }): Promise<{ previousUserId: number | null }> {
    return this.db.tx(async () => {
      const req = await this.getLinkRequest(r.codeHash)
      const t = this.now()
      if (!req) throw new LinkError('unknown', 'This link code is unknown')
      if (req.usedAt !== null) throw new LinkError('used', 'This link code was already used')
      if (t > req.expiresAt) throw new LinkError('expired', 'This link code expired')
      if (req.userId !== r.userId) throw new LinkError('owner', 'This link code belongs to another Telegram account')
      if (req.network !== r.network) throw new LinkError('network', `This link code is for the ${req.network} network`)
      const previous = await this.linkOf(r.network, r.accountId)
      const previousUserId = previous && previous.userId !== r.userId ? previous.userId : null
      // Used up only if still unused: two completions racing (two instances) link one account, never two.
      const used = await this.db.run('UPDATE link_requests SET used_at = ?, linked_account = ? WHERE code_hash = ? AND used_at IS NULL', [t, r.accountId, r.codeHash])
      if (used !== 1) throw new LinkError('used', 'This link code was already used')
      if (previousUserId !== null) {
        await this.db.run('INSERT INTO link_events (network, account_id, user_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)', [
          r.network,
          r.accountId,
          previousUserId,
          'moved-away',
          `to ${r.userId}`,
          t,
        ])
        await this.clearDefaultIf(previousUserId, r.accountId)
      }
      await this.db.run(
        `INSERT INTO account_links (network, account_id, user_id, public_key, linked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(network, account_id) DO UPDATE SET user_id = excluded.user_id, public_key = excluded.public_key, linked_at = excluded.linked_at`,
        [r.network, r.accountId, r.userId, r.publicKey, t],
      )
      await this.db.run('INSERT INTO link_events (network, account_id, user_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)', [
        r.network,
        r.accountId,
        r.userId,
        'linked',
        r.publicKey,
        t,
      ])
      return { previousUserId }
    })
  }

  async unlink(network: string, accountId: string, userId: number): Promise<boolean> {
    return this.db.tx(async () => {
      const changed = await this.db.run('DELETE FROM account_links WHERE network = ? AND account_id = ? AND user_id = ?', [network, accountId, userId])
      if (changed === 0) return false
      await this.db.run('INSERT INTO link_events (network, account_id, user_id, kind, detail, at) VALUES (?, ?, ?, ?, NULL, ?)', [
        network,
        accountId,
        userId,
        'unlinked',
        this.now(),
      ])
      await this.clearDefaultIf(userId, accountId)
      return true
    })
  }

  private async clearDefaultIf(userId: number, accountId: string) {
    await this.db.run('UPDATE user_settings SET default_account = NULL WHERE user_id = ? AND default_account = ?', [userId, accountId])
  }

  async linkEvents(network: string, accountId: string): Promise<{ kind: string; userId: number; at: number }[]> {
    return (
      await this.db.all<{ kind: string; user_id: number; at: number }>('SELECT kind, user_id, at FROM link_events WHERE network = ? AND account_id = ? ORDER BY id', [
        network,
        accountId,
      ])
    ).map((r) => ({ kind: r.kind, userId: r.user_id, at: r.at }))
  }

  // ─── conversation state ───────────────────────────────────────────────────

  async getSession<T = Record<string, unknown>>(chatId: number, userId: number): Promise<{ flow: string; data: T; expiresAt: number } | null> {
    const r = await this.db.get<{ flow: string; data: string; expires_at: number }>('SELECT flow, data, expires_at FROM sessions WHERE chat_id = ? AND user_id = ?', [
      chatId,
      userId,
    ])
    if (!r || r.expires_at < this.now()) return null
    return { flow: r.flow, data: json<T>(r.data, {} as T), expiresAt: r.expires_at }
  }

  async setSession(chatId: number, userId: number, flow: string, data: unknown, ttlMs: number): Promise<void> {
    await this.db.run(
      `INSERT INTO sessions (chat_id, user_id, flow, data, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET flow = excluded.flow, data = excluded.data, expires_at = excluded.expires_at`,
      [chatId, userId, flow, JSON.stringify(data), this.now() + ttlMs],
    )
  }

  async clearSession(chatId: number, userId: number): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE chat_id = ? AND user_id = ?', [chatId, userId])
  }

  // ─── callback payloads ────────────────────────────────────────────────────

  async putCallback(payload: unknown, userId: number, chatId: number, ttlMs: number): Promise<string> {
    const id = randomToken(12)
    await this.db.run('INSERT INTO callbacks (id, user_id, chat_id, payload, expires_at) VALUES (?, ?, ?, ?, ?)', [id, userId, chatId, JSON.stringify(payload), this.now() + ttlMs])
    return id
  }

  /** Only the user the button was made for can use it. */
  async getCallback<T = unknown>(id: string, userId: number): Promise<T | null> {
    const r = await this.db.get<{ payload: string; user_id: number; expires_at: number }>('SELECT payload, user_id, expires_at FROM callbacks WHERE id = ?', [id])
    if (!r || r.user_id !== userId || r.expires_at < this.now()) return null
    return json<T | null>(r.payload, null)
  }

  // ─── user tokens ──────────────────────────────────────────────────────────

  async addUserToken(userId: number, network: string, contract: string): Promise<void> {
    await this.db.run('INSERT INTO user_tokens (user_id, network, contract, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [userId, network, contract, this.now()])
  }

  async userTokens(userId: number, network: string): Promise<string[]> {
    return (await this.db.all<{ contract: string }>('SELECT contract FROM user_tokens WHERE user_id = ? AND network = ? ORDER BY added_at', [userId, network])).map(
      (r) => r.contract,
    )
  }

  // ─── meta ─────────────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    return (await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  /**
   * Counts this start in the database file. `boot` goes up by one on every start
   * that found the previous data; `since` is when the first one happened. After a
   * restart or redeploy, boot 1 again means the data did not survive.
   */
  async recordBoot(): Promise<{ boot: number; since: number }> {
    return this.db.tx(async () => {
      const boot = Number((await this.getMeta('boots')) ?? '0') + 1
      const since = Number((await this.getMeta('first_boot_at')) ?? String(this.now()))
      await this.setMeta('boots', String(boot))
      await this.setMeta('first_boot_at', String(since))
      return { boot, since }
    })
  }

  // ─── housekeeping ─────────────────────────────────────────────────────────

  /** Drops expired conversation state, callbacks and day-old link requests. */
  async prune(): Promise<void> {
    const t = this.now()
    await this.db.tx(async () => {
      await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [t])
      await this.db.run('DELETE FROM callbacks WHERE expires_at < ?', [t])
      await this.db.run('DELETE FROM link_requests WHERE expires_at < ?', [t - 86_400_000])
    })
  }

  async counts(): Promise<Record<string, number>> {
    const n = async (table: string) => (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0
    return {
      users: await n('telegram_users'),
      links: await n('account_links'),
      sessions: await n('sessions'),
      callbacks: await n('callbacks'),
      linkRequests: await n('link_requests'),
    }
  }
}
