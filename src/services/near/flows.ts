import type { RpcTxResult } from './rpc'

/**
 * What a transaction moved, read from the chain's own record: every token and
 * NEAR movement in every receipt that succeeded, and from that, who traded what.
 * One implementation for the buybot, positions and PnL, and trade confirmations,
 * so they can never disagree.
 *
 * Sources of truth, per receipt that SUCCEEDED (a failed receipt changes nothing):
 * - NEP-141 `EVENT_JSON` logs: ft_transfer, ft_mint, ft_burn.
 * - Legacy text logs for tokens that predate events (wrap.near): "Deposit N NEAR to A",
 *   "Transfer N from A to B", "Withdraw N NEAR from A", "Refund N from B to A".
 * - Native NEAR: deposits attached to Transfer and FunctionCall actions. Gas refunds
 *   (receipts from `system`) are not income; gas is counted once, as `gasBurnt`.
 * Storage deposits and the 1 yoctoNEAR security deposit NEP-141 requires are tagged,
 * so trade values can leave them out.
 */

export type ActionView = { kind: 'transfer'; deposit: bigint } | { kind: 'call'; method: string; deposit: bigint } | { kind: 'delegate'; sender: string } | { kind: 'other' }

export interface NormalizedReceipt {
  id: string
  predecessorId: string
  receiverId: string
  actions: ActionView[]
  executorId: string
  logs: string[]
  success: boolean
  tokensBurnt: bigint
  /** Receipts this one created (its outcome's receipt_ids). */
  children: string[]
}

export interface NormalizedTx {
  hash: string
  signerId: string
  receiverId: string
  /** The signer and any delegate-action (meta-transaction) senders: whoever started it. */
  initiators: string[]
  /** yoctoNEAR burnt as gas across the whole receipt tree: what the signer paid for gas. */
  gasBurnt: bigint
  receipts: NormalizedReceipt[]
  blockHeight: number | null
  /** Block time in ms, when the source reports it. */
  timestampMs: number | null
}

export type FlowKind = 'transfer' | 'mint' | 'burn' | 'native' | 'storage' | 'security'

export interface Flow {
  /** Token contract, or 'near' for native NEAR. */
  asset: string
  from: string | null
  to: string | null
  amount: bigint
  kind: FlowKind
  receiptId: string
}

export interface FlowOptions {
  wrapContract: string
  /** Other tokens that log in the legacy text format. */
  legacyTokens?: readonly string[]
}

// ─── normalizing ────────────────────────────────────────────────────────────

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const big = (v: unknown): bigint => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : 0n)

function actionView(raw: unknown): ActionView {
  if (!obj(raw)) return { kind: 'other' }
  if (obj(raw.Transfer)) return { kind: 'transfer', deposit: big(raw.Transfer.deposit) }
  if (obj(raw.FunctionCall)) return { kind: 'call', method: String(raw.FunctionCall.method_name ?? ''), deposit: big(raw.FunctionCall.deposit) }
  if (obj(raw.Delegate)) {
    const inner = obj(raw.Delegate.delegate_action) ? raw.Delegate.delegate_action : {}
    return { kind: 'delegate', sender: String(inner.sender_id ?? '') }
  }
  return { kind: 'other' }
}

function succeeded(status: unknown): boolean {
  return obj(status) && ('SuccessValue' in status || 'SuccessReceiptId' in status)
}

function receiptActions(receipt: unknown): ActionView[] {
  const action = obj(receipt) && obj(receipt.Action) ? receipt.Action : null
  return action && Array.isArray(action.actions) ? action.actions.map(actionView) : []
}

function initiatorsOf(signerId: string, txActions: unknown): string[] {
  const delegates = (Array.isArray(txActions) ? txActions.map(actionView) : []).flatMap((a) => (a.kind === 'delegate' && a.sender ? [a.sender] : []))
  return [...new Set([signerId, ...delegates])]
}

