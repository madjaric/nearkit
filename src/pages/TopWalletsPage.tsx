import { Bot, Search, X } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DataTag } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tip } from '@/components/ui/Floating'
import { Checkbox, Input, Segmented, Select, Tabs } from '@/components/ui/Form'
import { ComingSoon, Skeleton, Tag } from '@/components/ui/Indicators'
import { Pct, Usd } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { AccountRef, FollowButton, IndexNote, Methodology, ShareBar } from '@/features/discovery/parts'
import { CATEGORY_LABEL, CATEGORY_RULE, METRIC_LABEL, REASON_TEXT, WINDOW_LABEL, windowCoverage, type WindowCoverage } from '@/features/discovery/model'
import { useDiscoveryOn, useFollowed, useWallets } from '@/features/discovery/queries'
import { WALLET_WINDOWS, type WalletCategory, type WalletMetric, type WalletRow, type WalletWindowKey } from '@/lib/discovery/api'
import { formatAgo, formatUsdCompact } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { isValidAccountId } from '@/lib/validation'

/**
 * Top Wallets (DISCOVERY.md): NEAR wallets ranked by verifiable trading performance, realized PnL from
 * indexed swaps at average cost, with each wallet's coverage, and the method on the page.
 */

const CATEGORIES: WalletCategory[] = ['all', 'smart', 'traders', 'early', 'fresh']
const METRICS: WalletMetric[] = ['pnl', 'return', 'winrate', 'activity']

function WalletTags({ row }: { row: WalletRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.categories.includes('smart') && <Tag tone="accent">Smart Money</Tag>}
      {row.automated && (
        <Tip content="Over 300 swap legs on a single day: automated trading. Kept out of the curated categories." focusable>
          <Tag tone="neutral">
            <Bot size={11} aria-hidden="true" /> Automated
          </Tag>
        </Tip>
      )}
      {!row.qualified && (
        <Tip content={`Not ranked by PnL: ${row.reasons.map((r) => REASON_TEXT[r]).join('; ')}.`} focusable>
          <Tag tone="warn">Not qualified</Tag>
        </Tip>
      )}
    </span>
  )
}

const COVER_TEXT: Readonly<Record<WindowCoverage['state'], string>> = {
  full: 'Full window indexed',
  'catching-up': 'Partial: the index is still catching up on history',
  young: 'Partial: the index is younger than the window',
}

function TopTokens({ row }: { row: WalletRow }) {
  if (row.topTokens.length === 0) return <span className="num text-xs text-fg-4">—</span>
  return (
    <span className="flex items-center gap-1.5">
      {row.topTokens.map((t) => (
        <Link key={t.token} to={`/launch-radar/${encodeURIComponent(t.token)}`} title={t.token} className="flex items-center gap-1 text-xs text-fg-2 no-underline hover:text-fg">
          <TokenGlyph symbol={t.symbol ?? '?'} tokenId={t.token} size={18} />
          <span className="max-w-16 truncate">{t.symbol ?? t.token}</span>
        </Link>
      ))}
    </span>
  )
}

function LastActivity({ row, now }: { row: WalletRow; now: number }) {
  if (!row.last) return <span className="num text-xs text-fg-4">—</span>
  return (
    <span className="flex flex-col text-xs">
      <span className="text-fg-2">
        {row.last.side === 'buy' ? 'Bought' : 'Sold'} {row.last.symbol ?? row.last.token}
        {row.last.usd !== null && <> · {formatUsdCompact(row.last.usd)}</>}
      </span>
      <span className="num text-fg-3">{formatAgo(row.last.ts, now)}</span>
    </span>
  )
}

