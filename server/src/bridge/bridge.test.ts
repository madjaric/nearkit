import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@/config/networks'
import { base58Encode } from '@/lib/encoding'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { ALICE } from '../bot/testing'
import { ONE, USDT, WRAP } from '../bot/walletTesting'
import { createBridgeService } from './service'
import { BOB, bridgeApp, DEPOSIT_SOL, FEE, NEAR_HASH, SOL, SOL_ADDR, SOL_SIG } from './testing'
import { BRIDGE_TICK_MS, createBridgeWorker } from './worker'

/**
 * Bridge & Buy on NEARKITS' server, end to end against the stand-ins of ./testing.ts: a fake 1Click
 * over HTTP, FastNEAR's record of the delivery, and the test chain with the real custody engine.
 * USDT stands in for $KITS.
 */

type App = Awaited<ReturnType<typeof bridgeApp>>

/** wrap.near knows `account`: NEAR Intents' wNEAR can reach it (both products refuse an account it doesn't know). */
const register = (h: App['h'], account: string) => h.chain.tokens.get(WRAP)?.registered.add(account)

/** Alice's NEARKITS wallet, funded and registered with wrap.near. */
async function walletFor(h: App['h'], near = ONE) {
  const w = await h.funded(near)
  register(h, w.accountId)
  return w
}

