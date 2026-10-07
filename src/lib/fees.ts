import { ENV } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import { mulBps, toYocto } from './amounts'

/**
 * NearKit's trading fee: the ONE place it is set. Web and Telegram quotes, the fee Rhea
 * is asked to collect (`appFeeRate`) and the route checks that require it, review
 * screens, disclosures, accounting and tests all derive from NEARKIT_FEE.
 *
 * - The user pays NEARKIT_FEE.bps of a swap as NearKit's fee (50 = 0.50%). On mainnet
 *   Rhea's aggregator collects it inside the swap as an app fee and keeps its share of it
 *   (the router share in src/config/networks.ts), so NearKit's account receives the rest.
 * - It is never the whole cost of a trade: Rhea's own protocol fee, pool fees and NEAR
 *   gas are separate, and quotes show them on their own lines.
 * - Referrals: a referrer earns NEARKIT_FEE.referralShareBps (20%) of what NearKit receives
 *   on the trades of users they invited: 0.08% of those trades' volume, out of NearKit's
 *   0.40%, which leaves NearKit 0.32%. The trader pays exactly the same 0.50% either way.
 *   `feeLedger` splits a collected fee into router share, what NearKit received, a
 *   referrer's share of that, and NearKit's net revenue.
 * - Testnet collects no fee (the classic router has no app fee). Without a configured
 *   fee account, fee-bearing mainnet trades are blocked.
 * Transfers (Split, Consolidate, Batch Send) carry no NearKit fee. $KITS' own 2% buy and sell
 * tax (its Nearly launch configuration, src/config/kit.ts) is a separate thing and does not live here.
 */
export const NEARKIT_FEE = {
  /** Basis points of a swap the user pays as NearKit's fee: 50 = 0.50%. */
  bps: 50,
  /** Basis points of what NearKit receives (after Rhea's share) that go to the referrer of the trader: 2000 = 20%. */
  referralShareBps: 2000,
} as const

export const NEARKIT_FEE_BPS: number = NEARKIT_FEE.bps
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
 * The production fee account (owner decision, 2026-09-29). Mainnet must be configured
 * with exactly this account: a mainnet build or server set to any other refuses to
 * trade, and the signer refuses to sign a route whose fee goes anywhere else.
 */
export const PRODUCTION_FEE_RECIPIENT = 'nearkitfee.near'

/** Accounts used only in tests and smoke tests: never a fee recipient anywhere. */
export const TEST_ONLY_ACCOUNTS: readonly string[] = Object.freeze(['testone.near'])

/**
 * Why `recipient` can't receive NearKit's fee on `network`, or null when it can. Testnet
 * charges no fee (the classic router has none), so only mainnet has a rule: exactly
 * PRODUCTION_FEE_RECIPIENT.
 */
export function feeRecipientProblem(network: 'mainnet' | 'testnet', recipient: string | null, production: string = PRODUCTION_FEE_RECIPIENT): string | null {
  if (recipient && TEST_ONLY_ACCOUNTS.includes(recipient)) return `${recipient} is a test account; it never receives the NEARKITS fee`
  if (network !== 'mainnet') return null
  if (!recipient) return `The NEARKITS fee account is not configured (it must be ${production})`
  if (recipient !== production) return `The NEARKITS fee account must be ${production}, not ${recipient}`
  return null
}

/**
 * Account that receives the NearKit fee, from VITE_NEARKIT_FEE_RECIPIENT (public, not a
 * secret). On mainnet it must be PRODUCTION_FEE_RECIPIENT (see feeRecipientProblem);
 * when it isn't, fee-bearing mainnet trades are blocked.
 */
export const NEARKIT_FEE_RECIPIENT: string | null = ENV.feeRecipient

/** How one collected NearKit fee divides, in raw units of the fee token. */
export interface FeeLedger {
  /** What the user paid as NearKit's fee. */
  gross: bigint
  /** The router's share of it (Rhea keeps a share of every app fee). */
  routerShare: bigint
  /** What reached NearKit's fee account. */
  received: bigint
  /** Owed to a referrer out of what NearKit received (0 when the trader has no referrer). */
  referral: bigint
  /** NearKit's revenue. */
  net: bigint
}

/**
 * Splits a collected fee for accounting. Every share rounds down; the parts add up to
 * `gross`. `referralShareBps`: 0 for a trader without a referrer, NEARKIT_FEE.referralShareBps
 * for one with.
 */
export function feeLedger(gross: bigint, routerShareBps: number, referralShareBps = 0): FeeLedger {
  const routerShare = (gross * BigInt(routerShareBps)) / 10_000n
  const received = gross - routerShare
  const referral = (received * BigInt(referralShareBps)) / 10_000n
  return { gross, routerShare, received, referral, net: received - referral }
}

/**
 * A referred trade, from what NearKit's fee account actually received on chain (Rhea's
 * `earn_app_fee`, already after Rhea's share): the referrer's share, NearKit's net, and the
 * gross fee and volume it implies (in the fee token's raw units). Rounds down.
 */
export function referralSplit(received: bigint, routerShareBps: number): { referral: bigint; net: bigint; gross: bigint; volume: bigint } {
  const referral = (received * BigInt(NEARKIT_FEE.referralShareBps)) / 10_000n
  const gross = routerShareBps < 10_000 ? (received * 10_000n) / BigInt(10_000 - routerShareBps) : received
  return { referral, net: received - referral, gross, volume: (gross * 10_000n) / BigInt(NEARKIT_FEE_BPS) }
}

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
