import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { InfoTip, Term } from '@/components/ui/Help'
import { Skeleton } from '@/components/ui/Indicators'
import { Line, Lines } from '@/components/ui/Panel'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { formatAccount, formatDuration } from '@/lib/format'
import { ACTUAL_NETWORK_FEE_LABEL } from '@/lib/gasReserve'
import { useNow } from '@/lib/hooks'
import { describeError } from '@/services/errors'
import { explorerTxUrl } from '@/services/near/explorer'
import { WRAP_NETWORK_FEE_YOCTO } from '@/services/near/wrap'
import type { WebLegStatus } from '@/services/nearkitWeb'
import { wrapTargets } from '@/services/postTradeRefresh'
import { useCapabilities, useNearKitMutations, useUnwrapStatus } from '@/services/queries'
import type { Wallet } from '@/types/domain'
import { WRAP_FEE_TEXT, wrapExplainer } from './wrapCopy'

/**
 * Unwrap from a NEARKITS wallet, on the Swap page: the Telegram bot's Unwrap wNEAR. The same
 * intent, run by the same engine handler and held by the same signer policy: one near_withdraw
 * on the wrap contract, of exactly the amount reviewed. NEARKITS' server reviews it against the
 * wallet's wNEAR on chain; Confirm runs it. Not a trade: no quote, no NEARKITS fee, nothing to slip.
 */

export interface NearKitUnwrapRequest {
  /** The page's wallet id (an account). */
  walletId: string
  /** Exact decimal wNEAR. */
  amount: string
}

const STATUS: Record<WebLegStatus, string> = {
  quoted: 'Starting',
  requoted: 'Something changed: review it again',
  executing: 'Unwrapping',
  processing: 'Processing: waiting for the NEAR network',
  done: 'Unwrapped',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'The review expired: review it again',
}

const FINAL: readonly WebLegStatus[] = ['done', 'failed', 'cancelled', 'expired', 'requoted']

export function NearKitUnwrapModal({
  request,
  wallets,
  onClose,
  onSettled,
}: {
  request: NearKitUnwrapRequest
  wallets: readonly Wallet[]
  onClose: () => void
  /** The unwrap finished; `ok`: it went through. */
  onSettled?: (ok: boolean) => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Review unwrap"
      description="NEARKITS unwraps it in your NEARKITS wallet, signed with its own key: one call to the wrap contract. No wallet prompt."
    >
      <NearKitUnwrap request={request} wallets={wallets} onClose={onClose} onSettled={onSettled} />
    </Modal>
  )
}

