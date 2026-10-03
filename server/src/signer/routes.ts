import type { NetworkConfig } from '@/config/networks'
import { mulBps } from '@/lib/amounts'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { dclQuote } from '@/services/dcl/quote'
import { dclPathTokens, dclSwapMsg } from '@/services/dcl/swap'
import { NearKitError } from '@/services/near/errors'
import { createRpcClient } from '@/services/near/rpc'
import { createFindPathClient } from '@/services/rhea/classic'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, verifySmartxSignature, type VerifiedRoute } from '@/services/rhea/smartx'
import { PolicyViolation, type SwapRouteFacts } from '../custody/policy'

/**
 * The signer's own check of a swap route, independent of the app that asked for it.
 *
 * - Mainnet: only Rhea's aggregator, whose routes carry NearKit's fee. The signer checks
 *   Rhea's signature on the route, decodes it and checks every field against what it
 *   knows itself: the wallet as the only user and receiver, NearKit's fee rate, and the
 *   fee account (the one canonical account, from the signer's own configuration).
 * - Testnet: only Rhea's classic exchange (no fee there).
 * - DCL directly (either network): the pools must connect the input to the output, the fee
 *   transfer must be NearKit's rate to the canonical account (mainnet) or absent (testnet),
 *   and the message must be exactly the one for those pools and that minimum.
 * - Everywhere: the signer asks for its own quote of the same swap, right now (Rhea for Rhea's
 *   routes, the DCL contract on chain for DCL routes), and refuses a route whose minimum is
 *   more than its slippage cap below that quote. An app that is compromised can't get a swap
 *   signed at a price far from the market.
 */

export interface RouteOracle {
  /** The expected output for this swap right now, asked by the signer itself (Rhea, or the DCL contract for `pools`). */
  expectedOut(q: {
    router: SwapRouteFacts['router']
    tokenIn: string
    tokenOut: string
    /** What the exchange receives (a direct route's input less its fee). */
    amountIn: bigint
    user: string
    nativeOut: boolean
    feeRecipient: string | null
    pools?: readonly string[]
  }): Promise<bigint>
}

export function createRouteOracle(network: NetworkConfig, fetchImpl?: typeof fetch): RouteOracle {
  const agg = network.rhea.aggregator
  const smartx = agg ? createSmartxClient({ baseUrl: agg.quoteUrl, fetch: fetchImpl }) : null
  const findPath = createFindPathClient({ baseUrl: network.rhea.classic.findPathUrl, fetch: fetchImpl })
  const rpc = createRpcClient({ urls: network.rpcUrls, fetch: fetchImpl })
  return {
    async expectedOut(q) {
      if (q.router === 'dcl') {
        const out = await dclQuote(rpc, network.dex.dcl.contract, { pools: q.pools ?? [], tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn })
        if (out <= 0n) throw new PolicyViolation('the DCL contract quotes nothing for this route right now')
        return out
      }
      if (q.router === 'aggregator') {
        if (!smartx || !q.feeRecipient) throw new PolicyViolation('there is no fee-bearing router on this network')
        const quote = await smartx.quote({
          tokenIn: q.tokenIn,
          tokenOut: q.tokenOut,
          amountIn: q.amountIn,
          slippage: 0.005,
          user: q.user,
          skipUnwrapNativeToken: !q.nativeOut,
          appFeeRate: NEARKIT_FEE_BPS,
          appFeeRecipient: q.feeRecipient,
        })
        return quote.amountOut
      }
      return (await findPath.quote({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, slippage: 0.005 })).amountOut
    },
  }
}

export interface RoutePolicy {
  network: NetworkConfig
  /** Where NearKit's fee must go on this network (the canonical account), or null where no fee is charged. */
  feeRecipient: string | null
  /** The most a route's minimum may sit below the signer's own quote, in parts per million. */
  maxSlippagePpm: number
  oracle: RouteOracle
  now: () => number
}

const PPM = 1_000_000n

/** What the signer verified of an aggregator route (the plan check uses these, not the app's). */
export interface CheckedRoute {
  routeTokens: string[]
  verified: VerifiedRoute | null
}

