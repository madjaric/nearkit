import { ArrowLeft, Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ValueTrace } from '@/components/chart/ValueTrace'
import { DataTag } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, Page, PageGrid, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Form'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct, Usd } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast-context'
import { AccountRef, FollowButton, IndexNote, Methodology, TradeRows } from '@/features/discovery/parts'
import { REASON_TEXT, tradesCsv, WINDOW_LABEL } from '@/features/discovery/model'
import { useDiscoveryClient, useWallet } from '@/features/discovery/queries'
import { WALLET_WINDOWS, type TradeView, type WalletWindowKey } from '@/lib/discovery/api'
import { formatAgo, formatDateTime, formatDuration, formatUsd } from '@/lib/format'
import { useNow } from '@/lib/hooks'

/**
 * A wallet on Top Wallets (DISCOVERY.md): its figures per window, the realized PnL curve and drawdown,
 * token by token, holding periods, an estimate of what is still open, its latest swaps (exportable),
 * and how much of its activity the index covers.
 */

const EXPORT_PAGES = 5

const pctText = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

export default function WalletDetailPage() {
  const id = decodeURIComponent(useParams().id ?? '').toLowerCase()
  const toast = useToast()
  const now = useNow(15_000)
  const client = useDiscoveryClient()
  const q = useWallet(id)
  const [range, setRange] = useState<WalletWindowKey>('30d')
  const [exporting, setExporting] = useState(false)
  const d = q.data
  const w = d?.windows[range] ?? null
  const points = useMemo(() => (d ? d.days.map((x) => ({ t: x.day * 86_400_000, v: x.cumulative })) : []), [d])

  const exportCsv = async () => {
    if (!client) return
    setExporting(true)
    try {
      const trades: TradeView[] = []
      let cursor: string | null = null
      for (let i = 0; i < EXPORT_PAGES; i++) {
        const page = await client.walletTrades(id, cursor)
        trades.push(...page.trades)
        cursor = page.nextCursor
        if (!cursor) break
      }
      const url = URL.createObjectURL(new Blob([tradesCsv(trades)], { type: 'text/csv' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `nearkits-swaps-${id}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.push({
        tone: 'accent',
        title: `${trades.length} swaps exported`,
        detail: cursor ? `The latest ${trades.length}; older swaps were left out.` : 'Every swap the index has for this wallet.',
      })
    } catch (e) {
      toast.push({ tone: 'neg', title: 'Export failed', detail: e instanceof Error ? e.message : '' })
    } finally {
      setExporting(false)
    }
  }

  if (q.isPending)
    return (
      <Page>
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the wallet">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </Page>
    )
  if (q.isError || !d)
    return (
      <Page>
        <Link to="/top-wallets" className="inline-flex w-fit items-center gap-1.5 text-xs text-fg-3 no-underline hover:text-fg">
          <ArrowLeft size={13} aria-hidden="true" /> Top Wallets
        </Link>
        <PageHeader title="Wallet" description={id} />
        <Panel>
          <LoadFailed title="No indexed swap by this wallet, or it couldn’t be read" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      </Page>
    )

  const losses = w ? w.closed - w.wins : 0
  return (
    <Page>
      <Link to="/top-wallets" className="inline-flex w-fit items-center gap-1.5 text-xs text-fg-3 no-underline hover:text-fg">
        <ArrowLeft size={13} aria-hidden="true" /> Top Wallets
      </Link>
      <PageHeader
        title={id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-10)}` : id}
        status={<DataTag />}
        description={`Wallet analysis from indexed swaps · ${id}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <FollowButton account={id} withAlerts />
            <Button size="sm" variant="ghost" loading={exporting} onClick={() => void exportCsv()}>
              <Download size={14} aria-hidden="true" /> Export CSV
            </Button>
          </span>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Window"
          size="sm"
          value={range}
          onChange={setRange}
          options={WALLET_WINDOWS.map((k) => ({ value: k, label: WINDOW_LABEL[k] === 'Top 100' ? 'All indexed' : WINDOW_LABEL[k] }))}
        />
        <span className="flex flex-wrap items-center gap-1.5">
          <AccountRef account={id} max={30} />
          {d.smart && <Tag tone="accent">Smart Money</Tag>}
          {d.automated && <Tag tone="neutral">Automated</Tag>}
          {w && !w.qualified && <Tag tone="warn">Not qualified: {w.reasons.map((r) => REASON_TEXT[r]).join('; ')}</Tag>}
        </span>
      </div>

      <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <ReadoutSlot legend="Realized PnL" value={<Usd value={w?.realized ?? null} signed colored compact />} sub="From matched sales" />
        <ReadoutSlot legend="Return" value={<Pct value={w?.returnPct ?? null} />} sub="÷ cost of units sold" />
        <ReadoutSlot legend="Win rate" value={<span className="num">{pctText(w?.winRate ?? null)}</span>} sub={w ? `${w.wins} won · ${losses} lost` : 'No closed trade'} />
        <ReadoutSlot legend="Closed trades" value={<span className="num">{w?.closed ?? 0}</span>} sub={w ? `${w.tokensSold} token${w.tokensSold === 1 ? '' : 's'} sold` : '—'} />
        <ReadoutSlot
          legend="Average gain"
          value={<Usd value={w?.avgGain ?? null} compact />}
          sub={w?.avgLoss == null ? 'Per winning trade' : `Average loss ${formatUsd(w.avgLoss)}`}
        />
        <ReadoutSlot
          legend="Coverage"
          value={<span className="num">{pctText(w?.coverage ?? null)}</span>}
          sub={w && w.unmatchedUsd > 0 ? `${formatUsd(w.unmatchedUsd)} of sales unmatched` : 'Sales with an indexed buy'}
        />
      </ReadoutStrip>

      <PageGrid
        asideWidth={360}
        aside={
          <>
            <Panel>
              <PanelHeader title="Open positions" />
              <div className="p-4">
                <Lines>
                  <Line label="Unrealized (estimate)">
                    <Usd value={d.unrealized.value} signed colored />
                  </Line>
                  <Line label="Priced positions">{d.unrealized.positions}</Line>
                  <Line label="Without a price now">{d.unrealized.unknown}</Line>
                </Lines>
                <p className="mt-3 text-[11px] leading-4 text-fg-3">
                  Units bought in indexed swaps and not sold, at today’s price, minus their cost. Tokens the wallet received by transfer are not included.
                </p>
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Holding and drawdown" />
              <div className="p-4">
                <Lines>
                  <Line label="Average holding period">{d.holding.avgMs === null ? '—' : formatDuration(d.holding.avgMs)}</Line>
                  <Line label="Positions closed">{d.holding.closedPositions}</Line>
                  <Line label="Max drawdown (realized)">
                    <Usd value={d.days.length ? -d.maxDrawdown : null} />
                  </Line>
                </Lines>
                <p className="mt-3 text-[11px] leading-4 text-fg-3">
                  Drawdown: the largest fall of cumulative realized PnL from a previous peak, by day. Holding: from the buy that opened a position to the sale that closed it.
                </p>
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Data coverage" />
              <div className="p-4">
                <Lines>
                  <Line label="First indexed swap">{d.firstTs ? formatDateTime(d.firstTs) : '—'}</Line>
                  <Line label="Latest indexed swap">{d.lastTs ? formatAgo(d.lastTs, now) : '—'}</Line>
                  <Line label="Index starts">{formatDateTime(d.index.indexStart)}</Line>
                  <Line label="Indexed to">{d.index.tradesTo ? formatAgo(d.index.tradesTo, now) : '—'}</Line>
                  <Line label="Sale coverage">{pctText(w?.coverage ?? null)}</Line>
                </Lines>
              </div>
            </Panel>
          </>
        }
      >
        <Panel>
          <PanelHeader title="Realized PnL · cumulative" actions={<span className="text-xs text-fg-3">USD, by UTC day, all indexed history</span>} />
          {points.length >= 2 ? (
            <div className="p-3">
              <ValueTrace
                points={points}
                label={`${id} cumulative realized PnL in USD`}
                formatValue={(v) => formatUsd(v, { signed: true })}
                formatTick={(v) => formatUsd(v)}
                formatTime={(t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                formatAxis={(t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                timeScale
                height={260}
              />
            </div>
          ) : (
            <EmptyState title="Not enough history for a curve" graphic={false} compact>
              The curve appears after two days with indexed swaps.
            </EmptyState>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Token by token" meta={d.tokens.length || undefined} />
          {d.tokens.length === 0 ? (
            <EmptyState title="No token traded in the index" graphic={false} compact />
          ) : (
            <div className="@container">
              <div className="hidden @[30rem]:block">
                <Table label="Performance by token">
                  <thead>
                    <tr>
                      <Th>Token</Th>
                      <Th align="right">Realized</Th>
                      <Th align="right">Closed</Th>
                      <Th align="right" className="hidden @[44rem]:table-cell">
                        Bought
                      </Th>
                      <Th align="right" className="hidden @[44rem]:table-cell">
                        Sold
                      </Th>
                      <Th align="right">Open (est.)</Th>
                      <Th align="right" className="hidden @[52rem]:table-cell">
                        Avg hold
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.tokens.slice(0, 50).map((t) => (
                      <Tr key={t.token}>
                        <Td>
                          <Link to={`/launch-radar/${encodeURIComponent(t.token)}`} className="flex items-center gap-2 no-underline" title={t.token}>
                            <TokenGlyph symbol={t.symbol ?? '?'} tokenId={t.token} size={20} />
                            <span className="max-w-28 truncate text-fg">{t.symbol ?? t.token}</span>
                          </Link>
                        </Td>
                        <Td align="right">
                          <Usd value={t.realized} signed colored />
                        </Td>
                        <Td align="right" mono className="text-fg-2">
                          {t.closed} <span className="text-fg-3">({t.wins} won)</span>
                        </Td>
                        <Td align="right" className="hidden @[44rem]:table-cell">
                          <Usd value={t.buyUsd} compact />
                        </Td>
                        <Td align="right" className="hidden @[44rem]:table-cell">
                          <Usd value={t.sellUsd} compact />
                        </Td>
                        <Td align="right">
                          {t.open ? (
                            <Usd value={t.unrealized} signed colored unknownHint={t.unknownCost ? 'Some units have no known cost' : 'No price now'} />
                          ) : (
                            <span className="text-xs text-fg-4">closed</span>
                          )}
                        </Td>
                        <Td align="right" mono className="hidden text-fg-2 @[52rem]:table-cell">
                          {t.avgHoldMs === null ? '—' : formatDuration(t.avgHoldMs)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              <ul className="divide-y divide-line-soft @[30rem]:hidden" aria-label="Performance by token">
                {d.tokens.slice(0, 50).map((t) => (
                  <li key={t.token} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <Link to={`/launch-radar/${encodeURIComponent(t.token)}`} className="flex min-w-0 items-center gap-2 no-underline" title={t.token}>
                      <TokenGlyph symbol={t.symbol ?? '?'} tokenId={t.token} size={20} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-fg">{t.symbol ?? t.token}</span>
                        <span className="num text-[11px] text-fg-3">
                          {t.closed} closed · {t.wins} won{t.avgHoldMs === null ? '' : ` · hold ${formatDuration(t.avgHoldMs)}`}
                        </span>
                      </span>
                    </Link>
                    <span className="flex flex-col items-end text-sm">
                      <Usd value={t.realized} signed colored />
                      {t.open && (
                        <span className="text-[11px] text-fg-3">
                          open <Usd value={t.unrealized} signed />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Latest swaps" meta={d.trades.length || undefined} />
          {d.trades.length === 0 ? <EmptyState title="No recent swap" graphic={false} compact /> : <TradeRows trades={d.trades.slice(0, 60)} label="Latest swaps" show="token" />}
        </Panel>
        <IndexNote index={d.index} />
        <Methodology title="How this wallet’s figures are made">
          <p>
            Every indexed swap of this wallet, at weighted average cost per token in USD at each swap’s own value. Realized PnL comes only from selling units it was seen buying.
          </p>
          <ul>
            <li>A sale of units with no indexed purchase (a transfer in, a buy before the index) is unmatched: it lowers coverage and is never profit.</li>
            <li>Unrealized PnL is an estimate at today’s price, for positions built from indexed buys only.</li>
            <li>Transfers aren’t indexed, so self-transfers and wallet clusters are not detected. Gas is not included.</li>
          </ul>
        </Methodology>
      </PageGrid>
    </Page>
  )
}
