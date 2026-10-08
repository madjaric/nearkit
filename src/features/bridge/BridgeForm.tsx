import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ShieldCheck, Wallet as WalletIcon } from 'lucide-react'
import { useState } from 'react'
import { ChainMark } from '@/components/brand/ChainMark'
import { AccountText } from '@/components/domain/Account'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Modal } from '@/components/ui/Dialog'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Field, Input, Segmented, Select } from '@/components/ui/Form'
import { Led, Tag } from '@/components/ui/Indicators'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { BRIDGE_CHAINS, BRIDGE_SIGN_WINDOW_MS, bridgeChain, type BridgeChain, type BridgeChainId } from '@/config/bridge'
import { ENV } from '@/config/env'
import { KITS_CONTRACT } from '@/config/kit'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { tryParseUnits } from '@/lib/amounts'
import { sourceAddressError } from '@/lib/bridge/addresses'
import { bpsPct } from '@/lib/bridge/fee'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { cn } from '@/lib/cn'
import { BRIDGE_FEE_LABEL, DEFAULT_SLIPPAGE, NEARKIT_FEE_LABEL, SLIPPAGE_PRESETS } from '@/lib/fees'
import { formatAgo, formatUsd, truncateMiddle } from '@/lib/format'
import { useDebouncedValue, useNow } from '@/lib/hooks'
import { tradeWalletPool } from '@/lib/wallets'
import { rememberOrder, type BridgeDestinationRequest, type BridgeQuoteRequest } from '@/services/bridge'
import { useWallets } from '@/services/queries'
import type { Wallet } from '@/types/domain'
import { countdown, etaText, kitsText, nearText, rawText } from './format'
import { useBridgeAssets, useBridgeClient, useBridgeQuote } from './useBridge'
import { useSourceWallet, type SourceWallet } from './useSourceWallet'
import { sendEvmNative, ensureEvmChain, SourceWalletError } from './wallets/evm'
import { sendSol } from './wallets/solana'

/**
 * Bridge & Buy $KITS: the form. The user picks the coin they hold (SOL, ETH or BNB), how much, and
 * the NEAR wallet that receives $KITS; NEARKITS' server prices it with NEAR Intents and NEARKITS'
 * own route, live. "Bridge & Buy $KITS" asks for the order (a deposit address bound to that wallet,
 * amount and fee) and opens the review; Confirm has the user's own wallet send exactly that amount to
 * the deposit address. Nothing here holds funds or keys, and no figure is shown that wasn't quoted.
 */

const KITS = KITS_CONTRACT

