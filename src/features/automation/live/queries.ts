import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateStrategyInput, StrategyDetail, StrategyView } from '@/lib/automation/api'
import { LIVE_STATUSES, type StrategyConfig, type StrategyKind } from '@/lib/automation/config'
import { useServices } from '@/services/context'
import { qk, useAutomationFeatures, useNearKitSession } from '@/services/queries'
import { sendCreate } from './model'

/**
 * Trading automation's data on NEARKITS web: the user's strategies and one strategy's detail, read
 * from NEARKITS' server with the NEARKITS web session. Strategies the worker acts on are read again
 * every few seconds; the rest every minute. Nothing here decides a state: the server's word is shown.
 */

const LIVE_MS = 8_000
const IDLE_MS = 60_000

/** Whether a strategy's figures change on their own now (watched, or a trade settling). */
export const isWorking = (s: Pick<StrategyView, 'status'>) => LIVE_STATUSES.includes(s.status)

/**
 * The server-backed page for this kind: real services, a NEARKITS web session, and the kind
 * switched on by NEARKITS. The demo and every other case keep the page as it was.
 */
export function automationLive(mode: 'demo' | 'near', enabled: readonly StrategyKind[] | null | undefined, kind: StrategyKind): boolean {
  return mode === 'near' && Array.isArray(enabled) && enabled.includes(kind)
}

export function useAutomationLive(kind: StrategyKind): boolean {
  const s = useServices()
  const { data } = useAutomationFeatures()
  return automationLive(s.mode, data?.enabled, kind)
}

export function useStrategies(kind: StrategyKind) {
  const s = useServices()
  const session = useNearKitSession()
  return useQuery({
    queryKey: [...qk.autoList(session?.token ?? null), kind] as const,
    queryFn: () => s.nearkit.autoList([kind]),
    enabled: s.nearkit.available && session !== null,
    refetchInterval: (q) => (q.state.data?.some(isWorking) ? LIVE_MS : IDLE_MS),
    retry: 1,
  })
}

export function useStrategy(id: string | null) {
  const s = useServices()
  const session = useNearKitSession()
  return useQuery({
    queryKey: qk.autoDetail(session?.token ?? null, id),
    queryFn: (): Promise<StrategyDetail> => s.nearkit.autoDetail(id as string),
    enabled: s.nearkit.available && session !== null && id !== null,
    refetchInterval: (q) => {
      const d = q.state.data
      const settling = d?.executions.some((e) => e.status === 'executing' || e.status === 'submitted') ?? false
      return d && (isWorking(d.strategy) || settling) ? LIVE_MS : IDLE_MS
    },
    retry: 1,
  })
}

export function useStrategyMutations() {
  const s = useServices()
  const qc = useQueryClient()
  const session = useNearKitSession()
  // Every list and every detail read again (they share the key's prefix). Awaited by the mutations:
  // a call's own onSuccess runs once the lists were read again.
  const changed = () => qc.invalidateQueries({ queryKey: qk.autoList(session?.token ?? null) })
  return {
    /** The user's strategies of a kind as last read (no request). */
    listed: (kind: StrategyKind) => qc.getQueryData<StrategyView[]>([...qk.autoList(session?.token ?? null), kind]),
    preview: useMutation({ mutationFn: ({ walletId, config }: { walletId: string; config: StrategyConfig }) => s.nearkit.autoPreview(walletId, config) }),
    // One request per review: its key goes with every send, so a retry never makes a second strategy.
    create: useMutation({ mutationFn: (input: CreateStrategyInput) => sendCreate((i) => s.nearkit.autoCreate(i), input), onSuccess: changed }),
    pause: useMutation({ mutationFn: (id: string) => s.nearkit.autoPause(id), onSettled: changed }),
    resume: useMutation({ mutationFn: (id: string) => s.nearkit.autoResume(id), onSettled: changed }),
    cancel: useMutation({ mutationFn: (id: string) => s.nearkit.autoCancel(id), onSettled: changed }),
    pauseAll: useMutation({ mutationFn: () => s.nearkit.autoPauseAll(), onSettled: changed }),
  }
}
