import { parseUnits } from '@/lib/amounts'
import { NEARKIT_FEE_BPS } from '@/lib/fees'
import { GAS } from '@/services/near/gas'
import { groupTransactions } from '@/services/near/plans'
import type { MultiTradeLegQuote, MultiTradeQuote, Quote, Token, Wallet } from '@/types/domain'
import type { FeeDisclosure, OperationPlan, PlannedTransaction, TokenRef } from '@/types/operations'
import { amountValue, tokenRef } from './plans'
import { nextId, type MockState } from './state'

const NEAR_REF: TokenRef = { id: 'near', symbol: 'NEAR', decimals: 24, contract: null }

/** Demo figures are floats; this turns one into raw units for display in a simulated plan only. */
function rawFromNumber(value: number, decimals: number): bigint {
  if (!(value > 0)) return 0n
  return parseUnits(value.toFixed(Math.min(decimals, 8)), decimals)
}

function demoFee(amountNear: number): FeeDisclosure {
  return {
    label: 'NEARKITS fee',
    bps: NEARKIT_FEE_BPS,
    amount: amountValue(rawFromNumber(amountNear, 24), 24),
    token: NEAR_REF,
    charged: false,
    recipient: null,
    received: null,
    routerShare: null,
    routerFee: null,
    note: 'Demo: shown for illustration. Nothing is charged or sent.',
  }
}

function swapTx(index: number, signerId: string, label: string): PlannedTransaction {
  return {
    index,
    signerId,
    receiverId: 'demo-router',
    actions: [{ kind: 'call', method: 'swap (simulated)', args: {}, gas: GAS.SWAP_CALL.toString(), deposit: '1' }],
    lineIds: [`l${index}`],
    label,
    gas: GAS.SWAP_CALL.toString(),
    deposit: '1',
  }
}

export function demoSwapPlan(state: MockState, input: { quote: Quote; tokenIn: Token; tokenOut: Token; signerId: string; walletLabel: string; raw: bigint }): OperationPlan {
  const { quote, tokenIn, tokenOut, signerId, walletLabel, raw } = input
  const inRef = tokenRef(tokenIn)
  const outRef = tokenRef(tokenOut)
  const verb = tokenIn.isNative ? `Buy ${tokenOut.symbol}` : tokenOut.isNative ? `Sell ${tokenIn.symbol}` : `Swap ${tokenIn.symbol} → ${tokenOut.symbol}`
  const transactions = [swapTx(0, signerId, verb)]
  return {
    id: nextId(state, 'plan'),
    kind: 'swap',
    mode: 'demo',
    network: 'demo',
    title: verb,
    token: inRef,
    signers: [signerId],
    lines: [{ id: 'l0', label: walletLabel, accountId: signerId, amount: amountValue(raw, tokenIn.decimals), storageDeposit: null, notes: [], txIndex: 0 }],
    transactions,
    groups: groupTransactions(transactions, true),
    totals: { amount: amountValue(raw, tokenIn.decimals), storage: amountValue(0n, 24), upfrontNear: amountValue(0n, 24) },
    fee: demoFee(quote.nearkitFee.amountNear ?? 0),
    swap: {
      router: 'demo',
      tokenIn: inRef,
      tokenOut: outRef,
      amountIn: amountValue(raw, tokenIn.decimals),
      expectedOut: amountValue(rawFromNumber(quote.amountOut, tokenOut.decimals), tokenOut.decimals),
      minOut: amountValue(rawFromNumber(quote.minAmountOut, tokenOut.decimals), tokenOut.decimals),
      slippagePct: quote.request.slippagePct,
      priceImpactPct: quote.priceImpactPct,
      route: quote.path,
      quotedAt: quote.quotedAt,
    },
    warnings: [],
    expiresAt: quote.expiresAt,
    createdAt: Date.now(),
  }
}

export function demoMultiPlan(state: MockState, input: { quote: MultiTradeQuote; token: Token; legs: (MultiTradeLegQuote & { wallet: Wallet })[] }): OperationPlan {
  const { quote, token, legs } = input
  const buy = quote.request.side === 'buy'
  const inRef = buy ? NEAR_REF : tokenRef(token)
  const verb = `${buy ? 'Multi buy' : 'Multi sell'} ${token.symbol}`
  const transactions = legs.map((leg, i) => swapTx(i, leg.wallet.accountId, `${leg.wallet.label} · ${buy ? 'buy' : 'sell'}`))
  const lines = legs.map((leg, i) => ({
    id: `l${i}`,
    label: leg.wallet.label,
    accountId: leg.wallet.accountId,
    amount: amountValue(rawFromNumber(leg.amountInValue, inRef.decimals), inRef.decimals),
    storageDeposit: null,
    notes: [],
    txIndex: i,
  }))
  const total = lines.reduce((s, l) => s + BigInt(l.amount.raw), 0n)
  return {
    id: nextId(state, 'plan'),
    kind: 'multi-trade',
    mode: 'demo',
    network: 'demo',
    title: `${verb} across ${legs.length} ${legs.length === 1 ? 'wallet' : 'wallets'}`,
    token: inRef,
    signers: [...new Set(legs.map((l) => l.wallet.accountId))],
    lines,
    transactions,
    // One approval per wallet: five wallets are five separate, non-atomic trades.
    groups: transactions.map((t) => [t.index]),
    totals: { amount: amountValue(total, inRef.decimals), storage: amountValue(0n, 24), upfrontNear: amountValue(0n, 24) },
    fee: demoFee(quote.nearkitFeeTotal),
    swap: null,
    warnings: [],
    expiresAt: quote.expiresAt,
    createdAt: Date.now(),
  }
}
