import { MoreHorizontal } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { BalanceRefreshStatus } from '@/components/domain/BalanceRefresh'
import { SimMark } from '@/components/domain/SimMark'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, SessionEnded } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Indicators'
import { Menu, type MenuEntry } from '@/components/ui/Menu'
import { Amount, Pct, Price, Usd } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { cn } from '@/lib/cn'
import { formatAmount, formatCompact } from '@/lib/format'
import { WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { useServices } from '@/services/context'
import { useBalanceRefresh, useIdentity, usePositions } from '@/services/queries'
import { useConnectPrompt, useTradeDrawer } from '@/state/contexts'
import type { Position } from '@/types/domain'

const SHOWN = 6
const linkKey = 'keycap inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-2xs text-fg-2 transition-colors hover:bg-raised hover:text-fg'
const tokenPage = (p: Position) => `/token/${encodeURIComponent(p.token.id)}`

/** Buy and Sell open the trade ticket on this token; its page has the chart and Send. NEAR is the base currency: its page only. */
function RowMenu({ position }: { position: Position }) {
  const { openTrade } = useTradeDrawer()
  const navigate = useNavigate()
  const symbol = position.token.symbol
  const entries: MenuEntry[] = [
    ...(position.token.isNative
      ? []
      : [
          { label: `Buy ${symbol}`, onSelect: () => openTrade({ tokenId: position.token.id, side: 'buy' }) },
          { label: `Sell ${symbol}`, onSelect: () => openTrade({ tokenId: position.token.id, side: 'sell' }) },
          { kind: 'divider' as const },
        ]),
    { label: `${symbol} page`, hint: 'Chart, activity, Send', onSelect: () => void navigate(tokenPage(position)) },
  ]
  return (
    <Menu
      label={`${symbol} actions`}
      entries={entries}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`${symbol} actions`}
          className="inline-grid size-7 place-items-center rounded-sm text-fg-3 transition-colors hover:bg-raised hover:text-fg aria-expanded:bg-raised aria-expanded:text-fg"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      )}
    />
  )
}

/** The amount held: in full up to a million, then short (1.05B), the full figure on hover. */
function Held({ position, className }: { position: Position; className?: string }) {
  const b = position.balance
  if (b < 1_000_000) return <Amount value={b} minDecimals={position.token.isNative ? 2 : 0} className={className} />
  return (
    <span className={cn('num', className)} title={formatAmount(b)}>
      {formatCompact(b, 2)}
    </span>
  )
}

function TokenName({ position }: { position: Position }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <TokenGlyph symbol={position.token.symbol} tokenId={position.token.id} size={20} />
      <Link to={tokenPage(position)} className="truncate font-medium text-fg underline-offset-2 hover:underline" title={position.token.name}>
        {position.token.symbol}
      </Link>
    </span>
  )
}

/**
 * The tokens held, largest first. The table fits its own box: the price drops out as it narrows
 * and, below that, each token prints as a row block holding every figure.
 */
function AssetsTable({ positions }: { positions: Position[] }) {
  return (
    <div className="@container">
      <div className="hidden @[26rem]:block">
        <Table label="Your assets">
          <thead>
            <tr>
              <Th>Token</Th>
              <Th align="right" className="hidden @[36rem]:table-cell">
                Price
              </Th>
              <Th align="right" className="hidden @[28rem]:table-cell">
                Amount
              </Th>
              <Th align="right">Value</Th>
              <Th align="right">24h</Th>
              <Th align="right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <Tr key={p.token.id}>
                <Td className="max-w-[9rem]">
                  <TokenName position={p} />
                  {/* Where the amount has no column of its own, it prints under the token. */}
                  <div className="pl-7 text-xs text-fg-3 @[28rem]:hidden">
                    <Held position={p} />
                  </div>
                </Td>
                <Td align="right" className="hidden whitespace-nowrap @[36rem]:table-cell">
                  <Price value={p.priceUsd} className="text-fg-2" />
                  {p.token.status === 'prelaunch' && <SimMark />}
                </Td>
                <Td align="right" className="hidden whitespace-nowrap @[28rem]:table-cell">
                  <Held position={p} className="text-fg-2" />
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <Usd value={p.valueUsd} className="text-fg" />
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  <Pct value={p.change24hPct} />
                </Td>
                <Td align="right" className="w-9 !pl-0 !pr-2">
                  <RowMenu position={p} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-line-soft @[26rem]:hidden" aria-label="Your assets">
        {positions.map((p) => (
          <li key={p.token.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <TokenName position={p} />
              <div className="mt-0.5 pl-7 text-xs text-fg-3">
                <Held position={p} />
              </div>
            </div>
            <div className="text-right">
              <Usd value={p.valueUsd} className="text-fg" />
              <div className="text-xs">
                <Pct value={p.change24hPct} />
              </div>
            </div>
            <RowMenu position={p} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AssetsPanel() {
  const { nearkit } = useServices()
  const who = useIdentity()
  const positions = usePositions()
  const { promptConnect } = useConnectPrompt()
  // While balances reconcile after a run, these figures aren't current: dimmed, and BalanceRefreshStatus says so.
  const reconciling = useBalanceRefresh().state === 'updating'
  const all = useMemo(() => positions.data ?? [], [positions.data])
  const top = useMemo(() => [...all].sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)).slice(0, SHOWN), [all])
  return (
    <Panel aria-labelledby="dash-assets" className="flex flex-col">
      <PanelHeader
        id="dash-assets"
        title="Your assets"
        meta={positions.data ? all.length : undefined}
        actions={
          <>
            <BalanceRefreshStatus />
            <Link to="/positions" className={linkKey}>
              All positions
            </Link>
          </>
        }
      />
      {who.kind === 'session-ended' ? (
        <SessionEnded ended={who.ended} />
      ) : who.kind === 'signed-out' ? (
        <EmptyState
          title="No wallet connected"
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={promptConnect}>
                Connect wallet
              </Button>
              {nearkit.available && WEB_SIGN_IN_URL && (
                <a href={WEB_SIGN_IN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex">
                  <Button variant="secondary" tabIndex={-1}>
                    Sign in with Telegram
                  </Button>
                </a>
              )}
            </span>
          }
        >
          Tokens across all of your NEARKITS wallets appear here.
        </EmptyState>
      ) : positions.isError && positions.data === undefined ? (
        <LoadFailed title="Assets can’t be loaded right now" error={positions.error} onRetry={() => void positions.refetch()} />
      ) : who.kind === 'pending' || positions.isPending ? (
        <div className="flex flex-col gap-px p-4" aria-busy="true" aria-label="Loading assets">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <Skeleton className="size-5" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="ml-auto h-4 w-16" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          title="No tokens yet"
          graphic={false}
          action={
            <Link to="/swap" className={linkKey}>
              Open Swap
            </Link>
          }
        >
          Tokens you buy or receive appear here with their value.
        </EmptyState>
      ) : (
        <div className={cn('transition-opacity', reconciling && 'opacity-60')} aria-busy={reconciling || undefined}>
          <AssetsTable positions={top} />
          {all.length > SHOWN && (
            <div className="border-t border-line-soft px-2 py-1.5">
              <Link to="/positions" className={linkKey}>
                {`${all.length - SHOWN} more in Positions`}
              </Link>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
