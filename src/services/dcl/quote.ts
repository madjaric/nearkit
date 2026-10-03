import type { NetworkConfig } from '@/config/networks'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { RpcError, type RpcClient } from '@/services/near/rpc'
import { type DclPool, type DclPoolReader } from './pools'

/**
 * Quotes on DCL v2 pools, from the contract itself: `quote` returns exactly what the pools
 * would pay now for `input_amount`, after their fees. It takes a path of pools, so a
 * two-hop route (TOKEN → USDC → wNEAR) is one call and one swap.
 */

export interface DclQuoteParams {
  pools: readonly string[]
  tokenIn: string
  tokenOut: string
  amountIn: bigint
}

const INT = /^\d+$/

/** The pools' output for `amountIn`, or 0n when they can't fill it. Throws on an RPC failure. */
export async function dclQuote(rpc: RpcClient, contract: string, p: DclQuoteParams): Promise<bigint> {
  let result: unknown
  try {
    result = await rpc.viewFunction<unknown>(
      contract,
      'quote',
      { pool_ids: [...p.pools], input_token: p.tokenIn, input_amount: p.amountIn.toString(), output_token: p.tokenOut, tag: 'nearkit' },
      'final',
    )
  } catch (e) {
    // The contract refuses a quote it can't make (a pool that isn't there, a path that doesn't connect): no route.
    if (e instanceof RpcError && e.kind === 'contract') return 0n
    throw toNearKitError(e, 'RPC_ERROR')
  }
  const amount = typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as { amount?: unknown }).amount : null
  if (typeof amount !== 'string' || !INT.test(amount)) return 0n
  return BigInt(amount)
}

export interface DclRoute {
  pools: string[]
  /** Every token on the path, input first and output last. */
  tokens: string[]
  amountIn: bigint
  amountOut: bigint
}

/** Token paths to try for a pair: the pair itself, then through each of the network's stablecoins. */
export function dclTokenPaths(network: Pick<NetworkConfig, 'stableTokens' | 'wrapContract'>, tokenIn: string, tokenOut: string): string[][] {
  const paths: string[][] = [[tokenIn, tokenOut]]
  const vias = [...new Set([network.wrapContract, ...network.stableTokens.map((s) => s.contract)])]
  for (const via of vias) if (via !== tokenIn && via !== tokenOut) paths.push([tokenIn, via, tokenOut])
  return paths
}

/** Pool combinations of a token path, at most the two deepest pools per hop, so a two-hop path costs at most four quotes. */
function poolPaths(hops: DclPool[][]): string[][] {
  let combos: string[][] = [[]]
  for (const pools of hops) {
    const next: string[][] = []
    for (const c of combos) for (const p of pools.slice(0, 2)) next.push([...c, p.id])
    combos = next
  }
  return combos
}

/**
 * The best DCL route for a pair now: every candidate path is quoted on chain and the one
 * with the highest output wins. Null when no pool of the pair has liquidity or nothing fills
 * the amount. `rpc` failures propagate (the caller says the quote is unavailable, never that
 * there is no route).
 */
export async function bestDclRoute(
  rpc: RpcClient,
  contract: string,
  reader: DclPoolReader,
  network: Pick<NetworkConfig, 'stableTokens' | 'wrapContract'>,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<DclRoute | null> {
  if (tokenIn === tokenOut) throw new NearKitError('INVALID_TOKEN', 'Choose two different tokens')
  const candidates = await Promise.all(
    dclTokenPaths(network, tokenIn, tokenOut).map(async (tokens) => {
      const hops = await Promise.all(tokens.slice(1).map((t, i) => reader.pools(tokens[i] as string, t)))
      if (hops.some((h) => h.length === 0)) return []
      return Promise.all(poolPaths(hops).map(async (pools) => ({ pools, tokens, amountIn, amountOut: await dclQuote(rpc, contract, { pools, tokenIn, tokenOut, amountIn }) })))
    }),
  )
  let best: DclRoute | null = null
  for (const route of candidates.flat()) if (route.amountOut > 0n && (best === null || route.amountOut > best.amountOut)) best = route
  return best
}
