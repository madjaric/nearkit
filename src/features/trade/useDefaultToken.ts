import { NETWORKS } from '@/config/networks'
import { useCapabilities, useTokens } from '@/services/queries'
import type { TokenId } from '@/types/domain'
import { kitsFirstToken, openingToken } from './openingToken'

/**
 * The token DCA and Limit Orders open on: the network's configured default when it is in
 * the list, else the first listed token that isn't NEAR. Demo token IDs mirror
 * mainnet contracts, so the demo resolves to the same default.
 */
export function useDefaultTradeToken(): TokenId {
  const caps = useCapabilities()
  const { data: tokens = [] } = useTokens()
  return openingToken(tokens, [NETWORKS[caps.network ?? 'mainnet'].defaultTradeToken])
}

/**
 * The token Quick Trade (its ticket on the Dashboard, the Dashboard's Buy and Sell keys and the
 * sidebar's Quick Trade), Swap, Multi Trade and a new Volume Bot open on: $KITS, the NEARKITS token,
 * from its one configuration (config/kit.ts), while it is listed; where it isn't (testnet), the
 * network's default. A token the page was opened for (`?token=`, a saved bot's) still comes first.
 */
export function useKitsFirstToken(): TokenId {
  const caps = useCapabilities()
  const { data: tokens = [] } = useTokens()
  return kitsFirstToken(tokens, caps.network ?? 'mainnet')
}