/** From `EXPERIMENTAL_tx_status` (which includes the receipts themselves). */
export function fromRpc(result: RpcTxResult, block: { height?: number; timestampMs?: number } = {}): NormalizedTx {
  const receipts = new Map((result.receipts ?? []).map((r) => [r.receipt_id, r]))
  const outcomes = result.receipts_outcome ?? []
  return {
    hash: result.transaction.hash,
    signerId: result.transaction.signer_id,
    receiverId: result.transaction.receiver_id,
    initiators: initiatorsOf(result.transaction.signer_id, result.transaction.actions),
    gasBurnt: big(result.transaction_outcome.outcome.tokens_burnt) + outcomes.reduce((s, o) => s + big(o.outcome.tokens_burnt), 0n),
    receipts: outcomes.map((o) => {
      const r = receipts.get(o.id)
      return {
        id: o.id,
        predecessorId: r?.predecessor_id ?? '',
        receiverId: r?.receiver_id ?? o.outcome.executor_id,
        actions: receiptActions(r?.receipt),
        executorId: o.outcome.executor_id,
        logs: o.outcome.logs ?? [],
        success: succeeded(o.outcome.status),
        tokensBurnt: big(o.outcome.tokens_burnt),
        children: o.outcome.receipt_ids ?? [],
      }
    }),
    blockHeight: block.height ?? null,
    timestampMs: block.timestampMs ?? null,
  }
}

interface FastTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions?: unknown[] }
  execution_outcome: { outcome: { tokens_burnt?: string } }
  receipts: {
    receipt: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: unknown }
    execution_outcome: { id: string; outcome: { executor_id: string; logs?: string[]; status: unknown; tokens_burnt?: string; receipt_ids?: string[] } }
  }[]
  block_height?: number
  /** Nanoseconds, as a string. */
  block_timestamp?: string
}

/** From FastNEAR's transactions API (tx.main.fastnear.com /v0/transactions). */
export function fromFastnear(raw: unknown): NormalizedTx {
  const t = raw as FastTx
  const receipts = t.receipts ?? []
  const ts = typeof t.block_timestamp === 'string' && /^\d+$/.test(t.block_timestamp) ? Number(BigInt(t.block_timestamp) / 1_000_000n) : null
  return {
    hash: t.transaction.hash,
    signerId: t.transaction.signer_id,
    receiverId: t.transaction.receiver_id,
    initiators: initiatorsOf(t.transaction.signer_id, t.transaction.actions),
    gasBurnt: big(t.execution_outcome?.outcome?.tokens_burnt) + receipts.reduce((s, r) => s + big(r.execution_outcome.outcome.tokens_burnt), 0n),
    receipts: receipts.map((r) => ({
      id: r.execution_outcome.id,
      predecessorId: r.receipt.predecessor_id,
      receiverId: r.receipt.receiver_id,
      actions: receiptActions(r.receipt.receipt),
      executorId: r.execution_outcome.outcome.executor_id,
      logs: r.execution_outcome.outcome.logs ?? [],
      success: succeeded(r.execution_outcome.outcome.status),
      tokensBurnt: big(r.execution_outcome.outcome.tokens_burnt),
      children: r.execution_outcome.outcome.receipt_ids ?? [],
    })),
    blockHeight: typeof t.block_height === 'number' ? t.block_height : null,
    timestampMs: ts,
  }
}

/**
 * True once every receipt the transaction created is in the record. An index can
 * serve a transaction while its last receipts are still executing; judging it
 * then would miss a refund or a payout.
 */
export function isComplete(tx: NormalizedTx, firstReceiptIds: readonly string[] = []): boolean {
  if (!tx.receipts.length) return false
  const have = new Set(tx.receipts.map((r) => r.id))
  return firstReceiptIds.every((id) => have.has(id)) && tx.receipts.every((r) => r.children.every((id) => have.has(id)))
}

