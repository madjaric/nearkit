import { mulBps } from '@/lib/amounts'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { dclPoolTokens } from './pools'

/**
 * A direct DCL v2 swap: `ft_transfer_call` from the input token to the DCL contract with a
 * `Swap` message (the format of real direct swaps on mainnet, 2026-09-29 fixtures). The
 * contract pays the output to the sender and, when the output is wNEAR, unwraps it to NEAR
 * unless told not to.
 */

export interface DclSwapMessage {
  pools: readonly string[]
  outputToken: string
  minOut: bigint
  /** Keep wNEAR as wNEAR (the user asked for the token, not native NEAR). */
  skipUnwrapNear: boolean
}

export function dclSwapMsg(m: DclSwapMessage): string {
  return JSON.stringify({
    Swap: { pool_ids: [...m.pools], output_token: m.outputToken, min_output_amount: m.minOut.toString(), ...(m.skipUnwrapNear ? { skip_unwrap_near: true } : {}) },
  })
}

/** The tokens a pool path passes through from `tokenIn`, input first; null when the pools don't connect. */
export function dclPathTokens(pools: readonly string[], tokenIn: string): string[] | null {
  const tokens = [tokenIn]
  let current = tokenIn
  for (const id of pools) {
    const pool = dclPoolTokens(id)
    if (!pool) return null
    if (current === pool.tokenX) current = pool.tokenY
    else if (current === pool.tokenY) current = pool.tokenX
    else return null
    tokens.push(current)
  }
  return tokens
}

/**
 * NearKit's fee on a direct DEX route: NEARKIT_FEE_BPS of the input, floored, transferred to the
 * fee account in the same transaction as the swap; the DEX receives the rest. Exactly the
 * one fee, with no router share.
 */
export function directFee(amountIn: bigint): bigint {
  return mulBps(amountIn, NEARKIT_FEE_BPS)
}
