import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID, NETWORKS } from '@/config/networks'
import type { BridgeOrderView } from '@/lib/bridge/types'
import { useServices } from '@/services/context'
import { reconcileBalances } from '@/services/queries'

/** The status tag's tone, as the Tag component names them. */
export const STATUS_TONE = { accent: 'accent', warn: 'warn', danger: 'neg', neutral: 'neutral' } as const

/**
 * When funds arrive (and again when the order completes or stops short), the receiving wallet's NEAR,
 * wNEAR and, for Bridge & Buy, $KITS reconcile everywhere (balances, portfolio, positions, available
 * NEAR, activity), as after a trade. Once per change this page sees.
 */
export function useBalancesAfter(o: BridgeOrderView | undefined) {
  const s = useServices()
  const qc = useQueryClient()
  const seen = useRef<string | null>(null)
  const key =
    o && (o.status === 'delivered' || o.status === 'complete' || o.status === 'buy-needed' || o.status === 'unwrap-needed' || o.status === 'unwrapping')
      ? `${o.id}:${o.status}`
      : null
  useEffect(() => {
    if (!o || !key || seen.current === key) return
    // The first reading of an order already settled before this page opened refreshes too: cheap, and never stale.
    seen.current = key
    const tokens = o.product === 'bridge' ? [NATIVE_TOKEN_ID, NETWORKS.mainnet.wrapContract] : [NATIVE_TOKEN_ID, NETWORKS.mainnet.wrapContract, KITS_CONTRACT]
    reconcileBalances(s, qc, { accounts: [o.destination.accountId], tokens }, new Map())
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
