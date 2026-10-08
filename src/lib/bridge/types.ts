import type { BridgeChainId } from '@/config/bridge'

/**
 * Bridge & Buy $KITS as NEARKITS' server describes it to the page. Two stages, and the page always
 * says which one it is in: NEAR Intents brings the source coin to NEAR (stage 1), then NEARKITS buys
 * $KITS with that NEAR (stage 2). Amounts are raw strings in their own units: the source coin's base
 * units, yocto for NEAR, KITS' 18 decimals.
 */

export type BridgeOrderStatus =
  /** Waiting for the user's transfer to the deposit address. */
  | 'awaiting-deposit'
  /** NEAR Intents saw the transfer (KNOWN_DEPOSIT_TX). */
  | 'deposit-seen'
  /** NEAR Intents is executing the swap and delivering NEAR (PROCESSING). */
  | 'bridging'
  /** Less arrived than the quote needs: refunded after the deadline unless the rest comes. */
  | 'incomplete-deposit'
  /** NEAR arrived in the NEAR wallet (checked on chain); $KITS not bought yet. */
  | 'delivered'
  /** NEARKITS is buying $KITS with it (a NEARKITS wallet). */
  | 'buying'
  /** $KITS reached the wallet. */
  | 'complete'
  /** NEAR arrived but $KITS wasn't bought: the user decides (the reason says why). */
  | 'buy-needed'
  | 'refunded'
  | 'failed'
  /** Nothing was deposited before the deposit address closed. */
  | 'expired'

export const BRIDGE_FINAL: readonly BridgeOrderStatus[] = ['complete', 'buy-needed', 'refunded', 'failed', 'expired']
/** Statuses NEAR Intents still moves (the server keeps asking it). */
export const BRIDGE_IN_TRANSIT: readonly BridgeOrderStatus[] = ['awaiting-deposit', 'deposit-seen', 'bridging', 'incomplete-deposit']

export interface BridgeFeeView {
  /** NEARKITS' share, bps of the amount bridged. */
  nearkitsBps: number
  /** NEAR Intents' own share, bps. */
  intentsBps: number
  /** The same, in the source coin's base units (rounded down). */
  nearkitsRaw: string
  intentsRaw: string
}

/** Stage 2's estimate: $KITS for the NEAR the quote delivers, priced by NEARKITS' trading route now. */
export interface BridgeKitsEstimate {
  /** Raw KITS expected (after the trading fee and $KITS' own buy tax, as the route prices them). */
  amountOut: string
  /** Raw KITS at the stage-2 slippage: the least NEARKITS buys at without asking again. */
  minOut: string
  /** NEARKITS' trading fee on the purchase (the ordinary 0.50%), bps. */
  tradingFeeBps: number
  /** NEAR the purchase spends (yocto): the NEAR delivered, less what stays for network fees. */
  nearIn: string
  slippagePct: number
  priceImpactPct: number | null
}

export interface BridgeQuoteView {
  chain: BridgeChainId
  /** Source coin, base units. */
  amountIn: string
  amountInUsd: number | null
  /** wNEAR delivered on NEAR (yocto): expected, and the least at 1Click's slippage. */
  nearOut: string
  nearMinOut: string
  nearOutUsd: number | null
  fee: BridgeFeeView
  /** NEAR Intents' estimate of the cross-chain leg once the deposit confirms, seconds. */
  timeEstimateSec: number
  /** What a refund would cost, source base units (NEAR Intents'), when it says. */
  refundFee: string | null
  /** Null when the purchase can't be priced now (the reason is in `kitsUnavailable`). */
  kits: BridgeKitsEstimate | null
  kitsUnavailable: string | null
  quotedAt: number
}

export interface BridgeTx {
  hash: string
  url: string
}

export interface BridgeDestination {
  kind: 'nearkits' | 'connected'
  accountId: string
  /** NEARKITS wallet id and name. */
  walletId: string | null
  name: string | null
}

export interface BridgeOrderView {
  id: string
  status: BridgeOrderStatus
  chain: BridgeChainId
  /** The user's address on the source chain: it sends, and any refund goes back to it. */
  sourceAddress: string
  depositAddress: string
  /** Deposits are taken until then (ms). Sending after it can lose the funds. */
  depositDeadline: number
  /** Send by then: the page refuses to start a transfer later (ms). */
  signBy: number
  quote: BridgeQuoteView
  destination: BridgeDestination
  depositTx: BridgeTx | null
  /** NEAR delivered and checked on chain: wNEAR or native NEAR. */
  delivered: { amount: string; asset: 'wnear' | 'near'; txs: BridgeTx[] } | null
  /** $KITS bought (stage 2), from the purchase's own record on chain. */
  kits: { amount: string; txs: BridgeTx[] } | null
  refund: { amount: string | null; reason: string | null; txs: BridgeTx[] } | null
  /** In plain words: what is happening, or what went wrong and what to do. */
  message: string | null
  createdAt: number
  updatedAt: number
}
