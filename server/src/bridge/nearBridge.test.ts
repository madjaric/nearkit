import { describe, expect, it } from 'vitest'
import type { BridgeOrderView, BridgeQuoteView } from '@/lib/bridge/types'
import { ONE, WRAP } from '../bot/walletTesting'
import { BOB, bridgeApp, DEPOSIT_SOL, FEE, NEAR_HASH, SOL, SOL_ADDR, SOL_SIG } from './testing'

/**
 * The plain Bridge to NEAR (SOL, ETH or BNB → NEAR, no purchase) on NEARKITS' server, beside Bridge
 * & Buy and on the same engine: the same 1Click quote and fee check, the same order and worker. What
 * differs is after the NEAR arrives. NEAR Intents delivers it as wNEAR, so:
 * - to a NEARKITS wallet, NEARKITS unwraps exactly what arrived through the engine's existing unwrap;
 * - to a connected wallet, its owner unwraps it with their own signature, checked on chain;
 * - to an external address, the wNEAR is what arrives, and the order says so.
 * Nothing is promised that the destination can't receive: it must be on NEAR and registered with wrap.near.
 */

type App = Awaited<ReturnType<typeof bridgeApp>>

const wrapOf = (app: App) => app.h.chain.tokens.get(WRAP)
/** wrap.near's registration of `account` on the test chain. */
const register = (app: App, account: string) => wrapOf(app)?.registered.add(account)
const unwraps = (app: App) =>
  app.h.chain.sent.flatMap(({ tx }) =>
    tx.actions.flatMap((a) => (a.type === 'FunctionCall' && a.methodName === 'near_withdraw' ? [JSON.parse(new TextDecoder().decode(a.args)) as { amount: string }] : [])),
  )

/** A Bridge to Alice's funded NEARKITS wallet, started (registered with wrap.near unless said otherwise). */
async function startedBridge(options: { registered?: boolean } = {}) {
  const app = await bridgeApp()
  const w = await app.h.funded(ONE)
  if (options.registered !== false) register(app, w.accountId)
  const token = await app.signIn()
  const v = (await app.call('/api/bridge/start', app.bridgeInput(token, w.id))) as unknown as BridgeOrderView
  return { ...app, w, token, v }
}

/** NEAR Intents reports SUCCESS, and FastNEAR has the delivery: wNEAR (wrap's ft_transfer) or native NEAR. */
function delivers(app: App, to: string, asset: 'wnear' | 'near', amount = 19n * ONE, hash = NEAR_HASH(2)) {
  if (asset === 'wnear') {
    const wrap = wrapOf(app)
    wrap?.registered.add(to)
    wrap?.balances.set(to, (wrap.balances.get(to) ?? 0n) + amount)
    app.fast.wnear(hash, WRAP, to, amount)
  } else {
    app.h.chain.fund(to, amount)
    app.fast.native(hash, to, amount)
  }
  app.status('SUCCESS', { destinationChainTxHashes: [{ hash, explorerUrl: '' }], amountOut: amount.toString() })
  return amount
}

