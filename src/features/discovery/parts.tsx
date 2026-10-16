import { Bell, BellOff, ExternalLink, ShieldAlert, Star, UserCheck, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Tip } from '@/components/ui/Floating'
import { Led, Tag } from '@/components/ui/Indicators'
import { Usd } from '@/components/ui/Num'
import { Table, Td, Th, Tr } from '@/components/ui/Table'
import { TOP_WALLETS_PAUSED } from '@/config/paused'
import type { IndexStatus, LaunchRow, TradeView } from '@/lib/discovery/api'
import { cn } from '@/lib/cn'
import { formatAccount, formatAgo, formatAmount, formatDateTime } from '@/lib/format'
import { useNow } from '@/lib/hooks'
import { explorerAccountUrl, explorerTxUrl } from '@/services/near/explorer'
import { useCapabilities } from '@/services/queries'
import { watchlist, useList } from './local'
import { riskFlags } from './model'
import { useFollowed } from './queries'

/** Discovery's shared pieces: freshness, coverage, risk evidence, shares, accounts, watch and follow keys. */

/** The trade index's state in one line: how fresh, how far back, still catching up. */
export function IndexNote({ index, className }: { index: IndexStatus; className?: string }) {
  const now = useNow(15_000)
  const tone = !index.on ? 'off' : index.stale || index.backfilling ? 'warn' : 'on'
  const text = !index.on
    ? 'The trade index isn’t running on NEARKITS’ server.'
    : index.backfilling
      ? `Catching up on swap history (indexed to ${index.tradesTo ? formatDateTime(index.tradesTo) : 'its start'}); figures fill in as it goes.`
      : index.stale
        ? `The newest indexed swap is ${index.tradesTo ? formatAgo(index.tradesTo, now) : 'unknown'}: the index is behind.`
        : `Swaps indexed to ${index.tradesTo ? formatAgo(index.tradesTo, now) : '—'}, from ${formatDateTime(index.indexStart)}.`
  return (
    <p className={cn('flex items-start gap-2 text-xs leading-5 text-fg-3', className)} role="status">
      <Led tone={tone} className="mt-[7px]" />
      <span>{text}</span>
    </p>
  )
}

/** Risk flags as a compact key; hover or focus lists each flag with its evidence. */
export function RiskKey({ row }: { row: LaunchRow }) {
  const flags = riskFlags(row)
  if (flags.length === 0)
    return (
      <Tip content="No flag raised by the data NEARKITS has. Absent data is not a pass, and no flag is not “safe”." focusable>
        <span className="num text-xs text-fg-4">—</span>
      </Tip>
    )
  return (
    <Tip
      focusable
      content={
        <ul className="flex flex-col gap-1">
          {flags.map((f) => (
            <li key={f.key}>
              <span className="font-medium text-fg">{f.label}.</span> {f.evidence}
            </li>
          ))}
        </ul>
      }
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs',
          flags.some((f) => f.key === 'spam' || f.key === 'concentrated' || f.key === 'dev-heavy') ? 'text-warn' : 'text-fg-2',
        )}
      >
        <ShieldAlert size={14} aria-hidden="true" />
        <span className="num">{flags.length}</span>
        <span className="sr-only">{flags.map((f) => f.label).join(', ')}</span>
      </span>
    </Tip>
  )
}

