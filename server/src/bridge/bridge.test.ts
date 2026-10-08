import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { base58Encode } from '@/lib/encoding'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { HttpError, type Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { ONE, USDT, WRAP, walletBot } from '../bot/walletTesting'
import type { TgUser } from '../telegram/types'
import { webRoutes } from '../web/routes'
import { createOneClick } from './oneclick'
import { bridgeRoutes } from './routes'
import { bridgeFor, createBridgeService, INTENTS_CONTRACT } from './service'
import type { SolanaReads } from './solana'
import { BridgeStore } from './store'

/**
 * Bridge & Buy on NEARKITS' server, end to end against stand-ins: a fake 1Click (NEAR Intents'
 * API, at the HTTP level, so the request NEARKITS sends and the parsing of every answer are what
 * runs in production), FastNEAR's record of the delivery on NEAR, and the test chain with the real
 * custody engine, signer policy and wallet keys for the purchase. No real funds move anywhere.
 * USDT stands in for $KITS: the test chain has no $KITS, and production builds the service only
 * for kits.nearlytrade.near on mainnet (checked at the end).
 */

const FEE = 'nearkitfee.near'
const ONECLICK = 'https://1click.test'
const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }
const SOL = 'nep141:sol.omft.near'
const SOL_ADDR = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 11))
const DEPOSIT_SOL = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 90 + i))
const SOL_SIG = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256))
const NEAR_HASH = (n: number) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i + n) % 256))

/** NEAR Intents' 1Click, as NEARKITS' server sees it over HTTP. */
function fakeOneClick(now: () => number) {
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
function fakeFastnear() {
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
    fetch: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const hashes = (JSON.parse(String(init?.body ?? '{}')) as { tx_hashes?: string[] }).tx_hashes ?? []
      return new Response(JSON.stringify({ transactions: hashes.flatMap((h) => (txs.has(h) ? [txs.get(h)] : [])) }), { status: 200 })
    },
  }
}

const solana: SolanaReads = { blockhash: async () => ({ blockhash: SOL_ADDR, lastValidBlockHeight: 1 }), balance: async () => 5n * 10n ** 9n }

async function bridgeApp() {
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
  return { h, custody, oc, fast, store, bridge, call, failure, signIn, tick, order, input }
}

