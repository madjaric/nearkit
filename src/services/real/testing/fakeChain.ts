import type { WalletAdapter, WalletSession } from '@/services/near/wallet'
import type { RpcTxResult } from '@/services/near/rpc'
import { base58Decode } from '@/lib/encoding'
import { deserializeSignedTransaction, transactionHash, type NearTransaction } from '@/services/near/transaction'
import { blockHashOf, createRuntime, heightOfBlock, implicitKeyOf, TxRejection, type FakeAccount, type RuntimeState } from './fakeRuntime'

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

export interface FakeDclPool {
  tokenX: string
  tokenY: string
  fee: number
  liquidity: bigint
  /** Output for an input through this pool, after its fee. */
  rate: (tokenIn: string, amountIn: bigint) => bigint
  state?: 'Running' | 'Paused'
}

export interface FakeChainOptions {
  /**
   * `global`: the account runs a shared global contract (NEP-591) instead of local code.
   * `keys`: access keys by public key (`ed25519:…`), 'full' or a function-call key.
   */
  accounts?: Record<string, { amount: bigint; storageUsage?: number; code?: boolean; global?: string; keys?: Record<string, 'full' | 'function-call'> }>
  tokens?: Record<string, Omit<FakeToken, 'balances' | 'registered'> & { balances?: Record<string, bigint>; registered?: string[] }>
  aggregator?: { contract: string; whitelist: string[]; protocolPpm: number; registered?: Record<string, string[]> }
  /** Rhea's classic exchange for signed swaps (fakeRuntime.ts): output per input at this rate. */
  exchange?: { contract: string; rate: (tokenIn: string, tokenOut: string, amountIn: bigint) => bigint }
  /** A DCL v2 contract with these pools (fakeRuntime.ts): `get_pool`, `quote` and swaps by `ft_transfer_call`. */
  dcl?: { contract: string; pools: Record<string, FakeDclPool> }
  wrapContract?: string
  /** Blocks a transaction stays valid after its anchor block (86,400 on NEAR). */
  validity?: number
  height?: number
}

/**
 * How a sent transaction behaves: 'apply' (normal), 'timeout' (it lands, but the RPC
 * answers TIMEOUT_ERROR), 'drop' (it never lands and the RPC answers TIMEOUT_ERROR),
 * 'transport' (it never lands and the node can't be reached), 'hidden' (it lands,
 * the RPC times out, and the RPC's status lookup doesn't return it until `reveal()`:
 * a lagging index).
 */
export type SendMode = 'apply' | 'timeout' | 'drop' | 'transport' | 'hidden'

const NO_CODE = '11111111111111111111111111111111'

export interface Recorded {
  url: string
  method?: string
  params?: unknown
}

