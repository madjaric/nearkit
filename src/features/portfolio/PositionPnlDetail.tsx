import { Share2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Tag } from '@/components/ui/Indicators'
import { Pct, Usd } from '@/components/ui/Num'
import { toneOf } from '@/lib/tone'
import { cn } from '@/lib/cn'
import { formatCompact, formatDateTime, formatNumber } from '@/lib/format'
import { explorerTxUrl } from '@/services/near/explorer'
import { useCapabilities, useWallets } from '@/services/queries'
import type { PnlFiguresView, Position } from '@/types/domain'
import { cardFromPosition, type PnlCard } from './pnlCard'
import { PnlCardDialog } from './PnlCardDialog'
import { LIMITATION_TEXT } from './pnlText'

/**
 * One position's PnL, as the engine (src/lib/pnl.ts) computed it: exact NEAR figures,
 * USD at each trade's hour, what's missing and why, and the transactions behind it.
 */

function Near({ value, signed = false }: { value: number | null; signed?: boolean }) {
  if (value === null) return <span className="num text-fg-4">—</span>
  const text = `${signed && value > 0 ? '+' : ''}${formatNumber(value, 0, Math.abs(value) < 1 ? 5 : 3)} NEAR`
  return <span className={cn('num', signed && toneOf(value))}>{text}</span>
}

function Figures({ label, f, currency }: { label: string; f: PnlFiguresView; currency: 'NEAR' | 'USD' }) {
  const money = (v: number | null, signed = false) => (currency === 'NEAR' ? <Near value={v} signed={signed} /> : <Usd value={v} signed={signed} colored={signed} />)
  const rows: [string, ReactNode][] = [
    ['Cost basis', money(f.costBasis)],
    ['Avg entry', f.avgEntry === null ? <span className="num text-fg-4">—</span> : currency === 'NEAR' ? <Near value={f.avgEntry} /> : <Usd value={f.avgEntry} />],
    ['Realized', money(f.realized, true)],
    ['Unrealized', money(f.unrealized, true)],
    ['Total', money(f.total, true)],
    ['Return', <Pct key="p" value={f.pnlPct} />],
  ]
  return (
    <div className="min-w-0">
      <p className="mb-1 flex items-center gap-2 text-2xs uppercase tracking-legend text-fg-3">
        {label}
        {!f.complete && <Tag tone="warn">Partial</Tag>}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-3">{k}</dt>
            <dd className="text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function PositionPnlDetail({ position }: { position: Position }) {
  const caps = useCapabilities()
  const { data: wallets = [] } = useWallets()
  /** When the card was opened: its "as of" time. */
  const [sharedAt, setSharedAt] = useState<number | null>(null)
  const pnl = position.pnl
  if (position.pnlStatus === 'loading') return <p className="text-xs text-fg-3">Reading this position’s on-chain history…</p>
  if (!pnl) return null
  const kind = { buy: 'Buy', sell: 'Sell', 'transfer-in': 'Received', 'transfer-out': 'Sent' } as const
  const card = (at: number) => cardFromPosition(position, { usd: caps.prices, network: caps.network, demo: caps.mode === 'demo', at })
  const accounts = [...new Set(position.wallets.map((w) => wallets.find((x) => x.id === w.walletId)?.accountId ?? w.walletId))]
  return (
    <div className="flex flex-col gap-3 py-1">
      {card(0) && (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" icon={<Share2 size={13} />} onClick={() => setSharedAt(Date.now())} aria-label={`Share ${position.token.symbol} PnL card`}>
            Share card
          </Button>
        </div>
      )}
      {sharedAt !== null && card(sharedAt) && <PnlCardDialog card={card(sharedAt) as PnlCard} accounts={accounts} onClose={() => setSharedAt(null)} />}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Figures label="In NEAR · exact" f={pnl.near} currency="NEAR" />
        {caps.prices && <Figures label="In USD · at each trade’s hour" f={pnl.usd} currency="USD" />}
      </div>
      <p className="text-[11px] text-fg-3">
        Average cost, per account. Bought {formatCompact(pnl.bought.amount, 2)}, sold {formatCompact(pnl.sold.amount, 2)} in {pnl.trades} {pnl.trades === 1 ? 'trade' : 'trades'}.
        Fees are inside each trade’s value.
        {pnl.unknownCostAmount > 0 && ` ${formatCompact(pnl.unknownCostAmount, 2)} ${position.token.symbol} held with unknown cost.`}
      </p>
      {pnl.limitations.length > 0 && (
        <ul className="flex flex-col gap-1 text-[11px] text-warn">
          {pnl.limitations.map((l) => (
            <li key={l}>{LIMITATION_TEXT[l]}</li>
          ))}
        </ul>
      )}
      {pnl.history.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" aria-label={`${position.token.symbol} transactions`}>
            <tbody>
              {pnl.history.slice(0, 8).map((h) => (
                <tr key={`${h.tx}:${h.accountId}:${h.kind}`} className="border-t border-line-soft">
                  <td className="whitespace-nowrap py-1 pr-3 text-fg-3">{formatDateTime(h.at)}</td>
                  <td className="py-1 pr-3 text-fg-2">{kind[h.kind]}</td>
                  <td className="num py-1 pr-3 text-right text-fg">{formatCompact(h.amount, 2)}</td>
                  <td className="py-1 pr-3 text-right">{h.valueNear !== null ? <Near value={h.valueNear} /> : <span className="text-fg-4">{h.counterparty ?? '—'}</span>}</td>
                  <td className="py-1 text-right">
                    {caps.explorerUrl && (
                      <a
                        href={explorerTxUrl({ explorerUrl: caps.explorerUrl }, h.tx)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-fg-3 underline-offset-2 hover:text-fg hover:underline"
                      >
                        tx
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
