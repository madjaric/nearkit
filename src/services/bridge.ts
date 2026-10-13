import type { BridgeChainId } from '@/config/bridge'
import type { BridgeOrderView, BridgeProduct, BridgeQuoteView } from '@/lib/bridge/types'
import { apiPost } from './telegramLink'

/**
 * NEARKITS' bridge, the pages' side, for both products: Bridge & Buy $KITS (/bridge) and the plain
 * Bridge to NEAR (/bridge-near). The server half is server/src/bridge/. Every figure comes
 * from NEARKITS' server, which asks NEAR Intents' 1Click API and checks its answers: this module
 * only carries requests and answers, and remembers which orders this browser started so a reload
 * (or coming back later) finds them again. A NEARKITS wallet is named by the NEARKITS web session, or
 * in Telegram's Mini App by the launch data Telegram signed (the server checks it); nothing here holds
 * a key or moves funds.
 */

export interface BridgeAssets {
  chains: { id: BridgeChainId; name: string; symbol: string; decimals: number; priceUsd: number | null }[]
  destination: { token: string; symbol: string; name: string; decimals: number }
  /** NEARKITS' bridge fee, bps. */
  feeBps: number
  /** NEARKITS' trading fee on the $KITS purchase, bps. */
  tradingFeeBps: number
  /** NEARKITS wallets can receive (the server has custody). */
  custody: boolean
}

export type BridgeDestinationRequest = { kind: 'nearkits'; walletId: string } | { kind: 'connected' | 'external'; accountId: string }

/** One of the user's NEARKITS wallets, as a destination (the Mini App lists them from the bridge). */
export interface BridgeWalletOption {
  id: string
  accountId: string
  name: string
  slot: number
  frozen: boolean
}

export interface BridgeQuoteRequest {
  /** The plain Bridge to NEAR; absent for Bridge & Buy (as its page has always sent it). */
  product?: Exclude<BridgeProduct, 'buy-kits'>
  chain: BridgeChainId
  /** Decimal source amount, as entered. */
  amount: string
  sourceAddress: string | null
  destination: BridgeDestinationRequest
  /** The $KITS purchase's slippage (Bridge & Buy only). */
  kitsSlippagePct?: number
}

export interface BridgeClient {
  readonly available: boolean
  assets(): Promise<BridgeAssets>
  quote(req: BridgeQuoteRequest): Promise<BridgeQuoteView>
  /** The order and its deposit address. `requestKey`: the review's key; asked again with it, the server returns the same order. */
  start(req: BridgeQuoteRequest, requestKey?: string): Promise<BridgeOrderView>
  deposit(orderId: string, txHash: string): Promise<BridgeOrderView>
  order(orderId: string): Promise<BridgeOrderView>
  /** The signed-in NEARKITS user's orders (their NEARKITS wallets). */
  orders(): Promise<BridgeOrderView[]>
  settle(orderId: string, txHash: string): Promise<BridgeOrderView>
  /** A Bridge to a NEARKITS wallet whose wNEAR wasn't unwrapped: its owner asks NEARKITS to unwrap it now. */
  unwrap(orderId: string): Promise<BridgeOrderView>
  solanaBlockhash(): Promise<string>
  solanaBalance(address: string): Promise<bigint>
  /** The signed-in user's NEARKITS wallets, as destinations. */
  wallets(): Promise<BridgeWalletOption[]>
}

export function createBridgeClient(options: {
  apiUrl: string | null
  fetch?: typeof fetch
  session: () => string | null
  /** In Telegram's Mini App: the launch data Telegram signed, which names the user instead of a web session. */
  telegram?: () => string | null
}): BridgeClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const post = <T>(path: string, body: Record<string, unknown> = {}) => {
    if (!options.apiUrl) return Promise.reject(new Error('This NEARKITS build has no NEARKITS server, so Bridge & Buy isn’t available here.'))
    const telegram = options.telegram?.() ?? null
    const session = telegram ? null : options.session()
    return apiPost<T>(options.apiUrl, path, telegram ? { ...body, telegram } : session ? { ...body, session } : body, fetchImpl)
  }
  return {
    available: options.apiUrl !== null,
    assets: () => post<BridgeAssets>('/api/bridge/assets'),
    quote: (req) => post<BridgeQuoteView>('/api/bridge/quote', { ...req }),
    start: (req, requestKey) => post<BridgeOrderView>('/api/bridge/start', requestKey ? { ...req, requestKey } : { ...req }),
    deposit: (orderId, txHash) => post<BridgeOrderView>('/api/bridge/deposit', { orderId, txHash }),
    order: (orderId) => post<BridgeOrderView>('/api/bridge/order', { orderId }),
    orders: async () => (await post<{ orders: BridgeOrderView[] }>('/api/bridge/orders')).orders,
    settle: (orderId, txHash) => post<BridgeOrderView>('/api/bridge/settle', { orderId, txHash }),
    unwrap: (orderId) => post<BridgeOrderView>('/api/bridge/unwrap', { orderId }),
    solanaBlockhash: async () => (await post<{ blockhash: string }>('/api/bridge/solana', { method: 'blockhash' })).blockhash,
    solanaBalance: async (address) => BigInt((await post<{ lamports: string }>('/api/bridge/solana', { method: 'balance', address })).lamports),
    wallets: async () => (await post<{ wallets: BridgeWalletOption[] }>('/api/bridge/wallets')).wallets,
  }
}

/** A review's request key: 24 random bytes, URL-safe (32 characters). */
export function newRequestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * The key a form's start goes with: the one it had while the request is the same (a retry after a lost
 * answer finds the order the first one made), a new one for any other request. Null: none yet, or its
 * order was made (the form forgets it then).
 */
export function reviewKey(last: { request: string; key: string } | null, req: BridgeQuoteRequest): { request: string; key: string } {
  const request = JSON.stringify(req)
  return last?.request === request ? last : { request, key: newRequestKey() }
}

// ─── orders this browser started ─────────────────────────────────────────────

const KEY = 'nearkits:bridge-orders'
const MAX_KEPT = 20

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Ids of the orders started here, newest first (a connected wallet's order is found only by its id). */
export function rememberedOrders(): string[] {
  try {
    const raw = JSON.parse(storage()?.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x)).slice(0, MAX_KEPT) : []
  } catch {
    return []
  }
}

export function rememberOrder(id: string): void {
  try {
    storage()?.setItem(KEY, JSON.stringify([id, ...rememberedOrders().filter((x) => x !== id)].slice(0, MAX_KEPT)))
  } catch {
    // Storage blocked: the order is still the server's, and its page link still finds it.
  }
}
