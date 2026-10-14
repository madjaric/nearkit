import { ArrowRight, ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { buttonClass } from '@/components/ui/buttonClass'
import { Led, Tag } from '@/components/ui/Indicators'
import { NAV_GROUPS, isNavAction, type NavItem } from '@/layouts/nav'
import { useIsSoon } from '@/layouts/navState'
import type { StrategyKind } from '@/lib/automation/config'
import { cn } from '@/lib/cn'
import type { StrategyRow } from './strategies'
import type { ActiveStrategies } from './useActiveStrategies'

/** The Dashboard's four featured tools, by their sidebar entries (one name, one description, one address). */
const FEATURED: { to: string; kind: StrategyKind | null }[] = [
  { to: '/swap', kind: null },
  { to: '/limit-orders', kind: 'limit' },
  { to: '/sniper', kind: 'sniper' },
  { to: '/dca', kind: 'dca' },
]

const PAGES = NAV_GROUPS.flatMap((g) => g.items).filter((i): i is NavItem => !isNavAction(i))

/** Live state only: how many of its strategies run or are paused (from NEARKITS or the demo), or SOON. Nothing otherwise. */
function CardStatus({ soon, rows, strategies }: { soon: boolean; rows: StrategyRow[]; strategies: ActiveStrategies }) {
  if (soon) return <Tag tone="soon">Soon</Tag>
  const running = strategies.running(rows)
  const paused = strategies.paused(rows)
  if (running === 0 && paused === 0) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.07em] text-fg-2">
      <Led tone={running > 0 ? 'on' : 'warn'} />
      <span className="num">{running > 0 ? running : paused}</span>
      {running > 0 ? 'active' : 'paused'}
    </span>
  )
}

function ToolCard({ item, kind, strategies }: { item: NavItem; kind: StrategyKind | null; strategies: ActiveStrategies }) {
  const isSoon = useIsSoon()
  const Icon = item.icon
  const soon = isSoon(item)
  const rows = kind && !strategies.loading ? strategies.rows.filter((r) => r.kind === kind) : []
  return (
    <li className="min-w-0">
      <Link
        to={item.to}
        className="group relative flex h-full items-center gap-3 rounded-lg border border-line bg-panel p-3 transition-colors duration-150 hover:border-line-strong hover:bg-raised/40 sm:flex-col sm:items-stretch sm:gap-0 sm:p-4"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-well text-fg-2 transition-colors duration-150 group-hover:border-accent/40 group-hover:text-accent">
          <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col sm:mt-3">
          {/* The name first (it names the link); its status follows it on a phone and sits top right from sm up. */}
          <span className="flex items-center gap-2">
            <span className="text-md font-semibold leading-6 text-fg">{item.label}</span>
            <span className="inline-flex sm:absolute sm:right-4 sm:top-4">
              <CardStatus soon={soon} rows={rows} strategies={strategies} />
            </span>
          </span>
          <span className="mt-0.5 text-sm text-fg-3 sm:mb-4">{item.description}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-fg-4 group-hover:text-accent sm:hidden" />
        {/* The card is the link; this is its key, from sm up (a phone row shows the chevron instead). */}
        <span aria-hidden="true" className="mt-auto hidden sm:block">
          <span className={cn(buttonClass({ variant: 'outline', size: 'sm' }), 'w-full justify-center group-hover:border-accent group-hover:bg-accent/8')}>
            Open {item.label}
            <ArrowRight size={14} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
        </span>
      </Link>
    </li>
  )
}

/** Exactly four: the sidebar and All Tools hold the rest. */
export function FeaturedTools({ strategies }: { strategies: ActiveStrategies }) {
  const items = FEATURED.map((f) => ({ ...f, item: PAGES.find((p) => p.to === f.to) })).filter((f): f is typeof f & { item: NavItem } => f.item !== undefined)
  return (
    <section aria-labelledby="dash-tools" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="dash-tools" className="num flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-fg-2">
          <ChevronRight size={13} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-fg-4" />
          Most used tools
        </h2>
        <Link to="/tools" className="keycap inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-2xs text-fg-2 transition-colors hover:bg-raised hover:text-fg">
          All tools
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((f) => (
          <ToolCard key={f.to} item={f.item} kind={f.kind} strategies={strategies} />
        ))}
      </ul>
    </section>
  )
}
