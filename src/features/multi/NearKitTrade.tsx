import { useEffect, useRef, useState } from 'react'
import { GasReserveLine } from '@/components/domain/GasReserve'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Term } from '@/components/ui/Help'
import { Skeleton, Tag, type TagTone } from '@/components/ui/Indicators'
import { Line, Lines } from '@/components/ui/Panel'
import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits, formatUnitsUp, tryParseUnits } from '@/lib/amounts'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { ACTUAL_NETWORK_FEE_LABEL, gasReserveYocto } from '@/lib/gasReserve'
import { formatPct } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { describeError } from '@/services/errors'
import type { WebLegStatus, WebTradeGroup, WebTradeLeg } from '@/services/nearkitWeb'
import { runningLeg, useCapabilities, useNearKitMutations, useTradeGroup } from '@/services/queries'
import type { Wallet } from '@/types/domain'

/**
 * A buy or sell from NearKit wallets, run from the web: NearKit's server quotes each wallet
 * (the review), and on Execute runs each wallet's own trade with that wallet's own key. The
 * dialog follows every wallet as it runs. A wallet whose price moved past its minimum sends
 * nothing until its new price is confirmed here.
 */

export interface NearKitTradeRequest {
  side: 'buy' | 'sell'
  tokenId: string
  symbol: string
  slippagePct: number
  /** The page's wallet ids (accounts), each with an exact decimal amount. */
  legs: { walletId: string; amountIn: string }[]
}

