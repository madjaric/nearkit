import { HttpError, type Route } from '../api/http'
import { field } from '../api/linkRoutes'
import type { WebSessions } from '../web/sessions'
import type { BridgeDestinationInput, BridgeQuoteInput, BridgeService } from './service'
import type { SolanaReads } from './solana'

/**
 * Bridge & Buy's public API: POST, JSON, no cookies (api/http.ts). Quote, start, deposit, status and
 * reconciliation are separate routes, each checked on its own. A NEARKITS wallet is named by the
 * NEARKITS web session (the server finds the wallet among that user's own); a connected wallet by
 * its NEAR account. An order is read by its id: a NEARKITS order only with its owner's session.
 */

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function bridgeRoutes(deps: { bridge: BridgeService; sessions: WebSessions | null; solana: SolanaReads }): Record<string, Route> {
  const { bridge } = deps

  /** The signed-in NEARKITS web user, or null without a session; 401 for a session that ended. */
  const userOf = async (body: unknown, required: boolean): Promise<number | null> => {
    const token = obj(body).session
    if (token === undefined || token === null || token === '') {
      if (required) throw new HttpError(401, 'session', 'Sign in to NEARKITS web to use your NEARKITS wallets.')
      return null
    }
    if (typeof token !== 'string' || token.length > 64 || !deps.sessions)
      throw new HttpError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
    const userId = await deps.sessions.userOf(token)
    if (userId === null) throw new HttpError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
    return userId
  }

  const inputOf = async (body: unknown): Promise<BridgeQuoteInput> => {
    const b = obj(body)
    const d = obj(b.destination)
    let destination: BridgeDestinationInput
    if (d.kind === 'nearkits') destination = { kind: 'nearkits', userId: (await userOf(body, true)) as number, walletId: field(d, 'walletId', 64) }
    else if (d.kind === 'connected') destination = { kind: 'connected', accountId: field(d, 'accountId', 64) }
    else throw new HttpError(400, 'destination', 'Choose the NEAR wallet that receives $KITS.')
    const source = b.sourceAddress
    if (source !== undefined && source !== null && (typeof source !== 'string' || source.length > 128)) throw new HttpError(400, 'source', 'That isn’t an address.')
    const slippage = b.kitsSlippagePct
    if (typeof slippage !== 'number') throw new HttpError(400, 'slippage', 'Missing slippage.')
    return { chain: field(b, 'chain', 8), amount: field(b, 'amount', 40), sourceAddress: typeof source === 'string' ? source : null, destination, kitsSlippagePct: slippage }
  }

  const orderOf = async (body: unknown) => bridge.orderFor(field(body, 'orderId', 64), await userOf(body, false))

  return {
    '/api/bridge/assets': async () => bridge.assets(),

    /** A price only: no deposit address is made and nothing can be sent to it. */
    '/api/bridge/quote': async (body) => bridge.preview(await inputOf(body)),

    /** The order and its deposit address. The user's own wallet sends; NEARKITS never holds the funds. */
    '/api/bridge/start': async (body) => bridge.start(await inputOf(body)),

    '/api/bridge/deposit': async (body) => bridge.recordDeposit(await orderOf(body), field(body, 'txHash', 128)),

    '/api/bridge/order': async (body) => bridge.view(await orderOf(body)),

    '/api/bridge/orders': async (body) => ({ orders: await bridge.ordersOf((await userOf(body, true)) as number) }),

    /** A connected wallet's $KITS purchase, checked on chain before the order counts as complete. */
    '/api/bridge/settle': async (body) => bridge.settleConnected(await orderOf(body), field(body, 'txHash', 64)),

    '/api/bridge/solana': async (body) => {
      const b = obj(body)
      if (b.method === 'blockhash') return deps.solana.blockhash()
      if (b.method === 'balance') return { lamports: (await deps.solana.balance(field(b, 'address', 64))).toString() }
      throw new HttpError(400, 'bad-request', 'Missing or invalid "method"')
    },
  }
}
