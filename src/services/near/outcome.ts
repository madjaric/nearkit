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
        const parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as { event?: unknown; data?: unknown }
        const first = Array.isArray(parsed.data) ? parsed.data[0] : undefined
        if (typeof parsed.event === 'string') events.push({ event: parsed.event, data: first && typeof first === 'object' ? (first as Record<string, unknown>) : {} })
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

export function classifyOutcome(result: RpcTxResult, planned: PlannedTransaction, context: OutcomeContext = {}): OutcomeVerdict {
  const show = (a: TokenAmount, role: TokenRole) => {
    const t = context.describeToken?.(a.token, role)
    return t ? `${formatUnits(BigInt(a.raw), t.decimals, { maxFraction: 6, group: true })} ${t.symbol}` : `${a.raw} raw units of ${a.token}`
  }

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
            note: 'The swap ran, but NearKit couldn’t confirm the output reached your account. Open it in the explorer before trading again.',
            swap: { received, refunded: null, appFee },
          }
        }
        const parts = [received ? `Received ${show(received, 'received')}` : 'Swap completed', appFee ? `NearKit fee ${show(appFee, 'fee')}` : null].filter(Boolean)
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
