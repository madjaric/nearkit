import { explorerTokenUrl } from '@/services/near/explorer'
import { ENV, NETWORK } from './env'

/**
 * $KIT, NEARKITS' own token: one configuration that every surface reads (the sidebar, the Dashboard,
 * token pickers and search, the $KIT page). Nothing here is guessed. The contract comes only from the
 * build (VITE_KIT_TOKEN_CONTRACT): until it names one, $KIT is Coming Soon and nothing trades it;
 * once it does, $KIT is live and trades like any other token.
 */

export type KitStatus = 'coming-soon' | 'live'

export interface KitConfig {
  name: string
  symbol: 'KIT'
  ticker: '$KIT'
  /** The NEP-141 contract; null until the build names it. */
  contract: string | null
  status: KitStatus
  /** False while Coming Soon: no picker, ticket or link may trade it. */
  tradable: boolean
  launchVenue: 'Nearly'
  /** One line for the places that introduce it. */
  tagline: string
  links: { page: '/kit'; token: string | null; explorer: string | null }
}

/** The demo's preview $KIT (simulated figures, never a contract). */
export const DEMO_KIT_ID = 'kit'

export function kitConfig(contract: string | null, explorerUrl: string): KitConfig {
  const live = contract !== null
  return {
    name: 'NEARKITS Token',
    symbol: 'KIT',
    ticker: '$KIT',
    contract,
    status: live ? 'live' : 'coming-soon',
    tradable: live,
    launchVenue: 'Nearly',
    tagline: live ? 'The NEARKITS token is live on NEAR.' : 'The NEARKITS token launches on Nearly.',
    links: {
      page: '/kit',
      token: live ? `/token/${encodeURIComponent(contract)}` : null,
      explorer: live ? explorerTokenUrl({ explorerUrl }, contract) : null,
    },
  }
}

export const KIT: Readonly<KitConfig> = Object.freeze(kitConfig(ENV.kitContract, NETWORK.explorerUrl))

/**
 * $KIT as its launch configuration on Nearly sets it (the owner's figures, 2026-10-07). The trading
 * tax and the pool fee are two separate things: NEARKITS' 70% is a share of the pool fee, never of
 * the tax. These are rules, not market figures: no price, supply or activity is implied.
 */
export const KIT_LAUNCH = {
  name: 'NEAR KITS',
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

/** True for $KIT's token id: the demo's preview token, or the configured contract. */
export function isKitToken(tokenId: string | null | undefined, kit: Pick<KitConfig, 'contract'> = KIT): boolean {
  return tokenId != null && (tokenId === DEMO_KIT_ID || (kit.contract !== null && tokenId === kit.contract))
}
