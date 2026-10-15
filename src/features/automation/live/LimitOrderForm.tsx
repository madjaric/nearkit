import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Figures } from '@/components/ui/Figures'
import { AmountInput, Field, Segmented, Switch } from '@/components/ui/Form'
import { InfoTip } from '@/components/ui/Help'
import { useToast } from '@/components/ui/toast-context'
import type { StrategyPreview } from '@/lib/automation/api'
import type { ConfigIssue, LimitConfig, LimitOrderType } from '@/lib/automation/config'
import { formatNumber } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { DEFAULT_SLIPPAGE } from '@/lib/fees'
import { AutomationFormPanel, ExpiryField, NumberField, ReviewFooter, SlippageField, Stack, TokenField, Wide } from './formParts'
import { useTokenChoice, useWalletChoice } from './hooks'
import { buildLimit, buildStopLossPair, conditionOf, createRefusalOf, issuesByField, ORDER_TYPE_LABEL, refusalOf, reviewOf, type ExpiryChoice, type Reviewed } from './model'
import { NearKitWalletField, PreviewLines, ReviewModal } from './parts'
import { useStrategyMutations } from './queries'

/**
 * A limit order run by NEARKITS' server from a NEARKITS wallet: limit buy, limit sell, take profit or
 * stop loss (a take profit can bring its stop loss: the first to trigger cancels the other). The
 * trigger is an executable price in NEAR per token; after it, the order is a market swap with this
 * slippage, so the price it trades at is not guaranteed. Reviewed on a fresh quote before it is created.
 */

export const LIMIT_TERMS =
  'The trigger compares NEARKITS’ executable price (fees, token tax and price impact included), checked on a schedule. Once it holds, the order trades at the market with your slippage: the minimum received is enforced on chain, the price is not guaranteed, and a fast market can move past the trigger.'

