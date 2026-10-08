import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { ENV } from '@/config/env'
import { BRIDGE_FINAL, BRIDGE_IN_TRANSIT, type BridgeOrderView } from '@/lib/bridge/types'
import { createBridgeClient, rememberedOrders, type BridgeClient, type BridgeQuoteRequest } from '@/services/bridge'
import { useServices } from '@/services/context'
import { useNearKitSession } from '@/services/queries'

/**
 * Bridge & Buy's data on the page: the chains NEAR Intents supports now, a live quote, and the
 * orders, each read from NEARKITS' server and refreshed while something can still change.
 */

/** Where Bridge & Buy can run: NEAR mainnet, real services, with NEARKITS' server. */
export type BridgeAvailability = { ok: true } | { ok: false; reason: 'demo' | 'testnet' | 'no-server' }

export function useBridgeAvailability(): BridgeAvailability {
  const { mode } = useServices()
  if (mode === 'demo') return { ok: false, reason: 'demo' }
  if (ENV.network !== 'mainnet') return { ok: false, reason: 'testnet' }
  if (!ENV.apiUrl) return { ok: false, reason: 'no-server' }
  return { ok: true }
}

export function useBridgeClient(): BridgeClient {
  const { nearkit } = useServices()
  return useMemo(() => createBridgeClient({ apiUrl: ENV.apiUrl, session: () => nearkit.session()?.token ?? null }), [nearkit])
}

export const bridgeKeys = {
  assets: ['bridge', 'assets'] as const,
  quote: (req: BridgeQuoteRequest | null) => ['bridge', 'quote', req] as const,
  order: (id: string | null) => ['bridge', 'order', id] as const,
  orders: (session: string | null) => ['bridge', 'orders', session] as const,
}

export function useBridgeAssets(enabled: boolean) {
  const client = useBridgeClient()
  return useQuery({ queryKey: bridgeKeys.assets, queryFn: () => client.assets(), enabled, staleTime: 5 * 60_000, retry: 1 })
}

/** A quote while the form is filled in: refreshed every 20 s; nothing is fabricated while it loads or fails. */
export const BRIDGE_QUOTE_REFRESH_MS = 20_000

export function useBridgeQuote(req: BridgeQuoteRequest | null) {
  const client = useBridgeClient()
  return useQuery({
    queryKey: bridgeKeys.quote(req),
    queryFn: () => client.quote(req as BridgeQuoteRequest),
    enabled: req !== null,
    refetchInterval: BRIDGE_QUOTE_REFRESH_MS,
    staleTime: 10_000,
    retry: false,
  })
}

/** How often an order is read again: often while it moves, never once it is final. */
export function orderPollMs(o: Pick<BridgeOrderView, 'status' | 'destination'> | undefined): number | false {
  if (!o) return 4_000
  if (BRIDGE_FINAL.includes(o.status)) return false
  if (o.status === 'delivered' && o.destination.kind === 'connected') return false
  if (o.status === 'awaiting-deposit') return 5_000
  return BRIDGE_IN_TRANSIT.includes(o.status) ? 4_000 : 3_000
}

export function useBridgeOrder(id: string | null) {
  const client = useBridgeClient()
  return useQuery({
    queryKey: bridgeKeys.order(id),
    queryFn: () => client.order(id as string),
    enabled: id !== null,
    refetchInterval: (q) => orderPollMs(q.state.data),
    retry: 2,
  })
}

/**
 * Every order the user can see here: their NEARKITS wallets' (from the server, with the session)
 * and the ones this browser started (a connected wallet's, by id). Newest first, each once.
 */
export function useBridgeOrders(enabled: boolean) {
  const client = useBridgeClient()
  const session = useNearKitSession()
  const server = useQuery({
    queryKey: bridgeKeys.orders(session?.token ?? null),
    queryFn: () => client.orders(),
    enabled: enabled && session !== null,
    refetchInterval: 30_000,
    retry: 1,
  })
  const ids = enabled ? rememberedOrders() : []
  const local = useQueries({
    queries: ids.map((id) => ({ queryKey: bridgeKeys.order(id), queryFn: () => client.order(id), retry: false, staleTime: 15_000 })),
  })
  const all = new Map<string, BridgeOrderView>()
  for (const o of server.data ?? []) all.set(o.id, o)
  for (const q of local) if (q.data) all.set(q.data.id, q.data)
  return {
    orders: [...all.values()].sort((a, b) => b.createdAt - a.createdAt),
    loading: server.isPending && session !== null && enabled,
  }
}

/** Reads an order again now (after the page sent its transfer or the purchase). */
export function useRefreshOrder() {
  const qc = useQueryClient()
  return (id: string) => qc.invalidateQueries({ queryKey: bridgeKeys.order(id) })
}
