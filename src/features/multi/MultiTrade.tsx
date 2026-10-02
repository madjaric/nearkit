import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AccountText } from '@/components/domain/Account'
import { AllocationBar } from '@/components/domain/AllocationBar'
import { QuoteFreshness } from '@/components/domain/QuoteFreshness'
import { SimulationNote } from '@/components/domain/Status'
import { SlippageControl } from '@/components/domain/TradeControls'
import { Figures } from '@/components/ui/Figures'
import { slippageIssue } from '@/lib/slippage'
import { TokenSelect } from '@/components/domain/TokenSelect'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { AmountInput, Checkbox, Field, Segmented, Tabs } from '@/components/ui/Form'
import { tabPanelProps } from '@/components/ui/tabs'
import { InfoTip, Term } from '@/components/ui/Help'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { formatUnits, fractionOf, splitEqual, tryParseUnits } from '@/lib/amounts'
import { cn } from '@/lib/cn'
import { GAS_RESERVE_NEAR, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { floorTo, formatAmount, formatCompact, formatNumber, formatPct, parseAmount, toInputString } from '@/lib/format'
import { useDebouncedValue, useNow } from '@/lib/hooks'
import { canExecute, executesViaNearKit, presetMembers, signsInBrowser } from '@/lib/wallets'
import { NATIVE_TOKEN_ID } from '@/config/networks'
import { useServices } from '@/services/context'
import { useCapabilities, useHoldings, useMultiQuote, usePlanners, usePresets, useSession, useTokens, useWallets } from '@/services/queries'
import { useConnectPrompt, useInComingSoon, useSettings } from '@/state/contexts'
import type { MultiTradeRequest, TradeSide } from '@/types/domain'
import { OperationModal } from '../tools/OperationModal'
import { useDefaultTradeToken } from '../trade/useDefaultToken'
import { NearKitTradeModal, type NearKitTradeRequest } from './NearKitTrade'

const NEAR = NATIVE_TOKEN_ID
type Mode = 'equal' | 'custom'
/** Who executes a run: NearKit wallets (NearKit's server, each with its own key) or the connected wallet's accounts (signed here). */
type Source = 'nearkit' | 'browser'

interface MultiTradeProps {
  initialSide: TradeSide
  initialPresetId: string | null
  /** Preselected by a token screen (`?token=`). */
  initialTokenId?: string | null
}

export function MultiTrade({ initialSide, initialPresetId, initialTokenId = null }: MultiTradeProps) {
  const { settings } = useSettings()
  const soon = useInComingSoon()
  const { data: wallets = [], isPending: walletsPending } = useWallets()
  const { data: holdings = [] } = useHoldings()
  const { data: presets = [] } = usePresets()
  const { data: tokens = [] } = useTokens()
  const now = useNow(500)

  const caps = useCapabilities()
  const { data: session } = useSession()
  const { nearkit } = useServices()
  const { promptConnect } = useConnectPrompt()
  const navigate = useNavigate()
  const planners = usePlanners()
  const defaultToken = useDefaultTradeToken()
  const [side, setSide] = useState<TradeSide>(initialSide)
  const [pickedToken, setTokenId] = useState<string | null>(initialTokenId)
  const tokenId = pickedToken ?? defaultToken
  const [pickedPreset, setPresetId] = useState<string | null | undefined>(undefined)
  const presetId = pickedPreset !== undefined ? pickedPreset : (initialPresetId ?? (presets.some((p) => p.id === 'preset-trading') ? 'preset-trading' : null))
  const [picked, setPicked] = useState<string[] | null>(null)
  const [mode, setMode] = useState<Mode>('equal')
  const [totalText, setTotalText] = useState('10')
  const [sellPctText, setSellPctText] = useState('50')
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [slippage, setSlippage] = useState(settings.defaultSlippage)
  const [confirm, setConfirm] = useState<MultiTradeRequest | null>(null)
  const [nearkitRun, setNearkitRun] = useState<NearKitTradeRequest | null>(null)
  const [pickedSource, setSource] = useState<Source | null>(null)

  // Only wallets that can trade: a watch-only wallet never joins, whatever a preset or the URL says.
  // One source per run, since the two confirm differently.
  const executable = wallets.filter((w) => canExecute(w) && !w.frozen)
  const hasNearKit = executable.some(executesViaNearKit)
  const hasBrowser = executable.some(signsInBrowser)
  const source: Source = pickedSource ?? (hasBrowser ? 'browser' : 'nearkit')
  const pool = executable.filter((w) => (source === 'nearkit' ? executesViaNearKit(w) : signsInBrowser(w)))
  const hiddenWatch = wallets.filter((w) => !canExecute(w)).length

  const token = tokens.find((t) => t.id === tokenId)
  const symbol = token?.symbol ?? ''
  const balance = (walletId: string, id: string) => holdings.find((h) => h.walletId === walletId && h.tokenId === id)?.amount ?? 0

  // Selection starts from the chosen preset until the user edits it by hand; a preset brings only
  // its members that can run here (a legacy one may hold a watch-only wallet: it stays out).
  const preset = presets.find((p) => p.id === presetId)
  const members = preset ? presetMembers(preset, wallets) : null
  const presetWallets = members?.executable.filter((w) => pool.includes(w)).map((w) => w.id)
  const fallbackIds = session && pool.some((w) => w.id === session.walletId) ? [session.walletId] : source === 'nearkit' && pool[0] ? [pool[0].id] : []
  const selectedIds = picked ?? presetWallets ?? fallbackIds
  const selected = pool.filter((w) => selectedIds.includes(w.id))
  const n = selected.length
  const leftOut = members
    ? [
        members.excluded.filter((e) => e.reason === 'watch').length ? `${members.excluded.filter((e) => e.reason === 'watch').length} watch-only (can’t trade)` : null,
        members.executable.filter((w) => !pool.includes(w)).length
          ? `${members.executable.filter((w) => !pool.includes(w)).length} ${source === 'nearkit' ? 'connected in the browser' : 'NearKit or frozen'}`
          : null,
        members.excluded.filter((e) => e.reason === 'missing').length ? `${members.excluded.filter((e) => e.reason === 'missing').length} no longer listed` : null,
      ].filter(Boolean)
    : []

  const total = parseAmount(totalText) ?? 0
  const sellPct = Math.min(100, parseAmount(sellPctText) ?? 0)

  // Leg amounts are exact decimal strings: equal buys split in yoctoNEAR, sells take an exact fraction of the raw balance.
  const exactTotal = tryParseUnits(totalText, 24)
  const equalTexts = side === 'buy' && mode === 'equal' && exactTotal.ok && n > 0 ? splitEqual(exactTotal.value, n).map((v) => formatUnits(v, 24)) : null
  const sellText = (walletId: string, pct: number): string => {
    const raw = holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.raw
    if (raw !== undefined && token) return formatUnits(fractionOf(BigInt(raw), Math.round(pct * 100), 10_000), token.decimals)
    return toInputString(floorTo((balance(walletId, tokenId) * pct) / 100, 2), 2)
  }
  const legs = (
    side === 'buy'
      ? selected.map((w, i) => ({ walletId: w.id, text: mode === 'equal' ? (equalTexts?.[i] ?? '0') : (custom[w.id] ?? '').trim() || '0' }))
      : selected.map((w) => ({ walletId: w.id, text: sellText(w.id, mode === 'equal' ? sellPct : Math.min(100, parseAmount(custom[w.id] ?? '') ?? 0)) }))
  ).map((l) => ({ ...l, amountIn: parseAmount(l.text) ?? 0 }))

  const totalIn = legs.reduce((s, l) => s + l.amountIn, 0)
  const slip = slippageIssue(slippage)
  const request: MultiTradeRequest | null = legs.some((l) => l.amountIn > 0)
    ? { side, tokenId, slippagePct: slip?.level === 'error' ? 1 : slippage, legs: legs.map((l) => ({ walletId: l.walletId, amountIn: l.text })) }
    : null
  const settledKey = useDebouncedValue(JSON.stringify(request), 250)
  const settledRequest = useMemo(() => (settledKey ? (JSON.parse(settledKey) as MultiTradeRequest | null) : null), [settledKey])
  const quote = useMultiQuote(settledRequest)
  const q = request ? quote.data : undefined
  const settling = JSON.stringify(request) !== settledKey || quote.isFetching
  const stale = settling || (q !== undefined && now >= q.expiresAt)
  const shortOf = (walletId: string) => q?.legs.find((l) => l.walletId === walletId)?.shortfall ?? 0
  const outOf = (walletId: string) => q?.legs.find((l) => l.walletId === walletId)?.amountOut
  const shortWallets = q ? q.legs.filter((l) => l.shortfall > 1e-9).length : 0
  const liveLegs = q ? q.legs.length - shortWallets : 0

  const inUnit = side === 'buy' ? 'NEAR' : symbol
  const outUnit = side === 'buy' ? symbol : 'NEAR'

  const toggle = (walletId: string) => {
    const base = new Set(selectedIds)
    if (base.has(walletId)) base.delete(walletId)
    else base.add(walletId)
    setPicked(pool.filter((w) => base.has(w.id)).map((w) => w.id))
    setPresetId(null)
  }

  let blocker: string | null = null
  if (n === 0) blocker = 'Select at least one wallet'
  else if (side === 'buy' && mode === 'equal' && !(total > 0)) blocker = 'Enter a total amount'
  else if (!(totalIn > 0)) blocker = side === 'buy' ? 'Allocate NEAR to at least one wallet' : `Selected wallets hold no ${symbol} to sell`
  else if (slip?.level === 'error') blocker = 'Check slippage'
  else if (quote.isError) blocker = quote.error instanceof Error ? quote.error.message : 'Quote unavailable'
  else if (q && liveLegs === 0) blocker = 'No selected wallet can cover its allocation'

  const verb = side === 'buy' ? 'Multi buy' : 'Multi sell'

  // ─── wallet table ─────────────────────────────────────────────────────────

  const allocationCell = (walletId: string, amountIn: number) => {
    if (mode === 'custom') {
      return (
        <div className="ml-auto flex w-32 flex-col items-end gap-0.5">
          <AmountInput
            aria-label={side === 'buy' ? 'NEAR for this wallet' : 'Percent of balance to sell'}
            value={custom[walletId] ?? ''}
            onValueChange={(v) => setCustom((c) => ({ ...c, [walletId]: v }))}
            unit={side === 'buy' ? 'NEAR' : '%'}
            placeholder="0"
            size="sm"
            className="w-full"
          />
          {side === 'sell' && amountIn > 0 && (
            <span className="num text-[11px] text-fg-3">
              {formatCompact(amountIn, 2)} {symbol}
            </span>
          )}
        </div>
      )
    }
    return <span className={cn('num', amountIn > 0 ? 'text-fg' : 'text-fg-4')}>{side === 'buy' ? formatNumber(amountIn, 2, 4) : formatCompact(amountIn, 2)}</span>
  }

  const statusCell = (walletId: string, isSelected: boolean) => {
    if (!isSelected) return <span className="text-xs text-fg-4">Not selected</span>
    const short = shortOf(walletId)
    if (short > 1e-9)
      return (
        <span className="text-xs text-neg">
          Short {formatNumber(short, 2, 4)} {inUnit}
        </span>
      )
    return q ? <Tag tone="neutral">Ready</Tag> : <span className="text-xs text-fg-4">—</span>
  }

  const walletTable = (
    <Panel>
      <PanelHeader
        title="Wallets"
        meta={`${n} of ${pool.length} selected`}
        actions={
          <>
            {hasNearKit && hasBrowser && (
              <Segmented
                label="Wallet source"
                size="sm"
                value={source}
                onChange={(v) => {
                  setSource(v)
                  setPicked(null)
                }}
                options={[
                  { value: 'nearkit', label: 'NearKit' },
                  { value: 'browser', label: 'Connected' },
                ]}
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setPicked(pool.map((w) => w.id))
                setPresetId(null)
              }}
            >
              Select all
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setPicked([])
                setPresetId(null)
              }}
            >
              Deselect all
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <span className="legend mr-1 flex items-center gap-1.5">
          Preset <InfoTip term="preset" />
        </span>
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={presetId === p.id}
            onClick={() => {
              setPresetId(p.id)
              setPicked(null)
            }}
            className={cn(
              'keycap h-8 rounded-md border px-3 text-2xs transition-colors',
              presetId === p.id ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg',
            )}
          >
            {p.name} <span className="num ml-1 font-normal text-fg-3">{p.walletIds.length}</span>
          </button>
        ))}
        {presetId === null && <Tag tone="neutral">Custom selection</Tag>}
      </div>
      {(leftOut.length > 0 || source === 'nearkit') && (
        <div className="flex flex-col gap-0.5 border-b border-line-soft px-4 py-2 text-xs text-fg-3">
          {source === 'nearkit' && <p>NearKit wallets: NearKit executes each wallet’s own trade on its server when you confirm here. No wallet prompt.</p>}
          {leftOut.length > 0 && <p className="text-warn">{`Left out of ${preset?.name ?? 'this preset'}: ${leftOut.join(', ')}.`}</p>}
        </div>
      )}

      {walletsPending ? (
        <div className="p-4">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : pool.length === 0 ? (
        <EmptyState
          title="No executable wallets available."
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              {nearkit.available && (
                <Button variant="primary" onClick={() => navigate('/wallets')}>
                  Create wallet
                </Button>
              )}
              <Button variant="secondary" onClick={promptConnect}>
                Connect wallet
              </Button>
            </span>
          }
        >
          {`A Multi ${side} runs on wallets that can trade: your NearKit wallets, or the accounts of a wallet connected here.${hiddenWatch ? ` Watch-only wallets (${hiddenWatch}) never join.` : ''}`}
        </EmptyState>
      ) : (
        <>
          <div className="hidden md:block">
            <Table label="Wallets for this order" rows="double" minWidth={720}>
              <thead>
                <tr>
                  <Th className="w-10">
                    <span className="sr-only">Include</span>
                  </Th>
                  <Th>Wallet</Th>
                  <Th align="right">NEAR</Th>
                  <Th align="right">{symbol}</Th>
                  <Th align="right">{side === 'buy' ? 'Allocation · NEAR' : mode === 'equal' ? `Sell · ${formatNumber(sellPct, 0, 2)}%` : 'Sell · % of balance'}</Th>
                  <Th align="right">Est. output</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {pool.map((w) => {
                  const isSelected = selectedIds.includes(w.id)
                  const leg = legs.find((l) => l.walletId === w.id)
                  const out = outOf(w.id)
                  const short = shortOf(w.id) > 1e-9
                  return (
                    <Tr key={w.id} className={cn(!isSelected && 'text-fg-4', short && 'bg-neg/[0.04]')}>
                      <Td>
                        <Checkbox checked={isSelected} onChange={() => toggle(w.id)} aria-label={`Include ${w.label}`} />
                      </Td>
                      <Td>
                        <div className="flex flex-col">
                          <span className={cn('text-sm', isSelected ? 'text-fg' : 'text-fg-3')}>{w.label}</span>
                          <AccountText id={w.accountId} className="text-[11px] text-fg-4" />
                        </div>
                      </Td>
                      <Td align="right" mono className={isSelected ? 'text-fg-2' : 'text-fg-4'}>
                        {formatAmount(balance(w.id, NEAR), 2)}
                      </Td>
                      <Td align="right" mono className={isSelected ? 'text-fg-2' : 'text-fg-4'}>
                        {balance(w.id, tokenId) > 0 ? formatCompact(balance(w.id, tokenId), 2) : '0'}
                      </Td>
                      <Td align="right">{isSelected ? allocationCell(w.id, leg?.amountIn ?? 0) : <span className="text-fg-4">—</span>}</Td>
                      <Td align="right" mono className={cn(stale && 'opacity-45', short ? 'text-fg-4 line-through' : 'text-fg-2')}>
                        {isSelected && out !== undefined ? `${side === 'buy' ? formatCompact(out, 2) : formatNumber(out, 2, 4)}` : '—'}
                      </Td>
                      <Td align="right">{statusCell(w.id, isSelected)}</Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </div>

          <ul className="divide-y divide-line-soft md:hidden" aria-label="Wallets for this order">
            {pool.map((w) => {
              const isSelected = selectedIds.includes(w.id)
              const leg = legs.find((l) => l.walletId === w.id)
              const out = outOf(w.id)
              return (
                <li key={w.id} className={cn('flex flex-col gap-2 px-4 py-3', shortOf(w.id) > 1e-9 && 'bg-neg/[0.04]')}>
                  <div className="flex items-start justify-between gap-3">
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggle(w.id)}
                      label={
                        <span className="flex flex-col">
                          <span className={isSelected ? 'text-fg' : 'text-fg-3'}>{w.label}</span>
                          <AccountText id={w.accountId} className="text-[11px] text-fg-4" />
                        </span>
                      }
                    />
                    <div className="text-right">{statusCell(w.id, isSelected)}</div>
                  </div>
                  <div className="flex items-end justify-between gap-3 pl-6 text-xs">
                    <span className="num text-fg-3">
                      {formatAmount(balance(w.id, NEAR), 2)} NEAR · {formatCompact(balance(w.id, tokenId), 2)} {symbol}
                    </span>
                    {isSelected && <span className="shrink-0">{allocationCell(w.id, leg?.amountIn ?? 0)}</span>}
                  </div>
                  {isSelected && out !== undefined && (
                    <p className={cn('num pl-6 text-xs text-fg-3', stale && 'opacity-45')}>
                      → {side === 'buy' ? formatCompact(out, 2) : formatNumber(out, 2, 4)} {outUnit}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          {hiddenWatch > 0 && (
            <p className="border-t border-line-soft px-4 py-2 text-xs text-fg-3">{`${hiddenWatch} watch-only ${hiddenWatch === 1 ? 'wallet is' : 'wallets are'} not listed: watch-only wallets can’t trade.`}</p>
          )}
        </>
      )}
      <div className="border-t border-line-soft px-4 py-3">
        <AllocationBar
          segments={legs.map((l) => ({ key: l.walletId, label: wallets.find((w) => w.id === l.walletId)?.label ?? l.walletId, value: l.amountIn }))}
          budget={totalIn}
          state={totalIn > 0 ? 'balanced' : 'empty'}
          unit={inUnit}
          summary={`${formatNumber(totalIn, side === 'buy' ? 2 : 0, side === 'buy' ? 4 : 2)} ${inUnit} across ${legs.filter((l) => l.amountIn > 0).length} wallets`}
        />
      </div>
    </Panel>
  )

  // ─── order panel ──────────────────────────────────────────────────────────

  const orderPanel = (
    <Panel>
      <PanelHeader title="Order" actions={<Tag tone={side === 'buy' ? 'accent' : 'neg'}>{verb}</Tag>} />
      <div className="flex flex-col gap-4 p-4">
        <Field label="Token">{({ id }) => <TokenSelect id={id} label="Token" value={tokenId} onChange={setTokenId} exclude={[NEAR]} />}</Field>

        <div className="flex flex-col gap-1.5">
          <span className="legend flex items-center gap-1.5">
            Allocation <InfoTip term={mode === 'equal' ? 'equalAllocation' : 'customAllocation'} />
          </span>
          <Segmented
            label="Allocation mode"
            block
            value={mode}
            onChange={setMode}
            options={[
              { value: 'equal', label: 'Equal' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
        </div>

        {side === 'buy' ? (
          mode === 'equal' ? (
            <div className="flex flex-col gap-2">
              <Field label="Total" aside={n > 0 && total > 0 ? <Figures>{`${formatNumber(total / n, 2, 4)} NEAR / wallet`}</Figures> : null}>
                {({ id }) => <AmountInput id={id} size="lg" value={totalText} onValueChange={setTotalText} unit="NEAR" placeholder="0.00" />}
              </Field>
              <div className="grid grid-cols-4 gap-1" role="group" aria-label="Total presets">
                {[5, 10, 25, 50].map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={total === v}
                    onClick={() => setTotalText(String(v))}
                    className={cn(
                      'num h-7 rounded-xs border text-xs transition-colors',
                      total === v ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line bg-raised/50 text-fg-2 hover:border-line-strong hover:text-fg',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <p className="text-xs text-fg-3">
                <Figures>{`MAX is not offered here: each wallet keeps ${GAS_RESERVE_NEAR} NEAR for gas.`}</Figures>
              </p>
            </div>
          ) : (
            <Lines>
              <Line label="Total (sum of rows)" emphasis>
                {formatNumber(totalIn, 2, 4)} NEAR
              </Line>
            </Lines>
          )
        ) : mode === 'equal' ? (
          <div className="flex flex-col gap-2">
            <Field label="Sell from each wallet">
              {({ id }) => <AmountInput id={id} value={sellPctText} onValueChange={setSellPctText} unit="% of balance" placeholder="0" />}
            </Field>
            <div className="grid grid-cols-4 gap-1" role="group" aria-label="Sell presets">
              {[25, 50, 75, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={sellPct === v}
                  onClick={() => setSellPctText(String(v))}
                  className={cn(
                    'keycap h-8 rounded-md border text-2xs transition-colors',
                    sellPct === v ? 'border-neg/50 bg-neg/10 text-neg' : 'border-line bg-raised/50 text-fg-2 hover:border-line-strong hover:text-fg',
                  )}
                >
                  {v === 100 ? 'MAX' : `${v}%`}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-fg-3">Set the percentage to sell for each wallet in the table.</p>
        )}

        <SlippageControl value={slippage} onChange={setSlippage} />

        <div className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
          <Lines className={cn('transition-opacity', stale && q && 'opacity-45')}>
            <Line label="Wallets">{n > 0 ? `${liveLegs || legs.filter((l) => l.amountIn > 0).length} of ${n}` : '—'}</Line>
            <Line label="Total in">{totalIn > 0 ? `${formatNumber(totalIn, side === 'buy' ? 2 : 0, side === 'buy' ? 4 : 2)} ${inUnit}` : '—'}</Line>
            <Line label="Est. output" emphasis>
              {q ? `${side === 'buy' ? formatCompact(q.totalOut, 2) : formatNumber(q.totalOut, 2, 4)} ${outUnit}` : '—'}
            </Line>
            <Line label={<Term term="minReceived" />}>{q ? `${side === 'buy' ? formatCompact(q.totalMinOut, 2) : formatNumber(q.totalMinOut, 2, 4)} ${outUnit}` : '—'}</Line>
            <Line label={<Term term="priceImpact" />}>{!q ? '—' : q.priceImpactPct === null ? 'Unknown' : formatPct(q.priceImpactPct, { signed: false })}</Line>
            <Line
              label={
                <>
                  NearKit fee <span className="num text-fg-2">{NEARKIT_FEE_LABEL}</span> <InfoTip term="nearkitFee" />
                </>
              }
            >
              {!q
                ? '—'
                : caps.mode === 'near' && !caps.execution.trading.feeCharged
                  ? 'Not charged on testnet'
                  : `${formatNumber(q.nearkitFeeTotal, 2, 6)} ${q.feeTokenId === NATIVE_TOKEN_ID ? 'NEAR' : symbol}`}
            </Line>
            <Line label={<Term term="networkFee">Network fee (est.)</Term>}>{q ? `${formatNumber(q.networkFeeNear, 4, 4)} NEAR · ${liveLegs} tx` : '—'}</Line>
          </Lines>
          <QuoteFreshness quotedAt={q?.quotedAt} expiresAt={q?.expiresAt} fetching={settling} />
          {shortWallets > 0 && (
            <p className="text-xs text-warn">
              {shortWallets} {shortWallets === 1 ? 'wallet' : 'wallets'} can't cover {shortWallets === 1 ? 'its' : 'their'} allocation and will be skipped.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            block
            variant={side === 'buy' ? 'primary' : 'sell'}
            disabled={blocker !== null || !q}
            onClick={() => {
              if (!q || !request) return
              const legs = request.legs.filter((l) => (parseAmount(l.amountIn) ?? 0) > 0 && shortOf(l.walletId) <= 1e-9)
              if (source === 'nearkit') setNearkitRun({ side, tokenId, symbol, slippagePct: request.slippagePct, legs })
              else setConfirm({ ...request, legs })
            }}
          >
            Execute {verb.toLowerCase()}
          </Button>
          {blocker && !soon && <p className="text-xs text-fg-3">{blocker}</p>}
          <SimulationNote real={source === 'nearkit' ? 'NearKit executes each NearKit wallet’s own trade, signed with that wallet’s key, and confirms it on chain.' : undefined} />
        </div>
      </div>
    </Panel>
  )

  return (
    <>
      <Tabs
        idBase="multi"
        label="Order side"
        value={side}
        onChange={(v) => {
          setSide(v)
          setCustom({})
        }}
        tabs={[
          { value: 'buy', label: 'Multi buy' },
          { value: 'sell', label: 'Multi sell' },
        ]}
      />
      <div {...tabPanelProps('multi', side)} className="outline-none">
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="order-2 min-w-0 xl:order-1">{walletTable}</div>
          <div className="order-1 min-w-0 xl:sticky xl:top-16 xl:order-2">{orderPanel}</div>
        </div>
      </div>
      {confirm && (
        <OperationModal
          title={`Review ${side === 'buy' ? 'multi buy' : 'multi sell'}`}
          confirmLabel={`Execute multi ${side}`}
          prepare={() => planners.multi(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
      {nearkitRun && <NearKitTradeModal request={nearkitRun} wallets={pool} onClose={() => setNearkitRun(null)} />}
    </>
  )
}
