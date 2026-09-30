import { NATIVE_TOKEN_ID, NEAR_DECIMALS, type NetworkConfig } from '@/config/networks'
import { formatUnits, formatUnitsUp } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { createCongestionProbe } from '@/services/near/congestion'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { detectTrades, fromRpc } from '@/services/near/flows'
import { classifyOutcome, swapDelivered } from '@/services/near/outcome'
import { peakNeedYocto, txStorageYocto } from '@/services/near/plans'
import { HIGH_REGISTRATION_YOCTO } from '@/services/near/storage'
import { aggregatorFee, grossOf } from '@/services/rhea/fees'
import { buildSwapTransactions } from '@/services/rhea/swapTransactions'
import { createSwapRouter, type RoutedSwap } from '@/services/real/swapRouting'
import type { QuoteRequest } from '@/types/domain'
import type { PlannedTransaction } from '@/types/operations'
import type { ServerNear } from '../near'
import type { RpcTxResult } from '@/services/near/rpc'
import type { ConfirmedTx, IntentHandler, PlanOutcome } from './engine'
import type { SwapRouteFacts, WalletTxPlan } from './policy'
import type { Intent, IntentResult, TradingWallet } from './store'

/**
 * Buy and Sell from a NearKit wallet, entirely in Telegram. The quote the user
 * confirms is never the authorization for something else: right before signing
 * NearKit asks Rhea for a fresh route bound to the wallet, checks it, and sends it
 * only if its minimum is at least the minimum the user confirmed (and no cost the
 * user didn't see was added). Otherwise the user gets the new quote to confirm.
 */

export interface SwapParams {
  side: 'buy' | 'sell'
  token: string
  symbol: string
  decimals: number
  /** Exact decimal input: NEAR for a buy, the token for a sell. */
  amountIn: string
  slippagePct: number
}

export interface SwapQuote {
  router: RoutedSwap['router']
  amountInRaw: string
  /** Expected output, raw. */
  amountOut: string
  /** The lowest output the route enforces: what the user authorizes. */
  minOut: string
  path: string[]
  priceImpactPct: number | null
  /** NearKit's fee as charged on this route (none on testnet). */
  fee: { charged: boolean; bps: number; amountRaw: string | null; token: string | null; routerShareBps: number | null }
  /** Registrations this trade needs first (yocto), shown on the quote. */
  registration: string
  /**
   * NEAR the wallet must have available when the trade starts (yocto): the amount, the
   * registrations and the gas the network holds while it runs (peakNeedYocto of its plan).
   */
  need?: string
  /** NEAR the wallet had available when quoted (yocto); absent when it couldn't be read. */
  available?: string
  networkFeeNear: string
  /** wrap.near's shard was backed up when quoted: the trade may take longer than usual (informational). */
  busy?: boolean
  quotedAt: number
  expiresAt: number
}

/** A quote can be confirmed this long; the route is fetched again at Confirm anyway. */
export const SWAP_QUOTE_TTL_MS = 60_000
/** Typical burn of a swap and of wrapping NEAR (tradingService.ts, from real swaps). */
const SWAP_BURN_YOCTO = 5n * 10n ** 21n
const WRAP_BURN_YOCTO = 5n * 10n ** 20n

/** Stand-ins for the reserves' plans: only the size of each transaction matters. */
const RESERVE_WALLET = '0'.repeat(64)
const RESERVE_TOKEN = 'token.near'
const RESERVE_ROUTER = 'router.near'
/** Twice the longest aggregator route message seen on mainnet (about 2 KB). */
const RESERVE_MSG = 'x'.repeat(4096)

/**
 * The largest plan a first trade can have: every registration at the high price, Rhea entries
 * for three route tokens and two fee tokens, a long route message. Amount 0: a buy's amount
 * adds to its peak one for one.
 */