describe('quotes: a real 1Click quote, NEARKITS’ fee confirmed, $KITS priced by NEARKITS’ route', () => {
  it('asks NEAR Intents for exactly the swap: EXACT_INPUT from the source chain to wNEAR on NEAR, the app fee that pays NEARKITS 0.25%', async () => {
    const { call, signIn, h, oc, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    const q = (await call('/api/bridge/quote', input(token, w.id))) as unknown as BridgeQuoteView
    expect(oc.quotes[0]).toMatchObject({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: SOL,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:wrap.near',
      amount: '1000000000',
      refundTo: SOL_ADDR,
      refundType: 'ORIGIN_CHAIN',
      recipient: w.accountId,
      recipientType: 'DESTINATION_CHAIN',
      referral: 'nearkits',
      appFees: [{ recipient: FEE, fee: 50 }],
    })
    // The split as 1Click charges it: 0.25% to NEARKITS, 0.25% to NEAR Intents, both from the input.
    expect(q.fee).toEqual({ nearkitsBps: 25, intentsBps: 25, nearkitsRaw: '2500000', intentsRaw: '2500000' })
    expect(BigInt(q.nearOut)).toBe((20n * ONE * 9950n) / 10_000n)
    expect(q.kits).not.toBeNull()
    expect(q.kits?.tradingFeeBps).toBe(50)
    expect(BigInt(q.kits?.minOut ?? '0')).toBeLessThan(BigInt(q.kits?.amountOut ?? '0'))
  })

  it('refuses a quote whose fees don’t pay NEARKITS exactly 0.25%, and sends nothing on', async () => {
    const { call, failure, signIn, h, oc, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    oc.state.split = 'other'
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
    expect(await failure('/api/bridge/start', input(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
    oc.state.split = 'policy'
    expect(await call('/api/bridge/quote', input(token, w.id))).toHaveProperty('fee.nearkitsBps', 25)
  })

  it('offers only SOL, ETH and BNB, each only while NEAR Intents lists it', async () => {
    const { call, failure, signIn, h, oc, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    expect(((await call('/api/bridge/assets', {})).chains as { id: string }[]).map((c) => c.id)).toEqual(['sol', 'eth', 'bsc'])
    oc.state.noBnb = true
    // 1Click's list is kept ten minutes: the next read is a fresh one.
    h.advance(11 * 60_000)
    expect(await failure('/api/bridge/quote', input(token, w.id, { chain: 'bsc' }))).toMatchObject({ status: 400, code: 'chain' })
    expect(await failure('/api/bridge/quote', input(token, w.id, { chain: 'base' }))).toMatchObject({ status: 400, code: 'chain' })
  })

  it('says what NEAR Intents refused, in words the page acts on: a minimum, no route, unavailable', async () => {
    const { failure, signIn, h, oc, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    oc.state.refuse = { status: 400, message: 'Amount is too low for bridge, try at least 981687' }
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 400, code: 'minimum' })
    oc.state.refuse = { status: 400, message: 'Temporary swap limits: minimum swap amount is $1,000' }
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 400, code: 'minimum' })
    oc.state.refuse = { status: 400, message: 'tokenOut is not valid' }
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 502, code: 'no-route' })
    oc.state.refuse = { status: 503, message: 'down' }
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 503, code: 'unavailable' })
  })

  it('checks every input itself: the amount, the source address, the destination', async () => {
    const { failure, signIn, h, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    expect(await failure('/api/bridge/quote', input(token, w.id, { amount: '0' }))).toMatchObject({ code: 'amount' })
    expect(await failure('/api/bridge/quote', input(token, w.id, { amount: '1.0000000001' }))).toMatchObject({ code: 'amount' })
    expect(await failure('/api/bridge/quote', input(token, w.id, { sourceAddress: '0xabc' }))).toMatchObject({ code: 'source' })
    expect(await failure('/api/bridge/start', input(token, w.id, { sourceAddress: null }))).toMatchObject({ code: 'source' })
    expect(await failure('/api/bridge/quote', input(token, w.id, { destination: { kind: 'connected', accountId: 'bob.near' } }))).toMatchObject({ code: 'destination' })
    expect(await failure('/api/bridge/quote', input(token, w.id, { destination: { kind: 'nearkits', walletId: 'not-mine' } }))).toMatchObject({ status: 403 })
    expect(await failure('/api/bridge/quote', input('', w.id))).toMatchObject({ status: 401 })
  })
})

