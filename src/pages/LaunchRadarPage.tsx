import { RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Sparkline } from '@/components/chart/Sparkline'
import { DataTag } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Popover } from '@/components/ui/Floating'
import { Checkbox, Input, Segmented, Select, Tabs } from '@/components/ui/Form'
import { ComingSoon, Skeleton, Tag } from '@/components/ui/Indicators'
import { Price, Pct, Usd } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import type { SortDir, SortProps } from '@/components/ui/useSort'
import { IndexNote, Methodology, RiskKey, ShareBar, WatchStar } from '@/features/discovery/parts'
import { watchlist, useList } from '@/features/discovery/local'
import {
  changeFor,
  changeWindow,
  DEFAULT_WEIGHTS,
  radarItems,
  radarSummary,
  sourceLabel,
  TOP_MIN_LIQUIDITY,
  TOP_MIN_TRADES,
  volumeFor,
  type RadarItem,
  type RadarTab,
  type ScoreWeights,
} from '@/features/discovery/model'
import { useDiscoveryOn, useFollowedSignals, useLaunches, useLaunchExtras } from '@/features/discovery/queries'
import { LAUNCH_PERIODS, PERIOD_MS, type LaunchPeriod, type LaunchRow } from '@/lib/discovery/api'
import { cn } from '@/lib/cn'
import { formatAgo, formatCompact, formatDuration } from '@/lib/format'
import { useNow } from '@/lib/hooks'

/**
 * Launch Radar (DISCOVERY.md): new NEAR tokens as they launch, where from, their market, holders and
 * risk evidence, and which tracked wallets traded them. One cached list per period from NEARKITS'
 * server; tabs, filters, sorting, score weights and pages run here.
 */

const PAGE_SIZE = 50
const TABS: { value: RadarTab; label: string }[] = [
  { value: 'last', label: 'Last' },
  { value: 'best', label: 'Last Best' },
  { value: 'top', label: 'Top' },
]
const TAB_RULE: Record<RadarTab, string> = {
  last: 'Newest first, by the token’s first block.',
  best: 'Launches with an active market, by the quality score (liquidity, holders, traders, buy pressure, reputation).',
  top: `Launches with at least $${TOP_MIN_LIQUIDITY.toLocaleString('en-US')} liquidity and ${TOP_MIN_TRADES} trades in 24h, by price change over the period.`,
}
const WEIGHT_KEYS: { key: keyof ScoreWeights; label: string }[] = [
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'holders', label: 'Holders' },
  { key: 'traders', label: 'Traders (24h)' },
  { key: 'buys', label: 'Buy pressure' },
  { key: 'reputation', label: 'Reputation' },
]
const WEIGHTS_KEY = 'nearkit:discovery:weights'

type SortKey = 'age' | 'price' | 'change' | 'volume' | 'liquidity' | 'holders' | 'tracked' | 'score'

