// Fake NEAR network for the real-mode e2e suite. Every request the page makes to
// an external host is answered here (JSON-RPC, FastNEAR discovery, NearBlocks,
// Rhea's testnet router) or aborted, so the suite never touches a live network.
// Transaction outcomes are derived from what the scripted test wallet signed.

const NO_CODE = '11111111111111111111111111111111'
const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)))

export function createFakeNear({ accounts = {}, tokens = {}, dcl = null } = {}) {
  const state = {
    accounts: new Map(Object.entries(accounts)),
    tokens: new Map(Object.entries(tokens).map(([id, t]) => [id, { ...t, balances: new Map(Object.entries(t.balances ?? {})), registered: new Set(t.registered ?? []) }])),
    /** A DCL v2 exchange: `{ contract, pools: { 'x|y|fee': { tokenX, tokenY, fee, liquidity, rate(tokenIn, amountIn) } } }`. */
    dcl: dcl ? { contract: dcl.contract, pools: new Map(Object.entries(dcl.pools ?? {})) } : null,
    /** hash → { signerId, tx }, filled from the page's signed log. */
    signed: new Map(),
    /** 'success' | 'fail' for the next confirmations. */
    outcome: 'success',
    external: [],
  }

  const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
  const rpcErr = (id, name, data) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error', data } })

  /** Output of a path of DCL pools for an input, or null when the path does not connect. */
  function dclQuote(ids, tokenIn, amountIn) {
    let token = tokenIn
    let amount = amountIn
    for (const id of ids) {
      const p = state.dcl.pools.get(id)
      if (!p) return null
      const next = token === p.tokenX ? p.tokenY : token === p.tokenY ? p.tokenX : null
      if (!next) return null
      amount = p.rate(token, amount)
      token = next
    }
    return { token, amount }
  }

  /** The DCL contract's views, as dclv2 answers them: a pool's state (`null` when there is none) and a quote over pools. */
  function dclView(method, args) {
    if (method === 'get_pool') {
      const p = state.dcl.pools.get(String(args.pool_id))
      return { result: p ? { pool_id: args.pool_id, token_x: p.tokenX, token_y: p.tokenY, fee: p.fee, liquidity: String(p.liquidity), state: 'Running' } : null }
    }
    if (method === 'quote') {
      const out = dclQuote(Array.isArray(args.pool_ids) ? args.pool_ids : [], String(args.input_token), BigInt(String(args.input_amount)))
      if (!out || out.token !== String(args.output_token)) return { error: 'wasm execution failed with error: Smart contract panicked: E200_INVALID_PATH' }
      return { result: { amount: String(out.amount), tag: args.tag ?? null } }
    }
    return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
  }

  function call(contract, method, args) {
    if (state.dcl && contract === state.dcl.contract) return dclView(method, args)
    const t = state.tokens.get(contract)
    if (!t) return { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
    switch (method) {
      case 'ft_metadata':
        return { result: { spec: 'ft-1.0.0', name: t.name ?? t.symbol, symbol: t.symbol, decimals: t.decimals, icon: t.icon ?? null } }
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
    return { ...base, ...swapReceipts(hash, signerId, tx), status: { SuccessValue: value } }
  }

  /**
   * Receipts and logs of a classic Rhea swap, as the chain records them: wrap.testnet's
   * legacy logs for wrapping and sending, and the output token's NEP-141 transfer to the
   * signer (the route's minimum). Anything else keeps an empty receipt list.
   */
  const rpcAction = (a) => ({
    FunctionCall: { method_name: a.params.methodName, args: btoa(JSON.stringify(a.params.args)), gas: Number(a.params.gas), deposit: a.params.deposit },
  })
  const outcomeOf = (id, executor, logLines, children) => ({
    id,
    outcome: { logs: logLines, receipt_ids: children, gas_burnt: 1, tokens_burnt: '0', executor_id: executor, status: { SuccessValue: '' } },
  })

  /**
   * Receipts of a direct DCL swap, as dclv2 records them: the exchange's `swap` event, then the
   * output's transfer to the signer (the token's NEP-141 event, or near_withdraw and a NEAR transfer).
   */
  function dclReceipts(hash, signerId, tx, call, swap) {
    const dcl = state.dcl.contract
    const amountIn = BigInt(call.params.args.amount)
    const out = dclQuote(swap.pool_ids ?? [], tx.receiverId, amountIn)?.amount ?? 0n
    const deposit = tx.actions.find((a) => a.type === 'FunctionCall' && a.params.methodName === 'near_deposit')
    const first = `${hash}-r1`
    const dex = `${hash}-r2`
    const payout = `${hash}-r3`
    const legacy = [...(deposit ? [`Deposit ${deposit.params.deposit} NEAR to ${signerId}`] : []), `Transfer ${amountIn} from ${signerId} to ${dcl}`]
    const data = {
      swapper: signerId,
      token_in: tx.receiverId,
      token_out: swap.output_token,
      amount_in: String(amountIn),
      amount_out: String(out),
      pool_id: swap.pool_ids?.at(-1) ?? '',
      total_fee: '0',
      protocol_fee: '0',
      referral_fee: '0',
      referral_id: null,
    }
    const swapEvent = `EVENT_JSON:${JSON.stringify({ standard: 'dcl.ref', version: '1.0.0', event: 'swap', data: [data] })}`
    const native = swap.output_token === 'wrap.testnet' && swap.skip_unwrap_near !== true
    const transfer = `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: dcl, new_owner_id: signerId, amount: String(out) }] })}`
    return {
      transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [first], gas_burnt: 1, tokens_burnt: '0', executor_id: signerId, status: { SuccessReceiptId: first } } },
      receipts_outcome: [
        outcomeOf(first, tx.receiverId, legacy, [dex]),
        outcomeOf(dex, dcl, [swapEvent], [payout]),
        ...(native ? [outcomeOf(`${hash}-r4`, 'wrap.testnet', [`Withdraw ${out} NEAR from ${dcl}`], [])] : []),
        native ? outcomeOf(payout, signerId, [], []) : outcomeOf(payout, swap.output_token, [transfer], []),
      ],
      receipts: [
        { receipt_id: first, predecessor_id: signerId, receiver_id: tx.receiverId, receipt: { Action: { signer_id: signerId, actions: tx.actions.map(rpcAction) } } },
        { receipt_id: dex, predecessor_id: tx.receiverId, receiver_id: dcl, receipt: { Action: { signer_id: signerId, actions: [] } } },
        native
          ? { receipt_id: payout, predecessor_id: dcl, receiver_id: signerId, receipt: { Action: { signer_id: signerId, actions: [{ Transfer: { deposit: String(out) } }] } } }
          : { receipt_id: payout, predecessor_id: dcl, receiver_id: swap.output_token, receipt: { Action: { signer_id: signerId, actions: [] } } },
      ],
    }
  }

  function swapReceipts(hash, signerId, tx) {
    const call = tx.actions.find((a) => a.type === 'FunctionCall' && a.params.methodName === 'ft_transfer_call')
    let msg
    try {
      msg = JSON.parse(call?.params.args.msg ?? '{}')
    } catch {
      msg = {}
    }
    if (call && state.dcl && call.params.args.receiver_id === state.dcl.contract && msg.Swap) return dclReceipts(hash, signerId, tx, call, msg.Swap)
    const actions = msg.actions
    if (!call || !Array.isArray(actions) || !actions.length) return { receipts_outcome: [], receipts: [] }
    const exchange = call.params.args.receiver_id
    const lastAction = actions.at(-1)
    const deposit = tx.actions.find((a) => a.type === 'FunctionCall' && a.params.methodName === 'near_deposit')
    const first = `${hash}-r1`
    const payout = `${hash}-r2`
    const logs = [...(deposit ? [`Deposit ${deposit.params.deposit} NEAR to ${signerId}`] : []), `Transfer ${call.params.args.amount} from ${signerId} to ${exchange}`]
    const outcome = (id, executor, logLines, children) => ({
      id,
      outcome: { logs: logLines, receipt_ids: children, gas_burnt: 1, tokens_burnt: '0', executor_id: executor, status: { SuccessValue: '' } },
    })
    return {
      transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [first], gas_burnt: 1, tokens_burnt: '0', executor_id: signerId, status: { SuccessReceiptId: first } } },
      receipts_outcome: [
        outcome(first, tx.receiverId, logs, [payout]),
        outcome(
          payout,
          lastAction.token_out,
          [
            `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: exchange, new_owner_id: signerId, amount: lastAction.min_amount_out }] })}`,
          ],
          [],
        ),
      ],
      receipts: [
        { receipt_id: first, predecessor_id: signerId, receiver_id: tx.receiverId, receipt: { Action: { signer_id: signerId, actions: tx.actions.map(rpcAction) } } },
        { receipt_id: payout, predecessor_id: exchange, receiver_id: lastAction.token_out, receipt: { Action: { signer_id: signerId, actions: [] } } },
      ],
    }
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
        ...(a.global ? { global_contract_hash: a.global } : {}),
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
    if (method === 'query' && params.request_type === 'view_access_key') {
      const a = state.accounts.get(params.account_id)
      if (!a) return rpcErr(id, 'UNKNOWN_ACCOUNT', `account ${params.account_id} does not exist while viewing`)
      const kind = a.keys?.[params.public_key]
      if (!kind) return rpcErr(id, 'UNKNOWN_ACCESS_KEY', `access key ${params.public_key} does not exist while viewing`)
      return rpcOk(id, {
        nonce: 1,
        permission: kind === 'full' ? 'FullAccess' : { FunctionCall: { allowance: null, receiver_id: 'app.testnet', method_names: [] } },
        block_height: 1,
        block_hash: 'h',
      })
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
    // Rhea's router knows one pool, wNEAR/USDT; any other pair gets its "no path" answer, as on the real testnet.
    const known = new Set(['wrap.testnet', 'usdt.itachicara.testnet'])
    if (!known.has(tokenIn) || !known.has(tokenOut)) return { result_code: 1, result_message: 'no path', result_data: null }
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

  /**
   * Answers one request to an external host, or null when the fake network doesn't
   * know it (the caller then aborts and records it: nothing may reach a live network).
   */
  function respond({ url, method, body }) {
    if (/(^|\.)rpc\.fastnear\.com$|intea\.rs$|drpc\.org$/.test(url.hostname) && method === 'POST') return { status: 200, json: rpc(JSON.parse(body ?? '{}')) }
    if (url.hostname.endsWith('api.fastnear.com') && url.pathname.endsWith('/ft')) {
      const account = decodeURIComponent(url.pathname.split('/')[3] ?? '')
      const held = [...state.tokens.entries()].flatMap(([contract, t]) =>
        BigInt(t.balances.get(account) ?? '0') > 0n ? [{ contract_id: contract, balance: String(t.balances.get(account)) }] : [],
      )
      return { status: 200, json: { account_id: account, tokens: held } }
    }
    if (url.hostname === 'smartroutertest.refburrow.top') return { status: 200, json: findPath(url) }
    // FastNEAR's transaction index (history for PnL): the fake network has none to report.
    if (/^tx\.(test|main)\.fastnear\.com$/.test(url.hostname) && url.pathname === '/v0/account') return { status: 200, json: { account_txs: [], txs_count: 0 } }
    if (/^tx\.(test|main)\.fastnear\.com$/.test(url.hostname) && url.pathname === '/v0/transactions') return { status: 200, json: { transactions: [] } }
    // Market data (DEX Screener, GeckoTerminal, CoinGecko): the fake network indexes no market.
    if (url.hostname === 'api.dexscreener.com') return { status: 200, json: [] }
    if (url.hostname === 'api.geckoterminal.com') return { status: 404, json: { errors: [{ status: '404' }] } }
    if (url.hostname === 'api.coingecko.com') return { status: 200, json: [] }
    if (url.hostname.endsWith('nearblocks.io')) {
      if (url.pathname.endsWith('/holders/count')) return { status: 200, json: { holders: [{ count: '872' }] } }
      if (url.pathname.includes('/holders')) return { status: 200, json: { holders: [{ account: 'ref-finance-101.testnet', amount: '40000000000000000000000000' }] } }
      if (url.pathname.startsWith('/v1/account/')) return { status: 200, json: { account: [{ created: { block_timestamp: 1700000000000000000 } }] } }
    }
    return null
  }

  /** Install on a Playwright page: local traffic passes, everything else is faked or aborted. */
  async function install(page) {
    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      if (req.method() === 'POST' && /(^|\.)rpc\.fastnear\.com$|intea\.rs$|drpc\.org$/.test(url.hostname)) {
        const body = JSON.parse(req.postData() ?? '{}')
        if (body.method === 'EXPERIMENTAL_tx_status') await syncSigned(page)
      }
      const r = respond({ url, method: req.method(), body: req.postData() })
      if (r) return route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r.json) })
      state.external.push(req.url())
      return route.abort()
    })
  }

  /** Learns what the page's scripted wallet signed, so transaction status can answer for it. */
  async function syncSigned(page) {
    const log = await page.evaluate(() => window.__NEARKIT_E2E_SIGNED__ ?? [])
    for (const s of log) s.hashes.forEach((h, i) => state.signed.set(h, { signerId: s.signerId, tx: s.transactions[i] }))
  }

  // `rpc` and `respond` serve servers that talk to the fake network over HTTP.
  return { state, install, rpc, respond, syncSigned }
}
