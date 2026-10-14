import { isStale } from '@/lib/freshness'
import { useNow } from '@/lib/hooks'
import { Coins, Layers, ListChecks, PieChart, SendHorizontal, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Sparkline } from '@/components/chart/Sparkline'
import { DataTag } from '@/components/domain/Status'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { buttonClass } from '@/components/ui/buttonClass'
import { Figures } from '@/components/ui/Figures'
import { Tag } from '@/components/ui/Indicators'
import { Pct } from '@/components/ui/Num'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { ReadoutSlot, ReadoutStrip } from '@/components/ui/Readout'
import { isComingSoon } from '@/config/release'
import { ActiveStrategiesPanel } from '@/features/dashboard/ActiveStrategiesPanel'
import { AssetsPanel } from '@/features/dashboard/AssetsPanel'
import { FeaturedTools } from '@/features/dashboard/FeaturedTools'
import { kindsCaption } from '@/features/dashboard/strategies'
import { useActiveStrategies, type ActiveStrategies } from '@/features/dashboard/useActiveStrategies'
import { ActivityList } from '@/features/portfolio/ActivityList'
import { withBridgeActivity } from '@/features/bridge/activity'
import { useBridgeAvailability, useBridgeOrders } from '@/features/bridge/useBridge'
import { ValuePanel } from '@/features/portfolio/ValuePanel'
import { useKitsFirstToken } from '@/features/trade/useDefaultToken'
import { formatAmount, formatUsd } from '@/lib/format'
import { toneOf } from '@/lib/tone'
import { useActivity, useCapabilities, useIdentity, useSummary, useValueHistory } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'

/** An action the public beta holds back: kept in place and tagged SOON, but not clickable. */
function SoonKey({ children }: { children: ReactNode }) {
  return (
    <span aria-disabled="true" className="keycap inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-2xs text-fg-2">
      <span className="inline-flex items-center gap-1.5 opacity-40">{children}</span>
      <Tag tone="soon">Soon</Tag>
    </span>
  )
}

