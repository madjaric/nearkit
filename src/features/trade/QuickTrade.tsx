import { useId, useState } from 'react'
import { PercentKeys, SlippageControl } from '@/components/domain/TradeControls'
import { slippageIssue } from '@/lib/slippage'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { Button } from '@/components/ui/Button'
import { AmountInput, Field, Segmented } from '@/components/ui/Form'
import { Amount } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { cn } from '@/lib/cn'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { GAS_RESERVE_NEAR } from '@/lib/fees'
import { formatAmount } from '@/lib/format'
import { useDebouncedValue, useNow } from '@/lib/hooks'
import { usePlanners, useQuote, useSession, useTokens } from '@/services/queries'
import { useConnectPrompt, useSettings } from '@/state/contexts'
import type { QuoteRequest, TokenId, TradeSide } from '@/types/domain'
import { NearKitTradeModal, type NearKitTradeRequest } from '../multi/NearKitTrade'
import { OperationModal } from '../tools/OperationModal'
import { ArmStatus } from './ArmStatus'
import { QuoteDetails } from './QuoteDetails'
import { useArm } from './useArm'
import { useQuickTradeToken } from './useDefaultToken'
import { useSpend } from './useSpend'
import { TradeWalletSelect } from './TradeWalletSelect'
import { useTradeWallets } from './useTradeWallets'

const NEAR = NATIVE_TOKEN_ID

interface QuickTradeProps {
  initialTokenId?: TokenId
  initialSide?: TradeSide
  /** `panel` draws its own module frame; `bare` sits inside a drawer. */
  variant?: 'panel' | 'bare'
  onExecuted?: () => void
  className?: string
}

/**
 * Buy or sell one token against NEAR from one wallet: the dashboard's trade ticket. It opens on
 * $KITS where $KITS trades (useQuickTradeToken), unless it was opened for a token. From a
 * NearKit wallet NearKit's server executes it (no wallet prompt, no browser wallet needed);
 * from a connected account it is signed in that wallet.
 */
