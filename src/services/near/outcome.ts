import { formatUnits } from '@/lib/amounts'
import type { NearKitErrorInfo, PlannedAction, PlannedTransaction } from '@/types/operations'
import { classifyFailure, errorInfo, NearKitError } from './errors'
import { decodeBase64Json, type RpcTxResult } from './rpc'

/**
 * Reading a confirmed transaction. The wallet's own result is never proof: the
 * executor fetches the outcome from our RPC and classifies it here.
 */

export interface TokenAmount {
  token: string
  raw: string
}

/** What a swap through Rhea's aggregator did, read from its EVENT_JSON logs. */
export interface SwapOutcome {
  received: TokenAmount | null
  refunded: TokenAmount | null
  appFee: (TokenAmount & { recipient: string }) | null
}

export interface OutcomeVerdict {
  phase: 'success' | 'failed' | 'unknown'
  error: NearKitErrorInfo | null
  note: string | null
  swap?: SwapOutcome
}

export type TokenRole = 'received' | 'refunded' | 'fee'

export interface OutcomeContext {
  /** Symbol and decimals for readable notes; unknown tokens are shown in raw units. */
  describeToken?: (tokenId: string, role: TokenRole) => { symbol: string; decimals: number } | null
}

interface ContractEvent {
  standard: string
  event: string
  data: Record<string, unknown>
}

/** `EVENT_JSON:` logs emitted by one contract across the receipt tree, in order. */
function eventsOf(result: RpcTxResult, executor: string): ContractEvent[] {
  const events: ContractEvent[] = []
  for (const r of result.receipts_outcome ?? []) {
    if (r.outcome.executor_id !== executor) continue
    for (const log of r.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue
      try {
        const parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as { standard?: unknown; event?: unknown; data?: unknown }
        const first = Array.isArray(parsed.data) ? parsed.data[0] : undefined
        if (typeof parsed.event === 'string')
          events.push({
            standard: typeof parsed.standard === 'string' ? parsed.standard : '',
            event: parsed.event,
            data: first && typeof first === 'object' ? (first as Record<string, unknown>) : {},
          })
      } catch {
        // not an event we can read
      }
    }
  }
  return events
}

const AGGREGATOR_EVENTS = new Set([
  'single_swap_success',
  'single_swap_failed',
  'swap_failed_refund_started',
  'withdraw_started',
  'withdraw_succeeded',
  'earn_app_fee',
  'earn_protocol_fee',
])

function amountOf(data: Record<string, unknown> | undefined, tokenKey: string): TokenAmount | null {
  const token = data?.[tokenKey]
  const raw = data?.amount
  return typeof token === 'string' && typeof raw === 'string' && /^\d+$/.test(raw) ? { token, raw } : null
}

/**
 * NearKit's fee as Rhea's aggregator reported it on chain (`earn_app_fee`): the fee token,
 * the amount credited to the fee account (its share, after Rhea's) and that account. Null
 * when the transaction carried no app fee (testnet, a refund, another route).
 */
export function appFeeEarned(result: RpcTxResult, aggregator: string): (TokenAmount & { recipient: string }) | null {
  const data = eventsOf(result, aggregator).find((e) => e.event === 'earn_app_fee')?.data
  const fee = amountOf(data, 'token')
  return fee && typeof data?.receipt === 'string' ? { ...fee, recipient: data.receipt } : null
}

/** Hash from a wallet result (FinalExecutionOutcome), or null when there is none. */
export function extractHash(walletResult: unknown): string | null {
  if (typeof walletResult === 'string' && walletResult.length > 0) return walletResult
  if (!walletResult || typeof walletResult !== 'object') return null
  const r = walletResult as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } }
  if (typeof r.transaction?.hash === 'string' && r.transaction.hash) return r.transaction.hash
  if (typeof r.transaction_outcome?.id === 'string' && r.transaction_outcome.id) return r.transaction_outcome.id
  return null
}

function statusObject(status: unknown): { SuccessValue?: string; Failure?: unknown } | null {
  return status && typeof status === 'object' ? (status as { SuccessValue?: string; Failure?: unknown }) : null
}

/** First failed receipt in the outcome tree, for the refund reason. */
function firstReceiptFailure(result: RpcTxResult): unknown {
  for (const r of result.receipts_outcome ?? []) {
    const s = statusObject(r.outcome.status)
    if (s && 'Failure' in s) return s.Failure
  }
  return null
}

const fail = (error: NearKitError, note: string | null = null): OutcomeVerdict => ({ phase: 'failed', error: errorInfo(error), note })