function reservePlan(network: NetworkConfig, side: 'buy' | 'sell'): PlannedTransaction[] {
  const per = network.rhea.aggregator ? BigInt(network.rhea.aggregator.tokenStorageDeposit) : 0n
  const wrap = network.wrapContract
  const input = side === 'buy' ? wrap : RESERVE_TOKEN
  return buildSwapTransactions({
    signerId: RESERVE_WALLET,
    wrap: side === 'buy' ? { contract: wrap, amount: 0n, registerDeposit: HIGH_REGISTRATION_YOCTO } : null,
    registrations: [{ contract: side === 'buy' ? RESERVE_TOKEN : wrap, accountId: RESERVE_WALLET, deposit: HIGH_REGISTRATION_YOCTO }],
    aggregatorDeposits: per
      ? {
          contract: RESERVE_ROUTER,
          entries: [
            { user: RESERVE_WALLET, tokens: [wrap, RESERVE_TOKEN, 'mid.near'], deposit: 3n * per },
            { user: 'fee.near', tokens: [wrap, RESERVE_TOKEN], deposit: 2n * per },
          ],
        }
      : null,
    swap: { tokenContract: input, receiverId: RESERVE_ROUTER, amount: 0n, msg: RESERVE_MSG },
    label: 'reserve',
  })
}

/**
 * NEAR a buy needs available besides its amount, at most (a first buy with every registration):
 * mostly gas the network holds while the swap runs. MAX keeps it back.
 */
export function buyReserve(network: NetworkConfig): bigint {
  return peakNeedYocto(reservePlan(network, 'buy'))
}

/** NEAR a sell needs available, at most: registrations and the gas held while the swap runs. */
export function sellReserve(network: NetworkConfig): bigint {
  return peakNeedYocto(reservePlan(network, 'sell'))
}

/** The requirement in words: what it is made of and how much is missing. */
function fundsText(side: 'buy' | 'sell', need: bigint, nearIn: bigint, registration: bigint, available: bigint): string {
  const up = (y: bigint) => formatUnitsUp(y, NEAR_DECIMALS, 4)
  const parts = [
    ...(nearIn ? [`${formatUnits(nearIn, NEAR_DECIMALS)} NEAR to swap`] : []),
    ...(registration ? [`${formatUnitsUp(registration, NEAR_DECIMALS, 5)} NEAR for one-time registrations`] : []),
  ]
  const gas = `${up(need - nearIn - registration)} NEAR for gas, which the network holds while the swap runs and gives back within seconds, all but the network fee`
  return (
    `This ${side} needs ${up(need)} NEAR available and your NearKit wallet has ${formatUnits(available, NEAR_DECIMALS, { maxFraction: 4 })} NEAR: ` +
    `${parts.length ? `${parts.join(', ')} and ${gas}` : gas}. Deposit at least ${up(need - available)} NEAR more.`
  )
}

export const requestOf = (p: SwapParams, walletAccount: string): QuoteRequest => ({
  tokenIn: p.side === 'buy' ? NATIVE_TOKEN_ID : p.token,
  tokenOut: p.side === 'buy' ? p.token : NATIVE_TOKEN_ID,
  amountIn: p.amountIn,
  slippagePct: p.slippagePct,
  walletId: walletAccount,
})

export function routeFacts(r: RoutedSwap): SwapRouteFacts {
  return {
    router: r.router,
    routeIn: r.routeIn,
    routeOut: r.routeOut,
    nativeIn: r.tokenIn.contract === null,
    nativeOut: r.tokenOut.contract === null,
    amountIn: r.amountIn,
    receiver: r.receiver,
    msg: r.msg,
    routeTokens: r.routeTokens,
    minOut: r.minOut,
    ...(r.router === 'aggregator' ? { signedMin: r.signedMin } : {}),
  }
}

const toWalletPlan = (txs: PlannedTransaction[]): WalletTxPlan[] => txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions, label: t.label }))

