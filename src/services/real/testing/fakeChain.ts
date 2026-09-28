import type { WalletAdapter, WalletSession } from '@/services/near/wallet'
import type { RpcTxResult } from '@/services/near/rpc'

/**
 * Test double for everything NearKit reads over HTTP: NEAR JSON-RPC (accounts,
 * NEP-141/145 views, Rhea's aggregator views, transaction status), FastNEAR
 * discovery, price feeds and Rhea's quote servers. Only tests import it.
 */

export interface FakeToken {
  symbol: string
  name?: string
  decimals: number
  balances: Map<string, bigint>
  registered: Set<string>
  /** `storage_balance_bounds.min`; null = no NEP-145 on this contract. */
  boundsMin: bigint | null
  totalSupply?: bigint
}

export interface FakeChainOptions {
  accounts?: Record<string, { amount: bigint; storageUsage?: number; code?: boolean }>
  tokens?: Record<string, Omit<FakeToken, 'balances' | 'registered'> & { balances?: Record<string, bigint>; registered?: string[] }>
  aggregator?: { contract: string; whitelist: string[]; protocolPpm: number; registered?: Record<string, string[]> }
}

const NO_CODE = '11111111111111111111111111111111'

export interface Recorded {
  url: string
  method?: string
  params?: unknown
}

export function createFakeChain(options: FakeChainOptions = {}) {
  const accounts = new Map(Object.entries(options.accounts ?? {}))
  const tokens = new Map<string, FakeToken>(
    Object.entries(options.tokens ?? {}).map(([id, t]) => [id, { ...t, balances: new Map(Object.entries(t.balances ?? {})), registered: new Set(t.registered ?? []) }]),
  )
  const agg = options.aggregator ? { ...options.aggregator, registered: new Map(Object.entries(options.aggregator.registered ?? {}).map(([u, ts]) => [u, new Set(ts)])) } : null
  const txs = new Map<string, RpcTxResult>()
  const requests: Recorded[] = []
  const http = new Map<string, (url: URL) => unknown>()

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const rpcError = (id: unknown, name: string, message: string) =>
    json({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error', data: message } })
  const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)))

  function callFunction(contract: string, method: string, args: Record<string, unknown>): { result?: unknown; error?: string } {
    const token = tokens.get(contract)
    if (token) {
      switch (method) {
        case 'ft_metadata':
          return { result: { spec: 'ft-1.0.0', name: token.name ?? token.symbol, symbol: token.symbol, decimals: token.decimals, icon: null } }
        case 'ft_balance_of':
          return { result: (token.balances.get(String(args.account_id)) ?? 0n).toString() }
        case 'ft_total_supply':
          return { result: (token.totalSupply ?? [...token.balances.values()].reduce((a, b) => a + b, 0n)).toString() }
        case 'storage_balance_bounds':
          return token.boundsMin === null
            ? { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
            : { result: { min: token.boundsMin.toString(), max: token.boundsMin.toString() } }
        case 'storage_balance_of':
          if (token.boundsMin === null) return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
          return { result: token.registered.has(String(args.account_id)) ? { total: token.boundsMin.toString(), available: '0' } : null }
      }
    }
    if (agg && contract === agg.contract) {
      switch (method) {
        case 'query_white_list_fee_tokens':
          return { result: agg.whitelist }
        case 'query_protocol_fee_rate':
          return { result: String(agg.protocolPpm) }
        case 'query_user_tokens_registered': {
          const set = agg.registered.get(String(args.user)) ?? new Set<string>()
          return { result: (args.tokens as string[]).map((t) => set.has(t)) }
        }
      }
    }
    return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
  }

  async function handleRpc(body: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<Response> {
    const { id, method, params = {} } = body
    if (method === 'query' && params.request_type === 'view_account') {
      const a = accounts.get(String(params.account_id))
      if (!a) return rpcError(id, 'UNKNOWN_ACCOUNT', `account ${String(params.account_id)} does not exist while viewing`)
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          amount: a.amount.toString(),
          locked: '0',
          code_hash: a.code ? 'Code1111111111111111111111111111' : NO_CODE,
          storage_usage: a.storageUsage ?? 182,
          block_height: 1,
          block_hash: 'h',
        },
      })
    }
    if (method === 'query' && params.request_type === 'call_function') {
      const args = JSON.parse(atob(String(params.args_base64 ?? ''))) as Record<string, unknown>
      const r = callFunction(String(params.account_id), String(params.method_name), args)
      return json({
        jsonrpc: '2.0',
        id,
        result: r.error ? { error: r.error, logs: [], block_height: 1, block_hash: 'h' } : { result: bytes(r.result), logs: [], block_height: 1, block_hash: 'h' },
      })
    }
    if (method === 'query' && params.request_type === 'view_access_key_list') {
      return json({ jsonrpc: '2.0', id, result: { keys: [], block_height: 1, block_hash: 'h' } })
    }
    if (method === 'EXPERIMENTAL_tx_status') {
      const tx = txs.get(String(params.tx_hash))
      return tx ? json({ jsonrpc: '2.0', id, result: tx }) : rpcError(id, 'UNKNOWN_TRANSACTION', 'Transaction not found')
    }
    return rpcError(id, 'UNSUPPORTED', `fake chain has no ${String(method)}`)
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (init?.method === 'POST' && init.body) {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown }
      requests.push({ url: url.href, method: body.method, params: body.params })
      return handleRpc(body as { id?: unknown; method?: string; params?: Record<string, unknown> })
    }
    requests.push({ url: url.href })
    for (const [prefix, handler] of http) if (url.href.startsWith(prefix)) return json(handler(url))
    if (url.pathname.endsWith('/ft') && url.pathname.startsWith('/v1/account/')) {
      const account = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      const held = [...tokens.entries()].flatMap(([contract, t]) =>
        (t.balances.get(account) ?? 0n) > 0n ? [{ contract_id: contract, balance: (t.balances.get(account) ?? 0n).toString() }] : [],
      )
      return json({ account_id: account, tokens: held })
    }
    return json({ error: 'not found' }, 404)
  }

  return {
    fetch: fetchImpl,
    requests,
    accounts,
    tokens,
    aggregator: agg,
    /** Answer GETs that start with this prefix. */
    route(prefix: string, handler: (url: URL) => unknown) {
      http.set(prefix, handler)
    },
    /** Make a transaction's final status available. */
    settle(hash: string, result: RpcTxResult) {
      txs.set(hash, result)
    },
    rpcCalls: (method?: string) => requests.filter((r) => r.method && (!method || r.method === method)),
  }
}