/** JSON with sorted keys, so argument order never decides equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const sameInt = (a: unknown, b: unknown) => {
  try {
    return BigInt(String(a)) === BigInt(String(b))
  } catch {
    return false
  }
}

/** Why the chain's actions differ from the plan, or null when they match exactly. */
function actionsMismatch(chain: unknown[], planned: PlannedAction[]): string | null {
  if (chain.length !== planned.length) return `${chain.length} actions on chain, ${planned.length} planned`
  for (const [i, p] of planned.entries()) {
    const c = chain[i] as { Transfer?: { deposit?: unknown }; FunctionCall?: { method_name?: unknown; args?: unknown; gas?: unknown; deposit?: unknown } } | undefined
    if (p.kind === 'transfer') {
      if (!c?.Transfer || !sameInt(c.Transfer.deposit, p.deposit)) return `action ${i + 1} is not the planned transfer`
      continue
    }
    const f = c?.FunctionCall
    if (!f || f.method_name !== p.method || !sameInt(f.deposit, p.deposit) || !sameInt(f.gas, p.gas)) return `action ${i + 1} is not the planned ${p.method}`
    let args: unknown
    try {
      args = decodeBase64Json(String(f.args ?? ''))
    } catch {
      return `action ${i + 1} has unreadable arguments`
    }
    if (canonical(args) !== canonical(p.args)) return `action ${i + 1} has different arguments than planned`
  }
  return null
}

/** Native NEAR output: a successful transfer of that amount from the aggregator to the recipient. */
function nativeDelivered(result: RpcTxResult, from: string, to: unknown, amount: string): boolean {
  if (typeof to !== 'string') return false
  return (result.receipts ?? []).some((r) => {
    if (r.predecessor_id !== from || r.receiver_id !== to) return false
    const pays = (r.receipt.Action?.actions ?? []).some((a) => sameInt((a as { Transfer?: { deposit?: unknown } }).Transfer?.deposit, amount))
    const status = statusObject(result.receipts_outcome.find((o) => o.id === r.receipt_id)?.outcome.status)
    return pays && status !== null && 'SuccessValue' in status
  })
}

/** A swap on Ref's DCL exchange, read from its `swap` events (one per pool; the last names the output). */
interface DclSwap {
  tokenOut: string
  amountOut: string
}

function dclSwapOf(events: ContractEvent[]): DclSwap | null {
  const last = events.filter((e) => e.standard === 'dcl.ref' && e.event === 'swap').at(-1)
  const tokenOut = last?.data.token_out
  const amountOut = last?.data.amount_out
  return typeof tokenOut === 'string' && typeof amountOut === 'string' && /^\d+$/.test(amountOut) ? { tokenOut, amountOut } : null
}

/** A NEP-141 transfer of `token` from `from` to `to` in a receipt that succeeded: the amount that arrived (after any tax the token takes). */
function tokenDelivered(result: RpcTxResult, token: string, from: string, to: string): string | null {
  for (const r of result.receipts_outcome ?? []) {
    if (r.outcome.executor_id !== token) continue
    const status = statusObject(r.outcome.status)
    if (!status || !('SuccessValue' in status)) continue
    for (const log of r.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue
      let parsed: { standard?: unknown; event?: unknown; data?: unknown }
      try {
        parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as typeof parsed
      } catch {
        continue
      }
      if (parsed.standard !== 'nep141' || parsed.event !== 'ft_transfer' || !Array.isArray(parsed.data)) continue
      for (const d of parsed.data as { old_owner_id?: unknown; new_owner_id?: unknown; amount?: unknown }[]) {
        if (d.old_owner_id === from && d.new_owner_id === to && typeof d.amount === 'string' && /^\d+$/.test(d.amount) && BigInt(d.amount) > 0n) return d.amount
      }
    }
  }
  return null
}

/** What a direct DCL swap delivered to `to`: the output token's transfer, or the exchange's NEAR transfer of the unwrapped output. */
function dclReceived(result: RpcTxResult, dex: string, to: string, swap: DclSwap): TokenAmount | null {
  const arrived = tokenDelivered(result, swap.tokenOut, dex, to)
  if (arrived) return { token: swap.tokenOut, raw: arrived }
  return nativeDelivered(result, dex, to, swap.amountOut) ? { token: 'near', raw: swap.amountOut } : null
}

/** NearKit's fee on a direct route: the plan's own transfer to the fee account, carried by the swap's transaction. */
function directFeeOf(planned: PlannedTransaction): (TokenAmount & { recipient: string }) | null {
  const fee = planned.actions.find((a) => a.kind === 'call' && a.method === 'ft_transfer')
  if (!fee || fee.kind !== 'call') return null
  const { receiver_id, amount } = fee.args
  return typeof receiver_id === 'string' && typeof amount === 'string' && /^\d+$/.test(amount) ? { token: planned.receiverId, raw: amount, recipient: receiver_id } : null
}

