import { SEED_ACTIVITY } from '@/mocks/activity'
import { SEED_COPY, SEED_DCA, SEED_SNIPER } from '@/mocks/automation'
import { SEED_ORDERS } from '@/mocks/orders'
import { generateClosedTrades } from '@/mocks/pnl'
import { SEED_MARKET, SEED_TOKENS, TOKEN_IDS } from '@/mocks/tokens'
import { MAIN_ACCOUNT, SEED_HOLDINGS, SEED_PRESETS, SEED_WALLETS } from '@/mocks/wallets'
import { SEED_NOW } from '@/mocks/time'
import type { ActivityItem, ClosedTrade, CopyRule, DcaPlan, Holding, LimitOrder, MarketQuote, Session, SniperConfig, Token, TokenId, Wallet, WalletPreset } from '@/types/domain'

export interface MockState {
  tokens: Token[]
  market: Map<TokenId, MarketQuote>
  lastTick: number
  wallets: Wallet[]
  holdings: Holding[]
  presets: WalletPreset[]
  orders: LimitOrder[]
  dca: DcaPlan[]
  copy: CopyRule[]
  sniper: SniperConfig[]
  activity: ActivityItem[]
  trades: ClosedTrade[]
  session: Session | null
  seq: number
}

export function createState(): MockState {
  const nearUsd = SEED_MARKET.find((m) => m.tokenId === TOKEN_IDS.near)?.priceUsd ?? 1
  const market = new Map<TokenId, MarketQuote>()
  for (const m of SEED_MARKET) {
    market.set(m.tokenId, { ...m, priceNear: m.priceUsd / nearUsd, updatedAt: SEED_NOW })
  }
  return {
    tokens: structuredClone(SEED_TOKENS),
    market,
    lastTick: Date.now(),
    wallets: structuredClone(SEED_WALLETS),
    holdings: structuredClone(SEED_HOLDINGS),
    presets: structuredClone(SEED_PRESETS),
    orders: structuredClone(SEED_ORDERS),
    dca: structuredClone(SEED_DCA),
    copy: structuredClone(SEED_COPY),
    sniper: structuredClone(SEED_SNIPER),
    activity: structuredClone(SEED_ACTIVITY),
    trades: generateClosedTrades(),
    session: { accountId: MAIN_ACCOUNT, walletId: 'w01', connectedAt: SEED_NOW, mode: 'demo' },
    seq: 100,
  }
}

export class ServiceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ServiceError'
  }
}

export function nextId(state: MockState, prefix: string): string {
  state.seq += 1
  return `${prefix}-${state.seq}`
}

// ─── latency ────────────────────────────────────────────────────────────────

let latencyScale = 1
/** Tests set this to 0; the demo keeps a little latency so loading states are real. */
export function setMockLatencyScale(scale: number): void {
  latencyScale = scale
}

const LATENCY = { read: 240, write: 420, quote: 180, scan: 900 } as const

export function wait(kind: keyof typeof LATENCY): Promise<void> {
  const ms = latencyScale * (LATENCY[kind] + Math.random() * LATENCY[kind] * 0.5)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── market ─────────────────────────────────────────────────────────────────

const TICK_MS = 8_000
const VOLATILITY: Record<string, number> = {
  [TOKEN_IDS.near]: 0.0022,
  [TOKEN_IDS.kit]: 0.006,
  [TOKEN_IDS.blackdragon]: 0.0055,
  [TOKEN_IDS.shitzu]: 0.004,
  [TOKEN_IDS.usdc]: 0.0001,
}

/** Demo prices drift a little between reads so quotes, freshness and totals behave like live data. */
export function tickMarket(state: MockState, now = Date.now()): void {
  if (now - state.lastTick < TICK_MS) return
  state.lastTick = now
  for (const quote of state.market.values()) {
    const vol = VOLATILITY[quote.tokenId] ?? 0.004
    const move = (Math.random() - 0.5) * 2 * vol
    const nextPrice = quote.tokenId === TOKEN_IDS.usdc ? 1 + (Math.random() - 0.5) * 0.0004 : quote.priceUsd * (1 + move)
    const change = ((1 + (quote.change24hPct ?? 0) / 100) * (nextPrice / quote.priceUsd) - 1) * 100
    quote.priceUsd = nextPrice
    quote.change24hPct = Math.max(-95, Math.min(500, change))
    quote.updatedAt = now
  }
  const nearUsd = state.market.get(TOKEN_IDS.near)?.priceUsd ?? 1
  for (const quote of state.market.values()) quote.priceNear = quote.priceUsd / nearUsd
}

export function priceOf(state: MockState, tokenId: TokenId): number {
  return state.market.get(tokenId)?.priceUsd ?? 0
}

export function nearPrice(state: MockState): number {
  return priceOf(state, TOKEN_IDS.near)
}

export function tokenOf(state: MockState, tokenId: TokenId): Token {
  const token = state.tokens.find((t) => t.id === tokenId)
  if (!token) throw new ServiceError('unknown-token', `Unknown token: ${tokenId}`)
  return token
}

export function walletOf(state: MockState, walletId: string): Wallet {
  const wallet = state.wallets.find((w) => w.id === walletId)
  if (!wallet) throw new ServiceError('unknown-wallet', `Unknown wallet: ${walletId}`)
  return wallet
}

/** A demo wallet that may trade or send; a watch-only account never does (as in real mode). */
export function executableWalletOf(state: MockState, walletId: string): Wallet {
  const wallet = walletOf(state, walletId)
  if (wallet.access === 'watch') throw new ServiceError('NOT_EXECUTABLE', `${wallet.label} is watch-only: it shows balances and activity, but can't trade or send.`)
  return wallet
}

/** The demo's wallet classes: its seeded wallets act (simulated); added accounts are watch-only. */
export const withSource = (w: Wallet): Wallet => ({ ...w, access: w.access ?? 'signer', source: w.access === 'watch' ? 'watch' : 'external' })

export function balanceOf(state: MockState, walletId: string, tokenId: TokenId): number {
  return state.holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.amount ?? 0
}

export function requireSession(state: MockState): Session {
  if (!state.session) throw new ServiceError('not-connected', 'Connect a wallet first')
  return state.session
}

export function logActivity(state: MockState, item: Omit<ActivityItem, 'id' | 'at' | 'origin'>): void {
  state.activity.unshift({ ...item, id: nextId(state, 'act'), at: Date.now(), origin: 'simulated' })
}