// ─── flows ──────────────────────────────────────────────────────────────────

const ACCOUNT = '([a-z0-9._-]{2,64})'
const LEGACY: [RegExp, (m: RegExpExecArray) => { kind: 'transfer' | 'mint' | 'burn'; from: string | null; to: string | null; amount: bigint }][] = [
  [new RegExp(`^Deposit (\\d+) NEAR to ${ACCOUNT}$`), (m) => ({ kind: 'mint', from: null, to: m[2] as string, amount: BigInt(m[1] as string) })],
  [new RegExp(`^Withdraw (\\d+) NEAR from ${ACCOUNT}$`), (m) => ({ kind: 'burn', from: m[2] as string, to: null, amount: BigInt(m[1] as string) })],
  [
    new RegExp(`^Transfer (\\d+) from ${ACCOUNT} to ${ACCOUNT}(?:, memo: .*)?$`),
    (m) => ({ kind: 'transfer', from: m[2] as string, to: m[3] as string, amount: BigInt(m[1] as string) }),
  ],
  [new RegExp(`^Refund (\\d+) from ${ACCOUNT} to ${ACCOUNT}$`), (m) => ({ kind: 'transfer', from: m[2] as string, to: m[3] as string, amount: BigInt(m[1] as string) })],
  [new RegExp(`^Account @${ACCOUNT} burned (\\d+)$`), (m) => ({ kind: 'burn', from: m[1] as string, to: null, amount: BigInt(m[2] as string) })],
]

export function parseLegacyFtLog(line: string): { kind: 'transfer' | 'mint' | 'burn'; from: string | null; to: string | null; amount: bigint } | null {
  for (const [re, make] of LEGACY) {
    const m = re.exec(line)
    if (m) return make(m)
  }
  return null
}

const STORAGE_METHODS = /^(storage_deposit|tokens_storage_deposit|register_tokens|storage_register)$/
const SECURITY_METHODS = /^(ft_transfer|ft_transfer_call|storage_withdraw|storage_unregister|withdraw|near_withdraw)$/

function nep141(line: string): { event: string; data: Record<string, unknown>[] } | null {
  if (!line.startsWith('EVENT_JSON:')) return null
  try {
    const parsed = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: unknown; event?: unknown; data?: unknown }
    if (parsed.standard !== 'nep141' || typeof parsed.event !== 'string' || !Array.isArray(parsed.data)) return null
    return { event: parsed.event, data: parsed.data.filter(obj) }
  } catch {
    return null
  }
}

/** Every token and NEAR movement in the transaction's successful receipts, in order. */
export function flowsOf(tx: NormalizedTx, options: FlowOptions): Flow[] {
  const legacy = new Set([options.wrapContract, ...(options.legacyTokens ?? [])])
  // A storage deposit's refund (NEP-145 returns the excess) belongs with the deposit.
  const storageRefunds = new Set(tx.receipts.filter((r) => r.actions.some((a) => a.kind === 'call' && STORAGE_METHODS.test(a.method) && a.deposit > 0n)).flatMap((r) => r.children))
  const flows: Flow[] = []
  for (const r of tx.receipts) {
    if (!r.success) continue
    if (r.predecessorId && r.predecessorId !== 'system') {
      for (const a of r.actions) {
        if ((a.kind !== 'transfer' && a.kind !== 'call') || a.deposit === 0n) continue
        const method = a.kind === 'call' ? a.method : ''
        const kind: FlowKind =
          STORAGE_METHODS.test(method) || (a.kind === 'transfer' && storageRefunds.has(r.id))
            ? 'storage'
            : a.deposit === 1n && SECURITY_METHODS.test(method)
              ? 'security'
              : 'native'
        flows.push({ asset: 'near', from: r.predecessorId, to: r.receiverId, amount: a.deposit, kind, receiptId: r.id })
      }
    }
    for (const line of r.logs) {
      const event = nep141(line)
      if (event) {
        for (const d of event.data) {
          const amount = big(d.amount)
          if (amount === 0n) continue
          if (event.event === 'ft_transfer')
            flows.push({ asset: r.executorId, from: String(d.old_owner_id ?? ''), to: String(d.new_owner_id ?? ''), amount, kind: 'transfer', receiptId: r.id })
          else if (event.event === 'ft_mint') flows.push({ asset: r.executorId, from: null, to: String(d.owner_id ?? ''), amount, kind: 'mint', receiptId: r.id })
          else if (event.event === 'ft_burn') flows.push({ asset: r.executorId, from: String(d.owner_id ?? ''), to: null, amount, kind: 'burn', receiptId: r.id })
        }
        continue
      }
      if (legacy.has(r.executorId)) {
        const l = parseLegacyFtLog(line)
        if (l && l.amount > 0n) flows.push({ asset: r.executorId, ...l, receiptId: r.id })
      }
    }
  }
  return flows
}

