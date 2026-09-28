import { useState } from 'react'
import { Link } from 'react-router'
import { PnlScope } from '@/components/chart/PnlScope'
import { SimMark } from '@/components/domain/SimMark'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Form'
import { InfoTip, Term } from '@/components/ui/Help'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct, Price, Usd } from '@/components/ui/Num'
import { toneOf } from '@/lib/tone'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useSort } from '@/components/ui/useSort'
import { cn } from '@/lib/cn'
import { NEARKIT_FEE_LABEL } from '@/lib/fees'
import { formatCompact, formatDate, formatDateTime, formatNumber, formatUsd, formatUsdCompact } from '@/lib/format'
import { useCapabilities, usePnl, useWallets } from '@/services/queries'
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
  realized: (t) => t.realizedUsd,
  unrealized: (t) => t.unrealizedUsd,
  win: (t) => t.winRatePct,
}

function ByToken({ rows }: { rows: TokenPnl[] }) {
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
                  {t.trades} trades · {t.trades ? `${formatNumber(t.winRatePct, 0, 1)}% won` : '—'}
                </span>
              </span>
            </span>
            <span className="text-right text-xs">
              <span className="block">
                <span className="text-fg-3">real </span>
                <Usd value={t.realizedUsd} signed colored />
              </span>
              <span className="block">
                <span className="text-fg-3">open </span>
                <Usd value={t.unrealizedUsd} signed colored />
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
                  {formatUsdCompact(t.volumeUsd)}
                </Td>
                <Td align="right">
                  <Usd value={t.realizedUsd} signed colored />
                </Td>
                <Td align="right">
                  <Usd value={t.unrealizedUsd} signed colored />
                </Td>
                <Td align="right" mono className={t.trades ? 'text-fg-2' : 'text-fg-4'}>
                  {t.trades ? `${formatNumber(t.winRatePct, 0, 1)}%` : '—'}
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

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Date range" value={range} onChange={setRange} options={RANGES} />
        <span className="flex items-center gap-2 text-xs text-fg-3">
          <Tag tone="neutral">Demo history</Tag> Closed trades generated for the preview
        </span>
      </div>

      <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5" className={dim ? 'opacity-60 transition-opacity' : undefined}>
        <ReadoutSlot
          className="col-span-2 md:col-span-1"
          size="lg"
          legend={<Term term="realizedPnl" />}
          loading={loading}
          value={r ? <span className={toneOf(r.realizedUsd)}>{formatUsd(r.realizedUsd, { signed: true })}</span> : '—'}
          sub={r ? `${r.trades} closed trades` : ''}
        />
        <ReadoutSlot
          legend={<Term term="unrealizedPnl" />}
          loading={loading}
          value={r ? <span className={toneOf(r.unrealizedUsd)}>{formatUsd(r.unrealizedUsd, { signed: true })}</span> : '—'}
          sub="open positions, now"
        />
        <ReadoutSlot legend="Trading volume" loading={loading} value={r ? formatUsdCompact(r.volumeUsd, 2) : '—'} sub="entries + exits" />
        <ReadoutSlot
          legend={
            <>
              Fees paid <InfoTip>Estimated at {NEARKIT_FEE_LABEL} of volume. The demo charges no fee.</InfoTip>
            </>
          }
          loading={loading}
          value={r ? formatUsd(r.feesUsd) : '—'}
          sub={`${NEARKIT_FEE_LABEL} of volume`}
        />
        <ReadoutSlot
          className="md:col-span-2 xl:col-span-1"
          legend={<Term term="winRate" />}
          loading={loading}
          value={r ? `${formatNumber(r.winRatePct, 1, 1)}%` : '—'}
          sub={r ? `${r.wins} won · ${r.losses} lost` : ''}
        />
      </ReadoutStrip>

      <Panel>
        <PanelHeader
          title="Cumulative realized PnL"
          meta={r ? <span className={cn('num', toneOf(r.realizedUsd))}>{formatUsdCompact(r.realizedUsd)}</span> : undefined}
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
              <PnlScope key={`${range}-${r.points.length}`} points={r.points} dim={dim} />
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
                      <Td align="right">{p.daily === 0 ? <span className="num text-fg-4">0.00</span> : <Usd value={p.daily} signed colored />}</Td>
                      <Td align="right">
                        <Usd value={p.cumulative} signed colored />
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
          {r ? <ByToken rows={r.byToken} /> : <Skeleton className="m-4 h-40" />}
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
                        <Usd value={t.pnlUsd} signed colored className="text-sm" />
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
                            <Price value={t.priceUsd} className="text-fg-2" />
                          </Td>
                          <Td align="right">
                            <Usd value={t.pnlUsd} signed colored />
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
          <Link to="/positions" className="keycap inline-flex h-8 items-center rounded-sm border border-line px-3 text-xs text-fg-2 hover:border-line-strong hover:text-fg">
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
