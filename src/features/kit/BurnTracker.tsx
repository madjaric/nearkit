import { ExternalLink } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { KIT, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime, formatUsd, truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import type { KitsBurn } from '@/services/kitsBurns'
import { explorerTxUrl } from '@/services/near/explorer'
import { BurnChart } from './BurnChart'
import { burnSeries } from './burnSeries'
import { burnFigures, type BurnTrackerState } from './buyback'

/**
 * $KITS' Buyback & Burn: the page's analytics centrepiece. The headline figures (KITS burned, their
 * share of the launch supply, the burn transactions, the last burn, the supply now) beside a chart of
 * KITS burned over time drawn from the verified burns alone, then the register of recent burns, each
 * linked to its transaction. Live figures come only from NEARKITS' server's reading of NEAR mainnet
 * (useBurnTracker); without one the section keeps its shape, with "—" and a plain reason.
 */

const SHOWN = 5

const STATUS: Record<BurnTrackerState['state'], { label: string; tone: 'on' | 'off' | 'warn' | 'idle'; tag: 'accent' | 'neutral' }> = {
  live: { label: 'Live', tone: 'on', tag: 'accent' },
  loading: { label: 'Reading', tone: 'idle', tag: 'neutral' },
  unavailable: { label: 'Awaiting data', tone: 'warn', tag: 'neutral' },
  'no-source': { label: 'Not read here', tone: 'off', tag: 'neutral' },
  'not-on-network': { label: 'Mainnet only', tone: 'off', tag: 'neutral' },
}

const ghost = (text = '—') => <span className="text-fg-4">{text}</span>

/** Why a section without a reading has no figure, in a sentence. */
function reasonOf(tracker: BurnTrackerState): string {
  switch (tracker.state) {
    case 'not-on-network':
      return `${KIT.ticker} trades on NEAR mainnet: its burns are tracked there, not in this build.`
    case 'no-source':
      return tracker.reason === 'demo'
        ? `This preview reads nothing from NEAR. On nearkits.com, ${KIT.ticker}’ burns are read live from ${KITS_CONTRACT}.`
        : `This build isn’t connected to NEARKITS’ server, which reads ${KIT.ticker}’ burns from NEAR.`
    case 'unavailable':
      return `NEARKITS can’t read ${KIT.ticker}’ burns from NEAR right now. It asks again every minute; no figure is shown until it has one.`
    default:
      return `Reading ${KIT.ticker}’ burns from NEAR…`
  }
}

function TxLink({ tx }: { tx: string }) {
  return (
    <a
      href={explorerTxUrl(NETWORKS.mainnet, tx)}
      target="_blank"
      rel="noreferrer noopener"
      className="num inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
      aria-label={`Burn transaction ${tx} on NearBlocks`}
    >
      {truncateMiddle(tx, 6, 4)}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

const SOURCE: Record<KitsBurn['kind'], string> = { tax: 'Tax · Buyback & Burn', other: 'Burn' }

function Confirmed() {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-2">
      <Led tone="on" /> Confirmed
    </span>
  )
}

function RecentBurns({ burns, decimals, total }: { burns: KitsBurn[]; decimals: number; total: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? burns : burns.slice(0, SHOWN)
  const amount = (b: KitsBurn) => formatUnits(BigInt(b.amount), decimals, { maxFraction: 2, group: true })
  if (!shown.length) return <p className="px-4 pb-4 pt-2 text-sm text-fg-3">No burn transaction has been verified yet.</p>
  return (
    <>
      <ul className="divide-y divide-line-soft md:hidden" aria-label="Recent burns">
        {shown.map((b) => (
          <li key={b.tx} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="num text-sm text-fg">
                {amount(b)} <span className="font-sans text-xs text-fg-3">KITS</span>
              </span>
              <span className="truncate text-[11px] text-fg-3">
                {formatDateTime(b.at)} · {SOURCE[b.kind]}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
              <TxLink tx={b.tx} />
              <Confirmed />
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table label="Recent burns" minWidth={640}>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th align="right">Amount burned</Th>
              <Th>Source</Th>
              <Th>Transaction</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <Tr key={b.tx}>
                <Td className="text-xs text-fg-2">{formatDateTime(b.at)}</Td>
                <Td align="right" mono className="text-fg">
                  {amount(b)} <span className="font-sans text-xs text-fg-3">KITS</span>
                </Td>
                <Td className="text-xs text-fg-2">{SOURCE[b.kind]}</Td>
                <Td className="text-xs">
                  <TxLink tx={b.tx} />
                </Td>
                <Td align="right" className="text-xs">
                  <Confirmed />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      {burns.length > SHOWN && (
        <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2 text-xs text-fg-3">
          <span>{all ? `All ${burns.length} burns listed${total > burns.length ? ` (of ${total})` : ''}.` : `The latest ${SHOWN} of ${total} burns.`}</span>
          <button type="button" onClick={() => setAll((v) => !v)} className="rounded-sm px-1.5 py-0.5 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg">
            {all ? 'Show fewer' : 'Show all'}
          </button>
        </div>
      )}
    </>
  )
}

/** One headline figure of the rail: its legend, its value, a line under it. */
function Figure({ legend, value, sub, className }: { legend: string; value: ReactNode; sub: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 px-4 py-3', className)}>
      <p className="legend">{legend}</p>
      <p className="num truncate text-lg leading-6 text-fg">{value}</p>
      <p className="text-[11px] leading-4 text-fg-3">{sub}</p>
    </div>
  )
}

export function BurnTracker({ tracker, priceUsd, className }: { tracker: BurnTrackerState; priceUsd: number | null; className?: string }) {
  const now = useNow(15_000)
  const status = STATUS[tracker.state]
  const live = tracker.state === 'live' ? tracker : null
  const f = live ? burnFigures(live.view, priceUsd) : null
  const loading = tracker.state === 'loading'
  const value = (text: ReactNode) => (loading ? <Skeleton className="h-6 w-24" /> : f ? text : ghost())
  const series = live ? burnSeries(live.view.burns, live.view.decimals, live.view.readAt) : null
  const otherBurned =
    live && f && !f.allByTax ? formatUnits(BigInt(live.view.burnedTotal) - BigInt(live.view.burnedByTax), live.view.decimals, { maxFraction: 2, group: true }) : null

  return (
    <Panel aria-labelledby="kit-burn" className={className}>
      <PanelHeader
        id="kit-burn"
        title="Buyback & Burn"
        meta={tracker.state === 'not-on-network' ? undefined : KITS_CONTRACT}
        actions={
          <span className="flex items-center gap-2.5">
            {live && <span className="hidden text-[11px] text-fg-3 sm:inline">Updated {formatAgo(live.view.readAt, now)}</span>}
            <Tag tone={status.tag}>
              <Led tone={status.tone} className={loading ? 'animate-pulse' : undefined} /> {status.label}
            </Tag>
          </span>
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-[19rem_minmax(0,1fr)]">
        {/* The rail: the total first and largest, then what it is made of. */}
        <div className="flex min-w-0 flex-col border-b border-line-soft lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-1.5 px-4 pb-4 pt-4">
            <span className="legend">Total burned</span>
            {loading ? (
              <Skeleton className="h-10 w-56" />
            ) : (
              <p className="num flex flex-wrap items-baseline gap-x-2 leading-none text-fg" style={{ fontSize: 'clamp(1.375rem, 6.4vw, 1.75rem)' }}>
                {f ? f.burned : ghost()} <span className="font-sans text-base text-fg-3">KITS</span>
              </p>
            )}
            <p className="text-sm text-fg-2">
              {f ? <Figures>{`${f.burnedPct} of the ${f.launchSupply} KITS launch supply`}</Figures> : <span className="text-fg-3">share of the launch supply</span>}
            </p>
            {f && f.valueUsd !== null && <p className="text-xs text-fg-3">{`≈ ${formatUsd(f.valueUsd)} at today’s price`}</p>}
          </div>
          <div className="grid grid-cols-2 border-t border-line-soft lg:grid-cols-1">
            <Figure
              legend="Burn transactions"
              value={value(f?.burnCount)}
              sub={live ? (live.view.historyComplete ? 'each verified on chain' : 'verified so far') : 'verified on chain'}
              className="border-r border-line-soft lg:border-r-0"
            />
            <Figure
              legend="Last burn"
              value={value(f?.lastBurn ? formatAgo(f.lastBurn.at, now) : 'None yet')}
              sub={f?.lastBurn ? `${f.lastBurn.amount} KITS` : 'when, and how much'}
              className="lg:border-t lg:border-line-soft"
            />
            <Figure legend="Supply now" value={value(f?.supply)} sub={f ? 'KITS after burns' : 'after burns'} className="col-span-2 border-t border-line-soft lg:col-span-1" />
          </div>
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
            <span className="legend">KITS burned over time</span>{' '}
            {series && <span className="text-[11px] text-fg-3">{`${series.steps.length} verified burn${series.steps.length === 1 ? '' : 's'}`}</span>}
          </div>
          {series ? (
            <BurnChart series={series} className="mx-3 mb-2 mt-1 h-[13.5rem] sm:h-[17rem] lg:h-[19rem]" />
          ) : (
            <div className="graticule relative mx-4 mb-4 mt-2 flex h-[13.5rem] items-center justify-center rounded-sm border border-line-soft bg-well/40 bg-[size:10%_25%] sm:h-[17rem]">
              <p className="max-w-[44ch] px-4 text-center text-xs text-fg-3">
                {loading ? 'Reading the burns from NEAR…' : live ? 'No burn transaction has been verified yet.' : reasonOf(tracker)}
              </p>
            </div>
          )}
        </div>
      </div>
      {live ? (
        <div className="border-t border-line-soft">
          <p className="legend px-4 pb-1 pt-3.5">Recent burns</p>
          <RecentBurns burns={live.view.burns} decimals={live.view.decimals} total={live.view.burnCount} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 border-t border-line-soft px-4 py-3 text-xs text-fg-3">
        {live ? (
          <>
            <p>
              <Figures>
                {`Read on NEAR mainnet by NEARKITS’ server: the totals from Nearly’s launchpad (${live.view.launchpad}, launch ${live.view.launchId}) and from ${KITS_CONTRACT}’s own supply; every burn from the ft_burn event of its transaction. The tax is collected in KITS, so the Buyback & Burn share is burned straight from it.`}
              </Figures>
            </p>
            {otherBurned && <p>{`${otherBurned} KITS of the total were burned outside the tax.`}</p>}
            {!live.view.historyComplete && <p>The chart and list hold the burns verified so far; the total is the chain’s own.</p>}
            {live.refreshFailed && <p className="text-warn">{`The last refresh didn’t come back: these figures are from ${formatAgo(live.view.readAt, now)}.`}</p>}
          </>
        ) : (
          <p>{reasonOf(tracker)}</p>
        )}
      </div>
    </Panel>
  )
}
