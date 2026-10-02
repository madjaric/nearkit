import { ChevronRight } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { AccountText } from '@/components/domain/Account'
import { SimMark } from '@/components/domain/SimMark'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Form'
import { Term } from '@/components/ui/Help'
import { Skeleton, Tag } from '@/components/ui/Indicators'
import { Amount, Pct, Price, Usd } from '@/components/ui/Num'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { useSort } from '@/components/ui/useSort'
import { cn } from '@/lib/cn'
import { formatCompact } from '@/lib/format'
import { canExecute, executesViaNearKit } from '@/lib/wallets'
import { useWallets } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import type { Position, Wallet } from '@/types/domain'
import { SendTokenButton } from '../token/SendToken'
import { NearKitSendModal } from '../wallets/nearkit'
import { PositionPnlDetail } from './PositionPnlDetail'

type SortKey = 'token' | 'balance' | 'avg' | 'price' | 'value' | 'pnl' | 'pnlPct'

// Unknown figures (null) sort below every known one.
const known = (v: number | null) => v ?? Number.NEGATIVE_INFINITY

const GETTERS: Record<SortKey, (p: Position) => number | string> = {
  token: (p) => p.token.symbol,
  balance: (p) => p.balance,
  avg: (p) => known(p.avgEntryUsd),
  price: (p) => known(p.priceUsd),
  value: (p) => known(p.valueUsd),
  pnl: (p) => known(p.pnlUsd),
  pnlPct: (p) => known(p.pnlPct),
}

const SORT_LABEL: Record<SortKey, string> = {
  token: 'Token',
  balance: 'Balance',
  avg: 'Average entry',
  price: 'Price',
  value: 'Value',
  pnl: 'Unrealized PnL',
  pnlPct: 'Unrealized %',
}

/** A position's PnL state next to its figures: still reading history, or partial. */
function PnlState({ position }: { position: Position }) {
  if (position.pnlStatus === 'loading') return <div className="text-[11px] text-fg-4">calculating…</div>
  if (position.pnl && !position.pnl.complete) return <div className="text-[11px] text-warn">partial</div>
  return null
}

interface PositionsTableProps {
  positions: Position[]
  loading?: boolean
  /** Dashboard variant drops average entry and per-wallet breakdown. */
  compact?: boolean
  /** Expandable per-wallet breakdown rows. */
  expandable?: boolean
}

/**
 * The table fits its own box instead of scrolling sideways: what a narrower box has no room for
 * drops out, measured against the table itself (not the window), and below the narrowest tier
 * the positions print as the card list, which holds every figure.
 *   Positions page: every column from 72rem; under it, average entry moves to the row's detail
 *   and the unrealized % prints under its figure; cards under 56rem.
 *   Dashboard: unrealized from 53rem, price and the Send key from 46rem; cards under 34rem.
 */
const TIERS = {
  full: {
    table: 'hidden @[56rem]:block',
    cards: '@[56rem]:hidden',
    detail: 'hidden @[72rem]:table-cell',
    pctInline: '@[72rem]:hidden',
    price: undefined,
    pnl: undefined,
    send: 'inline-flex',
  },
  compact: {
    table: 'hidden @[34rem]:block',
    cards: '@[34rem]:hidden',
    detail: undefined,
    pctInline: undefined,
    price: 'hidden @[46rem]:table-cell',
    pnl: 'hidden @[53rem]:table-cell',
    send: 'hidden @[46rem]:inline-flex',
  },
} as const

/** BUY | SELL | SEND: the existing trade ticket, and each wallet's own send flow (never a watch-only one). */
function TradeKeys({ position, compact = false }: { position: Position; compact?: boolean }) {
  const { openTrade } = useTradeDrawer()
  const send = (
    <span className={TIERS[compact ? 'compact' : 'full'].send}>
      <SendTokenButton token={position.token} label="Send" size="sm" variant="ghost" icon={false} />
    </span>
  )
  if (position.token.isNative) {
    return (
      <div className="flex items-center justify-end gap-1">
        <span className="text-xs text-fg-4" title="NEAR is the base currency; trade tokens against it">
          Base
        </span>
        {send}
      </div>
    )
  }
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="quiet-buy" onClick={() => openTrade({ tokenId: position.token.id, side: 'buy' })} aria-label={`Buy ${position.token.symbol}`}>
        Buy
      </Button>
      <Button size="sm" variant="quiet-sell" onClick={() => openTrade({ tokenId: position.token.id, side: 'sell' })} aria-label={`Sell ${position.token.symbol}`}>
        Sell
      </Button>
      {send}
    </div>
  )
}

