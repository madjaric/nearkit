import type { EnvIssue } from '@/config/env'
import type { OwnerControl } from '@/lib/ownerAccount'
import type {
  PriceHistory,
  TokenMarket,
  ActivityItem,
  ChartRange,
  CopyRule,
  CopyRuleInput,
  DcaInput,
  DcaPlan,
  Holding,
  LimitOrder,
  MarketQuote,
  MultiTradeQuote,
  MultiTradeRequest,
  OrderInput,
  PnlRange,
  PnlReport,
  PortfolioSummary,
  Position,
  PresetInput,
  Quote,
  QuoteRequest,
  ScanResult,
  Session,
  SniperConfig,
  SniperInput,
  TokenId,
  TokenListing,
  TokenTrade,
  TransferRequest,
  ValuePoint,
  Wallet,
  WalletPreset,
  WalletSnapshot,
} from '@/types/domain'
import type { NetworkName, OperationPlan, OperationProgress } from '@/types/operations'
import type { SignedMessageResult, SignMessageRequest } from './near/wallet'
import type { NearKitWeb } from './nearkitWeb'

/**
 * Service contracts. The UI reaches data and actions only through these
 * interfaces (via the hooks in `queries.ts`) and never knows which
 * implementation answers:
 *
 *   UI  →  hooks (queries.ts)  →  NearKitServices  →  real/  (NEAR: wallet, RPC, indexers, Rhea)
 *                                                  →  mock/  (demo mode: simulated)
 *
 * Value-moving operations are two steps: a `prepare*` call returns an exact,
 * reviewable `OperationPlan`; `execution.run` signs and confirms it.
 */

/** What the running implementation can do, so the UI can explain rather than guess. */
export interface Capabilities {
  mode: 'demo' | 'near'
  /** Null in demo mode. */
  network: NetworkName | null
  networkLabel: 'Demo' | 'Testnet' | 'Mainnet'
  explorerUrl: string | null
  /** RPC endpoints in failover order, for display (empty in demo mode). */
  rpcUrls: readonly string[]
  /** USD prices exist (mainnet and demo; never testnet). */
  prices: boolean
  /** Cost basis, PnL and value history are tracked (demo only in Phase 2). */
  pnl: boolean
  /** Automation and orders: simulated demo, or local drafts that nothing executes. */
  automation: 'demo' | 'drafts'
  execution: {
    /** Transfers can be signed and sent (true in demo, where they are simulated). */
    enabled: boolean
    simulated: boolean
    /** Why execution is off (e.g. the mainnet switch), in plain words. */
    reason: string | null
    trading: {
      enabled: boolean
      reason: string | null
      router: 'aggregator' | 'classic' | 'demo'
      /** The NearKit fee is collected on this network. */
      feeCharged: boolean
      feeRecipient: string | null
    }
  }
  /** $KIT contract once configured; null until launch. */
  kitContract: string | null
  configIssues: readonly EnvIssue[]
}

export interface WalletOption {
  id: string
  name: string
  icon: string | null
  description: string
  website: string
  injected: boolean
}

export interface TokenService {
  listTokens(): Promise<TokenListing[]>
  getToken(id: TokenId): Promise<TokenListing | null>
  /**
   * Read a contract that is in no list yet: it must exist, run a contract (local or
   * global) and answer NEP-148 metadata and NEP-141 supply. Nothing is saved, and a
   * token that reads fine may still have no route: the quote decides that.
   */
  lookupToken(contract: string): Promise<TokenListing>
  /** Validate a NEP-141 contract and add it to this network's token list. */
  importToken(contract: string): Promise<TokenListing>
  getMarket(ids?: TokenId[]): Promise<MarketQuote[]>
  /** NEAR/USD, or null where no price exists (testnet). */
  getNearPrice(): Promise<MarketQuote | null>
  /** One token's live price from the app's price sources; null when none reports it (never zero, never estimated). */
  getPrice(id: TokenId): Promise<MarketQuote | null>
  /** Raw NEP-141 total supply, read from chain (for FDV); null for NEAR, or when it can't be read. */
  getTotalSupply(id: TokenId): Promise<string | null>
  /**
   * A token's market data for its screen: price, 24h change, market cap, FDV, liquidity and
   * volume, each with its source (DEX Screener, GeckoTerminal, CoinGecko, Coinbase) or why it
   * is missing. Never estimated: a market cap needs a known circulating supply.
   */
  getMarketData(id: TokenId): Promise<TokenMarket>
  /**
   * Real market prices over `range`, oldest first: Coinbase's NEAR/USD candles for NEAR,
   * GeckoTerminal's candles of the token's main DEX pair otherwise. Null when no source has this
   * token's history (its screen then says so, and shows only what it saw itself). A failed read
   * throws. Never filled in or estimated.
   */
  getPriceHistory(id: TokenId, range: ChartRange): Promise<PriceHistory | null>
  /**
   * Recent buys and sells of a token against NEAR, newest first, read from the chain's own record.
   * Null when there is no source for it (NEAR itself, the demo); empty when none of its latest
   * transactions is a trade. Never made up.
   */
  getActivity(id: TokenId): Promise<TokenTrade[] | null>
  scan(query: string): Promise<ScanResult | null>
  scanSuggestions(): Promise<{ query: string; label: string }[]>
}

