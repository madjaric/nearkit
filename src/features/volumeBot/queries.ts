import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { BotDetail, BotSummary } from '@/lib/volumeBot/api'
import type { BotConfig } from '@/lib/volumeBot/types'
import { useServices } from '@/services/context'
import { snapshotOf } from '@/services/postTradeRefresh'
import { qk, reconcileBalances, useNearKitSession } from '@/services/queries'
import type { Holding } from '@/types/domain'

/**
 * The Volume Bot console's data: the user's bots and one bot's detail, read from NEARKITS's server
 * with the NEARKITS web session. Live bots are read again every few seconds; when the worker
 * confirms a new trade, the balances of the bot's wallets reconcile like after any trade.
 */

/** A bot the worker is acting on (or settling): its figures change on their own. */
export const isLive = (status: BotSummary['status']) => status === 'running' || status === 'stopping'

const LIST_LIVE_MS = 10_000
const DETAIL_LIVE_MS = 5_000
const IDLE_MS = 60_000

export function useVolumeBots() {
  const s = useServices()
  const session = useNearKitSession()
  return useQuery({
    queryKey: qk.volumeBots(session?.token ?? null),
    queryFn: () => s.nearkit.bots(),
    enabled: s.nearkit.available && session !== null,
    refetchInterval: (q) => (q.state.data?.some((b) => isLive(b.status)) ? LIST_LIVE_MS : IDLE_MS),
    retry: 1,
  })
}

export function useVolumeBot(botId: string | null) {
  const s = useServices()
  const qc = useQueryClient()
  const session = useNearKitSession()
  const key = qk.volumeBot(session?.token ?? null, botId)
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<BotDetail> => {
      const before = qc.getQueryData<BotDetail>(key)
      const detail = await s.nearkit.botDetail(botId as string)
      const confirmed = (d: BotDetail | undefined) => d?.trades.filter((t) => t.status === 'confirmed').length ?? 0
      // A trade the worker confirmed since the last read moved the wallets' balances: every view reconciles.
      if (before && confirmed(detail) > confirmed(before)) {
        const targets = { accounts: detail.wallets.flatMap((w) => (w.accountId ? [w.accountId] : [])), tokens: [NATIVE_TOKEN_ID, detail.bot.token] }
        reconcileBalances(s, qc, targets, snapshotOf(qc.getQueryData<Holding[]>(qk.holdings), targets))
      }
      return detail
    },
    enabled: s.nearkit.available && session !== null && botId !== null,
    refetchInterval: (q) => (q.state.data && (isLive(q.state.data.bot.status) || q.state.data.bot.inFlight > 0) ? DETAIL_LIVE_MS : IDLE_MS),
    retry: 1,
  })
}

export function useVolumeBotMutations() {
  const s = useServices()
  const qc = useQueryClient()
  const session = useNearKitSession()
  // The list and every bot's detail read again (they share the key's prefix).
  const changed = () => qc.invalidateQueries({ queryKey: qk.volumeBots(session?.token ?? null) })
  return {
    save: useMutation({ mutationFn: ({ config, botId }: { config: BotConfig; botId?: string }) => s.nearkit.saveBot(config, botId), onSuccess: changed }),
    start: useMutation({ mutationFn: (botId: string) => s.nearkit.startBot(botId), onSettled: changed }),
    pause: useMutation({ mutationFn: (botId: string) => s.nearkit.pauseBot(botId), onSettled: changed }),
    resume: useMutation({ mutationFn: (botId: string) => s.nearkit.resumeBot(botId), onSettled: changed }),
    stop: useMutation({ mutationFn: ({ botId, emergency }: { botId: string; emergency: boolean }) => s.nearkit.stopBot(botId, emergency), onSettled: changed }),
    remove: useMutation({ mutationFn: (botId: string) => s.nearkit.deleteBot(botId), onSuccess: changed }),
  }
}
