import { ArrowDownUp } from 'lucide-react'
import { useId, useState } from 'react'
import { PercentKeys, SlippageControl } from '@/components/domain/TradeControls'
import { slippageIssue } from '@/lib/slippage'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { Button, IconButton } from '@/components/ui/Button'
import { fitFigure } from '@/components/ui/fitFigure'
import { AmountInput, Field } from '@/components/ui/Form'
import { Amount } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { formatAmount } from '@/lib/format'
import { useDebouncedValue, useNow } from '@/lib/hooks'
import { useBalance, usePlanners, useQuote, useTokens } from '@/services/queries'
import { useConnectPrompt, useSettings } from '@/state/contexts'
import type { QuoteRequest, TokenId } from '@/types/domain'
import type { OperationProgress } from '@/types/operations'
import { NearKitTradeModal, type NearKitTradeRequest } from '../multi/NearKitTrade'
import { OperationModal } from '../tools/OperationModal'
import { ArmStatus } from './ArmStatus'
import { QuoteDetails } from './QuoteDetails'
import { useArm } from './useArm'
import { useSpend } from './useSpend'
import { TradeWalletSelect } from './TradeWalletSelect'
import { useTradeWallets } from './useTradeWallets'

const NEAR = NATIVE_TOKEN_ID

interface SwapTicketProps {
  fromId: TokenId
  toId: TokenId
  onPairChange: (from: TokenId, to: TokenId) => void
  walletId: string
  onWalletChange: (id: string) => void
  /** Prefilled from a link (e.g. a trade prepared in Telegram). Exact decimal string. */
  initialAmount?: string
  initialSlippage?: number
  /** Called when a swap this ticket started finishes, with its final progress. */
  onSettled?: (progress: OperationProgress) => void
}

/**
 * Any listed token for any other. Pairs without NEAR hop through it; the fee sits on that leg.
 * From a NearKit wallet NearKit's server executes it (tokens against NEAR), with no wallet prompt;
 * from a connected account it is signed in that wallet.
 */
