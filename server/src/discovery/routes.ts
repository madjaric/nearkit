import {
  CANDLE_INTERVALS,
  LAUNCH_PERIODS,
  MAX_FOLLOWS,
  type CandleInterval,
  type LaunchPeriod,
  type WalletCategory,
  type WalletMetric,
  type WalletWindowKey,
} from '@/lib/discovery/api'
import { isValidAccountId } from '@/lib/validation'
import { field } from '../api/linkRoutes'
import { HttpError, type Route } from '../api/http'
import type { WebSessions } from '../web/sessions'
import type { DiscoveryService } from './service'
import type { DiscoveryStore } from './store'

/**
 * Launch Radar's and Top Wallets' API (DISCOVERY.md). The `/api/discovery/*` routes are public and
 * read-only: one cached answer for everyone, rate-limited per IP (api/limits.ts). Followed wallets
 * (`/api/web/discovery/*`) carry the NEARKITS web session; their alerts are Telegram messages from the bot.
 */

const WINDOWS: readonly WalletWindowKey[] = ['7d', '30d', '90d', 'all']
const METRICS: readonly WalletMetric[] = ['pnl', 'return', 'winrate', 'activity']
const CATEGORIES: readonly WalletCategory[] = ['all', 'smart', 'traders', 'early', 'fresh']

const obj = (body: unknown): Record<string, unknown> => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {})
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback)

function account(v: unknown, name = 'account'): string {
  const a = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!a || a.length > 64 || !isValidAccountId(a)) throw new HttpError(400, 'account', `"${name}" must be a NEAR account.`)
  return a
}

function accounts(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return [
    ...new Set(
      v
        .slice(0, max)
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().toLowerCase()),
    ),
  ].filter((x) => x.length <= 64 && isValidAccountId(x))
}

/** A source failure as a 503 the page can explain; anything else as it was. */
async function fromSource<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(503, 'source', 'NEARKITS can’t read this from its data source right now. Try again in a moment.')
  }
}

export function discoveryRoutes(deps: { service: DiscoveryService; store: DiscoveryStore; network: string; sessions: WebSessions | null }): Record<string, Route> {
  const { service } = deps
  const userOf = async (body: unknown): Promise<number> => {
    if (!deps.sessions) throw new HttpError(503, 'off', 'NEARKITS web sign-in isn’t running on this server.')
    const userId = await deps.sessions.userOf(field(body, 'session', 64))
    if (userId === null) throw new HttpError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
    return userId
  }
  return {
    '/api/discovery/status': async () => service.status(),
    '/api/discovery/launches': async (body) => fromSource(() => service.launches(oneOf<LaunchPeriod>(obj(body).period, LAUNCH_PERIODS, '24h'))),
    '/api/discovery/extras': async (body) => {
      const raw = obj(body).tokens
      const tokens = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length <= 128 && isValidAccountId(x)).slice(0, 60) : []
      return fromSource(() => service.extras(tokens))
    },
    '/api/discovery/launch': async (body) => {
      const token = account(obj(body).token, 'token')
      const d = await fromSource(() => service.launch(token))
      if (!d) throw new HttpError(404, 'not-found', 'NEARKITS hasn’t seen this token.')
      return d
    },
    '/api/discovery/candles': async (body) => {
      const b = obj(body)
      const token = account(b.token, 'token')
      if (typeof b.interval !== 'string' || !(CANDLE_INTERVALS as readonly string[]).includes(b.interval))
        throw new HttpError(400, 'bad-request', `interval: one of ${CANDLE_INTERVALS.join(', ')}`)
      const interval = b.interval as CandleInterval
      const c = await fromSource(() => service.candles(token, interval))
      if (!c) throw new HttpError(404, 'not-found', 'NEARKITS has no candles for this token.')
      return c
    },
    '/api/discovery/wallets': async (body) => {
      const b = obj(body)
      const limit = Math.min(100, Math.max(1, Number.isInteger(b.limit) ? Number(b.limit) : 100))
      const search = typeof b.search === 'string' ? b.search.slice(0, 64) : undefined
      return fromSource(() =>
        service.wallets({
          window: oneOf(b.window, WINDOWS, 'all'),
          metric: oneOf(b.metric, METRICS, 'pnl'),
          category: oneOf(b.category, CATEGORIES, 'all'),
          limit,
          ...(search ? { search } : {}),
        }),
      )
    },
    '/api/discovery/wallet': async (body) => {
      const a = account(obj(body).account)
      const d = await fromSource(() => service.wallet(a))
      if (!d) throw new HttpError(404, 'not-found', 'No indexed swap by this account yet.')
      return d
    },
    '/api/discovery/wallet/trades': async (body) => {
      const b = obj(body)
      const a = account(b.account)
      const cursor = typeof b.cursor === 'string' && b.cursor.length <= 128 ? b.cursor : null
      return fromSource(() => service.walletTrades(a, cursor))
    },
    '/api/discovery/signals': async (body) => {
      const b = obj(body)
      const since = typeof b.since === 'number' && Number.isFinite(b.since) ? b.since : 0
      return { trades: await fromSource(() => service.signals(accounts(b.wallets, MAX_FOLLOWS), since)) }
    },
    '/api/web/discovery/follows': async (body) => ({ follows: await deps.store.follows(await userOf(body), deps.network) }),
    '/api/web/discovery/follow': async (body) => {
      const userId = await userOf(body)
      const b = obj(body)
      const a = account(b.account)
      const existing = await deps.store.follows(userId, deps.network)
      if (!existing.some((f) => f.account === a) && existing.length >= MAX_FOLLOWS)
        throw new HttpError(409, 'limit', `You follow ${MAX_FOLLOWS} wallets already. Unfollow one first.`)
      await deps.store.follow(userId, deps.network, a, b.alerts === true)
      return { follows: await deps.store.follows(userId, deps.network) }
    },
    '/api/web/discovery/unfollow': async (body) => {
      const userId = await userOf(body)
      await deps.store.unfollow(userId, deps.network, account(obj(body).account))
      return { follows: await deps.store.follows(userId, deps.network) }
    },
  }
}