/** A NearKit wallet's transaction as the plan its outcome is checked against. */
const plannedOf = (walletAccount: string, plan: WalletTxPlan): PlannedTransaction =>
  ({ index: 0, signerId: walletAccount, receiverId: plan.receiverId, actions: plan.actions, lineIds: [], label: '', gas: '0', deposit: '0' }) as PlannedTransaction

const gasOf = (txs: { result: RpcTxResult }[]) => txs.reduce((s, c) => s + fromRpc(c.result).gasBurnt, 0n)

/**
 * A buy whose tokens already reached the wallet, before the chain's last settlement callbacks
 * ran (minutes later under congestion): done for the user, reported as bought right away. The
 * swap transaction may still be running (`last.result` partial); its final record is filed when
 * it settles. Null until the tokens arrived, and for anything but a buy through Rhea's
 * aggregator: sells (NEAR out) and the classic router are judged when final.
 */
export function deliveredTrade(params: SwapParams, walletAccount: string, earlier: ConfirmedTx[], last: ConfirmedTx, network: NetworkConfig): IntentResult | null {
  if (params.side !== 'buy' || !network.rhea.aggregator) return null
  const verdict = swapDelivered(last.result, plannedOf(walletAccount, last.plan), { token: params.token, recipient: walletAccount })
  const received = verdict?.swap?.received
  if (!verdict || !received) return null
  const trade = detectTrades(fromRpc(last.result), params.token, { wrapContract: network.wrapContract }).find((t) => t.account === walletAccount)
  const spent = trade?.paid.find((l) => l.asset === 'near')?.amount ?? null
  const fee = verdict.swap?.appFee ?? null
  return {
    ok: true,
    message: 'Buy confirmed.',
    hashes: [...earlier, last].map((c) => c.hash),
    facts: {
      token: params.token,
      tokenAmount: received.raw,
      nearAmount: spent?.toString() ?? null,
      fee: fee ? { token: fee.token, raw: fee.raw, recipient: fee.recipient } : null,
      gasBurnt: gasOf([...earlier, last]).toString(),
      delivered: true,
    },
  }
}

