import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { ENV } from '@/config/env'
import { TOP_WALLETS_PAUSED } from '@/config/paused'
import { INTERVAL_REFRESH_MS } from '@/lib/chart/intervals'
import type { CandleInterval, FollowView, LaunchPeriod, WalletCategory, WalletMetric, WalletWindowKey } from '@/lib/discovery/api'
import { useServices } from '@/services/context'
import { createDiscoveryClient, type DiscoveryClient } from '@/services/discoveryApi'
import { createDemoDiscovery } from '@/services/discoveryDemo'
import { LinkRequestError } from '@/services/telegramLink'
import { useNearKitSession } from '@/services/queries'
import { followed, useList } from './local'

/**
 * Launch Radar's and Top Wallets' data: NEARKITS' server (cached there for everyone) in real mode, the
 * demo's sample data in the demo. Pages refresh about as often as the server's own caches change.
 */

const LAUNCHES_MS = 30_000
const RANKING_MS = 120_000
const DETAIL_MS = 30_000

let demo: DiscoveryClient | null = null

/**
 * The data client for this build: null where there is no NEARKITS server (nothing to read). The demo's
 * generated launches, wallets and candles exist in the demo build only (a build-time constant, as for the
 * demo's services): every other build leaves them out.
 */
export function useDiscoveryClient(): DiscoveryClient | null {
  const s = useServices()
  return useMemo(() => {
    if (__NEARKIT_DEMO__ && s.mode === 'demo') return (demo ??= createDemoDiscovery())
    return ENV.apiUrl ? createDiscoveryClient(ENV.apiUrl) : null
  }, [s.mode])
}

export const dk = {
  launches: (p: LaunchPeriod) => ['discovery', 'launches', p] as const,
  extras: (tokens: readonly string[]) => ['discovery', 'extras', tokens.join(',')] as const,
  launch: (t: string) => ['discovery', 'launch', t] as const,
  candles: (t: string, i: CandleInterval) => ['discovery', 'candles', t, i] as const,
  wallets: (w: WalletWindowKey, m: WalletMetric, c: WalletCategory, q: string) => ['discovery', 'wallets', w, m, c, q] as const,
  wallet: (a: string) => ['discovery', 'wallet', a] as const,
  signals: (ws: readonly string[]) => ['discovery', 'signals', ws.join(',')] as const,
  follows: (token: string | null) => ['discovery', 'follows', token] as const,
}

/** Whether Launch Radar and Top Wallets run here (the shared hook: the sidebar's SOON tags use it too). */
export { useDiscoveryOn } from '@/services/queries'

export function useLaunches(period: LaunchPeriod) {
  const client = useDiscoveryClient()
  return useQuery({ queryKey: dk.launches(period), queryFn: () => (client as DiscoveryClient).launches(period), enabled: client !== null, refetchInterval: LAUNCHES_MS, retry: 1 })
}

export function useLaunchExtras(tokens: readonly string[]) {
  const client = useDiscoveryClient()
  const sorted = useMemo(() => [...new Set(tokens)].sort(), [tokens])
  return useQuery({
    queryKey: dk.extras(sorted),
    queryFn: () => (client as DiscoveryClient).extras(sorted),
    enabled: client !== null && sorted.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export function useLaunch(token: string) {
  const client = useDiscoveryClient()
  return useQuery({ queryKey: dk.launch(token), queryFn: () => (client as DiscoveryClient).launch(token), enabled: client !== null, refetchInterval: DETAIL_MS, retry: 1 })
}

/** How often a chart's candles are read again: about as often as NEARKITS' server reads them from Intear. */

/** A token's candles at one interval. A 404 (no candles, or a server without this route yet) is not retried. */
export function useLaunchCandles(token: string, interval: CandleInterval) {
  const client = useDiscoveryClient()
  return useQuery({
    queryKey: dk.candles(token, interval),
    queryFn: () => (client as DiscoveryClient).candles(token, interval),
    enabled: client !== null && token !== '',
    refetchInterval: INTERVAL_REFRESH_MS[interval],
    retry: (n, e) => !(e instanceof LinkRequestError && e.status === 404) && n < 1,
  })
}

export function useWallets(q: { window: WalletWindowKey; metric: WalletMetric; category: WalletCategory; search: string }) {
  const client = useDiscoveryClient()
  const search = q.search.trim().toLowerCase()
  return useQuery({
    queryKey: dk.wallets(q.window, q.metric, q.category, search),
    queryFn: () => (client as DiscoveryClient).wallets({ window: q.window, metric: q.metric, category: q.category, limit: 100, ...(search ? { search } : {}) }),
    enabled: client !== null,
    refetchInterval: RANKING_MS,
    placeholderData: (prev) => prev,
    retry: 1,
  })
}

export function useWallet(account: string) {
  const client = useDiscoveryClient()
  return useQuery({ queryKey: dk.wallet(account), queryFn: () => (client as DiscoveryClient).wallet(account), enabled: client !== null, refetchInterval: 60_000, retry: 1 })
}

/** Followed wallets' swaps in recent launches (their evidence on Launch Radar). */
export function useFollowedSignals(since: number) {
  const client = useDiscoveryClient()
  const list = useFollowed().accounts
  return useQuery({
    queryKey: dk.signals(list),
    queryFn: () => (client as DiscoveryClient).signals(list, since),
    enabled: client !== null && list.length > 0 && !TOP_WALLETS_PAUSED,
    refetchInterval: 60_000,
    retry: 1,
  })
}

/**
 * Followed wallets: kept in this browser for everyone; with a NEARKITS web session, also on NEARKITS'
 * server, where each can have Telegram alerts from the bot.
 */
export function useFollowed() {
  const s = useServices()
  const session = useNearKitSession()
  const qc = useQueryClient()
  const local = useList(followed)
  const signedIn = s.mode === 'near' && session !== null
  const server = useQuery({
    queryKey: dk.follows(session?.token ?? null),
    queryFn: () => s.nearkit.discoveryFollows(),
    enabled: signedIn && !TOP_WALLETS_PAUSED,
    staleTime: 60_000,
    retry: 1,
  })
  const set = (follows: FollowView[]) => qc.setQueryData(dk.follows(session?.token ?? null), follows)
  const follow = useMutation({ mutationFn: (v: { account: string; alerts: boolean }) => s.nearkit.discoveryFollow(v.account, v.alerts), onSuccess: set })
  const unfollow = useMutation({ mutationFn: (account: string) => s.nearkit.discoveryUnfollow(account), onSuccess: set })
  const remote = useMemo(() => server.data ?? [], [server.data])
  const accounts = useMemo(() => [...new Set([...local, ...remote.map((f) => f.account)])], [local, remote])
  const alerts = useMemo(() => new Set(remote.filter((f) => f.alerts).map((f) => f.account)), [remote])
  return {
    accounts,
    signedIn,
    alerts,
    isFollowed: (a: string) => accounts.includes(a),
    toggle(a: string) {
      const on = !accounts.includes(a)
      if (on !== local.includes(a)) followed.toggle(a)
      if (signedIn) {
        if (on) follow.mutate({ account: a, alerts: false })
        else if (remote.some((f) => f.account === a)) unfollow.mutate(a)
      }
    },
    setAlerts(a: string, on: boolean) {
      if (!local.includes(a)) followed.toggle(a)
      follow.mutate({ account: a, alerts: on })
    },
    busy: follow.isPending || unfollow.isPending,
    error: follow.error ?? unfollow.error ?? null,
  }
}
