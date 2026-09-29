import { NATIVE_TOKEN_ID } from '@/config/networks'
import { mapLimit } from '@/lib/async'
import { MAX_SLIPPAGE, NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { storageBoundsMin, storageStatus } from '@/services/near/storage'
import { classicSwapMsg, createFindPathClient, type FindPathClient } from '@/services/rhea/classic'
import { feeTokenFor, trueMinimum, type FeeStage } from '@/services/rhea/fees'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, verifySmartxSignature, type SmartxClient } from '@/services/rhea/smartx'
import type { QuoteRequest } from '@/types/domain'
import type { TokenRef } from '@/types/operations'
import { parseAmount, resolveToken } from './common'
import type { NearContext } from './context'

/**
 * Routing and on-chain prerequisites for swaps. Mainnet routes go through Rhea's
 * aggregator with NearKit's app fee (`appFeeRate=10`, 0.10%) and are verified before
 * anything is signed; testnet routes use Rhea's classic router with no fee.
 */

export interface SwapFeeInfo {
  stage: FeeStage
  /** Routing token the fee is taken from. */
  token: string
  appPpm: number
  protocolPpm: number
  routerShareBps: number
  recipient: string
}

export interface RoutedSwap {
  router: 'aggregator' | 'classic'
  tokenIn: TokenRef
  tokenOut: TokenRef
  /** Routing contracts: wNEAR stands in for NEAR. */
  routeIn: string
  routeOut: string
  amountIn: bigint
  amountOut: bigint
  /** Minimum the route itself enforces. */
  signedMin: bigint
  /** Lowest amount the user can actually receive (signed minimum less output-side fees). */
  minOut: bigint
  slippagePct: number
  routeTokens: string[]
  /** Token each DEX step starts from. */
  stepContracts: string[]
  multiDex: boolean
  /** Contract the swap's `ft_transfer_call` goes to, and its msg. */
  receiver: string
  msg: string
  deadline: number | null
  fee: SwapFeeInfo | null
  quotedAt: number
}

export interface Prerequisites {
  wrapRegister: bigint | null
  registrations: { contract: string; accountId: string; deposit: bigint }[]
  aggregatorEntries: { user: string; tokens: string[]; deposit: bigint }[]
}

const NATIVE = NATIVE_TOKEN_ID

