import { NATIVE_TOKEN_ID } from '@/config/networks'
import { mulBps } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { MAX_SLIPPAGE, NEARKIT_FEE_BPS } from '@/lib/fees'
import { createDclPoolReader, type DclPoolReader } from '@/services/dcl/pools'
import { bestDclRoute } from '@/services/dcl/quote'
import { dclSwapMsg, directFee } from '@/services/dcl/swap'
import { readTransferTax } from '@/services/dcl/tax'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { storageBoundsMin, storageStatus } from '@/services/near/storage'
import { classicSwapMsg, createFindPathClient, type FindPathClient } from '@/services/rhea/classic'
import { feeTokenFor, trueMinimum, type FeeStage } from '@/services/rhea/fees'
import { checkSmartxRoute, createSmartxClient, decodeSmartxMsg, verifySmartxSignature, type SmartxClient } from '@/services/rhea/smartx'
import { selectRoute, type RouteSource } from '@/services/routing/select'
import type { QuoteRequest } from '@/types/domain'
import type { TokenRef } from '@/types/operations'
import { parseAmount, resolveToken } from './common'
import type { NearContext } from './context'

/**
 * NearKit's router: one place that turns a quote request into an executable route, for the
 * web app and the server alike (ROUTING_PLAN.md). Every source that can quote the pair is
 * asked, every answer is verified, and the one that pays the most is returned:
 *
 * - Rhea's aggregator (mainnet): server-signed routes across Rhea's DEXs, checked field by
 *   field before anything is signed, carrying NearKit's app fee.
 * - Rhea's classic router (testnet, where there is no aggregator): no fee.
 * - DCL v2 directly, on both networks: the pools of the pair read from the contract itself,
 *   quoted on chain, so a pool created a minute ago is tradable now. NearKit's fee is a
 *   transfer to the fee account in the same transaction as the swap.
 *
 * On-chain prerequisites (registrations) are read right before a plan is built.
 */

export interface SwapFeeInfo {
  stage: FeeStage
  /** Routing token the fee is taken from. */
  token: string
  appPpm: number
  protocolPpm: number
  routerShareBps: number
  recipient: string
  /** Direct routes: the fee is this transfer to the recipient, in the swap's own transaction. */
  transfer?: { amount: bigint }
}

