import type { CreateStrategyInput } from '@/lib/automation/api'
import type { StrategyKind } from '@/lib/automation/config'
import { field } from '../api/linkRoutes'
import { HttpError, type Route } from '../api/http'
import type { WebSessions } from '../web/sessions'
import { AutomationError, type AutomationService } from './service'

/**
 * NEARKITS web's trading automation API: limit orders, Copy Trade, Sniper and DCA. Every call carries
 * the session token in its JSON body; the session names the user, and the service checks every
 * strategy and wallet against that user. The same service runs the Telegram bot's buttons.
 */

const STATUS: Record<AutomationError['code'], number> = {
  off: 409,
  'not-found': 404,
  wallet: 403,
  token: 400,
  limit: 409,
  busy: 409,
  confirm: 400,
  target: 409,
  pair: 400,
  state: 400,
  request: 409,
}

const KINDS: readonly StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']

export function automationRoutes(deps: { sessions: WebSessions; service: AutomationService }): Record<string, Route> {
  const { service } = deps
  const userOf = async (body: unknown): Promise<number> => {
    const userId = await deps.sessions.userOf(field(body, 'session', 64))
    if (userId === null) throw new HttpError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
    return userId
  }
  const obj = (body: unknown): Record<string, unknown> => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {})
  /** A service refusal as an HTTP answer, with the fields to fix when there are some. */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof AutomationError) throw new HttpError(STATUS[e.code], e.code, e.message, e.issues.length ? { issues: e.issues } : undefined)
      throw e
    }
  }

  return {
    '/api/web/auto/features': async (body) => {
      await userOf(body)
      return service.features()
    },

    '/api/web/auto/list': async (body) => {
      const userId = await userOf(body)
      const raw = obj(body).kinds
      const kinds = Array.isArray(raw) ? raw.filter((k): k is StrategyKind => typeof k === 'string' && KINDS.includes(k as StrategyKind)) : undefined
      return { strategies: await service.list(userId, kinds) }
    },

    '/api/web/auto/detail': async (body) => {
      const userId = await userOf(body)
      return run(() => service.detail(userId, field(body, 'id', 32)))
    },

    '/api/web/auto/preview': async (body) => {
      const userId = await userOf(body)
      return run(() => service.preview(userId, field(body, 'walletId', 64), obj(body).config))
    },

    '/api/web/auto/create': async (body) => {
      const userId = await userOf(body)
      const b = obj(body)
      const input: CreateStrategyInput = {
        walletId: field(body, 'walletId', 64),
        config: b.config as CreateStrategyInput['config'],
        ...(b.pair !== undefined && b.pair !== null ? { pair: b.pair as CreateStrategyInput['config'] } : {}),
        confirmExecute: b.confirmExecute === true,
        ...(typeof b.requestKey === 'string' ? { requestKey: b.requestKey } : {}),
      }
      return { strategies: await run(() => service.create(userId, input)) }
    },

    '/api/web/auto/pause': async (body) => {
      const userId = await userOf(body)
      return { strategy: await run(() => service.pause(userId, field(body, 'id', 32))) }
    },

    '/api/web/auto/resume': async (body) => {
      const userId = await userOf(body)
      return { strategy: await run(() => service.resume(userId, field(body, 'id', 32))) }
    },

    '/api/web/auto/cancel': async (body) => {
      const userId = await userOf(body)
      return { strategy: await run(() => service.cancel(userId, field(body, 'id', 32))) }
    },

    '/api/web/auto/pause-all': async (body) => {
      const userId = await userOf(body)
      return { paused: await service.pauseAll(userId) }
    },
  }
}