describe('an order: the deposit address bound to the destination, the amount and the fee', () => {
  it('starts with a real quote (its deposit address and 1Click’s signature kept), and a send-by well before the address closes', async () => {
    const { call, signIn, h, oc, input, order } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    const v = (await call('/api/bridge/start', input(token, w.id))) as unknown as BridgeOrderView
    expect(oc.quotes.at(-1)).toMatchObject({ dry: false, refundTo: SOL_ADDR, recipient: w.accountId })
    expect(v).toMatchObject({
      status: 'awaiting-deposit',
      chain: 'sol',
      depositAddress: DEPOSIT_SOL,
      sourceAddress: SOL_ADDR,
      destination: { kind: 'nearkits', accountId: w.accountId, walletId: w.id },
    })
    expect(v.signBy).toBeLessThanOrEqual(v.depositDeadline - 10 * 60_000)
    const o = await order(v.id)
    expect(o.oneclick.signature).toBe('ed25519:signed-by-1click')
    expect(o.kitsMinPerNear).not.toBeNull()
  })

  it('records the source transaction once, tells NEAR Intents, and refuses a different one or a wrong shape', async () => {
    const { call, failure, signIn, h, oc, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    const v = (await call('/api/bridge/start', input(token, w.id))) as unknown as BridgeOrderView
    expect(await failure('/api/bridge/deposit', { session: token, orderId: v.id, txHash: '0x' + 'a'.repeat(64) })).toMatchObject({ status: 400, code: 'tx' })
    const r = (await call('/api/bridge/deposit', { session: token, orderId: v.id, txHash: SOL_SIG })) as unknown as BridgeOrderView
    expect(r.depositTx).toEqual({ hash: SOL_SIG, url: `https://solscan.io/tx/${SOL_SIG}` })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(oc.submitted).toEqual([{ depositAddress: DEPOSIT_SOL, txHash: SOL_SIG }])
    const other = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 3) % 256))
    expect(await failure('/api/bridge/deposit', { session: token, orderId: v.id, txHash: other })).toMatchObject({ status: 409 })
  })

  it('a NEARKITS order is its owner’s: no other session reads or moves it; a connected one is read by its id', async () => {
    const { call, failure, signIn, h, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const alice = await signIn()
    const bob = await signIn(BOB)
    const v = (await call('/api/bridge/start', input(alice, w.id))) as unknown as BridgeOrderView
    expect(await failure('/api/bridge/order', { session: bob, orderId: v.id })).toMatchObject({ status: 404 })
    expect(await failure('/api/bridge/order', { orderId: v.id })).toMatchObject({ status: 404 })
    expect(await failure('/api/bridge/deposit', { session: bob, orderId: v.id, txHash: SOL_SIG })).toMatchObject({ status: 404 })
    expect(((await call('/api/bridge/orders', { session: bob })).orders as unknown[]).length).toBe(0)
    expect(((await call('/api/bridge/orders', { session: alice })).orders as { id: string }[]).map((o) => o.id)).toEqual([v.id])
    // A connected wallet's order: its id is the key (no NEARKITS session is involved).
    const c = (await call('/api/bridge/start', input('', w.id, { destination: { kind: 'connected', accountId: 'bob.testnet' } }))) as unknown as BridgeOrderView
    expect(c.destination).toEqual({ kind: 'connected', accountId: 'bob.testnet', walletId: null, name: null })
    expect(await call('/api/bridge/order', { orderId: c.id })).toMatchObject({ id: c.id, status: 'awaiting-deposit' })
    expect(await failure('/api/bridge/order', { orderId: 'x'.repeat(16) })).toMatchObject({ status: 404 })
  }, 30_000)

  it('refuses a destination that isn’t on NEAR yet, a frozen wallet, and while NEARKITS paused Bridge & Buy or trading', async () => {
    const { failure, signIn, h, custody, input } = await bridgeApp()
    const w = await h.funded(ONE)
    const token = await signIn()
    await custody.ops.set('bridge', true, 'incident', 'test')
    expect(await failure('/api/bridge/start', input(token, w.id))).toMatchObject({ status: 409, code: 'paused' })
    await custody.ops.set('bridge', false, 'over', 'test')
    await custody.ops.set('trading', true, 'incident', 'test')
    expect(await failure('/api/bridge/start', input(token, w.id))).toMatchObject({ status: 409, code: 'paused' })
    await custody.ops.set('trading', false, 'over', 'test')
    await custody.store.setFrozen(w.id, 'test')
    expect(await failure('/api/bridge/start', input(token, w.id))).toMatchObject({ status: 409, code: 'frozen' })
  })
}, 60_000)

