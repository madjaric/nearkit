import { useQuery } from '@tanstack/react-query'
import { isWorking } from '@/features/automation/live/queries'
import { LIVE_STATUSES } from '@/lib/automation/config'
import { useServices } from '@/services/context'
import {
  qk,
  useAutomationFeatures,
  useCapabilities,
  useCopyRules,
  useDcaPlans,
  useIdentity,
  useNearKitSession,
  useOrders,
  useServerAutomation,
  useSniperConfigs,
  useTokens,
} from '@/services/queries'
import { demoRows, serverRows, strategiesOff, type StrategiesOff, type StrategyRow } from './strategies'

export interface ActiveStrategies {
  /** 'server': NEARKITS runs them; 'demo': the demo's seeded, simulated ones; 'off': none can run here (see `off`). */
  source: 'server' | 'demo' | 'off'
  off: StrategiesOff | null
  rows: StrategyRow[]
  loading: boolean
  /** The last read failed and none came before it: unknown, never "none". */
  failed: boolean
  error: unknown
  refetch: () => void
  /** Rows the worker acts on now (watching, triggered, settling a trade). */
  running: (rows: readonly StrategyRow[]) => number
  paused: (rows: readonly StrategyRow[]) => number
}

const LIVE_MS = 8_000
const IDLE_MS = 60_000

const running = (rows: readonly StrategyRow[]) => rows.filter((r) => r.lamp.source === 'demo' || LIVE_STATUSES.includes(r.lamp.status)).length
const paused = (rows: readonly StrategyRow[]) => rows.filter((r) => r.lamp.source === 'server' && r.lamp.status === 'paused').length

/**
 * The strategies that can still act, for the Dashboard: read from NEARKITS' server with the web
 * session (every kind NEARKITS switched on for this user), or the demo's seeded orders and rules.
 */
export function useActiveStrategies(): ActiveStrategies {
  const s = useServices()
  const caps = useCapabilities()
  const who = useIdentity()
  const session = useNearKitSession()
  const features = useAutomationFeatures()
  // NEARKITS' public answer: without a session, whether there is anything to sign in for.
  const server = useServerAutomation()
  const enabled = features.data?.enabled ?? []
  const demo = caps.mode === 'demo'
  const serverOn = !demo && s.nearkit.available && session !== null && enabled.length > 0

  const list = useQuery({
    // Under the strategies' own key: creating, pausing or cancelling one anywhere reads this again.
    queryKey: [...qk.autoList(session?.token ?? null), 'dashboard', enabled.join(',')] as const,
    queryFn: () => s.nearkit.autoList([...enabled]),
    enabled: serverOn,
    refetchInterval: (q) => (q.state.data?.some(isWorking) ? LIVE_MS : IDLE_MS),
    retry: 1,
  })

  const orders = useOrders()
  const dca = useDcaPlans()
  const copy = useCopyRules()
  const sniper = useSniperConfigs()
  const { data: tokens = [] } = useTokens()

  const base = { running, paused }
  if (demo) {
    const pending = orders.isPending || dca.isPending || copy.isPending || sniper.isPending
    return {
      ...base,
      source: 'demo',
      off: null,
      rows: pending ? [] : demoRows({ orders: orders.data ?? [], dca: dca.data ?? [], copy: copy.data ?? [], sniper: sniper.data ?? [], tokens }),
      loading: pending,
      failed: false,
      error: null,
      refetch: () => void orders.refetch(),
    }
  }
  if (serverOn) {
    const failed = list.isError && list.data === undefined
    return {
      ...base,
      source: 'server',
      off: null,
      rows: serverRows(list.data ?? []),
      loading: list.isPending,
      failed,
      error: list.error,
      refetch: () => void list.refetch(),
    }
  }
  const off = strategiesOff({
    sessionEnded: who.kind === 'session-ended',
    available: s.nearkit.available,
    session: session !== null,
    signedOut: who.kind === 'signed-out',
    serverKinds: server.data,
  })
  const waiting = who.kind === 'pending' || (session !== null && features.isPending)
  return { ...base, source: 'off', off, rows: [], loading: waiting, failed: false, error: null, refetch: () => void features.refetch() }
}