describe('a Bridge quote: the same NEAR Intents swap and fee as Bridge & Buy, nothing bought, the delivery said plainly', () => {
  it('asks 1Click for exactly the swap (EXACT_INPUT to wNEAR on NEAR, the app fee that pays NEARKITS 0.25%) and prices no purchase', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    register(app, w.accountId)
    const token = await app.signIn()
    const q = (await app.call('/api/bridge/quote', app.bridgeInput(token, w.id))) as unknown as BridgeQuoteView
    expect(app.oc.quotes[0]).toMatchObject({
      dry: true,
      swapType: 'EXACT_INPUT',
      originAsset: SOL,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:wrap.near',
      recipient: w.accountId,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: SOL_ADDR,
      refundType: 'ORIGIN_CHAIN',
      appFees: [{ recipient: FEE, fee: 50 }],
    })
    // 0.25% to NEARKITS and NEAR Intents' own 0.25%, both from the input; no trading fee (nothing is traded).
    expect(q.fee).toEqual({ nearkitsBps: 25, intentsBps: 25, nearkitsRaw: '2500000', intentsRaw: '2500000' })
    expect(q.kits).toBeNull()
    expect(q.kitsUnavailable).toBeNull()
    expect(q.delivery).toEqual({ asset: 'wnear', unwrap: 'nearkits', blocked: null, fix: null })
  })

  it('refuses a quote that doesn’t pay NEARKITS exactly 0.25%, for a Bridge too', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    register(app, w.accountId)
    const token = await app.signIn()
    app.oc.state.split = 'other'
    expect(await app.failure('/api/bridge/quote', app.bridgeInput(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
    expect(await app.failure('/api/bridge/start', app.bridgeInput(token, w.id))).toMatchObject({ status: 503, code: 'fee' })
  })

  it('says before confirming when the destination can’t receive wNEAR, and starts nothing for it', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    const token = await app.signIn()
    // A NEARKITS wallet wrap.near doesn't know yet.
    const q1 = (await app.call('/api/bridge/quote', app.bridgeInput(token, w.id))) as unknown as BridgeQuoteView
    expect(q1.delivery).toMatchObject({ unwrap: 'nearkits', fix: null })
    expect(q1.delivery?.blocked).toMatch(/isn’t registered with wNEAR/)
    expect(await app.failure('/api/bridge/start', app.bridgeInput(token, w.id))).toMatchObject({ status: 409, code: 'not-registered' })
    // A connected wallet that isn't registered: its owner can register by signing.
    const q2 = (await app.call('/api/bridge/quote', app.bridgeInput('', '', { destination: { kind: 'connected', accountId: 'bob.testnet' } }))) as unknown as BridgeQuoteView
    expect(q2.delivery).toMatchObject({ unwrap: 'wallet', fix: 'register' })
    // An external address: only its owner can register it.
    app.h.chain.fund('carol.testnet', ONE)
    const q3 = (await app.call('/api/bridge/quote', app.bridgeInput('', '', { destination: { kind: 'external', accountId: 'carol.testnet' } }))) as unknown as BridgeQuoteView
    expect(q3.delivery).toMatchObject({ unwrap: 'none', fix: null })
    expect(q3.delivery?.blocked).toMatch(/isn’t registered with wNEAR/)
    // An account that isn't on NEAR at all.
    const q4 = (await app.call('/api/bridge/quote', app.bridgeInput('', '', { destination: { kind: 'external', accountId: 'nobody.testnet' } }))) as unknown as BridgeQuoteView
    expect(q4.delivery?.blocked).toMatch(/isn’t on NEAR yet/)
    expect(await app.failure('/api/bridge/start', app.bridgeInput('', '', { destination: { kind: 'external', accountId: 'nobody.testnet' } }))).toMatchObject({
      status: 409,
      code: 'not-on-chain',
    })
    expect(app.oc.quotes.filter((q) => q.dry === false)).toHaveLength(0)
  })

  it('a NEARKITS wallet with no NEAR for the unwrap’s network fee is refused before anything is sent', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(1n)
    register(app, w.accountId)
    const token = await app.signIn()
    const q = (await app.call('/api/bridge/quote', app.bridgeInput(token, w.id))) as unknown as BridgeQuoteView
    expect(q.delivery?.blocked).toMatch(/no NEAR for the network fee of unwrapping/)
    expect(await app.failure('/api/bridge/start', app.bridgeInput(token, w.id))).toMatchObject({ status: 409, code: 'no-gas' })
  })

  it('an external NEAR address is a Bridge destination only: Bridge & Buy still takes a NEARKITS or connected wallet', async () => {
    const app = await bridgeApp()
    register(app, 'carol.testnet')
    expect(await app.failure('/api/bridge/quote', app.input('', '', { destination: { kind: 'external', accountId: 'carol.testnet' } }))).toMatchObject({
      status: 400,
      code: 'destination',
    })
    expect(await app.failure('/api/bridge/quote', app.bridgeInput('', '', { destination: { kind: 'external', accountId: 'not an account' } }))).toMatchObject({
      status: 400,
      code: 'destination',
    })
    expect(await app.failure('/api/bridge/quote', app.bridgeInput('', '', { product: 'airdrop' }))).toMatchObject({ status: 400, code: 'product' })
  })

  it('the bridge kill switch stops new Bridge orders; trading paused doesn’t (a Bridge trades nothing, and unwrapping stays inside the wallet)', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    register(app, w.accountId)
    register(app, 'bob.testnet')
    const token = await app.signIn()
    await app.custody.ops.set('bridge', true, 'incident', 'test')
    const paused = await app.failure('/api/bridge/start', app.bridgeInput(token, w.id))
    expect(paused).toMatchObject({ status: 409, code: 'paused' })
    expect(paused.message).toMatch(/^Bridge is paused/)
    expect(await app.failure('/api/bridge/start', app.bridgeInput('', '', { destination: { kind: 'connected', accountId: 'bob.testnet' } }))).toMatchObject({ code: 'paused' })
    await app.custody.ops.set('bridge', false, 'over', 'test')
    await app.custody.ops.set('trading', true, 'incident', 'test')
    expect(await app.call('/api/bridge/start', app.bridgeInput(token, w.id))).toMatchObject({ product: 'bridge', status: 'awaiting-deposit' })
    // A frozen wallet is never a destination.
    await app.custody.store.setFrozen(w.id, 'test')
    expect(await app.failure('/api/bridge/quote', app.bridgeInput(token, w.id))).toMatchObject({ status: 409, code: 'frozen' })
  })
}, 60_000)

