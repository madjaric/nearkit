// Fake NEAR network for the real-mode e2e suite. Every request the page makes to
// an external host is answered here (JSON-RPC, FastNEAR discovery, NearBlocks,
// Rhea's testnet router) or aborted, so the suite never touches a live network.
// Transaction outcomes are derived from what the scripted test wallet signed.

const NO_CODE = '11111111111111111111111111111111'
const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)))

export function createFakeNear({ accounts = {}, tokens = {} } = {}) {
  const state = {
    accounts: new Map(Object.entries(accounts)),
    tokens: new Map(Object.entries(tokens).map(([id, t]) => [id, { ...t, balances: new Map(Object.entries(t.balances ?? {})), registered: new Set(t.registered ?? []) }])),
    /** hash → { signerId, tx }, filled from the page's signed log. */
    signed: new Map(),
    /** 'success' | 'fail' for the next confirmations. */
    outcome: 'success',
    external: [],
  }

  const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
  const rpcErr = (id, name, data) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error', data } })

  function call(contract, method, args) {
    const t = state.tokens.get(contract)
    if (!t) return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
    switch (method) {
      case 'ft_metadata':
        return { result: { spec: 'ft-1.0.0', name: t.name ?? t.symbol, symbol: t.symbol, decimals: t.decimals, icon: null } }
      case 'ft_balance_of':
        return { result: String(t.balances.get(args.account_id) ?? '0') }
      case 'ft_total_supply':
        return { result: String([...t.balances.values()].reduce((a, b) => a + BigInt(b), 0n)) }
      case 'storage_balance_bounds':
        return { result: { min: t.boundsMin, max: t.boundsMin } }
      case 'storage_balance_of':
        return { result: t.registered.has(args.account_id) ? { total: t.boundsMin, available: '0' } : null }
      default:
        return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
    }
  }

  function outcomeFor(hash) {
    const hit = state.signed.get(hash)
    if (!hit) return null
    const { signerId, tx } = hit
    const last = tx.actions.at(-1)
    const base = {
      final_execution_status: 'FINAL',
      transaction: { hash, signer_id: signerId, receiver_id: tx.receiverId },
      transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: signerId, status: {} } },
      receipts_outcome: [],
    }
    if (state.outcome === 'fail') {
      return {
        ...base,
        status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account alice is not registered' } } } } },
      }
    }
    const value = last?.type === 'FunctionCall' && last.params.methodName === 'ft_transfer_call' ? btoa(JSON.stringify(String(last.params.args.amount))) : ''
    return { ...base, status: { SuccessValue: value } }
  }

  function rpc(body) {
    const { id, method, params = {} } = body
    if (method === 'query' && params.request_type === 'view_account') {
      const a = state.accounts.get(params.account_id)
      if (!a) return rpcErr(id, 'UNKNOWN_ACCOUNT', `account ${params.account_id} does not exist while viewing`)
      return rpcOk(id, {
        amount: a.amount,
        locked: '0',
        code_hash: a.code ? 'Code1111111111111111111111111111' : NO_CODE,
        storage_usage: a.storageUsage ?? 182,
        block_height: 1,
        block_hash: 'h',
      })
    }
    if (method === 'query' && params.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(params.args_base64 ?? '', 'base64').toString() || '{}')
      const r = call(params.account_id, params.method_name, args)
      return rpcOk(id, r.error ? { error: r.error, logs: [], block_height: 1, block_hash: 'h' } : { result: enc(r.result), logs: [], block_height: 1, block_hash: 'h' })
    }
    if (method === 'query' && params.request_type === 'view_access_key_list') return rpcOk(id, { keys: [], block_height: 1, block_hash: 'h' })
    if (method === 'EXPERIMENTAL_tx_status') {
      const result = outcomeFor(params.tx_hash)
      return result ? rpcOk(id, result) : rpcErr(id, 'UNKNOWN_TRANSACTION', 'Transaction not found')
    }
    return rpcErr(id, 'UNSUPPORTED', `fake network has no ${method}`)
  }

  function findPath(url) {
    const amountIn = url.searchParams.get('amountIn')
    const tokenIn = url.searchParams.get('tokenIn')
    const tokenOut = url.searchParams.get('tokenOut')
    // A fixed 4.039 USDT per NEAR pool, the rate of the real testnet pool 1352 on 2026-09-28.
    const out = (BigInt(amountIn) * 4039n) / 1000n
    const min = (out * 995n) / 1000n
    return {
      result_code: 0,
      result_message: '',
      result_data: {
        routes: [
          {
            pools: [{ pool_id: '1352', token_in: tokenIn, token_out: tokenOut, amount_in: amountIn, amount_out: '0', min_amount_out: String(min) }],
            amount_in: amountIn,
            min_amount_out: String(min),
            amount_out: '0',
          },
        ],
        contract_in: tokenIn,
        contract_out: tokenOut,
        amount_in: amountIn,
        amount_out: String(out),
      },
    }
  }

  /** Install on a Playwright page: local traffic passes, everything else is faked or aborted. */
  async function install(page) {
    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
      if (/(^|\.)rpc\.fastnear\.com$|intea\.rs$|drpc\.org$/.test(url.hostname) && req.method() === 'POST') {
        const body = JSON.parse(req.postData() ?? '{}')
        if (body.method === 'EXPERIMENTAL_tx_status') {
          const log = await page.evaluate(() => window.__NEARKIT_E2E_SIGNED__ ?? [])
          for (const s of log) s.hashes.forEach((h, i) => state.signed.set(h, { signerId: s.signerId, tx: s.transactions[i] }))
        }
        return json(rpc(body))
      }
      if (url.hostname.endsWith('api.fastnear.com') && url.pathname.endsWith('/ft')) {
        const account = decodeURIComponent(url.pathname.split('/')[3] ?? '')
        const held = [...state.tokens.entries()].flatMap(([contract, t]) =>
          BigInt(t.balances.get(account) ?? '0') > 0n ? [{ contract_id: contract, balance: String(t.balances.get(account)) }] : [],
        )
        return json({ account_id: account, tokens: held })
      }
      if (url.hostname === 'smartroutertest.refburrow.top') return json(findPath(url))
      if (url.hostname.endsWith('nearblocks.io')) {
        if (url.pathname.endsWith('/holders/count')) return json({ holders: [{ count: '872' }] })
        if (url.pathname.includes('/holders')) return json({ holders: [{ account: 'ref-finance-101.testnet', amount: '40000000000000000000000000' }] })
        if (url.pathname.startsWith('/v1/account/')) return json({ account: [{ created: { block_timestamp: 1700000000000000000 } }] })
      }
      state.external.push(req.url())
      return route.abort()
    })
  }

  return { state, install }
}
