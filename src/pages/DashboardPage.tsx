import { Coins, Layers, PieChart, SendHorizontal, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Sparkline } from '@/components/chart/Sparkline'
import { BalanceRefreshStatus } from '@/components/domain/BalanceRefresh'
import { Freshness } from '@/components/domain/Freshness'
import { SimMark } from '@/components/domain/SimMark'
import { DataTag, StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Page, PageGrid, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { EmptyState } from '@/components/ui/EmptyState'
import { Figures } from '@/components/ui/Figures'
import { Tag } from '@/components/ui/Indicators'
import { Pct, Price } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { isComingSoon } from '@/config/release'
import { KitSpotlight } from '@/features/kit/KitSpotlight'
import { ActivityList } from '@/features/portfolio/ActivityList'
import { PositionsTable } from '@/features/portfolio/PositionsTable'
import { ValuePanel } from '@/features/portfolio/ValuePanel'
import { QuickTrade } from '@/features/trade/QuickTrade'
import { useDefaultTradeToken } from '@/features/trade/useDefaultToken'
import { formatAmount, formatUsd } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import { useActivity, useCapabilities, useNearKitSession, useOrders, usePositions, useSession, useSummary, useTokens, useValueHistory } from '@/services/queries'
import { useConnectPrompt, useTradeDrawer } from '@/state/contexts'

const linkKey = 'keycap inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-2xs text-fg-2 transition-colors hover:bg-raised hover:text-fg'

/** An action the public beta holds back: kept in place and tagged SOON, but not clickable. */
function SoonKey({ children }: { children: ReactNode }) {
  return (
    <span aria-disabled="true" className="keycap inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-2xs text-fg-2">
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

/** BUY, SELL, SEND and MULTI BUY: the page's actions, always in view. */
function QuickActions() {
  const { openTrade } = useTradeDrawer()
  const tokenId = useDefaultTradeToken()
  const multiSoon = isComingSoon('/multi-trade')
  return (
    <>
      <Button variant="primary" size="lg" onClick={() => openTrade({ tokenId, side: 'buy' })}>
        Buy
      </Button>
      <Button variant="secondary" size="lg" onClick={() => openTrade({ tokenId, side: 'sell' })}>
        Sell
      </Button>
      <Link to="/batch-send" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
        <SendHorizontal size={15} aria-hidden="true" /> Send
      </Link>
      {multiSoon ? (
        <SoonKey>
          <Layers size={14} aria-hidden="true" /> Multi buy
        </SoonKey>
      ) : (
        <Link to="/multi-trade" className={buttonClass({ variant: 'secondary', size: 'lg' })}>
          <Layers size={15} aria-hidden="true" /> Multi buy
        </Link>
      )}
    </>
  )
}

function Readouts() {
  const { data: session } = useSession()
  // NearKit wallets count too: signed in on NearKit web, with or without a browser wallet.
  const nearkitSession = useNearKitSession()
  const caps = useCapabilities()
  const summary = useSummary()
  const history = useValueHistory(7)
  const zeroUsd = caps.prices ? '$0.00' : '—'
  const s = summary.data
  const loading = summary.isPending
  const off = !session && !nearkitSession
  const trace = !off && history.data && history.data.length > 1 ? <Sparkline values={history.data.map((p) => p.valueUsd)} width={84} /> : undefined
  return (
    <ReadoutStrip cols="grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr_1fr]">
      <ReadoutSlot
        className="col-span-2 xl:col-span-1"
        size="lg"
        legend="Portfolio value"
        aside={!off && s ? <Freshness at={s.updatedAt} /> : undefined}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">{zeroUsd}</span> : s.valueUsd === null ? <span className="text-fg-4">—</span> : formatUsd(s.valueUsd)}
        sub={
          off || !s ? (
            'Connect a wallet'
          ) : s.valueUsd === null ? (
            'no USD prices on testnet'
          ) : s.pnl24hPct === null ? (
            `across ${s.executableWalletCount} executable ${s.executableWalletCount === 1 ? 'wallet' : 'wallets'}`
          ) : (
            <span className={toneOf(s.pnl24hUsd ?? 0)}>
              <Pct value={s.pnl24hPct} /> <Figures>(24h)</Figures>
            </span>
          )
        }
        trace={trace}
      />
      <ReadoutSlot
        legend="Available NEAR"
        aside={<Wallet size={16} aria-hidden="true" />}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">0.00</span> : formatAmount(s.availableNear, 2)}
        unit={off || !s ? undefined : 'NEAR'}
        sub={off || !s ? '—' : s.availableNearUsd === null ? `Main ${formatAmount(s.mainNear, 2)}` : `≈ ${formatUsd(s.availableNearUsd)}`}
      />
      <ReadoutSlot
        legend="Active positions"
        aside={<PieChart size={16} aria-hidden="true" />}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">0</span> : s.activePositions}
        sub={off || !s ? '—' : `${s.activePositions === 1 ? 'token' : 'tokens'}`}
      />
      <ReadoutSlot
        className="col-span-2 xl:col-span-1"
        legend="Total wallets"
        aside={<Coins size={16} aria-hidden="true" />}
        loading={loading}
        value={off || !s ? <span className="text-fg-4">0</span> : s.walletCount}
        sub={
          off || !s
            ? '—'
            : caps.mode === 'demo'
              ? 'demo wallets'
              : s.walletCount > s.executableWalletCount
                ? `${s.executableWalletCount} executable · ${s.walletCount - s.executableWalletCount} watch-only`
                : 'NEARKITS and connected wallets'
        }
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
                <TokenGlyph symbol={token?.symbol ?? '?'} tokenId={o.tokenId} size={24} />
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
            ? `${summary ? `${summary.executableWalletCount} executable ${summary.executableWalletCount === 1 ? 'wallet' : 'wallets'} · ` : ''}${caps.mode === 'demo' ? 'Demo · prices move every few seconds' : `${caps.networkLabel} · balances refreshed every 30 s`}`
            : 'Connect a wallet to load your portfolio.'
        }
        actions={<QuickActions />}
      />

      <Readouts />

      <KitSpotlight />

      <PageGrid aside={<QuickTrade />} asideWidth={380} asideFirst stickyAside>
        <ValuePanel />

        <Panel>
          <PanelHeader
            title="Positions"
            meta={positions.data ? positions.data.length : undefined}
            actions={
              <>
                <BalanceRefreshStatus />
                <Link to="/positions" className={linkKey}>
                  All positions
                </Link>
              </>
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
              Positions across all of your NEARKITS wallets appear here.
            </EmptyState>
          ) : (
            <PositionsTable positions={positions.data ?? []} loading={positions.isPending} compact />
          )}
        </Panel>

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