describe('a Bridge to a NEARKITS wallet: NEARKITS unwraps exactly what NEAR Intents delivered, through the engine', () => {
  it('wNEAR delivered and checked on chain → unwrapped once, exactly → complete with the native NEAR', async () => {
    const app = await startedBridge()
    const { v, w, token, tick, order } = app
    expect(v).toMatchObject({ product: 'bridge', status: 'awaiting-deposit', destination: { kind: 'nearkits', accountId: w.accountId }, kits: null, unwrapped: null })
    expect((await order(v.id)).kitsMinPerNear).toBeNull()
    const amount = delivers(app, w.accountId, 'wnear')
    await tick()
    expect(await order(v.id)).toMatchObject({ status: 'unwrapping', delivered: { asset: 'wnear', amount: amount.toString() } })
    await tick()
    const o = await order(v.id)
    expect(o.status).toBe('complete')
    // Exactly one unwrap, of exactly what arrived, signed for this wallet.
    expect(unwraps(app)).toEqual([{ amount: amount.toString() }])
    expect(app.h.chain.sent.filter(({ tx }) => tx.receiverId === WRAP).map(({ tx }) => tx.signerId)).toEqual([w.accountId])
    const view = (await app.call('/api/bridge/order', { session: token, orderId: v.id })) as unknown as BridgeOrderView
    expect(view).toMatchObject({ product: 'bridge', status: 'complete', kits: null, unwrapped: { amount: amount.toString() } })
    expect(view.unwrapped?.txs.length).toBeGreaterThan(0)
    // Never twice: a finished order is not unwrapped again.
    const sent = app.h.chain.sent.length
    await app.bridge.step(await order(v.id))
    await tick()
    expect(app.h.chain.sent.length).toBe(sent)
  })

  it('native NEAR delivered: complete as it arrived, nothing to unwrap', async () => {
    const app = await startedBridge()
    const amount = delivers(app, app.w.accountId, 'near')
    await app.tick()
    expect(await app.order(app.v.id)).toMatchObject({ status: 'complete', delivered: { asset: 'near', amount: amount.toString() } })
    expect(unwraps(app)).toEqual([])
  })

  it('SUCCESS without the delivery on NEAR is not done: nothing is unwrapped until it is seen in the wallet', async () => {
    const app = await startedBridge()
    app.status('SUCCESS', { amountOut: (19n * ONE).toString(), destinationChainTxHashes: [{ hash: NEAR_HASH(1), explorerUrl: '' }] })
    await app.tick()
    await app.tick()
    expect((await app.order(app.v.id)).status).toBe('bridging')
    expect(unwraps(app)).toEqual([])
  })

  it('the unwrap couldn’t run (the wallet had no NEAR left for its fee when the wNEAR arrived): unwrap-needed with the reason; its owner adds NEAR, asks again, and it completes', async () => {
    const app = await startedBridge()
    const amount = delivers(app, app.w.accountId, 'wnear')
    // Drained after the order was confirmed: nothing left for the unwrap's network fee.
    const account = app.h.chain.accounts.get(app.w.accountId)
    if (account) account.amount = 1n
    await app.tick()
    await app.tick()
    const stuck = await app.order(app.v.id)
    expect(stuck.status).toBe('unwrap-needed')
    expect(stuck.message).toMatch(/gas/)
    expect(stuck.message).toMatch(/19 wNEAR is in the wallet/)
    expect(unwraps(app)).toEqual([])
    // No automatic retry: it waits for the owner.
    await app.tick()
    expect((await app.order(app.v.id)).status).toBe('unwrap-needed')
    // Only the order's owner may ask, and only while it is stuck.
    const bob = await app.signIn(BOB)
    expect(await app.failure('/api/bridge/unwrap', { session: bob, orderId: app.v.id })).toMatchObject({ status: 404 })
    app.h.chain.fund(app.w.accountId, ONE)
    expect(await app.call('/api/bridge/unwrap', { session: app.token, orderId: app.v.id })).toMatchObject({ status: 'unwrapping' })
    await app.tick()
    expect(await app.order(app.v.id)).toMatchObject({ status: 'complete' })
    expect(unwraps(app)).toEqual([{ amount: amount.toString() }])
    expect(await app.failure('/api/bridge/unwrap', { session: app.token, orderId: app.v.id })).toMatchObject({ status: 409 })
  })

  it('a refund is a refund: NEAR Intents’ reason recorded, nothing delivered, nothing unwrapped, and no $KITS anywhere in it', async () => {
    const app = await startedBridge()
    app.status('REFUNDED', {
      refundedAmount: '999000000',
      refundReason: 'Deposit deadline passed',
      originChainTxHashes: [{ hash: SOL_SIG, explorerUrl: 'https://solscan.io/tx/r' }],
    })
    await app.tick()
    const o = await app.order(app.v.id)
    expect(o).toMatchObject({ status: 'refunded', refund: { amount: '999000000', reason: 'Deposit deadline passed' }, delivered: null })
    expect(o.message).not.toMatch(/KITS/)
    expect(unwraps(app)).toEqual([])
  })

  it('a source transfer is recorded once: the same hash again is fine, a different one is refused', async () => {
    const app = await startedBridge()
    await app.call('/api/bridge/deposit', { session: app.token, orderId: app.v.id, txHash: SOL_SIG })
    await app.call('/api/bridge/deposit', { session: app.token, orderId: app.v.id, txHash: SOL_SIG })
    expect(app.oc.submitted).toEqual([{ depositAddress: DEPOSIT_SOL, txHash: SOL_SIG }])
    expect(await app.failure('/api/bridge/deposit', { session: app.token, orderId: app.v.id, txHash: SOL_ADDR + 'x'.repeat(20) })).toMatchObject({ status: 400 })
  })
}, 60_000)

