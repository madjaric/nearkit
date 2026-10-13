import { isStale } from '@/lib/freshness'
import { useNow } from '@/lib/hooks'
import { Coins, Layers, PieChart, SendHorizontal, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Sparkline } from '@/components/chart/Sparkline'
import { BalanceRefreshStatus } from '@/components/domain/BalanceRefresh'
import { SimMark } from '@/components/domain/SimMark'
import { DataTag, StatusLamp } from '@/components/domain/Status'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { LoadFailed, Page, PageGrid, PageHeader, SessionEnded } from '@/components/page/Page'
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
import { withBridgeActivity } from '@/features/bridge/activity'
import { useBridgeAvailability, useBridgeOrders } from '@/features/bridge/useBridge'
import { PositionsTable } from '@/features/portfolio/PositionsTable'
import { ValuePanel } from '@/features/portfolio/ValuePanel'
import { QuickTrade } from '@/features/trade/QuickTrade'
import { useKitsFirstToken } from '@/features/trade/useDefaultToken'
import { formatAmount, formatUsd } from '@/lib/format'
import { WEB_SIGN_IN_URL } from '@/lib/telegramLinks'
import { toneOf } from '@/lib/tone'
import { useServices } from '@/services/context'
import { useActivity, useCapabilities, useIdentity, useOrders, usePositions, useSummary, useTokens, useValueHistory } from '@/services/queries'
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

function Readouts() {
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
  return (
    <ReadoutStrip cols="grid-cols-2 xl:grid-cols-[1.5fr_1fr_1fr_1fr]">
      <ReadoutSlot
        className="col-span-2 xl:col-span-1"
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
        legend="Available NEAR"
        aside={<Wallet size={16} aria-hidden="true" />}
        loading={loading}
        value={blank ? ghost('0.00') : formatAmount(s.availableNear, 2)}
        unit={blank ? undefined : 'NEAR'}
        sub={blank ? blankSub : s.availableNearUsd === null ? `Main ${formatAmount(s.mainNear, 2)}` : `≈ ${formatUsd(s.availableNearUsd)}`}
      />
      <ReadoutSlot
        legend="Active positions"
        aside={<PieChart size={16} aria-hidden="true" />}
        loading={loading}
        value={blank ? ghost('0') : s.activePositions}
        sub={blank ? blankSub : `${s.activePositions === 1 ? 'token' : 'tokens'}`}
      />
      <ReadoutSlot
        className="col-span-2 xl:col-span-1"
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
  const { nearkit } = useServices()
  // A browser wallet, a NEARKITS web session, or both: the portfolio is theirs (useIdentity).
  const who = useIdentity()
  const { data: summary } = useSummary()
  const positions = usePositions()
  const activity = useActivity(6)
  // Bridge & Buy orders (NEARKITS' server keeps them) sit in the same list, each linked to its order.
  const bridge = useBridgeOrders(useBridgeAvailability().ok)
  const { promptConnect } = useConnectPrompt()
  const refreshed = caps.mode === 'demo' ? 'Demo · prices move every few seconds' : `${caps.networkLabel} · balances refreshed every 30 s`

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        status={<DataTag />}
        description={
          who.kind === 'signed-in'
            ? `${summary ? `${summary.executableWalletCount} executable ${summary.executableWalletCount === 1 ? 'wallet' : 'wallets'} · ` : ''}${refreshed}`
            : who.kind === 'session-ended'
              ? 'Your NEARKITS web session ended: send /web to the NEARKITS bot to sign in again.'
              : who.kind === 'pending'
                ? refreshed
                : nearkit.available
                  ? 'Connect a wallet or sign in with Telegram to load your portfolio.'
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
              Positions across all of your NEARKITS wallets appear here.
            </EmptyState>
          ) : positions.isError && positions.data === undefined ? (
            <LoadFailed title="Positions can’t be loaded right now" error={positions.error} onRetry={() => void positions.refetch()} />
          ) : (
            <PositionsTable positions={positions.data ?? []} loading={who.kind === 'pending' || positions.isPending} compact />
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Recent activity" actions={<span className="text-[11px] text-fg-3">{caps.mode === 'demo' ? 'Demo history' : 'Sent from this browser'}</span>} />
            <ActivityList items={withBridgeActivity(activity.data ?? [], bridge.orders, 6)} loading={activity.isPending} />
          </Panel>
          <OpenOrdersPanel />
        </div>
      </PageGrid>
    </Page>
  )
}