function TokenCell({ position }: { position: Position }) {
  return (
    <div className="flex items-center gap-2.5">
      <TokenGlyph symbol={position.token.symbol} tokenId={position.token.id} size={28} />
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 font-semibold text-fg">
          {/* The token's screen: live price, chart, balance, Buy / Sell / Send. */}
          <Link to={`/token/${encodeURIComponent(position.token.id)}`} className="underline-offset-2 hover:underline">
            {position.token.symbol}
          </Link>
          {position.token.status === 'prelaunch' && (
            <Tag tone="warn" title="$KIT has not launched. KIT figures in this preview are demo data.">
              Pre-launch
            </Tag>
          )}
        </span>
        <span className="text-xs text-fg-3">{position.token.name}</span>
      </div>
    </div>
  )
}

export function PositionsTable({ positions, loading = false, compact = false, expandable = false }: PositionsTableProps) {
  const { sorted, sort, setSort, thSort } = useSort(positions, GETTERS, { key: 'value', dir: 'desc' })
  const { data: wallets = [] } = useWallets()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState<{ wallet: Wallet; tokenId: string } | null>(null)
  const walletLabel = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets])

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (loading) {
    return (
      <div className="flex flex-col gap-px p-4" aria-busy="true" aria-label="Loading positions">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 py-2.5">
            <Skeleton className="size-6" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    )
  }

  const colCount = compact ? 6 : 8
  const tier = TIERS[compact ? 'compact' : 'full']

  return (
    <div className="@container">
      {/* A box wide enough for it: the terminal table */}
      <div className={tier.table}>
        <Table label="Positions" rows="double" minWidth={compact ? 520 : 860}>
          <thead>
            <tr>
              <Th sort={thSort('token')}>Token</Th>
              <Th align="right" sort={thSort('balance')}>
                Balance
              </Th>
              {!compact && (
                <Th align="right" sort={thSort('avg')} className={tier.detail}>
                  <Term term="avgEntry">Avg entry</Term>
                </Th>
              )}
              <Th align="right" sort={thSort('price')} className={tier.price}>
                Price
              </Th>
              <Th align="right" sort={thSort('value')}>
                Value
              </Th>
              <Th align="right" sort={thSort('pnl')} className={tier.pnl}>
                Unrealized
              </Th>
              {!compact && (
                <Th align="right" sort={thSort('pnlPct')} className={tier.detail}>
                  Unrealized %
                </Th>
              )}
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const isOpen = open.has(p.token.id)
              return (
                <Fragment key={p.token.id}>
                  <Tr>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {expandable && (
                          <button
                            type="button"
                            onClick={() => toggle(p.token.id)}
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} wallets holding ${p.token.symbol}`}
                            className="-ml-1 grid size-6 place-items-center rounded-xs text-fg-3 hover:bg-raised hover:text-fg"
                          >
                            <ChevronRight size={14} className={cn('transition-transform duration-150', isOpen && 'rotate-90')} />
                          </button>
                        )}
                        <TokenCell position={p} />
                      </div>
                    </Td>
                    <Td align="right">
                      <Amount value={p.balance} minDecimals={p.token.isNative ? 2 : 0} className="text-fg" />
                      {expandable && (
                        <div className="text-[11px] text-fg-3">
                          {p.wallets.length} {p.wallets.length === 1 ? 'wallet' : 'wallets'}
                        </div>
                      )}
                    </Td>
                    {!compact && (
                      <Td align="right" className={tier.detail}>
                        <Price value={p.avgEntryUsd} className="text-fg-2" />
                        {p.token.status === 'prelaunch' && <SimMark />}
                      </Td>
                    )}
                    <Td align="right" className={tier.price}>
                      <Price value={p.priceUsd} className="text-fg" />
                      {p.token.status === 'prelaunch' && <SimMark />}
                      <div>
                        <Pct value={p.change24hPct} className="text-[11px]" />
                      </div>
                    </Td>
                    <Td align="right">
                      <Usd value={p.valueUsd} className="text-fg" />
                    </Td>
                    <Td align="right" className={tier.pnl}>
                      <Usd value={p.pnlUsd} signed colored />
                      {/* The percentage prints under the figure wherever it has no column of its own. */}
                      <div className={tier.pctInline}>
                        <Pct value={p.pnlPct} className="text-[11px]" />
                      </div>
                      <PnlState position={p} />
                    </Td>
                    {!compact && (
                      <Td align="right" className={tier.detail}>
                        <Pct value={p.pnlPct} />
                      </Td>
                    )}
                    <Td align="right">
                      <TradeKeys position={p} compact={compact} />
                    </Td>
                  </Tr>
                  {expandable && isOpen && (
                    <tr className="border-b border-line-soft bg-well/60">
                      <td colSpan={colCount} className="px-4 py-2">
                        <div className="pb-2 pl-10">
                          <PositionPnlDetail position={p} />
                        </div>
                        <ul className="grid grid-cols-1 gap-x-8 gap-y-1 pl-10 sm:grid-cols-2 xl:grid-cols-3" aria-label={`${p.token.symbol} by wallet`}>
                          {p.wallets.map((w) => {
                            const wallet = walletLabel.get(w.walletId)
                            return (
                              <li key={w.walletId} className="flex items-center justify-between gap-4 py-1 text-xs">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="text-fg-2">{wallet?.label ?? w.walletId}</span>
                                  {wallet && <AccountText id={wallet.accountId} className="text-fg-4" />}
                                  {wallet && !canExecute(wallet) && <Tag tone="soon">Watch only</Tag>}
                                </span>
                                <span className="flex items-center gap-2">
                                  <span className="num text-fg-2">{formatCompact(w.amount, 2)}</span>
                                  {wallet && executesViaNearKit(wallet) && !wallet.frozen && (
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => setSending({ wallet, tokenId: p.token.id })}
                                      aria-label={`Send ${p.token.symbol} from ${wallet.label}`}
                                    >
                                      Send
                                    </Button>
                                  )}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      </div>
      <NearKitSendModal wallet={sending?.wallet ?? null} tokenId={sending?.tokenId} onClose={() => setSending(null)} />

      {/* A narrower box: each position becomes a two-line row with its keys */}
      <div className={tier.cards}>
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2">
          <span className="legend">Sort</span>
          <Select
            selectSize="sm"
            aria-label="Sort positions"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']
              setSort({ key, dir })
            }}
            className="w-44"
          >
            {(['value', 'pnl', 'pnlPct', 'balance', 'token'] as SortKey[]).map((k) => (
              <option key={k} value={`${k}:${k === 'token' ? 'asc' : 'desc'}`}>
                {SORT_LABEL[k]} {k === 'token' ? 'A–Z' : '↓'}
              </option>
            ))}
          </Select>
        </div>
        <ul className="divide-y divide-line-soft" aria-label="Positions">
          {sorted.map((p) => (
            <li key={p.token.id} className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <TokenCell position={p} />
                <div className="text-right">
                  <Usd value={p.valueUsd} className="text-sm text-fg" />
                  <div className="text-xs">
                    <Usd value={p.pnlUsd} signed colored /> <Pct value={p.pnlPct} className="text-fg-3" colored />
                  </div>
                  <PnlState position={p} />
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="legend">Balance</dt>
                  <dd className="num mt-0.5 text-fg-2">{formatCompact(p.balance, 2)}</dd>
                </div>
                <div>
                  <dt className="legend">Avg entry</dt>
                  <dd className="mt-0.5 text-fg-2">
                    <Price value={p.avgEntryUsd} />
                    {p.token.status === 'prelaunch' && <SimMark />}
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="legend">Price</dt>
                  <dd className="mt-0.5 text-fg-2">
                    <Price value={p.priceUsd} />
                    {p.token.status === 'prelaunch' && <SimMark />}
                  </dd>
                </div>
              </dl>
              {expandable && (p.pnl || p.pnlStatus === 'loading') && (
                <div>
                  <button type="button" onClick={() => toggle(p.token.id)} aria-expanded={open.has(p.token.id)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                    <ChevronRight size={13} className={cn('transition-transform duration-150', open.has(p.token.id) && 'rotate-90')} />
                    PnL details
                  </button>
                  {open.has(p.token.id) && (
                    <div className="mt-2">
                      <PositionPnlDetail position={p} />
                    </div>
                  )}
                </div>
              )}
              {!p.token.isNative && <TradeKeysMobile position={p} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function TradeKeysMobile({ position }: { position: Position }) {
  const { openTrade } = useTradeDrawer()
  return (
    <div className="grid grid-cols-3 gap-2">
      <Button size="sm" variant="quiet-buy" onClick={() => openTrade({ tokenId: position.token.id, side: 'buy' })} aria-label={`Buy ${position.token.symbol}`}>
        Buy
      </Button>
      <Button size="sm" variant="quiet-sell" onClick={() => openTrade({ tokenId: position.token.id, side: 'sell' })} aria-label={`Sell ${position.token.symbol}`}>
        Sell
      </Button>
      <SendTokenButton token={position.token} label="Send" size="sm" variant="ghost" icon={false} />
    </div>
  )
}
