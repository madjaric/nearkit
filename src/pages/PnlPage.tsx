import { Share2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { PnlScope } from '@/components/chart/PnlScope'
import { SimMark } from '@/components/domain/SimMark'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct, Price } from '@/components/ui/Num'
import { toneOf } from '@/lib/tone'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useSort } from '@/components/ui/useSort'
import { cn } from '@/lib/cn'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatCompact, formatDateTime, formatNumber, formatPrice, NEAR_FORMAT, USD_FORMAT, type MoneyFormat } from '@/lib/format'
import { bucketLabel, PNL_PERIODS } from '@/lib/pnlPeriod'
import { useCapabilities, usePnl, useWallets } from '@/services/queries'
import { cardFromReport } from '@/features/portfolio/pnlCard'
import { PnlCardDialog } from '@/features/portfolio/PnlCardDialog'
import { LIMITATION_TEXT } from '@/features/portfolio/pnlText'
import type { ClosedTrade, PnlRange, PnlReport, Token, TokenPnl } from '@/types/domain'

const PERIODS = PNL_PERIODS.map((p) => ({ value: p.value, label: p.label }))
const periodOf = (range: PnlRange) => PNL_PERIODS.find((p) => p.value === range) ?? { value: range, label: range.toUpperCase(), name: range }
/** The next longer period, offered when this one has nothing in it. */
const longer = (range: PnlRange): PnlRange | null => PNL_PERIODS[PNL_PERIODS.findIndex((p) => p.value === range) + 1]?.value ?? null

type TokenKey = 'token' | 'trades' | 'volume' | 'realized' | 'unrealized' | 'win'
const TOKEN_GETTERS: Record<TokenKey, (t: TokenPnl) => number | string> = {
  token: (t) => t.token.symbol,
  trades: (t) => t.trades,
  volume: (t) => t.volumeUsd,
  // Unknown figures sort below every known one.
  realized: (t) => t.realizedUsd ?? Number.NEGATIVE_INFINITY,
  unrealized: (t) => t.unrealizedUsd ?? Number.NEGATIVE_INFINITY,
  win: (t) => t.winRatePct,
}

/** A money figure in the report's currency: green above zero, red below, plain at zero; unknown is a ghost dash. */
function Money({
  value,
  money,
  signed = false,
  colored = false,
  className,
}: {
  value: number | null
  money: MoneyFormat
  signed?: boolean
  colored?: boolean
  className?: string
}) {
  if (value === null) return <span className={cn('num text-fg-4', className)}>—</span>
  return <span className={cn('num', colored && toneOf(value), className)}>{money.full(value, { signed })}</span>
}

/** A token as the Positions table shows it: its glyph, symbol and name. */
function TokenCell({ token, sub }: { token: Token; sub?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TokenGlyph symbol={token.symbol} tokenId={token.id} size={28} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 font-medium text-fg">
          {token.symbol}
          {token.status === 'prelaunch' && <SimMark className="ml-0" />}
        </span>
        <span className="truncate text-xs text-fg-3">{sub ?? token.name}</span>
      </span>
    </span>
  )
}

/** Nothing in this period: say so, and offer the next longer one. */
function Nothing({ text, range, onRange }: { text: string; range: PnlRange; onRange: (r: PnlRange) => void }) {
  const next = longer(range)
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-sm text-fg-3">{text}</p>
      {next && (
        <Button size="sm" variant="secondary" onClick={() => onRange(next)}>
          {`Show ${periodOf(next).label}`}
        </Button>
      )}
    </div>
  )
}

