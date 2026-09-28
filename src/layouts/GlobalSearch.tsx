import { CornerDownLeft, ScanSearch, Search, SquareSlash, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Popover } from '@/components/ui/Floating'
import { Kbd, Tag } from '@/components/ui/Indicators'
import { isComingSoon } from '@/config/release'
import { cn } from '@/lib/cn'
import { isValidAccountId } from '@/lib/validation'
import { useTokens } from '@/services/queries'
import type { TokenListing } from '@/types/domain'
import { ALL_NAV, COMMANDS } from './nav'

interface Result {
  id: string
  group: 'Tokens' | 'Scan' | 'Commands' | 'Go to'
  label: ReactNode
  detail?: ReactNode
  to: string
  icon?: LucideIcon
  token?: TokenListing
  /** Leads to a feature the public beta holds back. */
  soon?: boolean
}

/**
 * The search box reads what you type: a symbol finds the token, a contract offers
 * a scan, and a leading "/" lists the same commands the Telegram bot will take.
 */
function buildResults(raw: string, tokens: TokenListing[]): Result[] {
  const q = raw.trim().toLowerCase()
  if (!q) {
    return tokens
      .filter((t) => !t.isNative)
      .slice(0, 4)
      .map((t) => ({ id: `t-${t.id}`, group: 'Tokens' as const, label: t.symbol, detail: t.name, to: `/swap?to=${encodeURIComponent(t.id)}`, token: t }))
  }
  if (q.startsWith('/')) {
    return COMMANDS.filter((c) => c.command.startsWith(q) || c.label.toLowerCase().includes(q.slice(1))).map((c) => ({
      id: `c-${c.command}`,
      group: 'Commands' as const,
      label: <span className="num">{c.command}</span>,
      detail: c.label,
      to: c.to,
      icon: SquareSlash,
      soon: isComingSoon(c.to.split('?')[0] ?? c.to),
    }))
  }
  const results: Result[] = []
  for (const t of tokens) {
    if (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (t.contract ?? '').toLowerCase().includes(q)) {
      results.push({ id: `t-${t.id}`, group: 'Tokens', label: t.symbol, detail: t.name, to: t.isNative ? '/swap' : `/swap?to=${encodeURIComponent(t.id)}`, token: t })
    }
  }
  if (isValidAccountId(q) && (q.includes('.') || q.length === 64 || q.startsWith('0x'))) {
    results.push({ id: `s-${q}`, group: 'Scan', label: `Scan ${q}`, detail: 'Contract indicators and risk flags', to: `/scanner?q=${encodeURIComponent(q)}`, icon: ScanSearch })
  }
  for (const item of ALL_NAV) {
    if (item.label.toLowerCase().includes(q) || item.keywords?.some((k) => k.includes(q))) {
      results.push({ id: `p-${item.to}`, group: 'Go to', label: item.label, to: item.to, icon: item.icon, soon: isComingSoon(item.to) })
    }
  }
  return results.slice(0, 9)
}

export function GlobalSearch({ className, autoFocus = false, onDone }: { className?: string; autoFocus?: boolean; onDone?: () => void }) {
  const navigate = useNavigate()
  const listId = useId()
  const { data: tokens = [] } = useTokens()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => buildResults(query, tokens), [query, tokens])

  // "/" focuses search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (!inputRef.current || inputRef.current.offsetParent === null) return
      event.preventDefault()
      inputRef.current.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const go = (result: Result | undefined) => {
    if (!result) return
    navigate(result.to)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
    onDone?.()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      go(results[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      onDone?.()
    }
  }

  const headers = results.map((r, i) => (i === 0 || results[i - 1]?.group !== r.group ? r.group : null))

  return (
    <div ref={wrapRef} className={cn('relative flex w-full items-center', className)}>
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 text-fg-3" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        aria-label="Search token, contract or command"
        placeholder="Search token / contract"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full rounded-sm border border-line bg-panel pl-9 pr-10 text-sm text-fg transition-colors placeholder:text-fg-3 hover:border-line-strong focus:border-accent focus:outline-none"
      />
      <Kbd className="pointer-events-none absolute right-2">/</Kbd>

      <Popover anchorRef={wrapRef} open={open} onClose={() => setOpen(false)} placement="bottom-start" matchWidth role="presentation" className="py-1.5">
        <ul id={listId} role="listbox" aria-label="Search results" className="max-h-[60dvh] overflow-y-auto">
          {results.length === 0 && (
            <li className="px-3 py-5 text-center text-sm text-fg-3">
              Nothing matches. Try a symbol, a <span className="num text-fg-2">.near</span> contract, or <span className="num text-fg-2">/</span> for commands.
            </li>
          )}
          {results.map((r, i) => {
            const header = headers[i]
            const Icon = r.icon
            return (
              <li key={r.id} role="presentation">
                {header && <div className="legend px-3 pb-1 pt-2">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r)}
                  className={cn('mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5', i === active ? 'bg-hover' : '')}
                >
                  {r.token ? (
                    <TokenGlyph symbol={r.token.symbol} tokenId={r.token.id} size={20} />
                  ) : Icon ? (
                    <span className="grid size-5 place-items-center text-fg-3">
                      <Icon size={15} strokeWidth={1.75} />
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.label}</span>
                  {r.detail && <span className="truncate text-xs text-fg-3">{r.detail}</span>}
                  {r.soon && <Tag tone="soon">Soon</Tag>}
                  {i === active && <CornerDownLeft size={13} className="shrink-0 text-fg-4" aria-hidden="true" />}
                </div>
              </li>
            )
          })}
        </ul>
        {!query && (
          <p className="mt-1 border-t border-line-soft px-3 pt-2 text-xs text-fg-3">
            Type a symbol, paste a <span className="num text-fg-2">.near</span> contract to scan it, or start with <span className="num text-fg-2">/</span> for commands.
          </p>
        )}
      </Popover>
    </div>
  )
}
