/**
 * Minimal typed NEAR JSON-RPC client over `fetch`.
 *
 * - POST JSON-RPC 2.0, one request per call (FastNEAR rejects batches).
 * - Fails over, in configured order, on transport problems: network errors,
 *   non-2xx HTTP, timeouts, JSON-RPC rate limits (-429) and INTERNAL_ERROR.
 *   An endpoint that just failed is asked last for `cooldownMs` (a public node
 *   that rate-limits can take a second or two to say so, on every call), and
 *   still asked when the others fail.
 * - Identical requests in flight share one request: a read many callers make
 *   at the same moment (the same pool for ten wallets) is made once. Nothing is
 *   cached: the next identical request, once that one is answered, asks again.
 * - Never fails over on semantic answers (unknown account, parse errors):
 *   another node would give the same answer.
 * - `call_function` contract errors arrive inside `result.error` and are thrown.
 */

export type Finality = 'optimistic' | 'near-final' | 'final'
export type WaitUntil = 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'INCLUDED_FINAL' | 'EXECUTED' | 'FINAL'

export type RpcErrorKind = 'transport' | 'handler' | 'contract'

export class RpcError extends Error {
  readonly kind: RpcErrorKind
  /** JSON-RPC `cause.name`, e.g. UNKNOWN_ACCOUNT, UNKNOWN_TRANSACTION, TIMEOUT_ERROR. */
  readonly causeName: string | undefined
  readonly data: unknown
  constructor(kind: RpcErrorKind, message: string, causeName?: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.kind = kind
    this.causeName = causeName
    this.data = data
  }
}

export interface ViewAccountResult {
  amount: string
  locked: string
  code_hash: string
  storage_usage: number
  global_contract_hash?: string
  global_contract_account_id?: string
  block_height: number
  block_hash: string
}

export interface RpcOutcome {
  logs: string[]
  receipt_ids: string[]
  gas_burnt: number
  tokens_burnt: string
  executor_id: string
  status: unknown
}

export interface RpcOutcomeWithId {
  id: string
  block_hash?: string
  outcome: RpcOutcome
}

/** A receipt from `EXPERIMENTAL_tx_status`: who sent what to whom. */
export interface RpcReceipt {
  receipt_id: string
  predecessor_id: string
  receiver_id: string
  receipt: { Action?: { actions: unknown[] } } & Record<string, unknown>
}

export interface RpcTxResult {
  final_execution_status?: string
  status: unknown
  transaction: { hash: string; signer_id: string; receiver_id: string; actions?: unknown[] }
  transaction_outcome: RpcOutcomeWithId
  receipts_outcome: RpcOutcomeWithId[]
  receipts?: RpcReceipt[]
}

export interface ProtocolConfigSubset {
  runtime_config: {
    storage_amount_per_byte: string
    transaction_costs?: unknown
    wasm_config?: { limit_config?: { max_total_prepaid_gas?: number; max_actions_per_receipt?: number } }
  }
}

export interface RpcClient {
  readonly urls: readonly string[]
  call<T>(method: string, params: unknown): Promise<T>
  viewAccount(accountId: string, finality?: Finality): Promise<ViewAccountResult>
  viewFunction<T>(contractId: string, methodName: string, args?: Record<string, unknown>, finality?: Finality): Promise<T | null>
  txStatus(hash: string, senderId: string, waitUntil?: WaitUntil): Promise<RpcTxResult>
}

export interface RpcClientOptions {
  urls: readonly string[]
  fetch?: typeof fetch
  /** Per-attempt timeout. */
  timeoutMs?: number
  /** How long an endpoint that just failed is asked last (RPC_COOLDOWN_MS). */
  cooldownMs?: number
  now?: () => number
}

/** How long an endpoint that just failed (rate limit, error, timeout) is asked after the others. */
export const RPC_COOLDOWN_MS = 15_000

// ─── encoding ───────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function encodeArgs(args: Record<string, unknown>): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(args)))
}

