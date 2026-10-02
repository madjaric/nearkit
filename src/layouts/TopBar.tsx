import { ChevronDown, Coins, ExternalLink, LogOut, Menu as MenuIcon, Search, Settings, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useNavigation } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { BalanceRefreshStatus } from '@/components/domain/BalanceRefresh'
import { Freshness } from '@/components/domain/Freshness'
import { Button, IconButton } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/Copy'
import { Figures } from '@/components/ui/Figures'
import { Tip } from '@/components/ui/Floating'
import { Led, Skeleton, Tag } from '@/components/ui/Indicators'
import { Menu } from '@/components/ui/Menu'
import { Pct } from '@/components/ui/Num'
import { useToast } from '@/components/ui/toast-context'
import { cn } from '@/lib/cn'
import { formatAccount, formatAmount, formatPrice } from '@/lib/format'
import { usePrevious } from '@/lib/hooks'
import { useNetworkWording } from '@/lib/modeCopy'
import { useCapabilities, useDisconnect, useNearPrice, useSession, useSummary } from '@/services/queries'
import { useConnectPrompt } from '@/state/contexts'
import { GlobalSearch } from './GlobalSearch'

export function NearTicker({ className, showAge = false }: { className?: string; showAge?: boolean }) {
  const { data, isPending } = useNearPrice()
  const previous = usePrevious(data?.priceUsd)
  const dir = data && previous !== undefined ? (data.priceUsd > previous ? 'up' : data.priceUsd < previous ? 'down' : null) : null
  return (
    <div className={cn('min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap', className)} aria-label="NEAR price">
      <span className="legend max-[339px]:hidden">NEAR/USD</span>
      {data ? (
        <>
          <span key={data.updatedAt} className={cn('num text-sm text-fg', dir === 'up' && 'animate-tick-up', dir === 'down' && 'animate-tick-down')}>
            ${formatPrice(data.priceUsd)}
          </span>
          <Pct value={data.change24hPct} className="text-xs" />
          {showAge && <Freshness at={data.updatedAt} />}
        </>
      ) : isPending ? (
        <Skeleton className="h-4 w-20 self-center" />
      ) : (
        <Tip content="Testnet NEAR has no market price, so NearKit shows no USD values on testnet.">
          <span tabIndex={0} className="num text-sm text-fg-4">
            —
          </span>
        </Tip>
      )}
    </div>
  )
}

/** The network readout: a bordered chip in the top bar, flat (`bare`) where a bar already frames it. */
export function NetworkChip({ bare = false }: { bare?: boolean }) {
  const caps = useCapabilities()
  const network = useNetworkWording()
  const demo = caps.mode === 'demo'
  const viewOnly = !demo && !caps.execution.enabled
  const tip = demo
    ? 'Demo: prices, balances and history are simulated, and nothing is sent on chain.'
    : viewOnly
      ? (caps.execution.reason ?? 'Execution is disabled in this build.')
      : network.beta
        ? 'NearKit public testnet beta. Testnet tokens have no value, and mainnet execution is off in this build. You sign every transaction in your wallet, and NearKit confirms it on chain.'
        : `NEAR ${network.name}. You sign every transaction in your wallet, and NearKit confirms it on chain.`
  return (
    <Tip content={tip}>
      <span tabIndex={0} className={cn('flex shrink-0 items-center gap-2', bare ? 'h-7' : 'h-10 rounded-md border border-line bg-panel px-3')}>
        <Led tone={demo ? 'idle' : viewOnly ? 'warn' : 'on'} />
        <span className="text-xs font-semibold tracking-[0.07em] text-fg-2" style={{ fontStretch: '90%' }}>
          NEAR
        </span>
        <Tag tone={demo ? 'neutral' : caps.network === 'mainnet' ? 'accent' : 'neutral'}>{network.tag}</Tag>
        {viewOnly && <Tag tone="soon">View only</Tag>}
      </span>
    </Tip>
  )
}

