import { CornerDownLeft, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { TokenGlyph } from '@/components/domain/TokenGlyph'
import { Popover } from '@/components/ui/Floating'
import { Kbd, Tag } from '@/components/ui/Indicators'
import { cn } from '@/lib/cn'
import { looksLikeContract } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useCapabilities, useTokenLookup, useTokens } from '@/services/queries'
import { buildResults, type Result } from './searchResults'

export function GlobalSearch({ className, autoFocus = false, onDone }: { className?: string; autoFocus?: boolean; onDone?: () => void }) {
  const navigate = useNavigate()
  const listId = useId()
  const { data: tokens = [] } = useTokens()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const caps = useCapabilities()
  // A pasted contract in no list yet is read from chain (the same checks as the swap selector).
  const exact = query.trim().toLowerCase()
  const lookupId = open && looksLikeContract(exact) && !tokens.some((t) => t.contract === exact) ? exact : null
  const lookup = useTokenLookup(lookupId)
  const lookupNote = !lookupId ? null : lookup.isError ? describeError(lookup.error).message : lookup.isPending ? `Checking it on ${caps.networkLabel.toLowerCase()}…` : null
  const lookupState = lookup.isPending ? 'checking' : lookup.data ? 'found' : 'not-found'
  const results = useMemo(
    () => buildResults(query, tokens, lookupId ? { token: lookup.data ?? null, note: lookupNote, state: lookupState } : null),
    [query, tokens, lookupId, lookup.data, lookupNote, lookupState],
  )

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
                  {/* A label is never cut for a long detail ("Token not found" stays whole): the detail gives way. */}
                  <span className={cn('truncate text-sm text-fg', r.detail ? 'max-w-[60%] shrink-0' : 'min-w-0 flex-1')}>{r.label}</span>
                  {r.detail && <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-3">{r.detail}</span>}
                  {r.soon && <Tag tone="soon">Soon</Tag>}
                  {i === active && <CornerDownLeft size={13} className="shrink-0 text-fg-4" aria-hidden="true" />}
                </div>
              </li>
            )
          })}
        </ul>
        {!query && (
          <p className="mt-1 border-t border-line-soft px-3 pt-2 text-xs text-fg-3">
            Type a symbol or name, paste a <span className="num text-fg-2">.near</span> contract to open its page or scan it, or start with <span className="num text-fg-2">/</span>{' '}
            for commands.
          </p>
        )}
      </Popover>
    </div>
  )
}
