import { NearKitError, toNearKitError } from '@/services/near/errors'
import { RpcError, type RpcClient } from '@/services/near/rpc'

/**
 * Some launch tokens tax transfers to and from their DEX pairs. nearlytrade launches (every
 * `*.nearlytrade.near` token runs the launchpad's global contract) answer `get_tax` with
 * `buy_bps` (taken from tokens a pair pays out), `sell_bps` (taken from tokens sent to a pair)
 * and the pairs that count; singularty.nearlytrade.near read 100 / 100 / dclv2 on 2026-10-03.
 * A direct DCL swap is quoted after that tax: the pool receives the input less the sell tax,
 * and the user receives the pool's output less the buy tax. A token without `get_tax`
 * reports none. A tax interface NearKit doesn't know is a documented residual: the swap is
 * quoted as if untaxed.
 */

export interface TransferTax {
  /** Basis points taken from tokens the DEX pays out. */
  buyBps: number
  /** Basis points taken from tokens sent to the DEX. */
  sellBps: number
}

export const NO_TAX: TransferTax = Object.freeze({ buyBps: 0, sellBps: 0 })

const bpsOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The tax `token` takes on transfers to and from `dex`, or none. Throws only when the chain can't be asked. */
export async function readTransferTax(rpc: RpcClient, token: string, dex: string): Promise<TransferTax> {
  let result: unknown
  try {
    result = await rpc.viewFunction<unknown>(token, 'get_tax', {}, 'final')
  } catch (e) {
    // No such method (every ordinary NEP-141), or a contract that refuses: no tax known.
    if (e instanceof RpcError && e.kind === 'contract') return NO_TAX
    if (e instanceof NearKitError) throw e
    throw toNearKitError(e, 'RPC_ERROR')
  }
  const tax = isObj(result) && isObj(result.tax) ? result.tax : null
  if (!tax) return NO_TAX
  const buyBps = bpsOf(tax.buy_bps)
  const sellBps = bpsOf(tax.sell_bps)
  const pairs = Array.isArray(tax.pairs) ? tax.pairs.filter((p): p is string => typeof p === 'string') : []
  if (buyBps === null || sellBps === null || !pairs.includes(dex)) return NO_TAX
  return { buyBps, sellBps }
}
