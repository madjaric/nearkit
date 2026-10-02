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
import { formatCompact, formatDate, formatDateTime, formatNumber, formatPrice, NEAR_FORMAT, USD_FORMAT, type MoneyFormat } from '@/lib/format'
import { useCapabilities, usePnl, useWallets } from '@/services/queries'
import { cardFromReport } from '@/features/portfolio/pnlCard'
import { PnlCardDialog } from '@/features/portfolio/PnlCardDialog'
import { LIMITATION_TEXT } from '@/features/portfolio/pnlText'
import type { PnlRange, TokenPnl } from '@/types/domain'

const RANGES: { value: PnlRange; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'All' },
]

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

/** A money figure in the report's currency. */
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

function ByToken({ rows, money }: { rows: TokenPnl[]; money: MoneyFormat }) {
  const { sorted, thSort } = useSort(rows, TOKEN_GETTERS, { key: 'realized', dir: 'desc' })
  return (
    <>
      <ul className="divide-y divide-line-soft md:hidden" aria-label="PnL by token">
        {sorted.map((t) => (
          <li key={t.token.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-2.5">
              <TokenGlyph symbol={t.token.symbol} tokenId={t.token.id} size={20} />
              <span className="flex flex-col">
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                  {t.token.symbol}
                  {t.token.status === 'prelaunch' && <SimMark className="ml-0" />}
                </span>
                <span className="num text-[11px] text-fg-3">
                  {t.trades} {t.trades === 1 ? 'trade' : 'trades'} · {(t.closed ?? t.trades) ? `${formatNumber(t.winRatePct, 0, 1)}% won` : 'none closed'}
                </span>
              </span>
            </span>
            <span className="text-right text-xs">
              <span className="block">
                <span className="text-fg-3">real </span>
                <Money money={money} value={t.realizedUsd} signed colored />
              </span>
              <span className="block">
                <span className="text-fg-3">open </span>
                <Money money={money} value={t.unrealizedUsd} signed colored />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table label="PnL by token" rows="double" minWidth={560}>
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
                  <span className="flex items-center gap-2">
                    <TokenGlyph symbol={t.token.symbol} tokenId={t.token.id} size={20} />
                    <span className="flex items-center gap-1.5 font-medium text-fg">
                      {t.token.symbol}
                      {t.token.status === 'prelaunch' && <SimMark className="ml-0" />}
                    </span>
                  </span>
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
                  {(t.closed ?? t.trades) ? `${formatNumber(t.winRatePct, 0, 1)}%` : '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
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
  /** When the card was opened: its "as of" time. */
  const [sharedAt, setSharedAt] = useState<number | null>(null)
  const accounts = [...new Set(wallets.map((w) => w.accountId))]

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Date range" value={range} onChange={setRange} options={RANGES} />
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
          loading={loading}
          value={r ? <Money money={money} value={r.realizedUsd} signed colored /> : '—'}
          sub={r ? `${r.trades} closed trades` : ''}
        />
        <ReadoutSlot
          legend={<Term term="unrealizedPnl" />}
          loading={loading}
          value={r ? <Money money={money} value={r.unrealizedUsd} signed colored /> : '—'}
          sub={r?.unrealizedUsd === null ? 'unknown: no current price' : 'open positions, now'}
        />
        <ReadoutSlot legend="Trading volume" loading={loading} value={r ? money.compact(r.volumeUsd, 2) : '—'} sub="entries + exits" />
        {chain ? (
          <ReadoutSlot
            legend={
              <>
                Gas paid <InfoTip>NEAR these accounts paid as gas across their history. Swap fees (NearKit’s {NEARKIT_FEE_LABEL}, Rhea’s) are inside each trade’s value.</InfoTip>
              </>
            }
            loading={loading}
            value={r?.gasNear !== undefined ? NEAR_FORMAT.full(r.gasNear) : '—'}
            sub={r?.history && !r.history.complete ? `latest ${r.history.txs} transactions only` : 'whole history'}
          />
        ) : (
          <ReadoutSlot
            legend={
              <>
                Fees paid <InfoTip>Estimated at {NEARKIT_FEE_LABEL} of volume. The demo charges no fee.</InfoTip>
              </>
            }
            loading={loading}
            value={r ? money.full(r.feesUsd) : '—'}
            sub={`${NEARKIT_FEE_LABEL} of volume`}
          />
        )}
        <ReadoutSlot
          className="md:col-span-2 xl:col-span-1"
          legend={<Term term="winRate" />}
          loading={loading}
          value={r && r.wins + r.losses > 0 ? `${formatNumber(r.winRatePct, 1, 1)}%` : '—'}
          sub={r ? (r.wins + r.losses > 0 ? `${r.wins} won · ${r.losses} lost` : 'no closed trades with a known result') : ''}
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
          }
        />
        <div className="p-4">
          {loading || !r ? (
            <Skeleton className="h-[420px] w-full" />
          ) : view === 'chart' ? (
            <>
              <p className="mb-3 text-xs text-fg-3">Drag cursor A or B, or focus a cursor handle and use the arrow keys (Shift for a week), to measure any window.</p>
              <PnlScope key={`${range}-${r.points.length}`} points={r.points} dim={dim} money={money} />
            </>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              <Table label="Daily realized PnL">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    <Th>Date</Th>
                    <Th align="right">Daily</Th>
                    <Th align="right">Cumulative</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.points].reverse().map((p) => (
                    <Tr key={p.t}>
                      <Td className="text-fg-2">{formatDate(p.t, true)}</Td>
                      <Td align="right">{p.daily === 0 ? <span className="num text-fg-4">0.00</span> : <Money money={money} value={p.daily} signed colored />}</Td>
                      <Td align="right">
                        <Money money={money} value={p.cumulative} signed colored />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
        <Panel>
          <PanelHeader title="By token" meta={r?.byToken.length} />
          {r ? <ByToken rows={r.byToken} money={money} /> : <Skeleton className="m-4 h-40" />}
        </Panel>
        <Panel>
          <PanelHeader title="Recent closed trades" meta={r?.recentTrades.length} />
          {r && r.recentTrades.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-fg-3">No trades closed in this range.</p>
          ) : r ? (
            <>
              <ul className="divide-y divide-line-soft md:hidden" aria-label="Recent closed trades">
                {r.recentTrades.map((t) => {
                  const token = r.byToken.find((b) => b.token.id === t.tokenId)?.token
                  const cost = t.valueUsd - t.pnlUsd
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 text-sm text-fg">
                          {token?.symbol}
                          {token?.status === 'prelaunch' && <SimMark className="ml-0" />}
                        </span>
                        <span className="truncate text-[11px] text-fg-3">
                          {formatDateTime(t.at)} · {wallets.find((w) => w.id === t.walletId)?.label}
                        </span>
                      </span>
                      <span className="text-right">
                        <Money money={money} value={t.pnlUsd} signed colored className="text-sm" />
                        <span className="block">
                          <Pct value={cost ? (t.pnlUsd / cost) * 100 : 0} className="text-[11px]" />
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
              <div className="hidden md:block">
                <Table label="Recent closed trades" rows="double" minWidth={560}>
                  <thead>
                    <tr>
                      <Th>Closed</Th>
                      <Th>Token</Th>
                      <Th align="right">Size</Th>
                      <Th align="right">Exit</Th>
                      <Th align="right">PnL</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.recentTrades.map((t) => {
                      const token = r.byToken.find((b) => b.token.id === t.tokenId)?.token
                      const cost = t.valueUsd - t.pnlUsd
                      return (
                        <Tr key={t.id}>
                          <Td className="text-xs text-fg-3">{formatDateTime(t.at)}</Td>
                          <Td>
                            <span className="flex flex-col">
                              <span className="flex items-center gap-1.5 text-fg">
                                {token?.symbol}
                                {token?.status === 'prelaunch' && <SimMark className="ml-0" />}
                              </span>
                              <span className="text-[11px] text-fg-4">{wallets.find((w) => w.id === t.walletId)?.label}</span>
                            </span>
                          </Td>
                          <Td align="right" mono className="text-fg-2">
                            {formatCompact(t.amount, 2)}
                          </Td>
                          <Td align="right">
                            {r.currency === 'NEAR' ? <span className="num text-fg-2">{formatPrice(t.priceUsd)} NEAR</span> : <Price value={t.priceUsd} className="text-fg-2" />}
                          </Td>
                          <Td align="right">
                            <Money money={money} value={t.pnlUsd} signed colored />
                            <div>
                              <Pct value={cost ? (t.pnlUsd / cost) * 100 : 0} className="text-[11px]" />
                            </div>
                          </Td>
                        </Tr>
                      )
                    })}
                  </tbody>
                </Table>
              </div>
            </>
          ) : (
            <Skeleton className="m-4 h-40" />
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
        PnL needs the entry price of every trade, including trades made outside NearKit. NearKit doesn't guess it from balances, because a wrong PnL is worse than none. Positions
        show your live balances and their value.
      </EmptyState>
    </Panel>
  )
}

export default function PnlPage() {
  const caps = useCapabilities()
  return (
    <Page>
      <PageHeader title="PnL" description="Realized and unrealized performance across every NearKit wallet." />
      <RequireWallet feature="PnL">{caps.pnl ? <Pnl /> : <NotTracked />}</RequireWallet>
    </Page>
  )
}
