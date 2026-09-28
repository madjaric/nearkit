import { NavLink } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { Led, Tag } from '@/components/ui/Indicators'
import { isComingSoon } from '@/config/release'
import { useDefaultTradeToken } from '@/features/trade/useDefaultToken'
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

function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <li>
      <NavLink
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'group flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors duration-100',
            isActive ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-raised/60 hover:text-fg',
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={cn('shrink-0', isActive ? 'text-accent' : 'text-fg-3 group-hover:text-fg-2')} />
            <span className="flex-1 truncate">{item.label}</span>
            {isSoon(item) && <Tag tone="soon">Soon</Tag>}
            {isActive && <Led tone="on" label="Current page" />}
          </>
        )}
      </NavLink>
    </li>
  )
}

/** Group legend drawn like a silkscreened bracket on an instrument panel. */
function GroupLegend({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 pb-1.5" aria-hidden="true">
      <span className="h-2 w-1.5 shrink-0 border-l border-t border-line-strong" />
      <span className="legend">{label}</span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  )
}

/** Opens the Quick Trade ticket over the current page, on the default trade token. */
function QuickTradeEntry({ entry, onNavigate }: { entry: NavAction; onNavigate?: () => void }) {
  const { openTrade } = useTradeDrawer()
  const tokenId = useDefaultTradeToken()
  const Icon = entry.icon
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onNavigate?.()
          openTrade({ tokenId, side: 'buy' })
        }}
        className="group flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-sm text-fg-2 transition-colors duration-100 hover:bg-raised/60 hover:text-fg"
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-fg-3 group-hover:text-fg-2" />
        <span className="flex-1 truncate">{entry.label}</span>
      </button>
    </li>
  )
}

/** $KIT keeps its own mark and mono ticker; it is not live until the token launches. */
function KitEntry({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <li>
      <NavLink
        to="/kit"
        onClick={onNavigate}
        className={({ isActive }) =>
          cn('group flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors', isActive ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-raised/60 hover:text-fg')
        }
      >
        {({ isActive }) => (
          <>
            <LogoMark size={16} />
            <span className="num flex-1 text-[12.5px] tracking-[0.02em]">$KIT</span>
            <Tag tone="soon">Soon</Tag>
            {isActive && <Led tone="on" label="Current page" />}
          </>
        )}
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
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        <ul>
          <NavEntry item={NAV_HOME} onNavigate={onNavigate} />
        </ul>
        {groups.map((group) => (
          <div key={group.label} className="mt-4" role="group" aria-label={group.label}>
            <GroupLegend label={group.label} />
            <ul className="flex flex-col gap-px">
              {group.items.map((item) =>
                isNavAction(item) ? <QuickTradeEntry key={item.action} entry={item} onNavigate={onNavigate} /> : <NavEntry key={item.to} item={item} onNavigate={onNavigate} />,
              )}
            </ul>
          </div>
        ))}
        <div className="mt-4" role="group" aria-label="Coming soon">
          <GroupLegend label="Coming soon" />
          <ul className="flex flex-col gap-px">
            {soon.map((item) => (
              <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
            ))}
            <KitEntry onNavigate={onNavigate} />
          </ul>
        </div>
      </nav>
      <div className="border-t border-line px-2 py-2">
        <ul className="flex flex-col gap-px">
          {NAV_FOOTER.filter((item) => !isSoon(item)).map((item) => (
            <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11px] text-fg-3">
        <BuildStatus />
      </div>
    </>
  )
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-well lg:flex">
      <NavLink to="/" className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4" aria-label="NearKit dashboard">
        <LogoMark size={20} />
        <Wordmark />
      </NavLink>
      <NavBody />
    </aside>
  )
}
