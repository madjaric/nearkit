import { ArrowRight } from 'lucide-react'
import { NavLink } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { SocialLinks } from '@/components/brand/Social'
import { Led, Tag } from '@/components/ui/Indicators'
import { KIT } from '@/config/kit'
import { useKitsFirstToken } from '@/features/trade/useDefaultToken'
import { cn } from '@/lib/cn'
import { useNetworkWording } from '@/lib/modeCopy'
import { useCapabilities } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import { isNavAction, NAV_ALL_TOOLS, NAV_GROUPS, NAV_HOME, NAV_MAIN, type NavAction, type NavItem } from './nav'
import { useIsSoon } from './navState'

/** What this build runs on, short enough for the sidebar's footer row; the network chip says the rest. */
function BuildStatus() {
  const caps = useCapabilities()
  const network = useNetworkWording()
  if (caps.mode === 'demo') {
    return (
      <span className="flex min-w-0 items-center gap-1.5" title="Demo: simulated, nothing is sent">
        <Led tone="idle" />
        <span className="truncate">Demo</span>
      </span>
    )
  }
  const live = caps.execution.enabled
  const text = `${caps.network === 'mainnet' ? 'Mainnet' : 'Testnet'} · ${live ? 'live' : 'view only'}`
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`NEAR ${network.name} · ${live ? 'live' : 'view only'}`}>
      <Led tone={live ? 'on' : 'warn'} />
      <span className="truncate">{text}</span>
    </span>
  )
}

const entryBase = 'group relative flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-base transition-colors duration-100'
const entryOn = 'bg-raised text-fg before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent'
const entryOff = 'text-fg-2 hover:bg-raised/60 hover:text-fg'
const iconOn = 'text-accent'
const iconOff = 'text-fg-3 group-hover:text-fg-2'

function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const isSoon = useIsSoon()
  const Icon = item.icon
  return (
    <li>
      <NavLink to={item.to} end={item.end} onClick={onNavigate} title={item.description} className={({ isActive }) => cn(entryBase, isActive ? entryOn : entryOff)}>
        {({ isActive }) => (
          <>
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', isActive ? iconOn : iconOff)} />
            <span className="flex-1 truncate">{item.label}</span>
            {isSoon(item) && <Tag tone="soon">Soon</Tag>}
          </>
        )}
      </NavLink>
    </li>
  )
}

/** Group label above a run of entries. */
function GroupLegend({ label }: { label: string }) {
  return (
    <div className="legend px-2.5 pb-1" aria-hidden="true">
      {label}
    </div>
  )
}

/** Opens the Quick Trade ticket over the current page, on Quick Trade's token ($KITS where it trades). */
function QuickTradeEntry({ entry, onNavigate }: { entry: NavAction; onNavigate?: () => void }) {
  const { openTrade } = useTradeDrawer()
  const tokenId = useKitsFirstToken()
  const Icon = entry.icon
  return (
    <li>
      <button
        type="button"
        title={entry.description}
        onClick={() => {
          onNavigate?.()
          openTrade({ tokenId, side: 'buy' })
        }}
        className={cn(entryBase, entryOff, 'w-full text-left')}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', iconOff)} />
        <span className="flex-1 truncate">{entry.label}</span>
      </button>
    </li>
  )
}

/** $KITS keeps its own mark and mono ticker, right under the Dashboard: Live where the build has its contract, Mainnet on testnet. */
function KitEntry({ onNavigate }: { onNavigate?: () => void }) {
  const live = KIT.status === 'live'
  return (
    <li>
      <NavLink to={KIT.links.page} onClick={onNavigate} title="The NEARKITS token" className={({ isActive }) => cn(entryBase, isActive ? entryOn : entryOff)}>
        <LogoMark size={16} />
        <span className="num flex-1 text-sm tracking-[0.02em]">{KIT.ticker}</span>
        {live ? <Tag tone="accent">Live</Tag> : <Tag>Mainnet</Tag>}
      </NavLink>
    </li>
  )
}

/** The sidebar's last entry: the searchable directory of every tool. */
function AllToolsEntry({ onNavigate }: { onNavigate?: () => void }) {
  const Icon = NAV_ALL_TOOLS.icon
  return (
    <NavLink
      to={NAV_ALL_TOOLS.to}
      onClick={onNavigate}
      title={NAV_ALL_TOOLS.description}
      className={({ isActive }) =>
        cn(
          'group flex h-10 items-center gap-2.5 rounded-sm border px-3 text-base transition-colors duration-100',
          isActive ? 'border-accent/45 bg-raised text-fg' : 'border-line text-fg-2 hover:border-accent/45 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', isActive ? iconOn : iconOff)} />
          <span className="flex-1 truncate">{NAV_ALL_TOOLS.label}</span>
          <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-fg-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-accent" />
        </>
      )}
    </NavLink>
  )
}

/**
 * Navigation body shared by the desktop sidebar and the phone drawer: every group in its fixed
 * order with all of its entries (one this build doesn't run yet carries a SOON tag in place, so
 * nothing moves when it goes live), MAIN first with the Dashboard and $KITS ahead of its own
 * entries, and All Tools pinned below the scrolling list.
 */
export function NavBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Main" className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className={group === NAV_MAIN ? undefined : 'mt-3'} role="group" aria-label={group.label}>
            <GroupLegend label={group.label} />
            <ul className="flex flex-col gap-px">
              {group === NAV_MAIN && (
                <>
                  <NavEntry item={NAV_HOME} onNavigate={onNavigate} />
                  <KitEntry onNavigate={onNavigate} />
                </>
              )}
              {group.items.map((item) =>
                isNavAction(item) ? <QuickTradeEntry key={item.action} entry={item} onNavigate={onNavigate} /> : <NavEntry key={item.to} item={item} onNavigate={onNavigate} />,
              )}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line px-3 pb-2 pt-3">
        <AllToolsEntry onNavigate={onNavigate} />
        <div className="mt-2 flex h-7 items-center gap-2 pl-1 text-xs text-fg-3">
          <BuildStatus />
          <span className="num ml-auto shrink-0 text-fg-4">v{__NEARKIT_VERSION__}</span>
          {/* NEARKITS' community: the Telegram group and X, on every page (the phone drawer shows the same). */}
          <SocialLinks variant="icons" className="-mr-1 shrink-0" />
        </div>
      </div>
    </>
  )
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-line bg-canvas lg:flex">
      <NavLink to="/" className="flex h-16 shrink-0 items-center gap-1.5 border-b border-line px-5" aria-label="NEARKITS dashboard">
        <LogoMark size={24} />
        <Wordmark height={16} />
      </NavLink>
      <NavBody />
    </aside>
  )
}
