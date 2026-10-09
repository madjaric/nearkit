import { useMutation } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AccountText } from '@/components/domain/Account'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { CopyButton } from '@/components/ui/Copy'
import { Figures } from '@/components/ui/Figures'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { bridgeChain, type BridgeChain } from '@/config/bridge'
import { NATIVE_TOKEN_ID, NETWORKS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { bpsPct } from '@/lib/bridge/fee'
import { bridgeHeadline, bridgeTone, nearBridgeSteps } from '@/lib/bridge/progress'
import type { BridgeOrderView } from '@/lib/bridge/types'
import { formatAgo, truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { signsInBrowser } from '@/lib/wallets'
import { usePlanners, useWallets } from '@/services/queries'
import { OperationModal } from '../tools/OperationModal'
import { nearText, rawText } from './format'
import { STATUS_TONE, useBalancesAfter } from './orderEffects'
import { AwaitingDeposit, StepList, TxLinks } from './orderParts'
import { useBridgeClient, useBridgeOrder, useRefreshOrder } from './useBridge'

/**
 * One Bridge to NEAR, as it happens: each step marked done only on what was seen (NEAR Intents'
 * report of the transfer, the wNEAR or NEAR on chain in the destination, the unwrap's own record),
 * what arrived in which asset, what to do when it stopped, and every transaction linked. A refresh,
 * or coming back from Activity later, finds the same order on NEARKITS' server.
 */

const WRAP = NETWORKS.mainnet.wrapContract

export function NearOrderView({ id, onNew }: { id: string; onNew: () => void }) {
  const order = useBridgeOrder(id)
  const now = useNow(5_000)
  const o = order.data
  useBalancesAfter(o)
  if (order.isPending)
    return (
      <Panel>
        <div className="p-5">
          <Skeleton className="h-40 w-full" />
        </div>
      </Panel>
    )
  if (!o)
    return (
      <Panel>
        <div className="flex flex-col items-start gap-3 p-5">
          <p className="text-sm text-fg">{(order.error as Error | null)?.message ?? 'That Bridge order isn’t here.'}</p>
          <Button variant="secondary" onClick={onNew}>
            New Bridge
          </Button>
        </div>
      </Panel>
    )
  const chain = bridgeChain(o.chain) as BridgeChain
  const result = received(o)
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <Panel aria-label="Bridge progress">
        <PanelHeader title="Bridge to NEAR" actions={<Tag tone={STATUS_TONE[bridgeTone(o.status)]}>{bridgeHeadline(o)}</Tag>} />
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          {o.status === 'complete' && result ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 px-4 py-4">
              <p className="legend">You received</p>
              <p className="num mt-1 text-3xl font-semibold leading-9 text-accent">{result}</p>
              <p className="mt-1 text-sm text-fg-2">
                for <Figures>{`${rawText(o.quote.amountIn, chain.decimals)} ${chain.symbol}`}</Figures>, in {o.destination.name ?? <AccountText id={o.destination.accountId} />}
              </p>
              {o.message && <p className="mt-2 text-xs text-fg-3">{o.message}</p>}
            </div>
          ) : (
            <p className="text-base text-fg">{o.message ?? bridgeHeadline(o)}</p>
          )}
          <StepList steps={nearBridgeSteps(o)} />
          <Actions order={o} chain={chain} onNew={onNew} />
        </div>
      </Panel>

      <Panel aria-label="Order details">
        <PanelHeader title="Details" actions={<span className="text-xs text-fg-3">Updated {formatAgo(o.updatedAt, now)}</span>} />
        <div className="p-4 sm:p-5">
          <Lines dense>
            <Line label="You send">
              <Figures>{`${rawText(o.quote.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`}</Figures>
            </Line>
            <Line label={`NEARKITS bridge fee (${bpsPct(o.quote.fee.nearkitsBps)})`}>
              <Figures>{`${rawText(o.quote.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
            </Line>
            <Line label={`NEAR Intents fee (${bpsPct(o.quote.fee.intentsBps)})`}>
              <Figures>{`${rawText(o.quote.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
            </Line>
            <Line label="Route">{`${chain.name} → NEAR`}</Line>
            <Line label="Destination">
              <span className="flex min-w-0 flex-col items-end">
                {o.destination.name && <span className="text-fg">{o.destination.name}</span>}
                <span className="flex min-w-0 items-center gap-1">
                  {/* An account typed in is shown whole (it was the user's to check); a wallet of theirs by its short form. */}
                  <span className="num break-all text-right text-xs text-fg-3" title={o.destination.accountId}>
                    {o.destination.kind === 'external' ? o.destination.accountId : truncateMiddle(o.destination.accountId, 8, 6)}
                  </span>
                  <CopyButton value={o.destination.accountId} label="Copy destination account" />
                </span>
              </span>
            </Line>
            <Line label={`${chain.name} transfer`}>
              <TxLinks txs={o.depositTx ? [o.depositTx] : []} label={`${chain.name} transfer`} />
            </Line>
            <Line label="Quoted">
              <Figures>{`≈ ${nearText(o.quote.nearOut)} NEAR (at least ${nearText(o.quote.nearMinOut)})`}</Figures>
            </Line>
            <Line label="Delivered on NEAR">
              {o.delivered ? (
                <span className="flex flex-col items-end gap-0.5">
                  <Figures>{`${nearText(o.delivered.amount)} ${o.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'}`}</Figures>
                  <TxLinks txs={o.delivered.txs} label="Delivery" />
                </span>
              ) : (
                <span className="text-fg-3">Not yet</span>
              )}
            </Line>
            {(o.unwrapped || o.delivered?.asset === 'wnear') && (
              <Line label="Unwrapped to NEAR">
                {o.unwrapped ? (
                  <span className="flex flex-col items-end gap-0.5">
                    <Figures>{`${nearText(o.unwrapped.amount)} NEAR`}</Figures>
                    <TxLinks txs={o.unwrapped.txs} label="Unwrap" />
                  </span>
                ) : (
                  <span className="text-fg-3">{o.destination.kind === 'external' ? 'Not here: the account’s owner unwraps it' : 'Not yet'}</span>
                )}
              </Line>
            )}
            {o.refund && (
              <Line label="Refunded">
                <span className="flex flex-col items-end gap-0.5">
                  <Figures>{o.refund.amount ? `${rawText(o.refund.amount, chain.decimals)} ${chain.symbol}` : 'To your address'}</Figures>
                  <TxLinks txs={o.refund.txs} label="Refund" />
                </span>
              </Line>
            )}
            {o.refund?.reason && <Line label="Refund reason">{o.refund.reason}</Line>}
            <Line label="Refunds go to">
              <span className="num text-fg-2" title={o.sourceAddress}>
                {truncateMiddle(o.sourceAddress, 6, 4)}
              </span>
            </Line>
            <Line label="Started">{new Date(o.createdAt).toLocaleString()}</Line>
          </Lines>
        </div>
      </Panel>
    </div>
  )
}

/** What arrived, verified: native NEAR from the unwrap, or the delivery as it came. Null before anything did. */
function received(o: BridgeOrderView): string | null {
  if (o.unwrapped) return `${nearText(o.unwrapped.amount)} NEAR`
  if (o.delivered) return `${nearText(o.delivered.amount)} ${o.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'}`
  return null
}

/** What the user can do now, for this state. Nothing here retries a cross-chain step by itself. */
function Actions({ order: o, chain, onNew }: { order: BridgeOrderView; chain: BridgeChain; onNew: () => void }) {
  const next = (
    <Link to="/swap" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
      Trade on Swap
    </Link>
  )
  const activity = (
    <Link to="/" className={buttonClass({ variant: 'ghost', size: 'lg' })}>
      View activity
    </Link>
  )
  if (o.status === 'awaiting-deposit' && !o.depositTx) return <AwaitingDeposit order={o} chain={chain} newLabel="New Bridge" onNew={onNew} />
  if (o.status === 'complete')
    return (
      <div className="flex flex-wrap gap-2">
        {next}
        {activity}
        <Button variant="ghost" size="lg" onClick={onNew}>
          New Bridge
        </Button>
      </div>
    )
  if ((o.status === 'delivered' || o.status === 'unwrap-needed') && o.destination.kind === 'connected') return <ConnectedUnwrap order={o} />
  if (o.status === 'unwrap-needed' && o.destination.kind === 'nearkits') return <UnwrapAgain order={o} />
  if (o.status === 'refunded' || o.status === 'failed' || o.status === 'expired')
    return (
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="lg" onClick={onNew}>
          New Bridge
        </Button>
        {o.depositTx && (
          <a href={chain.explorerAddress(o.sourceAddress)} target="_blank" rel="noopener noreferrer" className={buttonClass({ variant: 'ghost', size: 'lg' })}>
            Your {chain.name} address <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    )
  return null
}

/**
 * A NEARKITS wallet whose wNEAR wasn't unwrapped: its owner asks NEARKITS to unwrap it now (the same
 * engine unwrap, once per request), or does it on Swap.
 */
function UnwrapAgain({ order: o }: { order: BridgeOrderView }) {
  const client = useBridgeClient()
  const refresh = useRefreshOrder()
  const again = useMutation({ mutationFn: () => client.unwrap(o.id), onSuccess: () => refresh(o.id) })
  const amount = o.delivered ? formatUnits(BigInt(o.delivered.amount), 24, { maxFraction: 6 }) : ''
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" onClick={() => again.mutate()} loading={again.isPending}>
          Unwrap to NEAR now
        </Button>
        <Link
          to={`/swap?from=${encodeURIComponent(WRAP)}&token=${encodeURIComponent(NATIVE_TOKEN_ID)}&amount=${encodeURIComponent(amount)}`}
          className={buttonClass({ variant: 'ghost', size: 'lg' })}
        >
          Unwrap on Swap
        </Link>
      </div>
      {again.error && <p className="text-xs text-neg">{(again.error as Error).message}</p>}
    </div>
  )
}

/**
 * A connected wallet's own unwrap of the wNEAR that arrived: wNEAR → NEAR through the ordinary Swap
 * review (wrap.near's near_withdraw), signed in the wallet. NEARKITS' server then checks it on chain
 * before the order counts as complete.
 */
function ConnectedUnwrap({ order: o }: { order: BridgeOrderView }) {
  const { data: wallets = [] } = useWallets()
  const planners = usePlanners()
  const client = useBridgeClient()
  const refresh = useRefreshOrder()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wallet = wallets.find((w) => signsInBrowser(w) && w.accountId === o.destination.accountId) ?? null
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  if (!o.delivered || o.delivered.asset !== 'wnear') return null
  const raw = BigInt(o.delivered.amount)
  if (!wallet)
    return (
      <p className="rounded-md border border-line-soft bg-well/60 p-3 text-sm text-fg-2">
        Connect <AccountText id={o.destination.accountId} className="text-fg" /> to unwrap the {nearText(raw)} wNEAR that arrived into NEAR.
      </p>
    )
  return (
    <div className="flex flex-col gap-2">
      <Button variant="primary" size="xl" block onClick={() => setOpen(true)}>
        Unwrap {nearText(raw)} wNEAR to NEAR
      </Button>
      <p className="text-xs text-fg-3">One signature in your wallet: wrap.near returns the same amount as native NEAR.</p>
      {error && <p className="text-xs text-neg">{error}</p>}
      {open && (
        <OperationModal
          title="Review unwrap"
          confirmLabel="Unwrap"
          prepare={() => planners.swap({ tokenIn: WRAP, tokenOut: NATIVE_TOKEN_ID, amountIn: formatUnits(raw, 24), slippagePct: 1, walletId: wallet.id })}
          onClose={() => setOpen(false)}
          onSettled={(p) => {
            const hash = [...p.txs].reverse().find((t) => t.hash && t.phase === 'success')?.hash
            if (p.phase !== 'success' || !hash) return
            client
              .settle(o.id, hash)
              .then(() => refresh(o.id))
              .catch((e: unknown) => {
                if (alive.current) setError(`${(e as Error).message} The unwrap itself went through; refresh in a moment.`)
              })
          }}
        />
      )}
    </div>
  )
}
