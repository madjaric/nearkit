import type { RpcClient } from '@/services/near/rpc'

/**
 * Ref/Rhea DCL v2 pools, read from the contract itself. A pool's id is `tokenX|tokenY|fee`
 * with the tokens in lexicographic order and the fee one of four tiers, so the pools of a
 * pair are found by asking for each tier: no scan, no indexer, and a pool created a minute
 * ago is there the next time anyone asks. `get_pool` answers `null` for a tier that has no
 * pool (verified live 2026-10-03 on `dclv2.ref-labs.near`).
 */

/** Fee tiers, in hundredths of a basis point (10000 = 1%). */
export const DCL_FEE_TIERS: readonly number[] = Object.freeze([100, 400, 2000, 10000])

export interface DclPool {
  id: string
  tokenX: string
  tokenY: string
  fee: number
  /** Liquidity at the current point; 0 means nothing can be swapped right now. */
  liquidity: bigint
  running: boolean
}

export function dclPoolId(a: string, b: string, fee: number): string {
  const [x, y] = a < b ? [a, b] : [b, a]
  return `${x}|${y}|${fee}`
}

/** The two tokens of a pool id, in the id's order; null for anything that isn't a pool id. */
export function dclPoolTokens(id: string): { tokenX: string; tokenY: string; fee: number } | null {
  const parts = id.split('|')
  if (parts.length !== 3) return null
  const [tokenX = '', tokenY = '', feeText = ''] = parts
  const fee = Number(feeText)
  if (!tokenX || !tokenY || tokenX >= tokenY || !DCL_FEE_TIERS.includes(fee)) return null
  return { tokenX, tokenY, fee }
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const INT = /^\d+$/

/** The pool as `get_pool` returns it; null for `null` (no pool) or anything malformed. */
export function parseDclPool(json: unknown): DclPool | null {
  if (!obj(json)) return null
  const { pool_id, token_x, token_y, fee, liquidity, state } = json
  if (typeof pool_id !== 'string' || typeof token_x !== 'string' || typeof token_y !== 'string') return null
  if (typeof fee !== 'number' || !DCL_FEE_TIERS.includes(fee)) return null
  if (typeof liquidity !== 'string' || !INT.test(liquidity)) return null
  if (pool_id !== dclPoolId(token_x, token_y, fee)) return null
  return { id: pool_id, tokenX: token_x, tokenY: token_y, fee, liquidity: BigInt(liquidity), running: state === 'Running' }
}

/** Which tiers of a pair have a pool is remembered this long (a `null` too); state is re-read on each use. */
export const DCL_POOL_TTL_MS = 60_000

export interface DclPoolReader {
  /** The running pools of a pair with liquidity, deepest first. */
  pools(a: string, b: string): Promise<DclPool[]>
}

/**
 * Reads a pair's pools from the contract, four tiers in parallel. Tiers found to have no pool
 * are not asked again for DCL_POOL_TTL_MS; an existing pool's state is always fresh.
 */
export function createDclPoolReader(rpc: RpcClient, contract: string, now: () => number = Date.now): DclPoolReader {
  const missing = new Map<string, number>()
  const get = async (id: string): Promise<DclPool | null> => {
    const until = missing.get(id)
    if (until !== undefined && until > now()) return null
    const pool = parseDclPool(await rpc.viewFunction<unknown>(contract, 'get_pool', { pool_id: id }, 'final'))
    if (pool) missing.delete(id)
    else missing.set(id, now() + DCL_POOL_TTL_MS)
    return pool
  }
  return {
    async pools(a, b) {
      if (a === b) return []
      const found = await Promise.all(DCL_FEE_TIERS.map((fee) => get(dclPoolId(a, b, fee))))
      return found.filter((p): p is DclPool => p !== null && p.running && p.liquidity > 0n).sort((p, q) => (q.liquidity > p.liquidity ? 1 : q.liquidity < p.liquidity ? -1 : 0))
    },
  }
}