/** BUY, SELL, SEND and MULTI BUY: the page's actions, always in view. */
function QuickActions() {
  const { openTrade } = useTradeDrawer()
  const tokenId = useKitsFirstToken()
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

/** Active strategies as a count: what NEARKITS (or the demo) lists, never a guess. */
function strategiesSlot(a: ActiveStrategies, off: boolean): { value: ReactNode; sub: ReactNode } {
  const ghost = (text: string) => <span className="text-fg-4">{text}</span>
  if (a.failed) return { value: ghost('—'), sub: <span className="text-warn">unavailable</span> }
  if (a.source === 'off') {
    const sub =
      a.off === 'session-ended'
        ? 'NEARKITS session ended'
        : a.off === 'signed-out'
          ? 'Sign in to automate'
          : a.off === 'no-session'
            ? 'Run from NEARKITS wallets'
            : 'Automation coming soon'
    return { value: ghost(off ? '0' : '—'), sub }
  }
  const paused = a.paused(a.rows)
  const caption = kindsCaption(a.rows)
  return {
    value: a.rows.length,
    sub: a.rows.length === 0 ? 'none running' : paused > 0 ? `${caption} · ${paused} paused` : (caption ?? ''),
  }
}

function Readouts({ strategies }: { strategies: ActiveStrategies }) {
  // NearKit wallets count too: signed in on NearKit web, with or without a browser wallet (useIdentity).
  const who = useIdentity()
  const caps = useCapabilities()
  const summary = useSummary()
  const history = useValueHistory(7)
  const s = summary.data
  const off = who.kind === 'signed-out'
  const ended = who.kind === 'session-ended'
  // The last read failed and none came before it: nothing is known, so nothing reads as 0.
  const failed = !off && !ended && summary.isError && s === undefined
  const loading = who.kind === 'pending' || (!ended && summary.isPending)
  // No figures: signed out (zeros that ask to connect), the NEARKITS session ended, or the read failed (unknown, never 0).
  const blank = off || ended || failed || !s
  const ghost = (text: string) => <span className="text-fg-4">{off ? text : '—'}</span>
  const blankSub = ended ? 'NEARKITS session ended' : failed ? 'unavailable' : '—'
  const trace = !blank && history.data && history.data.length > 1 ? <Sparkline values={history.data.map((p) => p.valueUsd)} width={84} /> : undefined
  // It refreshes on its own and prints no age; a reading past 20 s dims until the next one lands.
  const now = useNow(5_000)
  const stale = !blank && s ? isStale(s.updatedAt, now) : false
  const partial = s && s.unavailableWalletCount > 0 ? `partial: ${s.unavailableWalletCount} ${s.unavailableWalletCount === 1 ? 'wallet' : 'wallets'} unavailable` : null
  const strat = strategiesSlot(strategies, off)
  return (
    // Phones: the value across, then pairs. From md: a row of three, then two. From xl: one row of five.
    <ReadoutStrip cols="grid-cols-2 md:grid-cols-6 xl:grid-cols-[1.45fr_repeat(4,minmax(0,1fr))]">
      <ReadoutSlot
        className="col-span-2 md:col-span-2 xl:col-span-1"
        size="lg"
        legend="Portfolio value"
        loading={loading}
        value={
          blank ? (
            ghost(caps.prices ? '$0.00' : '—')
          ) : s.valueUsd === null ? (
            <span className="text-fg-4">—</span>
          ) : (
            <span className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'} title={stale ? 'Last value: refreshing' : undefined}>
              {formatUsd(s.valueUsd)}
            </span>
          )
        }
        sub={
          off ? (
            'Connect a wallet'
          ) : ended ? (
            blankSub
          ) : failed ? (
            <span className="text-warn">
              Portfolio can’t be loaded ·{' '}
              <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => void summary.refetch()}>
                Try again
              </button>
            </span>
          ) : !s ? (
            '—'
          ) : partial ? (
            <span className="text-warn">{partial}</span>
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
        className="md:col-span-2 xl:col-span-1"
        legend="Available NEAR"
        aside={<Wallet size={16} aria-hidden="true" />}
        loading={loading}
        value={blank ? ghost('0.00') : formatAmount(s.availableNear, 2)}
        unit={blank ? undefined : 'NEAR'}
        sub={blank ? blankSub : s.availableNearUsd === null ? `Main ${formatAmount(s.mainNear, 2)}` : `≈ ${formatUsd(s.availableNearUsd)}`}
      />
      <ReadoutSlot
        className="md:col-span-2 xl:col-span-1"
        legend="Active positions"
        aside={<PieChart size={16} aria-hidden="true" />}
        loading={loading}
        value={blank ? ghost('0') : s.activePositions}
        sub={blank ? blankSub : `${s.activePositions === 1 ? 'token' : 'tokens'}`}
      />
      <ReadoutSlot
        className="md:col-span-3 xl:col-span-1"
        legend="Active strategies"
        aside={<ListChecks size={16} aria-hidden="true" />}
        loading={strategies.loading}
        value={strat.value}
        sub={strat.sub}
      />
      <ReadoutSlot
        className="md:col-span-3 xl:col-span-1"
        legend="Total wallets"
        aside={<Coins size={16} aria-hidden="true" />}
        loading={loading}
        value={blank ? ghost('0') : s.walletCount}
        sub={
          blank
            ? blankSub
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

function RecentActivityPanel() {
  const caps = useCapabilities()
  const who = useIdentity()
  const activity = useActivity(6)
  // Bridge & Buy orders (NEARKITS' server keeps them) sit in the same list, each linked to its order.
  const bridge = useBridgeOrders(useBridgeAvailability().ok)
  return (
    <Panel aria-labelledby="dash-activity">
      <PanelHeader
        id="dash-activity"
        title="Recent activity"
        actions={
          <span className="text-[11px] text-fg-3">
            {caps.mode === 'demo' ? 'Demo history' : who.kind === 'signed-in' && who.nearkit ? 'This browser and your NEARKITS wallets' : 'Sent from this browser'}
          </span>
        }
      />
      <ActivityList items={withBridgeActivity(activity.data ?? [], bridge.orders, 6)} loading={activity.isPending} />
    </Panel>
  )
}

export default function DashboardPage() {
  const strategies = useActiveStrategies()
  return (
    <Page>
      <PageHeader title="Dashboard" status={<DataTag />} description="Your trading terminal on NEAR." actions={<QuickActions />} />

      <Readouts strategies={strategies} />

      <FeaturedTools strategies={strategies} />

      {/* Performance beside the assets, then strategies beside activity; stacked below 1280px. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <ValuePanel title="Portfolio performance" />
        <AssetsPanel />
        <ActiveStrategiesPanel strategies={strategies} />
        <RecentActivityPanel />
      </div>
    </Page>
  )
}