export interface WalletService {
  getSession(): Promise<Session | null>
  /** Wallets that can connect on this network (empty in demo mode). */
  listWalletOptions(): Promise<WalletOption[]>
  /**
   * With `account` (Recover's "Connect <owner>"): that NEAR account is the session's account when the
   * wallet shares exactly it, also after a reload; otherwise, and on a plain connect, the wallet's first.
   */
  connect(walletId?: string, options?: { account?: string }): Promise<Session>
  disconnect(): Promise<void>
  /**
   * Can the connected wallet sign for `owner` (Recover's owner requests)? The owner account itself,
   * or an account whose reported key is a full-access key of the owner on chain right now. No
   * account is ever taken for another.
   */
  ownerControl(owner: string): Promise<OwnerControl>
  /**
   * Sign a NEP-413 message with the connected wallet: free, no transaction. Used
   * to prove account ownership (e.g. linking Telegram). Refused in demo mode.
   * With `accountId` (an owner's request): asked of the wallet only while it can sign for that owner
   * (`ownerControl`), and kept only if the key that signed is a full-access key of the owner on chain.
   */
  signMessage(request: SignMessageRequest & { accountId?: string }): Promise<SignedMessageResult>
  listWallets(): Promise<Wallet[]>
  /** Every wallet with its balances: the wallet views, watch-only ones included. */
  listSnapshots(): Promise<WalletSnapshot[]>
  /**
   * The snapshots the portfolio is made of: executable wallets only (`executableWallets` in
   * src/lib/wallets.ts), their balances read for those alone. Watch-only wallets never enter it.
   */
  listPortfolioSnapshots(): Promise<WalletSnapshot[]>
  listHoldings(): Promise<Holding[]>
  /** Add a watch-only account to the account book. */
  addAccount(input: { accountId: string; label?: string }): Promise<Wallet>
  removeAccount(walletId: string): Promise<void>
  listPresets(): Promise<WalletPreset[]>
  createPreset(input: PresetInput): Promise<WalletPreset>
  updatePreset(id: string, input: PresetInput): Promise<WalletPreset>
  duplicatePreset(id: string): Promise<WalletPreset>
  deletePreset(id: string): Promise<void>
}

export interface TransferService {
  /** Validate and price a Batch Send, Split or Consolidate into an exact plan. */
  prepare(request: TransferRequest): Promise<OperationPlan>
}

export interface TradingService {
  quote(request: QuoteRequest): Promise<Quote>
  /** Fresh quote and exact swap plan; the review shows this plan, not the ticket's earlier quote. */
  prepareSwap(request: QuoteRequest): Promise<OperationPlan>
  quoteMulti(request: MultiTradeRequest): Promise<MultiTradeQuote>
  prepareMulti(request: MultiTradeRequest): Promise<OperationPlan>
  listOrders(): Promise<LimitOrder[]>
  createOrder(input: OrderInput): Promise<LimitOrder>
  cancelOrder(id: string): Promise<LimitOrder>
}

export interface ExecutionService {
  /**
   * Sign and confirm a plan (or simulate it in demo mode). Continue a paused run
   * by passing its last progress as `prior`.
   */
  run(plan: OperationPlan, prior: OperationProgress | null, onProgress: (progress: OperationProgress) => void): Promise<OperationProgress>
  /**
   * Drop what is cached about these accounts' balances, so the next read asks the chain
   * again (the post-trade refresh does this before each try). No-op in demo mode.
   */
  forgetBalances(accountIds: readonly string[]): void
  /**
   * Read these tokens of these accounts on chain directly for a while (they just received or sent
   * them), instead of waiting for the token indexer to notice. No-op in demo mode.
   */
  trackBalances(accountIds: readonly string[], contracts: readonly string[]): void
}

export interface AutomationService {
  listDcaPlans(): Promise<DcaPlan[]>
  createDcaPlan(input: DcaInput): Promise<DcaPlan>
  deleteDcaPlan(id: string): Promise<void>
  listCopyRules(): Promise<CopyRule[]>
  createCopyRule(input: CopyRuleInput): Promise<CopyRule>
  deleteCopyRule(id: string): Promise<void>
  listSniperConfigs(): Promise<SniperConfig[]>
  createSniperConfig(input: SniperInput): Promise<SniperConfig>
  deleteSniperConfig(id: string): Promise<void>
}

export interface PortfolioService {
  getSummary(): Promise<PortfolioSummary>
  listPositions(): Promise<Position[]>
  getValueHistory(days: number): Promise<ValuePoint[]>
  /** Null where PnL is not tracked (real mode in Phase 2). */
  getPnl(range: PnlRange): Promise<PnlReport | null>
  listActivity(limit?: number): Promise<ActivityItem[]>
}

export interface NearKitServices {
  mode: 'demo' | 'near'
  capabilities: Capabilities
  tokens: TokenService
  wallets: WalletService
  transfers: TransferService
  trading: TradingService
  execution: ExecutionService
  automation: AutomationService
  portfolio: PortfolioService
  /**
   * The signed-in Telegram user's NearKit wallets (custody), through NearKit's server: sign-in,
   * create, rename, and the trades and sends NearKit's server runs, with no Telegram step.
   * Unavailable in the demo and in builds without a NearKit server.
   */
  nearkit: NearKitWeb
  /** Demo only: restore the seeded demo state. */
  resetDemo?: () => void
}