export function LimitOrderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast()
  const { preview, create } = useStrategyMutations()
  const [walletId, setWalletId] = useWalletChoice()
  const { tokenId, setTokenId, token, listing } = useTokenChoice()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [type, setType] = useState<LimitOrderType>('limit-buy')
  const [sellBy, setSellBy] = useState<'tokens' | 'percent'>('tokens')
  const [amountText, setAmountText] = useState('')
  const [triggerText, setTriggerText] = useState('')
  const [slippagePct, setSlippage] = useState(DEFAULT_SLIPPAGE)
  const [expiry, setExpiry] = useState<ExpiryChoice>('7d')
  const [withStop, setWithStop] = useState(false)
  const [stopText, setStopText] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [review, setReview] = useState<Reviewed<{ order: LimitConfig; pair: LimitConfig | null }> | null>(null)

  const now = useNow(15_000)
  const draft = { type, token, sellBy, amountText, triggerText, slippagePct, expiry }
  const pairing = type === 'take-profit' && withStop
  const built = buildLimit(draft, now)
  const pair = pairing ? buildStopLossPair(built.config, stopText, now) : null
  const issues = [...built.issues, ...(pair?.issues ?? [])]
  const errors = attempted ? { ...issuesByField(serverIssues), ...issuesByField(issues) } : issuesByField(serverIssues)
  const unit = side === 'buy' ? 'NEAR' : sellBy === 'percent' ? '%' : (token?.symbol ?? '')
  const listedNear = listing?.market?.priceNear ?? null

  const changed = () => {
    setServerIssues([])
    setFailure(null)
  }
  const pickSide = (v: 'buy' | 'sell') => {
    changed()
    setSide(v)
    setAmountText('')
    setType(v === 'buy' ? 'limit-buy' : 'limit-sell')
    setWithStop(false)
  }

  const openReview = () => {
    setAttempted(true)
    setFailure(null)
    if (issues.length > 0 || !walletId) {
      if (!walletId) setFailure('Choose a NEARKITS wallet.')
      return
    }
    // The expiry counts from now, the moment it is reviewed. A new review: a new request key.
    const at = Date.now()
    const fresh = buildLimit(draft, at)
    const freshPair = pairing ? buildStopLossPair(fresh.config, stopText, at).config : null
    setReview(reviewOf({ order: fresh.config, pair: freshPair }, walletId))
    preview.reset()
    preview.mutate({ walletId, config: { kind: 'limit', limit: fresh.config } })
  }

  const confirm = () => {
    if (!review) return
    const { order, pair } = review.config
    // Exactly what was reviewed, with the review's key: a retry or a second click makes nothing twice.
    create.mutate(
      {
        walletId: review.walletId,
        config: { kind: 'limit', limit: order },
        ...(pair ? { pair: { kind: 'limit', limit: pair } } : {}),
        requestKey: review.requestKey,
      },
      {
        onSuccess: (made) => {
          setReview(null)
          setAttempted(false)
          setAmountText('')
          setTriggerText('')
          setStopText('')
          toast.push({
            tone: 'accent',
            title: made.length > 1 ? 'Take profit and stop loss created' : `${ORDER_TYPE_LABEL[order.type]} created`,
            detail: 'NEARKITS watches the price from now on. It trades only when the trigger holds.',
          })
          if (made[0]) onCreated(made[0].id)
        },
        onError: (e) => {
          const r = createRefusalOf(e)
          setFailure(r.message)
          if (r.reviewAgain) {
            setServerIssues(r.issues)
            setReview(null)
          }
        },
      },
    )
  }

  const previewState = review
    ? {
        pending: preview.isPending,
        error: preview.isError ? refusalOf(preview.error).message : null,
        body: preview.data && token ? <PreviewLines preview={preview.data as StrategyPreview} token={token} triggerText={review.config.order.triggerPriceNear} /> : null,
      }
    : null

  return (
    <AutomationFormPanel
      title="New order"
      actions={<InfoTip term={type === 'take-profit' ? 'takeProfit' : type === 'stop-loss' ? 'stopLoss' : 'limitOrder'} />}
      footer={
        <ReviewFooter
          action={
            <Button size="lg" block variant={side === 'buy' ? 'primary' : 'sell'} onClick={openReview}>
              Review {ORDER_TYPE_LABEL[type].toLowerCase()}
            </Button>
          }
          failure={failure && !review ? failure : null}
          issues={attempted ? issues : null}
          terms={LIMIT_TERMS}
        />
      }
      dialog={
        <ReviewModal
          open={review !== null}
          onClose={() => setReview(null)}
          title={`Review ${review ? ORDER_TYPE_LABEL[review.config.order.type].toLowerCase() : 'order'}`}
          summary={
            review && (
              <Figures>
                {`${ORDER_TYPE_LABEL[review.config.order.type]} ${review.config.order.token.symbol} when the price is ${conditionOf(review.config.order.type)} ${review.config.order.triggerPriceNear} NEAR${review.config.pair ? `, with a stop loss at ≤ ${review.config.pair.triggerPriceNear} NEAR (the first to trigger cancels the other; cancelling either cancels both)` : ''}. Slippage ${review.config.order.slippagePct}%.`}
              </Figures>
            )
          }
          preview={previewState}
          terms={`${LIMIT_TERMS} It runs server-side from your NEARKITS wallet without asking again; pause or cancel it any time before it triggers.`}
          error={failure}
          confirmLabel={review?.config.pair ? 'Create both orders' : 'Create order'}
          confirming={create.isPending}
          onConfirm={confirm}
        />
      }
    >
      <Wide>
        <Segmented
          label="Order side"
          block
          size="lg"
          value={side}
          onChange={pickSide}
          options={[
            { value: 'buy', label: 'Buy', tone: 'buy' },
            { value: 'sell', label: 'Sell', tone: 'sell' },
          ]}
        />
        {side === 'sell' && (
          <div className="flex flex-col gap-1.5">
            <span className="legend">Order type</span>
            <Segmented
              label="Order type"
              block
              value={type}
              onChange={(v) => {
                changed()
                setType(v)
                if (v !== 'take-profit') setWithStop(false)
              }}
              options={[
                { value: 'limit-sell', label: 'Limit' },
                { value: 'take-profit', label: 'Take profit' },
                { value: 'stop-loss', label: 'Stop loss' },
              ]}
            />
          </div>
        )}
      </Wide>

      <TokenField
        tokenId={tokenId}
        onChange={(id) => {
          changed()
          setTokenId(id)
        }}
        error={errors['token.id'] ?? errors['token.decimals'] ?? errors['token.symbol'] ?? errors.token}
      />
      <Field
        label={`Trigger price · ${conditionOf(type)}`}
        aside={listedNear !== null && listedNear > 0 ? <span className="num">Listed ≈ {formatNumber(listedNear, 0, 8)} NEAR</span> : undefined}
        error={errors.triggerPriceNear}
        hint={`${ORDER_TYPE_LABEL[type]} triggers when NEARKITS’ executable price is ${conditionOf(type) === '≤' ? 'at or below' : 'at or above'} this, in NEAR per ${token?.symbol ?? 'token'}.`}
      >
        {({ id, describedBy, invalid }) => (
          <AmountInput
            id={id}
            value={triggerText}
            onValueChange={(v) => {
              changed()
              setTriggerText(v)
            }}
            unit="NEAR"
            placeholder="0"
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>

      <Stack>
        {side === 'sell' && (
          <div className="flex flex-col gap-1.5">
            <span className="legend" aria-hidden="true">
              Sell amount as
            </span>
            <Segmented
              label="Sell amount as"
              block
              size="sm"
              value={sellBy}
              onChange={(v) => {
                changed()
                setSellBy(v)
                setAmountText('')
              }}
              options={[
                { value: 'tokens', label: 'Token amount' },
                { value: 'percent', label: '% of balance' },
              ]}
            />
          </div>
        )}
        <NumberField
          label={side === 'buy' ? 'Spend' : sellBy === 'percent' ? 'Sell share' : 'Sell amount'}
          value={amountText}
          onChange={(v) => {
            changed()
            setAmountText(v)
          }}
          unit={unit}
          error={errors.amount}
          placeholder={sellBy === 'percent' && side === 'sell' ? '100' : '0'}
          hint={side === 'sell' && sellBy === 'percent' ? 'A whole percentage of what the wallet holds when the order triggers, read from chain then.' : undefined}
        />
      </Stack>
      <ExpiryField
        value={expiry}
        onChange={(v) => {
          changed()
          setExpiry(v)
        }}
        error={errors.expiresAt}
      />

      {type === 'take-profit' && (
        <Wide>
          <div className="flex flex-col gap-3 rounded-md border border-line-soft p-3">
            <Switch
              checked={withStop}
              onChange={(on) => {
                changed()
                setWithStop(on)
              }}
              label="Add a stop loss"
              description="The pair shares the amount: the first to trigger cancels the other, and cancelling either cancels both."
            />
            {withStop && (
              <div className="@xl:max-w-[calc(50%-0.625rem)]">
                <NumberField
                  label="Stop loss trigger · ≤"
                  value={stopText}
                  onChange={(v) => {
                    changed()
                    setStopText(v)
                  }}
                  unit="NEAR"
                  error={errors['pair.triggerPriceNear']}
                />
              </div>
            )}
          </div>
        </Wide>
      )}

      <NearKitWalletField
        value={walletId}
        onChange={(id) => {
          changed()
          setWalletId(id)
        }}
        error={errors.walletId}
      />
      <SlippageField
        value={slippagePct}
        onChange={(v) => {
          changed()
          setSlippage(v)
        }}
        error={errors.slippagePct}
      />
    </AutomationFormPanel>
  )
}
