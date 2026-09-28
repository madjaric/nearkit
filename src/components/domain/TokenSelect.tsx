import { ChevronDown, Search } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Popover } from '@/components/ui/Floating'
import { Tag } from '@/components/ui/Indicators'
import { Amount, Pct, Price } from '@/components/ui/Num'
import { cn } from '@/lib/cn'
import { useHoldings, useTokens } from '@/services/queries'
import type { TokenId, TokenListing } from '@/types/domain'
import { SimMark } from './SimMark'
import { TokenGlyph } from './TokenGlyph'

interface TokenSelectProps {
  value: TokenId
  onChange: (id: TokenId) => void
  label: string
  exclude?: TokenId[]
  /** Show balances held by this wallet in the list. */
  walletId?: string
  size?: 'md' | 'lg'
  /** Symbol only at full height, for sitting beside an amount field. */
  compact?: boolean
  className?: string
  id?: string
  describedBy?: string
}

export function TokenSelect({ value, onChange, label, exclude = [], walletId, size = 'lg', compact = false, className, id, describedBy }: TokenSelectProps) {
  const { data: tokens = [] } = useTokens()
  const { data: holdings = [] } = useHoldings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const selected = tokens.find((t) => t.id === value)
  const balanceOf = (tokenId: string) => (walletId ? (holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.amount ?? 0) : null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tokens.filter(
      (t) => !exclude.includes(t.id) && (!q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (t.contract ?? '').toLowerCase().includes(q)),
    )
  }, [tokens, exclude, query])

  const close = () => {
    setOpen(false)
    setQuery('')
    triggerRef.current?.focus()
  }
  const choose = (token: TokenListing) => {
    onChange(token.id)
    close()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, list.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const token = list[active]
      if (token) choose(token)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.symbol ?? 'none'}`}
        aria-describedby={describedBy}
        onClick={() => {
          setActive(0)
          setOpen((o) => !o)
        }}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-sm border border-line-strong bg-well text-left transition-colors hover:border-fg-4 focus-visible:border-accent',
          size === 'lg' ? 'h-11 px-3' : 'h-9 px-2.5',
          className,
        )}
      >
        {selected ? (
          <>
            <TokenGlyph symbol={selected.symbol} tokenId={selected.id} size={size === 'lg' && !compact ? 28 : size === 'lg' ? 24 : 20} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('flex min-w-0 items-center gap-1.5 truncate font-semibold text-fg', size === 'lg' && !compact ? 'text-base' : 'text-sm')}>
                <span className="truncate">{selected.symbol}</span>
                {selected.status === 'prelaunch' && size === 'lg' && !compact && <Tag tone="warn">Pre-launch</Tag>}
              </span>
              {size === 'lg' && !compact && <span className="truncate text-xs text-fg-3">{selected.name}</span>}
            </span>
            {size === 'lg' && !compact && selected.market && (
              <span className="flex flex-col items-end text-xs">
                <span className="flex items-center">
                  <Price value={selected.market.priceUsd} className="text-fg-2" />
                  {selected.status === 'prelaunch' && <SimMark />}
                </span>
                <Pct value={selected.market.change24hPct} className="text-[11px]" />
              </span>
            )}
          </>
        ) : (
          <span className="flex-1 text-sm text-fg-3">Select token</span>
        )}
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-3" />
      </button>

      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        matchWidth={size === 'lg' && !compact}
        label={label}
        className={cn((size === 'md' || compact) && 'w-72')}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3">
          <Search size={14} className="text-fg-3" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Symbol, name or contract"
            aria-label="Search tokens"
            aria-controls="token-listbox"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none"
          />
        </div>
        <ul id="token-listbox" role="listbox" aria-label={label} className="max-h-72 overflow-y-auto py-1">
          {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-fg-3">No token matches “{query}”</li>}
          {list.map((token, index) => {
            const balance = balanceOf(token.id)
            return (
              <li key={token.id} role="option" aria-selected={token.id === value}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(token)}
                  className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left', index === active ? 'bg-hover' : 'hover:bg-hover')}
                >
                  <TokenGlyph symbol={token.symbol} tokenId={token.id} size={24} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                      {token.symbol}
                      {token.status === 'prelaunch' && <Tag tone="warn">Pre-launch</Tag>}
                      {token.id === value && <span className="text-[11px] font-normal text-accent">Selected</span>}
                    </span>
                    <span className="truncate text-xs text-fg-3">{token.name}</span>
                  </span>
                  <span className="flex flex-col items-end text-xs">
                    {balance !== null ? <Amount value={balance} className="text-fg-2" /> : token.market && <Price value={token.market.priceUsd} className="text-fg-2" />}
                    {token.market && <Pct value={token.market.change24hPct} className="text-[11px]" />}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Popover>
    </>
  )
}
