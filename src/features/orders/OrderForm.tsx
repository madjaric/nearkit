import { useState } from 'react'
import { SimulationNote } from '@/components/domain/Status'
import { PercentKeys } from '@/components/domain/TradeControls'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { WalletSelect } from '@/components/domain/WalletSelect'
import { Button } from '@/components/ui/Button'
import { AmountInput, Field, Segmented, Select } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { Amount, Price } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { useToast } from '@/components/ui/toast-context'
import { useRuleWording } from '@/lib/modeCopy'
import { GAS_RESERVE_NEAR, NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { floorTo, formatAmount, formatCompact, formatNumber, formatPct, formatPrice, parseAmount, toInputString } from '@/lib/format'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useSession } from '@/services/queries'
import { useDefaultTradeToken } from '../trade/useDefaultToken'
import { useBalance, useOrderMutations, useTokens, useWallets } from '@/services/queries'
import type { OrderExpiry, OrderType, TradeSide } from '@/types/domain'

const NEAR = NATIVE_TOKEN_ID
const OFFSETS = [-10, -5, 0, 5, 10]
const EXPIRY_LABEL: Record<OrderExpiry, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days', gtc: 'Good till cancelled' }
const TYPE_LABEL: Record<OrderType, string> = { limit: 'Limit', 'take-profit': 'Take profit', 'stop-loss': 'Stop loss' }

