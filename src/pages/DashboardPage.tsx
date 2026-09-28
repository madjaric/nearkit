import { Layers, SendHorizontal, Split } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Freshness } from '@/components/domain/Freshness'
import { SimMark } from '@/components/domain/SimMark'
import { DataTag, StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Page, PageGrid, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Term } from '@/components/ui/Help'
import { Tag } from '@/components/ui/Indicators'
import { Pct, Price, Usd } from '@/components/ui/Num'
import { toneOf } from '@/lib/tone'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { ActivityList } from '@/features/portfolio/ActivityList'
import { PositionsTable } from '@/features/portfolio/PositionsTable'
import { ValuePanel } from '@/features/portfolio/ValuePanel'
import { QuickTrade } from '@/features/trade/QuickTrade'
import { formatAmount, formatUsd } from '@/lib/format'
import { useActivity, useCapabilities, useOrders, usePositions, useSession, useSummary, useTokens } from '@/services/queries'
import { useConnectPrompt } from '@/state/contexts'
import { isComingSoon } from '@/config/release'

const linkKey = 'keycap inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-2xs text-fg-2 transition-colors hover:bg-raised hover:text-fg'

/** An action the public beta holds back: kept in place and tagged SOON, but not clickable. */
function SoonKey({ children }: { children: ReactNode }) {
  return (
    <span aria-disabled="true" className="keycap inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-2xs text-fg-2">
      <span className="inline-flex items-center gap-1.5 opacity-40">{children}</span>
      <Tag tone="soon">Soon</Tag>
    </span>
  )
}

/** Orders the page lists: live ones in the demo, local drafts in real mode (nothing executes them). */
function useOrderView() {
  const caps = useCapabilities()
  const demo = caps.mode === 'demo'
  return { demo, status: demo ? ('open' as const) : ('draft' as const), noun: demo ? 'Open orders' : 'Order drafts' }
}

function Readouts() {
  const { data: session } = useSession()
  const caps = useCapabilities()
  const view = useOrderView()
  const summary = useSummary()
  const { data: orders = [] } = useOrders()
  const open = orders.filter((o) => o.status === view.status)
  const zeroUsd = caps.prices ? '$0.00' : '—'
  const byType = (type: string) => open.filter((o) => o.type === type).length
  const s = summary.data
  const loading = summary.isPending
  const off = !session
  return (
    <ReadoutStrip cols="grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <ReadoutSlot
        className="col-span-2 md:col-span-1"
        size="lg"
        legend="Portfolio value"
        aside={!off && s ? <Freshness at={s.updatedAt} /> : undefined}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">{zeroUsd}</span> : s.valueUsd === null ? <span className="text-fg-4">—</span> : formatUsd(s.valueUsd)}
        sub={off || !s ? 'Connect a wallet' : s.valueUsd === null ? 'no USD prices on testnet' : `across ${s.walletCount} wallets`}
      />
      <ReadoutSlot
        legend="24h PnL"
        loading={loading}
        value={
          off || !s ? (
            <span className="text-fg-4">{zeroUsd}</span>
          ) : s.pnl24hUsd === null ? (
            <span className="text-fg-4">—</span>
          ) : (
            <span className={toneOf(s.pnl24hUsd)}>{formatUsd(s.pnl24hUsd, { signed: true })}</span>
          )
        }
        sub={
          off || !s ? (
            '—'
          ) : s.pnl24hPct === null ? (
            'not tracked yet'
          ) : (
            <>
              <Pct value={s.pnl24hPct} /> <Figures>vs 24h ago</Figures>
            </>
          )
        }
      />
      <ReadoutSlot
        legend="Available NEAR"
        loading={loading}
        value={
          off || !s ? (
            <span className="text-fg-4">0.00</span>
          ) : (
            <>
              {formatAmount(s.availableNear, 2)} <span className="font-sans text-sm font-medium text-fg-3">NEAR</span>
            </>
          )
        }
        sub={off || !s ? '—' : s.availableNearUsd === null ? `Main ${formatAmount(s.mainNear, 2)}` : `≈ ${formatUsd(s.availableNearUsd)} · Main ${formatAmount(s.mainNear, 2)}`}
      />
      <ReadoutSlot
        legend="Active positions"
        loading={loading}
        value={off || !s ? <span className="text-fg-4">0</span> : s.activePositions}
        sub={
          off || !s ? (
            '—'
          ) : (
            <span>
              <Term term="unrealizedPnl">Unrealized</Term> <Usd value={s.unrealizedPnlUsd} signed colored />
            </span>
          )
        }
      />
      <ReadoutSlot
        className="md:col-span-2 xl:col-span-1"
        legend={view.noun}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">0</span> : view.demo ? s.openOrders : open.length}
        sub={off ? '—' : view.demo ? `${byType('limit')} limit · ${byType('take-profit')} TP · ${byType('stop-loss')} SL` : 'saved here, not monitored'}
      />
    </ReadoutStrip>
  )
}

