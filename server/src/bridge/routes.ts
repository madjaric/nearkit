import { HttpError, type Route } from '../api/http'
import { field } from '../api/linkRoutes'
import { verifyTelegramLaunch, type TelegramCheck } from '../signer/telegram'
import type { WebSessions } from '../web/sessions'
import type { BridgeProduct } from '@/lib/bridge/types'
import type { BridgeDestinationInput, BridgeQuoteInput, BridgeService } from './service'
import type { SolanaReads } from './solana'

/**
 * The bridge's public API, both products (Bridge & Buy $KITS, and the plain Bridge to NEAR): POST,
 * JSON, no cookies (api/http.ts). Quote, start, deposit, status, reconciliation and the owner's
 * unwrap are separate routes, each checked on its own. `product` says which ('buy-kits' when absent,
 * as the pages before the Bridge sent nothing). A NEARKITS wallet is named by the NEARKITS web
 * session (the server finds the wallet among that user's own); a connected or external destination
 * by its NEAR account. An order is read by its id: a NEARKITS order only with its owner's session.
 *
 * In Telegram's Mini App the page has no web session: it names the Telegram user with the launch data
 * Telegram signed for NEARKITS' bot (`telegram`), checked here with Telegram's own Ed25519 key, exactly
 * as the signer checks its approvals, and only within TELEGRAM_LAUNCH_MAX_AGE_MS of being opened. It
 * reaches the bridge routes only: never a trade, a send, or any other web route.
 */

/** How long a Mini App's launch data names its user to the bridge after Telegram opened it. */
export const TELEGRAM_LAUNCH_MAX_AGE_MS = 60 * 60_000
/** Clock difference tolerated between Telegram and this server. */
const TELEGRAM_SKEW_MS = 5 * 60_000
/** A review's request key: 16 to 64 random URL-safe characters, made by the page or the bot. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function bridgeRoutes(deps: {
  bridge: BridgeService
  sessions: WebSessions | null
  solana: SolanaReads
  /** NEARKITS' bot and Telegram's key: the Mini App's launch data is checked against them; null without a bot. */
  telegram?: TelegramCheck | null
  now?: () => number
}): Record<string, Route> {
  const { bridge } = deps
  const now = deps.now ?? Date.now

  /** The Telegram user who opened the Mini App, from launch data Telegram signed for this bot, opened within the hour. */
  const telegramUser = async (initData: unknown): Promise<number> => {
    const again = 'Telegram’s sign-in for this page ended. Open Bridge from the NEARKITS bot again.'
    if (typeof initData !== 'string' || !deps.telegram) throw new HttpError(401, 'telegram', again)
    const launch = await verifyTelegramLaunch(initData, deps.telegram)
    if (!launch) throw new HttpError(401, 'telegram', again)
    const opened = launch.authDate * 1000
    if (opened < now() - TELEGRAM_LAUNCH_MAX_AGE_MS || opened > now() + TELEGRAM_SKEW_MS) throw new HttpError(401, 'telegram', again)
    return launch.userId
  }

  /** The signed-in NEARKITS web user (or the Mini App's Telegram user), or null without either; 401 for a session that ended. */
  const userOf = async (body: unknown, required: boolean): Promise<number | null> => {
    const launch = obj(body).telegram
    if (launch !== undefined && launch !== null && launch !== '') return telegramUser(launch)
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

  const productOf = (b: Record<string, unknown>): BridgeProduct => {
    if (b.product === undefined || b.product === 'buy-kits') return 'buy-kits'
    if (b.product === 'bridge') return 'bridge'
    throw new HttpError(400, 'product', 'Unknown bridge product.')
  }

  const inputOf = async (body: unknown): Promise<BridgeQuoteInput> => {
    const b = obj(body)
    const product = productOf(b)
    const d = obj(b.destination)
    let destination: BridgeDestinationInput
    if (d.kind === 'nearkits') destination = { kind: 'nearkits', userId: (await userOf(body, true)) as number, walletId: field(d, 'walletId', 64) }
    else if (d.kind === 'connected' || d.kind === 'external') destination = { kind: d.kind, accountId: field(d, 'accountId', 64) }
    else throw new HttpError(400, 'destination', product === 'bridge' ? 'Choose the NEAR account that receives the NEAR.' : 'Choose the NEAR wallet that receives $KITS.')
    const source = b.sourceAddress
    if (source !== undefined && source !== null && (typeof source !== 'string' || source.length > 128)) throw new HttpError(400, 'source', 'That isn’t an address.')
    // Slippage is the $KITS purchase's: a Bridge buys nothing, so it takes none.
    const slippage = b.kitsSlippagePct
    if (product === 'buy-kits' && typeof slippage !== 'number') throw new HttpError(400, 'slippage', 'Missing slippage.')
    return {
      product,
      chain: field(b, 'chain', 8),
      amount: field(b, 'amount', 40),
      sourceAddress: typeof source === 'string' ? source : null,
      destination,
      kitsSlippagePct: product === 'buy-kits' ? (slippage as number) : null,
    }
  }

  const orderOf = async (body: unknown) => bridge.orderFor(field(body, 'orderId', 64), await userOf(body, false))

  /** The review's key, when the caller sent one: the same key always finds the same order. */
  const requestKeyOf = (body: unknown): string | null => {
    const key = obj(body).requestKey
    if (key === undefined || key === null || key === '') return null
    if (typeof key !== 'string' || !REQUEST_KEY.test(key)) throw new HttpError(400, 'request', 'That request key isn’t valid. Get a new quote.')
    return key
  }

  return {
    '/api/bridge/assets': async () => bridge.assets(),

    /** A price only: no deposit address is made and nothing can be sent to it. */
    '/api/bridge/quote': async (body) => bridge.preview(await inputOf(body)),

    /** The order and its deposit address. The user's own wallet sends; NEARKITS never holds the funds. */
    '/api/bridge/start': async (body) => bridge.start(await inputOf(body), { requestKey: requestKeyOf(body) }),

    /** The caller's own NEARKITS wallets, as destinations (the Mini App has no web session to list them with). */
    '/api/bridge/wallets': async (body) => ({ wallets: await bridge.destinationsOf((await userOf(body, true)) as number) }),

    '/api/bridge/deposit': async (body) => bridge.recordDeposit(await orderOf(body), field(body, 'txHash', 128)),

    '/api/bridge/order': async (body) => bridge.view(await orderOf(body)),

    '/api/bridge/orders': async (body) => ({ orders: await bridge.ordersOf((await userOf(body, true)) as number) }),

    /** A connected wallet's $KITS purchase (Bridge & Buy) or its unwrap (Bridge), checked on chain before the order counts as complete. */
    '/api/bridge/settle': async (body) => bridge.settleConnected(await orderOf(body), field(body, 'txHash', 64)),

    /** A Bridge to a NEARKITS wallet whose wNEAR wasn't unwrapped: its owner (by session) asks NEARKITS to unwrap it now. */
    '/api/bridge/unwrap': async (body) => {
      const userId = await userOf(body, true)
      return bridge.retryUnwrap(await bridge.orderFor(field(body, 'orderId', 64), userId))
    },

    '/api/bridge/solana': async (body) => {
      const b = obj(body)
      if (b.method === 'blockhash') return deps.solana.blockhash()
      if (b.method === 'balance') return { lamports: (await deps.solana.balance(field(b, 'address', 64))).toString() }
      throw new HttpError(400, 'bad-request', 'Missing or invalid "method"')
    },
  }
}
