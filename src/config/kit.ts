import { explorerTokenUrl } from '@/services/near/explorer'
import { ENV } from './env'
import { NETWORKS } from './networks'

/**
 * $KITS (Near Kits), the NEARKITS token: one configuration that every surface reads (the sidebar,
 * the Dashboard, token pickers and search, the $KITS page). NEARKITS is the platform; $KITS is its
 * token, and it is one contract: kits.nearlytrade.near, on NEAR mainnet, launched on Nearly. Where
 * the build has that contract (mainnet, and the demo's preview), $KITS is live and trades like any
 * other token; on testnet, where it doesn't exist, it is mainnet-only and nothing trades it.
 */

/** The one $KITS contract (NEAR mainnet). */
export const KITS_CONTRACT = 'kits.nearlytrade.near'

/**
 * Nearly's launchpad contract, where $KITS launched, and the token's tax admin: it collects the
 * trading tax in KITS (its collect_tax calls the token's tax_take), burns the Buyback & Burn share
 * (its process_tax calls the token's burn: an NEP-141 ft_burn event, and its own tax_burned event)
 * and hands the rest to its tax seller for NEAR. NEARKITS' server checks on chain that it is the
 * token's tax admin before it reads a burn from it; the launch id is read from it, never assumed.
 */
export const KIT_LAUNCHPAD = 'nearlytrade.near'

export type KitStatus = 'live' | 'mainnet-only'

export interface KitConfig {
  name: 'Near Kits'
  symbol: 'KITS'
  ticker: '$KITS'
  /** The NEP-141 contract on this build's network; null where $KITS doesn't exist (testnet). */
  contract: string | null
  status: KitStatus
  /** False where the build has no contract: no picker, ticket or link may trade it. */
  tradable: boolean
  launchVenue: 'Nearly'
  /** One line for the places that introduce it. */
  tagline: string
  /** Its page, its Token Detail where it trades, and its explorer page (always mainnet's: where it lives). */
  links: { page: '/kit'; token: string | null; explorer: string }
}

export function kitConfig(contract: string | null): KitConfig {
  const live = contract !== null
  return {
    name: 'Near Kits',
    symbol: 'KITS',
    ticker: '$KITS',
    contract,
    status: live ? 'live' : 'mainnet-only',
    tradable: live,
    launchVenue: 'Nearly',
    tagline: live ? '$KITS, the NEARKITS token, is live on NEAR.' : '$KITS, the NEARKITS token, trades on NEAR mainnet.',
    links: {
      page: '/kit',
      token: live ? `/token/${encodeURIComponent(contract)}` : null,
      explorer: explorerTokenUrl(NETWORKS.mainnet, KITS_CONTRACT),
    },
  }
}

export const KIT: Readonly<KitConfig> = Object.freeze(kitConfig(ENV.kitContract))

/**
 * $KITS as its launch configuration on Nearly sets it (the owner's figures, 2026-10-07; the
 * contract's own get_tax reads 200 bps on buys and on sells). The trading tax and the pool fee are
 * two separate things: NEARKITS' 70% is a share of the pool fee, never of the tax. These are
 * rules, not market figures: no price, supply or activity is implied.
 */
export const KIT_LAUNCH = {
  /** Charged on every buy and every sell, in % of the trade. */
  tax: { buyPct: 2, sellPct: 2 },
  /** Where the tax goes, in % of the tax: all of it. */
  taxSplit: { buybackBurnPct: 50, holdersPct: 50, creatorPct: 0 },
  /** The pool's fee, in % of the trade, and NEARKITS' share of that fee. */
  poolFee: { pct: 1, nearkitsSharePct: 70 },
} as const

const { tax, taxSplit, poolFee } = KIT_LAUNCH
/** One rate for both sides: buys and sells are taxed alike (kit.test.ts holds the two together). */
export const KIT_TAX_NOTE = `${tax.buyPct}% tax applies to buys and sells. Tax revenue is split ${taxSplit.buybackBurnPct}/${taxSplit.holdersPct} between Buyback & Burn and Holder rewards.`
export const KIT_POOL_FEE_NOTE = `${poolFee.nearkitsSharePct}% of the ${poolFee.pct}% pool fee is allocated to NEARKITS.`

/** True for $KITS' token id: the build's contract (the demo's preview uses the same id). */
export function isKitToken(tokenId: string | null | undefined, kit: Pick<KitConfig, 'contract'> = KIT): boolean {
  return tokenId != null && kit.contract !== null && tokenId === kit.contract
}