describe('a Bridge to a connected wallet or an external address', () => {
  it('connected: wNEAR arrives and the order waits for its owner’s unwrap; only an unwrap that account signed, that succeeded, completes it', async () => {
    const app = await bridgeApp()
    register(app, 'bob.testnet')
    const v = (await app.call('/api/bridge/start', app.bridgeInput('', '', { destination: { kind: 'connected', accountId: 'bob.testnet' } }))) as unknown as BridgeOrderView
    const amount = delivers(app, 'bob.testnet', 'wnear')
    const sent = app.h.chain.sent.length
    await app.tick()
    await app.tick()
    expect(await app.order(v.id)).toMatchObject({ status: 'delivered', delivered: { asset: 'wnear' }, nextCheckAt: null })
    // NEARKITS never signs for a connected wallet.
    expect(app.h.chain.sent.length).toBe(sent)
    app.fast.unwrap(NEAR_HASH(7), 'carol.testnet', WRAP, amount)
    expect(await app.failure('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(7) })).toMatchObject({ status: 400 })
    app.fast.unwrap(NEAR_HASH(8), 'bob.testnet', WRAP, amount, false)
    expect(await app.failure('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(8) })).toMatchObject({ status: 400 })
    app.fast.unwrap(NEAR_HASH(9), 'bob.testnet', WRAP, amount)
    const done = (await app.call('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(9) })) as unknown as BridgeOrderView
    expect(done).toMatchObject({ product: 'bridge', status: 'complete', unwrapped: { amount: amount.toString() }, kits: null })
  })

  it('external: the wNEAR delivered is the result (no authorized unwrap exists there), said as such; nothing to settle', async () => {
    const app = await bridgeApp()
    app.h.chain.fund('carol.testnet', ONE)
    register(app, 'carol.testnet')
    const v = (await app.call('/api/bridge/start', app.bridgeInput('', '', { destination: { kind: 'external', accountId: 'carol.testnet' } }))) as unknown as BridgeOrderView
    expect(v.destination).toEqual({ kind: 'external', accountId: 'carol.testnet', walletId: null, name: null })
    expect(v.quote.delivery).toMatchObject({ unwrap: 'none', blocked: null })
    delivers(app, 'carol.testnet', 'wnear')
    await app.tick()
    const o = await app.order(v.id)
    expect(o).toMatchObject({ status: 'complete', delivered: { asset: 'wnear' } })
    expect(o.message).toMatch(/as wNEAR/)
    expect(unwraps(app)).toEqual([])
    expect(await app.call('/api/bridge/order', { orderId: v.id })).toMatchObject({ id: v.id, product: 'bridge' })
    app.fast.unwrap(NEAR_HASH(9), 'carol.testnet', WRAP, 1n)
    expect(await app.failure('/api/bridge/settle', { orderId: v.id, txHash: NEAR_HASH(9) })).toMatchObject({ status: 409 })
  })
})

describe('Bridge and Bridge & Buy side by side', () => {
  it('a user’s orders list both, each saying which it is; Bridge & Buy still needs its $KITS price and slippage', async () => {
    const app = await bridgeApp()
    const w = await app.h.funded(ONE)
    register(app, w.accountId)
    const token = await app.signIn()
    const plain = (await app.call('/api/bridge/start', app.bridgeInput(token, w.id))) as unknown as BridgeOrderView
    const kits = (await app.call('/api/bridge/start', app.input(token, w.id))) as unknown as BridgeOrderView
    expect(kits).toMatchObject({ product: 'buy-kits' })
    expect((await app.order(kits.id)).kitsMinPerNear).not.toBeNull()
    const listed = (await app.call('/api/bridge/orders', { session: token })).orders as { id: string; product: string }[]
    expect(listed.map((o) => [o.id, o.product]).sort()).toEqual(
      [
        [plain.id, 'bridge'],
        [kits.id, 'buy-kits'],
      ].sort(),
    )
    expect(await app.failure('/api/bridge/quote', app.input(token, w.id, { kitsSlippagePct: undefined }))).toMatchObject({ code: 'slippage' })
    // An unwrap retry is a Bridge's: a Bridge & Buy order isn't one.
    expect(await app.failure('/api/bridge/unwrap', { session: token, orderId: kits.id })).toMatchObject({ status: 409 })
  })
}, 60_000)
