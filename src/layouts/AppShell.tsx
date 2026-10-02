import { ArrowLeftRight, Coins, Layers, LayoutGrid, Menu as MenuIcon, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, ScrollRestoration } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { IconButton } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Dialog'
import { Led } from '@/components/ui/Indicators'
import { isComingSoon } from '@/config/release'
import { cn } from '@/lib/cn'
import { NavBody, Sidebar } from './SideNav'
import { StatusStrip, TopBar } from './TopBar'

const TAB_BAR = [
  { to: '/', label: 'Home', icon: LayoutGrid, end: true },
  { to: '/swap', label: 'Trade', icon: ArrowLeftRight },
  { to: '/multi-trade', label: 'Multi', icon: Layers },
  { to: '/positions', label: 'Positions', icon: Coins },
]

/** Phone tab bar: the four most-used surfaces plus the full menu. */
function TabBar({ onOpenNav }: { onOpenNav: () => void }) {
  // Live tabs first; a tab the public beta holds back moves to the end, before Menu.
  const tabs = [...TAB_BAR.filter((t) => !isComingSoon(t.to)), ...TAB_BAR.filter((t) => isComingSoon(t.to))]
  return (
    <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-well pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="grid h-16 grid-cols-5">
        {tabs.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="flex h-full flex-col items-center justify-center gap-1">
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={isActive ? 'text-accent' : 'text-fg-3'} />
                      {isActive && <Led tone="on" className="absolute -right-2 -top-0.5" />}
                    </span>
                    <span className="flex h-3.5 items-center gap-1">
                      <span className={cn('text-[11px] leading-none', isActive ? 'text-fg' : 'text-fg-3')}>{item.label}</span>
                      {isComingSoon(item.to) && (
                        <span className="inline-flex h-3.5 items-center rounded-[2px] border border-dashed border-fg-4 px-[3px] text-[9px] font-semibold uppercase leading-none tracking-[0.06em] text-fg-3">
                          Soon
                        </span>
                      )}
                    </span>
                  </>
                )}
              </NavLink>
            </li>
          )
        })}
        <li>
          <button type="button" onClick={onOpenNav} className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-3">
            <MenuIcon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[11px] leading-none">Menu</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

export function AppShell() {
  const [navOpen, setNavOpen] = useState(false)
  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-[100] rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] outline-none lg:pb-0">
          <StatusStrip />
          <Outlet />
        </main>
      </div>
      <TabBar onOpenNav={() => setNavOpen(true)} />
      <Sheet open={navOpen} onClose={() => setNavOpen(false)} side="left" label="Navigation">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
          <span className="flex items-center gap-3">
            <LogoMark size={24} />
            <Wordmark />
          </span>
          <IconButton label="Close navigation" size="sm" onClick={() => setNavOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>
        <NavBody onNavigate={() => setNavOpen(false)} />
      </Sheet>
      <ScrollRestoration />
    </div>
  )
}
