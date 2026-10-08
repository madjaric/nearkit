import type { BridgeChainId } from '@/config/bridge'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { apiPost } from './telegramLink'

/**
 * Bridge & Buy $KITS, the page's side (the server half is server/src/bridge/). Every figure comes
 * from NEARKITS' server, which asks NEAR Intents' 1Click API and checks its answers: this module
 * only carries requests and answers, and remembers which orders this browser started so a reload
 * (or coming back later) finds them again. A NEARKITS wallet is named by the NEARKITS web session;
 * nothing here holds a key or moves funds.
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

export type BridgeDestinationRequest = { kind: 'nearkits'; walletId: string } | { kind: 'connected'; accountId: string }

export interface BridgeQuoteRequest {
  chain: BridgeChainId
  /** Decimal source amount, as entered. */
  amount: string
  sourceAddress: string | null
  destination: BridgeDestinationRequest
  kitsSlippagePct: number
}

export interface BridgeClient {
  readonly available: boolean
  assets(): Promise<BridgeAssets>
  quote(req: BridgeQuoteRequest): Promise<BridgeQuoteView>
  start(req: BridgeQuoteRequest): Promise<BridgeOrderView>
  deposit(orderId: string, txHash: string): Promise<BridgeOrderView>
  order(orderId: string): Promise<BridgeOrderView>
  /** The signed-in NEARKITS user's orders (their NEARKITS wallets). */
  orders(): Promise<BridgeOrderView[]>
  settle(orderId: string, txHash: string): Promise<BridgeOrderView>
  solanaBlockhash(): Promise<string>
  solanaBalance(address: string): Promise<bigint>
}

export function createBridgeClient(options: { apiUrl: string | null; fetch?: typeof fetch; session: () => string | null }): BridgeClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const post = <T>(path: string, body: Record<string, unknown> = {}) => {
    if (!options.apiUrl) return Promise.reject(new Error('This NEARKITS build has no NEARKITS server, so Bridge & Buy isn’t available here.'))
    const session = options.session()
    return apiPost<T>(options.apiUrl, path, session ? { ...body, session } : body, fetchImpl)
  }
  return {
    available: options.apiUrl !== null,
    assets: () => post<BridgeAssets>('/api/bridge/assets'),
    quote: (req) => post<BridgeQuoteView>('/api/bridge/quote', { ...req }),
    start: (req) => post<BridgeOrderView>('/api/bridge/start', { ...req }),
    deposit: (orderId, txHash) => post<BridgeOrderView>('/api/bridge/deposit', { orderId, txHash }),
    order: (orderId) => post<BridgeOrderView>('/api/bridge/order', { orderId }),
    orders: async () => (await post<{ orders: BridgeOrderView[] }>('/api/bridge/orders')).orders,
    settle: (orderId, txHash) => post<BridgeOrderView>('/api/bridge/settle', { orderId, txHash }),
    solanaBlockhash: async () => (await post<{ blockhash: string }>('/api/bridge/solana', { method: 'blockhash' })).blockhash,
    solanaBalance: async (address) => BigInt((await post<{ lamports: string }>('/api/bridge/solana', { method: 'balance', address })).lamports),
  }
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
