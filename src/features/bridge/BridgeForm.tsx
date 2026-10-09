import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { ChainMark } from '@/components/brand/ChainMark'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Field, Input, Segmented, Select } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { BRIDGE_SIGN_WINDOW_MS, bridgeChain, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { ENV } from '@/config/env'
import { KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { bpsPct } from '@/lib/bridge/fee'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { BRIDGE_FEE_LABEL, DEFAULT_SLIPPAGE, NEARKIT_FEE_LABEL, SLIPPAGE_PRESETS } from '@/lib/fees'
import { formatAgo, formatUsd, truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { tradeWalletPool } from '@/lib/wallets'
import { rememberOrder, type BridgeDestinationRequest, type BridgeQuoteRequest } from '@/services/bridge'
import { useWallets } from '@/services/queries'
import type { Wallet } from '@/types/domain'
import { countdown, etaText, kitsText, nearText, rawText } from './format'
import { useBridgeAssets, useBridgeClient, useBridgeQuote } from './useBridge'
import { ChainPicker, SendAmountField, SourceConnect, SourceStatus } from './SourceFields'
import { useSendToDeposit, useSourceSide } from './useSourceSide'
import type { SourceWallet } from './useSourceWallet'

/**
 * Bridge & Buy $KITS: the form. The user picks the coin they hold (SOL, ETH or BNB), how much, and
 * the NEAR wallet that receives $KITS; NEARKITS' server prices it with NEAR Intents and NEARKITS'
 * own route, live. "Bridge & Buy $KITS" asks for the order (a deposit address bound to that wallet,
 * amount and fee) and opens the review; Confirm has the user's own wallet send exactly that amount to
 * the deposit address. Nothing here holds funds or keys, and no figure is shown that wasn't quoted.
 */

const KITS = KITS_CONTRACT

/** A destination as the server takes it, from a wallet the page lists. */
function destinationOf(w: Wallet): BridgeDestinationRequest | null {
  if (w.source === 'nearkit') return w.nearkitId ? { kind: 'nearkits', walletId: w.nearkitId } : null
  if (w.source === 'external') return { kind: 'connected', accountId: w.accountId }
  return null
}

export function BridgeForm({ onStarted, initialChain }: { onStarted: (orderId: string) => void; initialChain?: BridgeChainId }) {
  const client = useBridgeClient()
  const assets = useBridgeAssets(true)
  const { data: wallets = [] } = useWallets()
  const { nearkit, browser } = tradeWalletPool(wallets)
  const destinations = [...nearkit, ...browser].filter((w) => destinationOf(w) !== null)

  const [chainId, setChainId] = useState<BridgeChainId>(initialChain ?? 'sol')
  const chain = bridgeChain(chainId) as BridgeChain
  const offered = assets.data?.chains.map((c) => c.id) ?? null
  const side = useSourceSide(chain)
  const { source, amountText, setAmountText, settled, amountRaw, precision, insufficient, manual, sourceAddress } = side
  const [destId, setDestId] = useState<string | null>(null)
  const dest = destinations.find((w) => w.id === destId) ?? destinations[0] ?? null
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE)
  const [review, setReview] = useState<BridgeOrderView | null>(null)

  const destination = dest ? destinationOf(dest) : null
  const request: BridgeQuoteRequest | null =
    amountRaw !== null && amountRaw > 0n && destination && (offered === null || offered.includes(chainId))
      ? { chain: chainId, amount: settled, sourceAddress, destination, kitsSlippagePct: slippage }
      : null
  const quote = useBridgeQuote(request)
  const q = request ? quote.data : undefined
  const settling = amountText.trim() !== settled || quote.isFetching

  const start = useMutation({
    mutationFn: (req: BridgeQuoteRequest) => client.start(req),
    onSuccess: (order) => {
      rememberOrder(order.id)
      setReview(order)
    },
  })

  const reason = !destination
    ? 'Choose the NEAR wallet that receives $KITS'
    : offered !== null && !offered.includes(chainId)
      ? `NEAR Intents isn’t taking ${chain.symbol} right now`
      : !(amountRaw && amountRaw > 0n)
        ? (precision ?? 'Enter an amount')
        : insufficient
          ? `Insufficient ${chain.symbol}`
          : !sourceAddress
            ? `Connect your ${chain.name} wallet`
            : quote.isError
              ? (quote.error as Error).message
              : !q || settling
                ? 'Getting a quote…'
                : !q.kits
                  ? (q.kitsUnavailable ?? 'NEARKITS can’t price $KITS right now')
                  : !ENV.mainnetExecution
                    ? 'This build doesn’t send transactions on mainnet'
                    : undefined

  const begin = () => {
    if (!request || !sourceAddress || reason) return
    start.mutate({ ...request, sourceAddress })
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <Panel aria-label="Bridge & Buy">
        <PanelHeader title="Bridge & Buy $KITS" />
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          {/* FROM */}
          <section aria-labelledby="bb-from" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="bb-from" className="legend">
                From
              </h2>
              <SourceStatus source={source} chain={chain} manual={manual} />
            </div>
            <ChainPicker
              chainId={chainId}
              offered={offered}
              onPick={(id) => {
                setChainId(id)
                setAmountText('')
              }}
            />
            <SourceConnect chain={chain} side={side} />
            <SendAmountField chain={chain} side={side} />
          </section>

          <div className="flex items-center gap-3 text-fg-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line-soft" />
            <span className="flex size-8 items-center justify-center rounded-full border border-line bg-well">
              <ArrowDown size={14} />
            </span>
            <span className="h-px flex-1 bg-line-soft" />
          </div>

          {/* TO */}
          <section aria-labelledby="bb-to" className="flex flex-col gap-3">
            <h2 id="bb-to" className="legend">
              To
            </h2>
            {/* The figure sits beside the token where the card is wide enough, under it where it isn't. */}
            <div className="@container rounded-md border border-line bg-well">
              <div className="flex flex-col gap-3 px-3 py-3 @[26rem]:flex-row @[26rem]:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <TokenGlyph symbol="KITS" tokenId={KITS} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="text-base font-semibold text-fg">$KITS</span>
                      <span className="text-sm text-fg-3">Near Kits</span>
                    </p>
                    <p className="flex items-center gap-1 text-xs text-fg-3">
                      <span className="num truncate">{KITS}</span>
                      <CopyButton value={KITS} label="Copy $KITS contract" />
                    </p>
                  </div>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line-soft pt-2 @[26rem]:block @[26rem]:border-0 @[26rem]:pt-0 @[26rem]:text-right">
                  <p className="legend">You receive</p>
                  <p className="num text-lg leading-7 text-fg">{q?.kits ? `≈ ${kitsText(q.kits.amountOut)} KITS` : '—'}</p>
                </div>
              </div>
            </div>
            <Field label="Receiving wallet (NEAR)" hint={dest ? <DestinationHint wallet={dest} /> : undefined}>
              {({ id }) =>
                destinations.length ? (
                  <Select id={id} value={dest?.id ?? ''} onChange={(e) => setDestId(e.target.value)}>
                    {nearkit.length > 0 && (
                      <optgroup label="NEARKITS wallets">
                        {nearkit.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {browser.length > 0 && (
                      <optgroup label="Connected NEAR wallet">
                        {browser.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                ) : (
                  <p id={id} className="rounded-md border border-dashed border-line px-3 py-2.5 text-sm text-fg-3">
                    Connect a NEAR wallet, or sign in to NEARKITS web to use your NEARKITS wallets. $KITS lands there.
                  </p>
                )
              }
            </Field>
            <Field label="$KITS purchase slippage" hint="The least $KITS NEARKITS buys at when the NEAR arrives; past it, nothing is bought and you decide.">
              {() => (
                <Segmented
                  label="Slippage"
                  value={String(slippage)}
                  onChange={(v) => setSlippage(Number(v))}
                  options={SLIPPAGE_PRESETS.map((p) => ({ value: String(p), label: `${p}%` }))}
                />
              )}
            </Field>
          </section>
        </div>
      </Panel>

      <RouteSummary
        chain={chain}
        quote={q}
        loading={request !== null && (quote.isPending || settling)}
        updatedAt={quote.dataUpdatedAt}
        reason={start.isPending ? undefined : reason}
        error={start.error ? (start.error as Error).message : null}
        busy={start.isPending}
        onStart={begin}
      />

      {review && (
        <ReviewModal
          order={review}
          chain={bridgeChain(review.chain) as BridgeChain}
          source={source.current}
          sourceAddress={source.connection?.address ?? null}
          destinationName={dest?.label ?? review.destination.accountId}
          onClose={() => setReview(null)}
          onSent={(id) => {
            setReview(null)
            setAmountText('')
            onStarted(id)
          }}
        />
      )}
    </div>
  )
}

function DestinationHint({ wallet }: { wallet: Wallet }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <AccountText id={wallet.accountId} className="text-fg-2" />
      <span>·</span>
      <span>{wallet.source === 'nearkit' ? 'NEARKITS buys $KITS for it when the NEAR arrives.' : 'You buy $KITS in this wallet when the NEAR arrives (one signature).'}</span>
    </span>
  )
}

function RouteSummary({
  chain,
  quote: q,
  loading,
  updatedAt,
  reason,
  error,
  busy,
  onStart,
}: {
  chain: BridgeChain
  quote: BridgeQuoteView | undefined
  loading: boolean
  updatedAt: number
  reason: string | undefined
  error: string | null
  busy: boolean
  onStart: () => void
}) {
  const now = useNow(5_000)
  return (
    <Panel aria-label="Route and quote" className="flex flex-col">
      <PanelHeader title="Route" actions={q ? <Tag tone="neutral">{loading ? 'Updating…' : `Updated ${formatAgo(updatedAt, now)}`}</Tag> : undefined} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <RouteLine chain={chain} />
        <Lines dense>
          <Line label="You send">
            {q ? <Figures>{`${rawText(q.amountIn, chain.decimals)} ${chain.symbol}${q.amountInUsd !== null ? ` · ${formatUsd(q.amountInUsd)}` : ''}`}</Figures> : '—'}
          </Line>
          <Line label={`NEARKITS fee (${BRIDGE_FEE_LABEL})`}>{q ? <Figures>{`${rawText(q.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures> : '—'}</Line>
          <Line label={`NEAR Intents fee (${q ? bpsPct(q.fee.intentsBps) : '—'})`}>
            {q ? <Figures>{`${rawText(q.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures> : '—'}
          </Line>
          <Line label={`${chain.name} network fee`}>
            <span className="text-fg-3">Shown in your wallet</span>
          </Line>
          <Line label="NEAR delivered">{q ? <Figures>{`≈ ${nearText(q.nearOut)} NEAR`}</Figures> : '—'}</Line>
          <Line label={`$KITS trading fee (${NEARKIT_FEE_LABEL})`}>
            <span className="text-fg-3">{q?.kits ? 'In the $KITS figure' : '—'}</span>
          </Line>
          <Line label="Estimated time">{q ? <Figures>{`${etaText(q.timeEstimateSec)} after deposit`}</Figures> : '—'}</Line>
        </Lines>
        <div className="rounded-md border border-line bg-well px-3 py-3">
          <p className="legend">You receive</p>
          <p className="num mt-1 text-2xl font-semibold leading-8 text-fg">{q?.kits ? `≈ ${kitsText(q.kits.amountOut)} KITS` : loading ? '…' : '—'}</p>
          <p className="mt-1 text-xs text-fg-3">
            {q?.kits
              ? `At least ${kitsText(q.kits.minOut)} KITS at ${q.kits.slippagePct}% slippage, or NEARKITS asks you before buying.`
              : q?.kitsUnavailable
                ? q.kitsUnavailable
                : 'Priced live by NEAR Intents and NEARKITS’ route.'}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="xl" block onClick={onStart} disabled={reason !== undefined} loading={busy}>
            Bridge &amp; Buy $KITS
          </Button>
          {(error ?? reason) && <p className={cn('text-center text-xs', error ? 'text-neg' : 'text-fg-3')}>{error ?? reason}</p>}
        </div>
        <p className="flex items-start gap-2 text-xs leading-5 text-fg-3">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-fg-3" aria-hidden="true" />
          Powered by NEAR Intents. Your own wallet sends; NEARKITS never holds your {chain.symbol}. A failed bridge refunds your address.
        </p>
      </div>
    </Panel>
  )
}

/** SOL → NEAR → $KITS: who does which step. */
export function RouteLine({ chain }: { chain: BridgeChain }) {
  return (
    <ol className="@container flex items-center justify-between gap-1 rounded-md border border-line-soft px-2.5 py-2" aria-label={`Route: ${chain.symbol} to NEAR to $KITS`}>
      <li className="flex items-center gap-1.5">
        <ChainMark chain={chain.id} size={20} />
        <span className="text-sm font-semibold text-fg">{chain.symbol}</span>
      </li>
      <li aria-hidden="true" className="flex min-w-0 flex-col items-center text-fg-3">
        <span className="hidden truncate text-2xs @[21rem]:block">NEAR Intents</span>
        <ArrowRight size={12} />
      </li>
      <li className="flex items-center gap-1.5">
        <TokenGlyph symbol="NEAR" tokenId={NATIVE_TOKEN_ID} size={20} />
        <span className="text-sm font-semibold text-fg">NEAR</span>
      </li>
      <li aria-hidden="true" className="flex min-w-0 flex-col items-center text-fg-3">
        <span className="hidden truncate text-2xs @[21rem]:block">NEARKITS</span>
        <ArrowRight size={12} />
      </li>
      <li className="flex items-center gap-1.5">
        <TokenGlyph symbol="KITS" tokenId={KITS} size={20} />
        <span className="text-sm font-semibold text-fg">$KITS</span>
      </li>
    </ol>
  )
}

/**
 * The review: the order's own figures (its real quote), how long it can still be sent, and Confirm,
 * which has the user's wallet send exactly the quoted amount to the deposit address. Without a
 * connected wallet it shows what to send where, and the user says when it went out.
 */
function ReviewModal({
  order,
  chain,
  source,
  sourceAddress,
  destinationName,
  onClose,
  onSent,
}: {
  order: BridgeOrderView
  chain: BridgeChain
  source: SourceWallet | null
  sourceAddress: string | null
  destinationName: string
  onClose: () => void
  onSent: (orderId: string) => void
}) {
  const now = useNow(1_000)
  const q = order.quote
  const expired = now >= order.signBy
  const viaWallet = source !== null && sourceAddress === order.sourceAddress
  const amount = `${rawText(q.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`
  const { send: sendNow, sentManually, sending, error, manualHash, setManualHash } = useSendToDeposit(order, chain, source, onSent)
  const send = () => sendNow(expired)

  return (
    <Modal
      open
      onClose={sending ? () => undefined : onClose}
      dismissible={!sending}
      size="md"
      title="Review Bridge & Buy"
      description={expired ? 'This quote expired. Get a new one.' : `Send within ${countdown(order.signBy, now)}. The price is NEAR Intents’ quote for this deposit address.`}
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            {expired ? 'Close' : 'Cancel'}
          </Button>
          {!expired &&
            (viaWallet ? (
              <Button variant="primary" size="lg" onClick={send} loading={sending}>
                Confirm in {source?.wallet.name}
              </Button>
            ) : (
              <Button variant="primary" size="lg" onClick={sentManually}>
                I’ve sent it
              </Button>
            ))}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <RouteLine chain={chain} />
        <Lines dense>
          <Line label="You send" emphasis>
            <Figures>{amount}</Figures>
          </Line>
          <Line label={`NEARKITS fee (${bpsPct(q.fee.nearkitsBps)})`}>
            <Figures>{`${rawText(q.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
          </Line>
          <Line label={`NEAR Intents fee (${bpsPct(q.fee.intentsBps)})`}>
            <Figures>{`${rawText(q.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
          </Line>
          <Line label="NEAR delivered">
            <Figures>{`≈ ${nearText(q.nearOut)} NEAR (at least ${nearText(q.nearMinOut)})`}</Figures>
          </Line>
          <Line label={`$KITS bought (trading fee ${NEARKIT_FEE_LABEL})`} emphasis>
            <Figures>{q.kits ? `≈ ${kitsText(q.kits.amountOut)} KITS` : '—'}</Figures>
          </Line>
          <Line label="Least $KITS">
            <Figures>{q.kits ? `${kitsText(q.kits.minOut)} KITS (${q.kits.slippagePct}% slippage)` : '—'}</Figures>
          </Line>
          <Line label="Receiving wallet">
            <span className="flex min-w-0 flex-col items-end">
              <span className="truncate text-fg">{destinationName}</span>
              <AccountText id={order.destination.accountId} className="text-xs text-fg-3" />
            </span>
          </Line>
          <Line label="Refunds go to">
            <span className="num text-fg-2" title={order.sourceAddress}>
              {truncateMiddle(order.sourceAddress, 8, 6)}
            </span>
          </Line>
          <Line label="Estimated time">
            <Figures>{etaText(q.timeEstimateSec)}</Figures>
          </Line>
        </Lines>
        <p className="rounded-md border border-line-soft bg-well/60 px-3 py-2 text-xs leading-5 text-fg-3">
          Two steps. NEAR Intents brings your {chain.symbol} to NEAR and delivers it to the receiving wallet; then{' '}
          {order.destination.kind === 'nearkits'
            ? 'NEARKITS buys $KITS with it at the price then, never for less than the least $KITS above (otherwise it asks you).'
            : 'you buy $KITS with it in that wallet, with one signature.'}{' '}
          If the bridge can’t complete, NEAR Intents refunds your address.
        </p>
        {!viaWallet && !expired && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/5 p-3">
            <p className="text-sm text-fg">
              Send exactly <span className="num font-semibold">{amount}</span> from <span className="num">{truncateMiddle(order.sourceAddress, 6, 4)}</span> to:
            </p>
            <p className="flex items-center gap-1.5">
              <span className="num break-all text-sm text-fg">{order.depositAddress}</span>
              <CopyButton value={order.depositAddress} label="Copy deposit address" />
            </p>
            <p className="text-xs text-fg-3">
              Before {new Date(order.signBy).toLocaleTimeString()}. Only {chain.symbol} on {chain.name}; anything else, or sending after the deposit address closes, can be lost.
            </p>
            <Field label="Transaction hash (optional)" hint="It lets NEAR Intents find your transfer sooner.">
              {({ id }) => <Input id={id} mono inputSize="sm" value={manualHash} onChange={(e) => setManualHash(e.target.value)} spellCheck={false} autoComplete="off" />}
            </Field>
          </div>
        )}
        <p className="flex items-center justify-between gap-2 text-xs text-fg-3">
          <span>Deposit address</span>
          <span className="flex items-center gap-1">
            <span className="num" title={order.depositAddress}>
              {truncateMiddle(order.depositAddress, 8, 6)}
            </span>
            <CopyButton value={order.depositAddress} label="Copy deposit address" />
          </span>
        </p>
        {error && <p className="text-sm text-neg">{error}</p>}
        <p className="text-2xs text-fg-4">{`Quotes stay sendable for ${BRIDGE_SIGN_WINDOW_MS / 60_000} minutes.`}</p>
      </div>
    </Modal>
  )
}
