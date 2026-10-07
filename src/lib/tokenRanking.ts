import { NATIVE_TOKEN_ID } from '@/config/networks'
import type { Holding, TokenId, TokenListing, Wallet } from '@/types/domain'
import { tokenMatchRank } from './tokenSearch'
import { canExecute } from './wallets'

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
 * What a picker's own wallets hold (`held`), and what the user's other executable wallets hold
 * (`heldElsewhere`). A watch-only wallet never counts, not even one a picker names. With no picker
 * wallets (`own` null: the global search), everything executable is `held`.
 */
export function holdingTiers(
  holdings: readonly Holding[],
  wallets: readonly Pick<Wallet, 'id' | 'source' | 'access'>[],
  own: readonly string[] | null,
): { held: Map<TokenId, number>; heldElsewhere: Map<TokenId, number> } {
  const executable = wallets.filter(canExecute).map((w) => w.id)
  if (own === null) return { held: heldBalances(holdings, executable), heldElsewhere: new Map() }
  const mine = new Set(own)
  return {
    held: heldBalances(
      holdings,
      executable.filter((id) => mine.has(id)),
    ),
    heldElsewhere: heldBalances(
      holdings,
      executable.filter((id) => !mine.has(id)),
    ),
  }
}

export interface RankOptions {
  /** What was typed; empty: no search. */
  query?: string
  /** The picker's current token: first, without a search. */
  selectedId?: TokenId | null
  /** What the picker's own wallets hold (its trading wallet, a send's source, Consolidate's sources). */
  held?: ReadonlyMap<TokenId, number>
  /** What the user's other executable wallets hold. */
  heldElsewhere?: ReadonlyMap<TokenId, number>
  /** $KITS' token id while it is listed (where the build has its contract, the demo included); null: not listed. */
  kitId?: TokenId | null
  /** Popular tokens, the most relevant first (stablecoins, then the network's known tokens). */
  popular?: readonly TokenId[]
}

const NONE: ReadonlyMap<TokenId, number> = new Map()

/**
 * NEARKITS' one token order, used by every token picker and search:
 *  1. $KITS, 2. NEAR, 3. what the picker's wallets hold, 4. what the user's other executable wallets
 *     hold, 5. popular tokens, 6. every other token in the order the list had it;
 *  - without a search, the selected token comes first of all;
 *  - with a search, how closely a token matches decides first (tokenSearch.ts: "USDC" finds USDC
 *    first, whatever is held), the order above only among equally close matches; every token stays
 *    findable, a selected one that doesn't match is not forced in.
 * Held tokens: the larger USD value first; held tokens without a price come after the priced ones,
 * the larger balance first (a missing price never hides a token). Ties: symbol, then contract.
 */
export function rankTokenList<T extends TokenListing>(tokens: readonly T[], opts: RankOptions = {}): T[] {
  const held = opts.held ?? NONE
  const elsewhere = opts.heldElsewhere ?? NONE
  const popular = new Map((opts.popular ?? []).map((id, i) => [id, i]))
  const position = new Map(tokens.map((t, i) => [t.id, i]))
  const amountHere = (t: T) => held.get(t.id) ?? 0
  const amountThere = (t: T) => elsewhere.get(t.id) ?? 0
  const tier = (t: T): number => {
    if (opts.kitId != null && t.id === opts.kitId) return 0
    if (t.isNative === true || t.id === NATIVE_TOKEN_ID) return 1
    if (amountHere(t) > 0) return 2
    if (amountThere(t) > 0) return 3
    if (popular.has(t.id)) return 4
    return 5
  }
  const byValue = (a: T, b: T, amountOf: (t: T) => number): number => {
    const va = valueOf(a, amountOf(a))
    const vb = valueOf(b, amountOf(b))
    if (va !== null && vb !== null && va !== vb) return vb - va
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1
    if (va === null && amountOf(a) !== amountOf(b)) return amountOf(b) - amountOf(a)
    return byText(a.symbol.toLowerCase(), b.symbol.toLowerCase()) || byText(a.id, b.id)
  }
  const order = (a: T, b: T): number => {
    const ta = tier(a)
    const tb = tier(b)
    if (ta !== tb) return ta - tb
    if (ta === 2) return byValue(a, b, amountHere)
    if (ta === 3) return byValue(a, b, amountThere)
    if (ta === 4) return (popular.get(a.id) ?? 0) - (popular.get(b.id) ?? 0)
    return (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)
  }

  const q = (opts.query ?? '').trim().toLowerCase()
  if (!q) {
    const selected = tokens.find((t) => t.id === opts.selectedId)
    const rest = tokens.filter((t) => t !== selected).sort(order)
    return selected ? [selected, ...rest] : rest
  }
  return tokens
    .map((t) => ({ t, rank: tokenMatchRank(t, q) }))
    .filter((m): m is { t: T; rank: number } => m.rank !== null)
    .sort((a, b) => a.rank - b.rank || order(a.t, b.t))
    .map((m) => m.t)
}
