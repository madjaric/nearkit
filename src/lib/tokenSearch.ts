/**
 * Token search, the same wherever a token is looked up by what someone typed (the global search,
 * the token selector): the closest match first. An exact contract, then an exact symbol, an exact
 * name, a symbol that starts with the query, a name that starts with it, a symbol or name that
 * contains it, and last a contract that contains it. Case and surrounding spaces don't matter;
 * ties keep the list's own order.
 */

export interface Searchable {
  symbol: string
  name: string
  contract: string | null
}

/** How closely a token matches a (trimmed, lowercase) query: lower is closer; null when it doesn't match. A leading "$" ($KIT) is the ticker's sign, not part of it. */
export function tokenMatchRank(t: Searchable, query: string): number | null {
  const q = query.startsWith('$') ? query.slice(1) : query
  if (q === '') return null
  const symbol = t.symbol.toLowerCase()
  const name = t.name.toLowerCase()
  const contract = (t.contract ?? '').toLowerCase()
  if (contract !== '' && contract === q) return 0
  if (symbol === q) return 1
  if (name === q) return 2
  if (symbol.startsWith(q)) return 3
  if (name.startsWith(q)) return 4
  if (symbol.includes(q) || name.includes(q)) return 5
  if (contract.includes(q)) return 6
  return null
}

/** The tokens matching `query`, closest first; an empty query keeps the list as it is. */
export function rankTokens<T extends Searchable>(tokens: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...tokens]
  return tokens
    .map((t, i) => ({ t, i, rank: tokenMatchRank(t, q) }))
    .filter((x): x is { t: T; i: number; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.t)
}
