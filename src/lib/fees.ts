import { ENV } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { mulBps, toYocto } from './amounts'

/**
 * NearKit trading fee on Swap and Quick Trade: single source of truth. On mainnet it
 * is collected through Rhea's app-fee mechanism (see PHASE2_IMPLEMENTATION.md §13):
 * the user pays 0.10%, of which Rhea keeps 20%, so NearKit receives 0.08%. The UI
 * never claims otherwise. Transfers (Split, Consolidate, Batch Send) carry no NearKit
 * fee. The future $KIT buy and sell fee is a separate thing and does not live here.
 */
export const NEARKIT_FEE_BPS = 10
export const NEARKIT_FEE_PCT = NEARKIT_FEE_BPS / 100

const bpsLabel = (bps: number) => `${(bps / 100).toFixed(2)}%`
/** Rhea's share of an app fee, in bps of the fee (mainnet aggregator config). */
const RHEA_APP_FEE_SHARE_BPS = NETWORKS.mainnet.rhea.aggregator?.appFeeRouterShareBps ?? 0

export const NEARKIT_FEE_LABEL = bpsLabel(NEARKIT_FEE_BPS)
/** What NearKit's fee account receives of the fee on mainnet. */
export const NEARKIT_FEE_RECEIVED_LABEL = bpsLabel((NEARKIT_FEE_BPS * (10_000 - RHEA_APP_FEE_SHARE_BPS)) / 10_000)
/** What Rhea's aggregator keeps of the NearKit fee on mainnet. */
export const RHEA_APP_FEE_SHARE_LABEL = bpsLabel((NEARKIT_FEE_BPS * RHEA_APP_FEE_SHARE_BPS) / 10_000)

/**
 * Account that receives the NearKit fee, from VITE_NEARKIT_FEE_RECIPIENT (public, not a
 * secret). Never hardcoded; when unset, fee-bearing mainnet trades are blocked.
 */
export const NEARKIT_FEE_RECIPIENT: string | null = ENV.feeRecipient

/** Display-only fee on a float amount. */
export function nearkitFee(amount: number): number {
  return (amount * NEARKIT_FEE_BPS) / 10_000
}

/** Exact fee on a raw amount, floored (never rounded up). */
export function nearkitFeeRaw(raw: bigint): bigint {
  return mulBps(raw, NEARKIT_FEE_BPS)
}

/** Estimated network cost of one function call on NEAR (demo figure, not a quote). */
export const NETWORK_FEE_NEAR_PER_TX = 0.0012

/** NEP-145 storage deposit an FT contract may require for a first-time recipient. */
export const STORAGE_DEPOSIT_NEAR = 0.00125

/** NEAR kept back by MAX so the wallet can still pay for gas and storage. Configurable here. */
export const GAS_RESERVE_NEAR = 0.05
export const GAS_RESERVE_YOCTO = toYocto('0.05')

export const SLIPPAGE_PRESETS = [0.5, 1, 3] as const
export const DEFAULT_SLIPPAGE = 1
export const HIGH_SLIPPAGE = 5
export const MAX_SLIPPAGE = 50
