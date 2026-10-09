import type { BridgeChainId } from '@/config/bridge'

/**
 * NEARKITS' two bridge products as its server describes them to the page. Both start the same way:
 * NEAR Intents brings the source coin to NEAR (stage 1). Then they differ:
 * - Bridge & Buy $KITS ('buy-kits', /bridge): NEARKITS buys $KITS with that NEAR (stage 2).
 * - Bridge ('bridge', /bridge-near): the NEAR itself is the point. NEAR Intents delivers it as wNEAR,
 *   and it is unwrapped to native NEAR where an authorized unwrap exists: by NEARKITS' engine for a
 *   NEARKITS wallet, by the owner's own signature for a connected wallet. An external address
 *   receives the wNEAR as it arrives.
 * Amounts are raw strings in their own units: the source coin's base units, yocto for NEAR and
 * wNEAR, KITS' 18 decimals.
 */

/** Which product an order is: Bridge & Buy $KITS, or the plain Bridge to NEAR. */
export type BridgeProduct = 'buy-kits' | 'bridge'

export type BridgeOrderStatus =
  /** Waiting for the user's transfer to the deposit address. */
  | 'awaiting-deposit'
  /** NEAR Intents saw the transfer (KNOWN_DEPOSIT_TX). */
  | 'deposit-seen'
  /** NEAR Intents is executing the swap and delivering NEAR (PROCESSING). */
  | 'bridging'
  /** Less arrived than the quote needs: refunded after the deadline unless the rest comes. */
  | 'incomplete-deposit'
  /**
   * NEAR arrived in the NEAR wallet (checked on chain). Bridge & Buy: $KITS not bought yet. Bridge:
   * wNEAR arrived in a connected wallet, whose owner unwraps it with their own signature.
   */
  | 'delivered'
  /** NEARKITS is buying $KITS with it (a NEARKITS wallet). */
  | 'buying'
  /** Bridge: NEARKITS is unwrapping the wNEAR delivered into native NEAR (a NEARKITS wallet). */
  | 'unwrapping'
  /** Bridge: the wNEAR arrived but wasn't unwrapped (the reason says why); it is in the wallet as wNEAR. */
  | 'unwrap-needed'
  /** Bridge & Buy: $KITS reached the wallet. Bridge: the NEAR (or, to an external address, the wNEAR) did. */
  | 'complete'
  /** NEAR arrived but $KITS wasn't bought: the user decides (the reason says why). */
  | 'buy-needed'
  | 'refunded'
  | 'failed'
  /** Nothing was deposited before the deposit address closed. */
  | 'expired'

export const BRIDGE_FINAL: readonly BridgeOrderStatus[] = ['complete', 'buy-needed', 'unwrap-needed', 'refunded', 'failed', 'expired']
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
  /** Null when the purchase can't be priced now (the reason is in `kitsUnavailable`); always null for a Bridge. */
  kits: BridgeKitsEstimate | null
  kitsUnavailable: string | null
  /** Bridge only: what arrives and whether it can arrive there (null for Bridge & Buy). */
  delivery?: BridgeDelivery | null
  quotedAt: number
}

/**
 * Bridge: what arrives on NEAR, and whether the destination can take it. NEAR Intents delivers NEAR
 * as wNEAR (`wrap.near`'s ft_transfer; it has no native NEAR asset), so the destination must be on
 * NEAR and registered with wrap.near, and native NEAR comes from an unwrap afterwards.
 */
export interface BridgeDelivery {
  /** What NEAR Intents delivers: wNEAR. */
  asset: 'wnear'
  /** Who turns it into native NEAR: NEARKITS' engine (a NEARKITS wallet), the owner's wallet (connected), nobody (an external address). */
  unwrap: 'nearkits' | 'wallet' | 'none'
  /** Null when the destination can receive it now; otherwise why not, in a sentence. */
  blocked: string | null
  /** What the page can offer to fix `blocked`: a connected wallet registers with wrap.near by signing. */
  fix: 'register' | null
}

export interface BridgeTx {
  hash: string
  url: string
}

export interface BridgeDestination {
  /** One of the user's NEARKITS wallets, a connected NEAR wallet, or (Bridge only) any NEAR account typed in. */
  kind: 'nearkits' | 'connected' | 'external'
  accountId: string
  /** NEARKITS wallet id and name. */
  walletId: string | null
  name: string | null
}

export interface BridgeOrderView {
  id: string
  product: BridgeProduct
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
  /** Bridge: native NEAR from unwrapping the wNEAR delivered, from the unwrap's own record on chain. */
  unwrapped: { amount: string; txs: BridgeTx[] } | null
  refund: { amount: string | null; reason: string | null; txs: BridgeTx[] } | null
  /** In plain words: what is happening, or what went wrong and what to do. */
  message: string | null
  createdAt: number
  updatedAt: number
}
