import { useQuery } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Tag } from '@/components/ui/Indicators'
import { Panel } from '@/components/ui/Panel'
import { ENV } from '@/config/env'
import { describeError } from '@/services/errors'
import { useImportToken, useSession, useTokenLookup } from '@/services/queries'
import { describeHandoff } from '@/services/telegramLink'
import type { HandoffReport } from './useHandoffReport'

/**
 * The web half of a trade prepared in the NearKit Telegram bot. The swap page
 * opens with the trade filled in; the user reviews and signs as always. Once it
 * settles, the transaction hashes go back to the NearKit server, which checks
 * them on chain before telling Telegram. Nothing here trusts the link beyond
 * pre-filling the form.
 */

export function HandoffBanner({ id, report }: { id: string; report: HandoffReport }) {
  const { data: session } = useSession()
  const info = useQuery({
    queryKey: ['handoff', id],
    queryFn: () => describeHandoff(ENV.apiUrl as string, id),
    enabled: Boolean(ENV.apiUrl),
    retry: false,
    staleTime: Infinity,
  })
  const account = info.data?.accountId
  const mismatch = account && session && session.accountId !== account
  return (
    <Panel className="flex gap-3 px-4 py-3">
      <MessageSquare size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1.5 text-sm">
        <p className="flex flex-wrap items-center gap-2 text-fg">
          Prepared in Telegram{account && <span className="num text-fg-2">for {account}</span>}
          <Tag tone="neutral">Telegram</Tag>
        </p>
        <p className="text-xs leading-5 text-fg-3">
          Review the trade below and sign it in your wallet. NearKit quotes again right before you sign. Once it is confirmed on chain, the result is sent back to the bot.
        </p>
        {!ENV.apiUrl && <p className="text-xs text-warn">This NearKit build isn’t connected to the bot server, so the result can’t be sent back to Telegram.</p>}
        {info.isError && <p className="text-xs text-warn">{describeError(info.error).message}</p>}
        {info.data && info.data.status !== 'open' && <p className="text-xs text-fg-3">This trade was already reported to Telegram ({info.data.status}).</p>}
        {mismatch && (
          <p className="text-xs text-warn" role="alert">
            You’re connected as {session.accountId}. Sign with {account} for the bot to confirm this trade.
          </p>
        )}
        {report.isPending && <p className="text-xs text-fg-3">Sending the result to Telegram…</p>}
        {report.isSuccess && (
          <p className="text-xs text-accent" role="status">
            {report.data.outcome === 'traded' ? 'Confirmed on chain and sent to Telegram.' : 'Sent to Telegram: the swap didn’t go through.'}
          </p>
        )}
        {report.isError && (
          <p className="text-xs text-warn" role="alert">
            Couldn’t send the result to Telegram: {describeError(report.error).message}
          </p>
        )}
      </div>
    </Panel>
  )
}

/** A token the link names but this browser's list doesn't have yet: read it from chain, add it on request. */
export function RequestedToken({ contract }: { contract: string }) {
  const lookup = useTokenLookup(contract)
  const importer = useImportToken()
  if (lookup.isPending) return null
  if (lookup.isError)
    return (
      <Panel className="px-4 py-3 text-sm text-warn" role="alert">
        {contract}: {describeError(lookup.error).message}
      </Panel>
    )
  const t = lookup.data
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 text-sm">
        <p className="text-fg">
          {t.symbol} isn’t in your token list yet <Tag tone="neutral">Not listed</Tag>
        </p>
        <p className="num break-all text-xs text-fg-3">
          {t.name} · {t.decimals} decimals · {t.contract}
        </p>
        <p className="text-[11px] text-fg-4">Read from chain. Whether Rhea can trade it shows in the quote.</p>
        {importer.isError && <p className="text-xs text-neg">{describeError(importer.error).message}</p>}
      </div>
      <Button variant="secondary" loading={importer.isPending} disabled={importer.isPending} onClick={() => importer.mutate(contract)}>
        Add {t.symbol}
      </Button>
    </Panel>
  )
}