export interface RoutedSwap {
  router: 'aggregator' | 'classic' | 'dcl'
  source: RouteSource
  tokenIn: TokenRef
  tokenOut: TokenRef
  /** Routing contracts: wNEAR stands in for NEAR. */
  routeIn: string
  routeOut: string
  /** What the user puts in. */
  amountIn: bigint
  /** What the DEX receives: `amountIn` less a direct route's fee transfer. */
  swapAmount: bigint
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
  /** Direct DCL routes: the pools of the path, in order. */
  pools?: string[]
  /** Direct DCL routes: the tokens' own tax on this trade (what enters the pool, what leaves it), already in the amounts. */
  tax?: { inBps: number; outBps: number }
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
const PPM = 1_000_000n

/** What a quote asks for, resolved: the routing contracts and the exact input. */
interface Pair {
  tokenIn: TokenRef
  tokenOut: TokenRef
  routeIn: string
  routeOut: string
  nativeOut: boolean
  amountIn: bigint
  slippage: number
  slippagePct: number
  user: string | null
  verify: boolean
  quotedAt: number
}

/** Fees still to come off a quoted output, for comparing routes (an aggregator fee taken from the output). */
export function outputFeePpm(r: Pick<RoutedSwap, 'fee'>): number {
  return r.fee && r.fee.stage === 'output' ? r.fee.appPpm + r.fee.protocolPpm : 0
}

export function createSwapRouter(ctx: NearContext) {
  const agg = ctx.network.rhea.aggregator
  const dcl = ctx.network.dex.dcl
  const smartx: SmartxClient | null = agg ? createSmartxClient({ baseUrl: agg.quoteUrl, fetch: ctx.fetch, now: ctx.now }) : null
  const findPath: FindPathClient = createFindPathClient({ baseUrl: ctx.network.rhea.classic.findPathUrl, fetch: ctx.fetch })
  const dclPools: DclPoolReader = createDclPoolReader(ctx.rpc, dcl.contract, ctx.now)
  /** The fee is collected on mainnet only (testnet charges nothing, on any route). */
  const feeCharged = ctx.network.id === 'mainnet'

  let feeConfig: Promise<{ whitelist: Set<string>; protocolPpm: number }> | null = null

  /** Fees credited to an account that does not exist could never be withdrawn, so trading stops. */
  let feeAccountExists: string | null = null
  async function assertFeeAccountExists(accountId: string): Promise<void> {
    if (feeAccountExists === accountId) return
    if (!(await accountState(ctx.rpc, accountId, 'final')).exists)
      throw new NearKitError(
        'EXECUTION_DISABLED',
        `The NEARKITS fee account ${accountId} does not exist on ${ctx.network.label.toLowerCase()}, so trades are blocked. Nothing was signed.`,
      )
    feeAccountExists = accountId
  }
  function feeRecipient(): string {
    const recipient = ctx.env.feeRecipient
    if (!recipient)
      throw new NearKitError('EXECUTION_DISABLED', ctx.capabilities.execution.trading.reason ?? 'The NEARKITS fee account is not configured, so trades are blocked on mainnet')
    return recipient
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

  /** Rhea's aggregator: a signed route with NearKit's app fee, verified before it is trusted. */
  async function aggregatorRoute(p: Pair): Promise<RoutedSwap> {
    if (!agg || !smartx) throw new Error('No aggregator on this network')
    const recipient = feeRecipient()
    const appPpm = NEARKIT_FEE_BPS * 100
    const [quote, fees] = await Promise.all([
      smartx.quote({
        tokenIn: p.routeIn,
        tokenOut: p.routeOut,
        amountIn: p.amountIn,
        slippage: p.slippage,
        user: p.user,
        skipUnwrapNativeToken: !p.nativeOut,
        appFeeRate: NEARKIT_FEE_BPS,
        appFeeRecipient: recipient,
        symbolIn: p.tokenIn.symbol,
        symbolOut: p.tokenOut.symbol,
      }),
      aggregatorFeeConfig(),
      p.verify ? assertFeeAccountExists(recipient) : null,
    ])
    if (p.verify && !(await verifySmartxSignature(quote.msg, quote.signature, agg.signerKey))) {
      throw new NearKitError('QUOTE_REJECTED', 'NEARKITS refused Rhea’s route: its signature did not verify. Nothing was signed.')
    }
    const checked = checkSmartxRoute(
      quote,
      decodeSmartxMsg(quote.msg),
      {
        user: p.user ?? '',
        tokenIn: p.routeIn,
        tokenOut: p.routeOut,
        amountIn: p.amountIn,
        slippage: p.slippage,
        skipUnwrapNear: !p.nativeOut,
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
      source: 'rhea-aggregator',
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      routeIn: p.routeIn,
      routeOut: p.routeOut,
      amountIn: p.amountIn,
      swapAmount: p.amountIn,
      amountOut: quote.amountOut,
      signedMin: quote.minAmountOut,
      minOut: trueMinimum(quote.minAmountOut, stage.stage, appPpm, fees.protocolPpm),
      slippagePct: p.slippagePct,
      routeTokens: checked.routeTokens,
      stepContracts,
      multiDex: checked.multiDex,
      receiver: agg.contract,
      msg: JSON.stringify({ msg: quote.msg, signature: quote.signature }),
      deadline: checked.deadline,
      fee: { stage: stage.stage, token: stage.token, appPpm, protocolPpm: fees.protocolPpm, routerShareBps: agg.appFeeRouterShareBps, recipient },
      quotedAt: p.quotedAt,
    }
  }

  /** Rhea's classic router (testnet): the exchange's message, no fee. */
  async function classicRoute(p: Pair): Promise<RoutedSwap> {
    const r = await findPath.quote({
      tokenIn: p.routeIn,
      tokenOut: p.routeOut,
      amountIn: p.amountIn,
      slippage: p.slippage,
      symbolIn: p.tokenIn.symbol,
      symbolOut: p.tokenOut.symbol,
    })
    return {
      router: 'classic',
      source: 'rhea-classic',
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      routeIn: p.routeIn,
      routeOut: p.routeOut,
      amountIn: p.amountIn,
      swapAmount: p.amountIn,
      amountOut: r.amountOut,
      signedMin: r.minAmountOut,
      minOut: r.minAmountOut,
      slippagePct: p.slippagePct,
      routeTokens: r.routeTokens,
      stepContracts: [p.routeIn],
      multiDex: false,
      receiver: ctx.network.rhea.classic.exchange,
      msg: classicSwapMsg(r, { unwrapNear: p.nativeOut }),
      deadline: null,
      fee: null,
      quotedAt: p.quotedAt,
    }
  }

  /**
   * DCL v2 directly: the pools of the pair (and through a stablecoin) read and quoted on the
   * contract. The fee comes off the input first; the pools are quoted for the rest, less the
   * input token's own tax on what enters a pool (nearlytrade launches). The contract enforces
   * the minimum on what the pools pay; the output token's own tax on what leaves a pool comes
   * off after that, so the user's expected and minimum amounts are shown after it.
   */
  async function dclRoute(p: Pair): Promise<RoutedSwap> {
    const recipient = feeCharged ? feeRecipient() : null
    const fee = recipient ? directFee(p.amountIn) : 0n
    const swapAmount = p.amountIn - fee
    if (swapAmount <= 0n) throw new NearKitError('INVALID_AMOUNT', 'The amount is too small to trade')
    const [inTax, outTax] = await Promise.all([
      readTransferTax(ctx.rpc, p.routeIn, dcl.contract),
      readTransferTax(ctx.rpc, p.routeOut, dcl.contract),
      p.verify && recipient ? assertFeeAccountExists(recipient) : null,
    ])
    const poolGets = swapAmount - mulBps(swapAmount, inTax.sellBps)
    if (poolGets <= 0n) throw new NearKitError('INVALID_AMOUNT', 'The amount is too small to trade')
    const best = await bestDclRoute(ctx.rpc, dcl.contract, dclPools, ctx.network, p.routeIn, p.routeOut, poolGets)
    if (!best)
      throw new NearKitError(
        'QUOTE_UNAVAILABLE',
        `DCL has no pool with liquidity for ${p.tokenIn.symbol} → ${p.tokenOut.symbol}, directly or through a stablecoin, that fills this amount.`,
      )
    const poolMin = (best.amountOut * (PPM - BigInt(Math.round(p.slippage * 1_000_000)))) / PPM
    if (poolMin <= 0n) throw new NearKitError('QUOTE_UNAVAILABLE', `DCL pays nothing for this amount of ${p.tokenIn.symbol}.`)
    const amountOut = best.amountOut - mulBps(best.amountOut, outTax.buyBps)
    const minOut = poolMin - mulBps(poolMin, outTax.buyBps)
    return {
      router: 'dcl',
      source: 'dcl',
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      routeIn: p.routeIn,
      routeOut: p.routeOut,
      amountIn: p.amountIn,
      swapAmount,
      amountOut,
      signedMin: poolMin,
      minOut,
      slippagePct: p.slippagePct,
      routeTokens: best.tokens,
      stepContracts: [p.routeIn],
      multiDex: false,
      receiver: dcl.contract,
      msg: dclSwapMsg({ pools: best.pools, outputToken: p.routeOut, minOut: poolMin, skipUnwrapNear: !p.nativeOut && p.routeOut === ctx.network.wrapContract }),
      pools: best.pools,
      tax: { inBps: inTax.sellBps, outBps: outTax.buyBps },
      deadline: null,
      fee: recipient ? { stage: 'input', token: p.routeIn, appPpm: NEARKIT_FEE_BPS * 100, protocolPpm: 0, routerShareBps: 0, recipient, transfer: { amount: fee } } : null,
      quotedAt: p.quotedAt,
    }
  }

  const pairLabel = (p: Pair) => `${p.tokenIn.symbol} → ${p.tokenOut.symbol}`

  /**
   * No source could route the pair: one message that says so, with each source's own reason.
   * A refusal that isn't "no route" (a configuration problem, a rejected route) is raised as is.
   */
  function noRoute(p: Pair, failures: { source: RouteSource; error: unknown }[]): never {
    const serious = failures.map((f) => toNearKitError(f.error, 'QUOTE_UNAVAILABLE')).find((e) => e.code !== 'QUOTE_UNAVAILABLE' && e.code !== 'RPC_ERROR')
    if (serious) throw serious
    const reasons = failures.map((f) => `${f.source === 'dcl' ? 'DCL' : 'Rhea'}: ${toNearKitError(f.error, 'QUOTE_UNAVAILABLE').message}`)
    throw new NearKitError('QUOTE_UNAVAILABLE', `No executable route found for ${pairLabel(p)} right now. ${reasons.join(' ')}`.trim())
  }

  /**
   * A fresh route from the best source. `user` binds an aggregator route to its signer;
   * `verify` also checks Rhea's signature and the fee account (always done before a plan is built).
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
    const p: Pair = {
      tokenIn,
      tokenOut,
      routeIn,
      routeOut,
      nativeOut: tokenOut.contract === null,
      amountIn,
      slippage: request.slippagePct / 100,
      slippagePct: request.slippagePct,
      user,
      verify,
      quotedAt: ctx.now(),
    }
    const sources: { source: RouteSource; ask: () => Promise<RoutedSwap> }[] = [
      agg && smartx ? { source: 'rhea-aggregator' as const, ask: () => aggregatorRoute(p) } : { source: 'rhea-classic' as const, ask: () => classicRoute(p) },
      { source: 'dcl', ask: () => dclRoute(p) },
    ]
    const answers = await Promise.all(
      sources.map(async (s) =>
        s.ask().then(
          (r) => ({ ok: true as const, r }),
          (error: unknown) => ({ ok: false as const, source: s.source, error }),
        ),
      ),
    )
    const found = answers.flatMap((a) => (a.ok ? [a.r] : []))
    if (found.length === 0)
      return noRoute(
        p,
        answers.flatMap((a) => (a.ok ? [] : [{ source: a.source, error: a.error }])),
      )
    return selectRoute(found.map((r) => ({ ...r, outputFeePpm: outputFeePpm(r) })))
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

      // A direct route's fee is a token transfer: the fee account must hold that token.
      if (r.fee?.transfer && r.fee.recipient !== signer && (await storageStatus(ctx.rpc, r.routeIn, [r.fee.recipient])).get(r.fee.recipient) === false) {
        const min = await boundsOf(r.routeIn)
        if (min !== null) registrations.push({ contract: r.routeIn, accountId: r.fee.recipient, deposit: min })
      }

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
