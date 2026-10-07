import { ChevronDown, Search } from 'lucide-react'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { Popover } from '@/components/ui/Floating'
import { Tag } from '@/components/ui/Indicators'
import { Amount, Pct, Price } from '@/components/ui/Num'
import { isKitToken, KIT, KITS_CONTRACT } from '@/config/kit'
import { useTokenRanking } from '@/features/tokens/useTokenRanking'
import { cn } from '@/lib/cn'
import { heldBalances, rankTokenList } from '@/lib/tokenRanking'
import { tokenMatchRank } from '@/lib/tokenSearch'
import { looksLikeContract } from '@/lib/validation'
import { describeError } from '@/services/errors'
import { useCapabilities, useHoldings, useImportToken, useTokenLookup, useTokens } from '@/services/queries'
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
  /**
   * The wallets whose tokens the list is about (Split, Batch Send: the source; Consolidate: every
   * source): what they hold, summed, is shown and comes first, the most valuable first; every other
   * token follows and search still finds it.
   */
  holdingsOf?: readonly string[]
  size?: 'md' | 'lg'
  /** A trading picker: on a network without $KITS (testnet), it is shown at the top (not selectable) with a link to its page. */
  kitTeaser?: boolean
  /** Symbol only, as a chip that sits inside an amount field. */
  compact?: boolean
  className?: string
  id?: string
  describedBy?: string
}

export function TokenSelect({
  value,
  onChange,
  label,
  exclude = [],
  walletId,
  holdingsOf,
  size = 'lg',
  kitTeaser = false,
  compact = false,
  className,
  id,
  describedBy,
}: TokenSelectProps) {
  const { data: tokens = [] } = useTokens()
  const { data: holdings = [] } = useHoldings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const selected = tokens.find((t) => t.id === value)
  const holdersKey = holdingsOf?.join(',') ?? null
  const shown = useMemo(() => (holdersKey === null ? null : heldBalances(holdings, holdersKey ? holdersKey.split(',') : [])), [holdings, holdersKey])
  const balanceOf = (tokenId: string) =>
    shown ? (shown.get(tokenId) ?? 0) : walletId ? (holdings.find((h) => h.walletId === walletId && h.tokenId === tokenId)?.amount ?? 0) : null

  // NEARKITS' one token order (src/lib/tokenRanking.ts): $KITS, NEAR, what this picker's wallets
  // hold, what the other executable wallets hold, popular tokens, the rest; a search ranks by match first.
  const ranking = useTokenRanking(holdingsOf ?? (walletId ? [walletId] : null))
  const list = useMemo(() => {
    const pool = tokens.filter((t) => !exclude.includes(t.id))
    return rankTokenList(pool, { ...ranking, query, selectedId: value })
  }, [tokens, exclude, query, ranking, value])
  // $KITS on a network without it (testnet): shown, never selectable (there is no contract to trade here).
  const teaserQuery = query.trim().toLowerCase()
  const teaser =
    kitTeaser &&
    KIT.status === 'mainnet-only' &&
    !tokens.some((t) => isKitToken(t.id)) &&
    (teaserQuery === '' || teaserQuery === KITS_CONTRACT || tokenMatchRank({ symbol: KIT.symbol, name: KIT.name, contract: null }, teaserQuery) !== null)

  // A pasted contract that no list has yet (a token launched minutes ago): read it from
  // chain and offer to import it. Reading it proves it is a token, not that it trades.
  const caps = useCapabilities()
  const exact = query.trim().toLowerCase()
  const lookupId = looksLikeContract(exact) && !tokens.some((t) => t.contract === exact) ? exact : null
  const lookup = useTokenLookup(open ? lookupId : null)
  const importer = useImportToken()

  const close = () => {
    setOpen(false)
    setQuery('')
    triggerRef.current?.focus()
  }
  const choose = (token: TokenListing) => {
    onChange(token.id)
    close()
  }
  const importAndChoose = (contract: string) => importer.mutate(contract, { onSuccess: (token) => choose(token) })

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
      else if (lookup.data && !importer.isPending) importAndChoose(lookup.data.id)
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
          'flex items-center rounded-md border text-left transition-colors focus-visible:border-accent',
          compact
            ? 'h-10 max-w-[11.5rem] gap-2 border-line bg-raised pl-2 pr-2.5 hover:border-line-strong'
            : cn('w-full gap-2.5 border-line-strong bg-well hover:border-fg-4', size === 'lg' ? 'h-11 px-3' : 'h-9 px-2.5'),
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
        placement={compact ? 'bottom-end' : 'bottom-start'}
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
          {lookupId && (
            <li role="option" aria-selected={false}>
              {lookup.data ? (
                <>
                  <button
                    type="button"
                    disabled={importer.isPending}
                    onClick={() => importAndChoose(lookup.data.id)}
                    className="flex w-full items-center gap-2.5 bg-hover px-3 py-2 text-left"
                  >
                    <TokenGlyph symbol={lookup.data.symbol} tokenId={lookup.data.id} size={24} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                        {lookup.data.symbol}
                        <Tag tone="neutral">Not in your list</Tag>
                      </span>
                      <span className="truncate text-xs text-fg-3">{lookup.data.name}</span>
                      <span className="text-[11px] text-fg-4">
                        <span className="num">{lookup.data.decimals}</span> decimals
                      </span>
                      <span className="num break-all text-[11px] text-fg-4">{lookup.data.contract}</span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-2">{importer.isPending ? 'Importing…' : 'Import'}</span>
                  </button>
                  <p className="px-3 pb-2 text-[11px] text-fg-4">
                    {importer.isError ? describeError(importer.error).message : 'Found on chain. Importing adds it to your token list.'}
                  </p>
                </>
              ) : (
                <p className="px-3 py-3 text-sm text-fg-3">
                  {lookup.isError ? describeError(lookup.error).message : `Checking ${lookupId} on ${caps.networkLabel.toLowerCase()}…`}
                </p>
              )}
            </li>
          )}
          {teaser && (
            <li role="option" aria-selected={false} aria-disabled="true" className="flex items-center gap-2.5 px-3 py-2">
              <TokenGlyph symbol={KIT.symbol} tokenId={KITS_CONTRACT} size={24} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  {KIT.symbol}
                  <Tag>Mainnet</Tag>
                </span>
                <span className="truncate text-xs text-fg-3">{`${KIT.name} · on NEAR mainnet`}</span>
              </span>
              <Link to={KIT.links.page} onClick={close} className="shrink-0 text-xs text-accent underline-offset-2 hover:underline">
                About {KIT.ticker}
              </Link>
            </li>
          )}
          {list.length === 0 && !lookupId && !teaser && <li className="px-3 py-6 text-center text-sm text-fg-3">No token matches “{query}”</li>}
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
