import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Figures } from '@/components/ui/Figures'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { KIT, KITS_CONTRACT } from '@/config/kit'
import { NETWORKS } from '@/config/networks'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime, formatUsd, truncateMiddle } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import type { KitsHolderPayout } from '@/services/kitsRewards'
import { explorerTxUrl } from '@/services/near/explorer'
import { nearOf, rewardFigures, type RewardsState } from './rewards'

/**
 * $KITS' holder rewards, live: what Nearly's launchpad has paid to $KITS holders (in NEAR), what it
 * holds for them and hasn't paid yet, and every payout round, each linked to its transaction. A
 * compact rewards ledger beside the Buyback & Burn chart: figures and a register, not another chart.
 */

const SHOWN = 6

const STATUS: Record<RewardsState['state'], { label: string; tone: 'on' | 'off' | 'warn' | 'idle'; tag: 'accent' | 'neutral' }> = {
  live: { label: 'Live', tone: 'on', tag: 'accent' },
  loading: { label: 'Reading', tone: 'idle', tag: 'neutral' },
  unavailable: { label: 'Awaiting data', tone: 'warn', tag: 'neutral' },
  'no-source': { label: 'Not read here', tone: 'off', tag: 'neutral' },
  'not-on-network': { label: 'Mainnet only', tone: 'off', tag: 'neutral' },
}

function reasonOf(state: RewardsState): string {
  switch (state.state) {
    case 'not-on-network':
      return `${KIT.ticker} trades on NEAR mainnet: its holder rewards are paid and tracked there, not in this build.`
    case 'no-source':
      return state.reason === 'demo'
        ? `This preview reads nothing from NEAR. On nearkits.com, ${KIT.ticker} holder rewards are read live from Nearly’s launchpad.`
        : `This build isn’t connected to NEARKITS’ server, which reads ${KIT.ticker} holder rewards from NEAR.`
    case 'unavailable':
      return `NEARKITS can’t read ${KIT.ticker} holder rewards from NEAR right now. It asks again every minute; no figure is shown until it has one.`
    default:
      return `Reading ${KIT.ticker} holder rewards from NEAR…`
  }
}

function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 px-4 py-3', className)}>
      <p className="legend">{label}</p>
      <p className="num truncate text-lg leading-6 text-fg">{value}</p>
      {sub && <p className="text-[11px] leading-4 text-fg-3">{sub}</p>}
    </div>
  )
}

