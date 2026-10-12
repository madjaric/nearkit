import { NearKitError, toNearKitError } from '@/services/near/errors'
import { RpcError, type RpcClient } from '@/services/near/rpc'

/**
 * Some launch tokens tax transfers to and from their DEX pairs. nearlytrade launches (every
 * `*.nearlytrade.near` token runs the launchpad's global contract) answer `get_tax` with
 * `buy_bps` (taken from tokens a pair pays out), `sell_bps` (taken from tokens sent to a pair)
 * and the pairs that count; singularty.nearlytrade.near read 100 / 100 / dclv2 on 2026-10-03.
 * A swap is quoted after that tax, whichever source routes it: what an exchange that is one of
 * the pairs receives is the input less the sell tax, and what it pays out reaches the user less
 * the buy tax (a direct DCL swap: dclRoute; Rhea's aggregator: routeTax on its signed steps). A
 * token without `get_tax` reports none. A tax interface NearKit doesn't know is a documented
 * residual: the swap is quoted as if untaxed, and what arrives is read from chain.
 */

export interface TransferTax {
  /** Basis points taken from tokens the DEX pays out. */
  buyBps: number
  /** Basis points taken from tokens sent to the DEX. */
  sellBps: number
}

/** A token's tax as it states it: the rates and the exchanges (pairs) they apply to. */
export interface TaxTerms extends TransferTax {
  pairs: readonly string[]
}

export const NO_TAX: TransferTax = Object.freeze({ buyBps: 0, sellBps: 0 })
export const NO_TAX_TERMS: TaxTerms = Object.freeze({ buyBps: 0, sellBps: 0, pairs: Object.freeze([]) as readonly string[] })

const bpsOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The tax `token` states, or none. Throws only when the chain can't be asked: an unread tax is never taken for no tax. */
export async function readTaxTerms(rpc: RpcClient, token: string): Promise<TaxTerms> {
  let result: unknown
  try {
    result = await rpc.viewFunction<unknown>(token, 'get_tax', {}, 'final')
  } catch (e) {
    // No such method (every ordinary NEP-141), or a contract that refuses: no tax known.
    if (e instanceof RpcError && e.kind === 'contract') return NO_TAX_TERMS
    if (e instanceof NearKitError) throw e
    throw toNearKitError(e, 'RPC_ERROR')
  }
  const tax = isObj(result) && isObj(result.tax) ? result.tax : null
  if (!tax) return NO_TAX_TERMS
  const buyBps = bpsOf(tax.buy_bps)
  const sellBps = bpsOf(tax.sell_bps)
  const pairs = Array.isArray(tax.pairs) ? tax.pairs.filter((p): p is string => typeof p === 'string') : []
  if (buyBps === null || sellBps === null || pairs.length === 0) return NO_TAX_TERMS
  return { buyBps, sellBps, pairs }
}

/** The tax a token with these terms takes on transfers to and from `dex`: none unless `dex` is one of its pairs. */
export function taxOn(terms: TaxTerms, dex: string): TransferTax {
  return terms.pairs.includes(dex) ? { buyBps: terms.buyBps, sellBps: terms.sellBps } : NO_TAX
}

/** The tax `token` takes on transfers to and from `dex`, or none. Throws only when the chain can't be asked. */
export async function readTransferTax(rpc: RpcClient, token: string, dex: string): Promise<TransferTax> {
  return taxOn(await readTaxTerms(rpc, token), dex)
}

/** One exchange call of a route: the token sent (`contract`) to the exchange (`receiver`), and the token it pays back. */
export interface TaxedStep {
  contract: string
  receiver: string
  output: string
}

/**
 * The tax a route through one or more exchanges pays on its own transfers: the input's sell tax
 * when the first exchange is one of its pairs (that exchange receives less than it was sent), and
 * the output's buy tax when the last exchange is one of its pairs (it pays out more than arrives).
 * Transfers inside one exchange (a multi-pool DCL step) move no tokens, so they pay nothing. Null
 * when a token handed from one exchange to the next is taxed on either: NEARKITS doesn't price that.
 */
export function routeTax(steps: readonly TaxedStep[], terms: (token: string) => TaxTerms): { inBps: number; outBps: number } | null {
  let inBps = 0
  let outBps = 0
  for (const [i, step] of steps.entries()) {
    const sent = taxOn(terms(step.contract), step.receiver).sellBps
    const paid = taxOn(terms(step.output), step.receiver).buyBps
    if (i === 0) inBps = sent
    else if (sent) return null
    if (i === steps.length - 1) outBps = paid
    else if (paid) return null
  }
  return { inBps, outBps }
}