export function createSwapService(near: ServerNear) {
  const router = createSwapRouter(near.ctx)
  const ctx = near.ctx
  const congestion = createCongestionProbe(ctx.rpc)

  async function symbolOf(contract: string): Promise<string> {
    if (contract === ctx.network.wrapContract) return 'wNEAR'
    return ctx.reader
      .metadata(contract)
      .then((m) => m.symbol)
      .catch(() => (contract.length > 16 ? `${contract.slice(0, 8)}…` : contract))
  }

  async function impactOf(r: RoutedSwap): Promise<number | null> {
    if (!ctx.capabilities.prices) return null
    const price = async (id: string) => (await near.market.quoteFor(id).catch(() => null))?.priceUsd ?? null
    const [pIn, pOut] = await Promise.all([price(r.tokenIn.contract ?? NATIVE_TOKEN_ID), price(r.tokenOut.contract ?? NATIVE_TOKEN_ID)])
    if (!pIn || !pOut) return null
    const gross = r.fee ? grossOf(r.amountOut, r.fee.appPpm, r.fee.protocolPpm) : r.amountOut
    const valueIn = Number(formatUnits(r.amountIn, r.tokenIn.decimals)) * pIn
    const valueOut = Number(formatUnits(gross, r.tokenOut.decimals)) * pOut
    return valueIn > 0 ? Math.max(0, (1 - valueOut / valueIn) * 100) : null
  }

  async function plan(r: RoutedSwap, wallet: TradingWallet) {
    const pre = await router.prerequisites(r, wallet.accountId)
    const txs = buildSwapTransactions({
      signerId: wallet.accountId,
      wrap: r.tokenIn.contract === null ? { contract: r.routeIn, amount: r.amountIn, registerDeposit: pre.wrapRegister } : null,
      registrations: pre.registrations,
      aggregatorDeposits: pre.aggregatorEntries.length && ctx.network.rhea.aggregator ? { contract: ctx.network.rhea.aggregator.contract, entries: pre.aggregatorEntries } : null,
      swap: { tokenContract: r.routeIn, receiverId: r.receiver, amount: r.amountIn, msg: r.msg },
      label: `${r.tokenIn.symbol} → ${r.tokenOut.symbol}`,
    })
    return { txs, registration: txs.reduce((s, t) => s + txStorageYocto(t), 0n) }
  }

  async function toQuote(r: RoutedSwap, registration: bigint, txs: PlannedTransaction[], wallet: TradingWallet): Promise<SwapQuote> {
    // Every Telegram trade is NEAR in or out, through wrap.near's shard.
    const [symbols, impact, state, busy] = await Promise.all([
      mapLimit(r.routeTokens, 4, symbolOf),
      impactOf(r),
      accountState(ctx.rpc, wallet.accountId, 'final').catch(() => null),
      congestion.busy(ctx.network.wrapContract),
    ])
    const path = symbols.map((s, i) => ((i === 0 && r.tokenIn.contract === null) || (i === symbols.length - 1 && r.tokenOut.contract === null) ? 'NEAR' : s))
    let fee: SwapQuote['fee'] = { charged: false, bps: NEARKIT_FEE_BPS, amountRaw: null, token: null, routerShareBps: null }
    if (r.fee) {
      const input = r.fee.stage === 'input'
      const base = input ? r.amountIn : grossOf(r.amountOut, r.fee.appPpm, r.fee.protocolPpm)
      const split = aggregatorFee({ base, appFeePpm: r.fee.appPpm, protocolFeePpm: r.fee.protocolPpm, routerShareBps: r.fee.routerShareBps })
      fee = {
        charged: true,
        bps: NEARKIT_FEE_BPS,
        amountRaw: split.app.toString(),
        token: input ? (r.tokenIn.contract ?? NATIVE_TOKEN_ID) : (r.tokenOut.contract ?? NATIVE_TOKEN_ID),
        routerShareBps: r.fee.routerShareBps,
      }
    }
    const burn = SWAP_BURN_YOCTO + (r.tokenIn.contract === null ? WRAP_BURN_YOCTO : 0n)
    return {
      router: r.router,
      amountInRaw: r.amountIn.toString(),
      amountOut: r.amountOut.toString(),
      minOut: r.minOut.toString(),
      path,
      priceImpactPct: impact,
      fee,
      registration: registration.toString(),
      need: peakNeedYocto(txs).toString(),
      ...(state ? { available: state.availableYocto.toString() } : {}),
      networkFeeNear: burn.toString(),
      ...(busy ? { busy: true } : {}),
      quotedAt: r.quotedAt,
      expiresAt: r.quotedAt + SWAP_QUOTE_TTL_MS,
    }
  }

  /**
   * The wallet must hold the input, and at the plan's peak the NEAR for registrations and the gas
   * the network holds upfront. Steps go one after another, each once the one before is refunded.
   */
  async function checkFunds(r: RoutedSwap, side: 'buy' | 'sell', wallet: TradingWallet, txs: PlannedTransaction[]) {
    const storage = txs.reduce((s, t) => s + txStorageYocto(t), 0n)
    const need = peakNeedYocto(txs)
    const [state, held] = await Promise.all([
      accountState(ctx.rpc, wallet.accountId, 'final'),
      r.tokenIn.contract ? ctx.reader.balanceOf(r.tokenIn.contract, wallet.accountId) : Promise.resolve(null),
    ])
    if (!state.exists) throw new NearKitError('INSUFFICIENT_BALANCE', 'Your NearKit wallet has no NEAR yet. Deposit first.')
    if (held !== null && held < r.amountIn)
      throw new NearKitError('INSUFFICIENT_BALANCE', `Your NearKit wallet holds ${formatUnits(held, r.tokenIn.decimals, { maxFraction: 6 })} ${r.tokenIn.symbol}.`)
    const nearIn = r.tokenIn.contract === null ? r.amountIn : 0n
    if (state.availableYocto < need) throw new NearKitError(nearIn ? 'INSUFFICIENT_BALANCE' : 'INSUFFICIENT_GAS', fundsText(side, need, nearIn, storage, state.availableYocto))
  }

  const handler: IntentHandler = {
    async plan(intent: Intent, wallet: TradingWallet): Promise<PlanOutcome> {
      const params = intent.params as unknown as SwapParams
      const shown = intent.quote as unknown as SwapQuote
      let r: RoutedSwap
      try {
        r = await router.route(requestOf(params, wallet.accountId), wallet.accountId, true)
      } catch (e) {
        throw toNearKitError(e, 'QUOTE_UNAVAILABLE')
      }
      const { txs, registration } = await plan(r, wallet)
      // Less than the confirmed minimum, or a cost the user didn't see: ask again, send nothing.
      if (r.minOut < BigInt(shown.minOut) || registration > BigInt(shown.registration))
        return { kind: 'requote', quote: { ...(await toQuote(r, registration, txs, wallet)) }, ttlMs: SWAP_QUOTE_TTL_MS }
      await checkFunds(r, params.side, wallet, txs)
      return { kind: 'plan', op: { kind: 'swap', route: routeFacts(r), authorizedMinOut: BigInt(shown.minOut) }, plan: toWalletPlan(txs) }
    },

    async summarize(intent, wallet, confirmed) {
      const params = intent.params as unknown as SwapParams
      const hashes = confirmed.map((c) => c.hash)
      const last = confirmed.at(-1)
      if (!last) return { ok: false, message: 'Nothing was sent.', hashes }
      const verdict = classifyOutcome(last.result, plannedOf(wallet.accountId, last.plan))
      const trade = detectTrades(fromRpc(last.result), params.token, { wrapContract: ctx.network.wrapContract }).find((t) => t.account === wallet.accountId)
      const gas = gasOf(confirmed)
      if (verdict.phase === 'success' && trade) {
        const other = (params.side === 'buy' ? trade.paid : trade.received).find((l) => l.asset === 'near')
        return {
          ok: true,
          message: params.side === 'buy' ? 'Buy confirmed.' : 'Sell confirmed.',
          hashes,
          facts: {
            token: params.token,
            tokenAmount: trade.amount.toString(),
            nearAmount: other?.amount.toString() ?? null,
            fee: verdict.swap?.appFee ? { token: verdict.swap.appFee.token, raw: verdict.swap.appFee.raw, recipient: verdict.swap.appFee.recipient } : null,
            gasBurnt: gas.toString(),
          },
        }
      }
      const refund = params.side === 'buy' ? ' Nothing was bought: the NEAR came back to your wallet as wNEAR (wrapped NEAR).' : ' Nothing was sold: your tokens came back.'
      const why =
        verdict.error?.code === 'SLIPPAGE_EXCEEDED' || /slippage|min/i.test(verdict.error?.message ?? '') ? 'The price moved past your slippage.' : 'The swap failed on chain.'
      return { ok: false, message: `${why}${verdict.phase === 'failed' ? refund : ' Open the transaction for the details.'}`, hashes, facts: { gasBurnt: gas.toString() } }
    },

    delivered(intent, wallet, earlier, last) {
      return deliveredTrade(intent.params as unknown as SwapParams, wallet.accountId, earlier, last, ctx.network)
    },
  }

  return {
    handler,
    /** A quote for the Telegram review: the route bound to the wallet, and what it needs registered first. */
    async quote(params: SwapParams, wallet: TradingWallet): Promise<SwapQuote> {
      const r = await router.route(requestOf(params, wallet.accountId), wallet.accountId, false)
      const { txs, registration } = await plan(r, wallet)
      return toQuote(r, registration, txs, wallet)
    },
  }
}

export type SwapService = ReturnType<typeof createSwapService>