function OpenOrdersPanel() {
  const orders = useOrders()
  const view = useOrderView()
  const { data: tokens = [] } = useTokens()
  const open = (orders.data ?? []).filter((o) => o.status === view.status).slice(0, 4)
  return (
    <Panel>
      <PanelHeader
        title={view.noun}
        meta={orders.data ? open.length : undefined}
        actions={
          <Link to="/limit-orders" className={linkKey}>
            Manage
            {isComingSoon('/limit-orders') && <Tag tone="soon">Soon</Tag>}
          </Link>
        }
      />
      {open.length === 0 ? (
        <EmptyState
          title={view.demo ? 'No open orders' : 'No order drafts'}
          graphic={false}
          action={
            isComingSoon('/limit-orders') ? (
              <SoonKey>Place a limit order</SoonKey>
            ) : (
              <Link to="/limit-orders" className={linkKey}>
                Place a limit order
              </Link>
            )
          }
        >
          {view.demo ? 'Limit, take-profit and stop-loss orders appear here.' : 'Limit, take-profit and stop-loss drafts you save appear here. Nothing executes them yet.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-soft">
          {open.map((o) => {
            const token = tokens.find((t) => t.id === o.tokenId)
            const price = token?.market?.priceUsd ?? 0
            const distance = price ? ((o.triggerPriceUsd - price) / price) * 100 : 0
            return (
              <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                <TokenGlyph symbol={token?.symbol ?? '?'} tokenId={o.tokenId} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <Tag tone={o.side === 'buy' ? 'accent' : 'neg'}>{o.side}</Tag>
                    <span className="font-medium text-fg">{token?.symbol}</span>
                    <span className="text-xs text-fg-3">{o.type === 'limit' ? 'Limit' : o.type === 'take-profit' ? 'Take profit' : 'Stop loss'}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    at <Price value={o.triggerPriceUsd} className="text-fg-2" /> · <Pct value={distance} colored={false} /> from market
                    {token?.status === 'prelaunch' && <SimMark />}
                  </div>
                </div>
                <StatusLamp status={view.status} />
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

export default function DashboardPage() {
  const caps = useCapabilities()
  const { data: session } = useSession()
  const { data: summary } = useSummary()
  const positions = usePositions()
  const activity = useActivity(6)
  const { promptConnect } = useConnectPrompt()

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        status={<DataTag />}
        description={
          session
            ? `${session.accountId}${summary ? ` · ${summary.walletCount} wallets` : ''} · ${caps.mode === 'demo' ? 'demo prices move every few seconds' : `${caps.networkLabel.toLowerCase()} balances, refreshed every 30 s`}`
            : 'Connect a wallet to load your portfolio.'
        }
        actions={
          <>
            {isComingSoon('/multi-trade') ? (
              <SoonKey>
                <Layers size={14} aria-hidden="true" /> Multi buy
              </SoonKey>
            ) : (
              <Link to="/multi-trade" className={linkKey}>
                <Layers size={14} aria-hidden="true" /> Multi buy
              </Link>
            )}
            <Link to="/split" className={linkKey}>
              <Split size={14} aria-hidden="true" /> Split
            </Link>
            <Link to="/batch-send" className={linkKey}>
              <SendHorizontal size={14} aria-hidden="true" /> Batch send
            </Link>
          </>
        }
      />

      <Readouts />

      <PageGrid aside={<QuickTrade />} asideWidth={372} asideFirst stickyAside>
        <Panel>
          <PanelHeader
            title="Positions"
            meta={positions.data ? positions.data.length : undefined}
            actions={
              <Link to="/positions" className={linkKey}>
                All positions
              </Link>
            }
          />
          {!session ? (
            <EmptyState
              title="No wallet connected"
              action={
                <Button variant="primary" onClick={promptConnect}>
                  Connect wallet
                </Button>
              }
            >
              Positions across all of your NearKit wallets appear here.
            </EmptyState>
          ) : (
            <PositionsTable positions={positions.data ?? []} loading={positions.isPending} compact />
          )}
        </Panel>

        <ValuePanel />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Recent activity" actions={<span className="text-[11px] text-fg-3">{caps.mode === 'demo' ? 'Demo history' : 'Sent from this browser'}</span>} />
            <ActivityList items={activity.data ?? []} loading={activity.isPending} />
          </Panel>
          <OpenOrdersPanel />
        </div>
      </PageGrid>
    </Page>
  )
}
