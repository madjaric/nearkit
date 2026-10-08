import { useQuery } from '@tanstack/react-query'
import { ENV } from '@/config/env'
import { KIT } from '@/config/kit'
import { fetchKitsBurns } from '@/services/kitsBurns'
import { useCapabilities } from '@/services/queries'
import { burnTrackerState, type BurnTrackerState } from './buyback'

/** How often an open $KITS page asks again. NEARKITS' server reads the chain at most once a minute for everyone. */
export const BURN_REFRESH_MS = 60_000

/** $KITS' Buyback & Burn from NEARKITS' server: read when the page opens, then every minute while it stays open. */
export function useBurnTracker(): BurnTrackerState {
  const caps = useCapabilities()
  const enabled = KIT.contract !== null && caps.mode === 'near' && caps.network === 'mainnet' && ENV.apiUrl !== null
  const query = useQuery({
    queryKey: ['kits', 'burns'],
    queryFn: () => fetchKitsBurns(ENV.apiUrl as string),
    enabled,
    refetchInterval: BURN_REFRESH_MS,
    staleTime: BURN_REFRESH_MS / 2,
    retry: 1,
  })
  return burnTrackerState({
    contract: KIT.contract,
    mode: caps.mode,
    network: caps.network,
    apiUrl: ENV.apiUrl,
    query: { data: query.data, isPending: query.isPending, isError: query.isError },
  })
}