export function createFakeChain(options: FakeChainOptions = {}) {
  const accounts = new Map<string, FakeAccount>(Object.entries(options.accounts ?? {}).map(([id, a]) => [id, { ...a, keys: a.keys ? { ...a.keys } : undefined }]))
  const tokens = new Map<string, FakeToken>(
    Object.entries(options.tokens ?? {}).map(([id, t]) => [id, { ...t, balances: new Map(Object.entries(t.balances ?? {})), registered: new Set(t.registered ?? []) }]),
  )
  const agg = options.aggregator ? { ...options.aggregator, registered: new Map(Object.entries(options.aggregator.registered ?? {}).map(([u, ts]) => [u, new Set(ts)])) } : null
  const txs = new Map<string, RpcTxResult>()
  const requests: Recorded[] = []
  const http = new Map<string, (url: URL, body: unknown) => unknown>()
  const nonces = new Map<string, bigint>()
  for (const [id, a] of accounts) for (const key of Object.keys(a.keys ?? {})) nonces.set(`${id}\u0000${key}`, 1n)
  const state: RuntimeState = {
    accounts,
    tokens,
    nonces,
    txs,
    height: { value: options.height ?? 200_000 },
    validity: options.validity ?? 86_400,
    wrapContract: options.wrapContract ?? 'wrap.testnet',
    exchange: options.exchange ?? null,
    dcl: options.dcl ? { contract: options.dcl.contract, pools: new Map(Object.entries(options.dcl.pools)) } : null,
    refunds: { lag: 0, pending: [] },
  }
  const runtime = createRuntime(state)
  let sendMode: (tx: NearTransaction) => SendMode = () => 'apply'
  const sent: { hash: string; mode: SendMode; tx: NearTransaction }[] = []
  const hidden = new Set<string>()
  /** Shard layout and delayed-receipt backlog per shard (congest()); none: the chain doesn't answer those calls. */
  let congestion: { layout: unknown; backlog: Map<number, bigint> } | null = null
  const header = (height: number) => ({ height, hash: blockHashOf(height), prev_hash: blockHashOf(height - 1), timestamp: height * 1_000_000_000 })

  async function sendTx(id: unknown, signedBase64: string): Promise<Response> {
    let decoded: NearTransaction | null = null
    try {
      decoded = deserializeSignedTransaction(Uint8Array.from(atob(signedBase64), (c) => c.charCodeAt(0))).transaction
    } catch {
      return rpcError(id, 'INVALID_TRANSACTION', 'malformed transaction')
    }
    const mode = sendMode(decoded)
    if (mode === 'drop' || mode === 'transport') {
      sent.push({ hash: await transactionHash(decoded), mode, tx: decoded })
      if (mode === 'transport') return json({ error: 'bad gateway' }, 502)
      return rpcError(id, 'TIMEOUT_ERROR', 'Timeout')
    }
    try {
      const { hash, result, tx } = await runtime.execute(signedBase64)
      sent.push({ hash, mode, tx })
      if (mode === 'hidden') hidden.add(hash)
      if (mode === 'timeout' || mode === 'hidden') return rpcError(id, 'TIMEOUT_ERROR', 'Timeout')
      return json({ jsonrpc: '2.0', id, result })
    } catch (e) {
      if (e instanceof TxRejection) return rpcError(id, 'INVALID_TRANSACTION', e.kind)
      throw e
    }
  }

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
    if (state.dcl && contract === state.dcl.contract) {
      const pools = state.dcl.pools
      switch (method) {
        case 'get_pool': {
          const p = pools.get(String(args.pool_id))
          if (!p) return { result: null }
          return { result: { pool_id: args.pool_id, token_x: p.tokenX, token_y: p.tokenY, fee: p.fee, liquidity: p.liquidity.toString(), state: p.state ?? 'Running' } }
        }
        case 'quote': {
          const ids = Array.isArray(args.pool_ids) ? (args.pool_ids as string[]) : []
          let current = String(args.input_token)
          let amount = BigInt(String(args.input_amount))
          for (const id of ids) {
            const p = pools.get(id)
            if (!p) return { error: `wasm execution failed with error: Smart contract panicked: E405_POOL_NOT_EXIST ${id}` }
            const next = current === p.tokenX ? p.tokenY : current === p.tokenY ? p.tokenX : null
            if (!next) return { error: 'wasm execution failed with error: Smart contract panicked: E200_INVALID_PATH' }
            amount = p.rate(current, amount)
            current = next
          }
          if (current !== String(args.output_token)) return { error: 'wasm execution failed with error: Smart contract panicked: E200_INVALID_PATH' }
          return { result: { amount: amount.toString(), tag: args.tag ?? null } }
        }
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
      runtime.read(String(params.account_id))
      const a = accounts.get(String(params.account_id))
      if (!a) return rpcError(id, 'UNKNOWN_ACCOUNT', `account ${String(params.account_id)} does not exist while viewing`)
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          amount: a.amount.toString(),
          locked: '0',
          code_hash: a.code ? 'Code1111111111111111111111111111' : NO_CODE,
          ...(a.global ? { global_contract_hash: a.global } : {}),
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
    if (method === 'query' && params.request_type === 'view_access_key') {
      const a = accounts.get(String(params.account_id))
      if (!a) return rpcError(id, 'UNKNOWN_ACCOUNT', `account ${String(params.account_id)} does not exist while viewing`)
      const kind = a.keys?.[String(params.public_key)]
      if (!kind) return rpcError(id, 'UNKNOWN_ACCESS_KEY', `access key ${String(params.public_key)} does not exist while viewing`)
      const permission = kind === 'full' ? 'FullAccess' : { FunctionCall: { allowance: null, receiver_id: 'app.near', method_names: [] } }
      const nonce = Number(nonces.get(`${String(params.account_id)}\u0000${String(params.public_key)}`) ?? 1n)
      return json({ jsonrpc: '2.0', id, result: { nonce, permission, block_height: state.height.value, block_hash: blockHashOf(state.height.value) } })
    }
    if (method === 'query' && params.request_type === 'view_access_key_list') {
      const a = accounts.get(String(params.account_id))
      const keys = Object.entries(a?.keys ?? {}).map(([public_key, kind]) => ({
        public_key,
        access_key: { nonce: Number(nonces.get(`${String(params.account_id)}\u0000${public_key}`) ?? 1n), permission: kind === 'full' ? 'FullAccess' : { FunctionCall: {} } },
      }))
      return json({ jsonrpc: '2.0', id, result: { keys, block_height: state.height.value, block_hash: blockHashOf(state.height.value) } })
    }
    if (method === 'EXPERIMENTAL_tx_status' || method === 'tx') {
      const tx = hidden.has(String(params.tx_hash)) ? undefined : txs.get(String(params.tx_hash))
      return tx ? json({ jsonrpc: '2.0', id, result: tx }) : rpcError(id, 'UNKNOWN_TRANSACTION', 'Transaction not found')
    }
    if (method === 'block') {
      const want = params.block_id
      if (want === undefined) return json({ jsonrpc: '2.0', id, result: { header: header(state.height.value) } })
      const height = typeof want === 'number' ? want : typeof want === 'string' ? heightOfBlock(base58Decode(want) ?? new Uint8Array()) : null
      if (typeof height !== 'number' || height < 1 || height > state.height.value) return rpcError(id, 'UNKNOWN_BLOCK', 'Block not found')
      return json({ jsonrpc: '2.0', id, result: { header: header(height) } })
    }
    if (method === 'EXPERIMENTAL_genesis_config') return json({ jsonrpc: '2.0', id, result: { transaction_validity_period: state.validity } })
    if (method === 'EXPERIMENTAL_protocol_config' && congestion) return json({ jsonrpc: '2.0', id, result: { shard_layout: congestion.layout } })
    if (method === 'chunk' && congestion) {
      const shard = Number(params.shard_id)
      const backlog = congestion.backlog.get(shard) ?? 0n
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          header: {
            shard_id: shard,
            height_included: params.block_id,
            congestion_info: { delayed_receipts_gas: backlog.toString(), buffered_receipts_gas: '0', receipt_bytes: 0, allowed_shard: 0 },
          },
          transactions: [],
          receipts: [],
        },
      })
    }
    if (method === 'send_tx') return sendTx(id, String(params.signed_tx_base64 ?? ''))
    if (method === 'broadcast_tx_commit' && Array.isArray(body.params)) return sendTx(id, String(body.params[0] ?? ''))
    return rpcError(id, 'UNSUPPORTED', `fake chain has no ${String(method)}`)
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    // Routes first (GET or POST, e.g. FastNEAR's transaction index), then JSON-RPC.
    for (const [prefix, handler] of http) {
      if (!url.href.startsWith(prefix)) continue
      requests.push({ url: url.href })
      const answer = handler(url, init?.body ? (JSON.parse(String(init.body)) as unknown) : null)
      return answer instanceof Response ? answer : json(answer)
    }
    if (init?.method === 'POST' && init.body) {
      const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown }
      requests.push({ url: url.href, method: body.method, params: body.params })
      return handleRpc(body as { id?: unknown; method?: string; params?: Record<string, unknown> })
    }
    requests.push({ url: url.href })
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
    /** The DCL contract's pools, for tests that add liquidity or pause a pool. */
    dclPools: state.dcl?.pools ?? null,
    /** Answer requests (GET or POST) whose URL starts with this prefix: a value as JSON, or a Response as is. */
    route(prefix: string, handler: (url: URL, body: unknown) => unknown) {
      http.set(prefix, handler)
    },
    /** Make a transaction's final status available. */
    settle(hash: string, result: RpcTxResult) {
      txs.set(hash, result)
    },
    /** Every signed transaction received, with how it was handled. */
    sent,
    /** How the next sends behave (see SendMode). */
    onSend(mode: SendMode | ((tx: NearTransaction) => SendMode)) {
      sendMode = typeof mode === 'function' ? mode : () => mode
    },
    /** The chain reads this shard layout and these delayed-receipt backlogs (gas) per shard. */
    congest(layout: unknown, backlog: Record<number, bigint>) {
      congestion = { layout, backlog: new Map(Object.entries(backlog).map(([k, v]) => [Number(k), v])) }
    },
    /** The lagging index catches up: hidden transactions become visible. */
    reveal() {
      hidden.clear()
    },
    /** Gas refunds land only after the signer's balance was read `reads` more times (0: at once). */
    lateRefunds(reads: number) {
      state.refunds.lag = reads
    },
    height: () => state.height.value,
    advance(blocks: number) {
      state.height.value += blocks
    },
    /** NEAR arrives from outside (a deposit); creates an implicit account like the chain does. */
    fund(accountId: string, yocto: bigint) {
      const a = accounts.get(accountId)
      if (a) {
        a.amount += yocto
        return
      }
      const key = implicitKeyOf(accountId)
      accounts.set(accountId, { amount: yocto, keys: key ? { [key]: 'full' } : {} })
      if (key) nonces.set(`${accountId}\u0000${key}`, BigInt(state.height.value) * 1_000_000n)
    },
    keysOf: (accountId: string) => Object.keys(accounts.get(accountId)?.keys ?? {}),
    rpcCalls: (method?: string) => requests.filter((r) => r.method && (!method || r.method === method)),
  }
}

export type FakeChain = ReturnType<typeof createFakeChain>

/** Wallet double: a fixed session; signing records the transactions and returns hashes. */
export function fakeWallet(
  session: WalletSession | null,
  onSign?: (signerId: string, transactions: unknown[]) => unknown[] | Promise<unknown[]>,
  messageSigner?: () => Promise<{ publicKey: string; signature: string }>,
) {
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
    signMessage: async (signerId) => {
      if (!messageSigner) throw new Error('User rejected the request')
      return { accountId: signerId, ...(await messageSigner()) }
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
