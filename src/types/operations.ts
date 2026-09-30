import type { TokenId } from './domain'

/**
 * Value-moving operations. Every tool builds an `OperationPlan` first (exact raw
 * amounts, transactions, deposits, fees), the user reviews that plan, and one
 * executor signs and confirms it. Plans are plain JSON so they can be persisted
 * and reconciled after a reload; raw amounts are integer strings, never floats.
 */

export type NetworkName = 'mainnet' | 'testnet'

// ─── errors ─────────────────────────────────────────────────────────────────

export type NearKitErrorCode =
  | 'USER_REJECTED'
  | 'WALLET_UNAVAILABLE'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_GAS'
  | 'STORAGE_REQUIRED'
  | 'INVALID_ACCOUNT'
  | 'INVALID_TOKEN'
  | 'INVALID_AMOUNT'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_UNAVAILABLE'
  | 'QUOTE_REJECTED'
  | 'SLIPPAGE_EXCEEDED'
  | 'RPC_ERROR'
  | 'TRANSACTION_FAILED'
  | 'NETWORK_MISMATCH'
  | 'EXECUTION_DISABLED'
  | 'UNKNOWN'

/** Serializable error for plans, progress and activity records. */
export interface NearKitErrorInfo {
  code: NearKitErrorCode
  message: string
  detail?: string
}

// ─── amounts ────────────────────────────────────────────────────────────────

export interface TokenRef {
  id: TokenId
  symbol: string
  decimals: number
  /** NEP-141 contract; null for native NEAR. */
  contract: string | null
}

/** An exact amount: raw integer units plus the exact human string (never rounded up). */
export interface AmountValue {
  raw: string
  display: string
}

// ─── plans ──────────────────────────────────────────────────────────────────

export type OperationKind = 'transfer' | 'batch-send' | 'split' | 'consolidate' | 'swap' | 'multi-trade'

export type PlannedAction = { kind: 'transfer'; deposit: string } | { kind: 'call'; method: string; args: Record<string, unknown>; gas: string; deposit: string }

export interface PlannedTransaction {
  index: number
  signerId: string
  receiverId: string
  actions: PlannedAction[]
  /** Plan lines this transaction settles. */
  lineIds: string[]
  label: string
  /** Σ attached gas and Σ deposits (yocto), for disclosure. */
  gas: string
  deposit: string
}

export interface PlanLine {
  id: string
  /** Wallet label or account ID as the user knows it. */
  label: string
  accountId: string
  amount: AmountValue
  /** NEP-145 registration paid for this recipient, in NEAR. */
  storageDeposit: AmountValue | null
  notes: string[]
  txIndex: number
}

export interface FeeShare {
  bps: number
  amount: AmountValue
  party: string
}

export interface FeeDisclosure {
  label: string
  /** Headline rate the user pays as the NearKit fee, in bps (50 = 0.50%). */
  bps: number
  amount: AmountValue
  token: TokenRef
  /** False when the fee is not collected (e.g. testnet). */
  charged: boolean
  recipient: string | null
  /** Part of the NearKit fee NearKit actually receives, after a router's share. */
  received: FeeShare | null
  /** Part of the NearKit fee a router keeps (e.g. Rhea's 20% of app fees). */
  routerShare: FeeShare | null
  /** Separate fee the router charges on every swap regardless of NearKit. */
  routerFee: FeeShare | null
  /** Amounts are estimates: the router takes the fee from a later token, so the exact figure is set at execution. */
  estimated?: boolean
  note: string | null
}

export interface SwapDetails {
  router: 'aggregator' | 'classic' | 'demo'
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: AmountValue
  expectedOut: AmountValue
  minOut: AmountValue
  slippagePct: number
  priceImpactPct: number | null
  route: string[]
  /** Routing tokens in order (wNEAR, not NEAR), for reading the outcome. */
  routeTokens?: TokenRef[]
  quotedAt: number
}

export interface PlanTotals {
  amount: AmountValue
  /** Σ NEP-145 storage deposits, NEAR. */
  storage: AmountValue
  /**
   * Gas bought upfront under NEP-642 plus 1-yocto security deposits, NEAR. Most of
   * it is refunded after execution. Excludes the amount itself and storage deposits.
   */
  upfrontNear: AmountValue
}

export interface OperationPlan {
  id: string
  kind: OperationKind
  mode: 'near' | 'demo'
  network: NetworkName | 'demo'
  title: string
  token: TokenRef
  /** Accounts that sign, in signing order. */
  signers: string[]
  lines: PlanLine[]
  transactions: PlannedTransaction[]
  /** Transaction indexes signed together (one wallet approval each), in order. */
  groups: number[][]
  totals: PlanTotals
  fee: FeeDisclosure | null
  swap: SwapDetails | null
  warnings: string[]
  /** Quote-bound plans must not execute after this time. */
  expiresAt: number | null
  createdAt: number
}

// ─── progress ───────────────────────────────────────────────────────────────

/**
 * `processing`: it reached the chain (or the wallet may have sent it) and NearKit is still
 * following it: slower than usual, never a failure. `success` for a swap means its tokens
 * arrived; the chain's last settlement callbacks may still run (`settling`).
 */
export type TxPhase = 'queued' | 'awaiting_signature' | 'submitted' | 'confirming' | 'processing' | 'success' | 'failed' | 'unknown' | 'not_sent'

export interface TxProgress {
  index: number
  phase: TxPhase
  hash: string | null
  explorerUrl: string | null
  error: NearKitErrorInfo | null
  /** Plain-language outcome detail, e.g. "Refunded: slippage limit reached". */
  note: string | null
  /** Delivered, and the chain's final settlement callbacks are still running. */
  settling?: boolean
}

/** `processing`: NearKit stopped following a transaction that hasn't settled yet (Activity keeps checking it). */
export type OperationPhase = 'idle' | 'running' | 'paused' | 'success' | 'partial' | 'failed' | 'processing'

export interface OperationPause {
  reason: 'failure' | 'switch-account' | 'requote'
  /** Account the next group needs, for switch-account pauses. */
  signerId: string | null
  message: string
}

export interface OperationProgress {
  planId: string
  phase: OperationPhase
  txs: TxProgress[]
  /** Next group to run. */
  groupIndex: number
  pause: OperationPause | null
  /** Demo plans are simulated: nothing is signed or sent. */
  simulated: boolean
  startedAt: number
  finishedAt: number | null
}
