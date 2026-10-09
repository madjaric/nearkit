import type { IncomingMessage } from 'node:http'
import { base58Encode } from '@/lib/encoding'
import { HttpError, type Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import type { TgUser } from '../telegram/types'
import { webRoutes } from '../web/routes'
import { createOneClick } from './oneclick'
import { bridgeRoutes } from './routes'
import { bridgeFor, INTENTS_CONTRACT } from './service'
import type { SolanaReads } from './solana'
import { BridgeStore } from './store'

/**
 * Test-only: NEARKITS' bridge server (both products) end to end against stand-ins: a fake 1Click (NEAR Intents'
 * API, at the HTTP level, so the request NEARKITS sends and the parsing of every answer are what
 * runs in production), FastNEAR's record of the delivery on NEAR, and the test chain with the real
 * custody engine, signer policy and wallet keys for the purchase and the unwrap. No real funds move anywhere.
 * USDT stands in for $KITS: the test chain has no $KITS, and production builds the service only
 * for kits.nearlytrade.near on mainnet.
 */

export const FEE = 'nearkitfee.near'
export const ONECLICK = 'https://1click.test'
export const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }
export const SOL = 'nep141:sol.omft.near'
export const SOL_ADDR = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 11))
export const DEPOSIT_SOL = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 90 + i))
export const SOL_SIG = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256))
export const NEAR_HASH = (n: number) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i + n) % 256))

/** NEAR Intents' 1Click, as NEARKITS' server sees it over HTTP. */
export function fakeOneClick(now: () => number) {
  const quotes: Record<string, unknown>[] = []
  const submitted: { depositAddress: string; txHash: string }[] = []
  const statuses = new Map<string, Record<string, unknown>>()
  /** Every real quote gets its own deposit address, the first one DEPOSIT_SOL. */
  let deposits = 0
  const state = {
    /** wNEAR (yocto) per whole SOL. */
    nearPerSol: 20n * ONE,
    /** How 1Click shares an app fee (its default partner policy); 'other' charges NEARKITS something else. */
    split: 'policy' as 'policy' | 'other',
    refuse: null as { status: number; message: string } | null,
    /** BNB missing from 1Click's list. */
    noBnb: false,
  }
  const tokens = () => [
    { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, price: 5 },
    { assetId: SOL, blockchain: 'sol', symbol: 'SOL', decimals: 9, price: 115 },
    { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18, price: 2500 },
    ...(state.noBnb ? [] : [{ assetId: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111', blockchain: 'bsc', symbol: 'BNB', decimals: 18, price: 760 }]),
  ]
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname === '/v0/tokens') return json(200, tokens())
    if (url.pathname === '/v0/status') {
      const s = statuses.get(url.searchParams.get('depositAddress') ?? '')
      return s ? json(200, s) : json(404, { message: 'not found' })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (url.pathname === '/v0/deposit/submit') {
      submitted.push(body as { depositAddress: string; txHash: string })
      return json(200, { status: 'KNOWN_DEPOSIT_TX' })
    }
    if (url.pathname !== '/v0/quote') return json(404, { message: 'no route' })
    quotes.push(body)
    if (state.refuse) return json(state.refuse.status, { message: state.refuse.message })
    const fee = ((body.appFees as { fee: number }[] | undefined)?.[0]?.fee ?? 0) as number
    const amountIn = BigInt(body.amount as string)
    const total = state.split === 'policy' ? Math.ceil(fee / 2) + Math.max(Math.floor(fee / 2), 20) : fee + 25
    const out = (amountIn * state.nearPerSol * BigInt(10_000 - total)) / (10n ** 9n * 10_000n)
    const echoedFees =
      state.split === 'policy'
        ? [
            { recipient: FEE, fee: Math.ceil(fee / 2) },
            { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: Math.max(Math.floor(fee / 2), 20) },
          ]
        : [
            { recipient: FEE, fee },
            { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 25 },
          ]
    return json(201, {
      correlationId: `c-${quotes.length}`,
      timestamp: new Date(now()).toISOString(),
      signature: body.dry ? '' : 'ed25519:signed-by-1click',
      quoteRequest: { ...body, depositMode: 'SIMPLE', appFees: echoedFees },
      quote: {
        amountIn: body.amount,
        amountInFormatted: '1.0',
        amountInUsd: '115',
        minAmountIn: body.amount,
        amountOut: out.toString(),
        amountOutFormatted: '',
        amountOutUsd: '114',
        minAmountOut: ((out * 99n) / 100n).toString(),
        timeEstimate: 20,
        refundFee: '89920',
        ...(body.dry
          ? {}
          : {
              depositAddress: (deposits += 1) === 1 ? DEPOSIT_SOL : base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (deposits * 13 + i) % 256)),
              deadline: new Date(now() + 20 * 60_000).toISOString(),
              timeWhenInactive: new Date(now() + 15 * 60_000).toISOString(),
            }),
      },
    })
  }
  return { fetch, quotes, submitted, statuses, state }
}