function WalletButton() {
  const caps = useCapabilities()
  const { data: session, isPending } = useSession()
  const { data: summary } = useSummary()
  const { promptConnect } = useConnectPrompt()
  const disconnect = useDisconnect()
  const navigate = useNavigate()
  const toast = useToast()

  if (isPending) return <Skeleton className="h-10 w-36" />
  if (!session)
    return (
      // A phone's bar has room for a 36px key; under 360px the label drops to its verb.
      <Button variant="primary" size="lg" aria-label="Connect wallet" className="max-sm:h-9 max-sm:px-4 max-sm:text-xs" onClick={promptConnect}>
        <span>
          Connect<span className="max-[359px]:hidden"> wallet</span>
        </span>
      </Button>
    )

  return (
    <Menu
      label="Wallet"
      header={
        <div className="mb-1 border-b border-line-soft px-3 pb-3 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="legend flex items-center gap-1.5">
              <Led tone={session.issue ? 'warn' : 'on'} /> {caps.mode === 'demo' ? 'Connected · demo' : `Connected · ${session.walletName ?? 'wallet'}`}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <span className="num truncate text-sm text-fg">{session.accountId}</span>
            <CopyButton value={session.accountId} label="Copy account ID" />
          </div>
          {session.issue ? (
            <p className="mt-1 text-xs text-warn">
              {session.issue === 'network-mismatch'
                ? `This account is not on ${caps.networkLabel.toLowerCase()}. Connect another one.`
                : `Not found on ${caps.networkLabel.toLowerCase()} yet. Fund it first.`}
            </p>
          ) : (
            summary && (
              <p className="mt-1 text-xs text-fg-3">
                <Figures>{`${summary.walletCount} wallets · ${formatAmount(summary.availableNear, 2)} NEAR available`}</Figures>
              </p>
            )
          )}
        </div>
      }
      entries={[
        { label: 'Wallets & presets', icon: <Wallet size={15} />, onSelect: () => navigate('/wallets') },
        { label: 'Positions', icon: <Coins size={15} />, onSelect: () => navigate('/positions') },
        { label: 'Settings', icon: <Settings size={15} />, onSelect: () => navigate('/settings') },
        ...(session.explorerUrl
          ? [{ label: 'View on explorer', icon: <ExternalLink size={15} />, onSelect: () => void window.open(session.explorerUrl ?? '', '_blank', 'noopener,noreferrer') }]
          : []),
        { kind: 'divider' },
        {
          label: 'Disconnect',
          icon: <LogOut size={15} />,
          tone: 'danger',
          onSelect: () =>
            disconnect.mutate(undefined, {
              onSuccess: () =>
                toast.push({
                  title: 'Disconnected',
                  detail: caps.mode === 'demo' ? 'Connect the demo account again from the top bar.' : 'The wallet session ended in this browser. Nothing changed on chain.',
                }),
            }),
        },
      ]}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          title={session.accountId}
          className="flex h-10 min-w-0 max-w-[14rem] items-center gap-2 rounded-md border border-line bg-panel px-3 transition-colors hover:border-line-strong aria-expanded:border-line-strong max-sm:gap-1.5 max-sm:px-2.5"
        >
          <Led tone={session.issue ? 'warn' : 'on'} />
          <span className="num truncate text-sm text-fg">{formatAccount(session.accountId, 20)}</span>
          <ChevronDown size={13} className="shrink-0 text-fg-3" aria-hidden="true" />
        </button>
      )}
    />
  )
}

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const navigation = useNavigation()
  const [searching, setSearching] = useState(false)

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas">
      <div className="flex h-16 items-center gap-2 px-3 lg:gap-4 lg:px-6">
        {searching ? (
          <>
            <GlobalSearch autoFocus onDone={() => setSearching(false)} className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setSearching(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <IconButton label="Open navigation" onClick={onOpenNav} className="-ml-1 lg:hidden">
              <MenuIcon size={18} />
            </IconButton>
            <Link to="/" className="flex items-center gap-2 lg:hidden" aria-label="NearKit dashboard">
              {/* Phones drop the mark so the connected account prints in full. */}
              <LogoMark size={20} className="hidden sm:block" />
              <Wordmark />
            </Link>
            <div className="hidden max-w-[480px] flex-1 lg:block">
              <GlobalSearch />
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2 lg:gap-3">
              <IconButton label="Search" onClick={() => setSearching(true)} className="lg:hidden">
                <Search size={17} />
              </IconButton>
              <BalanceRefreshStatus terse />
              <NearTicker className="hidden sm:flex" showAge />
              <div className="hidden md:block">
                <NetworkChip />
              </div>
              <WalletButton />
            </div>
          </>
        )}
      </div>
      {navigation.state === 'loading' && (
        <div className="absolute inset-x-0 -bottom-px h-px overflow-hidden" role="progressbar" aria-label="Loading page">
          <span className="block h-full w-1/4 animate-scan bg-accent" />
        </div>
      )}
    </header>
  )
}

/** Phone status strip: the ticker and network readout that the top bar has no room for. */
export function StatusStrip() {
  return (
    <div className="flex h-11 items-center justify-between gap-3 border-b border-line-soft bg-well px-4 sm:hidden">
      <NearTicker className="flex" showAge />
      <NetworkChip bare />
    </div>
  )
}
