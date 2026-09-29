import type { NetworkConfig } from '@/config/networks'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { NearKitError } from '@/services/near/errors'
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
 * - Everywhere: the signer asks Rhea for its own quote of the same swap, right now, and
 *   refuses a route whose minimum is more than its slippage cap below that quote. An app
 *   that is compromised can't get a swap signed at a price far from the market.
 */

export interface RouteOracle {
  /** Rhea's expected output for this swap right now, asked by the signer itself. */
  expectedOut(q: {
    router: SwapRouteFacts['router']
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    user: string
    nativeOut: boolean
    feeRecipient: string | null
  }): Promise<bigint>
}

export function createRouteOracle(network: NetworkConfig, fetchImpl?: typeof fetch): RouteOracle {
  const agg = network.rhea.aggregator
  const smartx = agg ? createSmartxClient({ baseUrl: agg.quoteUrl, fetch: fetchImpl }) : null
  const findPath = createFindPathClient({ baseUrl: network.rhea.classic.findPathUrl, fetch: fetchImpl })
  return {
    async expectedOut(q) {
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
        amountIn: route.amountIn,
        user: walletAccount,
        nativeOut: route.nativeOut,
        feeRecipient: p.feeRecipient,
      })
    } catch (e) {
      if (e instanceof PolicyViolation) throw e
      // No independent quote, no signature: fail closed.
      throw new PolicyViolation(`the signer could not check the price with Rhea (${e instanceof Error ? e.message : 'no answer'})`)
    }
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