/** FastNEAR's record of NEAR transactions: what the server checks a delivery and a purchase against. */
export function fakeFastnear() {
  const txs = new Map<string, unknown>()
  const receipt = (id: string, predecessor: string, receiver: string, executor: string, actions: unknown[], logs: string[] = []) => ({
    receipt: { receipt_id: id, predecessor_id: predecessor, receiver_id: receiver, receipt: { Action: { actions } } },
    execution_outcome: { id, outcome: { executor_id: executor, logs, status: { SuccessValue: '' }, tokens_burnt: '0', receipt_ids: [] } },
  })
  const ftTransfer = (from: string, to: string, amount: bigint) =>
    `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: from, new_owner_id: to, amount: amount.toString() }] })}`
  const tx = (hash: string, signer: string, receipts: unknown[]) => ({
    transaction: { hash, signer_id: signer, receiver_id: INTENTS_CONTRACT, actions: [] },
    execution_outcome: { outcome: { tokens_burnt: '0' } },
    receipts,
    block_height: 1,
    block_timestamp: '1791400000000000000',
  })
  return {
    /** NEAR Intents delivered native NEAR to `to`. */
    native(hash: string, to: string, amount: bigint) {
      txs.set(hash, tx(hash, 'solver-relay.near', [receipt(`r-${hash}`, INTENTS_CONTRACT, to, to, [{ Transfer: { deposit: amount.toString() } }])]))
    },
    /** NEAR Intents delivered wNEAR (`wrap`'s ft_transfer from intents.near). */
    wnear(hash: string, wrap: string, to: string, amount: bigint) {
      txs.set(
        hash,
        tx(hash, 'solver-relay.near', [
          receipt(`r-${hash}`, INTENTS_CONTRACT, wrap, wrap, [{ FunctionCall: { method_name: 'ft_transfer', deposit: '1' } }], [ftTransfer(INTENTS_CONTRACT, to, amount)]),
        ]),
      )
    },
    /** A purchase `signer` signed that brought `token` to it. */
    purchase(hash: string, signer: string, token: string, amount: bigint) {
      txs.set(hash, {
        ...tx(hash, signer, [
          receipt(`r-${hash}`, 'pool.near', token, token, [{ FunctionCall: { method_name: 'ft_transfer', deposit: '1' } }], [ftTransfer('pool.near', signer, amount)]),
        ]),
        transaction: { hash, signer_id: signer, receiver_id: token, actions: [] },
      })
    },
    /** `signer` unwrapped `amount` of its wNEAR: wrap's near_withdraw, then the native NEAR back to it. */
    unwrap(hash: string, signer: string, wrap: string, amount: bigint, ok = true) {
      const call = receipt(
        `r-${hash}`,
        signer,
        wrap,
        wrap,
        [{ FunctionCall: { method_name: 'near_withdraw', deposit: '1' } }],
        ok ? [`Withdraw ${amount} NEAR from ${signer}`] : [],
      )
      const back = receipt(`b-${hash}`, wrap, signer, signer, [{ Transfer: { deposit: amount.toString() } }])
      if (!ok) (call.execution_outcome.outcome as Record<string, unknown>).status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'not enough' } } } } }
      txs.set(hash, { ...tx(hash, signer, ok ? [call, back] : [call]), transaction: { hash, signer_id: signer, receiver_id: wrap, actions: [] } })
    },
    fetch: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const hashes = (JSON.parse(String(init?.body ?? '{}')) as { tx_hashes?: string[] }).tx_hashes ?? []
      return new Response(JSON.stringify({ transactions: hashes.flatMap((h) => (txs.has(h) ? [txs.get(h)] : [])) }), { status: 200 })
    },
  }
}

