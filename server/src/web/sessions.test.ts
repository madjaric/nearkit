import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/schema'
import { SqliteDatabase } from '../db/sqlite'
import { Store } from '../db/store'
import { WEB_LOGIN_TTL_MS, WEB_SESSION_TTL_MS, WebLoginLimitError, WebSessions } from './sessions'

/**
 * NearKit web signs a Telegram user in with a one-time link the bot sends in their own chat:
 * no password, no /link. The code and the session token are random 256-bit values; only
 * their SHA-256 is stored.
 */

let clock: number
let db: SqliteDatabase
let sessions: WebSessions

beforeEach(async () => {
  clock = 1_800_000_000_000
  db = await SqliteDatabase.open(null)
  await migrate(db)
  const users = new Store(db, () => clock)
  await users.upsertUser({ userId: 101, username: 'alice', firstName: 'Alice', languageCode: null })
  await users.upsertUser({ userId: 202, username: 'bob', firstName: 'Bob', languageCode: null })
  sessions = new WebSessions(db, () => clock)
})

describe('web sign-in', () => {
  it('a one-time code from the bot opens a session for that Telegram user, once', async () => {
    const code = await sessions.issueCode(101)
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const s = await sessions.redeem(code)
    expect(s).toMatchObject({ userId: 101, expiresAt: clock + WEB_SESSION_TTL_MS })
    expect(s?.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await sessions.userOf(s?.token ?? '')).toBe(101)
    // The same code never opens a second session.
    expect(await sessions.redeem(code)).toBeNull()
  })

  it('keeps only hashes: neither the code nor the token is stored as is', async () => {
    const code = await sessions.issueCode(101)
    const s = await sessions.redeem(code)
    const everything = JSON.stringify([await db.all('SELECT * FROM web_login_codes'), await db.all('SELECT * FROM web_sessions')])
    expect(everything).not.toContain(code)
    expect(everything).not.toContain(s?.token)
  })

  it('refuses an expired code, an unknown one, and anything malformed', async () => {
    const code = await sessions.issueCode(101)
    clock += WEB_LOGIN_TTL_MS + 1
    expect(await sessions.redeem(code)).toBeNull()
    expect(await sessions.redeem('x'.repeat(43))).toBeNull()
    expect(await sessions.redeem('')).toBeNull()
    expect(await sessions.userOf('not-a-token')).toBeNull()
  })

  it('limits sign-in links to 5 an hour per user', async () => {
    for (let i = 0; i < 5; i++) await sessions.issueCode(101)
    await expect(sessions.issueCode(101)).rejects.toBeInstanceOf(WebLoginLimitError)
    // Another user is not affected, and the window moves on.
    await expect(sessions.issueCode(202)).resolves.toBeTruthy()
    clock += 60 * 60_000 + 1
    await expect(sessions.issueCode(101)).resolves.toBeTruthy()
  })

  it('a session ends when it expires, when it signs out, or when the user signs out everywhere', async () => {
    const a = await sessions.redeem(await sessions.issueCode(101))
    const b = await sessions.redeem(await sessions.issueCode(101))
    const c = await sessions.redeem(await sessions.issueCode(202))
    await sessions.revoke(a?.token ?? '')
    expect(await sessions.userOf(a?.token ?? '')).toBeNull()
    expect(await sessions.userOf(b?.token ?? '')).toBe(101)
    expect(await sessions.revokeAll(101)).toBe(1)
    expect(await sessions.userOf(b?.token ?? '')).toBeNull()
    // Another user's session is untouched, until it expires.
    expect(await sessions.userOf(c?.token ?? '')).toBe(202)
    clock += WEB_SESSION_TTL_MS + 1
    expect(await sessions.userOf(c?.token ?? '')).toBeNull()
  })
})