function ByToken({ rows, money }: { rows: TokenPnl[]; money: MoneyFormat }) {
  const { sorted, thSort } = useSort(rows, TOKEN_GETTERS, { key: 'realized', dir: 'desc' })
  const won = (t: TokenPnl) => ((t.closed ?? t.trades) ? `${formatNumber(t.winRatePct, 0, 1)}%` : '—')
  return (
    <>
      <ul className="divide-y divide-line-soft md:hidden" aria-label="PnL by token">
        {sorted.map((t) => (
          <li key={t.token.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <TokenCell token={t.token} sub={`${t.trades} ${t.trades === 1 ? 'trade' : 'trades'} · ${won(t)} won`} />
            <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
              <Money money={money} value={t.realizedUsd} signed colored className="text-sm" />
              <span className="text-fg-3">
                open <Money money={money} value={t.unrealizedUsd} signed colored />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table label="PnL by token" rows="double" minWidth={620}>
          <thead>
            <tr>
              <Th sort={thSort('token')}>Token</Th>
              <Th align="right" sort={thSort('trades')}>
                Trades
              </Th>
              <Th align="right" sort={thSort('volume')}>
                Volume
              </Th>
              <Th align="right" sort={thSort('realized')}>
                Realized
              </Th>
              <Th align="right" sort={thSort('unrealized')}>
                Unrealized
              </Th>
              <Th align="right" sort={thSort('win')}>
                Win rate
              </Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <Tr key={t.token.id}>
                <Td>
                  <TokenCell token={t.token} />
                </Td>
                <Td align="right" mono className="text-fg-2">
                  {t.trades}
                </Td>
                <Td align="right" mono className="text-fg-2">
                  {money.compact(t.volumeUsd)}
                </Td>
                <Td align="right">
                  <Money money={money} value={t.realizedUsd} signed colored />
                </Td>
                <Td align="right">
                  <Money money={money} value={t.unrealizedUsd} signed colored />
                </Td>
                <Td align="right" mono className={(t.closed ?? t.trades) ? 'text-fg-2' : 'text-fg-4'}>
                  {won(t)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  )
}

function ClosedTrades({ r, money }: { r: PnlReport; money: MoneyFormat }) {
  const { data: wallets = [] } = useWallets()
  const tokenOf = (t: ClosedTrade) => r.byToken.find((b) => b.token.id === t.tokenId)?.token
  const walletOf = (t: ClosedTrade) => wallets.find((w) => w.id === t.walletId)?.label ?? ''
  const onCost = (t: ClosedTrade) => {
    const cost = t.valueUsd - t.pnlUsd
    return cost ? (t.pnlUsd / cost) * 100 : 0
  }
  return (
    <>
      <ul className="divide-y divide-line-soft md:hidden" aria-label="Closed trades">
        {r.recentTrades.map((t) => {
          const token = tokenOf(t)
          return (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              {token ? <TokenCell token={token} sub={`${formatDateTime(t.at)} · ${walletOf(t)}`} /> : <span className="text-sm text-fg-3">{formatDateTime(t.at)}</span>}
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <Money money={money} value={t.pnlUsd} signed colored className="text-sm" />
                <Pct value={onCost(t)} className="text-[11px]" />
              </span>
            </li>
          )
        })}
      </ul>
      <div className="hidden md:block">
        <Table label="Closed trades" rows="double" minWidth={620}>
          <thead>
            <tr>
              <Th>Token</Th>
              <Th>Closed</Th>
              <Th align="right">Size</Th>
              <Th align="right">Exit</Th>
              <Th align="right">PnL</Th>
            </tr>
          </thead>
          <tbody>
            {r.recentTrades.map((t) => {
              const token = tokenOf(t)
              return (
                <Tr key={t.id}>
                  <Td>{token ? <TokenCell token={token} sub={walletOf(t)} /> : '—'}</Td>
                  <Td className="text-xs text-fg-2">{formatDateTime(t.at)}</Td>
                  <Td align="right" mono className="text-fg-2">
                    {formatCompact(t.amount, 2)}
                  </Td>
                  <Td align="right">
                    {r.currency === 'NEAR' ? <span className="num text-fg-2">{formatPrice(t.priceUsd)} NEAR</span> : <Price value={t.priceUsd} className="text-fg-2" />}
                  </Td>
                  <Td align="right">
                    <Money money={money} value={t.pnlUsd} signed colored />
                    <div>
                      <Pct value={onCost(t)} className="text-[11px]" />
                    </div>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      </div>
    </>
  )
}

/** The chart's table view: the buckets in which trades closed, newest first. */
function Buckets({ r, money, range, onRange }: { r: PnlReport; money: MoneyFormat; range: PnlRange; onRange: (r: PnlRange) => void }) {
  const active = r.points.slice(1).filter((p) => p.booked !== 0 || p.volumeUsd !== 0)
  if (!active.length) return <Nothing text={`No trade closed in ${periodOf(range).name}.`} range={range} onRange={onRange} />
  return (
    <div className="max-h-[420px] overflow-y-auto">
      <Table label="Realized PnL by period">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <Th>Period</Th>
            <Th align="right">Realized</Th>
            <Th align="right">Cumulative</Th>
          </tr>
        </thead>
        <tbody>
          {[...active].reverse().map((p) => (
            <Tr key={p.t}>
              <Td className="text-xs text-fg-2">{bucketLabel(p, r.bucketMs)}</Td>
              <Td align="right">{p.booked === 0 ? <span className="num text-fg-4">0.00</span> : <Money money={money} value={p.booked} signed colored />}</Td>
              <Td align="right">
                <Money money={money} value={p.cumulative} signed colored />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

function Pnl() {
  const [range, setRange] = useState<PnlRange>('90d')
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const pnl = usePnl(range)
  const { data: wallets = [] } = useWallets()
  const r = pnl.data
  const loading = pnl.isPending
  const dim = pnl.isPlaceholderData
  const chain = r?.source === 'chain'
  const money = r?.currency === 'NEAR' ? NEAR_FORMAT : USD_FORMAT
  const caps = useCapabilities()
  // The figures' period: while a newly picked one loads, the last one stays on screen (dimmed), named as what it is.
  const period = periodOf(r?.range ?? range)
  /** When the card was opened: its "as of" time. */
  const [sharedAt, setSharedAt] = useState<number | null>(null)
  const accounts = [...new Set(wallets.map((w) => w.accountId))]
  const judged = r ? r.wins + r.losses : 0

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Period" value={range} onChange={setRange} options={PERIODS} />
        <div className="flex flex-wrap items-center gap-3">
          {chain ? (
            <span className="flex items-center gap-2 text-xs text-fg-3">
              <Tag tone="neutral">On-chain history</Tag> Average cost · {r?.currency === 'NEAR' ? 'in NEAR: no USD prices on this network' : 'USD at each trade’s hour'}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-xs text-fg-3">
              <Tag tone="neutral">Demo history</Tag> Closed trades generated for the preview
            </span>
          )}
          <Button size="sm" variant="secondary" icon={<Share2 size={14} />} disabled={!r || dim} onClick={() => setSharedAt(Date.now())}>
            Share card
          </Button>
        </div>
      </div>
      {sharedAt !== null && r && <PnlCardDialog card={cardFromReport(r, { network: caps.network, at: sharedAt })} accounts={accounts} onClose={() => setSharedAt(null)} />}

      <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5" className={dim ? 'opacity-60 transition-opacity' : undefined}>
        <ReadoutSlot
          className="col-span-2 md:col-span-1"
          size="lg"
          legend={<Term term="realizedPnl" />}
          aside={<span className="num text-[11px] text-fg-3">{period.label}</span>}
          loading={loading}
          value={r ? <Money money={money} value={r.realizedUsd} signed colored /> : '—'}
          sub={r ? (r.trades ? `${r.trades} closed ${r.trades === 1 ? 'trade' : 'trades'} in ${period.name}` : `no trade closed in ${period.name}`) : ''}
        />
        <ReadoutSlot
          legend={<Term term="unrealizedPnl" />}
          aside={<span className="text-[11px] text-fg-3">now</span>}
          loading={loading}
          value={r ? <Money money={money} value={r.unrealizedUsd} signed colored /> : '—'}
          sub={r?.unrealizedUsd === null ? 'unknown: no current price' : 'open positions, at today’s prices'}
        />
        <ReadoutSlot
          legend="Trading volume"
          aside={<span className="num text-[11px] text-fg-3">{period.label}</span>}
          loading={loading}
          value={r ? money.compact(r.volumeUsd, 2) : '—'}
          sub="entries + exits"
        />
        {chain ? (
          <ReadoutSlot
            legend={
              <>
                Gas paid{' '}
                <InfoTip>
                  NEAR these accounts paid as gas in the period, transaction by transaction. Swap fees (NEARKITS’ {NEARKIT_FEE_LABEL}, Rhea’s) are inside each trade’s value.
                </InfoTip>
              </>
            }
            aside={<span className="num text-[11px] text-fg-3">{period.label}</span>}
            loading={loading}
            value={r?.gasNear !== undefined ? NEAR_FORMAT.full(r.gasNear) : '—'}
            sub={r?.history && !r.history.complete ? `partial: latest ${r.history.txs} transactions read` : `in ${period.name}`}
          />
        ) : (
          <ReadoutSlot
            legend={
              <>
                Fees paid <InfoTip>Estimated at {NEARKIT_FEE_LABEL} of volume. The demo charges no fee.</InfoTip>
              </>
            }
            aside={<span className="num text-[11px] text-fg-3">{period.label}</span>}
            loading={loading}
            value={r ? money.full(r.feesUsd) : '—'}
            sub={`${NEARKIT_FEE_LABEL} of volume`}
          />
        )}
        <ReadoutSlot
          className="md:col-span-2 xl:col-span-1"
          legend={<Term term="winRate" />}
          aside={<span className="num text-[11px] text-fg-3">{period.label}</span>}
          loading={loading}
          value={r && judged > 0 ? `${formatNumber(r.winRatePct, 1, 1)}%` : <span className="text-fg-4">—</span>}
          sub={r ? (judged > 0 ? `${r.wins} won · ${r.losses} lost` : 'no closed trade with a known result') : ''}
        />
      </ReadoutStrip>

      {chain && r?.limitations && r.limitations.length > 0 && (
        <Panel className="px-4 py-3">
          <p className="text-xs text-fg-2">Partial figures:</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-warn">
            {r.limitations.map((l) => (
              <li key={l}>{LIMITATION_TEXT[l]}</li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title="Cumulative realized PnL"
          meta={r && r.realizedUsd !== null ? <span className={cn('num', toneOf(r.realizedUsd))}>{money.compact(r.realizedUsd)}</span> : undefined}
          actions={
            <span className="flex items-center gap-2">
              <InfoTip>Drag cursor A or B on the chart, or focus a cursor handle and use the arrow keys (Shift for 7 steps), to measure the PnL between any two points.</InfoTip>
              <Segmented
                label="View"
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'chart', label: 'Chart' },
                  { value: 'table', label: 'Table' },
                ]}
              />
            </span>
          }
        />
        <div className="p-4">
          {loading || !r ? (
            <Skeleton className="h-[300px] w-full" />
          ) : view === 'chart' ? (
            <PnlScope key={`${range}-${r.points.length}`} points={r.points} bucketMs={r.bucketMs} periodName={period.name} dim={dim} money={money} />
          ) : (
            <Buckets r={r} money={money} range={r.range} onRange={setRange} />
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
        <Panel>
          <PanelHeader title="By token" meta={r?.byToken.length} actions={<span className="num text-[11px] text-fg-3">{period.label}</span>} />
          {!r ? (
            <Skeleton className="m-4 h-40" />
          ) : r.byToken.length === 0 ? (
            <Nothing text={`No token traded in ${period.name}.`} range={r.range} onRange={setRange} />
          ) : (
            <ByToken rows={r.byToken} money={money} />
          )}
        </Panel>
        <Panel>
          <PanelHeader
            title="Closed trades"
            meta={r?.recentTrades.length}
            actions={<span className="text-[11px] text-fg-3">{r && r.trades > r.recentTrades.length ? `latest ${r.recentTrades.length} of ${r.trades}` : period.label}</span>}
          />
          {!r ? (
            <Skeleton className="m-4 h-40" />
          ) : r.recentTrades.length === 0 ? (
            <Nothing text={`No trade closed in ${period.name}.`} range={r.range} onRange={setRange} />
          ) : (
            <ClosedTrades r={r} money={money} />
          )}
        </Panel>
      </div>
    </>
  )
}

/** Real mode: no cost basis is recorded yet, and NearKit won't infer one from balances. */
function NotTracked() {
  return (
    <Panel>
      <EmptyState
        title="PnL isn't tracked yet"
        action={
          <Link to="/positions" className={buttonClass()}>
            See positions
          </Link>
        }
      >
        PnL needs the entry price of every trade, including trades made outside NEARKITS. NEARKITS doesn't guess it from balances, because a wrong PnL is worse than none. Positions
        show your live balances and their value.
      </EmptyState>
    </Panel>
  )
}

export default function PnlPage() {
  const caps = useCapabilities()
  return (
    <Page>
      <PageHeader title="PnL" description="Realized and unrealized performance across every NEARKITS wallet, for the period you pick." />
      <RequireWallet feature="PnL">{caps.pnl ? <Pnl /> : <NotTracked />}</RequireWallet>
    </Page>
  )
}
