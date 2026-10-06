import { useMutation } from '@tanstack/react-query'
import { ENV } from '@/config/env'
import { reportHandoff } from '@/services/telegramLink'
import type { OperationProgress } from '@/types/operations'

/**
 * Sends the hashes of a swap prepared in Telegram back to the NearKit server once
 * it settles. The server reads each one from chain before telling the bot, so
 * this sends facts to be checked, not claims to be believed.
 */
export function useHandoffReport(id: string | null) {
  const report = useMutation({
    mutationFn: (hashes: string[]) => {
      if (!ENV.apiUrl || !id) throw new Error('No NEARKITS bot server is connected to this build')
      return reportHandoff(ENV.apiUrl, id, hashes)
    },
  })
  const onSettled = (p: OperationProgress) => {
    const hashes = p.txs.flatMap((t) => (t.hash ? [t.hash] : []))
    if (id && hashes.length && (p.phase === 'success' || p.phase === 'failed') && !report.isPending && !report.isSuccess) report.mutate(hashes)
  }
  return { report, onSettled }
}

export type HandoffReport = ReturnType<typeof useHandoffReport>['report']