export type FakeChain = ReturnType<typeof createFakeChain>

/** Wallet double: a fixed session; signing records the transactions and returns hashes. */
export function fakeWallet(session: WalletSession | null, onSign?: (signerId: string, transactions: unknown[]) => unknown[] | Promise<unknown[]>) {
  const signed: { signerId: string; transactions: unknown[] }[] = []
  let current = session
  let counter = 0
  const adapter: WalletAdapter = {
    kind: 'e2e-test',
    listWallets: async () => [{ id: 'fake', name: 'Fake Wallet', icon: null, description: '', website: '', injected: false }],
    connect: async () => {
      if (!current) throw new Error('User rejected the connection')
      return current
    },
    restore: async () => current,
    session: async () => current,
    disconnect: async () => {
      current = null
    },
    signAndSendTransactions: async (signerId, transactions) => {
      signed.push({ signerId, transactions })
      if (onSign) return onSign(signerId, transactions)
      return transactions.map(() => ({ transaction: { hash: `HASH${(counter += 1)}`, signer_id: signerId } }))
    },
  }
  return { adapter, signed, setSession: (s: WalletSession | null) => (current = s) }
}

/** A successful final outcome for a planned transaction. */
export function successOutcome(hash: string, signerId: string, receiverId: string, successValue = ''): RpcTxResult {
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: successValue },
    transaction: { hash, signer_id: signerId, receiver_id: receiverId },
    transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: signerId, status: {} } },
    receipts_outcome: [],
  }
}