describe('quotes: a real 1Click quote, NEARKITS’ fee confirmed, $KITS priced by NEARKITS’ route', () => {
  it('asks NEAR Intents for exactly the swap: EXACT_INPUT from the source chain to wNEAR on NEAR, the app fee that pays NEARKITS 0.25%', async () => {
    const { call, signIn, h, oc, input } = await bridgeApp()
    const w = await walletFor(h)
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
    const w = await walletFor(h)
    const token = await signIn()
    oc.state.split = 'other'
    expect(await failure('/api/bridge/quote', input(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
    expect(await failure('/api/bridge/start', input(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
    oc.state.split = 'policy'
    expect(await call('/api/bridge/quote', input(token, w.id))).toHaveProperty('fee.nearkitsBps', 25)
  })

  it('offers only SOL, ETH and BNB, each only while NEAR Intents lists it', async () => {
    const { call, failure, signIn, h, oc, input } = await bridgeApp()
    const w = await walletFor(h)
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
    const w = await walletFor(h)
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
    const w = await walletFor(h)
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
    const w = await walletFor(h)
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
    const w = await walletFor(h)
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
    const w = await walletFor(h)
    const alice = await signIn()
    const bob = await signIn(BOB)
    const v = (await call('/api/bridge/start', input(alice, w.id))) as unknown as BridgeOrderView
    expect(await failure('/api/bridge/order', { session: bob, orderId: v.id })).toMatchObject({ status: 404 })
    expect(await failure('/api/bridge/order', { orderId: v.id })).toMatchObject({ status: 404 })
    expect(await failure('/api/bridge/deposit', { session: bob, orderId: v.id, txHash: SOL_SIG })).toMatchObject({ status: 404 })
    expect(((await call('/api/bridge/orders', { session: bob })).orders as unknown[]).length).toBe(0)
    expect(((await call('/api/bridge/orders', { session: alice })).orders as { id: string }[]).map((o) => o.id)).toEqual([v.id])
    // A connected wallet's order: its id is the key (no NEARKITS session is involved).
    register(h, 'bob.testnet')
    const c = (await call('/api/bridge/start', input('', w.id, { destination: { kind: 'connected', accountId: 'bob.testnet' } }))) as unknown as BridgeOrderView
    expect(c.destination).toEqual({ kind: 'connected', accountId: 'bob.testnet', walletId: null, name: null })
    expect(await call('/api/bridge/order', { orderId: c.id })).toMatchObject({ id: c.id, status: 'awaiting-deposit' })
    expect(await failure('/api/bridge/order', { orderId: 'x'.repeat(16) })).toMatchObject({ status: 404 })
  }, 30_000)

  it('refuses a destination that isn’t on NEAR yet, a frozen wallet, and while NEARKITS paused Bridge & Buy or trading', async () => {
    const { failure, signIn, h, custody, input } = await bridgeApp()
    const w = await walletFor(h)
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

describe('Bridge & Buy delivers wNEAR too: a destination that can’t receive it is refused before any deposit address exists', () => {
  const realQuotes = (app: App) => app.oc.quotes.filter((q) => q.dry === false)

  it('a NEARKITS wallet wrap.near doesn’t know: the quote says so, start is refused with nothing made; registered, it starts', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    const token = await app.signIn()
    const q = (await app.call('/api/bridge/quote', app.input(token, w.id))) as unknown as BridgeQuoteView
    expect(q.delivery).toMatchObject({ asset: 'wnear', unwrap: 'nearkits', fix: null })
    expect(q.delivery?.blocked).toMatch(/isn’t registered with wNEAR/)
    const refused = await app.failure('/api/bridge/start', app.input(token, w.id))
    expect(refused).toMatchObject({ status: 409, code: 'not-registered' })
    expect(refused.message).toMatch(/Nothing was sent\.$/)
    expect(realQuotes(app)).toHaveLength(0)
    expect(await app.store.ofUser(ALICE.id, 'testnet')).toHaveLength(0)
    register(app.h, w.accountId)
    expect(((await app.call('/api/bridge/quote', app.input(token, w.id))) as unknown as BridgeQuoteView).delivery).toEqual({
      asset: 'wnear',
      unwrap: 'nearkits',
      blocked: null,
      fix: null,
    })
    expect(await app.call('/api/bridge/start', app.input(token, w.id))).toMatchObject({ product: 'buy-kits', status: 'awaiting-deposit' })
    expect(realQuotes(app)).toHaveLength(1)
  })

  it('a connected wallet: registering is the fix its owner signs; refused until it is (a registration that failed changes nothing), then it starts', async () => {
    const app = await bridgeApp()
    const bob = { destination: { kind: 'connected', accountId: 'bob.testnet' } }
    const q = (await app.call('/api/bridge/quote', app.input('', '', bob))) as unknown as BridgeQuoteView
    expect(q.delivery).toMatchObject({ unwrap: 'wallet', fix: 'register' })
    expect(q.delivery?.blocked).toMatch(/Register it once: your wallet signs/)
    expect(await app.failure('/api/bridge/start', app.input('', '', bob))).toMatchObject({ status: 409, code: 'not-registered' })
    // Its registration failed on chain: wrap.near still doesn't know it, so it is still refused.
    expect(await app.failure('/api/bridge/start', app.input('', '', bob))).toMatchObject({ status: 409, code: 'not-registered' })
    // An account that isn't on NEAR at all.
    const nobody = { destination: { kind: 'connected', accountId: 'nobody.testnet' } }
    expect(((await app.call('/api/bridge/quote', app.input('', '', nobody))) as unknown as BridgeQuoteView).delivery?.blocked).toMatch(/isn’t on NEAR yet/)
    expect(await app.failure('/api/bridge/start', app.input('', '', nobody))).toMatchObject({ status: 409, code: 'not-on-chain' })
    expect(realQuotes(app)).toHaveLength(0)
    register(app.h, 'bob.testnet')
    expect(await app.call('/api/bridge/start', app.input('', '', bob))).toMatchObject({ product: 'buy-kits', destination: { kind: 'connected', accountId: 'bob.testnet' } })
  })

  it('gas: a NEARKITS wallet with no NEAR for the unwrap that starts the purchase is refused before anything is sent', async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h, 1n)
    const token = await app.signIn()
    const q = (await app.call('/api/bridge/quote', app.input(token, w.id))) as unknown as BridgeQuoteView
    expect(q.delivery?.blocked).toMatch(/no NEAR for the network fee of unwrapping/)
    expect(await app.failure('/api/bridge/start', app.input(token, w.id))).toMatchObject({ status: 409, code: 'no-gas' })
    expect(realQuotes(app)).toHaveLength(0)
  })

  it('gas: NEAR for the unwrap is all the wallet needs beforehand; the buy’s own gas and registrations come out of the NEAR delivered', async () => {
    const app = await bridgeApp()
    // 0.1 NEAR: the unwrap's network fee (about 0.03), well below what a first buy holds back (buyReserve, about 0.36).
    const w = await walletFor(app.h, 10n ** 23n)
    const token = await app.signIn()
    const v = (await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView
    const amount = 19n * ONE
    app.h.chain.tokens.get(WRAP)?.balances.set(w.accountId, amount)
    app.fast.wnear(NEAR_HASH(2), WRAP, w.accountId, amount)
    app.status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() })
    await app.tick()
    // The bound is per NEAR: at exactly the reviewed price, a spend that isn't round can land a rounding unit
    // under it. The price moves a little in the buyer's favour here, as prices do while NEAR bridges.
    app.h.market.usdtPerNear += 1_000n
    await app.tick()
    const o = await app.order(v.id)
    expect(o.status).toBe('complete')
    expect(BigInt(o.kits?.amount ?? '0')).toBeGreaterThan(0n)
    // It bought with less than arrived: the rest stayed for the buy's gas and registrations.
    expect(BigInt(o.stage2.nearIn ?? '0')).toBeLessThan(amount)
  })

  it('one review is one order: started again with its request key, it is the same order and deposit address', async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
    const token = await app.signIn()
    const body = { ...app.input(token, w.id), requestKey: 'web-review-key-0001' }
    const first = (await app.call('/api/bridge/start', body)) as unknown as BridgeOrderView
    const again = (await app.call('/api/bridge/start', body)) as unknown as BridgeOrderView
    expect(again).toMatchObject({ id: first.id, depositAddress: first.depositAddress, product: 'buy-kits' })
    expect(realQuotes(app)).toHaveLength(1)
    expect(await app.failure('/api/bridge/start', { ...body, amount: '2' })).toMatchObject({ status: 409, code: 'request' })
  })
}, 60_000)

describe('following an order: NEAR Intents’ status, then the delivery checked on NEAR', () => {
  const started = async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
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

describe('a failed order: asked about slowly for what NEAR Intents does next, never in a loop, then let go', () => {
  /** A Bridge & Buy order to Alice's NEARKITS wallet (registered with wrap.near) that NEAR Intents reported FAILED. */
  const failed = async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
    const token = await app.signIn()
    const v = (await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView
    app.status('FAILED', { originChainTxHashes: [{ hash: SOL_SIG, explorerUrl: 'https://solscan.io/tx/x' }] })
    await app.tick()
    expect(await app.order(v.id)).toMatchObject({ status: 'failed', refund: null })
    /** The checks due after `ms` more on the clock, each stepped once. */
    const later = async (ms: number) => {
      app.h.advance(ms)
      for (const o of await app.store.due(50)) await app.bridge.step(o)
    }
    const polled = () => app.oc.polls.filter((d) => d === DEPOSIT_SOL).length
    return { ...app, w, token, v, later, polled }
  }

  it('NEAR Intents still says FAILED: checked again minutes later, never due again at once', async () => {
    const { order, v, later, polled, h } = await failed()
    expect((await order(v.id)).nextCheckAt).toBeGreaterThanOrEqual(h.deps.now() + 60_000)
    const asked = polled()
    await later(5 * 60_000)
    const o = await order(v.id)
    expect(o.status).toBe('failed')
    expect(o.message).toMatch(/NEARKITS keeps checking/)
    expect(o.nextCheckAt).toBeGreaterThanOrEqual(h.deps.now() + 60_000)
    expect(polled()).toBe(asked + 1)
    // The worker's passes in between ask NEAR Intents nothing about it.
    for (let i = 0; i < 10; i++) await later(BRIDGE_TICK_MS)
    expect(polled()).toBe(asked + 1)
  })

  it('then REFUNDED: the refund recorded once, with NEAR Intents’ reason, and the order no longer followed', async () => {
    const { order, v, later, status, h, bridge } = await failed()
    const before = await order(v.id)
    const sent = h.chain.sent.length
    status('REFUNDED', { refundedAmount: '999000000', refundReason: 'Swap failed', originChainTxHashes: [{ hash: SOL_SIG, explorerUrl: 'https://solscan.io/tx/r' }] })
    await later(5 * 60_000)
    const o = await order(v.id)
    expect(o).toMatchObject({
      status: 'refunded',
      refund: { amount: '999000000', reason: 'Swap failed', txs: [{ hash: SOL_SIG }] },
      nextCheckAt: null,
      delivered: null,
      kits: null,
    })
    expect(o.message).toMatch(/refunded your address on the source chain/)
    // Never twice: a step that read the order before the refund was recorded changes nothing.
    status('REFUNDED', { refundedAmount: '1', refundReason: 'other', originChainTxHashes: [] })
    await bridge.step(before)
    await later(10 * 60_000)
    expect(await order(v.id)).toMatchObject({ status: 'refunded', refund: { amount: '999000000', reason: 'Swap failed' }, nextCheckAt: null })
    // NEAR Intents refunds the source address: NEARKITS sent nothing on NEAR.
    expect(h.chain.sent.length).toBe(sent)
  })

  it('then SUCCESS with the NEAR seen on chain in the wallet: it goes on to the purchase like any delivery', async () => {
    const { order, v, later, status, h, fast, w } = await failed()
    const amount = 19n * ONE
    h.chain.fund(w.accountId, amount)
    fast.native(NEAR_HASH(2), w.accountId, amount)
    status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() })
    await later(5 * 60_000)
    expect(await order(v.id)).toMatchObject({ status: 'delivered', delivered: { amount: amount.toString(), asset: 'near' } })
    await later(BRIDGE_TICK_MS)
    const o = await order(v.id)
    expect(o.status).toBe('complete')
    expect(BigInt(o.kits?.amount ?? '0')).toBeGreaterThan(0n)
  })

  it('a day without its refund reported: no longer followed, and the order says so honestly', async () => {
    const { order, v, later, polled } = await failed()
    await later(24 * 60 * 60_000)
    const o = await order(v.id)
    expect(o).toMatchObject({ status: 'failed', nextCheckAt: null, refund: null })
    expect(o.message).toMatch(/stopped checking/)
    expect(o.message).toMatch(/refund/)
    const asked = polled()
    for (let i = 0; i < 5; i++) await later(10 * 60_000)
    expect(polled()).toBe(asked)
  })

  it('a step whose move loses (the order changed under it) still leaves the order a next check, never due again at once', async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
    const v = (await app.call('/api/bridge/start', app.input(await app.signIn(), w.id))) as unknown as BridgeOrderView
    // A step that read the order while it was in transit; meanwhile it failed, its next check long past (as the old loop left such orders).
    const stale = await app.order(v.id)
    await app.store.update(v.id, { status: 'failed', nextCheckAt: app.h.deps.now() - 60_000 })
    app.status('PROCESSING')
    await app.bridge.step(stale)
    const o = await app.order(v.id)
    expect(o.status).toBe('failed')
    expect(o.nextCheckAt).toBeGreaterThanOrEqual(app.h.deps.now() + 60_000)
  })

  it('eleven failed orders never hold up a live one; each is asked about at most once per its slow interval', async () => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
    const token = await app.signIn()
    const orders: BridgeOrderView[] = []
    for (let i = 0; i < 12; i++) orders.push((await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView)
    const live = orders.at(-1) as BridgeOrderView
    const failing = orders.slice(0, 11)
    for (const o of failing) app.status('FAILED', {}, o.depositAddress)
    app.status('PROCESSING', {}, live.depositAddress)
    // The worker as it runs: ten due orders a pass, one pass every two seconds.
    const worker = createBridgeWorker({ bridge: app.bridge, store: app.store, instanceId: 'test', log: app.h.deps.log })
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += BRIDGE_TICK_MS) {
        app.h.advance(BRIDGE_TICK_MS)
        await worker.tick()
      }
    }
    await run(20_000)
    for (const o of failing) expect((await app.order(o.id)).status).toBe('failed')
    expect((await app.order(live.id)).status).toBe('bridging')
    // Past the failed orders' next check, the live one's NEAR arrives: it is still stepped, through to its purchase.
    await run(5 * 60_000)
    const amount = 19n * ONE
    app.h.chain.fund(w.accountId, amount)
    app.fast.native(NEAR_HASH(2), w.accountId, amount)
    app.status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() }, live.depositAddress)
    await run(30_000)
    expect((await app.order(live.id)).status).toBe('complete')
    // Each failed order was asked about when it failed and once more five minutes later: never in a loop.
    for (const o of failing) expect(app.oc.polls.filter((d) => d === o.depositAddress).length).toBeLessThanOrEqual(2)
  }, 60_000)
})

describe('stage 2: NEARKITS buys the token with the NEAR delivered, through the engine, within what the user accepted', () => {
  const delivered = async (asset: 'near' | 'wnear') => {
    const app = await bridgeApp()
    const w = await walletFor(app.h)
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
    register(h, 'bob.testnet')
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
