import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { NEARKIT_FEE_BPS, NEARKIT_FEE_LABEL } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { createCongestionProbe, NETWORK_BUSY_WARNING } from '@/services/near/congestion'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { groupTransactions, registrationWarnings, txStorageYocto, txUpfrontYocto } from '@/services/near/plans'
import { HIGH_REGISTRATION_YOCTO } from '@/services/near/storage'
import { aggregatorFee, grossOf } from '@/services/rhea/fees'
import { buildSwapTransactions } from '@/services/rhea/swapTransactions'
import type { LimitOrder, MultiTradeLegQuote, MultiTradeQuote, OrderExpiry, Quote, QuoteRequest, Wallet } from '@/types/domain'
import type { FeeDisclosure, OperationPlan, PlanLine, PlannedTransaction, SwapDetails, TokenRef } from '@/types/operations'
import type { TradingService, WalletService } from '../types'
import { amountValue, executableWallet, nearText, nearValue, newPlanId, requireSession, sumRaw, walletOf } from './common'
import type { NearContext } from './context'
import type { Market } from './market'
import { createSwapRouter, type RoutedSwap } from './swapRouting'

/**
 * Real trading. Quotes are indicative; `prepareSwap` always fetches a fresh
 * route bound to the signer, verifies it, reads every prerequisite from chain
 * and returns the exact plan the user signs. Plans expire with their quote.
 * Limit, take-profit and stop-loss orders are local drafts: nothing executes them.
 */

const DISPLAY_TTL_MS = 30_000
const REVIEW_WINDOW_MS = 120_000
/** Typical burn of an aggregator swap: 0.0035–0.0046 NEAR on four real swaps (§13). */
const SWAP_BURN_YOCTO = 5n * 10n ** 21n
const SIMPLE_TX_BURN_YOCTO = 5n * 10n ** 20n

const EXPIRY_MS: Record<OrderExpiry, number | null> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, gtc: null }

const display = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals))

/** A Multi Trade leg with something to trade; wallets allocated nothing are left out. */
const allocated = (leg: { amountIn: string }) => leg.amountIn.trim() !== '' && Number(leg.amountIn) > 0

