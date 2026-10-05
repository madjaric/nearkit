import type { Holding, TokenId, TokenListing } from '@/types/domain'
import { tokenMatchRank } from './tokenSearch'

/**
 * What these wallets hold, by token id (its contract; `near` for native NEAR): the sum of their
 * positive balances. Only the wallets named count, so leave watch-only wallets (and a destination)
 * out before asking. Two tokens that share a symbol are two entries: the contract is the key.
 */
export function heldBalances(holdings: readonly Holding[], walletIds: readonly string[]): Map<TokenId, number> {
  const wanted = new Set(walletIds)
  const held = new Map<TokenId, number>()
  for (const h of holdings) {
    if (!wanted.has(h.walletId) || !(h.amount > 0)) continue
    held.set(h.tokenId, (held.get(h.tokenId) ?? 0) + h.amount)
  }
  return held
}

/** A held amount's USD value when the token has a usable price; null otherwise (no price is no value, not zero). */
function valueOf(t: TokenListing, amount: number): number | null {
  const price = t.market?.priceUsd
  return price !== undefined && Number.isFinite(price) && price > 0 ? amount * price : null
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The order of a picker that knows what the wallets hold (Split, Batch Send, Consolidate):
 *  - without a search: the selected token first, then every held token, then the tokens not held
 *    in the order the list had them;
 *  - with a search: every token (held or not) that matches, the closest match first
 *    (tokenSearch.ts), held before not held for an equally close match.
 * Held tokens: the larger USD value first; held tokens without a price come after the priced ones,
 * the larger balance first. A missing price never hides a token. Ties: symbol, then contract.
 */
export function rankByHoldings<T extends TokenListing>(tokens: readonly T[], opts: { query: string; selectedId: TokenId | null; held: ReadonlyMap<TokenId, number> }): T[] {
  const position = new Map(tokens.map((t, i) => [t.id, i]))
  const amountOf = (t: T) => opts.held.get(t.id) ?? 0
  const heldFirst = (a: T, b: T): number => {
    const ha = amountOf(a) > 0
    const hb = amountOf(b) > 0
    if (ha !== hb) return ha ? -1 : 1
    if (!ha) return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
    const va = valueOf(a, amountOf(a))
    const vb = valueOf(b, amountOf(b))
    if (va !== null && vb !== null && va !== vb) return vb - va
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1
    if (va === null && amountOf(a) !== amountOf(b)) return amountOf(b) - amountOf(a)
    return byText(a.symbol.toLowerCase(), b.symbol.toLowerCase()) || byText(a.id, b.id)
  }

  const q = opts.query.trim().toLowerCase()
  if (!q) {
    const selected = tokens.find((t) => t.id === opts.selectedId)
    const rest = tokens.filter((t) => t !== selected).sort(heldFirst)
    return selected ? [selected, ...rest] : rest
  }
  return tokens
    .map((t) => ({ t, rank: tokenMatchRank(t, q) }))
    .filter((m): m is { t: T; rank: number } => m.rank !== null)
    .sort((a, b) => a.rank - b.rank || heldFirst(a.t, b.t))
    .map((m) => m.t)
}