const UNCONFIRMED_DELIVERY = 'The swap ran, but NEARKITS couldn’t confirm the output reached your account. Open it in the explorer before trading again.'

/** Whether a transaction's actions, as the chain shows them, are exactly the planned ones. */
export function sameActions(chain: readonly unknown[], planned: PlannedAction[]): boolean {
  return actionsMismatch([...chain], planned) === null
}

const shower = (context: OutcomeContext) => (a: TokenAmount, role: TokenRole) => {
  const t = a.token === 'near' ? { symbol: 'NEAR', decimals: 24 } : context.describeToken?.(a.token, role)
  return t ? `${formatUnits(BigInt(a.raw), t.decimals, { maxFraction: 6, group: true })} ${t.symbol}` : `${a.raw} raw units of ${a.token}`
}

export interface DeliveryExpectation {
  /** The output token's contract, or `near` for native NEAR (a direct route's unwrapped output). */
  token: string
  /** The account that must receive it (the signer). */
  recipient: string
}

/**
 * A swap through Rhea's aggregator whose output already reached the recipient, read from a
 * transaction that may still be running. The aggregator reports `withdraw_succeeded` once its
 * transfer of the output to the recipient succeeded; what runs after it (the input's
 * `ft_resolve_transfer`, `callback_swap` with `single_swap_success`) settles its own books and
 * can't take the tokens back. Under congestion that settlement can come minutes later.
 *
 * Null until then, and for anything else: a refund, another token or recipient, a failed
 * transaction, or a transaction that isn't exactly the planned one.
 */
export function swapDelivered(result: RpcTxResult, planned: PlannedTransaction, expect: DeliveryExpectation, context: OutcomeContext = {}): OutcomeVerdict | null {
  const last = planned.actions.at(-1)
  if (last?.kind !== 'call' || last.method !== 'ft_transfer_call' || typeof last.args.receiver_id !== 'string') return null
  if (result.transaction.signer_id !== planned.signerId || result.transaction.receiver_id !== planned.receiverId) return null
  if (!Array.isArray(result.transaction.actions) || actionsMismatch(result.transaction.actions, planned.actions) !== null) return null
  const status = statusObject(result.status)
  if (status && 'Failure' in status) return null
  const events = eventsOf(result, last.args.receiver_id)
  if (events.some((e) => e.event === 'swap_failed_refund_started')) return null
  const show = shower(context)
  const dcl = dclSwapOf(events)
  if (dcl) {
    const received = dclReceived(result, last.args.receiver_id, expect.recipient, dcl)
    if (!received || received.token !== expect.token) return null
    const appFee = directFeeOf(planned)
    const note = [`Received ${show(received, 'received')}`, appFee ? `NEARKITS fee ${show(appFee, 'fee')}` : null].filter(Boolean).join(' · ')
    return { phase: 'success', error: null, note, swap: { received, refunded: null, appFee } }
  }
  const done = events.find((e) => e.event === 'withdraw_succeeded' && e.data.token_id === expect.token && e.data.receive_id === expect.recipient)
  const received = amountOf(done?.data, 'token_id')
  if (!received || BigInt(received.raw) === 0n) return null
  const feeData = events.find((e) => e.event === 'earn_app_fee')?.data
  const fee = amountOf(feeData, 'token')
  const appFee = fee && typeof feeData?.receipt === 'string' ? { ...fee, recipient: feeData.receipt } : null
  const note = [`Received ${show(received, 'received')}`, appFee ? `NEARKITS fee ${show(appFee, 'fee')}` : null].filter(Boolean).join(' · ')
  return { phase: 'success', error: null, note, swap: { received, refunded: null, appFee } }
}