export function createTradingService(ctx: NearContext, market: Market, wallets: Pick<WalletService, 'getSession' | 'listWallets'>): TradingService {
  const router = createSwapRouter(ctx)
  const congestion = createCongestionProbe(ctx.rpc)

  /**
   * Swaps with NEAR go through wrap.near's shard (twice before the tokens arrive). When it is
   * backed up, say so before signing: informational only, never blocking.
   */
  async function busyWarning(r: RoutedSwap): Promise<string[]> {
    if (r.tokenIn.contract !== null && r.tokenOut.contract !== null) return []
    return (await congestion.busy(ctx.network.wrapContract)) ? [NETWORK_BUSY_WARNING] : []
  }
  const orders = ctx.stores.drafts.orders

  const symbolOf = async (contract: string): Promise<{ symbol: string; decimals: number }> => {
    try {
      const m = await ctx.reader.metadata(contract)
      return { symbol: m.symbol, decimals: m.decimals }
    } catch {
      return { symbol: contract.length > 16 ? `${contract.slice(0, 8)}…` : contract, decimals: 0 }
    }
  }

  /** Routing tokens with names; the wrap contract shows as wNEAR. */
  async function routeRefs(r: RoutedSwap): Promise<TokenRef[]> {
    return mapLimit(r.routeTokens, 4, async (contract) => {
      const m = contract === ctx.network.wrapContract ? { symbol: 'wNEAR', decimals: NEAR_DECIMALS } : await symbolOf(contract)
      return { id: contract, symbol: m.symbol, decimals: m.decimals, contract }
    })
  }

  const pathOf = (r: RoutedSwap, refs: TokenRef[]) =>
    refs.map((t, i) => {
      if (i === 0 && r.tokenIn.contract === null) return 'NEAR'
      if (i === refs.length - 1 && r.tokenOut.contract === null) return 'NEAR'
      return t.symbol
    })

  /** App fee as the user pays it: exact from the input, estimated from a later token. */
  function feeSplit(r: RoutedSwap) {
    if (!r.fee) return null
    if (r.fee.transfer) {
      // A direct route: one transfer from the input, all of it NearKit's.
      const app = r.fee.transfer.amount
      return { split: { app, nearkit: app, router: 0n, protocol: 0n }, token: r.tokenIn, estimated: false }
    }
    const input = r.fee.stage === 'input'
    const base = input ? r.amountIn : grossOf(r.amountOut, r.fee.appPpm, r.fee.protocolPpm)
    const token = input ? r.tokenIn : r.tokenOut
    const split = aggregatorFee({ base, appFeePpm: r.fee.appPpm, protocolFeePpm: r.fee.protocolPpm, routerShareBps: r.fee.routerShareBps })
    return { split, token, estimated: !input }
  }

  async function priceUsd(token: TokenRef): Promise<number | null> {
    return (await market.quoteFor(token.contract === null ? NATIVE_TOKEN_ID : token.id).catch(() => null))?.priceUsd ?? null
  }

  async function impactOf(r: RoutedSwap): Promise<number | null> {
    if (!ctx.capabilities.prices) return null
    const [pIn, pOut] = await Promise.all([priceUsd(r.tokenIn), priceUsd(r.tokenOut)])
    if (!pIn || !pOut) return null
    const gross = r.fee ? grossOf(r.amountOut, r.fee.appPpm, r.fee.protocolPpm) : r.amountOut
    const valueIn = display(r.amountIn, r.tokenIn.decimals) * pIn
    const valueOut = display(gross, r.tokenOut.decimals) * pOut
    return valueIn > 0 ? Math.max(0, (1 - valueOut / valueIn) * 100) : null
  }

  async function toQuote(request: QuoteRequest, r: RoutedSwap): Promise<Quote> {
    const [refs, impact, nearUsd] = await Promise.all([routeRefs(r), impactOf(r), market.nearQuote()])
    const amountOut = display(r.amountOut, r.tokenOut.decimals)
    const fee = feeSplit(r)
    let amountNear: number | null = null
    let amountUsd: number | null = null
    if (fee) {
      const value = display(fee.split.app, fee.token.decimals)
      const isNear = fee.token.contract === null || fee.token.contract === ctx.network.wrapContract
      const price = await priceUsd(fee.token)
      amountUsd = price !== null ? value * price : isNear && nearUsd ? value * nearUsd.priceUsd : null
      amountNear = isNear ? value : amountUsd !== null && nearUsd ? amountUsd / nearUsd.priceUsd : null
    }
    const burn = SWAP_BURN_YOCTO + (r.tokenIn.contract === null ? SIMPLE_TX_BURN_YOCTO : 0n)
    return {
      request,
      amountOut,
      minAmountOut: display(r.minOut, r.tokenOut.decimals),
      amountOutRaw: r.amountOut.toString(),
      minAmountOutRaw: r.minOut.toString(),
      rate: amountOut / display(r.amountIn, r.tokenIn.decimals),
      priceImpactPct: impact,
      nearkitFee: r.fee
        ? {
            amountNear,
            amountUsd,
            bps: NEARKIT_FEE_BPS,
            charged: true,
            receivedBps: (NEARKIT_FEE_BPS * (10_000 - r.fee.routerShareBps)) / 10_000,
            routerShareBps: (NEARKIT_FEE_BPS * r.fee.routerShareBps) / 10_000,
            routerFeeBps: r.fee.protocolPpm / 100,
          }
        : { amountNear: null, amountUsd: null, bps: NEARKIT_FEE_BPS, charged: false, receivedBps: null, routerShareBps: null, routerFeeBps: null },
      networkFeeNear: display(burn, NEAR_DECIMALS),
      path: pathOf(r, refs),
      router: r.router,
      source: r.source,
      quotedAt: r.quotedAt,
      expiresAt: r.quotedAt + DISPLAY_TTL_MS,
    }
  }

  function feeDisclosure(r: RoutedSwap): FeeDisclosure {
    const f = feeSplit(r)
    if (!f || !r.fee) {
      return {
        label: 'NearKit fee',
        bps: NEARKIT_FEE_BPS,
        amount: amountValue(0n, r.tokenIn.decimals),
        token: r.tokenIn,
        charged: false,
        recipient: null,
        received: null,
        routerShare: null,
        routerFee: null,
        note: `Not charged on testnet. On mainnet the ${NEARKIT_FEE_LABEL} is collected inside the swap by Rhea’s aggregator.`,
      }
    }
    const d = f.token.decimals
    if (r.fee.transfer) {
      return {
        label: 'NearKit fee',
        bps: NEARKIT_FEE_BPS,
        amount: amountValue(f.split.app, d),
        token: f.token,
        charged: true,
        recipient: r.fee.recipient,
        received: { bps: NEARKIT_FEE_BPS, amount: amountValue(f.split.app, d), party: 'NearKit' },
        routerShare: null,
        routerFee: null,
        estimated: false,
        note: `Transferred from your ${f.token.symbol} to ${r.fee.recipient} in the same transaction as the swap, before the exchange receives the rest. NearKit receives all of it; the exchange's pool fee is in the rate.`,
      }
    }
    const shareBps = (NEARKIT_FEE_BPS * r.fee.routerShareBps) / 10_000
    return {
      label: 'NearKit fee',
      bps: NEARKIT_FEE_BPS,
      amount: amountValue(f.split.app, d),
      token: f.token,
      charged: true,
      recipient: r.fee.recipient,
      received: { bps: NEARKIT_FEE_BPS - shareBps, amount: amountValue(f.split.nearkit, d), party: 'NearKit' },
      routerShare: { bps: shareBps, amount: amountValue(f.split.router, d), party: 'Rhea' },
      routerFee: { bps: r.fee.protocolPpm / 100, amount: amountValue(f.split.protocol, d), party: 'Rhea protocol' },
      estimated: f.estimated,
      note: f.estimated
        ? `Estimated: Rhea takes the fees in ${f.token.symbol} during the swap, so the exact amounts appear in the transaction’s events. No separate fee transfer is signed.`
        : `Taken from your ${f.token.symbol} inside the swap by Rhea’s aggregator. No separate fee transfer is signed.`,
    }
  }

  interface LegPlan {
    wallet: Wallet
    route: RoutedSwap
    txs: PlannedTransaction[]
    refs: TokenRef[]
  }

  async function planLeg(wallet: Wallet, r: RoutedSwap): Promise<LegPlan> {
    const signer = wallet.accountId
    const [pre, refs] = await Promise.all([router.prerequisites(r, signer), routeRefs(r)])
    const inSym = r.tokenIn.symbol
    const outSym = r.tokenOut.symbol
    const txs = buildSwapTransactions({
      signerId: signer,
      wrap: r.tokenIn.contract === null ? { contract: r.routeIn, amount: r.amountIn, registerDeposit: pre.wrapRegister } : null,
      registrations: pre.registrations,
      aggregatorDeposits: pre.aggregatorEntries.length && ctx.network.rhea.aggregator ? { contract: ctx.network.rhea.aggregator.contract, entries: pre.aggregatorEntries } : null,
      swap: { tokenContract: r.routeIn, receiverId: r.receiver, amount: r.swapAmount, msg: r.msg },
      feeTransfer: r.fee?.transfer ? { recipient: r.fee.recipient, amount: r.fee.transfer.amount } : null,
      label: `${r.tokenIn.contract === null ? 'Wrap and swap' : 'Swap'} ${formatUnits(r.amountIn, r.tokenIn.decimals)} ${inSym} → ${outSym}`,
    })
    return { wallet, route: r, txs, refs }
  }

  /** The signer must hold the input and the NEAR for storage and gas bought upfront. */
  async function checkFunds(leg: LegPlan): Promise<void> {
    const { route: r, wallet } = leg
    const storage = sumRaw(leg.txs.map(txStorageYocto))
    const upfront = sumRaw(leg.txs.map(txUpfrontYocto))
    let state
    let tokenBalance: bigint | null = null
    try {
      ;[state, tokenBalance] = await Promise.all([
        accountState(ctx.rpc, wallet.accountId),
        r.tokenIn.contract ? ctx.reader.balanceOf(r.tokenIn.contract, wallet.accountId) : Promise.resolve(null),
      ])
    } catch (e) {
      throw toNearKitError(e, 'RPC_ERROR')
    }
    const nearIn = r.tokenIn.contract === null ? r.amountIn : 0n
    if (r.tokenIn.contract === null && state.availableYocto < r.amountIn) {
      throw new NearKitError(
        'INSUFFICIENT_BALANCE',
        `${wallet.label} has ${nearText(state.availableYocto)} NEAR available and this swaps ${formatUnits(r.amountIn, NEAR_DECIMALS)} NEAR`,
      )
    }
    if (tokenBalance !== null && tokenBalance < r.amountIn) {
      throw new NearKitError(
        'INSUFFICIENT_BALANCE',
        `${wallet.label} holds ${formatUnits(tokenBalance, r.tokenIn.decimals)} ${r.tokenIn.symbol} and this swaps ${formatUnits(r.amountIn, r.tokenIn.decimals)}`,
      )
    }
    const need = nearIn + storage + upfront
    if (state.availableYocto < need) {
      const parts = [
        nearIn ? `${formatUnits(nearIn, NEAR_DECIMALS)} to swap` : null,
        storage ? `${nearText(storage)} for registrations` : null,
        `${nearText(upfront)} of gas bought upfront, mostly refunded`,
      ].filter(Boolean)
      throw new NearKitError(
        'INSUFFICIENT_GAS',
        `${wallet.label} needs ${nearText(need)} NEAR available to sign (${parts.join(' + ')}). It has ${nearText(state.availableYocto)} NEAR.`,
      )
    }
  }

  function warningsFor(r: RoutedSwap): string[] {
    const w: string[] = []
    if (r.tokenIn.contract === null) w.push('If the swap doesn’t go through, the refund arrives as wNEAR (wrapped NEAR), not NEAR.')
    if (r.fee?.stage === 'output')
      w.push(
        `Rhea takes its fees from the ${r.tokenOut.symbol} after the exchange checks the signed minimum, so the minimum shown is that minimum less ${((r.fee.appPpm + r.fee.protocolPpm) / 10_000).toFixed(2)}%.`,
      )
    if (r.multiDex)
      w.push(`This route crosses two exchanges. If the second one misses its minimum, you keep the intermediate token instead of ${r.tokenOut.symbol}, and no fee is charged.`)
    if (r.fee?.transfer)
      w.push(
        `This route goes to the exchange directly. The NearKit fee leaves with the swap's own transaction; if the exchange then refunds the swap (the price moved past your slippage), the fee is not refunded.`,
      )
    if (r.tax?.inBps) w.push(`${r.tokenIn.symbol} takes a ${r.tax.inBps / 100}% tax on tokens entering its DCL pool; the quote is for what the pool receives after it.`)
    if (r.tax?.outBps) w.push(`${r.tokenOut.symbol} takes a ${r.tax.outBps / 100}% tax on tokens leaving its DCL pool; the amounts shown are after it.`)
    return w
  }

  // Counted from when the route was quoted, not from when the plan finished preparing.
  const expiryOf = (r: RoutedSwap) => Math.min(r.quotedAt + REVIEW_WINDOW_MS, r.deadline !== null ? r.deadline - 60_000 : Number.POSITIVE_INFINITY)

  /** A different known token uses the same symbol: say which contract is being traded. */
  async function lookalikeWarnings(tokens: TokenRef[]): Promise<string[]> {
    const known = await mapLimit([...ctx.network.knownTokens], 4, async (c) => ({ contract: c, symbol: (await symbolOf(c)).symbol.toLowerCase() }))
    return tokens.flatMap((t) => {
      if (!t.contract || ctx.network.knownTokens.includes(t.contract)) return []
      const twin = known.find((k) => k.symbol === t.symbol.toLowerCase() && k.contract !== t.contract)
      return twin ? [`${t.symbol} here is ${t.contract}, not the listed ${t.symbol} (${twin.contract}). Check the contract before you sign.`] : []
    })
  }

  /** Planned registrations of NearKit's own fee account, paid by the user, stated plainly. */
  function feeAccountWarning(r: RoutedSwap, txs: PlannedTransaction[]): string[] {
    if (!r.fee) return []
    const recipient = r.fee.recipient
    const actions = txs.flatMap((t) => t.actions)
    const withRhea = actions.filter((a) => a.kind === 'call' && a.method === 'tokens_storage_deposit' && a.args.user === recipient)
    const onToken = actions.filter((a) => a.kind === 'call' && a.method === 'storage_deposit' && a.args.account_id === recipient)
    const w: string[] = []
    if (withRhea.length)
      w.push(
        `This swap also registers NearKit’s fee account (${recipient}) with Rhea for the token the fee is taken in: ${nearText(sumRaw(withRhea.map((a) => BigInt(a.deposit))))} NEAR, one time.`,
      )
    if (onToken.length)
      w.push(
        `This swap also registers NearKit’s fee account (${recipient}) on ${r.tokenIn.symbol}’s contract, so it can receive the fee: ${nearText(sumRaw(onToken.map((a) => BigInt(a.deposit))))} NEAR, one time.`,
      )
    return w
  }

  async function signerFor(walletId: string): Promise<Wallet> {
    requireSession(await wallets.getSession(), ctx.network.label)
    return executableWallet(await wallets.listWallets(), walletId, 'browser')
  }

  async function sessionSigners(): Promise<Set<string>> {
    const ws = await ctx.wallet().then((w) => w.session().catch(() => null))
    return new Set(ws?.accounts ?? [])
  }

  async function walletBatches(): Promise<boolean> {
    const ws = await ctx.wallet().then((w) => w.session().catch(() => null))
    return ws?.batch ?? false
  }

  return {
    async quote(request) {
      const user = ctx.session.current?.accountId ?? null
      return toQuote(request, await router.route(request, user && !ctx.session.current?.issue ? user : null, false))
    },

    async prepareSwap(request) {
      const wallet = await signerFor(request.walletId)
      const r = await router.route(request, wallet.accountId, true)
      const leg = await planLeg(wallet, r)
      await checkFunds(leg)
      const [impact, batch, signing, busy] = await Promise.all([impactOf(r), walletBatches(), sessionSigners(), busyWarning(r)])
      const now = ctx.now()
      const swap: SwapDetails = {
        router: r.router,
        source: r.source,
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: amountValue(r.amountIn, r.tokenIn.decimals),
        expectedOut: amountValue(r.amountOut, r.tokenOut.decimals),
        minOut: amountValue(r.minOut, r.tokenOut.decimals),
        slippagePct: r.slippagePct,
        priceImpactPct: impact,
        route: pathOf(r, leg.refs),
        routeTokens: leg.refs,
        quotedAt: r.quotedAt,
      }
      const warnings = [
        ...busy,
        ...warningsFor(r),
        ...(await lookalikeWarnings([r.tokenIn, r.tokenOut])),
        ...feeAccountWarning(r, leg.txs),
        ...registrationWarnings(leg.txs, HIGH_REGISTRATION_YOCTO),
      ]
      if (!signing.has(wallet.accountId)) warnings.push(`${wallet.accountId} is not connected right now. NearKit asks you to connect it in your wallet before signing.`)
      const verb =
        r.tokenIn.contract === null ? `Buy ${r.tokenOut.symbol}` : r.tokenOut.contract === null ? `Sell ${r.tokenIn.symbol}` : `Swap ${r.tokenIn.symbol} for ${r.tokenOut.symbol}`
      return {
        id: newPlanId(now),
        kind: 'swap',
        mode: 'near',
        network: ctx.network.id,
        title: `${verb} · ${formatUnits(r.amountIn, r.tokenIn.decimals)} ${r.tokenIn.symbol}`,
        token: r.tokenIn,
        signers: [wallet.accountId],
        lines: [],
        transactions: leg.txs,
        groups: groupTransactions(leg.txs, batch),
        totals: {
          amount: amountValue(r.amountIn, r.tokenIn.decimals),
          storage: nearValue(sumRaw(leg.txs.map(txStorageYocto))),
          upfrontNear: nearValue(sumRaw(leg.txs.map(txUpfrontYocto))),
        },
        fee: feeDisclosure(r),
        swap,
        warnings,
        expiresAt: expiryOf(r),
        createdAt: now,
      } satisfies OperationPlan
    },

    async quoteMulti(request) {
      if (request.tokenId === NATIVE_TOKEN_ID) throw new NearKitError('INVALID_TOKEN', 'Choose a token other than NEAR')
      const legs = request.legs.filter(allocated)
      if (legs.length === 0) throw new NearKitError('INVALID_AMOUNT', 'Allocate an amount to at least one wallet')
      // Watch-only wallets never join, not even in a quote.
      const known = await wallets.listWallets()
      for (const leg of legs) executableWallet(known, leg.walletId, 'any')
      const pair = request.side === 'buy' ? { tokenIn: NATIVE_TOKEN_ID, tokenOut: request.tokenId } : { tokenIn: request.tokenId, tokenOut: NATIVE_TOKEN_ID }
      const user = ctx.session.current?.issue ? null : (ctx.session.current?.accountId ?? null)
      // One indicative quote per distinct amount; the review re-quotes every wallet.
      const distinct = [...new Set(legs.map((l) => l.amountIn.trim()))]
      const routed = new Map<string, RoutedSwap>()
      for (const amount of distinct)
        routed.set(amount, await router.route({ ...pair, amountIn: amount, slippagePct: request.slippagePct, walletId: legs[0]?.walletId ?? '' }, user, false))
      const holdings = await Promise.all(legs.map((l) => ctx.balances.get(l.walletId).catch(() => null)))
      const quoted: MultiTradeLegQuote[] = legs.map((leg, i) => {
        const r = routed.get(leg.amountIn.trim()) as RoutedSwap
        const b = holdings[i]
        const have = r.tokenIn.contract === null ? (b?.state?.availableYocto ?? 0n) : (b?.fts.find((f) => f.contract === r.tokenIn.contract)?.raw ?? 0n)
        const fee = feeSplit(r)
        return {
          ...leg,
          amountInValue: display(r.amountIn, r.tokenIn.decimals),
          amountOut: display(r.amountOut, r.tokenOut.decimals),
          minAmountOut: display(r.minOut, r.tokenOut.decimals),
          nearkitFee: fee ? display(fee.split.app, fee.token.decimals) : 0,
          shortfall: have >= r.amountIn ? 0 : display(r.amountIn - have, r.tokenIn.decimals),
        }
      })
      const live = quoted.filter((l) => l.shortfall === 0)
      // The fee is taken in one token for the pair (the input when Rhea whitelists it, else
      // the output), so every leg's fee is in the same token.
      const feeToken = feeSplit(routed.values().next().value as RoutedSwap)?.token ?? null
      const feeTokenId = feeToken === null || feeToken.contract === null || feeToken.contract === ctx.network.wrapContract ? NATIVE_TOKEN_ID : feeToken.id
      const impacts = await Promise.all([...routed.values()].map(impactOf))
      const now = ctx.now()
      return {
        request,
        legs: quoted,
        totalIn: live.reduce((s, l) => s + l.amountInValue, 0),
        totalOut: live.reduce((s, l) => s + l.amountOut, 0),
        totalMinOut: live.reduce((s, l) => s + l.minAmountOut, 0),
        nearkitFeeTotal: live.reduce((s, l) => s + l.nearkitFee, 0),
        feeTokenId,
        networkFeeNear: display(SWAP_BURN_YOCTO, NEAR_DECIMALS) * live.length,
        // The worst leg's impact; unknown if any leg can't be estimated.
        priceImpactPct: impacts.some((x) => x === null) ? null : Math.max(0, ...impacts.map((x) => x ?? 0)),
        quotedAt: now,
        expiresAt: now + DISPLAY_TTL_MS,
      } satisfies MultiTradeQuote
    },

    async prepareMulti(request) {
      requireSession(await wallets.getSession(), ctx.network.label)
      if (request.tokenId === NATIVE_TOKEN_ID) throw new NearKitError('INVALID_TOKEN', 'Choose a token other than NEAR')
      const list = await wallets.listWallets()
      const legs = request.legs.filter(allocated)
      if (legs.length === 0) throw new NearKitError('INVALID_AMOUNT', 'Allocate an amount to at least one wallet')
      const pair = request.side === 'buy' ? { tokenIn: NATIVE_TOKEN_ID, tokenOut: request.tokenId } : { tokenIn: request.tokenId, tokenOut: NATIVE_TOKEN_ID }
      // Every wallet must be able to sign here before any is routed or checked.
      const legWallets = legs.map((leg) => executableWallet(list, leg.walletId, 'browser'))
      // Sequential: each wallet gets its own route, bound to it and verified.
      const planned: LegPlan[] = []
      for (const [i, leg] of legs.entries()) {
        const wallet = legWallets[i] as Wallet
        const r = await router.route({ ...pair, amountIn: leg.amountIn, slippagePct: request.slippagePct, walletId: wallet.id }, wallet.accountId, true)
        const p = await planLeg(wallet, r)
        await checkFunds(p)
        planned.push(p)
      }
      const [batch, signing] = await Promise.all([walletBatches(), sessionSigners()])
      const now = ctx.now()
      const transactions: PlannedTransaction[] = []
      const lines: PlanLine[] = []
      const groups: number[][] = []
      for (const [i, p] of planned.entries()) {
        const start = transactions.length
        for (const tx of p.txs) transactions.push({ ...tx, index: transactions.length, label: `${p.wallet.label} · ${tx.label}` })
        const own = transactions.slice(start)
        for (const g of groupTransactions(own, batch)) groups.push(g)
        const r = p.route
        lines.push({
          id: `l${i}`,
          label: p.wallet.label,
          accountId: p.wallet.accountId,
          amount: amountValue(r.amountIn, r.tokenIn.decimals),
          storageDeposit: null,
          notes: [
            `Expected ${formatUnits(r.amountOut, r.tokenOut.decimals, { maxFraction: 6, group: true })} ${r.tokenOut.symbol}`,
            `Minimum ${formatUnits(r.minOut, r.tokenOut.decimals, { maxFraction: 6, group: true })} ${r.tokenOut.symbol}`,
          ],
          txIndex: transactions.length - 1,
        })
      }
      const first = planned[0]?.route
      if (!first) throw new NearKitError('INVALID_AMOUNT', 'Allocate an amount to at least one wallet')
      const disclosures = planned.map((p) => feeDisclosure(p.route))
      const sameToken = disclosures.every((d) => d.token.id === disclosures[0]?.token.id)
      const sumShare = (pick: (d: FeeDisclosure) => { amount: { raw: string } } | null) => sumRaw(disclosures.map((d) => BigInt(pick(d)?.amount.raw ?? '0')))
      const base = disclosures[0] as FeeDisclosure
      const fee: FeeDisclosure =
        base.charged && sameToken
          ? {
              ...base,
              amount: amountValue(
                sumShare((d) => d),
                base.token.decimals,
              ),
              received: base.received && {
                ...base.received,
                amount: amountValue(
                  sumShare((d) => d.received),
                  base.token.decimals,
                ),
              },
              routerShare: base.routerShare && {
                ...base.routerShare,
                amount: amountValue(
                  sumShare((d) => d.routerShare),
                  base.token.decimals,
                ),
              },
              routerFee: base.routerFee && {
                ...base.routerFee,
                amount: amountValue(
                  sumShare((d) => d.routerFee),
                  base.token.decimals,
                ),
              },
              estimated: disclosures.some((d) => d.estimated),
              note: `Across ${planned.length} wallets. ${base.note ?? ''}`.trim(),
            }
          : base
      const elsewhere = planned.map((p) => p.wallet.accountId).filter((id) => !signing.has(id))
      const warnings = [
        ...(await busyWarning(first)),
        'Each wallet’s swap is separate, signed one wallet after another. There is no all-or-nothing execution: if one fails or the quote expires, NearKit stops there. Wallets already done keep their swaps; the rest are not sent.',
        ...warningsFor(first),
        ...(await lookalikeWarnings([first.tokenIn, first.tokenOut])),
        ...new Set(planned.flatMap((p) => feeAccountWarning(p.route, p.txs))),
        ...registrationWarnings(transactions, HIGH_REGISTRATION_YOCTO),
        ...(elsewhere.length ? [`NearKit asks you to connect ${elsewhere.join(', ')} in your wallet when their turn comes.`] : []),
      ]
      // One summary for the review: totals across wallets, the first wallet's route, the worst impact.
      const impacts = await Promise.all(planned.map((p) => impactOf(p.route)))
      const firstLeg = planned[0] as LegPlan
      const swap: SwapDetails = {
        router: first.router,
        source: first.source,
        tokenIn: first.tokenIn,
        tokenOut: first.tokenOut,
        amountIn: amountValue(sumRaw(planned.map((p) => p.route.amountIn)), first.tokenIn.decimals),
        expectedOut: amountValue(sumRaw(planned.map((p) => p.route.amountOut)), first.tokenOut.decimals),
        minOut: amountValue(sumRaw(planned.map((p) => p.route.minOut)), first.tokenOut.decimals),
        slippagePct: first.slippagePct,
        priceImpactPct: impacts.some((x) => x === null) ? null : Math.max(0, ...impacts.map((x) => x ?? 0)),
        route: pathOf(first, firstLeg.refs),
        routeTokens: firstLeg.refs,
        quotedAt: Math.min(...planned.map((p) => p.route.quotedAt)),
      }
      const token = request.side === 'buy' ? first.tokenOut : first.tokenIn
      const n = planned.length
      return {
        id: newPlanId(now),
        kind: 'multi-trade',
        mode: 'near',
        network: ctx.network.id,
        title: `${request.side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol} with ${n} ${n === 1 ? 'wallet' : 'wallets'}`,
        token: first.tokenIn,
        signers: planned.map((p) => p.wallet.accountId),
        lines,
        transactions,
        groups,
        totals: {
          amount: amountValue(sumRaw(planned.map((p) => p.route.amountIn)), first.tokenIn.decimals),
          storage: nearValue(sumRaw(transactions.map(txStorageYocto))),
          upfrontNear: nearValue(sumRaw(transactions.map(txUpfrontYocto))),
        },
        fee,
        swap,
        warnings,
        expiresAt: Math.min(...planned.map((p) => expiryOf(p.route))),
        createdAt: now,
      } satisfies OperationPlan
    },

    async listOrders() {
      return orders.read().sort((a, b) => b.createdAt - a.createdAt)
    },

    async createOrder(input) {
      requireSession(await wallets.getSession(), ctx.network.label)
      if (input.tokenId === NATIVE_TOKEN_ID) throw new NearKitError('INVALID_TOKEN', 'Choose a token other than NEAR')
      walletOf(await wallets.listWallets(), input.walletId)
      if (!(input.triggerPriceUsd > 0)) throw new NearKitError('INVALID_AMOUNT', 'Enter a trigger price above 0')
      if (!(input.amount > 0)) throw new NearKitError('INVALID_AMOUNT', 'Enter an amount above 0')
      const now = ctx.now()
      const ttl = EXPIRY_MS[input.expiry]
      const order: LimitOrder = {
        id: `ord-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        tokenId: input.tokenId,
        side: input.side,
        type: input.type,
        triggerPriceUsd: input.triggerPriceUsd,
        amount: input.amount,
        walletId: input.walletId,
        createdAt: now,
        expiresAt: ttl === null ? null : now + ttl,
        status: 'draft',
        closedAt: null,
      }
      orders.write([order, ...orders.read()])
      return order
    },

    async cancelOrder(id) {
      const list = orders.read()
      const order = list.find((o) => o.id === id)
      if (!order) throw new NearKitError('UNKNOWN', 'Order not found')
      const cancelled: LimitOrder = { ...order, status: 'cancelled', closedAt: ctx.now() }
      orders.write(list.map((o) => (o.id === id ? cancelled : o)))
      return cancelled
    },
  }
}