const STATUS: Record<WebLegStatus, { label: string; tone: TagTone }> = {
  quoted: { label: 'Ready', tone: 'neutral' },
  requoted: { label: 'Price changed', tone: 'warn' },
  executing: { label: 'Executing', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  done: { label: 'Confirmed', tone: 'accent' },
  failed: { label: 'Failed', tone: 'neg' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
}

const FINAL: readonly WebLegStatus[] = ['done', 'failed', 'cancelled', 'expired']

export function NearKitTradeModal({
  request,
  wallets,
  onClose,
  onSettled,
}: {
  request: NearKitTradeRequest
  wallets: readonly Wallet[]
  onClose: () => void
  /** Every wallet finished; `ok`: at least one trade went through. */
  onSettled?: (ok: boolean) => void
}) {
  const multi = request.legs.length > 1
  const verb = request.side === 'buy' ? 'buy' : 'sell'
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={multi ? `Review multi ${verb}` : `Review ${verb}`}
      description="NEARKITS executes it from your NEARKITS wallets: each one trades its own funds, signed with its own key. No wallet prompt."
    >
      <NearKitTrade request={request} wallets={wallets} onClose={onClose} onSettled={onSettled} />
    </Modal>
  )
}

function NearKitTrade({
  request,
  wallets,
  onClose,
  onSettled,
}: {
  request: NearKitTradeRequest
  wallets: readonly Wallet[]
  onClose: () => void
  onSettled?: (ok: boolean) => void
}) {
  const caps = useCapabilities()
  const { prepareTrade, executeTrade, cancelTrade } = useNearKitMutations()
  const [groupId, setGroupId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const group = useTradeGroup(groupId, running)
  const now = useNow(1000)
  const asked = useRef(false)
  const reported = useRef(false)
  const multi = request.legs.length > 1
  const buy = request.side === 'buy'
  const inUnit = buy ? 'NEAR' : request.symbol
  const outUnit = buy ? request.symbol : 'NEAR'
  const byId = new Map(wallets.map((w) => [w.id, w]))
  const legs = request.legs.flatMap((l) => {
    const w = byId.get(l.walletId)
    return w?.nearkitId ? [{ walletId: w.nearkitId, amountIn: l.amountIn }] : []
  })

  const prepare = () =>
    prepareTrade.mutate(
      { side: request.side, token: request.tokenId, slippagePct: request.slippagePct, legs },
      {
        onSuccess: (g) => {
          setGroupId(g.groupId)
          setRunning(false)
        },
      },
    )
  // The server's quote for each wallet, once the dialog opens.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    prepare()
  })

  const g: WebTradeGroup | undefined = group.data ?? prepareTrade.data
  const shown = g?.legs ?? []
  const settled = running && shown.length > 0 && shown.every((l) => FINAL.includes(l.status))
  const anyDone = shown.some((l) => l.status === 'done')
  useEffect(() => {
    if (!settled || reported.current) return
    reported.current = true
    onSettled?.(anyDone)
  }, [settled, anyDone, onSettled])

  if (!g) {
    if (prepareTrade.isError)
      return (
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-sm text-neg">
            {describeError(prepareTrade.error).message}
          </p>
          <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" onClick={prepare}>
              Try again
            </Button>
          </div>
        </div>
      )
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <p className="text-sm text-fg-3">{multi ? 'Getting a fresh quote for each wallet…' : 'Getting a fresh quote…'}</p>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const outDecimals = buy ? g.decimals : NEAR_DECIMALS
  const fmt = (raw: string) => formatUnits(BigInt(raw), outDecimals, { maxFraction: 6, group: true })
  const open = shown.filter((l) => l.status === 'quoted' || l.status === 'requoted')
  const requoted = shown.filter((l) => l.status === 'requoted')
  const seconds = Math.max(0, Math.round((Math.min(...(open.length ? open : shown).map((l) => l.expiresAt)) - now) / 1000))
  const expired = open.length > 0 && seconds === 0
  const error = executeTrade.error ? describeError(executeTrade.error).message : null

  const execute = (ids: string[]) =>
    groupId &&
    executeTrade.mutate(
      { groupId, intentIds: ids },
      {
        onSuccess: () => {
          setRunning(true)
          void group.refetch()
        },
      },
    )

  /** A wallet's gas reserve: what its plan needs beyond the NEAR it swaps and its registrations. */
  const reserveOf = (l: WebTradeLeg): bigint | null => {
    if (l.need === null) return null
    const nearIn = buy ? tryParseUnits(l.amountIn, NEAR_DECIMALS) : null
    return gasReserveYocto(BigInt(l.need), nearIn?.ok ? nearIn.value : 0n, BigInt(l.registration))
  }
  const reserves = shown.map(reserveOf).filter((r): r is bigint => r !== null)
  const reserveMax = reserves.length ? reserves.reduce((a, b) => (b > a ? b : a)) : null
  const reserveText =
    reserveMax === null
      ? null
      : `${multi && reserves.some((r) => r !== reserveMax) ? 'up to ' : ''}${formatUnitsUp(reserveMax, NEAR_DECIMALS, 4)} NEAR${multi ? ' per wallet' : ''}`

  const legRow = (l: WebTradeLeg) => {
    const short = l.need !== null && l.available !== null && BigInt(l.available) < BigInt(l.need)
    const reserve = reserveOf(l)
    return (
      <li key={l.walletId} className="flex flex-col gap-1 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg">{l.name}</span>
          <Tag tone={running && l.status === 'quoted' ? 'neutral' : STATUS[l.status].tone}>{running && l.status === 'quoted' ? 'Starting' : STATUS[l.status].label}</Tag>
        </div>
        <p className="num text-xs text-fg-3">
          {l.status === 'done' && l.received
            ? `${l.amountIn} ${inUnit} → ${fmt(l.received)} ${outUnit}`
            : `${l.amountIn} ${inUnit} → ≈ ${fmt(l.amountOut)} ${outUnit} · min ${fmt(l.minOut)}`}
        </p>
        {!running && short && (
          <p className="text-xs text-warn">
            <Figures>{`Has ${formatUnits(BigInt(l.available as string), NEAR_DECIMALS, { maxFraction: 4 })} NEAR available, needs ${formatUnitsUp(BigInt(l.need as string), NEAR_DECIMALS, 4)}${reserve !== null ? `, including a ${formatUnitsUp(reserve, NEAR_DECIMALS, 4)} NEAR gas reserve that is refunded after the trade` : ''}: this wallet’s trade fails unless it gets more NEAR first.`}</Figures>
          </p>
        )}
        {l.status === 'requoted' && <p className="text-xs text-warn">The price moved past its minimum, so nothing was sent from it. This is its new quote.</p>}
        {l.status === 'processing' && <p className="text-xs text-fg-3">Sent; waiting for the NEAR network.</p>}
        {l.message && <p className="text-xs text-neg">{l.message}</p>}
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-line-soft rounded-sm border border-line" aria-label={multi ? 'Wallets in this trade' : 'This trade'}>
        {shown.map(legRow)}
      </ul>
      {!running && (
        <Lines>
          {multi && (
            <Line label="Total" emphasis>
              <Figures>{`${shown.reduce((s, l) => s + Number(l.amountIn), 0)} ${inUnit} → ≈ ${fmt(shown.reduce((s, l) => s + BigInt(l.amountOut), 0n).toString())} ${outUnit}`}</Figures>
            </Line>
          )}
          <Line label="NEARKITS fee">{g.fee.charged ? `${NEARKIT_FEE_LABEL} (included in the rate)` : `Not charged on ${caps.networkLabel.toLowerCase()}`}</Line>
          <Line label="Price impact">{g.priceImpactPct === null ? 'Unknown' : formatPct(g.priceImpactPct, { decimals: 2 })}</Line>
          <Line label={<Term term="networkFee">{ACTUAL_NETWORK_FEE_LABEL}</Term>}>
            <Figures>{`≈ ${formatUnits(BigInt(g.networkFeeNear), NEAR_DECIMALS, { maxFraction: 4 })} NEAR${multi ? ' per wallet' : ''}`}</Figures>
          </Line>
          <Line label="Route">{g.path.length ? `${g.path.join(' → ')} · Rhea` : '—'}</Line>
          {reserveText !== null && <GasReserveLine value={reserveText} />}
        </Lines>
      )}
      {g.busy && !running && <p className="text-xs text-warn">NEAR network is currently busy. This trade may take longer than usual.</p>}
      {!running && (
        <p className="text-xs text-fg-3">
          {expired
            ? 'This quote expired. Get a fresh one.'
            : `Valid for ${seconds}s. Right before sending, NEARKITS checks each price again; if a wallet would get less than its minimum, nothing is sent from it until you confirm the new price.`}
        </p>
      )}
      {settled && (
        <p className="text-sm text-fg">
          {`Finished: ${shown.filter((l) => l.status === 'done').length} of ${shown.length} ${shown.length === 1 ? 'trade' : 'trades'} confirmed. Balances update in a moment.`}
        </p>
      )}
      {running && !settled && requoted.length === 0 && shown.some((l) => runningLeg(l.status) || l.status === 'quoted') && (
        <p className="text-xs text-fg-3">NEARKITS is executing each wallet’s trade. You can close this: it keeps going, and balances update when it’s done.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end">
        {!running ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                if (groupId) cancelTrade.mutate(groupId)
                onClose()
              }}
            >
              Cancel
            </Button>
            {expired ? (
              <Button variant="secondary" loading={prepareTrade.isPending} onClick={prepare}>
                Refresh quote
              </Button>
            ) : (
              <Button variant={buy ? 'primary' : 'sell'} loading={executeTrade.isPending} disabled={open.length === 0} onClick={() => execute(open.map((l) => l.intentId))}>
                {multi ? `Execute multi ${request.side} (${open.length})` : `${buy ? 'Buy' : 'Sell'} ${request.symbol}`}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {requoted.length > 0 && (
              <Button variant={buy ? 'primary' : 'sell'} loading={executeTrade.isPending} onClick={() => execute(requoted.map((l) => l.intentId))}>
                {requoted.length === 1 ? 'Confirm new price' : `Confirm new prices (${requoted.length})`}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