export function decodeBase64Json(value: string): unknown {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Decode a `call_function` byte-array result; empty output is `null`. */
function decodeResultBytes(result: unknown): unknown {
  if (!Array.isArray(result) || result.length === 0) return null
  const text = new TextDecoder().decode(Uint8Array.from(result as number[]))
  return text.trim() === '' ? null : JSON.parse(text)
}

// ─── client ─────────────────────────────────────────────────────────────────

interface JsonRpcErrorBody {
  name?: string
  code?: number
  message?: string
  data?: unknown
  cause?: { name?: string; info?: unknown }
}

function isRetryable(error: JsonRpcErrorBody): boolean {
  if (error.code === -429) return true
  if (typeof error.message === 'string' && /rate limit/i.test(error.message)) return true
  return error.name === 'INTERNAL_ERROR'
}

let requestId = 0

export function createRpcClient({
  urls,
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 8000,
  cooldownMs = RPC_COOLDOWN_MS,
  now = Date.now,
}: RpcClientOptions): RpcClient {
  /** Until when each endpoint that just failed is asked last. */
  const coolingUntil = new Map<string, number>()
  /** The configured order, with endpoints still cooling down moved last (the soonest to recover first). */
  const order = (): string[] => {
    const t = now()
    const cooling = (u: string) => (coolingUntil.get(u) ?? 0) > t
    return [...urls.filter((u) => !cooling(u)), ...urls.filter(cooling).sort((a, b) => (coolingUntil.get(a) ?? 0) - (coolingUntil.get(b) ?? 0))]
  }
  /** Requests in flight, by method and params: identical ones share the answer. */
  const inFlight = new Map<string, Promise<unknown>>()

  async function attempt(url: string, body: string): Promise<{ ok: true; result: unknown } | { ok: false; retry: RpcError } | { ok: false; fatal: RpcError }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal })
      if (!res.ok) return { ok: false, retry: new RpcError('transport', `${url} answered HTTP ${res.status}`) }
      const json = (await res.json()) as { result?: unknown; error?: JsonRpcErrorBody }
      if (json.error) {
        const e = json.error
        const message = [e.message, typeof e.data === 'string' ? e.data : ''].filter(Boolean).join(': ') || 'RPC error'
        if (isRetryable(e)) return { ok: false, retry: new RpcError('transport', `${url}: ${message}`, e.cause?.name, e) }
        return { ok: false, fatal: new RpcError('handler', message, e.cause?.name ?? e.name, e) }
      }
      return { ok: true, result: json.result }
    } catch (e) {
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : e instanceof Error ? e.message : String(e)
      return { ok: false, retry: new RpcError('transport', `${url}: ${reason}`) }
    } finally {
      clearTimeout(timer)
    }
  }

  async function send(method: string, params: unknown): Promise<unknown> {
    requestId += 1
    const body = JSON.stringify({ jsonrpc: '2.0', id: `nk-${requestId}`, method, params })
    const failures: string[] = []
    for (const url of order()) {
      const r = await attempt(url, body)
      if (r.ok) {
        coolingUntil.delete(url)
        return r.result
      }
      if ('fatal' in r) throw r.fatal
      coolingUntil.set(url, now() + cooldownMs)
      failures.push(r.retry.message)
    }
    throw new RpcError('transport', urls.length ? `All RPC endpoints failed (${failures.join('; ')})` : 'No RPC endpoint configured')
  }

  async function call<T>(method: string, params: unknown): Promise<T> {
    const key = JSON.stringify([method, params])
    let pending = inFlight.get(key)
    if (!pending) {
      pending = send(method, params).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return (await pending) as T
  }

  return {
    urls,
    call,
    viewAccount: (accountId, finality = 'optimistic') => call<ViewAccountResult>('query', { request_type: 'view_account', finality, account_id: accountId }),
    async viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}, finality: Finality = 'optimistic') {
      const result = await call<{ result?: unknown; error?: string }>('query', {
        request_type: 'call_function',
        finality,
        account_id: contractId,
        method_name: methodName,
        args_base64: encodeArgs(args),
      })
      if (result && typeof result.error === 'string') throw new RpcError('contract', result.error)
      return decodeResultBytes(result?.result) as T | null
    },
    txStatus: (hash, senderId, waitUntil = 'FINAL') => call<RpcTxResult>('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: senderId, wait_until: waitUntil }),
  }
}
