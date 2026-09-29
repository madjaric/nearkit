import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Page, PageHeader, RequireWallet } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Input, Select } from '@/components/ui/Form'
import { Term } from '@/components/ui/Help'
import { Pct } from '@/components/ui/Num'
import { toneOf } from '@/lib/tone'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { PositionsTable } from '@/features/portfolio/PositionsTable'
import { formatUsd } from '@/lib/format'
import { useCapabilities, usePositions, useWallets } from '@/services/queries'
import { useSettings } from '@/state/contexts'
import type { Position } from '@/types/domain'

/**
 * Re-cut positions to one wallet's share, valued at the same prices. Real PnL is
 * computed per account from its own history, so a position held by several
 * accounts has no single entry to re-cut: its PnL figures become unknown here.
 */
function forWallet(positions: Position[], walletId: string): Position[] {
  return positions.flatMap((p) => {
    const share = p.wallets.find((w) => w.walletId === walletId)
    if (!share) return []
    if (p.pnl !== undefined && p.wallets.length === 1) return [p]
    const valueUsd = p.priceUsd === null ? null : share.amount * p.priceUsd
    if (p.pnl !== undefined) return [{ ...p, balance: share.amount, valueUsd, avgEntryUsd: null, costUsd: null, pnlUsd: null, pnlPct: null, pnl: undefined, wallets: [share] }]
    const costUsd = p.avgEntryUsd === null ? null : share.amount * p.avgEntryUsd
    const pnlUsd = valueUsd !== null && costUsd !== null ? valueUsd - costUsd : null
    const pnlPct = pnlUsd !== null && costUsd ? (pnlUsd / costUsd) * 100 : null
    return [{ ...p, balance: share.amount, valueUsd, costUsd, pnlUsd, pnlPct, wallets: [share] }]
  })
}

/** Sum of the known figures; null when none is known. */
const knownSum = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null)
  return known.length ? known.reduce((s, v) => s + v, 0) : null
}

function Positions() {
  const positions = usePositions()
  const caps = useCapabilities()
  const { data: wallets = [] } = useWallets()
  const { settings } = useSettings()
  const [query, setQuery] = useState('')
  const [walletId, setWalletId] = useState('all')
  const [hideDust, setHideDust] = useState(settings.hideDust)

  const rows = useMemo(() => {
    let list = positions.data ?? []
    if (walletId !== 'all') list = forWallet(list, walletId)
    // Without a price the value is unknown, not dust: keep the row.
    if (hideDust) list = list.filter((p) => p.valueUsd === null || p.valueUsd >= 1)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((p) => p.token.symbol.toLowerCase().includes(q) || p.token.name.toLowerCase().includes(q) || (p.token.contract ?? '').includes(q))
    return list
  }, [positions.data, walletId, hideDust, query])

  const value = knownSum(rows.map((p) => p.valueUsd))
  const unrealized = knownSum(rows.map((p) => p.pnlUsd))
  const ranked = rows.filter((p) => p.pnlPct !== null)
  const best = ranked.reduce<Position | null>((m, p) => (m === null || (p.pnlPct ?? 0) > (m.pnlPct ?? 0) ? p : m), null)
  const worst = ranked.reduce<Position | null>((m, p) => (m === null || (p.pnlPct ?? 0) < (m.pnlPct ?? 0) ? p : m), null)
  const loading = positions.isPending
  const filtered = query !== '' || walletId !== 'all' || hideDust

  return (
    <>
      <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <ReadoutSlot
          className="col-span-2 md:col-span-1"
          size="lg"
          legend="Value"
          loading={loading}
          value={value === null ? <span className="text-fg-4">—</span> : formatUsd(value)}
          sub={value === null && !caps.prices ? 'no USD prices on testnet' : walletId === 'all' ? 'all wallets' : wallets.find((w) => w.id === walletId)?.label}
        />
        <ReadoutSlot
          legend={<Term term="unrealizedPnl" />}
          loading={loading}
          value={unrealized === null ? <span className="text-fg-4">—</span> : <span className={toneOf(unrealized)}>{formatUsd(unrealized, { signed: true })}</span>}
          sub={
            unrealized === null ? (
              caps.pnl ? (
                rows.some((p) => p.pnlStatus === 'loading') ? (
                  'reading history…'
                ) : (
                  '—'
                )
              ) : (
                'cost basis not tracked yet'
              )
            ) : rows.some((p) => p.pnl && !p.pnl.complete) ? (
              'partial: see each row'
            ) : value !== null && value - unrealized > 0 ? (
              <>
                <Pct value={(unrealized / (value - unrealized)) * 100} /> on cost
              </>
            ) : (
              '—'
            )
          }
        />
        <ReadoutSlot legend="Positions" loading={loading} value={rows.length} sub={filtered ? 'matching filters' : 'tokens held'} />
        <ReadoutSlot legend="Best" loading={loading} value={best ? best.token.symbol : '—'} sub={best ? <Pct value={best.pnlPct} /> : ''} />
        <ReadoutSlot
          className="md:col-span-2 xl:col-span-1"
          legend="Worst"
          loading={loading}
          value={worst ? worst.token.symbol : '—'}
          sub={worst ? <Pct value={worst.pnlPct} /> : ''}
        />
      </ReadoutStrip>

      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter positions">
        <div className="relative w-full sm:w-64">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <Input inputSize="sm" aria-label="Filter by token" placeholder="Filter token" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select selectSize="sm" aria-label="Wallet" value={walletId} onChange={(e) => setWalletId(e.target.value)} className="w-full sm:w-48">
          <option value="all">All wallets</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </Select>
        <Checkbox checked={hideDust} onChange={(e) => setHideDust(e.target.checked)} label="Hide balances under $1" labelClassName="text-xs" className="sm:ml-2" />
      </div>

      <Panel>
        <PanelHeader title="Positions" meta={rows.length} actions={<span className="text-[11px] text-fg-3">Expand a row for its PnL, history and wallets</span>} />
        {!loading && rows.length === 0 ? (
          <EmptyState
            title={filtered ? 'No positions match these filters' : 'No positions yet'}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('')
                    setWalletId('all')
                    setHideDust(false)
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {filtered ? 'Try another wallet or clear the token filter.' : 'Buy a token and it appears here with entry, value and PnL.'}
          </EmptyState>
        ) : (
          <PositionsTable positions={rows} loading={loading} expandable={walletId === 'all'} />
        )}
      </Panel>
    </>
  )
}

export default function PositionsPage() {
  const caps = useCapabilities()
  const description =
    caps.mode === 'demo'
      ? 'Every token held across your NearKit wallets, valued at demo prices against your average entry.'
      : caps.prices
        ? 'Every token held across your NearKit wallets, valued at Rhea prices, with cost basis and PnL from your on-chain history (average cost).'
        : `Every token held across your NearKit wallets on ${caps.networkLabel.toLowerCase()}. Testnet tokens have no USD price: each row’s details show PnL in NEAR.`
  return (
    <Page>
      <PageHeader title="Positions" description={description} />
      <RequireWallet feature="Positions">
        <Positions />
      </RequireWallet>
    </Page>
  )
}