function loadWeights(): ScoreWeights {
  try {
    const raw = localStorage.getItem(WEIGHTS_KEY)
    const w = raw ? (JSON.parse(raw) as Partial<ScoreWeights>) : {}
    const out = { ...DEFAULT_WEIGHTS }
    for (const k of Object.keys(out) as (keyof ScoreWeights)[]) if (typeof w[k] === 'number' && w[k] >= 0 && w[k] <= 5) out[k] = w[k]
    return out
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

const ageOf = (r: LaunchRow, now: number) => (r.createdAt === null ? null : Math.max(0, now - r.createdAt))

function ScoreWeightsKey({ weights, onChange }: { weights: ScoreWeights; onChange: (w: ScoreWeights) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button ref={ref} size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal size={14} aria-hidden="true" /> Score weights
      </Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} label="Score weights" className="w-72 p-4">
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-fg-3">score = 100 × Σ weight × part ÷ Σ weights. Each part is 0–1 (DISCOVERY.md). Kept in this browser.</p>
          {WEIGHT_KEYS.map(({ key, label }) => (
            <label key={key} className="flex items-center justify-between gap-3 text-sm text-fg-2">
              {label}
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={weights[key]}
                aria-label={`${label} weight`}
                onChange={(e) => onChange({ ...weights, [key]: Number(e.target.value) })}
                className="w-32 accent-[var(--color-accent)]"
              />
              <span className="num w-4 text-right text-fg">{weights[key]}</span>
            </label>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...DEFAULT_WEIGHTS })}>
            Reset to 3 · 2 · 2 · 1 · 1
          </Button>
        </div>
      </Popover>
    </>
  )
}

function RowActions({ row }: { row: LaunchRow }) {
  return (
    <span className="flex items-center justify-end gap-1">
      <Link to={`/token/${encodeURIComponent(row.token)}`} className="inline-flex" aria-label={`Trade ${row.symbol ?? row.token}`}>
        <Button size="xs" variant="outline" tabIndex={-1}>
          Trade
        </Button>
      </Link>
      <WatchStar token={row.token} symbol={row.symbol} />
    </span>
  )
}

function TokenCell({ row, thumb }: { row: LaunchRow; thumb: string | null }) {
  return (
    <Link to={`/launch-radar/${encodeURIComponent(row.token)}`} className="flex min-w-0 items-center gap-2.5 no-underline">
      <TokenGlyph symbol={row.symbol ?? '?'} tokenId={row.token} icon={thumb} size={28} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-fg">{row.symbol ?? 'Unnamed'}</span>
          {row.reputation === 'Spam' && <Tag tone="warn">Spam</Tag>}
        </span>
        <span className="num truncate text-[11px] text-fg-3" title={row.token}>
          {row.token}
        </span>
      </span>
    </Link>
  )
}

export default function LaunchRadarPage() {
  const on = useDiscoveryOn()
  const now = useNow(15_000)
  const [params, setParams] = useSearchParams()
  const tab = (['last', 'best', 'top'].includes(params.get('tab') ?? '') ? params.get('tab') : 'last') as RadarTab
  const period = (LAUNCH_PERIODS.includes(params.get('period') as LaunchPeriod) ? params.get('period') : '24h') as LaunchPeriod
  const source = params.get('source') ?? 'all'
  const q = params.get('q') ?? ''
  const watchOnly = params.get('watch') === '1'
  const spam = params.get('spam') === '1'
  const update = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        for (const [k, v] of Object.entries(patch))
          if (v === null || v === '') n.delete(k)
          else n.set(k, v)
        return n
      },
      { replace: true },
    )
  const [weights, setWeightsState] = useState<ScoreWeights>(loadWeights)
  const setWeights = (w: ScoreWeights) => {
    setWeightsState(w)
    try {
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(w))
    } catch {
      // Not kept: the weights hold for this visit.
    }
  }
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [page, setPage] = useState(0)
  const watch = useList(watchlist)
  const launches = useLaunches(period)
  const followedHits = useFollowedSignals(now - PERIOD_MS[period])

  const rows = launches.data?.launches
  const items = useMemo(
    () => (rows ? radarItems(rows, { tab, source, q, spam, watchOnly, watch: new Set(watch) }, period, weights) : []),
    [rows, tab, source, q, spam, watchOnly, watch, period, weights],
  )
  const ordered = useMemo(() => {
    if (!sort) return items
    const get: Record<SortKey, (i: RadarItem) => number | null> = {
      age: (i) => ageOf(i.row, now),
      price: (i) => i.row.priceUsd,
      change: (i) => changeFor(i.row, period),
      volume: (i) => volumeFor(i.row, period),
      liquidity: (i) => i.row.liquidityUsd,
      holders: (i) => i.row.holders,
      tracked: (i) => i.row.tracked,
      score: (i) => i.score,
    }
    const f = get[sort.key]
    // Unknown figures last, whichever way.
    return [...items].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      if (x === null) return y === null ? 0 : 1
      if (y === null) return -1
      return sort.dir === 'asc' ? x - y : y - x
    })
  }, [items, sort, now, period])
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = ordered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const extras = useLaunchExtras(useMemo(() => shown.map((i) => i.row.token), [shown]))
  const summary = useMemo(() => radarSummary(rows ?? []), [rows])
  const followedByToken = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const t of followedHits.data ?? []) m.set(t.token, (m.get(t.token) ?? new Set()).add(t.trader))
    return m
  }, [followedHits.data])

  const th = (key: SortKey): SortProps => ({
    active: sort?.key === key,
    dir: sort?.key === key ? sort.dir : 'desc',
    onSort: () => {
      setPage(0)
      setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: key === 'age' ? 'asc' : 'desc' }))
    },
  })
  const win = changeWindow(period)

  const header = (
    <PageHeader
      title="Launch Radar"
      status={<DataTag />}
      description="New NEAR tokens as they launch: where they come from, their market, holders and risk evidence, and which tracked wallets traded them."
      actions={
        <Button size="sm" variant="secondary" onClick={() => void launches.refetch()} loading={launches.isFetching && !launches.isPending}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      }
    />
  )

  if (on === false)
    return (
      <Page>
        <PageHeader title="Launch Radar" status={<ComingSoon />} description="New NEAR tokens as they launch, with their market, holders and risk evidence." />
        <Panel>
          <EmptyState title="Launch Radar isn’t running on NEARKITS’ server yet">
            It lists new tokens from NEARKITS’ own index once its server runs it. Nothing here is made up meanwhile.
          </EmptyState>
        </Panel>
      </Page>
    )

  return (
    <Page>
      {header}
      <ReadoutStrip cols="grid-cols-2 xl:grid-cols-4">
        <ReadoutSlot
          legend={`Launches · ${period}`}
          loading={launches.isPending}
          value={<span className="num">{summary.launches.toLocaleString('en-US')}</span>}
          sub="Tokens whose first block is in the period"
        />
        <ReadoutSlot
          legend="With an active market"
          loading={launches.isPending}
          value={<span className="num">{summary.withMarket.toLocaleString('en-US')}</span>}
          sub={summary.launches ? `${Math.round((summary.withMarket / summary.launches) * 100)}% have a pool with liquidity` : 'A pool with liquidity'}
        />
        <ReadoutSlot
          legend="24h volume"
          loading={launches.isPending}
          value={<Usd value={summary.volume24h} compact unknownHint="No volume reported for these launches" />}
          sub="Of the period’s launches, as reported"
        />
        <ReadoutSlot
          legend="Liquidity"
          loading={launches.isPending}
          value={<Usd value={summary.liquidity} compact unknownHint="No liquidity reported for these launches" />}
          sub="In their main pools now"
        />
      </ReadoutStrip>

      <Panel>
        <PanelHeader
          title="Launches"
          meta={rows ? `${ordered.length}${ordered.length !== rows.length ? ` of ${rows.length}` : ''}` : undefined}
          actions={
            launches.data ? (
              <span className={cn('num text-xs', launches.data.stale ? 'text-warn' : 'text-fg-3')}>
                {launches.data.stale ? 'stale · ' : ''}
                {launches.data.marketAt ? formatAgo(launches.data.marketAt, now) : '—'}
              </span>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-3 border-b border-line-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Tabs
              idBase="radar"
              label="Launch Radar list"
              value={tab}
              onChange={(t) => {
                setSort(null)
                setPage(0)
                update({ tab: t === 'last' ? null : t })
              }}
              tabs={TABS}
            />
            <Segmented
              label="Period"
              size="sm"
              value={period}
              onChange={(p) => (setPage(0), update({ period: p === '24h' ? null : p }))}
              options={LAUNCH_PERIODS.map((p) => ({ value: p, label: p }))}
            />
            <Select
              selectSize="sm"
              aria-label="Launchpad or source"
              value={source}
              onChange={(e) => (setPage(0), update({ source: e.target.value === 'all' ? null : e.target.value }))}
              className="min-w-40"
            >
              <option value="all">All sources</option>
              {(launches.data?.sources ?? []).map((s) => (
                <option key={s.id ?? 'direct'} value={s.id ?? 'direct'}>
                  {sourceLabel(s)} ({s.launches})
                </option>
              ))}
            </Select>
            {tab === 'best' && <ScoreWeightsKey weights={weights} onChange={setWeights} />}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="relative w-full max-w-[340px]">
              <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
              <Input
                type="search"
                inputSize="sm"
                aria-label="Search launches"
                placeholder="Name, symbol or contract"
                value={q}
                onChange={(e) => (setPage(0), update({ q: e.target.value }))}
                className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {q && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => update({ q: null })}
                  className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-xs text-fg-3 hover:bg-raised hover:text-fg"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <Checkbox checked={watchOnly} onChange={(e) => (setPage(0), update({ watch: e.target.checked ? '1' : null }))} label={`Watchlist only (${watch.length})`} />
            <Checkbox checked={spam} onChange={(e) => (setPage(0), update({ spam: e.target.checked ? '1' : null }))} label="Show tokens marked spam" />
          </div>
          <p className="text-xs leading-5 text-fg-3">
            {TAB_RULE[tab]} Changes and volume over {win}. Trade opens the token’s page, where you review and confirm as anywhere else.
          </p>
        </div>

        {launches.isPending || on === null ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading launches">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : launches.isError && !launches.data ? (
          <LoadFailed title="Launches couldn’t be read" error={launches.error} onRetry={() => void launches.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState title={rows?.length ? 'No launch matches these filters' : `No launch in the last ${period}`} graphic={false} compact>
            {rows?.length ? 'Change the tab, source, search or watchlist filter.' : 'New tokens appear here within a minute of their first block.'}
          </EmptyState>
        ) : (
          <div className="@container">
            <div className="hidden @[52rem]:block">
              <Table label="Launches" rows="double">
                <thead>
                  <tr>
                    <Th align="right" className="w-10">
                      #
                    </Th>
                    <Th>Token</Th>
                    <Th className="hidden @[64rem]:table-cell">Source</Th>
                    <Th align="right" sort={th('age')}>
                      Age
                    </Th>
                    <Th align="right" sort={th('price')}>
                      Price
                    </Th>
                    <Th align="right" sort={th('change')}>
                      {win} %
                    </Th>
                    <Th className="hidden @[80rem]:table-cell">24h trace</Th>
                    <Th align="right" sort={th('volume')}>
                      Volume {win}
                    </Th>
                    <Th align="right" sort={th('liquidity')}>
                      Liquidity
                    </Th>
                    <Th align="right" sort={th('holders')} className="hidden @[76rem]:table-cell">
                      Holders
                    </Th>
                    <Th className="hidden @[90rem]:table-cell">Top 10</Th>
                    <Th>Risk</Th>
                    <Th align="right" sort={th('tracked')} className="hidden @[70rem]:table-cell">
                      Tracked
                    </Th>
                    {tab === 'best' && (
                      <Th align="right" sort={th('score')}>
                        Score
                      </Th>
                    )}
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i, n) => {
                    const r = i.row
                    const ex = extras.data?.[r.token]
                    const age = ageOf(r, now)
                    const followedHere = followedByToken.get(r.token)?.size ?? 0
                    return (
                      <Tr key={r.token}>
                        <Td align="right" mono className="text-fg-3">
                          {current * PAGE_SIZE + n + 1}
                        </Td>
                        <Td className="max-w-48">
                          <TokenCell row={r} thumb={ex?.thumb ?? null} />
                        </Td>
                        <Td className="hidden max-w-36 @[64rem]:table-cell">
                          <span className="flex flex-col">
                            <span className="truncate text-fg-2" title={r.source.id ?? undefined}>
                              {sourceLabel(r.source)}
                            </span>
                            <span className="text-[11px] text-fg-3">{r.venue ?? 'No pool yet'}</span>
                          </span>
                        </Td>
                        <Td align="right" mono className="text-fg-2">
                          {age === null ? '—' : formatDuration(age)}
                        </Td>
                        <Td align="right">
                          <Price value={r.priceUsd} unknownHint="No price reported yet" />
                        </Td>
                        <Td align="right">
                          <Pct value={changeFor(r, period)} unknownHint={`No ${win} change reported (too new, or no trades)`} />
                        </Td>
                        <Td className="hidden @[80rem]:table-cell">
                          {ex?.spark ? <Sparkline values={ex.spark} width={88} height={26} /> : <span className="num text-xs text-fg-4">—</span>}
                        </Td>
                        <Td align="right">
                          <Usd value={volumeFor(r, period)} compact />
                        </Td>
                        <Td align="right">
                          <Usd value={r.liquidityUsd} compact />
                        </Td>
                        <Td align="right" mono className="hidden text-fg-2 @[76rem]:table-cell">
                          {r.holders === null ? '—' : formatCompact(r.holders, 1)}
                        </Td>
                        <Td className="hidden @[90rem]:table-cell">
                          <ShareBar share={r.top10Share} />
                        </Td>
                        <Td>
                          <RiskKey row={r} />
                        </Td>
                        <Td align="right" className="hidden @[70rem]:table-cell">
                          <span className="num text-xs text-fg-2" title="Distinct tracked wallets (qualified over 30 days) that traded it in the period; yours after the plus">
                            {r.tracked || '—'}
                            {followedHere > 0 && <span className="text-accent"> +{followedHere}</span>}
                          </span>
                        </Td>
                        {tab === 'best' && (
                          <Td align="right" mono className="text-fg">
                            {i.score === null ? '—' : i.score.toFixed(0)}
                          </Td>
                        )}
                        <Td align="right">
                          <RowActions row={r} />
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </div>
            <ul className="divide-y divide-line-soft @[52rem]:hidden" aria-label="Launches">
              {shown.map((i) => {
                const r = i.row
                const age = ageOf(r, now)
                return (
                  <li key={r.token} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <TokenCell row={r} thumb={extras.data?.[r.token]?.thumb ?? null} />
                      <RowActions row={r} />
                    </div>
                    <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
                      <div className="flex flex-col">
                        <dt className="legend">Price</dt>
                        <dd>
                          <Price value={r.priceUsd} />
                        </dd>
                      </div>
                      <div className="flex flex-col">
                        <dt className="legend">{win}</dt>
                        <dd>
                          <Pct value={changeFor(r, period)} />
                        </dd>
                      </div>
                      <div className="flex flex-col">
                        <dt className="legend">Age</dt>
                        <dd className="num text-fg-2">{age === null ? '—' : formatDuration(age)}</dd>
                      </div>
                      <div className="flex flex-col">
                        <dt className="legend">Volume</dt>
                        <dd>
                          <Usd value={volumeFor(r, period)} compact />
                        </dd>
                      </div>
                      <div className="flex flex-col">
                        <dt className="legend">Liquidity</dt>
                        <dd>
                          <Usd value={r.liquidityUsd} compact />
                        </dd>
                      </div>
                      <div className="flex flex-col">
                        <dt className="legend">Risk</dt>
                        <dd>
                          <RiskKey row={r} />
                        </dd>
                      </div>
                    </dl>
                    <p className="text-[11px] text-fg-3">
                      {sourceLabel(r.source)} · {r.venue ?? 'no pool yet'}
                      {r.tracked > 0 && ` · ${r.tracked} tracked wallet${r.tracked === 1 ? '' : 's'}`}
                      {tab === 'best' && i.score !== null && ` · score ${i.score.toFixed(0)}`}
                    </p>
                  </li>
                )
              })}
            </ul>
            {pages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5">
                <span className="num text-xs text-fg-3">
                  {current * PAGE_SIZE + 1}–{Math.min(ordered.length, (current + 1) * PAGE_SIZE)} of {ordered.length}
                </span>
                <span className="flex gap-2">
                  <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                    Next
                  </Button>
                </span>
              </div>
            )}
          </div>
        )}
      </Panel>

      {launches.data && <IndexNote index={launches.data.index} />}

      <Methodology>
        <p>
          A launch is a NEP-141 token whose first block falls in the period. Its source is the account that created the token account (only <span className="num">x.near</span> can
          create <span className="num">token.x.near</span>): a known launchpad by name, any other token factory with a contract and 3 or more tokens by its account, otherwise
          Direct with its first pool’s venue.
        </p>
        <ul>
          <li>
            Market figures (price, changes, volume, liquidity, buys and sells, traders, holders, reputation) come from Intear’s free API, read once a minute by NEARKITS’ server for
            everyone.
          </li>
          <li>
            Last Best’s score is 100 × Σ weight × part ÷ Σ weights; parts: liquidity (log scale to $50,000), holders (to 1,000), 24h traders (to 200), buy share of 24h trades (0.5
            under 5 trades), reputation. Default weights 3 · 2 · 2 · 1 · 1.
          </li>
          <li>Top: launches with at least $1,000 liquidity and 10 trades in 24h, by price change over the period’s window.</li>
          <li>Risk flags each name their evidence; pools, the launchpad and the token contract are left out of holder concentration. No flag is not “safe”.</li>
          <li>
            Tracked: distinct wallets qualified over 30 days on Top Wallets that traded the token in the period, each with its transaction on the token’s page; yours (followed
            wallets) after the plus.
          </li>
        </ul>
        <p className="text-xs text-fg-3">Data: Intear (api.intea.rs). Nothing here is advice or a prediction.</p>
      </Methodology>
    </Page>
  )
}