export const solana: SolanaReads = { blockhash: async () => ({ blockhash: SOL_ADDR, lastValidBlockHeight: 1 }), balance: async () => 5n * 10n ** 9n }

export async function bridgeApp() {
  const h = await walletBot()
  const custody = h.custody
  const web = h.deps.web
  if (!custody || !web) throw new Error('custody and web must be on')
  const now = h.deps.now
  const oc = fakeOneClick(now)
  const fast = fakeFastnear()
  const store = new BridgeStore(h.db, now)
  const bridge = bridgeFor(
    {
      network: h.config.network,
      oneclick: createOneClick({ fetch: oc.fetch as typeof fetch, baseUrl: ONECLICK, now, log: h.deps.log }),
      store,
      near: h.deps.near,
      feeRecipient: FEE,
      custody,
      ops: custody.ops,
      fetch: fast.fetch as typeof fetch,
      now,
      log: h.deps.log,
    },
    USDT,
  )
  const routes = bridgeRoutes({ bridge, sessions: web, solana })
  const call = async (path: string, body: unknown) => (routes[path] as Route)(body, {} as IncomingMessage) as Promise<Record<string, unknown>>
  const failure = async (path: string, body: unknown) => {
    try {
      await call(path, body)
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message }
      throw e
    }
    throw new Error(`${path} succeeded`)
  }
  const signIn = async (user: TgUser = ALICE): Promise<string> => {
    await h.say('/web', user)
    const url = h.buttons().find((b) => b.url?.includes('#login='))?.url
    const code = new URL(url ?? 'x:').hash.slice('#login='.length)
    const login = webRoutes({
      sessions: web,
      custody,
      store: h.store,
      near: h.deps.near,
      network: h.config.network,
      now,
      approvalsOn: async () => false,
      linkedAccount: async () => null,
      notify: async () => true,
      log: h.deps.log,
    })['/api/web/login'] as Route
    return String(((await login({ code }, {} as IncomingMessage)) as { token: string }).token)
  }
  /** One step of every due order, after the clock moved past their next check. */
  const tick = async () => {
    h.advance(130_000)
    for (const o of await store.due(50)) await bridge.step(o)
  }
  const order = async (id: unknown) => (await store.get(String(id)))!
  const input = (session: string, walletId: string, over: Record<string, unknown> = {}) => ({
    session,
    chain: 'sol',
    amount: '1',
    sourceAddress: SOL_ADDR,
    destination: { kind: 'nearkits', walletId },
    kitsSlippagePct: 1,
    ...over,
  })
  /** A Bridge (to NEAR, no purchase) request: no slippage, since nothing is bought. */
  const bridgeInput = (session: string, walletId: string, over: Record<string, unknown> = {}) => ({
    session,
    product: 'bridge',
    chain: 'sol',
    amount: '1',
    sourceAddress: SOL_ADDR,
    destination: { kind: 'nearkits', walletId },
    ...over,
  })
  /** NEAR Intents' answer for the order's deposit address. */
  const status = (s: string, details: Record<string, unknown> = {}, deposit = DEPOSIT_SOL) =>
    oc.statuses.set(deposit, {
      correlationId: 'c',
      status: s,
      updatedAt: new Date().toISOString(),
      quoteResponse: {},
      swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...details },
    })
  return { h, custody, oc, fast, store, bridge, call, failure, signIn, tick, order, input, bridgeInput, status }
}
