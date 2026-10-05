import { rankByHoldings } from '@/lib/tokenRanking'
import { tradeWalletPool } from '@/lib/wallets'
import type { TokenId, TokenListing, Wallet } from '@/types/domain'

/** Who runs a Consolidate: NearKit wallets (NearKit's server sends for each) or the connected wallet's accounts (signed here). One at a time, as in Multi Trade. */
export type SourceFamily = 'nearkit' | 'browser'

type PoolWallet = Pick<Wallet, 'id' | 'source' | 'access' | 'frozen'>

/**
 * The wallets a Consolidate may gather from: every wallet that can act (NearKit wallets that aren't
 * frozen, the connected wallet's accounts), never a watch-only one and never the destination itself.
 */
export function consolidatePool<W extends PoolWallet>(wallets: readonly W[], destinationId: string): { nearkit: W[]; browser: W[]; all: W[] } {
  const pool = tradeWalletPool(wallets)
  const nearkit = pool.nearkit.filter((w) => w.id !== destinationId)
  const browser = pool.browser.filter((w) => w.id !== destinationId)
  return { nearkit, browser, all: [...nearkit, ...browser] }
}

/** The family a run starts from: the one with more wallets holding the token (NearKit on a tie), or the only one there is. */
export function defaultFamily(pool: { nearkit: readonly PoolWallet[]; browser: readonly PoolWallet[] }, holds: (walletId: string) => boolean): SourceFamily {
  if (pool.nearkit.length === 0) return 'browser'
  if (pool.browser.length === 0) return 'nearkit'
  return pool.browser.filter((w) => holds(w.id)).length > pool.nearkit.filter((w) => holds(w.id)).length ? 'browser' : 'nearkit'
}

/**
 * The token a Consolidate opens on: the most valuable token the sources hold (by the same ranking
 * as the token picker; a token without a price still counts), another token before NEAR; `fallback`
 * while nothing is held (or the balances aren't read yet).
 */
export function defaultConsolidateToken(tokens: readonly TokenListing[], held: ReadonlyMap<TokenId, number>, fallback: TokenId): TokenId {
  const ranked = rankByHoldings(tokens, { query: '', selectedId: null, held }).filter((t) => (held.get(t.id) ?? 0) > 0)
  return (ranked.find((t) => !t.isNative) ?? ranked[0])?.id ?? fallback
}
