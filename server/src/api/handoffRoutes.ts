import type { Handoffs } from '../trade/handoff'
import type { Route } from './http'
import { field } from './linkRoutes'

/**
 * The web app's side of a Telegram trade: which account the trade was prepared
 * for, and the hashes its wallet signed. The server checks every hash on chain.
 */
export function handoffRoutes(handoffs: Handoffs): Record<string, Route> {
  return {
    '/api/handoff/describe': async (body) => await handoffs.describe(field(body, 'id', 64)),
    '/api/handoff/result': async (body) => {
      const hashes = typeof body === 'object' && body !== null ? (body as { txHashes?: unknown }).txHashes : undefined
      return handoffs.report(field(body, 'id', 64), hashes)
    },
  }
}
