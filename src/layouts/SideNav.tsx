import { NavLink } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { Led, Tag } from '@/components/ui/Indicators'
import { isComingSoon } from '@/config/release'
import { cn } from '@/lib/cn'
import { useNetworkWording } from '@/lib/modeCopy'
import { useCapabilities } from '@/services/queries'
import { NAV_FOOTER, NAV_GROUPS, NAV_HOME, type NavItem } from './nav'

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
            {(item.soon || isComingSoon(item.to)) && <Tag tone="soon">Soon</Tag>}
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

/** Navigation body shared by the desktop sidebar and the phone drawer. */
export function NavBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        <ul>
          <NavEntry item={NAV_HOME} onNavigate={onNavigate} />
        </ul>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mt-4" role="group" aria-label={group.label}>
            <GroupLegend label={group.label} />
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => (
                <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line px-2 py-2">
        <ul className="flex flex-col gap-px">
          {NAV_FOOTER.map((item) => (
            <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
          ))}
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
