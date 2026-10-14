import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Skeleton } from '@/components/ui/Indicators'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { StrategyLamp } from '@/features/automation/live/parts'
import { formatAccount, formatAgo } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { cn } from '@/lib/cn'
import { countByKind, KIND_PAGE, type StrategiesOff, type StrategyRow } from './strategies'
import type { ActiveStrategies } from './useActiveStrategies'

const SHOWN = 5
const linkKey = 'keycap inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-2xs text-fg-2 transition-colors hover:bg-raised hover:text-fg'

/** The four kinds, with where each is managed, in the sidebar's order. */
const KINDS = [
  { kind: 'limit', label: 'Limit Orders' },
  { kind: 'dca', label: 'DCA' },
  { kind: 'copy', label: 'Copy Trade' },
  { kind: 'sniper', label: 'Sniper' },
] as const

function Lamp({ row }: { row: StrategyRow }) {
  return row.lamp.source === 'server' ? <StrategyLamp status={row.lamp.status} /> : <StatusLamp status={row.lamp.status} />
}

/** The token's glyph, or the kind's first letter for an account or new pools. */
function Subject({ row }: { row: StrategyRow }) {
  const symbol = row.subject.split(' / ')[0] ?? row.subject
  return (
    <span className="flex min-w-0 items-center gap-2">
      {row.tokenId ? (
        <TokenGlyph symbol={symbol} tokenId={row.tokenId} size={20} />
      ) : (
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-raised text-[10px] font-semibold uppercase text-fg-3">
          {row.kind === 'copy' ? '@' : '+'}
        </span>
      )}
      <span className={cn('truncate text-fg', row.kind === 'copy' && 'num text-sm')} title={row.subject}>
        {row.kind === 'copy' ? formatAccount(row.subject, 22) : row.subject}
      </span>
    </span>
  )
}

function OffState({ off }: { off: StrategiesOff }) {
  if (off === 'no-session' || off === 'signed-out')
    return (
      <EmptyState
        title="Automations run from NEARKITS wallets"
        graphic={false}
        action={
          WEB_SIGN_IN_URL ? (
            <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
              <Button variant="secondary" tabIndex={-1}>
                Sign in with Telegram
              </Button>
            </a>
          ) : undefined
        }
      >
        Sign in with Telegram to create limit orders, DCA plans, Copy Trade rules and snipers, and follow them here.
      </EmptyState>
    )
  if (off === 'session-ended')
    return (
      <EmptyState title="NEARKITS session ended" graphic={false}>
        Sign in again with /web to the NEARKITS bot to see the strategies running on your NEARKITS wallets.
      </EmptyState>
    )
  return (
    <EmptyState title="Automation is coming soon" graphic={false}>
      {off === 'unavailable'
        ? 'Limit orders, DCA, Copy Trade and Sniper run on NEARKITS’ server, which this build doesn’t use. Nothing runs here.'
        : 'Limit orders, DCA, Copy Trade and Sniper aren’t switched on for your account yet. Nothing runs until they are.'}
    </EmptyState>
  )
}

function NoneRunning() {
  return (
    <EmptyState
      title="Nothing running"
      graphic={false}
      action={
        <span className="flex flex-wrap items-center justify-center gap-1">
          <Link to="/limit-orders" className={linkKey}>
            Place a limit order
          </Link>
          <Link to="/dca" className={linkKey}>
            Start a DCA plan
          </Link>
          <Link to="/sniper" className={linkKey}>
            Set up a sniper
          </Link>
        </span>
      }
    >
      Strategies you create are watched by NEARKITS and listed here while they run.
    </EmptyState>
  )
}

/**
 * The table fits its own box: the trigger and the age drop out as it narrows (measured against
 * the panel, not the window), and below that each strategy prints as a row block with every figure.
 */
function StrategiesTable({ rows }: { rows: StrategyRow[] }) {
  const now = useNow(30_000)
  return (
    <div className="@container">
      <div className="hidden @[30rem]:block">
        <Table label="Active strategies" className="[&_td]:px-2.5 [&_th]:px-2.5">
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Token / Pair</Th>
              <Th className="hidden @[37rem]:table-cell">Trigger</Th>
              <Th align="right">Amount</Th>
              <Th>Status</Th>
              <Th align="right" className="hidden @[48rem]:table-cell">
                Created
              </Th>
              <Th align="right">
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <Link to={r.href} className="whitespace-nowrap text-fg underline-offset-2 hover:underline">
                    {r.type}
                  </Link>
                </Td>
                <Td className="max-w-[10rem]">
                  <Subject row={r} />
                </Td>
                <Td className="hidden whitespace-nowrap text-fg-2 @[37rem]:table-cell">
                  <Figures>{r.trigger}</Figures>
                </Td>
                <Td align="right" className="whitespace-nowrap text-fg-2">
                  <Figures>{r.amount}</Figures>
                </Td>
                <Td>
                  <Lamp row={r} />
                </Td>
                <Td align="right" className="num hidden whitespace-nowrap text-fg-3 @[48rem]:table-cell">
                  {formatAgo(r.createdAt, now)}
                </Td>
                <Td align="right" className="w-8 !pl-0 !pr-2">
                  <Link
                    to={r.href}
                    aria-label={`Manage ${r.type} ${r.subject}`}
                    className="inline-grid size-6 place-items-center rounded-xs text-fg-4 hover:bg-raised hover:text-fg"
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-line-soft @[30rem]:hidden" aria-label="Active strategies">
        {rows.map((r) => (
          <li key={r.id}>
            <Link to={r.href} className="flex items-start gap-3 px-4 py-3 hover:bg-raised/50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-base font-medium text-fg">{r.type}</span>
                  <Lamp row={r} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-sm">
                  <Subject row={r} />
                  <span className="shrink-0 text-fg-2">
                    <Figures>{r.amount}</Figures>
                  </span>
                </div>
                <div className="mt-1 text-xs text-fg-3">
                  <Figures>{`${r.trigger} · ${formatAgo(r.createdAt, now)}`}</Figures>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ActiveStrategiesPanel({ strategies: a }: { strategies: ActiveStrategies }) {
  const shown = a.rows.slice(0, SHOWN)
  const counts = countByKind(a.rows)
  return (
    <Panel aria-labelledby="dash-strategies">
      <PanelHeader id="dash-strategies" title="Active strategies" meta={a.loading || a.failed || a.source === 'off' ? undefined : a.rows.length} />
      {a.loading ? (
        <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading strategies">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : a.failed ? (
        <LoadFailed title="Strategies can’t be loaded right now" error={a.error} onRetry={a.refetch} />
      ) : a.source === 'off' && a.off ? (
        <OffState off={a.off} />
      ) : a.rows.length === 0 ? (
        <NoneRunning />
      ) : (
        <>
          <StrategiesTable rows={shown} />
          {/* Every kind, with how many it has listed, links to where it is managed. */}
          <nav aria-label="Strategy pages" className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-line-soft px-2 py-1.5">
            {KINDS.map((k) => (
              <Link key={k.kind} to={KIND_PAGE[k.kind]} className={linkKey}>
                {k.label}
                <span className={cn('num', counts[k.kind] > 0 ? 'text-fg' : 'text-fg-4')}>{counts[k.kind]}</span>
              </Link>
            ))}
            {a.rows.length > SHOWN && <span className="ml-auto px-2 text-xs text-fg-3">{`${a.rows.length - SHOWN} more on their pages`}</span>}
          </nav>
        </>
      )}
    </Panel>
  )
}