describe('following an order: NEAR Intents’ status, then the delivery checked on NEAR', () => {
  const started = async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    const token = await app.signIn()
    const v = (await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView
    const status = (s: string, details: Record<string, unknown> = {}) =>
      app.oc.statuses.set(DEPOSIT_SOL, {
        correlationId: 'c',
        status: s,
        updatedAt: new Date().toISOString(),
        quoteResponse: {},
        swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...details },
      })
    return { ...app, w, token, v, status }
  }

  it('maps each 1Click status to the order’s own, and keeps waiting for a deposit until the address closes', async () => {
    const { tick, order, v, status } = await started()
    status('PENDING_DEPOSIT')
    await tick()
    expect((await order(v.id)).status).toBe('awaiting-deposit')
    status('KNOWN_DEPOSIT_TX', { originChainTxHashes: [{ hash: SOL_SIG, explorerUrl: 'https://solscan.io/tx/x' }] })
    await tick()
    expect(await order(v.id)).toMatchObject({ status: 'deposit-seen', depositTx: SOL_SIG })
    status('PROCESSING')
    await tick()
    expect((await order(v.id)).status).toBe('bridging')
    status('INCOMPLETE_DEPOSIT')
    await tick()
    expect((await order(v.id)).status).toBe('incomplete-deposit')
  })

  it('a refund is a refund: recorded with NEAR Intents’ reason, no NEAR delivered, no $KITS bought', async () => {
    const { tick, order, v, status, h } = await started()
    status('REFUNDED', { refundedAmount: '999000000', refundReason: 'Deposit deadline passed', originChainTxHashes: [{ hash: SOL_SIG, explorerUrl: 'https://solscan.io/tx/r' }] })
    const sent = h.chain.sent.length
    await tick()
    expect(await order(v.id)).toMatchObject({
      status: 'refunded',
      refund: { amount: '999000000', reason: 'Deposit deadline passed' },
      nextCheckAt: null,
      delivered: null,
      kits: null,
    })
    expect(h.chain.sent.length).toBe(sent)
  })

  it('nothing arrived and the deposit address closed: expired, nothing bought', async () => {
    const { tick, order, v, status, h } = await started()
    status('PENDING_DEPOSIT')
    h.advance(31 * 60_000)
    await tick()
    expect((await order(v.id)).status).toBe('expired')
  })

  it('SUCCESS alone is not delivery: until the NEAR is seen on chain in the wallet, nothing is bought', async () => {
    const { tick, order, v, status, h } = await started()
    status('SUCCESS', { amountOut: (19n * ONE).toString(), destinationChainTxHashes: [{ hash: NEAR_HASH(1), explorerUrl: '' }] })
    const sent = h.chain.sent.length
    await tick()
    await tick()
    expect((await order(v.id)).status).toBe('bridging')
    expect(h.chain.sent.length).toBe(sent)
  })
})

describe('stage 2: NEARKITS buys the token with the NEAR delivered, through the engine, within what the user accepted', () => {
  const delivered = async (asset: 'near' | 'wnear') => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    const token = await app.signIn()
    const v = (await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView
    const amount = 19n * ONE
    if (asset === 'near') {
      app.h.chain.fund(w.accountId, amount)
      app.fast.native(NEAR_HASH(2), w.accountId, amount)
    } else {
      const wrap = app.h.chain.tokens.get(WRAP)
      wrap?.registered.add(w.accountId)
      wrap?.balances.set(w.accountId, amount)
      app.fast.wnear(NEAR_HASH(2), WRAP, w.accountId, amount)
    }
    app.oc.statuses.set(DEPOSIT_SOL, {
      correlationId: 'c',
      status: 'SUCCESS',
      updatedAt: new Date().toISOString(),
      quoteResponse: {},
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }],
        amountOut: amount.toString(),
      },
    })
    const usdt = () => app.h.chain.tokens.get(USDT)?.balances.get(w.accountId) ?? 0n
    return { ...app, w, token, v, amount, usdt }
  }

  it('native NEAR delivered: checked on chain, then bought at a fresh price through the engine; complete with what arrived', async () => {
    const { tick, order, v, usdt, call, token, amount } = await delivered('near')
    await tick()
    expect(await order(v.id)).toMatchObject({ status: 'delivered', delivered: { amount: amount.toString(), asset: 'near' } })
    await tick()
    const o = await order(v.id)
    expect(o.status).toBe('complete')
    expect(BigInt(o.kits?.amount ?? '0')).toBe(usdt())
    expect(usdt()).toBeGreaterThan(0n)
    const view = (await call('/api/bridge/order', { session: token, orderId: v.id })) as unknown as BridgeOrderView
    expect(view.kits?.txs.length).toBeGreaterThan(0)
  })

  it('wNEAR delivered: unwrapped exactly, then bought', async () => {
    const { tick, order, v, usdt, h, amount } = await delivered('wnear')
    await tick()
    expect(await order(v.id)).toMatchObject({ status: 'delivered', delivered: { asset: 'wnear' } })
    await tick()
    expect((await order(v.id)).status).toBe('complete')
    const unwraps = h.chain.sent.flatMap(({ tx }) =>
      tx.actions.flatMap((a) => (a.type === 'FunctionCall' && a.methodName === 'near_withdraw' ? [JSON.parse(new TextDecoder().decode(a.args)) as { amount: string }] : [])),
    )
    expect(unwraps).toEqual([{ amount: amount.toString() }])
    expect(usdt()).toBeGreaterThan(0n)
  })

  it('the price moved beyond the slippage the user accepted: nothing is bought, the NEAR stays, the user decides', async () => {
    const { tick, order, v, usdt, h } = await delivered('near')
    await tick()
    h.market.usdtPerNear = h.market.usdtPerNear / 2n
    const sent = h.chain.sent.length
    await tick()
    const o = await order(v.id)
    expect(o.status).toBe('buy-needed')
    expect(o.message).toMatch(/price moved/)
    expect(usdt()).toBe(0n)
    expect(h.chain.sent.length).toBe(sent)
  })

  it('trading paused when the NEAR arrives: nothing is bought, and the order says why', async () => {
    const { tick, order, v, custody, usdt } = await delivered('near')
    await tick()
    await custody.ops.set('trading', true, 'incident', 'test')
    await tick()
    const o = await order(v.id)
    expect(o.status).toBe('buy-needed')
    expect(o.message).toMatch(/paused/)
    expect(usdt()).toBe(0n)
  })

  it('never buys twice: a finished order isn’t stepped into another purchase', async () => {
    const { tick, order, v, h, bridge } = await delivered('near')
    await tick()
    await tick()
    expect((await order(v.id)).status).toBe('complete')
    const sent = h.chain.sent.length
    await bridge.step(await order(v.id))
    await tick()
    expect(h.chain.sent.length).toBe(sent)
  })
})

