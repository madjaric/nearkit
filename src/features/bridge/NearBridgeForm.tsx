import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ChainMark } from '@/components/brand/ChainMark'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { Field, Input, Select } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { BRIDGE_SIGN_WINDOW_MS, bridgeChain, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { ENV } from '@/config/env'
import { NATIVE_TOKEN_ID, NETWORKS } from '@/config/networks'
import { bpsPct } from '@/lib/bridge/fee'
import type { BridgeDelivery, BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { BRIDGE_FEE_LABEL } from '@/lib/fees'
import { formatAgo, formatUsd, truncateMiddle } from '@/lib/format'
import { useDebouncedValue, useNow } from '@/lib/hooks'
import { accountIdError } from '@/lib/validation'
import { tradeWalletPool } from '@/lib/wallets'
import { rememberOrder, type BridgeDestinationRequest, type BridgeQuoteRequest } from '@/services/bridge'
import { usePlanners, useWallets } from '@/services/queries'
import { WRAP_NETWORK_FEE_YOCTO } from '@/services/near/wrap'
import type { Wallet } from '@/types/domain'
import { OperationModal } from '../tools/OperationModal'
import { countdown, etaText, nearText, rawText } from './format'
import { ChainPicker, SendAmountField, SourceConnect, SourceStatus } from './SourceFields'
import { useBridgeAssets, useBridgeClient, useBridgeQuote } from './useBridge'
import { useSendToDeposit, useSourceSide } from './useSourceSide'
import type { SourceWallet } from './useSourceWallet'

/**
 * The Bridge to NEAR: the form. The user picks the coin they hold (SOL, ETH or BNB), how much, and
 * where the NEAR goes: one of their NEARKITS wallets, the NEAR wallet they connected, or any NEAR
 * account. NEARKITS' server prices it with NEAR Intents, live, and says what arrives (wNEAR, as NEAR
 * Intents delivers NEAR) and who turns it into native NEAR, and whether that destination can receive
 * it at all, before anything can be sent. "Bridge to NEAR" asks for the order and opens the review;
 * Confirm has the user's own wallet send exactly that amount. Nothing is bought; no figure is shown
 * that wasn't quoted.
 */

const WRAP = NETWORKS.mainnet.wrapContract

type DestinationMode = 'nearkits' | 'connected' | 'external'

const MODES: { value: DestinationMode; title: string; text: string }[] = [
  { value: 'nearkits', title: 'My NEARKITS wallet', text: 'NEARKITS unwraps it to NEAR there.' },
  { value: 'connected', title: 'Connected NEAR wallet', text: 'Your wallet signs the unwrap.' },
  { value: 'external', title: 'External NEAR address', text: 'Arrives as wNEAR.' },
]

const short = (account: string) => (account.length > 24 ? truncateMiddle(account, 8, 6) : account)

/** An external NEAR account as typed: null while it isn't one (with why), on NEAR mainnet. */
function externalProblem(raw: string): string | null {
  const id = raw.trim().toLowerCase()
  if (!id) return null
  if (id.endsWith('.testnet')) return 'That is a testnet account. The Bridge delivers on NEAR mainnet.'
  return accountIdError(id)
}

export function NearBridgeForm({ onStarted, initialChain }: { onStarted: (orderId: string) => void; initialChain?: BridgeChainId }) {
  const client = useBridgeClient()
  const assets = useBridgeAssets(true)
  const { data: wallets = [] } = useWallets()
  const { nearkit, browser } = tradeWalletPool(wallets)

  const [chainId, setChainId] = useState<BridgeChainId>(initialChain ?? 'sol')
  const chain = bridgeChain(chainId) as BridgeChain
  const offered = assets.data?.chains.map((c) => c.id) ?? null
  const side = useSourceSide(chain)
  const { source, amountText, setAmountText, settled, amountRaw, precision, insufficient, manual, sourceAddress } = side

  const [mode, setMode] = useState<DestinationMode>(nearkit.length ? 'nearkits' : browser.length ? 'connected' : 'nearkits')
  const [nearkitId, setNearkitId] = useState<string | null>(null)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [externalText, setExternalText] = useState('')
  const externalSettled = useDebouncedValue(externalText.trim().toLowerCase(), 500)
  const externalError = externalProblem(externalSettled)
  const pickedNearkit = nearkit.find((w) => w.id === nearkitId) ?? nearkit[0] ?? null
  const pickedConnected = browser.find((w) => w.id === connectedId) ?? browser[0] ?? null
  const destination: BridgeDestinationRequest | null =
    mode === 'nearkits'
      ? pickedNearkit?.nearkitId
        ? { kind: 'nearkits', walletId: pickedNearkit.nearkitId }
        : null
      : mode === 'connected'
        ? pickedConnected
          ? { kind: 'connected', accountId: pickedConnected.accountId }
          : null
        : externalSettled && !externalError
          ? { kind: 'external', accountId: externalSettled }
          : null
  const destinationAccount =
    mode === 'nearkits' ? (pickedNearkit?.accountId ?? null) : mode === 'connected' ? (pickedConnected?.accountId ?? null) : destination ? externalSettled : null
  const destinationName = mode === 'nearkits' ? (pickedNearkit?.label ?? null) : mode === 'connected' ? (pickedConnected?.label ?? null) : null

  const request: BridgeQuoteRequest | null =
    amountRaw !== null && amountRaw > 0n && destination && (offered === null || offered.includes(chainId))
      ? { product: 'bridge', chain: chainId, amount: settled, sourceAddress, destination }
      : null
  const quote = useBridgeQuote(request)
  const q = request ? quote.data : undefined
  const settling = amountText.trim() !== settled || quote.isFetching
  const [review, setReview] = useState<BridgeOrderView | null>(null)

  const start = useMutation({
    mutationFn: (req: BridgeQuoteRequest) => client.start(req),
    onSuccess: (order) => {
      rememberOrder(order.id)
      setReview(order)
    },
  })

  const reason = !destination
    ? mode === 'external'
      ? (externalError ?? 'Enter the NEAR account that receives the NEAR')
      : mode === 'nearkits'
        ? 'Sign in to NEARKITS web to use your NEARKITS wallets'
        : 'Connect a NEAR wallet'
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
                : q.delivery?.blocked
                  ? 'This destination can’t receive it yet'
                  : !ENV.mainnetExecution
                    ? 'This build doesn’t send transactions on mainnet'
                    : undefined

  const begin = () => {
    if (!request || !sourceAddress || reason) return
    start.mutate({ ...request, sourceAddress })
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <Panel aria-label="Bridge to NEAR">
        <PanelHeader title="Bridge to NEAR" />
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          {/* FROM */}
          <section aria-labelledby="br-from" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="br-from" className="legend">
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
          <section aria-labelledby="br-to" className="flex flex-col gap-3">
            <h2 id="br-to" className="legend">
              To
            </h2>
            <div className="@container rounded-md border border-line bg-well">
              <div className="flex flex-col gap-3 px-3 py-3 @[26rem]:flex-row @[26rem]:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <TokenGlyph symbol="NEAR" tokenId={NATIVE_TOKEN_ID} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="text-base font-semibold text-fg">NEAR</span>
                      <span className="text-sm text-fg-3">NEAR Protocol</span>
                    </p>
                    <p className="text-xs text-fg-3">For gas, trading and transfers in NEARKITS</p>
                  </div>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line-soft pt-2 @[26rem]:block @[26rem]:border-0 @[26rem]:pt-0 @[26rem]:text-right">
                  <p className="legend">You receive</p>
                  <p className="num text-lg leading-7 text-fg">{q ? `≈ ${nearText(q.nearOut)} NEAR` : '—'}</p>
                </div>
              </div>
            </div>
          </section>

          {/* DESTINATION */}
          <section aria-labelledby="br-dest" className="flex flex-col gap-3">
            <h2 id="br-dest" className="legend">
              Destination
            </h2>
            <div role="radiogroup" aria-label="Destination" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((m) => {
                const on = m.value === mode
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMode(m.value)}
                    className={cn(
                      'flex min-w-0 flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors',
                      on ? 'border-accent/70 bg-accent/8' : 'border-line bg-well hover:border-line-strong',
                    )}
                  >
                    <span className={cn('text-sm font-semibold leading-5', on ? 'text-fg' : 'text-fg-2')}>{m.title}</span>
                    <span className="text-xs text-fg-3">{m.text}</span>
                  </button>
                )
              })}
            </div>
            {mode === 'nearkits' && (
              <Field label="NEARKITS wallet" hint={pickedNearkit ? <AccountText id={pickedNearkit.accountId} className="text-fg-2" /> : undefined}>
                {({ id }) =>
                  nearkit.length ? (
                    <Select id={id} value={pickedNearkit?.id ?? ''} onChange={(e) => setNearkitId(e.target.value)}>
                      {nearkit.map((w) => (
                        <option key={w.id} value={w.id}>
                          {`${w.label} · ${short(w.accountId)}`}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p id={id} className="rounded-md border border-dashed border-line px-3 py-2.5 text-sm text-fg-3">
                      Sign in to NEARKITS web to use your NEARKITS wallets: send /web to the NEARKITS bot.
                    </p>
                  )
                }
              </Field>
            )}
            {mode === 'connected' && <ConnectedDestination wallets={browser} picked={pickedConnected} onPick={setConnectedId} />}
            {mode === 'external' && (
              <Field
                label="NEAR account"
                hint="Any existing NEAR mainnet account: a name like alice.near, or a 64-character implicit account."
                error={externalText.trim() && externalText.trim().toLowerCase() === externalSettled ? (externalError ?? undefined) : undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    mono
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="alice.near"
                    value={externalText}
                    onChange={(e) => setExternalText(e.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                  />
                )}
              </Field>
            )}
            {q?.delivery && destinationAccount && (
              <DeliveryNote delivery={q.delivery} wallet={mode === 'connected' ? pickedConnected : null} onFixed={() => void quote.refetch()} />
            )}
          </section>
        </div>
      </Panel>

      <QuoteSummary
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
        <NearReviewModal
          order={review}
          chain={bridgeChain(review.chain) as BridgeChain}
          source={source.current}
          sourceAddress={source.connection?.address ?? null}
          destinationName={destinationName}
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

function ConnectedDestination({ wallets, picked, onPick }: { wallets: Wallet[]; picked: Wallet | null; onPick: (id: string) => void }) {
  if (!wallets.length)
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-2.5 text-sm text-fg-3">
        Connect a NEAR wallet (Connect wallet, top right). Its own signature unwraps the wNEAR when it arrives.
      </p>
    )
  return (
    <Field label="Connected NEAR wallet" hint={picked ? <AccountText id={picked.accountId} className="text-fg-2" /> : undefined}>
      {({ id }) => (
        <Select id={id} value={picked?.id ?? ''} onChange={(e) => onPick(e.target.value)}>
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {`${w.label} · ${short(w.accountId)}`}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )
}

/**
 * What arrives and who turns it into NEAR, for the destination chosen, as NEARKITS' server checked
 * it; and, when that destination can't receive it, why, with the one fix the page can offer (a
 * connected wallet registering with wrap.near, which a small wrap does, in its own review).
 */
function DeliveryNote({ delivery, wallet, onFixed }: { delivery: BridgeDelivery; wallet: Wallet | null; onFixed: () => void }) {
  const planners = usePlanners()
  const [registering, setRegistering] = useState(false)
  if (delivery.blocked)
    return (
      <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/5 p-3">
        <p className="text-sm text-fg">{delivery.blocked}</p>
        {delivery.fix === 'register' && wallet && (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setRegistering(true)}>
              Register with wNEAR
            </Button>
          </div>
        )}
        {registering && wallet && (
          <OperationModal
            title="Register with wNEAR"
            confirmLabel="Register"
            prepare={() => planners.swap({ tokenIn: NATIVE_TOKEN_ID, tokenOut: WRAP, amountIn: '0.001', slippagePct: 1, walletId: wallet.id })}
            onClose={() => setRegistering(false)}
            onSettled={(p) => {
              if (p.phase === 'success') onFixed()
            }}
          />
        )}
      </div>
    )
  const text =
    delivery.unwrap === 'nearkits'
      ? 'NEAR Intents delivers NEAR as wNEAR. NEARKITS unwraps it to native NEAR in this wallet, ready for gas and trading.'
      : delivery.unwrap === 'wallet'
        ? 'NEAR Intents delivers NEAR as wNEAR. Your wallet unwraps it to native NEAR with one signature when it arrives.'
        : 'This account receives wNEAR (wrap.near), as NEAR Intents delivers it. NEARKITS can’t unwrap it there: its owner unwraps it. Transfers to it can’t be reversed.'
  return <p className="rounded-md border border-line-soft bg-well/60 px-3 py-2 text-xs leading-5 text-fg-3">{text}</p>
}

/** The rate as people read it: "1 SOL ≈ 21.4 NEAR", from the quote's own figures (fees included). */
function rateText(chain: BridgeChain, q: BridgeQuoteView): string | null {
  const amountIn = BigInt(q.amountIn)
  if (amountIn === 0n) return null
  return `1 ${chain.symbol} ≈ ${nearText((BigInt(q.nearOut) * 10n ** BigInt(chain.decimals)) / amountIn)} NEAR`
}

function arrivesText(delivery: BridgeDelivery | null | undefined): string {
  if (!delivery) return 'Priced live by NEAR Intents.'
  if (delivery.unwrap === 'nearkits') return 'Arrives as wNEAR; NEARKITS unwraps it to native NEAR in your wallet.'
  if (delivery.unwrap === 'wallet') return 'Arrives as wNEAR; you unwrap it to native NEAR with one signature.'
  return 'Arrives as wNEAR (wrap.near) in that account.'
}

function QuoteSummary({
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
  const rate = q ? rateText(chain, q) : null
  const unwrapFee = q?.delivery && q.delivery.unwrap !== 'none'
  return (
    <Panel aria-label="Quote summary" className="flex flex-col">
      <PanelHeader title="Quote" actions={q ? <Tag tone="neutral">{loading ? 'Updating…' : `Updated ${formatAgo(updatedAt, now)}`}</Tag> : undefined} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <NearRouteLine chain={chain} />
        <Lines dense>
          <Line label="You send">
            {q ? <Figures>{`${rawText(q.amountIn, chain.decimals)} ${chain.symbol}${q.amountInUsd !== null ? ` · ${formatUsd(q.amountInUsd)}` : ''}`}</Figures> : '—'}
          </Line>
          <Line label={`NEARKITS bridge fee (${BRIDGE_FEE_LABEL})`}>{q ? <Figures>{`${rawText(q.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures> : '—'}</Line>
          <Line label={`NEAR Intents fee (${q ? bpsPct(q.fee.intentsBps) : '—'})`}>
            {q ? <Figures>{`${rawText(q.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures> : '—'}
          </Line>
          <Line label={`${chain.name} network fee`}>
            <span className="text-fg-3">Shown in your wallet</span>
          </Line>
          {unwrapFee && (
            <Line label="Unwrap network fee">
              <Figures>{`≈ ${nearText(WRAP_NETWORK_FEE_YOCTO)} NEAR, on NEAR`}</Figures>
            </Line>
          )}
          <Line label="Trading fee">
            <span className="text-fg-3">None: nothing is traded</span>
          </Line>
          <Line label="Rate">{rate ? <Figures>{rate}</Figures> : '—'}</Line>
          <Line label="Estimated time">{q ? <Figures>{`${etaText(q.timeEstimateSec)} after deposit`}</Figures> : '—'}</Line>
        </Lines>
        <div className="rounded-md border border-line bg-well px-3 py-3">
          <p className="legend">You receive</p>
          <p className="num mt-1 text-2xl font-semibold leading-8 text-fg">{q ? `≈ ${nearText(q.nearOut)} NEAR` : loading ? '…' : '—'}</p>
          <p className="mt-1 text-xs text-fg-3">{q ? `At least ${nearText(q.nearMinOut)} NEAR. ${arrivesText(q.delivery)}` : 'Priced live by NEAR Intents.'}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="xl" block onClick={onStart} disabled={reason !== undefined} loading={busy}>
            Bridge to NEAR
          </Button>
          {(error ?? reason) && <p className={cn('text-center text-xs', error ? 'text-neg' : 'text-fg-3')}>{error ?? reason}</p>}
        </div>
        <p className="flex items-start gap-2 text-xs leading-5 text-fg-3">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-fg-3" aria-hidden="true" />
          Powered by NEAR Intents. Your own wallet sends; NEARKITS never holds your {chain.symbol}. A failed bridge refunds your address.
        </p>
        <p className="text-xs text-fg-3">
          Want $KITS with it?{' '}
          <Link to="/bridge" className="font-semibold text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
            Bridge &amp; Buy $KITS
          </Link>
        </p>
      </div>
    </Panel>
  )
}

/** SOL → NEAR: NEAR Intents moves it; nothing after. */
export function NearRouteLine({ chain }: { chain: BridgeChain }) {
  return (
    <ol className="flex items-center justify-between gap-2 rounded-md border border-line-soft px-3 py-2" aria-label={`Route: ${chain.symbol} to NEAR`}>
      <li className="flex items-center gap-1.5">
        <ChainMark chain={chain.id} size={20} />
        <span className="text-sm font-semibold text-fg">{chain.symbol}</span>
        <span className="hidden text-xs text-fg-3 min-[420px]:inline">{chain.name}</span>
      </li>
      <li aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 text-fg-3">
        <span className="h-px flex-1 bg-line" />
        <span className="shrink-0 text-2xs">NEAR Intents</span>
        <ArrowRight size={12} className="shrink-0" />
      </li>
      <li className="flex items-center gap-1.5">
        <TokenGlyph symbol="NEAR" tokenId={NATIVE_TOKEN_ID} size={20} />
        <span className="text-sm font-semibold text-fg">NEAR</span>
      </li>
    </ol>
  )
}

/**
 * The review: the order's own figures (its real quote), where the NEAR goes (in full, with copy, and
 * what arrives there), how long it can still be sent, and Confirm, which has the user's wallet send
 * exactly the quoted amount to the deposit address. Without a connected wallet it shows what to send
 * where, and the user says when it went out.
 */
function NearReviewModal({
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
  destinationName: string | null
  onClose: () => void
  onSent: (orderId: string) => void
}) {
  const now = useNow(1_000)
  const q = order.quote
  const expired = now >= order.signBy
  const viaWallet = source !== null && sourceAddress === order.sourceAddress
  const amount = `${rawText(q.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`
  const external = order.destination.kind === 'external'
  const { send, sentManually, sending, error, manualHash, setManualHash } = useSendToDeposit(order, chain, source, onSent)

  return (
    <Modal
      open
      onClose={sending ? () => undefined : onClose}
      dismissible={!sending}
      size="md"
      title="Review Bridge"
      description={expired ? 'This quote expired. Get a new one.' : `Send within ${countdown(order.signBy, now)}. The price is NEAR Intents’ quote for this deposit address.`}
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            {expired ? 'Close' : 'Cancel'}
          </Button>
          {!expired &&
            (viaWallet ? (
              <Button variant="primary" size="lg" onClick={() => send(expired)} loading={sending}>
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
        <NearRouteLine chain={chain} />
        <Lines dense>
          <Line label="You send" emphasis>
            <Figures>{amount}</Figures>
          </Line>
          <Line label={`NEARKITS bridge fee (${bpsPct(q.fee.nearkitsBps)})`}>
            <Figures>{`${rawText(q.fee.nearkitsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
          </Line>
          <Line label={`NEAR Intents fee (${bpsPct(q.fee.intentsBps)})`}>
            <Figures>{`${rawText(q.fee.intentsRaw, chain.decimals)} ${chain.symbol}`}</Figures>
          </Line>
          <Line label="You receive" emphasis>
            <Figures>{`≈ ${nearText(q.nearOut)} NEAR (at least ${nearText(q.nearMinOut)})`}</Figures>
          </Line>
          <Line label="Arrives as">{external ? 'wNEAR (wrap.near)' : 'wNEAR, then unwrapped to NEAR'}</Line>
          <Line label="Destination">
            <span className="flex min-w-0 flex-col items-end">
              {destinationName && <span className="truncate text-fg">{destinationName}</span>}
              <span className="flex min-w-0 items-center gap-1">
                {/* An account typed in is shown whole, to check before sending; a wallet of the user's by its short form. */}
                <span className="num break-all text-right text-xs text-fg-2" title={order.destination.accountId}>
                  {external ? order.destination.accountId : truncateMiddle(order.destination.accountId, 8, 6)}
                </span>
                <CopyButton value={order.destination.accountId} label="Copy destination account" />
              </span>
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
          NEAR Intents brings your {chain.symbol} to NEAR and delivers it to {external ? 'that account' : 'the wallet above'} as wNEAR;{' '}
          {order.destination.kind === 'nearkits'
            ? 'NEARKITS then unwraps it to native NEAR there.'
            : order.destination.kind === 'connected'
              ? 'you then unwrap it to native NEAR with one signature.'
              : 'it stays wNEAR there, and NEARKITS can’t move it.'}{' '}
          Nothing is bought. If the bridge can’t complete, NEAR Intents refunds your address.
        </p>
        {external && (
          <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs leading-5 text-fg-2">
            Check the account: transfers to it are irreversible, and NEARKITS can’t recover funds sent to the wrong account.
          </p>
        )}
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
