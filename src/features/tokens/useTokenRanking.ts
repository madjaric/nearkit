import { useMemo } from 'react'
import { ENV, NETWORK } from '@/config/env'
import { isKitToken } from '@/config/kit'
import { holdingTiers, type RankOptions } from '@/lib/tokenRanking'
import { useHoldings, useTokens, useWallets } from '@/services/queries'

/**
 * Popular tokens on this network, the most relevant first: its stablecoins, then the tokens it is
 * configured with. wNEAR is NEAR's wrapped form and not a pick of its own, so it isn't one of them.
 * The demo ranks its simulated tokens in their own order.
 */
export function popularTokenIds(): string[] {
  if (ENV.services === 'demo') return []
  const stables = NETWORK.stableTokens.map((t) => t.contract)
  const wrap = NETWORK.knownTokens.find((t) => t.startsWith('wrap.'))
  return [...stables, ...NETWORK.knownTokens.filter((t) => t !== wrap && !stables.includes(t))]
}

const POPULAR: readonly string[] = Object.freeze(popularTokenIds())

/**
 * What NEARKITS' token order (rankTokenList) needs to know besides the search: $KITS while it is
 * listed, NEAR, what `own` wallets hold (a picker's trading wallet or sources; null: every executable
 * wallet, for the global search), what the user's other executable wallets hold (never watch-only),
 * and the popular tokens.
 */
export function useTokenRanking(own: readonly string[] | null): Required<Pick<RankOptions, 'held' | 'heldElsewhere' | 'kitId' | 'popular'>> {
  const { data: holdings = [] } = useHoldings()
  const { data: wallets = [] } = useWallets()
  const { data: tokens = [] } = useTokens()
  const ownKey = own === null ? null : own.join(',')
  const tiers = useMemo(() => holdingTiers(holdings, wallets, ownKey === null ? null : ownKey === '' ? [] : ownKey.split(',')), [holdings, wallets, ownKey])
  const kitId = tokens.find((t) => isKitToken(t.id))?.id ?? null
  return useMemo(() => ({ ...tiers, kitId, popular: POPULAR }), [tiers, kitId])
}
