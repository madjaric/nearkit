import type { LinkService } from '../link/service'
import { HttpError, type Route } from './http'

/** String field from a JSON body, bounded; anything else is a 400. */
export function field(body: unknown, name: string, max = 2048): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new HttpError(400, 'bad-request', `Missing or invalid "${name}"`)
  return value
}

export function linkRoutes(deps: {
  link: LinkService
  onLinked: (r: { accountId: string; userId: number; previousUserId: number | null }) => Promise<void>
}): Record<string, Route> {
  return {
    '/api/link/describe': async (body) => await deps.link.describe(field(body, 'code', 64)),
    '/api/link/confirm': async (body) => {
      const code = field(body, 'code', 64)
      const described = await deps.link.describe(code)
      const result = await deps.link.confirm({
        code,
        accountId: field(body, 'accountId', 64),
        publicKey: field(body, 'publicKey', 128),
        signature: field(body, 'signature', 256),
      })
      // Telling Telegram is best effort: the link is already saved.
      await deps.onLinked(result).catch(() => undefined)
      return { accountId: result.accountId, telegram: described.telegram, network: described.network }
    },
  }
}