function TxLink({ tx }: { tx: string }) {
  return (
    <a
      href={explorerTxUrl(NETWORKS.mainnet, tx)}
      target="_blank"
      rel="noreferrer noopener"
      className="num inline-flex items-center gap-1 text-fg-2 underline decoration-fg-4 underline-offset-2 hover:text-fg"
      aria-label={`Payout transaction ${tx} on NearBlocks`}
    >
      {truncateMiddle(tx, 6, 4)}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

function Paid() {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-2">
      <Led tone="on" /> Paid
    </span>
  )
}

function Payouts({ payouts, total }: { payouts: KitsHolderPayout[]; total: number }) {
  const shown = payouts.slice(0, SHOWN)
  if (!shown.length) return <p className="px-4 py-4 text-sm text-fg-3">No payout round has been verified yet.</p>
  return (
    <>
      <ul className="divide-y divide-line-soft md:hidden" aria-label="Payout rounds">
        {shown.map((p) => (
          <li key={p.tx} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="num text-sm text-fg">
                {nearOf(p.amount)} <span className="font-sans text-xs text-fg-3">NEAR</span>
              </span>
              <span className="truncate text-[11px] text-fg-3">
                <Figures>{`${formatDateTime(p.at)} · ${p.payments} holder${p.payments === 1 ? '' : 's'}`}</Figures>
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
              <TxLink tx={p.tx} />
              <Paid />
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table label="Payout rounds" minWidth={520}>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th align="right">Paid</Th>
              <Th align="right">Holders</Th>
              <Th>Transaction</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <Tr key={p.tx}>
                <Td className="text-xs text-fg-2">{formatDateTime(p.at)}</Td>
                <Td align="right" mono className="text-fg">
                  {nearOf(p.amount)} <span className="font-sans text-xs text-fg-3">NEAR</span>
                </Td>
                <Td align="right" mono className="text-fg-2">
                  {p.payments}
                </Td>
                <Td className="text-xs">
                  <TxLink tx={p.tx} />
                </Td>
                <Td align="right" className="text-xs">
                  <Paid />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      {total > shown.length && <p className="border-t border-line-soft px-4 py-2.5 text-xs text-fg-3">{`The latest ${shown.length} of ${total} payout rounds.`}</p>}
    </>
  )
}

export function HolderRewards({ state, nearUsd }: { state: RewardsState; nearUsd: number | null }) {
  const now = useNow(15_000)
  const status = STATUS[state.state]
  const live = state.state === 'live' ? state : null
  const f = live ? rewardFigures(live.view, nearUsd) : null
  const loading = state.state === 'loading'
  const show = (v: ReactNode) => (loading ? <Skeleton className="h-6 w-24" /> : f ? v : <span className="text-fg-4">—</span>)

  return (
    <Panel aria-labelledby="kit-holder-rewards">
      <PanelHeader
        id="kit-holder-rewards"
        title="Holder rewards"
        meta={state.state === 'not-on-network' ? undefined : 'Paid in NEAR'}
        actions={
          <span className="flex items-center gap-2.5">
            {live && <span className="text-[11px] text-fg-3">Updated {formatAgo(live.view.readAt, now)}</span>}
            <Tag tone={status.tag}>
              <Led tone={status.tone} className={loading ? 'animate-pulse' : undefined} /> {status.label}
            </Tag>
          </span>
        }
      />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col border-b border-line-soft xl:border-b-0 xl:border-r">
          <div className="flex flex-col gap-1.5 px-4 pb-3 pt-4">
            <span className="legend">Paid to holders</span>
            <p className="num flex flex-wrap items-baseline gap-x-2 leading-none text-fg" style={{ fontSize: 'clamp(1.375rem, 5.6vw, 1.75rem)' }}>
              {show(f?.paid)} <span className="font-sans text-base text-fg-3">NEAR</span>
            </p>
            <p className="text-xs text-fg-3">
              {f ? (f.paidUsd !== null ? `≈ ${formatUsd(f.paidUsd)} at today’s NEAR price · all time` : 'all time, verified on chain') : 'all time'}
            </p>
          </div>
          <div className="grid grid-cols-2 border-t border-line-soft">
            <Stat label="Allocated" value={show(f ? `${f.allocated}` : null)} sub="NEAR in all: paid + waiting" className="border-r border-line-soft" />
            <Stat label="Waiting" value={show(f ? `${f.waiting}` : null)} sub="NEAR allocated, not paid yet" />
            <Stat
              label="Payout rounds"
              value={show(f?.payoutCount)}
              sub={f ? <Figures>{`${f.paymentCount} holder payments`}</Figures> : 'verified on chain'}
              className="border-r border-t border-line-soft"
            />
            <Stat
              label="Latest payout"
              value={show(f?.latest ? formatAgo(f.latest.at, now) : 'None yet')}
              sub={f?.latest ? <Figures>{`${f.latest.amount} NEAR to ${f.latest.payments} holders`}</Figures> : 'when, and how much'}
              className="border-t border-line-soft"
            />
          </div>
        </div>
        <div className="min-w-0">
          {live ? (
            <Payouts payouts={live.view.payouts} total={live.view.payoutCount} />
          ) : (
            <div className="flex h-full min-h-28 items-center px-4 py-5">
              <p className="max-w-[52ch] text-sm text-fg-3">{reasonOf(state)}</p>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line-soft px-4 py-3 text-xs text-fg-3">
        {live ? (
          <>
            <p>
              <Figures>
                {`Holders’ share of the tax: ${f?.sharePct}. Nearly’s launchpad (${live.view.launchpad}, launch ${live.view.launchId}) sells it for NEAR and pays it to ${KIT.ticker} holders in rounds; “paid” counts only rounds verified on chain, “waiting” is what it holds for holders and hasn’t paid.`}
              </Figures>
            </p>
            {!live.view.historyComplete && <p>{`Reading the payout history: ${live.view.payoutCount} rounds verified so far. The paid total is the launchpad’s own.`}</p>}
            {live.refreshFailed && <p className="text-warn">{`The last refresh didn’t come back: these figures are from ${formatAgo(live.view.readAt, now)}.`}</p>}
          </>
        ) : (
          <p>{state.state === 'loading' ? reasonOf(state) : `Read live from ${KITS_CONTRACT}’s launch on NEAR mainnet.`}</p>
        )}
      </div>
    </Panel>
  )
}
