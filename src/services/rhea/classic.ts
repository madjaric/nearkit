import { NearKitError } from '@/services/near/errors'

/**
 * Rhea's classic Smart Router (`findPath`) over the classic exchange. NearKit
 * uses it on testnet, where the aggregator doesn't exist. It has no integrator
 * fee mechanism, and NearKit charges no fee on testnet. The route becomes the
 * exchange's `ft_transfer_call` message; the exchange enforces each minimum
 * and refunds the whole input if any hop misses it.
 */

export interface FindPathParams {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  slippage: number
}

export interface ClassicAction {
  pool_id: number
  token_in: string
  token_out: string
  amount_in?: string
  min_amount_out: string
}

export interface ClassicRoute {
  amountIn: bigint
  amountOut: bigint
  minAmountOut: bigint
  actions: ClassicAction[]
  routeTokens: string[]
}

const INT = /^\d+$/
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const rejected = (message: string) => new NearKitError('QUOTE_REJECTED', `NearKit refused the route: ${message}. Nothing was signed.`)

export function findPathUrl(base: string, p: FindPathParams): string {
  const url = new URL(base)
  url.searchParams.set('amountIn', p.amountIn.toString())
  url.searchParams.set('tokenIn', p.tokenIn)
  url.searchParams.set('tokenOut', p.tokenOut)
  url.searchParams.set('pathDeep', '3')
  url.searchParams.set('slippage', String(p.slippage))
  return url.toString()
}

export function parseFindPath(json: unknown, p: FindPathParams): ClassicRoute {
  const data = obj(json) && json.result_code === 0 && obj(json.result_data) ? json.result_data : null
  if (!data || !Array.isArray(data.routes) || data.routes.length === 0 || typeof data.amount_out !== 'string' || !INT.test(data.amount_out) || data.amount_out === '0') {
    throw new NearKitError('QUOTE_UNAVAILABLE', 'Rhea found no route for this trade')
  }
  const actions: ClassicAction[] = []
  const routeTokens = [p.tokenIn]
  let covered = 0n
  let minOut = 0n
  for (const route of data.routes) {
    if (!obj(route) || !Array.isArray(route.pools) || route.pools.length === 0 || typeof route.amount_in !== 'string' || !INT.test(route.amount_in))
      throw rejected('a route is malformed')
    let current = p.tokenIn
    for (const [i, pool] of route.pools.entries()) {
      if (
        !obj(pool) ||
        typeof pool.pool_id !== 'string' ||
        !INT.test(pool.pool_id) ||
        typeof pool.token_out !== 'string' ||
        typeof pool.min_amount_out !== 'string' ||
        !INT.test(pool.min_amount_out)
      ) {
        throw rejected('a pool is malformed')
      }
      if (!Number.isSafeInteger(Number(pool.pool_id))) throw rejected('a pool id is out of range')
      if (pool.token_in !== current) throw rejected(i === 0 ? 'it starts from a different token' : 'its hops do not connect')
      current = pool.token_out
      if (!routeTokens.includes(current)) routeTokens.push(current)
      actions.push({
        pool_id: Number(pool.pool_id),
        token_in: pool.token_in,
        token_out: pool.token_out,
        ...(i === 0 ? { amount_in: route.amount_in } : {}),
        min_amount_out: pool.min_amount_out,
      })
    }
    if (current !== p.tokenOut) throw rejected('it ends in a different token')
    const last = route.pools.at(-1) as { min_amount_out: string }
    covered += BigInt(route.amount_in)
    minOut += BigInt(last.min_amount_out)
  }
  if (covered !== p.amountIn) throw rejected('it covers a different input amount')
  if (minOut === 0n) throw rejected('it has no minimum output')
  const amountOut = BigInt(data.amount_out)
  if (amountOut < minOut) throw rejected('its expected output is below its own minimum')
  // The router applies the slippage to each route; allow 0.1 point for rounding across routes.
  const slippagePpm = BigInt(Math.round(p.slippage * 1_000_000))
  if (minOut < (amountOut * (1_000_000n - slippagePpm - 1_000n)) / 1_000_000n) throw rejected(`its minimum is looser than your ${(p.slippage * 100).toFixed(2)}% slippage limit`)
  routeTokens.splice(routeTokens.indexOf(p.tokenOut), 1)
  routeTokens.push(p.tokenOut)
  return { amountIn: p.amountIn, amountOut, minAmountOut: minOut, actions, routeTokens }
}

/** `ft_transfer_call` msg for the classic exchange. `skip_unwrap_near: false` makes it deliver native NEAR. */
export function classicSwapMsg(route: ClassicRoute, { unwrapNear }: { unwrapNear: boolean }): string {
  return JSON.stringify({ actions: route.actions, ...(unwrapNear ? { skip_unwrap_near: false } : {}) })
}

export function createFindPathClient({
  baseUrl,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 10_000,
}: {
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
}) {
  return {
    async quote(p: FindPathParams): Promise<ClassicRoute> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      try {
        res = await fetchImpl(findPathUrl(baseUrl, p), { signal: controller.signal, headers: { accept: 'application/json' } })
      } catch (e) {
        throw new NearKitError('QUOTE_UNAVAILABLE', 'Rhea’s router did not answer. Try again in a moment.', { detail: e instanceof Error ? e.message : String(e) })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new NearKitError('QUOTE_UNAVAILABLE', `Rhea’s router answered HTTP ${res.status}. Try again in a moment.`)
      let json: unknown
      try {
        json = await res.json()
      } catch {
        throw new NearKitError('QUOTE_UNAVAILABLE', 'Rhea’s router returned something that isn’t a route')
      }
      return parseFindPath(json, p)
    },
  }
}

export type FindPathClient = ReturnType<typeof createFindPathClient>