export function QuickTrade({ initialTokenId, initialSide = 'buy', variant = 'panel', onExecuted, className }: QuickTradeProps) {
  const uid = useId()
  const { settings } = useSettings()
  const { data: session } = useSession()
  const { promptConnect } = useConnectPrompt()
  const { data: tokens = [] } = useTokens()
  const planners = usePlanners()
  const defaultToken = useQuickTradeToken()
  const now = useNow(500)
  const { armed, armedAt, arm, disarm } = useArm()

  const [side, setSide] = useState<TradeSide>(initialSide)
  const [pickedToken, setTokenId] = useState<TokenId | null>(initialTokenId ?? null)
  const [pickedWallet, setWalletId] = useState<string | null>(null)
  const [amountText, setAmountText] = useState('')
  const [slippage, setSlippage] = useState(settings.defaultSlippage)
  const [review, setReview] = useState<QuoteRequest | null>(null)
  const [nearkitRun, setNearkitRun] = useState<NearKitTradeRequest | null>(null)

  const tokenId = pickedToken ?? defaultToken
  const { walletId, wallet, viaNearKit, ready, nearkit, browser, options } = useTradeWallets(pickedWallet)
  const token = tokens.find((t) => t.id === tokenId)
  const nearPrice = tokens.find((t) => t.id === NEAR)?.market?.priceUsd
  const symbol = token?.symbol ?? '—'
  const spendSymbol = side === 'buy' ? 'NEAR' : symbol
  const receiveSymbol = side === 'buy' ? symbol : 'NEAR'
  const spend = useSpend(walletId, side === 'buy' ? NEAR : tokenId, amountText, ready)
  const { balance, amount, insufficient, eatsGas, activeFraction } = spend

  const settledText = useDebouncedValue(amountText.trim(), 250)
  const slip = slippageIssue(slippage)

  // Query keys are compared by value, so a fresh object each render doesn't refetch.
  const request: QuoteRequest | null =
    !ready || !(Number(settledText) > 0) || spend.precisionError
      ? null
      : {
          tokenIn: side === 'buy' ? NEAR : tokenId,
          tokenOut: side === 'buy' ? tokenId : NEAR,
          amountIn: settledText,
          slippagePct: slip?.level === 'error' ? 1 : slippage,
          walletId,
        }

  const quote = useQuote(request)
  const q = amount > 0 && request ? quote.data : undefined
  const settling = amountText.trim() !== settledText || quote.isFetching
  const stale = settling || (q !== undefined && now >= q.expiresAt)

  // Opens the review: NearKit's server quotes a NearKit wallet's trade; for a connected account
  // the service re-quotes and builds the exact plan the user signs.
  const execute = () => {
    disarm()
    if (viaNearKit) return setNearkitRun({ side, tokenId, symbol, slippagePct: slippage, legs: [{ walletId, amountIn: amountText.trim() }] })
    if (!session) return
    setReview({ tokenIn: side === 'buy' ? NEAR : tokenId, tokenOut: side === 'buy' ? tokenId : NEAR, amountIn: amountText.trim(), slippagePct: slippage, walletId })
  }

  const verb = side === 'buy' ? 'Buy' : 'Sell'
  const tone = side === 'buy' ? 'primary' : 'sell'
  // The key always names its action; when blocked it is disabled and the line under it says why.
  const reason = !(amount > 0)
    ? 'Enter an amount'
    : spend.precisionError
      ? spend.precisionError
      : insufficient
        ? `Insufficient ${spendSymbol}`
        : slip?.level === 'error'
          ? 'Check slippage'
          : quote.isError
            ? 'Quote unavailable'
            : undefined
  let cta: { label: string; disabled?: boolean; reason?: string; onClick?: () => void; variant: 'primary' | 'sell' | 'secondary' }
  if (!ready) cta = { label: 'Connect wallet', variant: 'secondary', onClick: promptConnect }
  else if (armed) cta = { label: `Confirm ${verb.toLowerCase()} ${symbol}`, variant: tone, onClick: execute }
  else cta = { label: `${verb} ${symbol}`, variant: tone, disabled: reason !== undefined, reason, onClick: settings.twoStepConfirm ? arm : execute }

  const walletPicker = options.length > 0 && (
    <TradeWalletSelect
      label="Trade from wallet"
      value={walletId}
      nearkit={nearkit}
      browser={browser}
      onChange={(id) => {
        disarm()
        setWalletId(id)
        setAmountText('')
      }}
      className="w-36"
    />
  )

  const body = (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Trade side"
        block
        size="lg"
        value={side}
        onChange={(v) => {
          disarm()
          setSide(v)
          setAmountText('')
        }}
        options={[
          { value: 'buy', label: 'Buy', tone: 'buy' },
          { value: 'sell', label: 'Sell', tone: 'sell' },
        ]}
      />

      <Field label="Token">
        {({ id }) => (
          <TokenSelect
            id={id}
            label="Token"
            value={tokenId}
            walletId={ready ? walletId : undefined}
            exclude={[NEAR]}
            kitTeaser
            onChange={(next) => {
              disarm()
              setTokenId(next)
              if (side === 'sell') setAmountText('')
            }}
          />
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <Field
          label={side === 'buy' ? 'You pay' : 'You sell'}
          aside={
            ready ? (
              <span className="flex items-center gap-1">
                Balance <Amount value={balance} minDecimals={side === 'buy' ? 2 : 0} unit={spendSymbol} className="text-fg-2" />
              </span>
            ) : null
          }
          error={insufficient ? `${wallet?.label ?? 'This wallet'} holds ${formatAmount(balance, side === 'buy' ? 2 : 0)} ${spendSymbol}` : undefined}
          warning={eatsGas ? `Leaves less than ${GAS_RESERVE_NEAR} NEAR for gas` : undefined}
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
              unit={spendSymbol}
              aria-describedby={describedBy}
              aria-invalid={invalid}
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

      <SlippageControl
        value={slippage}
        onChange={(v) => {
          disarm()
          setSlippage(v)
        }}
      />

      <div className="border-t border-line-soft pt-3">
        <QuoteDetails
          quote={q}
          inSymbol={spendSymbol}
          outSymbol={receiveSymbol}
          outTokenId={side === 'buy' ? tokenId : NEAR}
          outDecimals={side === 'sell' ? 2 : 0}
          outPriceUsd={side === 'buy' ? token?.market?.priceUsd : nearPrice}
          stale={stale}
          settling={settling}
          error={quote.isError && amount > 0 ? (quote.error instanceof Error ? quote.error.message : 'Quote unavailable') : null}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Button size="xl" block variant={cta.variant} disabled={cta.disabled} title={cta.reason} onClick={cta.onClick} aria-describedby={`${uid}-arm`}>
          {cta.label}
        </Button>
        <ArmStatus id={`${uid}-arm`} armedAt={armedAt} tone={side} blocked={cta.reason} onCancel={disarm} />
        {viaNearKit && <p className="text-xs text-fg-3">{`NEARKITS executes it from ${wallet?.label ?? 'this NEARKITS wallet'}: no wallet prompt.`}</p>}
      </div>
      {nearkitRun && (
        <NearKitTradeModal
          request={nearkitRun}
          wallets={options}
          onClose={() => setNearkitRun(null)}
          onSettled={(ok) => {
            if (!ok) return
            setAmountText('')
            onExecuted?.()
          }}
        />
      )}
      {review && (
        <OperationModal
          title={`Review ${side === 'buy' ? 'buy' : 'sell'}`}
          confirmLabel={`${verb} ${symbol}`}
          prepare={() => planners.swap(review)}
          onClose={() => setReview(null)}
          onSettled={(p) => {
            if (p.phase === 'success') {
              setAmountText('')
              onExecuted?.()
            }
          }}
        />
      )}
    </div>
  )

  if (variant === 'bare') {
    return (
      <div className={cn('flex flex-col gap-4', className)}>
        {walletPicker && (
          <div className="flex items-center justify-between gap-3">
            <span className="legend">From wallet</span>
            {walletPicker}
          </div>
        )}
        {body}
      </div>
    )
  }

  return (
    <Panel className={className} aria-labelledby={`${uid}-title`}>
      <PanelHeader id={`${uid}-title`} title="Quick trade" actions={walletPicker} />
      <div className="p-4">{body}</div>
    </Panel>
  )
}
