import { ArrowRight, Search, X } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/page/Page'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Form'
import { Tag } from '@/components/ui/Indicators'
import { soonLabel } from '@/config/paused'
import { Panel, PanelHeader } from '@/components/ui/Panel'
import { useKitsFirstToken } from '@/features/trade/useDefaultToken'
import { NAV_GROUPS, isNavAction, type NavAction, type NavItem } from '@/layouts/nav'
import { useIsSoon } from '@/layouts/navState'
import { directoryGroups, entryKey, filterDirectory } from '@/layouts/toolDirectory'
import { cn } from '@/lib/cn'
import { useTradeDrawer } from '@/state/contexts'

const GROUPS = directoryGroups(NAV_GROUPS)
const TOTAL = GROUPS.reduce((n, g) => n + g.items.length, 0)

const rowClass = 'group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-raised/50'
const tileClass =
  'grid size-9 shrink-0 place-items-center rounded-md border border-line bg-well text-fg-2 transition-colors duration-150 group-hover:border-accent/40 group-hover:text-accent'

function RowBody({ entry, soon, tag }: { entry: NavItem | NavAction; soon: boolean; tag?: string }) {
  const Icon = entry.icon
  return (
    <>
      <span className={tileClass}>
        <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-fg">{entry.label}</span>
          {soon && <Tag tone="soon">{soonLabel('to' in entry ? entry.to : '')}</Tag>}
          {tag && <Tag>{tag}</Tag>}
        </span>
        <span className="mt-0.5 block text-sm text-fg-3">{entry.description}</span>
      </span>
      <ArrowRight size={15} aria-hidden="true" className="shrink-0 text-fg-4 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-accent" />
    </>
  )
}

/** Quick Trade has no page: it opens the trade ticket over this one, as the sidebar's entry does. */
function QuickTradeRow({ entry }: { entry: NavAction }) {
  const { openTrade } = useTradeDrawer()
  const tokenId = useKitsFirstToken()
  return (
    <button type="button" className={rowClass} onClick={() => openTrade({ tokenId, side: 'buy' })}>
      <RowBody entry={entry} soon={false} tag="Opens here" />
    </button>
  )
}

function ToolRow({ entry }: { entry: NavItem | NavAction }) {
  const isSoon = useIsSoon()
  return (
    <li>
      {isNavAction(entry) ? (
        <QuickTradeRow entry={entry} />
      ) : (
        <Link to={entry.to} className={rowClass}>
          <RowBody entry={entry} soon={isSoon(entry)} />
        </Link>
      )}
    </li>
  )
}

/** Group keys: All, then each group with how many tools it holds (whatever the search). */
function GroupKeys({ value, onChange }: { value: string | null; onChange: (slug: string | null) => void }) {
  const key = (active: boolean) =>
    cn(
      'keycap inline-flex h-8 items-center gap-1.5 rounded-sm border px-3 text-2xs transition-colors duration-100',
      active ? 'border-accent/45 bg-accent/8 text-accent' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg',
    )
  return (
    <div role="group" aria-label="Filter by group" className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={value === null} className={key(value === null)} onClick={() => onChange(null)}>
        All <span className="num text-fg-3">{TOTAL}</span>
      </button>
      {GROUPS.map((g) => (
        <button key={g.slug} type="button" aria-pressed={value === g.slug} className={key(value === g.slug)} onClick={() => onChange(value === g.slug ? null : g.slug)}>
          {g.label} <span className="num text-fg-3">{g.items.length}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Every NEARKITS tool in the sidebar's groups, each with what it does. The search reads names, tasks
 * ("take profit", "airdrop") and group names; the group keys narrow it. Both live in the address.
 */
export default function ToolsPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const picked = params.get('group')
  const group = GROUPS.some((g) => g.slug === picked) ? picked : null
  const shown = useMemo(() => filterDirectory(GROUPS, query, group), [query, group])
  const count = shown.reduce((n, g) => n + g.items.length, 0)

  const update = (next: { q?: string; group?: string | null }) => {
    const p = new URLSearchParams(params)
    const q = next.q ?? query
    const g = next.group === undefined ? group : next.group
    if (q) p.set('q', q)
    else p.delete('q')
    if (g) p.set('group', g)
    else p.delete('group')
    setParams(p, { replace: true })
  }

  return (
    <Page>
      <PageHeader title="All Tools" description="Every NEARKITS tool by group, with what each one does. Search by name, by task or by group." />

      <div className="flex flex-col gap-3">
        <div className="relative w-full max-w-[420px]">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <Input
            type="search"
            aria-label="Search tools"
            placeholder="Search tools: swap, take profit, airdrop…"
            value={query}
            onChange={(e) => update({ q: e.target.value })}
            className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => update({ q: '' })}
              className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-xs text-fg-3 hover:bg-raised hover:text-fg"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <GroupKeys value={group} onChange={(g) => update({ group: g })} />
        <p className="text-xs text-fg-3" role="status" aria-live="polite">
          {count === TOTAL ? `${TOTAL} tools` : `${count} of ${TOTAL} tools`}
        </p>
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState
            title={query ? `No tool matches “${query}”` : 'No tool in this group'}
            graphic={false}
            action={
              <Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                Show every tool
              </Button>
            }
          >
            Try a tool’s name, or what you want to do: “send”, “take profit”, “new pools”.
          </EmptyState>
        </Panel>
      ) : (
        // Groups flow in columns, so short and long groups pack without gaps; reading order stays the sidebar's.
        <div className="gap-4 md:columns-2 2xl:columns-3">
          {shown.map((g) => (
            <Panel key={g.slug} aria-labelledby={`tools-${g.slug}`} className="mb-4 break-inside-avoid">
              <PanelHeader id={`tools-${g.slug}`} title={g.label} meta={g.items.length} />
              <ul className="divide-y divide-line-soft">
                {g.items.map((entry) => (
                  <ToolRow key={entryKey(entry)} entry={entry} />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </Page>
  )
}
