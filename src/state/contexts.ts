import { createContext, useContext } from 'react'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import type { TokenId, TradeSide } from '@/types/domain'

// ─── settings ───────────────────────────────────────────────────────────────

export interface Settings {
  defaultSlippage: number
  /** Trades need a second press to fire (armed → confirm) instead of one click. */
  twoStepConfirm: boolean
  hideDust: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  defaultSlippage: DEFAULT_SLIPPAGE,
  twoStepConfirm: true,
  hideDust: false,
}

export interface SettingsApi {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  reset: () => void
}

export const SettingsContext = createContext<SettingsApi | null>(null)

export function useSettings(): SettingsApi {
  const api = useContext(SettingsContext)
  if (!api) throw new Error('useSettings must be used inside <SettingsProvider>')
  return api
}

// ─── trade drawer ───────────────────────────────────────────────────────────

export interface TradeIntent {
  tokenId: TokenId
  side: TradeSide
}

export interface TradeDrawerApi {
  openTrade: (intent: TradeIntent) => void
}

export const TradeDrawerContext = createContext<TradeDrawerApi | null>(null)

export function useTradeDrawer(): TradeDrawerApi {
  const api = useContext(TradeDrawerContext)
  if (!api) throw new Error('useTradeDrawer must be used inside <TradeDrawerProvider>')
  return api
}

// ─── connect prompt ─────────────────────────────────────────────────────────

export interface ConnectApi {
  promptConnect: () => void
  /** Connect exactly this NEAR account (Recover's owner): the current session is signed out first, and another account is an error. */
  connectOwner: (owner: string) => void
}

export const ConnectContext = createContext<ConnectApi | null>(null)

export function useConnectPrompt(): ConnectApi {
  const api = useContext(ConnectContext)
  if (!api) throw new Error('useConnectPrompt must be used inside <ConnectProvider>')
  return api
}

// ─── coming soon ────────────────────────────────────────────────────────────

/** True inside the read-only body of a page the public beta marks COMING SOON. */
export const ComingSoonContext = createContext(false)

export function useInComingSoon(): boolean {
  return useContext(ComingSoonContext)
}
