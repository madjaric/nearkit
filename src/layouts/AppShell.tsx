import { ArrowLeftRight, Coins, Layers, LayoutGrid, Menu as MenuIcon, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, ScrollRestoration } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/Brand'
import { IconButton } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Dialog'
import { Led } from '@/components/ui/Indicators'
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
  return (
    <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-well pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="grid h-14 grid-cols-5">
        {TAB_BAR.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="flex h-full flex-col items-center justify-center gap-1">
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <Icon size={18} strokeWidth={1.75} aria-hidden="true" className={isActive ? 'text-accent' : 'text-fg-3'} />
                      {isActive && <Led tone="on" className="absolute -right-2 -top-0.5" />}
                    </span>
                    <span className={cn('text-[11px] leading-none', isActive ? 'text-fg' : 'text-fg-3')}>{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          )
        })}
        <li>
          <button type="button" onClick={onOpenNav} className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-3">
            <MenuIcon size={18} strokeWidth={1.75} aria-hidden="true" />
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
      <a href="#main" className="sr-only z-[100] rounded-sm bg-accent px-3 py-2 text-sm font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] outline-none lg:pb-0">
          <StatusStrip />
          <Outlet />
        </main>
      </div>
      <TabBar onOpenNav={() => setNavOpen(true)} />
      <Sheet open={navOpen} onClose={() => setNavOpen(false)} side="left" label="Navigation">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="flex items-center gap-2.5">
            <LogoMark size={20} />
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