/** asset → account → net change (received minus sent). */
export function balanceChanges(flows: readonly Flow[]): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>()
  const add = (asset: string, account: string | null, delta: bigint) => {
    if (!account) return
    const m = out.get(asset) ?? new Map<string, bigint>()
    m.set(account, (m.get(account) ?? 0n) + delta)
    out.set(asset, m)
  }
  for (const f of flows) {
    add(f.asset, f.to, f.amount)
    add(f.asset, f.from, -f.amount)
  }
  return out
}

// ─── trades ─────────────────────────────────────────────────────────────────

export interface Leg {
  /** 'near' covers native NEAR and wrapped NEAR together. */
  asset: string
  amount: bigint
}

export interface Trade {
  account: string
  side: 'buy' | 'sell'
  token: string
  /** Tokens received (buy) or sent (sell), net of any refund. */
  amount: bigint
  /** What the account gave up in the same transaction. */
  paid: Leg[]
  /** What else it got (for a sell, the proceeds). */
  received: Leg[]
}

/** Net change of one account, with wNEAR folded into 'near'. Storage and security deposits left out. */
export function accountLegs(flows: readonly Flow[], account: string, wrapContract: string): Map<string, bigint> {
  const changes = balanceChanges(flows.filter((f) => f.kind !== 'storage' && f.kind !== 'security'))
  const legs = new Map<string, bigint>()
  for (const [asset, byAccount] of changes) {
    const delta = byAccount.get(account) ?? 0n
    if (delta === 0n) continue
    const key = asset === wrapContract ? 'near' : asset
    legs.set(key, (legs.get(key) ?? 0n) + delta)
  }
  for (const [k, v] of legs) if (v === 0n) legs.delete(k)
  return legs
}

/**
 * Buys and sells of `token` by the people who started the transaction. Only
 * initiators count, so pools and routers moving tokens in between never look like
 * buyers. A buy needs the account to end with more `token` AND to have given
 * something up; tokens that simply arrived (a transfer, a refund) are not trades.
 */
export function detectTrades(tx: NormalizedTx, token: string, options: FlowOptions): Trade[] {
  const flows = flowsOf(tx, options)
  const trades: Trade[] = []
  for (const account of tx.initiators) {
    const legs = accountLegs(flows, account, options.wrapContract)
    const delta = legs.get(token) ?? 0n
    if (delta === 0n) continue
    legs.delete(token)
    const paid = [...legs].filter(([, v]) => v < 0n).map(([asset, v]) => ({ asset, amount: -v }))
    const received = [...legs].filter(([, v]) => v > 0n).map(([asset, v]) => ({ asset, amount: v }))
    if (delta > 0n && paid.length) trades.push({ account, side: 'buy', token, amount: delta, paid, received })
    else if (delta < 0n && received.length) trades.push({ account, side: 'sell', token, amount: -delta, paid, received })
  }
  return trades
}
