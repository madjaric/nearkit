import type {
  CandleInterval,
  CandlesResponse,
  IndexStatus,
  LaunchDetail,
  LaunchExtras,
  LaunchPeriod,
  LaunchesResponse,
  WalletCategory,
  WalletDetail,
  WalletMetric,
  WalletsResponse,
  WalletTradesPage,
  WalletWindowKey,
} from '@/lib/discovery/api'
import { apiPost } from './telegramLink'

/**
 * Launch Radar's and Top Wallets' data, from NEARKITS' server (public, read-only, cached there for
 * everyone: server/src/discovery). The demo answers from discoveryDemo.ts instead.
 */

export interface SignalTrade {
  token: string
  trader: string
  side: 'buy' | 'sell'
  usd: number | null
  ts: number
  tx: string
}

export interface DiscoveryClient {
  status(): Promise<IndexStatus>
  launches(period: LaunchPeriod): Promise<LaunchesResponse>
  extras(tokens: readonly string[]): Promise<LaunchExtras>
  launch(token: string): Promise<LaunchDetail>
  /** A token's USD candles at one interval (as Intear serves it). */
  candles(token: string, interval: CandleInterval): Promise<CandlesResponse>
  wallets(q: { window: WalletWindowKey; metric: WalletMetric; category: WalletCategory; limit?: number; search?: string }): Promise<WalletsResponse>
  wallet(account: string): Promise<WalletDetail>
  walletTrades(account: string, cursor: string | null): Promise<WalletTradesPage>
  /** Given wallets' swaps in recent launches. */
  signals(wallets: readonly string[], since: number): Promise<SignalTrade[]>
}

export function createDiscoveryClient(apiUrl: string, fetchImpl: typeof fetch = fetch): DiscoveryClient {
  const post = <T>(path: string, body: Record<string, unknown>) => apiPost<T>(apiUrl, path, body, fetchImpl)
  return {
    status: () => post('/api/discovery/status', {}),
    launches: (period) => post('/api/discovery/launches', { period }),
    extras: (tokens) => post('/api/discovery/extras', { tokens: [...tokens] }),
    launch: (token) => post('/api/discovery/launch', { token }),
    candles: (token, interval) => post('/api/discovery/candles', { token, interval }),
    wallets: (q) => post('/api/discovery/wallets', { ...q }),
    wallet: (account) => post('/api/discovery/wallet', { account }),
    walletTrades: (account, cursor) => post('/api/discovery/wallet/trades', { account, cursor }),
    signals: async (wallets, since) => (await post<{ trades: SignalTrade[] }>('/api/discovery/signals', { wallets: [...wallets], since })).trades,
  }
}
