import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react'
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
import { KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID, NETWORKS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { bpsPct } from '@/lib/bridge/fee'
import { bridgeHeadline, bridgeSteps, bridgeTone, type StepState } from '@/lib/bridge/progress'
import type { BridgeOrderView, BridgeTx } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { GAS_RESERVE_YOCTO } from '@/lib/fees'
import { formatAgo, truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { signsInBrowser } from '@/lib/wallets'
import { useServices } from '@/services/context'
import { reconcileBalances, usePlanners, useWallets } from '@/services/queries'
import { useQueryClient } from '@tanstack/react-query'
import { OperationModal } from '../tools/OperationModal'
import { countdown, kitsText, nearText, rawText } from './format'
import { useBridgeClient, useBridgeOrder, useRefreshOrder } from './useBridge'

/**
 * One Bridge & Buy, as it happens: each step marked done only on what was seen (NEAR Intents'
 * report of the transfer, the NEAR on chain in the wallet, the $KITS from the purchase's own record),
 * what to do when it stopped, and every transaction linked. A refresh, or coming back from
 * Activity later, finds the same order on NEARKITS' server.
 */

const TONE = { accent: 'accent', warn: 'warn', danger: 'neg', neutral: 'neutral' } as const

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-accent text-accent-ink">
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  if (state === 'active')
    return (
      <span className="flex size-5 items-center justify-center rounded-full border border-accent/60 text-accent">
        <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </span>
    )
  if (state === 'error')
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-warn/15 text-warn">
        <CircleAlert size={12} aria-hidden="true" />
      </span>
    )
  return <span className="size-5 rounded-full border border-line" aria-hidden="true" />
}

const STATE_WORD: Record<StepState, string> = { done: 'done', active: 'in progress', todo: 'to do', error: 'stopped' }