export function classifyOutcome(result: RpcTxResult, planned: PlannedTransaction, context: OutcomeContext = {}): OutcomeVerdict {
  const show = shower(context)

  if (Array.isArray(result.transaction.actions)) {
    const why = actionsMismatch(result.transaction.actions, planned.actions)
    if (why) return fail(new NearKitError('TRANSACTION_FAILED', 'The confirmed transaction does not match the plan', { detail: why }))
  }
  if (result.transaction.signer_id !== planned.signerId || result.transaction.receiver_id !== planned.receiverId) {
    return fail(
      new NearKitError('TRANSACTION_FAILED', 'The confirmed transaction does not match the plan', {
        detail: `planned ${planned.signerId} → ${planned.receiverId}; chain shows ${result.transaction.signer_id} → ${result.transaction.receiver_id}`,
      }),
    )
  }

  const status = statusObject(result.status)
  if (!status) return { phase: 'unknown', error: null, note: 'The transaction has not finished yet' }
  if ('Failure' in status) return fail(classifyFailure(status.Failure))
  if (!('SuccessValue' in status)) return { phase: 'unknown', error: null, note: 'The transaction has not finished yet' }

  // ft_transfer_call returns the amount the receiver used; the rest came back.
  const last = planned.actions.at(-1)
  if (last?.kind === 'call' && last.method === 'ft_transfer_call') {
    const sent = BigInt(String(last.args.amount ?? '0'))
    let used: bigint
    try {
      used = BigInt(String(decodeBase64Json(status.SuccessValue ?? '')))
    } catch {
      return { phase: 'unknown', error: null, note: 'Could not read how much of the transfer was used' }
    }
    if (used === 0n) {
      const inner = firstReceiptFailure(result)
      const cause = inner ? classifyFailure(inner) : new NearKitError('TRANSACTION_FAILED', 'The receiving contract did not accept the transfer')
      return fail(cause, 'Nothing was swapped: the full amount was refunded to your wallet')
    }

    // Rhea's aggregator keeps the whole input either way and refunds with a separate
    // transfer, so "used" can't tell success from refund: its events decide.
    const receiver = typeof last.args.receiver_id === 'string' ? last.args.receiver_id : ''
    const events = eventsOf(result, receiver)
    // A direct swap on the DCL exchange: its `swap` event says what came out; done only when that output provably reached the wallet.
    const dcl = dclSwapOf(events)
    if (dcl) {
      const received = dclReceived(result, receiver, planned.signerId, dcl)
      const appFee = directFeeOf(planned)
      if (!received) return { phase: 'unknown', error: null, note: UNCONFIRMED_DELIVERY, swap: { received: null, refunded: null, appFee } }
      const parts = [`Received ${show(received, 'received')}`, appFee ? `NEARKITS fee ${show(appFee, 'fee')}` : null].filter(Boolean)
      return { phase: 'success', error: null, note: parts.join(' · '), swap: { received, refunded: null, appFee } }
    }
    if (events.some((e) => AGGREGATOR_EVENTS.has(e.event))) {
      const find = (name: string) => events.find((e) => e.event === name)?.data
      const refunded = amountOf(find('swap_failed_refund_started'), 'token_id')
      const received = amountOf(find('withdraw_started') ?? find('withdraw_succeeded'), 'token_id')
      const feeData = find('earn_app_fee')
      const fee = amountOf(feeData, 'token')
      const appFee = fee && typeof feeData?.receipt === 'string' ? { ...fee, recipient: feeData.receipt } : null
      if (refunded) {
        const inner = firstReceiptFailure(result)
        const cause = inner ? classifyFailure(inner) : new NearKitError('TRANSACTION_FAILED', 'The swap did not complete')
        const intermediate = refunded.token !== planned.receiverId
        const note = intermediate
          ? `A later hop missed its minimum, so you received ${show(refunded, 'refunded')} instead of the output token. No fee was charged.`
          : `Nothing was swapped: ${show(refunded, 'refunded')} was refunded to your wallet. No fee was charged.`
        return { ...fail(cause, note), swap: { received: null, refunded, appFee: null } }
      }
      if (events.some((e) => e.event === 'single_swap_success')) {
        // Done only when the output provably reached the recipient: a token withdrawal that
        // succeeded, or the aggregator's NEAR transfer for native output.
        const started = find('withdraw_started')
        const delivered = events.some((e) => e.event === 'withdraw_succeeded') || (received !== null && nativeDelivered(result, receiver, started?.receive_id, received.raw))
        if (!delivered) {
          return {
            phase: 'unknown',
            error: null,
            note: UNCONFIRMED_DELIVERY,
            swap: { received, refunded: null, appFee },
          }
        }
        const parts = [received ? `Received ${show(received, 'received')}` : 'Swap completed', appFee ? `NEARKITS fee ${show(appFee, 'fee')}` : null].filter(Boolean)
        return { phase: 'success', error: null, note: parts.join(' · '), swap: { received, refunded: null, appFee } }
      }
      return {
        phase: 'unknown',
        error: null,
        note: 'Rhea’s aggregator did not report an outcome. Open the transaction in the explorer.',
        swap: { received: null, refunded: null, appFee: null },
      }
    }

    if (used < sent) return { phase: 'success', error: null, note: `Partially used: ${sent - used} raw units were refunded` }
  }
  return { phase: 'success', error: null, note: null }
}
