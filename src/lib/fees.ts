import { ENV } from '@/config/env'
import { mulBps, toYocto } from './amounts'

/**
 * NearKit fee: single source of truth. On mainnet it is collected through Rhea's
 * app-fee mechanism (see PHASE2_IMPLEMENTATION.md §13): the user pays 2.00%, of
 * which Rhea keeps 20%, so NearKit receives 1.60%. The UI never claims otherwise.
 */
export const NEARKIT_FEE_BPS = 200
export const NEARKIT_FEE_PCT = NEARKIT_FEE_BPS / 100
export const NEARKIT_FEE_LABEL = '2.00%'

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
