import { createHash, randomBytes } from 'node:crypto'
import type { Database } from '../db/database'

/**
 * Signing in to NearKit web as a Telegram user, with no password and no linked wallet:
 * - the bot sends a one-time link in the user's own chat (`issueCode`); it opens NearKit web
 *   with the code in the URL fragment, which never reaches a server log or a link preview;
 * - NearKit web trades it for a session (`redeem`), once, within WEB_LOGIN_TTL_MS;
 * - each API call carries the session token in its JSON body (no cookies, so no CSRF).
 *
 * Codes and tokens are random 256-bit values; only their SHA-256 is stored. A session can list,
 * create and rename the user's NearKit wallets and prepare trades and sends: every trade and send
 * is still confirmed by the user in Telegram, so a session can't move funds on its own.
 */

export const WEB_LOGIN_TTL_MS = 10 * 60_000
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60_000
export const WEB_LOGIN_CODES_PER_HOUR = 5

/** 32 random bytes, base64url: 43 characters. */
const SECRET = /^[A-Za-z0-9_-]{43}$/
const secret = () => randomBytes(32).toString('base64url')
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex')

export class WebLoginLimitError extends Error {
  constructor() {
    super(`Too many sign-in links this hour (${WEB_LOGIN_CODES_PER_HOUR}). Use the last one, or try again later.`)
    this.name = 'WebLoginLimitError'
  }
}

export class WebSessions {
  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  /** A one-time sign-in code for this Telegram user. */
  async issueCode(userId: number): Promise<string> {
    const t = this.now()
    const recent = await this.db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM web_login_codes WHERE user_id = ? AND created_at > ?', [userId, t - 3_600_000])
    if (Number(recent?.n ?? 0) >= WEB_LOGIN_CODES_PER_HOUR) throw new WebLoginLimitError()
    const code = secret()
    await this.db.run('INSERT INTO web_login_codes (code_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)', [
      hashOf(code),
      userId,
      t,
      t + WEB_LOGIN_TTL_MS,
    ])
    return code
  }

  /** A session for the code's user; null for a code that is unknown, expired or used. Once only. */
  async redeem(code: string): Promise<{ token: string; userId: number; expiresAt: number } | null> {
    if (!SECRET.test(code)) return null
    const t = this.now()
    return this.db.tx(async () => {
      const row = await this.db.get<{ user_id: number | string; expires_at: number | string; used_at: number | string | null }>(
        'SELECT user_id, expires_at, used_at FROM web_login_codes WHERE code_hash = ?',
        [hashOf(code)],
      )
      if (!row || row.used_at !== null || Number(row.expires_at) < t) return null
      // Whoever marks it used first gets the session.
      const moved = await this.db.run('UPDATE web_login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [t, hashOf(code)])
      if (moved !== 1) return null
      const token = secret()
      const expiresAt = t + WEB_SESSION_TTL_MS
      await this.db.run('INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)', [
        hashOf(token),
        Number(row.user_id),
        t,
        expiresAt,
      ])
      return { token, userId: Number(row.user_id), expiresAt }
    })
  }

  /** The Telegram user a live session belongs to; null for anything else. */
  async userOf(token: string): Promise<number | null> {
    if (!SECRET.test(token)) return null
    const row = await this.db.get<{ user_id: number | string; expires_at: number | string; revoked_at: number | string | null }>(
      'SELECT user_id, expires_at, revoked_at FROM web_sessions WHERE token_hash = ?',
      [hashOf(token)],
    )
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= this.now()) return null
    return Number(row.user_id)
  }

  /** Signs this session out. */
  async revoke(token: string): Promise<void> {
    if (!SECRET.test(token)) return
    await this.db.run('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [this.now(), hashOf(token)])
  }

  /** Signs every live session of this user out; how many there were. */
  async revokeAll(userId: number): Promise<number> {
    const t = this.now()
    return this.db.run('UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', [t, userId, t])
  }

  /** Drops codes and sessions long over (housekeeping). */
  async prune(): Promise<void> {
    const cutoff = this.now() - 24 * 60 * 60_000
    await this.db.run('DELETE FROM web_login_codes WHERE expires_at < ?', [cutoff])
    await this.db.run('DELETE FROM web_sessions WHERE expires_at < ?', [cutoff])
  }
}
