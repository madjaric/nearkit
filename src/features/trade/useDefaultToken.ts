import { NATIVE_TOKEN_ID, NETWORKS } from '@/config/networks'
import { useCapabilities, useTokens } from '@/services/queries'
import type { TokenId } from '@/types/domain'

/**
 * The token trade tools open on: the network's configured default when it is in
 * the list, else the first listed token that isn't NEAR. Demo token IDs mirror
 * mainnet contracts, so the demo resolves to the same default.
 */
export function useDefaultTradeToken(): TokenId {
  const caps = useCapabilities()
  const { data: tokens = [] } = useTokens()
  const preferred = NETWORKS[caps.network ?? 'mainnet'].defaultTradeToken
  return tokens.find((t) => t.id === preferred)?.id ?? tokens.find((t) => !t.isNative && t.status === 'listed')?.id ?? NATIVE_TOKEN_ID
}