export default function TopWalletsPage() {
  const on = useDiscoveryOn()
  const now = useNow(15_000)
  const [params, setParams] = useSearchParams()
  const range = (WALLET_WINDOWS.includes(params.get('window') as WalletWindowKey) ? params.get('window') : 'all') as WalletWindowKey
  const category = (CATEGORIES.includes(params.get('category') as WalletCategory) ? params.get('category') : 'all') as WalletCategory
  const metric = (METRICS.includes(params.get('metric') as WalletMetric) ? params.get('metric') : 'pnl') as WalletMetric
  const search = params.get('q') ?? ''
  const followedOnly = params.get('followed') === '1'
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
  const q = useWallets({ window: range, metric, category, search })
  const followed = useFollowed()
  const data = q.data
  const rows = useMemo(() => (data ? (followedOnly ? data.rows.filter((r) => followed.isFollowed(r.trader)) : data.rows) : []), [data, followedOnly, followed])
  const searchAccount = search.trim().toLowerCase()
  const openable = searchAccount && isValidAccountId(searchAccount) && !rows.some((r) => r.trader === searchAccount) ? searchAccount : null
  const cover = data ? windowCoverage(range, data.index, data.asOf) : null

  if (on === false)
    return (
      <Page>
        <PageHeader title="Top Wallets" status={<ComingSoon />} description="NEAR wallets ranked by verifiable trading performance." />
        <Panel>
          <EmptyState title="Top Wallets isn’t running on NEARKITS’ server yet">
            It ranks wallets from NEARKITS’ own swap index once its server runs it. Nothing here is made up meanwhile.
          </EmptyState>
        </Panel>
      </Page>
    )

  return (
    <Page>
      <PageHeader
        title="Top Wallets"
        status={<DataTag />}
        description="NEAR wallets ranked by verifiable trading performance: realized PnL from indexed swaps at average cost, with each wallet’s coverage. Follow a wallet to see what it buys."
      />
      <ReadoutStrip cols="grid-cols-2 xl:grid-cols-4">
        <ReadoutSlot
          legend="Wallets in the window"
          loading={q.isPending}
          value={<span className="num">{data ? data.counts.wallets.toLocaleString('en-US') : '—'}</span>}
          sub="With a closed trade or $100+ traded"
        />
        <ReadoutSlot
          legend="Qualified"
          loading={q.isPending}
          value={<span className="num">{data ? data.counts.qualified.toLocaleString('en-US') : '—'}</span>}
          sub="Enough trades, tokens, coverage and history"
        />
        <ReadoutSlot
          legend="Window covered"
          loading={q.isPending}
          value={<span className="num">{cover ? (cover.days === null ? `${cover.covered}d` : `${cover.covered}/${cover.days}d`) : '—'}</span>}
          sub={cover ? COVER_TEXT[cover.state] : '—'}
        />
        <ReadoutSlot
          legend="Indexed to"
          loading={q.isPending}
          value={<span className="num">{data?.index.tradesTo ? formatAgo(data.index.tradesTo, now) : '—'}</span>}
          sub={data ? (data.index.backfilling ? 'Catching up on history' : data.index.stale ? 'Behind: figures may lag' : 'Live') : '—'}
        />
      </ReadoutStrip>

      <Panel>
        <PanelHeader
          title={WINDOW_LABEL[range]}
          meta={data ? rows.length : undefined}
          actions={data ? <span className="num text-xs text-fg-3">{formatAgo(data.asOf, now)}</span> : undefined}
        />
        <div className="flex flex-col gap-3 border-b border-line-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Tabs
              idBase="wallets"
              label="Window"
              value={range}
              onChange={(w) => update({ window: w === 'all' ? null : w })}
              tabs={WALLET_WINDOWS.map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
            />
            <Select selectSize="sm" aria-label="Rank by" value={metric} onChange={(e) => update({ metric: e.target.value === 'pnl' ? null : e.target.value })} className="min-w-44">
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  Rank by {METRIC_LABEL[m]}
                </option>
              ))}
            </Select>
          </div>
          <div className="hidden sm:block">
            <Segmented
              label="Category"
              size="sm"
              value={category}
              onChange={(c) => update({ category: c === 'all' ? null : c })}
              options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c], disabled: c === 'fresh' && data !== undefined && !data.freshAvailable }))}
            />
          </div>
          <Select
            selectSize="sm"
            aria-label="Category"
            value={category}
            onChange={(e) => update({ category: e.target.value === 'all' ? null : e.target.value })}
            className="sm:hidden"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c} disabled={c === 'fresh' && data !== undefined && !data.freshAvailable}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="relative w-full max-w-[340px]">
              <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
              <Input
                type="search"
                inputSize="sm"
                aria-label="Search wallets"
                placeholder="Wallet account"
                value={search}
                onChange={(e) => update({ q: e.target.value })}
                className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {search && (
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
            <Checkbox checked={followedOnly} onChange={(e) => update({ followed: e.target.checked ? '1' : null })} label={`Followed only (${followed.accounts.length})`} />
          </div>
          <p className="text-xs leading-5 text-fg-3">
            {CATEGORY_RULE[category]}{' '}
            {metric === 'activity' ? 'Activity ranks every wallet by volume traded and says nothing about profit.' : 'PnL, return and win rate rank qualified wallets only.'}
          </p>
        </div>

        {q.isPending || on === null ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading wallets">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : q.isError && !data ? (
          <LoadFailed title="The ranking couldn’t be read" error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={followedOnly ? 'No followed wallet in this ranking' : 'No wallet qualifies here yet'}
            graphic={false}
            compact
            action={
              openable ? (
                <Link to={`/top-wallets/${encodeURIComponent(openable)}`} className="inline-flex">
                  <Button size="sm" variant="secondary" tabIndex={-1}>
                    Open {openable}
                  </Button>
                </Link>
              ) : undefined
            }
          >
            {followedOnly ? 'Followed wallets that don’t qualify are still on their own pages.' : 'Try another window, category or ranking, or rank by activity.'}
          </EmptyState>
        ) : (
          <div className="@container">
            <div className="hidden @[56rem]:block">
              <Table label={`Top wallets, ${WINDOW_LABEL[range]}`} rows="double" minWidth={860}>
                <thead>
                  <tr>
                    <Th align="right" className="w-10">
                      #
                    </Th>
                    <Th>Wallet</Th>
                    <Th align="right">Realized PnL</Th>
                    <Th align="right">Return</Th>
                    <Th>Win rate</Th>
                    <Th align="right">Closed</Th>
                    <Th className="hidden @[76rem]:table-cell">Most traded</Th>
                    <Th className="hidden @[66rem]:table-cell">Latest</Th>
                    <Th align="right" className="hidden @[66rem]:table-cell">
                      Coverage
                    </Th>
                    {metric === 'activity' && <Th align="right">Volume</Th>}
                    <Th align="right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.trader}>
                      <Td align="right" mono className="text-fg-3">
                        {r.rank}
                      </Td>
                      <Td className="max-w-72">
                        <span className="flex min-w-0 flex-col gap-1">
                          <AccountRef account={r.trader} max={24}>
                            <Link to={`/top-wallets/${encodeURIComponent(r.trader)}`} className="num truncate text-fg hover:underline" title={r.trader}>
                              {r.trader.length > 24 ? `${r.trader.slice(0, 10)}…${r.trader.slice(-8)}` : r.trader}
                            </Link>
                          </AccountRef>
                          <WalletTags row={r} />
                        </span>
                      </Td>
                      <Td align="right">
                        <Usd value={r.realized} signed colored />
                      </Td>
                      <Td align="right">
                        <Pct value={r.returnPct} />
                      </Td>
                      <Td>
                        <ShareBar share={r.winRate} className="w-24" warnAbove={null} />
                      </Td>
                      <Td align="right" mono className="text-fg-2">
                        {r.closed}
                      </Td>
                      <Td className="hidden @[76rem]:table-cell">
                        <TopTokens row={r} />
                      </Td>
                      <Td className="hidden @[66rem]:table-cell">
                        <LastActivity row={r} now={now} />
                      </Td>
                      <Td align="right" mono className="hidden text-xs text-fg-2 @[66rem]:table-cell">
                        {r.coverage === null ? '—' : `${Math.round(r.coverage * 100)}%`}
                      </Td>
                      {metric === 'activity' && (
                        <Td align="right">
                          <Usd value={r.buyUsd + r.sellUsd} compact />
                        </Td>
                      )}
                      <Td align="right">
                        <span className="flex items-center justify-end gap-1.5">
                          <FollowButton account={r.trader} size="xs" />
                          <Link to={`/top-wallets/${encodeURIComponent(r.trader)}`} className="inline-flex">
                            <Button size="xs" variant="ghost" tabIndex={-1}>
                              Open
                            </Button>
                          </Link>
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <ul className="divide-y divide-line-soft @[56rem]:hidden" aria-label={`Top wallets, ${WINDOW_LABEL[range]}`}>
              {rows.map((r) => (
                <li key={r.trader} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="num text-xs text-fg-3">#{r.rank}</span>
                        <Link to={`/top-wallets/${encodeURIComponent(r.trader)}`} className="num truncate text-sm text-fg hover:underline" title={r.trader}>
                          {r.trader.length > 26 ? `${r.trader.slice(0, 10)}…${r.trader.slice(-8)}` : r.trader}
                        </Link>
                      </span>
                      <WalletTags row={r} />
                    </span>
                    <FollowButton account={r.trader} size="xs" />
                  </div>
                  <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
                    <div className="flex flex-col">
                      <dt className="legend">Realized</dt>
                      <dd>
                        <Usd value={r.realized} signed colored compact />
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="legend">Return</dt>
                      <dd>
                        <Pct value={r.returnPct} />
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="legend">Win rate</dt>
                      <dd className="num text-fg-2">{r.winRate === null ? '—' : `${Math.round(r.winRate * 100)}%`}</dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="legend">Closed</dt>
                      <dd className="num text-fg-2">{r.closed}</dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="legend">Coverage</dt>
                      <dd className="num text-fg-2">{r.coverage === null ? '—' : `${Math.round(r.coverage * 100)}%`}</dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="legend">Latest</dt>
                      <dd className="num text-fg-2">{r.last ? formatAgo(r.last.ts, now) : '—'}</dd>
                    </div>
                  </dl>
                  <TopTokens row={r} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {data && <IndexNote index={data.index} />}

      <Methodology>
        <p>
          Every swap on NEAR’s indexed venues (Rhea DCL, Ref v1, the Rhea router’s legs, Intear, Aidols) is applied per wallet and token at weighted average cost, in USD at each
          swap’s own value. NEAR and USD stablecoins are the money; a route through an intermediate token counts as one sale and one purchase.
        </p>
        <ul>
          <li>
            Realized PnL comes only from selling units the wallet was seen buying. A sale of units with no indexed purchase (a transfer in, a buy before the index) is unmatched and
            never profit.
          </li>
          <li>Return = realized PnL ÷ the cost of the units sold. Win rate = winning closed trades ÷ closed trades. Coverage = matched sale value ÷ all sale value.</li>
          <li>
            Qualified for a PnL ranking: at least 5 (7D), 10 (30D) or 15 (90D, Top 100) closed trades, sales in 2+ tokens, coverage of 80% or more, and 2+ days between the first
            and last indexed swap. Others appear only in the activity ranking.
          </li>
          <li>Automated: more than 300 swap legs on one day; flagged and kept out of Smart Money, Traders, Early Buyers and Fresh Wallets.</li>
          <li>
            Each swap belongs to one wallet (its signer) and is applied once, so nothing is counted twice. Transfers aren’t indexed, so wallet clusters and self-transfers are not
            detected.
          </li>
          <li>Gas is not included; pool fees and token taxes are inside the traded amounts. Unrealized PnL on a wallet’s page is an estimate at today’s price.</li>
        </ul>
        <p className="text-xs text-fg-3">History starts on 2026-09-18 (Intear’s trade index); longer windows fill in as the index ages. Data: Intear (api.intea.rs). Not advice.</p>
      </Methodology>
    </Page>
  )
}