function NearKitUnwrap({
  request,
  wallets,
  onClose,
  onSettled,
}: {
  request: NearKitUnwrapRequest
  wallets: readonly Wallet[]
  onClose: () => void
  onSettled?: (ok: boolean) => void
}) {
  const caps = useCapabilities()
  const { reviewUnwrap, executeUnwrap } = useNearKitMutations()
  const [running, setRunning] = useState<string | null>(null)
  const asked = useRef(false)
  const reported = useRef(false)
  const now = useNow(1000)
  const wallet = wallets.find((w) => w.id === request.walletId)
  const r = reviewUnwrap.data
  // The wallet's NEAR and wNEAR reconcile once the unwrap finishes.
  const status = useUnwrapStatus(running, r ? wrapTargets(r.review.accountId, r.review.contract) : undefined)
  const s = status.data
  const finished = s !== undefined && FINAL.includes(s.status)

  const review = () => {
    if (wallet?.nearkitId) reviewUnwrap.mutate({ walletId: wallet.nearkitId, amount: request.amount })
  }
  // The server's review, once the dialog opens.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    review()
  })
  useEffect(() => {
    if (!finished || reported.current) return
    reported.current = true
    onSettled?.(s?.status === 'done')
  }, [finished, s?.status, onSettled])

  const again = () => {
    reviewUnwrap.reset()
    executeUnwrap.reset()
    setRunning(null)
    reported.current = false
    review()
  }

  if (!wallet?.nearkitId)
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-sm text-neg">
          That wallet isn’t a NEARKITS wallet: unwrap from a connected wallet signs it in that wallet.
        </p>
        <div className="flex justify-end border-t border-line-soft pt-4">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    )

  if (!r) {
    if (reviewUnwrap.isError)
      return (
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-sm text-neg">
            {describeError(reviewUnwrap.error).message}
          </p>
          <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" onClick={review}>
              Try again
            </Button>
          </div>
        </div>
      )
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <p className="text-sm text-fg-3">Reading this wallet’s wNEAR…</p>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const amount = formatUnits(BigInt(r.review.amount), NEAR_DECIMALS, { group: true })
  const summary = (
    <Line label="Unwrap" emphasis>
      <Figures>{`${amount} wNEAR → ${amount} NEAR`}</Figures>
    </Line>
  )

  // Unwrapping, or unwrapped: the status as NEARKITS' server reports it.
  if (running) {
    return (
      <div className="flex flex-col gap-4">
        <Lines>
          <Line label="From">{`${r.review.from} · ${formatAccount(r.review.accountId)}`}</Line>
          {summary}
        </Lines>
        <p className={s?.status === 'failed' ? 'text-sm text-neg' : s?.status === 'done' ? 'text-sm text-fg' : 'text-sm text-fg-2'} aria-live="polite">
          {s ? STATUS[s.status] : 'Starting'}
        </p>
        {s?.status === 'done' && <p className="text-xs text-fg-3">{`${amount} wNEAR is now NEAR. Balances update in a moment.`}</p>}
        {s?.message && <p className="text-sm text-neg">{s.message}</p>}
        {s?.hashes.length ? (
          <p className="text-xs text-fg-3">
            {s.hashes.map((h) => (
              <a
                key={h}
                href={caps.explorerUrl ? explorerTxUrl({ explorerUrl: caps.explorerUrl }, h) : undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="num mr-2 underline"
              >
                {`${h.slice(0, 6)}…${h.slice(-4)}`}
              </a>
            ))}
          </p>
        ) : null}
        {!finished && <p className="text-xs text-fg-3">You can close this: it keeps going, and balances update when it’s done.</p>}
        <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
          {finished && s?.status !== 'done' && (
            <Button variant="secondary" onClick={again}>
              Review again
            </Button>
          )}
          <Button variant={finished ? 'primary' : 'ghost'} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    )
  }

  // Reviewed: exactly what NEARKITS will sign, and Confirm.
  const expired = r.expiresAt <= now
  const executeError = executeUnwrap.error ? describeError(executeUnwrap.error).message : null
  return (
    <div className="flex flex-col gap-4">
      <Lines>
        <Line label="From">{`${r.review.from} · ${formatAccount(r.review.accountId)}`}</Line>
        {summary}
        <Line label="Rate">1 wNEAR = 1 NEAR · exact</Line>
        <Line label="Contract call">
          <span className="flex items-center justify-end gap-1.5">
            {`${r.review.contract} · near_withdraw`}
            <InfoTip>{wrapExplainer('unwrap')}</InfoTip>
          </span>
        </Line>
        <Line label="NEARKITS fee">{WRAP_FEE_TEXT}</Line>
        <Line label={<Term term="networkFee">{ACTUAL_NETWORK_FEE_LABEL}</Term>}>
          <Figures>{`≈ ${formatUnits(WRAP_NETWORK_FEE_YOCTO, NEAR_DECIMALS, { maxFraction: 4 })} NEAR`}</Figures>
        </Line>
      </Lines>
      <p className="text-xs text-fg-3">
        {expired
          ? 'This review expired. Review it again.'
          : `Valid for ${formatDuration(r.expiresAt - now)}. Right before signing, NEARKITS reads this wallet’s wNEAR again: if it holds less, nothing is sent.`}
      </p>
      {executeError && (
        <p role="alert" className="text-sm text-neg">
          {executeError}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {expired ? (
          <Button variant="secondary" loading={reviewUnwrap.isPending} onClick={again}>
            Review again
          </Button>
        ) : (
          <Button variant="primary" loading={executeUnwrap.isPending} onClick={() => executeUnwrap.mutate(r.intentId, { onSuccess: () => setRunning(r.intentId) })}>
            Confirm unwrap
          </Button>
        )}
      </div>
    </div>
  )
}