export function OrderForm() {
  const toast = useToast()
  const wording = useRuleWording()
  const { data: tokens = [] } = useTokens()
  const { data: wallets = [] } = useWallets()
  const { create } = useOrderMutations()
  const [side, setSide] = useState<TradeSide>('buy')
  const [type, setType] = useState<OrderType>('limit')
  const { data: session } = useSession()
  const defaultToken = useDefaultTradeToken()
  const [pickedToken, setTokenId] = useState<string | null>(null)
  const [pickedWallet, setWalletId] = useState<string | null>(null)
  const tokenId = pickedToken ?? defaultToken
  const walletId = pickedWallet ?? session?.walletId ?? wallets[0]?.id ?? ''
  const [triggerText, setTriggerText] = useState('')
  const [amountText, setAmountText] = useState('')
  const [expiry, setExpiry] = useState<OrderExpiry>('7d')

  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? ''
  const market = token?.market?.priceUsd ?? 0
  const nearUsd = tokens.find((t) => t.id === NEAR)?.market?.priceUsd ?? 0
  const nearBalance = useBalance(walletId, NEAR)
  const tokenBalance = useBalance(walletId, tokenId)
  const balance = side === 'buy' ? nearBalance : tokenBalance
  const maxSpend = side === 'buy' ? Math.max(0, floorTo(nearBalance - GAS_RESERVE_NEAR, 4)) : tokenBalance
  const trigger = parseAmount(triggerText) ?? 0
  const amount = parseAmount(amountText) ?? 0
  const distance = market > 0 && trigger > 0 ? ((trigger - market) / market) * 100 : null
  const fee = NEARKIT_FEE_BPS / 10_000

  const estOut = trigger > 0 && amount > 0 ? (side === 'buy' ? (amount * (1 - fee) * nearUsd) / trigger : ((amount * trigger) / nearUsd) * (1 - fee)) : 0
  const feeNear = amount > 0 ? (side === 'buy' ? amount * fee : ((amount * trigger) / (nearUsd || 1)) * fee) : 0

  let triggerIssue: { level: 'error' | 'warning'; text: string } | null = null
  if (trigger > 0 && market > 0) {
    if (type === 'take-profit' && trigger <= market) triggerIssue = { level: 'error', text: 'A take profit sits above the current price' }
    else if (type === 'stop-loss' && trigger >= market) triggerIssue = { level: 'error', text: 'A stop loss sits below the current price' }
    else if (type === 'limit' && side === 'buy' && trigger >= market) triggerIssue = { level: 'warning', text: 'At or above the market: this would fill as soon as it goes live' }
    else if (type === 'limit' && side === 'sell' && trigger <= market) triggerIssue = { level: 'warning', text: 'At or below the market: this would fill as soon as it goes live' }
  }

  const insufficient = amount > balance + 1e-9
  let blocker: string | null = null
  if (!(trigger > 0)) blocker = 'Enter a trigger price'
  else if (triggerIssue?.level === 'error') blocker = 'Check the trigger price'
  else if (!(amount > 0)) blocker = 'Enter an amount'
  else if (insufficient) blocker = `Insufficient ${side === 'buy' ? 'NEAR' : symbol}`

  const cta = type === 'limit' ? `Place limit ${side}` : `Place ${TYPE_LABEL[type].toLowerCase()}`
  const condition = type === 'stop-loss' || (type === 'limit' && side === 'buy') ? '≤' : '≥'

  return (
    <Panel>
      <PanelHeader title="New order" actions={<InfoTip term={type === 'limit' ? 'limitOrder' : type === 'take-profit' ? 'takeProfit' : 'stopLoss'} />} />
      <div className="flex flex-col gap-4 p-4">
        <Segmented
          label="Order side"
          block
          size="lg"
          value={side}
          onChange={(v) => {
            setSide(v)
            setAmountText('')
            if (v === 'buy') setType('limit')
          }}
          options={[
            { value: 'buy', label: 'Buy', tone: 'buy' },
            { value: 'sell', label: 'Sell', tone: 'sell' },
          ]}
        />
        <div className="flex flex-col gap-1.5">
          <span className="legend">Order type</span>
          <Segmented
            label="Order type"
            block
            value={type}
            onChange={setType}
            options={[
              { value: 'limit', label: 'Limit' },
              { value: 'take-profit', label: 'Take profit', disabled: side === 'buy' },
              { value: 'stop-loss', label: 'Stop loss', disabled: side === 'buy' },
            ]}
          />
          {side === 'buy' && <p className="text-xs text-fg-3">Take profit and stop loss close positions, so they are sell-side only.</p>}
        </div>

        <Field label="Token">{({ id }) => <TokenSelect id={id} label="Token" value={tokenId} onChange={setTokenId} exclude={[NEAR]} walletId={walletId} />}</Field>

        <div className="flex flex-col gap-2">
          <Field
            label="Trigger price"
            aside={
              <span className="flex items-center gap-1">
                Market <Price value={market} className="text-fg-2" />
              </span>
            }
            error={triggerIssue?.level === 'error' ? triggerIssue.text : undefined}
            warning={triggerIssue?.level === 'warning' ? triggerIssue.text : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <AmountInput
                id={id}
                value={triggerText}
                onValueChange={setTriggerText}
                unit="USD"
                placeholder={formatPrice(market)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <div className="grid grid-cols-5 gap-1" role="group" aria-label="Trigger relative to market">
            {OFFSETS.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setTriggerText(toInputString(market * (1 + o / 100), 12))}
                className="num h-7 rounded-xs border border-line bg-raised/50 text-[11px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
              >
                {o === 0 ? 'Market' : `${o > 0 ? '+' : '−'}${Math.abs(o)}%`}
              </button>
            ))}
          </div>
          {distance !== null && (
            <p className="num text-xs text-fg-3">
              {formatPct(distance)} {distance >= 0 ? 'above' : 'below'} market
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Field
            label={side === 'buy' ? 'Spend' : 'Sell amount'}
            aside={
              <span className="flex items-center gap-1">
                Balance <Amount value={balance} minDecimals={side === 'buy' ? 2 : 0} unit={side === 'buy' ? 'NEAR' : symbol} className="text-fg-2" />
              </span>
            }
            error={insufficient ? `This wallet holds ${formatAmount(balance, side === 'buy' ? 2 : 0)} ${side === 'buy' ? 'NEAR' : symbol}` : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <AmountInput
                id={id}
                value={amountText}
                onValueChange={setAmountText}
                unit={side === 'buy' ? 'NEAR' : symbol}
                placeholder="0"
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <PercentKeys disabled={maxSpend <= 0} onPick={(f) => setAmountText(toInputString(floorTo(maxSpend * f, side === 'buy' ? 4 : 2), side === 'buy' ? 4 : 2))} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Expiration">
            {({ id }) => (
              <Select id={id} value={expiry} onChange={(e) => setExpiry(e.target.value as OrderExpiry)}>
                {(Object.keys(EXPIRY_LABEL) as OrderExpiry[]).map((k) => (
                  <option key={k} value={k}>
                    {EXPIRY_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Wallet">{({ id }) => <WalletSelect id={id} value={walletId} onChange={setWalletId} wallets={wallets} showAccount={false} />}</Field>
        </div>

        <div className="border-t border-line-soft pt-3">
          <Lines>
            <Line label="Fills when price">
              {trigger > 0 ? (
                <>
                  {condition} <Price value={trigger} />
                </>
              ) : (
                '—'
              )}
            </Line>
            <Line label="Est. receive">{estOut > 0 ? `${side === 'buy' ? formatCompact(estOut, 2) : formatNumber(estOut, 2, 4)} ${side === 'buy' ? symbol : 'NEAR'}` : '—'}</Line>
            <Line
              label={
                <>
                  <Term term="nearkitFee">NearKit fee on fill</Term> <span className="num text-fg-2">{NEARKIT_FEE_LABEL}</span>
                </>
              }
            >
              {feeNear > 0 ? `${formatNumber(feeNear, 2, 4)} NEAR` : '—'}
            </Line>
            <Line label="Expires">{EXPIRY_LABEL[expiry]}</Line>
          </Lines>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            block
            variant={side === 'buy' ? 'primary' : 'sell'}
            disabled={blocker !== null}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { tokenId, side, type, triggerPriceUsd: trigger, amount, walletId, expiry },
                {
                  onSuccess: () => {
                    setAmountText('')
                    toast.push({
                      tone: 'accent',
                      title: `${TYPE_LABEL[type]} ${side} placed for ${symbol}`,
                      detail: `${wording.saved} Nothing watches the price, so it never fills.`,
                    })
                  },
                  onError: (e) => toast.push({ tone: 'neg', title: 'Order not placed', detail: e instanceof Error ? e.message : 'Unknown error' }),
                },
              )
            }
          >
            {cta}
          </Button>
          {blocker && <p className="text-xs text-fg-3">{blocker}</p>}
          <SimulationNote
            demo="Orders are stored for this session only. Nothing watches the price, so they never fill."
            real="Orders are saved as drafts in this browser. Nothing watches the price, so they never fill: that needs a keeper service NearKit doesn't run yet."
          />
        </div>
      </div>
    </Panel>
  )
}