describe('a connected wallet: the bridge delivers, its owner signs the purchase, NEARKITS checks it on chain', () => {
  it('stops at delivered (NEARKITS never signs for it), and completes only on a purchase signed by that account that brought it the token', async () => {
    const app = await bridgeApp()
    const { call, failure, tick, order, oc, fast, h } = app
    const v = (await call('/api/bridge/start', app.input('', '', { destination: { kind: 'connected', accountId: 'bob.testnet' } }))) as unknown as BridgeOrderView
    fast.native(NEAR_HASH(3), 'bob.testnet', 19n * ONE)
    oc.statuses.set(DEPOSIT_SOL, {
      correlationId: 'c',
      status: 'SUCCESS',
      updatedAt: new Date().toISOString(),
      quoteResponse: {},
      swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [{ hash: NEAR_HASH(3), explorerUrl: '' }] },
    })
    const sent = h.chain.sent.length
    await tick()
    await tick()
    expect(await order(v.id)).toMatchObject({ status: 'delivered', nextCheckAt: null })
    expect(h.chain.sent.length).toBe(sent)
    fast.purchase(NEAR_HASH(4), 'carol.testnet', USDT, 5_000_000n)
    expect(await failure('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(4) })).toMatchObject({ status: 400 })
    fast.purchase(NEAR_HASH(5), 'bob.testnet', 'other.testnet', 5_000_000n)
    expect(await failure('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(5) })).toMatchObject({ status: 400 })
    fast.purchase(NEAR_HASH(6), 'bob.testnet', USDT, 5_000_000n)
    const done = (await call('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(6) })) as unknown as BridgeOrderView
    expect(done).toMatchObject({ status: 'complete', kits: { amount: '5000000' } })
  })
})

describe('Bridge & Buy is $KITS on NEAR mainnet, nothing else', () => {
  it('the service refuses to exist on testnet or for any other token', () => {
    const deps = { network: NETWORKS.testnet } as unknown as Parameters<typeof createBridgeService>[0]
    expect(() => createBridgeService(deps)).toThrow(/mainnet/)
    expect(() => createBridgeService({ ...deps, network: { ...NETWORKS.mainnet, kitsContract: 'evil.near' } })).toThrow(/kits\.nearlytrade\.near/)
  })
})
