import { NavLink } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { Led, Tag } from '@/components/ui/Indicators'
import { KIT } from '@/config/kit'
import { isComingSoon } from '@/config/release'
import { useQuickTradeToken } from '@/features/trade/useDefaultToken'
import { cn } from '@/lib/cn'
import { useNetworkWording } from '@/lib/modeCopy'
import { useCapabilities } from '@/services/queries'
import { useTradeDrawer } from '@/state/contexts'
import { isNavAction, NAV_FOOTER, NAV_GROUPS, NAV_HOME, type NavAction, type NavItem } from './nav'

/** Not live in this build: always-soon entries, and the ones the public beta holds back. */
const isSoon = (item: NavItem) => item.soon === true || isComingSoon(item.to)

/** Build status line: what this build runs on. */
function BuildStatus() {
  const caps = useCapabilities()
  const network = useNetworkWording()
  if (caps.mode === 'demo') {
    return (
      <>
        <Led tone="idle" />
        <span>Demo · simulated, nothing is sent</span>
      </>
    )
  }
  const live = caps.execution.enabled
  return (
    <>
      <Led tone={live ? 'on' : 'warn'} />
      <span>{live ? `NEAR ${network.name} · live` : `NEAR ${network.name} · view only`}</span>
    </>
  )
}

const entryBase = 'group relative flex h-10 items-center gap-3 rounded-md px-3 text-base transition-colors duration-100'
const entryOn = 'bg-raised text-fg before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-accent'
const entryOff = 'text-fg-2 hover:bg-raised/60 hover:text-fg'

function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon
  // An entry with a hint is two lines (the label, then what tells it from its neighbour); the rest keep one.
  return (
    <li>
      <NavLink
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={({ isActive }) => cn(entryBase, item.hint && 'h-auto min-h-10 items-start py-2', isActive ? entryOn : entryOff)}
      >
        {({ isActive }) => (
          <>
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', item.hint && 'mt-0.5', isActive ? 'text-accent' : 'text-fg-3 group-hover:text-fg-2')} />
            {item.hint ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                <span className="text-2xs leading-4 text-fg-3">{item.hint}</span>
              </span>
            ) : (
              <span className="flex-1 truncate">{item.label}</span>
            )}
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
    <div className="legend px-3 pb-2" aria-hidden="true">
      {label}
    </div>
  )
}

/** Opens the Quick Trade ticket over the current page, on Quick Trade's token ($KITS where it trades). */
function QuickTradeEntry({ entry, onNavigate }: { entry: NavAction; onNavigate?: () => void }) {
  const { openTrade } = useTradeDrawer()
  const tokenId = useQuickTradeToken()
  const Icon = entry.icon
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onNavigate?.()
          openTrade({ tokenId, side: 'buy' })
        }}
        className={cn(entryBase, entryOff, 'w-full text-left')}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-fg-3 group-hover:text-fg-2" />
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
      <NavLink to={KIT.links.page} onClick={onNavigate} className={({ isActive }) => cn(entryBase, isActive ? entryOn : entryOff)}>
        <LogoMark size={18} />
        <span className="num flex-1 text-sm tracking-[0.02em]">{KIT.ticker}</span>
        {live ? <Tag tone="accent">Live</Tag> : <Tag>Mainnet</Tag>}
      </NavLink>
    </li>
  )
}

/**
 * Navigation body shared by the desktop sidebar and the phone drawer. Live entries
 * stay in their groups (a group with none left is hidden); everything not live in
 * this build is listed once, in a COMING SOON group at the end.
 */
export function NavBody({ onNavigate }: { onNavigate?: () => void }) {
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => isNavAction(i) || !isSoon(i)) })).filter((g) => g.items.length > 0)
  const soon = [...NAV_GROUPS.flatMap((g) => g.items), ...NAV_FOOTER].filter((i): i is NavItem => !isNavAction(i) && isSoon(i))
  return (
    <>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-0.5">
          <NavEntry item={NAV_HOME} onNavigate={onNavigate} />
          <KitEntry onNavigate={onNavigate} />
        </ul>
        {groups.map((group) => (
          <div key={group.label} className="mt-6" role="group" aria-label={group.label}>
            <GroupLegend label={group.label} />
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) =>
                isNavAction(item) ? <QuickTradeEntry key={item.action} entry={item} onNavigate={onNavigate} /> : <NavEntry key={item.to} item={item} onNavigate={onNavigate} />,
              )}
            </ul>
          </div>
        ))}
        {soon.length > 0 && (
          <div className="mt-6" role="group" aria-label="Coming soon">
            <GroupLegend label="Coming soon" />
            <ul className="flex flex-col gap-0.5">
              {soon.map((item) => (
                <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        )}
      </nav>
      <div className="border-t border-line px-3 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV_FOOTER.filter((item) => !isSoon(item)).map((item) => (
            <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-fg-3">
        <BuildStatus />
        <span className="num ml-auto text-fg-4">v{__NEARKIT_VERSION__}</span>
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