export function SwapTicket({ fromId, toId, onPairChange, walletId, onWalletChange, initialAmount, initialSlippage, onSettled }: SwapTicketProps) {
  const uid = useId()
  const { settings } = useSettings()
  const { promptConnect } = useConnectPrompt()
  const { data: tokens = [] } = useTokens()
  const planners = usePlanners()
  const now = useNow(500)
  const { armed, armedAt, arm, disarm } = useArm()
  const [amountText, setAmountText] = useState(initialAmount ?? '')
  const [slippage, setSlippage] = useState(initialSlippage ?? settings.defaultSlippage)
  const [review, setReview] = useState<QuoteRequest | null>(null)
  const [nearkitRun, setNearkitRun] = useState<NearKitTradeRequest | null>(null)

  const { wallet, viaNearKit, ready, nearkit, browser, options } = useTradeWallets(walletId)
  // NearKit wallets trade tokens against NEAR: one side of the pair is NEAR.
  const nearkitPair = fromId === NEAR ? { side: 'buy' as const, tokenId: toId } : toId === NEAR ? { side: 'sell' as const, tokenId: fromId } : null
  const from = tokens.find((t) => t.id === fromId)
  const to = tokens.find((t) => t.id === toId)
  const toBalance = useBalance(walletId, toId)
  const spend = useSpend(walletId, fromId, amountText, ready)
  const { balance: fromBalance, amount, insufficient, activeFraction } = spend
  const settledText = useDebouncedValue(amountText.trim(), 250)
  const slip = slippageIssue(slippage)

  const request: QuoteRequest | null =
    ready && Number(settledText) > 0 && !spend.precisionError
      ? { tokenIn: fromId, tokenOut: toId, amountIn: settledText, slippagePct: slip?.level === 'error' ? 1 : slippage, walletId }
      : null
  const quote = useQuote(request)
  const q = amount > 0 && request ? quote.data : undefined
  const settling = amountText.trim() !== settledText || quote.isFetching
  const stale = settling || (q !== undefined && now >= q.expiresAt)
  const outDecimals = toId === NEAR || (to?.decimals ?? 0) <= 8 ? 2 : 0

  const setPair = (nextFrom: TokenId, nextTo: TokenId) => {
    disarm()
    // Picking the token already on the other side swaps the two sides instead of emptying one.
    if (nextFrom === nextTo) onPairChange(nextTo === fromId ? toId : nextFrom, nextFrom === toId ? fromId : nextTo)
    else onPairChange(nextFrom, nextTo)
  }

  // Opens the review: NearKit's server quotes a NearKit wallet's trade; for a connected account
  // the service re-quotes and builds the exact plan the user signs.
  const execute = () => {
    disarm()
    if (viaNearKit) {
      if (!nearkitPair) return
      const token = tokens.find((t) => t.id === nearkitPair.tokenId)
      return setNearkitRun({
        side: nearkitPair.side,
        tokenId: nearkitPair.tokenId,
        symbol: token?.symbol ?? '',
        slippagePct: slippage,
        legs: [{ walletId, amountIn: amountText.trim() }],
      })
    }
    setReview({ tokenIn: fromId, tokenOut: toId, amountIn: amountText.trim(), slippagePct: slippage, walletId })
  }

  const reason =
    viaNearKit && !nearkitPair
      ? 'NEARKITS wallets trade tokens against NEAR: pick NEAR on one side'
      : !(amount > 0)
        ? 'Enter an amount'
        : spend.precisionError
          ? spend.precisionError
          : insufficient
            ? `Insufficient ${from?.symbol ?? ''}`
            : slip?.level === 'error'
              ? 'Check slippage'
              : quote.isError
                ? 'Quote unavailable'
                : undefined
  let cta: { label: string; disabled?: boolean; reason?: string; onClick?: () => void; variant: 'primary' | 'secondary' }
  if (!ready) cta = { label: 'Connect wallet', variant: 'secondary', onClick: promptConnect }
  else if (armed) cta = { label: 'Confirm swap', variant: 'primary', onClick: execute }
  else
    cta = {
      label: `Swap ${from?.symbol ?? ''} → ${to?.symbol ?? ''}`,
      variant: 'primary',
      disabled: reason !== undefined,
      reason,
      onClick: settings.twoStepConfirm ? arm : execute,
    }

  return (
    <Panel aria-labelledby={`${uid}-title`}>
      <PanelHeader
        id={`${uid}-title`}
        title="Swap"
        actions={
          options.length > 0 && (
            <TradeWalletSelect
              label="Swap from wallet"
              value={walletId}
              nearkit={nearkit}
              browser={browser}
              onChange={(id) => {
                disarm()
                onWalletChange(id)
                setAmountText('')
              }}
              className="w-36"
            />
          )
        }
      />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <Field
            label="From"
            aside={
              ready ? (
                <span className="flex items-center gap-1">
                  Balance <Amount value={fromBalance} minDecimals={fromId === NEAR ? 2 : 0} unit={from?.symbol} className="text-fg-2" />
                </span>
              ) : null
            }
            error={insufficient ? `${wallet?.label ?? 'This wallet'} holds ${formatAmount(fromBalance, fromId === NEAR ? 2 : 0)} ${from?.symbol ?? ''}` : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <AmountInput
                id={id}
                size="lg"
                placeholder="0.00"
                value={amountText}
                onValueChange={(v) => {
                  disarm()
                  setAmountText(v)
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                trailing={<TokenSelect label="From token" size="lg" compact value={fromId} walletId={ready ? walletId : undefined} onChange={(id) => setPair(id, toId)} />}
              />
            )}
          </Field>
          <PercentKeys
            disabled={!ready || !spend.maxSpend}
            active={activeFraction}
            onPick={(f) => {
              disarm()
              setAmountText(spend.presetText(f))
            }}
          />
        </div>

        <div className="flex items-center gap-3" aria-hidden={false}>
          <span className="h-px flex-1 bg-line-soft" />
          <IconButton
            label="Flip direction"
            onClick={() => {
              disarm()
              setAmountText('')
              onPairChange(toId, fromId)
            }}
            className="border border-line bg-raised"
          >
            <ArrowDownUp size={15} />
          </IconButton>
          <span className="h-px flex-1 bg-line-soft" />
        </div>

        <Field
          label="To (est.)"
          aside={
            ready ? (
              <span className="flex items-center gap-1">
                Balance <Amount value={toBalance} minDecimals={toId === NEAR ? 2 : 0} unit={to?.symbol} className="text-fg-2" />
              </span>
            ) : null
          }
        >
          {({ id }) => {
            const estimate = q ? formatAmount(q.amountOut, outDecimals) : '0.00'
            return (
              <div className="flex h-16 items-center rounded-md border border-line bg-well/50">
                <div className="@container flex h-full min-w-0 flex-1 items-center">
                  <output
                    id={id}
                    aria-live="polite"
                    className={cn('num block w-full truncate px-3.5 text-3xl transition-opacity', q ? 'text-fg' : 'text-fg-4', stale && q && 'opacity-45')}
                    style={{ fontSize: fitFigure(estimate.length) }}
                  >
                    {estimate}
                  </output>
                </div>
                <div className="flex shrink-0 items-center pr-3">
                  <TokenSelect label="To token" size="lg" compact kitTeaser value={toId} walletId={ready ? walletId : undefined} onChange={(id) => setPair(fromId, id)} />
                </div>
              </div>
            )
          }}
        </Field>

        <SlippageControl
          value={slippage}
          onChange={(v) => {
            disarm()
            setSlippage(v)
          }}
        />

        <div className="border-t border-line-soft pt-3.5">
          <QuoteDetails
            quote={q}
            inSymbol={from?.symbol ?? ''}
            outSymbol={to?.symbol ?? ''}
            outDecimals={outDecimals}
            stale={stale}
            settling={settling}
            showPath
            showReceive={false}
            error={quote.isError && amount > 0 ? (quote.error instanceof Error ? quote.error.message : 'Quote unavailable') : null}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Button size="lg" block variant={cta.variant} disabled={cta.disabled} title={cta.reason} onClick={cta.onClick} aria-describedby={`${uid}-arm`}>
            {cta.label}
          </Button>
          <ArmStatus id={`${uid}-arm`} armedAt={armedAt} tone="buy" blocked={cta.reason} onCancel={disarm} />
          {viaNearKit && <p className="text-xs text-fg-3">{`NEARKITS executes it from ${wallet?.label ?? 'this NEARKITS wallet'}: no wallet prompt.`}</p>}
        </div>
      </div>
      {nearkitRun && (
        <NearKitTradeModal
          request={nearkitRun}
          wallets={options}
          onClose={() => setNearkitRun(null)}
          onSettled={(ok) => {
            if (ok) setAmountText('')
          }}
        />
      )}
      {review && (
        <OperationModal
          title="Review swap"
          confirmLabel={`Swap ${from?.symbol ?? ''} → ${to?.symbol ?? ''}`}
          prepare={() => planners.swap(review)}
          onClose={() => setReview(null)}
          onSettled={(p) => {
            if (p.phase === 'success') setAmountText('')
            onSettled?.(p)
          }}
        />
      )}
    </Panel>
  )
}
