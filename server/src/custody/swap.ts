import { NATIVE_TOKEN_ID, NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { mapLimit } from '@/lib/async'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { detectTrades, fromRpc } from '@/services/near/flows'
import { estimateUpfrontYocto, GAS } from '@/services/near/gas'
import { classifyOutcome } from '@/services/near/outcome'
import { txStorageYocto, txUpfrontYocto } from '@/services/near/plans'
import { HIGH_REGISTRATION_YOCTO } from '@/services/near/storage'
import { aggregatorFee, grossOf } from '@/services/rhea/fees'
import { buildSwapTransactions } from '@/services/rhea/swapTransactions'
import { createSwapRouter, type RoutedSwap } from '@/services/real/swapRouting'
import type { QuoteRequest } from '@/types/domain'
import type { PlannedTransaction } from '@/types/operations'
import type { ServerNear } from '../near'
import type { IntentHandler, PlanOutcome } from './engine'
import type { SwapRouteFacts, WalletTxPlan } from './policy'
import type { Intent, TradingWallet } from './store'

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
  networkFeeNear: string
  quotedAt: number
  expiresAt: number
}

/** A quote can be confirmed this long; the route is fetched again at Confirm anyway. */
export const SWAP_QUOTE_TTL_MS = 60_000
/** Typical burn of a swap and of wrapping NEAR (tradingService.ts, from real swaps). */
const SWAP_BURN_YOCTO = 5n * 10n ** 21n
const WRAP_BURN_YOCTO = 5n * 10n ** 20n

/**
 * NEAR a buy keeps back beyond its amount: gas bought upfront for the swap and a
 * registration (mostly refunded after), plus two registrations. MAX uses it.
 */
export function buyReserve(): bigint {
  const swapTx = estimateUpfrontYocto({ transactions: 1, actions: 3, attachedGas: GAS.STORAGE_DEPOSIT + GAS.NEAR_DEPOSIT + GAS.SWAP_CALL, deposits: 1n })
  const regTx = estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: GAS.STORAGE_DEPOSIT, deposits: 0n })
  return swapTx + regTx + 2n * HIGH_REGISTRATION_YOCTO + 10n ** 21n
}

/** NEAR a sell needs available for gas bought upfront (mostly refunded). */
export function sellReserve(): bigint {
  return estimateUpfrontYocto({ transactions: 1, actions: 1, attachedGas: GAS.SWAP_CALL, deposits: 1n }) + HIGH_REGISTRATION_YOCTO
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

export function createSwapService(near: ServerNear) {
  const router = createSwapRouter(near.ctx)
  const ctx = near.ctx

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

  async function toQuote(r: RoutedSwap, registration: bigint): Promise<SwapQuote> {
    const [symbols, impact] = await Promise.all([mapLimit(r.routeTokens, 4, symbolOf), impactOf(r)])
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
      networkFeeNear: burn.toString(),
      quotedAt: r.quotedAt,
      expiresAt: r.quotedAt + SWAP_QUOTE_TTL_MS,
    }
  }

  /** The wallet must hold the input, and the NEAR for registrations and gas bought upfront. */
  async function checkFunds(r: RoutedSwap, wallet: TradingWallet, txs: PlannedTransaction[]) {
    const storage = txs.reduce((s, t) => s + txStorageYocto(t), 0n)
    const upfront = txs.reduce((s, t) => s + txUpfrontYocto(t), 0n)
    const [state, held] = await Promise.all([
      accountState(ctx.rpc, wallet.accountId, 'final'),
      r.tokenIn.contract ? ctx.reader.balanceOf(r.tokenIn.contract, wallet.accountId) : Promise.resolve(null),
    ])
    if (!state.exists) throw new NearKitError('INSUFFICIENT_BALANCE', 'Your NearKit wallet has no NEAR yet. Deposit first.')
    if (held !== null && held < r.amountIn)
      throw new NearKitError('INSUFFICIENT_BALANCE', `Your NearKit wallet holds ${formatUnits(held, r.tokenIn.decimals, { maxFraction: 6 })} ${r.tokenIn.symbol}.`)
    const nearIn = r.tokenIn.contract === null ? r.amountIn : 0n
    const need = nearIn + storage + upfront
    if (state.availableYocto < need) {
      throw new NearKitError(
        r.tokenIn.contract === null ? 'INSUFFICIENT_BALANCE' : 'INSUFFICIENT_GAS',
        `This needs ${formatUnits(need, NEAR_DECIMALS, { maxFraction: 4 })} NEAR available${nearIn ? ` (${formatUnits(nearIn, NEAR_DECIMALS, { maxFraction: 4 })} to swap, the rest for gas bought upfront and mostly refunded)` : ' for gas bought upfront (mostly refunded)'}. Your NearKit wallet has ${formatUnits(state.availableYocto, NEAR_DECIMALS, { maxFraction: 4 })} NEAR.`,
      )
    }
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
        return { kind: 'requote', quote: { ...(await toQuote(r, registration)) }, ttlMs: SWAP_QUOTE_TTL_MS }
      await checkFunds(r, wallet, txs)
      return { kind: 'plan', op: { kind: 'swap', route: routeFacts(r), authorizedMinOut: BigInt(shown.minOut) }, plan: toWalletPlan(txs) }
    },

    async summarize(intent, wallet, confirmed) {
      const params = intent.params as unknown as SwapParams
      const hashes = confirmed.map((c) => c.hash)
      const last = confirmed.at(-1)
      if (!last) return { ok: false, message: 'Nothing was sent.', hashes }
      const planned = {
        index: 0,
        signerId: wallet.accountId,
        receiverId: last.plan.receiverId,
        actions: last.plan.actions,
        lineIds: [],
        label: '',
        gas: '0',
        deposit: '0',
      } as PlannedTransaction
      const verdict = classifyOutcome(last.result, planned)
      const trade = detectTrades(fromRpc(last.result), params.token, { wrapContract: ctx.network.wrapContract }).find((t) => t.account === wallet.accountId)
      const gas = confirmed.reduce((s, c) => s + fromRpc(c.result).gasBurnt, 0n)
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
            fee: verdict.swap?.appFee ? { token: verdict.swap.appFee.token, raw: verdict.swap.appFee.raw } : null,
            gasBurnt: gas.toString(),
          },
        }
      }
      const refund = params.side === 'buy' ? ' Nothing was bought: the NEAR came back to your wallet as wNEAR (wrapped NEAR).' : ' Nothing was sold: your tokens came back.'
      const why =
        verdict.error?.code === 'SLIPPAGE_EXCEEDED' || /slippage|min/i.test(verdict.error?.message ?? '') ? 'The price moved past your slippage.' : 'The swap failed on chain.'
      return { ok: false, message: `${why}${verdict.phase === 'failed' ? refund : ' Open the transaction for the details.'}`, hashes, facts: { gasBurnt: gas.toString() } }
    },
  }

  return {
    handler,
    /** A quote for the Telegram review: the route bound to the wallet, and what it needs registered first. */
    async quote(params: SwapParams, wallet: TradingWallet): Promise<SwapQuote> {
      const r = await router.route(requestOf(params, wallet.accountId), wallet.accountId, false)
      const { registration } = await plan(r, wallet)
      return toQuote(r, registration)
    },
  }
}

export type SwapService = ReturnType<typeof createSwapService>