/** A share (0-1) as a figure over a hairline bar. */
export function ShareBar({ share, className, warnAbove = 0.5 }: { share: number | null; className?: string; warnAbove?: number | null }) {
  if (share === null) return <span className="num text-xs text-fg-4">—</span>
  const pct = Math.max(0, Math.min(1, share)) * 100
  return (
    <span className={cn('flex min-w-16 flex-col gap-1', className)}>
      <span className="num text-xs text-fg-2">{pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%</span>
      <span className="h-[3px] w-full rounded-full bg-line" aria-hidden="true">
        <span className={cn('block h-full rounded-full', warnAbove !== null && share > warnAbove ? 'bg-warn' : 'bg-fg-3')} style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

/** An account: shortened, copyable, opened on the explorer. */
export function AccountRef({ account, max = 22, className, children }: { account: string; max?: number; className?: string; children?: ReactNode }) {
  const caps = useCapabilities()
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {children ?? (
        <span className="num truncate text-fg" title={account}>
          {formatAccount(account, max)}
        </span>
      )}
      <CopyButton value={account} label={`Copy ${account}`} />
      {caps.explorerUrl && (
        <a
          href={explorerAccountUrl({ explorerUrl: caps.explorerUrl }, account)}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${account} on the explorer`}
          className="grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      )}
    </span>
  )
}

/** Adds a token to the watchlist kept in this browser, or removes it. */
export function WatchStar({ token, symbol }: { token: string; symbol?: string | null }) {
  const list = useList(watchlist)
  const on = list.includes(token)
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${symbol ?? token} from your watchlist` : `Add ${symbol ?? token} to your watchlist`}
      title={on ? 'On your watchlist' : 'Watch'}
      onClick={(e) => {
        e.stopPropagation()
        watchlist.toggle(token)
      }}
      className={cn('grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-raised', on ? 'text-accent' : 'text-fg-3 hover:text-fg')}
    >
      <Star size={15} aria-hidden="true" fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}

/** Follow a wallet (kept in this browser; with a NEARKITS session, also on the server for alerts). */
export function FollowButton({ account, size = 'sm', withAlerts = false }: { account: string; size?: 'xs' | 'sm'; withAlerts?: boolean }) {
  const f = useFollowed()
  const on = f.isFollowed(account)
  const alerts = f.alerts.has(account)
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button size={size} variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={() => f.toggle(account)}>
        {on ? <UserCheck size={13} aria-hidden="true" /> : <UserPlus size={13} aria-hidden="true" />}
        {on ? 'Following' : 'Follow'}
      </Button>
      {withAlerts && on && f.signedIn && (
        <Button
          size={size}
          variant="ghost"
          aria-pressed={alerts}
          disabled={f.busy}
          onClick={() => f.setAlerts(account, !alerts)}
          title="Telegram alerts from the NEARKITS bot for each swap"
        >
          {alerts ? <Bell size={13} aria-hidden="true" /> : <BellOff size={13} aria-hidden="true" />}
          {alerts ? 'Alerts on' : 'Alerts off'}
        </Button>
      )}
    </span>
  )
}

/** How the figures on a page are made: a panel the reader can open. */
export function Methodology({ title = 'How these figures are made', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium uppercase tracking-[0.06em] text-fg-2 [&::-webkit-details-marker]:hidden">
        <span className="num">› {title}</span>
        <Tag tone="neutral">Methodology</Tag>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line-soft px-4 py-3 text-sm leading-6 text-fg-2 [&_li]:ml-4 [&_li]:list-disc">{children}</div>
    </details>
  )
}

/** A transaction on the explorer, shortened. */
export function TxRef({ hash }: { hash: string }) {
  const caps = useCapabilities()
  if (!caps.explorerUrl) return <span className="num text-xs text-fg-3">{hash.slice(0, 8)}…</span>
  return (
    <a
      href={explorerTxUrl({ explorerUrl: caps.explorerUrl }, hash)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Transaction ${hash} on the explorer`}
      className="num inline-flex items-center gap-1 text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline"
    >
      {hash.slice(0, 8)}…
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

/**
 * Swaps as the box allows (DESIGN.md: tables fit their own box): a table from 34rem whose quieter
 * columns drop out as the panel narrows, a card per swap below that. `show`: the token column (a
 * wallet's swaps) or the wallet column (a token's swaps).
 */
export function TradeRows({ trades, label, show }: { trades: readonly TradeView[]; label: string; show: 'token' | 'wallet' }) {
  const now = useNow(15_000)
  const amount = (t: TradeView) => (
    <>
      {t.amount === null ? '—' : formatAmount(t.amount)} <span className="text-fg-3">{t.symbol ?? ''}</span>
    </>
  )
  const counter = (t: TradeView) => (
    <>
      {t.counterAmount === null ? '—' : formatAmount(t.counterAmount)} <span className="text-fg-3">{t.counterSymbol ?? ''}</span>
    </>
  )
  const who = (t: TradeView) =>
    show === 'wallet' ? (
      TOP_WALLETS_PAUSED ? (
        <span className="num block truncate text-xs text-fg-2" title={t.trader}>
          {t.trader}
        </span>
      ) : (
        <Link to={`/top-wallets/${encodeURIComponent(t.trader)}`} className="num block truncate text-xs text-fg-2 hover:text-fg" title={t.trader}>
          {t.trader}
        </Link>
      )
    ) : (
      <Link to={`/launch-radar/${encodeURIComponent(t.token)}`} className="block truncate text-fg hover:underline" title={t.token}>
        {t.symbol ?? t.token}
      </Link>
    )
  return (
    <div className="@container">
      <div className="hidden @[34rem]:block">
        <Table label={label}>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Side</Th>
              {show === 'token' && <Th>Token</Th>}
              <Th align="right">Amount</Th>
              <Th align="right" className="hidden @[46rem]:table-cell">
                Paid / got
              </Th>
              <Th align="right">USD</Th>
              {show === 'wallet' && <Th className="hidden @[54rem]:table-cell">Wallet</Th>}
              <Th>Tx</Th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <Tr key={`${t.tx}-${i}`}>
                <Td mono className="text-xs text-fg-3">
                  {formatAgo(t.ts, now)}
                </Td>
                <Td>
                  <Tag tone={t.side === 'buy' ? 'accent' : 'neg'}>{t.side}</Tag>
                </Td>
                {show === 'token' && <Td className="max-w-28">{who(t)}</Td>}
                <Td align="right" mono>
                  {amount(t)}
                </Td>
                <Td align="right" mono className="hidden text-fg-2 @[46rem]:table-cell">
                  {counter(t)}
                </Td>
                <Td align="right">
                  <Usd value={t.usd} />
                </Td>
                {show === 'wallet' && <Td className="hidden max-w-44 @[54rem]:table-cell">{who(t)}</Td>}
                <Td>
                  <TxRef hash={t.tx} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y divide-line-soft @[34rem]:hidden" aria-label={label}>
        {trades.map((t, i) => (
          <li key={`${t.tx}-${i}`} className="flex flex-col gap-1 px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone={t.side === 'buy' ? 'accent' : 'neg'}>{t.side}</Tag>
                <span className="num truncate text-sm text-fg">{amount(t)}</span>
              </span>
              <Usd value={t.usd} className="text-sm" />
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
              <span className="num shrink-0 text-fg-3">{formatAgo(t.ts, now)}</span>
              <span className="min-w-0 flex-1 truncate">{who(t)}</span>
              <TxRef hash={t.tx} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