export function createSwapRouter(ctx: NearContext) {
  const agg = ctx.network.rhea.aggregator
  const smartx: SmartxClient | null = agg ? createSmartxClient({ baseUrl: agg.quoteUrl, fetch: ctx.fetch, now: ctx.now }) : null
  const findPath: FindPathClient = createFindPathClient({ baseUrl: ctx.network.rhea.classic.findPathUrl, fetch: ctx.fetch })

  let feeConfig: Promise<{ whitelist: Set<string>; protocolPpm: number }> | null = null

  /** Fees credited to an account that does not exist could never be withdrawn, so trading stops. */
  let feeAccountExists: string | null = null
  async function assertFeeAccountExists(accountId: string): Promise<void> {
    if (feeAccountExists === accountId) return
    if (!(await accountState(ctx.rpc, accountId, 'final')).exists)
      throw new NearKitError(
        'EXECUTION_DISABLED',
        `The NearKit fee account ${accountId} does not exist on ${ctx.network.label.toLowerCase()}, so trades are blocked. Nothing was signed.`,
      )
    feeAccountExists = accountId
  }
  const aggregatorFeeConfig = () => {
    if (!agg) throw new Error('No aggregator on this network')
    feeConfig ??= Promise.all([
      ctx.rpc.viewFunction<unknown>(agg.contract, 'query_white_list_fee_tokens', { from_index: 0, count: 100 }, 'final'),
      ctx.rpc.viewFunction<unknown>(agg.contract, 'query_protocol_fee_rate', {}, 'final'),
    ])
      .then(([list, rate]) => {
        const ppm = typeof rate === 'string' && /^\d+$/.test(rate) ? Number(rate) : typeof rate === 'number' ? rate : NaN
        if (!Array.isArray(list) || !Number.isInteger(ppm) || ppm < 0 || ppm > 100_000) throw new Error('Unexpected aggregator fee configuration')
        return { whitelist: new Set(list.filter((t): t is string => typeof t === 'string')), protocolPpm: ppm }
      })
      .catch((e) => {
        feeConfig = null
        throw toNearKitError(e, 'RPC_ERROR')
      })
    return feeConfig
  }

  /**
   * A fresh route. `user` binds an aggregator route to its signer; `verify` also
   * checks Rhea's signature (always done before a plan is built).
   */
  async function route(request: QuoteRequest, user: string | null, verify: boolean): Promise<RoutedSwap> {
    if (request.tokenIn === request.tokenOut) throw new NearKitError('INVALID_TOKEN', 'Choose two different tokens')
    if (!(request.slippagePct > 0 && request.slippagePct <= MAX_SLIPPAGE)) throw new NearKitError('INVALID_AMOUNT', `Slippage must be between 0 and ${MAX_SLIPPAGE}%`)
    // A plan (verify) re-reads decimals from chain; an indicative quote may use the cache.
    const [tokenIn, tokenOut] = await Promise.all([resolveToken(ctx, request.tokenIn, { fresh: verify }), resolveToken(ctx, request.tokenOut, { fresh: verify })])
    const amountIn = parseAmount(request.amountIn, tokenIn, 'Amount')
    const routeIn = tokenIn.contract ?? ctx.network.wrapContract
    const routeOut = tokenOut.contract ?? ctx.network.wrapContract
    if (routeIn === routeOut) throw new NearKitError('INVALID_TOKEN', 'Wrapping or unwrapping NEAR is not a swap')
    const nativeOut = tokenOut.contract === null
    const slippage = request.slippagePct / 100
    const quotedAt = ctx.now()

    if (agg && smartx) {
      const recipient = ctx.env.feeRecipient
      if (!recipient)
        throw new NearKitError('EXECUTION_DISABLED', ctx.capabilities.execution.trading.reason ?? 'The NearKit fee account is not configured, so trades are blocked on mainnet')
      const appPpm = NEARKIT_FEE_BPS * 100
      const [quote, fees] = await Promise.all([
        smartx.quote({
          tokenIn: routeIn,
          tokenOut: routeOut,
          amountIn,
          slippage,
          user,
          skipUnwrapNativeToken: !nativeOut,
          appFeeRate: NEARKIT_FEE_BPS,
          appFeeRecipient: recipient,
        }),
        aggregatorFeeConfig(),
        verify ? assertFeeAccountExists(recipient) : null,
      ])
      if (verify && !(await verifySmartxSignature(quote.msg, quote.signature, agg.signerKey))) {
        throw new NearKitError('QUOTE_REJECTED', 'NearKit refused Rhea’s route: its signature did not verify. Nothing was signed.')
      }
      const checked = checkSmartxRoute(
        quote,
        decodeSmartxMsg(quote.msg),
        {
          user: user ?? '',
          tokenIn: routeIn,
          tokenOut: routeOut,
          amountIn,
          slippage,
          skipUnwrapNear: !nativeOut,
          appFeePpm: appPpm,
          appFeeRecipient: recipient,
          dexReceivers: agg.dexReceivers,
          referrals: agg.referrals,
        },
        ctx.now(),
      )
      const stepContracts = checked.steps.map((s) => s.contract)
      const stage = feeTokenFor(checked.routeTokens, stepContracts, fees.whitelist)
      return {
        router: 'aggregator',
        tokenIn,
        tokenOut,
        routeIn,
        routeOut,
        amountIn,
        amountOut: quote.amountOut,
        signedMin: quote.minAmountOut,
        minOut: trueMinimum(quote.minAmountOut, stage.stage, appPpm, fees.protocolPpm),
        slippagePct: request.slippagePct,
        routeTokens: checked.routeTokens,
        stepContracts,
        multiDex: checked.multiDex,
        receiver: agg.contract,
        msg: JSON.stringify({ msg: quote.msg, signature: quote.signature }),
        deadline: checked.deadline,
        fee: { stage: stage.stage, token: stage.token, appPpm, protocolPpm: fees.protocolPpm, routerShareBps: agg.appFeeRouterShareBps, recipient },
        quotedAt,
      }
    }

    const r = await findPath.quote({ tokenIn: routeIn, tokenOut: routeOut, amountIn, slippage })
    return {
      router: 'classic',
      tokenIn,
      tokenOut,
      routeIn,
      routeOut,
      amountIn,
      amountOut: r.amountOut,
      signedMin: r.minAmountOut,
      minOut: r.minAmountOut,
      slippagePct: request.slippagePct,
      routeTokens: r.routeTokens,
      stepContracts: [routeIn],
      multiDex: false,
      receiver: ctx.network.rhea.classic.exchange,
      msg: classicSwapMsg(r, { unwrapNear: nativeOut }),
      deadline: null,
      fee: null,
      quotedAt,
    }
  }

  const boundsCache = new Map<string, Promise<bigint | null>>()
  const boundsOf = (contract: string) => {
    let hit = boundsCache.get(contract)
    if (!hit) {
      hit = storageBoundsMin(ctx.rpc, contract)
      boundsCache.set(contract, hit)
      hit.catch(() => boundsCache.delete(contract))
    }
    return hit
  }

  async function registeredWithAggregator(user: string, tokens: string[]): Promise<string[]> {
    if (!agg || tokens.length === 0) return []
    const flags = await ctx.rpc.viewFunction<unknown>(agg.contract, 'query_user_tokens_registered', { user, tokens }, 'final')
    if (!Array.isArray(flags) || flags.length !== tokens.length) throw new NearKitError('RPC_ERROR', 'Rhea’s aggregator returned an unexpected registration list')
    return tokens.filter((_, i) => flags[i] !== true)
  }

  /** Everything the swap needs registered first, read from chain right now. */
  async function prerequisites(r: RoutedSwap, signer: string): Promise<Prerequisites> {
    const nativeIn = r.tokenIn.contract === null
    const nativeOut = r.tokenOut.contract === null
    try {
      const wrapRegister = nativeIn && (await storageStatus(ctx.rpc, r.routeIn, [signer])).get(signer) === false ? await boundsOf(r.routeIn) : null

      // The signer receives the output, or an intermediate token if a later DEX step fails.
      const userTokens = new Set(r.multiDex ? [...r.stepContracts.slice(1), r.routeOut] : [r.routeOut])
      if (nativeOut && !r.stepContracts.slice(1).includes(r.routeOut)) userTokens.delete(r.routeOut)
      if (nativeIn) userTokens.delete(r.routeIn)
      userTokens.delete(r.tokenIn.contract ?? '')

      const registrations: Prerequisites['registrations'] = []
      await mapLimit([...userTokens], 3, async (contract) => {
        if ((await storageStatus(ctx.rpc, contract, [signer])).get(signer) !== false) return
        const min = await boundsOf(contract)
        if (min !== null) registrations.push({ contract, accountId: signer, deposit: min })
      })

      const aggregatorEntries: Prerequisites['aggregatorEntries'] = []
      if (r.router === 'aggregator' && agg && r.fee) {
        const aggregatorContract = agg.contract
        // The aggregator itself must be registered on every token it holds along the way.
        await mapLimit([...new Set([...r.stepContracts, r.routeOut])], 3, async (contract) => {
          if ((await storageStatus(ctx.rpc, contract, [aggregatorContract])).get(aggregatorContract) !== false) return
          const min = await boundsOf(contract)
          if (min !== null) registrations.push({ contract, accountId: aggregatorContract, deposit: min })
        })
        const per = BigInt(agg.tokenStorageDeposit)
        // Only tokens in the signed route; Rhea's unsigned token list could otherwise inflate the registrations.
        const userMissing = await registeredWithAggregator(signer, r.routeTokens)
        if (userMissing.length) aggregatorEntries.push({ user: signer, tokens: userMissing, deposit: per * BigInt(userMissing.length) })
        // NearKit's fee account must be registered for the token the fee is taken in.
        const candidates = r.fee.stage === 'input' ? [r.fee.token] : [...new Set([r.fee.token, r.routeOut])]
        // A trader who is also the fee account is registered once, not twice.
        const covered = new Set(r.fee.recipient === signer ? userMissing : [])
        const feeMissing = (await registeredWithAggregator(r.fee.recipient, candidates)).filter((t) => !covered.has(t))
        if (feeMissing.length) aggregatorEntries.push({ user: r.fee.recipient, tokens: feeMissing, deposit: per * BigInt(feeMissing.length) })
      }
      return { wrapRegister, registrations, aggregatorEntries }
    } catch (e) {
      throw toNearKitError(e, 'RPC_ERROR')
    }
  }

  return { route, prerequisites }
}

export type SwapRouter = ReturnType<typeof createSwapRouter>

export const isNative = (id: string) => id === NATIVE