export async function verifySwapRoute(route: SwapRouteFacts, walletAccount: string, p: RoutePolicy): Promise<CheckedRoute> {
  const agg = p.network.rhea.aggregator
  const floor = (expected: bigint) => (expected * (PPM - BigInt(p.maxSlippagePpm))) / PPM
  const ask = async () => {
    try {
      return await p.oracle.expectedOut({
        router: route.router,
        tokenIn: route.routeIn,
        tokenOut: route.routeOut,
        amountIn: route.direct ? route.direct.swapAmount : route.amountIn,
        user: walletAccount,
        nativeOut: route.nativeOut,
        feeRecipient: p.feeRecipient,
        ...(route.pools ? { pools: route.pools } : {}),
      })
    } catch (e) {
      if (e instanceof PolicyViolation) throw e
      // No independent quote, no signature: fail closed.
      throw new PolicyViolation(`the signer could not check the price (${e instanceof Error ? e.message : 'no answer'})`)
    }
  }

  if (route.router === 'dcl') {
    const dcl = p.network.dex.dcl
    if (route.receiver !== dcl.contract) throw new PolicyViolation('the swap goes to a contract that is not the DCL exchange')
    if (!route.pools || route.pools.length === 0 || route.pools.length > 3) throw new PolicyViolation('the route names no pools')
    const path = dclPathTokens(route.pools, route.routeIn)
    if (!path || path.at(-1) !== route.routeOut) throw new PolicyViolation('the route’s pools do not connect the input to the output')
    if (path.join(',') !== route.routeTokens.join(',')) throw new PolicyViolation('the route’s tokens differ from its pools')
    const direct = route.direct
    if (!direct) throw new PolicyViolation('a direct route must state what the exchange receives and the fee')
    if (p.network.id === 'mainnet') {
      if (!p.feeRecipient) throw new PolicyViolation('no NearKit fee account is configured for the signer')
      if (direct.feeRecipient !== p.feeRecipient) throw new PolicyViolation('the fee goes to an account that is not NearKit’s fee account')
      if (direct.fee !== mulBps(route.amountIn, NEARKIT_FEE_BPS)) throw new PolicyViolation('the fee is not NearKit’s fee rate of the amount')
    } else if (direct.fee !== 0n || direct.feeRecipient !== null) {
      throw new PolicyViolation('no fee is charged on this network')
    }
    if (direct.swapAmount !== route.amountIn - direct.fee) throw new PolicyViolation('the exchange does not receive the amount less the fee')
    // The message's minimum is what the pools must pay; the user's minimum is that less the output token's own tax, never more.
    const poolMin = route.signedMin ?? route.minOut
    if (poolMin < route.minOut) throw new PolicyViolation('the route’s minimum is above what its message enforces')
    const expectedMsg = dclSwapMsg({
      pools: route.pools,
      outputToken: route.routeOut,
      minOut: poolMin,
      skipUnwrapNear: !route.nativeOut && route.routeOut === p.network.wrapContract,
    })
    if (route.msg !== expectedMsg) throw new PolicyViolation('the swap message differs from the verified route')
    // The signer's own quote is for the input as sent (a launch token's sell tax is not read here, so the floor is conservative).
    const expected = await ask()
    if (poolMin < floor(expected)) throw new PolicyViolation('the route’s minimum is further below the DCL contract’s current quote than the signer allows')
    return { routeTokens: route.routeTokens, verified: null }
  }

  if (!agg) {
    if (route.router !== 'classic') throw new PolicyViolation('only Rhea’s classic exchange is allowed on this network')
    const expected = await ask()
    if (route.minOut < floor(expected)) throw new PolicyViolation('the route’s minimum is further below Rhea’s current price than the signer allows')
    return { routeTokens: route.routeTokens, verified: null }
  }

  // Mainnet: the aggregator and NearKit's fee, always.
  if (route.router !== 'aggregator') throw new PolicyViolation('on this network swaps go through Rhea’s aggregator, with NearKit’s fee')
  if (!p.feeRecipient) throw new PolicyViolation('no NearKit fee account is configured for the signer')
  if (route.receiver !== agg.contract) throw new PolicyViolation('the swap goes to a contract that is not Rhea’s aggregator')
  let signed: { msg?: unknown; signature?: unknown }
  try {
    signed = JSON.parse(route.msg) as typeof signed
  } catch {
    throw new PolicyViolation('the route message is unreadable')
  }
  if (!signed || typeof signed !== 'object' || typeof signed.msg !== 'string' || typeof signed.signature !== 'string' || Object.keys(signed).length !== 2)
    throw new PolicyViolation('the route message is malformed')
  if (!(await verifySmartxSignature(signed.msg, signed.signature, agg.signerKey))) throw new PolicyViolation('Rhea’s signature on the route did not verify')
  const signedMin = route.signedMin
  if (signedMin === undefined) throw new PolicyViolation('the route’s signed minimum is missing')
  const expected = await ask()
  let verified: VerifiedRoute
  try {
    verified = checkSmartxRoute(
      { amountIn: route.amountIn, amountOut: expected, minAmountOut: signedMin, dexs: [], tokens: [], msg: signed.msg, signature: signed.signature },
      decodeSmartxMsg(signed.msg),
      {
        user: walletAccount,
        tokenIn: route.routeIn,
        tokenOut: route.routeOut,
        amountIn: route.amountIn,
        slippage: p.maxSlippagePpm / 1_000_000,
        skipUnwrapNear: !route.nativeOut,
        appFeePpm: NEARKIT_FEE_BPS * 100,
        appFeeRecipient: p.feeRecipient,
        dexReceivers: agg.dexReceivers,
        referrals: agg.referrals,
      },
      p.now(),
    )
  } catch (e) {
    if (e instanceof NearKitError) throw new PolicyViolation(e.message.replace(/^NearKit refused Rhea’s route: /, '').replace(/\. Nothing was signed\.$/, ''))
    throw e
  }
  // The minimum the user confirmed is never more than what the route itself enforces.
  if (route.minOut > signedMin) throw new PolicyViolation('the route’s minimum is above what its signature enforces')
  if (verified.routeTokens.join(',') !== route.routeTokens.join(',')) throw new PolicyViolation('the route’s tokens differ from the signed route')
  return { routeTokens: verified.routeTokens, verified }
}