const chainTitle = (c: BridgeChain) => `${c.symbol} · ${c.name}`

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
  const [amountText, setAmountText] = useState('')
  const [destId, setDestId] = useState<string | null>(null)
  const dest = destinations.find((w) => w.id === destId) ?? destinations[0] ?? null
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE)
  const [manual, setManual] = useState(false)
  const [manualAddress, setManualAddress] = useState('')
  const [review, setReview] = useState<BridgeOrderView | null>(null)

  const source = useSourceWallet(chain, client.solanaBalance)
  const manualError = manual && manualAddress.trim() ? sourceAddressError(chain, manualAddress) : null
  const sourceAddress = source.connection?.address ?? (manual && manualAddress.trim() && !manualError ? manualAddress.trim() : null)

  const settled = useDebouncedValue(amountText.trim(), 400)
  const parsed = settled ? tryParseUnits(settled, chain.decimals) : null
  const amountRaw = parsed?.ok ? parsed.value : null
  const precision = parsed && !parsed.ok ? `At most ${chain.decimals} decimals for ${chain.symbol}.` : null
  const destination = dest ? destinationOf(dest) : null
  const request: BridgeQuoteRequest | null =
    amountRaw !== null && amountRaw > 0n && destination && (offered === null || offered.includes(chainId))
      ? { chain: chainId, amount: settled, sourceAddress, destination, kitsSlippagePct: slippage }
      : null
  const quote = useBridgeQuote(request)
  const q = request ? quote.data : undefined
  const settling = amountText.trim() !== settled || quote.isFetching

  const balance = source.balance
  const insufficient = balance !== null && amountRaw !== null && amountRaw > balance
  const leavesNoFee = balance !== null && amountRaw !== null && !insufficient && balance - amountRaw < chain.maxReserve

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
            <div role="radiogroup" aria-label="Source chain" className="grid grid-cols-3 gap-2">
              {BRIDGE_CHAINS.map((c) => {
                const on = c.id === chainId
                const down = offered !== null && !offered.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={chainTitle(c)}
                    onClick={() => {
                      setChainId(c.id)
                      setAmountText('')
                    }}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors sm:px-3',
                      on ? 'border-accent/70 bg-accent/8' : 'border-line bg-well hover:border-line-strong',
                      down && 'opacity-50',
                    )}
                  >
                    <ChainMark chain={c.id} size={24} />
                    <span className="min-w-0">
                      <span className={cn('block text-sm font-semibold leading-5', on ? 'text-fg' : 'text-fg-2')}>{c.symbol}</span>
                      <span className="hidden truncate text-2xs text-fg-3 min-[420px]:block">{c.name}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <SourceConnect
              source={source}
              chain={chain}
              manual={manual}
              setManual={setManual}
              manualAddress={manualAddress}
              setManualAddress={setManualAddress}
              manualError={manualError}
            />
            <Field
              label="You send"
              aside={
                balance !== null ? (
                  <span className="flex items-center gap-1.5">
                    Balance{' '}
                    <span className="num text-fg-2">
                      {rawText(balance, chain.decimals)} {chain.symbol}
                    </span>
                    <button
                      type="button"
                      className="rounded-sm px-1 text-2xs font-semibold uppercase tracking-[0.08em] text-accent hover:bg-accent/10"
                      onClick={() => {
                        const max = balance - chain.maxReserve
                        if (max > 0n) setAmountText(rawText(max, chain.decimals, chain.decimals).replace(/,/g, ''))
                      }}
                    >
                      Max
                    </button>
                  </span>
                ) : null
              }
              error={insufficient ? `Your wallet holds ${rawText(balance as bigint, chain.decimals)} ${chain.symbol}.` : (precision ?? undefined)}
              warning={leavesNoFee ? `Leaves less than ${rawText(chain.maxReserve, chain.decimals)} ${chain.symbol} for ${chain.name}’s own network fee.` : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <AmountInput
                  id={id}
                  size="lg"
                  placeholder="0.00"
                  value={amountText}
                  onValueChange={setAmountText}
                  unit={chain.symbol}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
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

type Source = ReturnType<typeof useSourceWallet>

function SourceStatus({ source, chain, manual }: { source: Source; chain: BridgeChain; manual: boolean }) {
  if (source.connection)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
        <Led tone="on" />
        <span className="truncate">{source.connection.name}</span>
        <span className="num text-fg-2" title={source.connection.address}>
          {truncateMiddle(source.connection.address, 6, 4)}
        </span>
        <button type="button" onClick={source.disconnect} className="text-fg-3 underline decoration-fg-4 underline-offset-2 hover:text-fg">
          Change
        </button>
      </span>
    )
  return <span className="text-xs text-fg-3">{manual ? `Sending from another ${chain.name} wallet` : `${chain.name} wallet not connected`}</span>
}

function SourceConnect({
  source,
  chain,
  manual,
  setManual,
  manualAddress,
  setManualAddress,
  manualError,
}: {
  source: Source
  chain: BridgeChain
  manual: boolean
  setManual: (v: boolean) => void
  manualAddress: string
  setManualAddress: (v: string) => void
  manualError: string | null
}) {
  if (source.connection) return source.error ? <p className="text-xs text-warn">{source.error}</p> : null
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-well/50 p-3">
      {source.wallets.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {source.wallets.map((w: SourceWallet) => (
            <Button key={w.wallet.id} size="sm" variant="secondary" loading={source.busy} onClick={() => source.connect(w)}>
              {w.wallet.icon ? <img src={w.wallet.icon} alt="" width={16} height={16} className="size-4 rounded-sm" /> : <WalletIcon size={14} aria-hidden="true" />}
              Connect {w.wallet.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fg-3">
          No {chain.name} wallet found in this browser. {chain.family === 'solana' ? 'Phantom, Solflare or Backpack' : 'MetaMask, Rabby or any EVM wallet'} connects here, or send
          from any wallet below.
        </p>
      )}
      {source.error && <p className="text-xs text-warn">{source.error}</p>}
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={manual} onChange={(e) => setManual(e.target.checked)} />
        Send from another wallet (paste its {chain.name} address)
      </label>
      {manual && (
        <Field label={`Your ${chain.name} address`} hint="It sends the amount, and any refund goes back to it." error={manualError ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              inputSize="sm"
              spellCheck={false}
              autoComplete="off"
              placeholder={chain.family === 'solana' ? 'Solana address' : '0x…'}
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </Field>
      )}
    </div>
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
  const client = useBridgeClient()
  const now = useNow(1_000)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [manualHash, setManualHash] = useState('')
  const q = order.quote
  const expired = now >= order.signBy
  const viaWallet = source !== null && sourceAddress === order.sourceAddress
  const amount = `${rawText(q.amountIn, chain.decimals, chain.decimals)} ${chain.symbol}`

  const send = async () => {
    if (!source || expired) return
    setError(null)
    setSending(true)
    let hash: string
    try {
      if (source.family === 'evm') {
        await ensureEvmChain(source.wallet.provider, chain.evmChainId as number)
        hash = await sendEvmNative(source.wallet.provider, { from: order.sourceAddress, to: order.depositAddress, value: BigInt(q.amountIn), chainId: chain.evmChainId as number })
      } else {
        const blockhash = await client.solanaBlockhash()
        hash = await sendSol(source.wallet, { from: order.sourceAddress, to: order.depositAddress, lamports: BigInt(q.amountIn), recentBlockhash: blockhash })
      }
    } catch (e) {
      setError(e instanceof SourceWalletError ? e.message : 'Your wallet couldn’t send it. Check your wallet before trying again.')
      setSending(false)
      return
    }
    // Sent: whatever happens to this call, the order follows the deposit address itself.
    await client.deposit(order.id, hash).catch(() => undefined)
    onSent(order.id)
  }

  const sentManually = async () => {
    const hash = manualHash.trim()
    if (hash) {
      try {
        await client.deposit(order.id, hash)
      } catch (e) {
        setError((e as Error).message)
        return
      }
    }
    onSent(order.id)
  }

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
