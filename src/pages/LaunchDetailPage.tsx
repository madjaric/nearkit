import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { CandleChart } from '@/components/chart/CandleChart'
import { DataTag } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, Page, PageGrid, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Price, Pct, Usd } from '@/components/ui/Num'
import { Line, Lines, Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { AccountRef, IndexNote, ShareBar, TradeRows, TxRef, WatchStar } from '@/features/discovery/parts'
import { riskFlags, sourceLabel } from '@/features/discovery/model'
import { useFollowedSignals, useLaunch } from '@/features/discovery/queries'
import type { LaunchDetail } from '@/lib/discovery/api'
import { cn } from '@/lib/cn'
import { formatAgo, formatCompact, formatDateTime, formatDuration, formatUsdPrice } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { explorerTokenUrl } from '@/services/near/explorer'
import { useCapabilities } from '@/services/queries'
import type { Candle } from '@/types/domain'

/**
 * A launch on Launch Radar (DISCOVERY.md): what is verified on chain, what Intear reports, what NEARKITS
 * observed; its hourly chart, holders, risk evidence, latest swaps and tracked wallets' transactions.
 */

function Kind({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
  return <Tag tone={tone}>{children}</Tag>
}

function axis(spanMs: number) {
  const day = spanMs > 36 * 3_600_000
  return (t: number) => {
    const d = new Date(t)
    return day ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
}

function Chart({ d, now }: { d: LaunchDetail; now: number }) {
  const candles = useMemo<Candle[]>(() => {
    const c = d.candles
    if (!c) return []
    const out: Candle[] = []
    c.time.forEach((t, i) => {
      const [o, h, l, cl] = [c.open[i], c.high[i], c.low[i], c.close[i]]
      if (o == null || h == null || l == null || cl == null) return
      out.push({ t, o, h, l, c: cl, v: c.volume[i] ?? null })
    })
    return out
  }, [d.candles])
  if (candles.length < 2)
    return (
      <EmptyState title="Not enough trading yet for a chart" graphic={false} compact>
        Hourly candles appear once the token has traded in at least two hours.
      </EmptyState>
    )
  const start = (candles[0] as Candle).t
  return (
    <div className="p-3">
      <CandleChart
        candles={candles}
        start={start}
        end={now}
        candleSec={3_600}
        live={d.launch.priceUsd}
        label={`${d.launch.symbol ?? d.launch.token} price in USD, hourly`}
        formatPrice={formatUsdPrice}
        formatTime={formatDateTime}
        formatAxis={axis(now - start)}
        formatVolume={(v) => `$${formatCompact(v, 1)}`}
        height={300}
      />
    </div>
  )
}

export default function LaunchDetailPage() {
  const id = decodeURIComponent(useParams().id ?? '')
  const caps = useCapabilities()
  const now = useNow(15_000)
  const q = useLaunch(id)
  const followedHits = useFollowedSignals(0)
  const d = q.data
  const l = d?.launch
  const mine = (followedHits.data ?? []).filter((t) => t.token === id)

  if (q.isPending)
    return (
      <Page>
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the launch">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </Page>
    )
  if (q.isError || !d || !l)
    return (
      <Page>
        <PageHeader title="Launch" description={id} />
        <Panel>
          <LoadFailed title="This launch couldn’t be read" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      </Page>
    )
  const flags = riskFlags(l)
  const age = l.createdAt === null ? null : now - l.createdAt
  const tradeLink = (
    <Link to={`/token/${encodeURIComponent(l.token)}`} className="inline-flex">
      <Button variant="primary" tabIndex={-1}>
        Trade {l.symbol ?? ''}
      </Button>
    </Link>
  )
  return (
    <Page>
      <Link to="/launch-radar" className="inline-flex w-fit items-center gap-1.5 text-xs text-fg-3 no-underline hover:text-fg">
        <ArrowLeft size={13} aria-hidden="true" /> Launch Radar
      </Link>
      <PageHeader
        title={l.symbol ?? l.token}
        status={<DataTag />}
        description={`${l.name ?? 'Unnamed token'} · ${l.token}`}
        actions={
          <span className="flex items-center gap-2">
            <WatchStar token={l.token} symbol={l.symbol} />
            {tradeLink}
          </span>
        }
      />
      <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <ReadoutSlot legend="Price" value={<Price value={l.priceUsd} />} sub="USD, as reported" aside={<TokenGlyph symbol={l.symbol ?? '?'} tokenId={l.token} size={20} />} />
        <ReadoutSlot legend="1h" value={<Pct value={l.priceChange1h} />} sub="Price change" />
        <ReadoutSlot legend="24h" value={<Pct value={l.priceChange24h} />} sub={age !== null && age < 86_400_000 ? 'Younger than 24h' : 'Price change'} />
        <ReadoutSlot legend="Liquidity" value={<Usd value={l.liquidityUsd} compact />} sub={l.venue ?? 'No pool yet'} />
        <ReadoutSlot legend="Volume 24h" value={<Usd value={l.volume24h} compact />} sub={l.buys24h === null ? '—' : `${l.buys24h} buys · ${l.sells24h ?? 0} sells`} />
        <ReadoutSlot
          legend="Holders"
          value={<span className="num">{l.holders === null ? '—' : l.holders.toLocaleString('en-US')}</span>}
          sub={age === null ? '—' : `Age ${formatDuration(age)}`}
        />
      </ReadoutStrip>

      <PageGrid
        asideWidth={380}
        aside={
          <>
            <Panel>
              <PanelHeader title="Launch facts" />
              <div className="flex flex-col gap-3 p-4">
                <Lines>
                  <Line label="Token account">
                    <AccountRef account={l.token} max={26} />
                  </Line>
                  <Line label="First block">
                    <span className="num">{l.createdHeight === null ? '—' : `#${l.createdHeight.toLocaleString('en-US')}`}</span>
                  </Line>
                  <Line label="Created">{l.createdAt === null ? '—' : formatDateTime(l.createdAt)}</Line>
                  <Line label="Created by">{l.source.id ? <AccountRef account={l.source.id} max={22} /> : <span className="text-fg-3">Not a sub-account</span>}</Line>
                  <Line label="Source">{sourceLabel(l.source)}</Line>
                  <Line label="Deployed by">{l.dev ? <AccountRef account={l.dev} max={22} /> : '—'}</Line>
                  <Line label="First seen by NEARKITS">{formatDateTime(l.firstSeenAt)}</Line>
                  <Line label="Main pool">
                    {l.mainPoolUrl ? (
                      <a href={l.mainPoolUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-fg-2 hover:text-fg">
                        {l.venue ?? 'Pool'} <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    ) : (
                      (l.venue ?? '—')
                    )}
                  </Line>
                </Lines>
                <div className="flex flex-wrap gap-1.5">
                  <Kind tone="accent">Verified on chain: token account, parent account</Kind>
                  <Kind>Reported by Intear: first block, deployer, market, holders</Kind>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  {caps.explorerUrl && (
                    <a
                      href={explorerTokenUrl({ explorerUrl: caps.explorerUrl }, l.token)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-fg-2 hover:text-fg"
                    >
                      Explorer <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  )}
                  <Link to={`/token/${encodeURIComponent(l.token)}`} className="text-fg-2 hover:text-fg">
                    Token page
                  </Link>
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Risk evidence" meta={flags.length || undefined} />
              <div className="flex flex-col gap-2 p-4 text-sm">
                {flags.length === 0 ? (
                  <p className="text-fg-3">No flag raised by the data NEARKITS has. Absent data is not a pass, and no flag is not “safe”.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {flags.map((f) => (
                      <li key={f.key} className="flex flex-col gap-0.5">
                        <span className="font-medium text-warn">{f.label}</span>
                        <span className="text-xs leading-5 text-fg-2">{f.evidence}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>

            <Panel>
              <PanelHeader
                title="Holders"
                meta={d.holders?.total ?? undefined}
                actions={d.holders ? <span className="num text-xs text-fg-3">{formatAgo(d.holders.at, now)}</span> : undefined}
              />
              {d.holders && d.holders.top.length ? (
                <div className="flex flex-col gap-2.5 p-4">
                  {d.holders.top.map((h, i) => (
                    <div key={h.account} className="grid grid-cols-[1.5rem_minmax(0,1fr)_5rem] items-center gap-2 text-xs">
                      <span className="num text-fg-4">{i + 1}</span>
                      <span className={cn('num truncate', h.account === l.dev ? 'text-warn' : 'text-fg-2')} title={h.account}>
                        {h.account}
                        {h.account === l.dev && ' (deployer)'}
                      </span>
                      <ShareBar share={h.share} />
                    </div>
                  ))}
                  <p className="text-[11px] leading-4 text-fg-3">
                    Share of supply. Left out as infrastructure: {d.holders.excluded.length ? d.holders.excluded.join(', ') : 'none among the largest holders'}.
                  </p>
                </div>
              ) : (
                <EmptyState title="Holder distribution not read yet" graphic={false} compact>
                  It is read for launches with a market.
                </EmptyState>
              )}
            </Panel>
          </>
        }
      >
        <Panel>
          <PanelHeader title="Price · hourly" actions={<span className="text-xs text-fg-3">USD, Intear candles</span>} />
          <Chart d={d} now={now} />
        </Panel>

        <Panel>
          <PanelHeader title="Tracked wallets" meta={d.signals.length || undefined} />
          {d.signals.length === 0 && mine.length === 0 ? (
            <EmptyState title="No tracked wallet traded it yet" graphic={false} compact>
              Tracked wallets are the ones qualified over 30 days on Top Wallets, and the ones you follow.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line-soft">
              {d.signals.map((s) => (
                <li key={s.trader} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link to={`/top-wallets/${encodeURIComponent(s.trader)}`} className="num truncate text-sm text-fg hover:underline" title={s.trader}>
                        {s.trader}
                      </Link>
                      {s.smart && <Tag tone="accent">Smart Money</Tag>}
                      {s.qualified && !s.smart && <Tag tone="neutral">Qualified</Tag>}
                    </span>
                    {s.stats30d && (
                      <span className="flex flex-wrap items-center gap-3 text-xs text-fg-3">
                        <span>
                          30D <Usd value={s.stats30d.realized} signed colored compact />
                        </span>
                        <span>win {s.stats30d.winRate === null ? '—' : `${Math.round(s.stats30d.winRate * 100)}%`}</span>
                        <span>{s.stats30d.closed} closed</span>
                        <span>coverage {s.stats30d.coverage === null ? '—' : `${Math.round(s.stats30d.coverage * 100)}%`}</span>
                      </span>
                    )}
                  </div>
                  <ul className="flex flex-wrap gap-x-4 gap-y-1">
                    {s.trades.map((t) => (
                      <li key={t.tx + t.side} className="flex items-center gap-2 text-xs">
                        <Tag tone={t.side === 'buy' ? 'accent' : 'neg'}>{t.side}</Tag>
                        <Usd value={t.usd} />
                        <span className="num text-fg-3">{formatDateTime(t.ts)}</span>
                        <TxRef hash={t.tx} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {mine.map((t) => (
                <li key={t.tx + t.trader} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs">
                  <Tag tone="neutral">You follow</Tag>
                  <Link to={`/top-wallets/${encodeURIComponent(t.trader)}`} className="num text-fg hover:underline">
                    {t.trader}
                  </Link>
                  <Tag tone={t.side === 'buy' ? 'accent' : 'neg'}>{t.side}</Tag>
                  <Usd value={t.usd} />
                  <span className="num text-fg-3">{formatDateTime(t.ts)}</span>
                  <TxRef hash={t.tx} />
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line-soft px-4 py-2.5 text-[11px] leading-4 text-fg-3">
            Evidence, not a signal: each line is a verified swap with its transaction. Past results don’t predict this token.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Latest swaps" actions={d.tradesAt ? <span className="num text-xs text-fg-3">{formatAgo(d.tradesAt, now)}</span> : undefined} />
          {d.trades.length === 0 ? (
            <EmptyState title="No swaps reported yet" graphic={false} compact>
              Swaps appear here as the token trades.
            </EmptyState>
          ) : (
            <TradeRows trades={d.trades} label={`Latest swaps in ${l.symbol ?? l.token}`} show="wallet" />
          )}
        </Panel>
        <IndexNote index={d.index} />
      </PageGrid>
    </Page>
  )
}