function TxLinks({ txs, label }: { txs: BridgeTx[]; label: string }) {
  if (!txs.length) return <span className="text-fg-3">—</span>
  return (
    <span className="flex flex-wrap justify-end gap-x-2">
      {txs.map((t) =>
        t.url ? (
          <a
            key={t.hash}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="num inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
            aria-label={`${label} ${t.hash} on the explorer`}
          >
            {truncateMiddle(t.hash, 6, 4)}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : (
          <span key={t.hash} className="num text-fg-2">
            {truncateMiddle(t.hash, 6, 4)}
          </span>
        ),
      )}
    </span>
  )
}

export function OrderView({ id, onNew }: { id: string; onNew: () => void }) {
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
          <p className="text-sm text-fg">{(order.error as Error | null)?.message ?? 'That Bridge & Buy order isn’t here.'}</p>
          <Button variant="secondary" onClick={onNew}>
            New Bridge &amp; Buy
          </Button>
        </div>
      </Panel>
    )
  const chain = bridgeChain(o.chain) as BridgeChain
  const steps = bridgeSteps(o)
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <Panel aria-label="Bridge & Buy progress">
        <PanelHeader title="Bridge & Buy $KITS" actions={<Tag tone={TONE[bridgeTone(o.status)]}>{bridgeHeadline(o)}</Tag>} />
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          {o.status === 'complete' && o.kits ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 px-4 py-4">
              <p className="legend">You received</p>
              <p className="num mt-1 text-3xl font-semibold leading-9 text-accent">{kitsText(o.kits.amount)} KITS</p>
              <p className="mt-1 text-sm text-fg-2">
                for <Figures>{`${rawText(o.quote.amountIn, chain.decimals)} ${chain.symbol}`}</Figures>, in {o.destination.name ?? <AccountText id={o.destination.accountId} />}
              </p>
            </div>
          ) : (
            <p className="text-base text-fg">{o.message ?? bridgeHeadline(o)}</p>
          )}
          <ol className="flex flex-col gap-0" aria-label="Steps">
            {steps.map((s, i) => (
              <li key={s.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <StepIcon state={s.state} />
                  {i < steps.length - 1 && <span className={cn('w-px flex-1', s.state === 'done' ? 'bg-accent/50' : 'bg-line')} aria-hidden="true" />}
                </div>
                <p className={cn('pb-4 text-sm leading-5', s.state === 'todo' ? 'text-fg-3' : s.state === 'error' ? 'text-warn' : 'text-fg')}>
                  {s.label}
                  <span className="sr-only">: {STATE_WORD[s.state]}</span>
                </p>
              </li>
            ))}
          </ol>
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
            <Line label={`NEARKITS fee (${bpsPct(o.quote.fee.nearkitsBps)})`}>
              <Figures>{`${rawText(o.quote.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
            </Line>
            <Line label={`NEAR Intents fee (${bpsPct(o.quote.fee.intentsBps)})`}>
              <Figures>{`${rawText(o.quote.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
            </Line>
            <Line label="Route">{`${chain.symbol} → NEAR → $KITS`}</Line>
            <Line label="Receiving wallet">
              <span className="flex min-w-0 flex-col items-end">
                {o.destination.name && <span className="text-fg">{o.destination.name}</span>}
                <AccountText id={o.destination.accountId} className="text-xs text-fg-3" />
              </span>
            </Line>
            <Line label={`${chain.name} transfer`}>
              <TxLinks txs={o.depositTx ? [o.depositTx] : []} label={`${chain.name} transfer`} />
            </Line>
            <Line label="NEAR delivered">
              {o.delivered ? (
                <span className="flex flex-col items-end gap-0.5">
                  <Figures>{`${nearText(o.delivered.amount)} ${o.delivered.asset === 'wnear' ? 'wNEAR' : 'NEAR'}`}</Figures>
                  <TxLinks txs={o.delivered.txs} label="Delivery" />
                </span>
              ) : (
                <Figures>{`≈ ${nearText(o.quote.nearOut)} NEAR expected`}</Figures>
              )}
            </Line>
            <Line label="$KITS bought">
              {o.kits ? (
                <span className="flex flex-col items-end gap-0.5">
                  <Figures>{`${kitsText(o.kits.amount)} KITS`}</Figures>
                  <TxLinks txs={o.kits.txs} label="Purchase" />
                </span>
              ) : (
                <Figures>{o.quote.kits ? `≈ ${kitsText(o.quote.kits.amountOut)} KITS expected` : '—'}</Figures>
              )}
            </Line>
            {o.refund && (
              <Line label="Refunded">
                <span className="flex flex-col items-end gap-0.5">
                  <Figures>{o.refund.amount ? `${rawText(o.refund.amount, chain.decimals)} ${chain.symbol}` : 'To your address'}</Figures>
                  <TxLinks txs={o.refund.txs} label="Refund" />
                </span>
              </Line>
            )}
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

/**
 * When NEAR arrives, and again when $KITS does (NEARKITS' server bought it), the receiving wallet's
 * NEAR, wNEAR and $KITS reconcile everywhere (balances, portfolio, positions, activity), as after a
 * trade. Once per change this page sees.
 */
function useBalancesAfter(o: BridgeOrderView | undefined) {
  const s = useServices()
  const qc = useQueryClient()
  const seen = useRef<string | null>(null)
  const key = o && (o.status === 'delivered' || o.status === 'complete' || o.status === 'buy-needed') ? `${o.id}:${o.status}` : null
  useEffect(() => {
    if (!o || !key || seen.current === key) return
    // The first reading of an order already settled before this page opened refreshes too: cheap, and never stale.
    seen.current = key
    reconcileBalances(s, qc, { accounts: [o.destination.accountId], tokens: [NATIVE_TOKEN_ID, NETWORKS.mainnet.wrapContract, KITS_CONTRACT] }, new Map())
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** What the user can do now, for this state. Nothing here retries a cross-chain step by itself. */
function Actions({ order: o, chain, onNew }: { order: BridgeOrderView; chain: BridgeChain; onNew: () => void }) {
  const now = useNow(1_000)
  const kitsLink = (
    <Link to="/kit" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
      View $KITS
    </Link>
  )
  const activity = (
    <Link to="/" className={buttonClass({ variant: 'ghost', size: 'lg' })}>
      View activity
    </Link>
  )
  if (o.status === 'awaiting-deposit' && !o.depositTx) {
    const open = now < o.depositDeadline
    return (
      <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-well/60 p-3 text-sm">
        {open ? (
          <>
            <p className="text-fg">
              Waiting for <span className="num font-semibold">{`${rawText(o.quote.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`}</span> from{' '}
              <span className="num">{truncateMiddle(o.sourceAddress, 6, 4)}</span> to the deposit address:
            </p>
            <p className="flex items-center gap-1.5">
              <span className="num break-all text-fg">{o.depositAddress}</span>
              <CopyButton value={o.depositAddress} label="Copy deposit address" />
            </p>
            <p className="text-xs text-fg-3">
              {now < o.signBy
                ? `Send within ${countdown(o.signBy, now)}, and only if you haven’t sent it yet.`
                : 'The time to send this quote has passed: don’t send to it now. Start a new Bridge & Buy.'}
            </p>
          </>
        ) : (
          <p className="text-fg-3">The deposit address closed. If nothing was sent, nothing happens.</p>
        )}
        <div>
          <Button variant="ghost" size="sm" onClick={onNew}>
            New Bridge &amp; Buy
          </Button>
        </div>
      </div>
    )
  }
  if (o.status === 'complete')
    return (
      <div className="flex flex-wrap gap-2">
        {kitsLink}
        {activity}
        <Button variant="ghost" size="lg" onClick={onNew}>
          New Bridge &amp; Buy
        </Button>
      </div>
    )
  if ((o.status === 'delivered' || o.status === 'buy-needed') && o.destination.kind === 'connected') return <ConnectedPurchase order={o} />
  if (o.status === 'buy-needed' && o.delivered) {
    const near = o.delivered.asset === 'wnear' ? 'wrap.near' : NATIVE_TOKEN_ID
    const amount = formatUnits(BigInt(o.delivered.amount), 24, { maxFraction: 4 })
    return (
      <div className="flex flex-wrap gap-2">
        <Link
          to={`/swap?from=${encodeURIComponent(near)}&token=${encodeURIComponent(KITS_CONTRACT)}&amount=${encodeURIComponent(amount)}`}
          className={buttonClass({ variant: 'primary', size: 'lg' })}
        >
          Buy $KITS on Swap
        </Link>
        {activity}
      </div>
    )
  }
  if (o.status === 'refunded' || o.status === 'failed' || o.status === 'expired')
    return (
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="lg" onClick={onNew}>
          New Bridge &amp; Buy
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
 * A connected wallet's purchase: the NEAR that arrived (wNEAR as wNEAR, native NEAR less a gas
 * reserve), NEAR → $KITS through the ordinary Swap review, signed in the wallet. NEARKITS' server
 * then checks the transaction on chain before the order counts as complete.
 */
function ConnectedPurchase({ order: o }: { order: BridgeOrderView }) {
  const { data: wallets = [] } = useWallets()
  const planners = usePlanners()
  const client = useBridgeClient()
  const refresh = useRefreshOrder()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wallet = wallets.find((w) => signsInBrowser(w) && w.accountId === o.destination.accountId) ?? null
  const delivered = o.delivered
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  if (!delivered) return null
  const wnear = delivered.asset === 'wnear'
  const raw = BigInt(delivered.amount)
  const spend = wnear ? raw : raw > GAS_RESERVE_YOCTO ? raw - GAS_RESERVE_YOCTO : 0n
  const amountIn = formatUnits(spend, 24)
  const slippagePct = o.quote.kits?.slippagePct ?? 1
  if (!wallet)
    return (
      <p className="rounded-md border border-line-soft bg-well/60 p-3 text-sm text-fg-2">
        Connect <AccountText id={o.destination.accountId} className="text-fg" /> to buy $KITS with the {wnear ? 'wNEAR' : 'NEAR'} that arrived.
      </p>
    )
  return (
    <div className="flex flex-col gap-2">
      <Button variant="primary" size="xl" block disabled={spend === 0n} onClick={() => setOpen(true)}>
        Buy $KITS with {nearText(spend)} {wnear ? 'wNEAR' : 'NEAR'}
      </Button>
      <p className="text-xs text-fg-3">{wnear ? 'NEAR Intents delivered wNEAR: it buys $KITS directly.' : 'A little NEAR stays in the wallet for network fees.'}</p>
      {error && <p className="text-xs text-neg">{error}</p>}
      {open && (
        <OperationModal
          title="Review $KITS purchase"
          confirmLabel="Buy $KITS"
          prepare={() => planners.swap({ tokenIn: wnear ? NETWORKS.mainnet.wrapContract : NATIVE_TOKEN_ID, tokenOut: KITS_CONTRACT, amountIn, slippagePct, walletId: wallet.id })}
          onClose={() => setOpen(false)}
          onSettled={(p) => {
            const hash = [...p.txs].reverse().find((t) => t.hash && t.phase === 'success')?.hash
            if (p.phase !== 'success' || !hash) return
            client
              .settle(o.id, hash)
              .then(() => refresh(o.id))
              .catch((e: unknown) => {
                if (alive.current) setError(`${(e as Error).message} The purchase itself went through; refresh in a moment.`)
              })
          }}
        />
      )}
    </div>
  )
}
