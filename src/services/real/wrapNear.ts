import { NEAR_DECIMALS } from '@/config/networks'
import { formatUnits } from '@/lib/amounts'
import { accountState } from '@/services/near/account'
import { NearKitError, toNearKitError } from '@/services/near/errors'
import { groupTransactions, txStorageYocto, txUpfrontYocto } from '@/services/near/plans'
import { storageBoundsMin, storageStatus } from '@/services/near/storage'
import { nearWithdrawAction, WRAP_NETWORK_FEE_YOCTO, wrapActions, type WrapDirection } from '@/services/near/wrap'
import type { Quote, QuoteRequest, Wallet } from '@/types/domain'
import type { OperationPlan, PlannedAction, PlannedTransaction, TokenRef } from '@/types/operations'
import { amountValue, NEAR_REF, nearText, nearValue, newPlanId, parseAmount, sumRaw } from './common'
import type { NearContext } from './context'

/**
 * NEAR ↔ wNEAR on the Swap page: wrapping, not a swap. No exchange, no router quote, no NEARKITS
 * fee, and the amount out is exactly the amount in. Unwrapping signs the same `near_withdraw` that
 * NEARKITS' server signs for a NEARKITS wallet (custody/unwrap.ts); wrapping signs the wrap step of
 * a swap from NEAR (registration with the wrap contract when the account has none, then
 * `near_deposit`), both built in services/near/wrap.ts.
 */

const QUOTE_TTL_MS = 30_000
const REVIEW_WINDOW_MS = 120_000

export function createWrapPlanner(ctx: NearContext) {
  const wrap = ctx.network.wrapContract
  const wnear: TokenRef = { id: wrap, symbol: 'wNEAR', decimals: NEAR_DECIMALS, contract: wrap }
  const sides = (d: WrapDirection) => (d === 'unwrap' ? { tokenIn: wnear, tokenOut: NEAR_REF } : { tokenIn: NEAR_REF, tokenOut: wnear })
  const path = (d: WrapDirection) => (d === 'unwrap' ? ['wNEAR', 'NEAR'] : ['NEAR', 'wNEAR'])
  const display = (raw: bigint) => Number(formatUnits(raw, NEAR_DECIMALS))

  /** Exact: what goes in comes out, 1:1, with nothing taken. */
  function quote(request: QuoteRequest, d: WrapDirection): Quote {
    const amount = parseAmount(request.amountIn, sides(d).tokenIn, 'Amount')
    const now = ctx.now()
    return {
      request,
      amountOut: display(amount),
      minAmountOut: display(amount),
      amountOutRaw: amount.toString(),
      minAmountOutRaw: amount.toString(),
      rate: 1,
      priceImpactPct: 0,
      nearkitFee: { amountNear: null, amountUsd: null, bps: 0, charged: false, receivedBps: null, routerShareBps: null, routerFeeBps: null },
      networkFeeNear: display(WRAP_NETWORK_FEE_YOCTO),
      path: path(d),
      router: d,
      quotedAt: now,
      expiresAt: now + QUOTE_TTL_MS,
    }
  }

  /** The plan the wallet signs: one transaction to the wrap contract, checked against what the wallet holds. */
  async function plan(wallet: Wallet, request: QuoteRequest, d: WrapDirection, extra: { warnings: string[]; batch: boolean }): Promise<OperationPlan> {
    const { tokenIn, tokenOut } = sides(d)
    const amount = parseAmount(request.amountIn, tokenIn, 'Amount')
    const signer = wallet.accountId
    let actions: PlannedAction[]
    let state
    try {
      if (d === 'unwrap') {
        const [held, s] = await Promise.all([ctx.reader.balanceOf(wrap, signer), accountState(ctx.rpc, signer)])
        if (held < amount)
          throw new NearKitError('INSUFFICIENT_BALANCE', `${wallet.label} holds ${formatUnits(held, NEAR_DECIMALS)} wNEAR and this unwraps ${formatUnits(amount, NEAR_DECIMALS)}`)
        actions = [nearWithdrawAction(amount)]
        state = s
      } else {
        // As a swap from NEAR registers the signer with the wrap contract before wrapping (swapRouting's prerequisites).
        const [registered, s] = await Promise.all([storageStatus(ctx.rpc, wrap, [signer]), accountState(ctx.rpc, signer)])
        const registerDeposit = registered.get(signer) === false ? await storageBoundsMin(ctx.rpc, wrap) : null
        actions = wrapActions(signer, amount, registerDeposit)
        state = s
      }
    } catch (e) {
      throw e instanceof NearKitError ? e : toNearKitError(e, 'RPC_ERROR')
    }
    const draft = { signerId: signer, receiverId: wrap, actions, lineIds: [], label: d === 'unwrap' ? 'Unwrap wNEAR' : 'Wrap NEAR' }
    const tx: PlannedTransaction = {
      ...draft,
      index: 0,
      gas: sumRaw(actions.map((a) => (a.kind === 'call' ? BigInt(a.gas) : 0n))).toString(),
      deposit: sumRaw(actions.map((a) => BigInt(a.deposit))).toString(),
    }
    const storage = txStorageYocto(tx)
    const upfront = txUpfrontYocto(tx)
    const nearIn = d === 'wrap' ? amount : 0n
    if (d === 'wrap' && state.availableYocto < amount) {
      throw new NearKitError(
        'INSUFFICIENT_BALANCE',
        `${wallet.label} has ${nearText(state.availableYocto)} NEAR available and this wraps ${formatUnits(amount, NEAR_DECIMALS)} NEAR`,
      )
    }
    const need = nearIn + storage + upfront
    if (state.availableYocto < need) {
      const parts = [
        nearIn ? `${formatUnits(nearIn, NEAR_DECIMALS)} to wrap` : null,
        storage ? `${nearText(storage)} to register with the wrap contract` : null,
        `${nearText(upfront)} gas reserve`,
      ]
      throw new NearKitError(
        'INSUFFICIENT_GAS',
        `${wallet.label} needs ${nearText(need)} NEAR available to sign (${parts.filter(Boolean).join(' + ')}). It has ${nearText(state.availableYocto)} NEAR.`,
      )
    }
    const now = ctx.now()
    const value = amountValue(amount, NEAR_DECIMALS)
    return {
      id: newPlanId(now),
      kind: 'swap',
      mode: 'near',
      network: ctx.network.id,
      title: `${d === 'unwrap' ? 'Unwrap' : 'Wrap'} · ${formatUnits(amount, NEAR_DECIMALS)} ${tokenIn.symbol}`,
      token: tokenIn,
      signers: [signer],
      lines: [],
      transactions: [tx],
      groups: groupTransactions([tx], extra.batch),
      totals: { amount: value, storage: nearValue(storage), upfrontNear: nearValue(upfront) },
      // Not a trade: no NEARKITS fee, no exchange, nothing to slip.
      fee: null,
      swap: {
        router: d,
        tokenIn,
        tokenOut,
        amountIn: value,
        expectedOut: value,
        minOut: value,
        slippagePct: 0,
        priceImpactPct: 0,
        route: path(d),
        routeTokens: [wnear],
        quotedAt: now,
      },
      warnings: extra.warnings,
      expiresAt: now + REVIEW_WINDOW_MS,
      createdAt: now,
    } satisfies OperationPlan
  }

  return { quote, plan }
}
