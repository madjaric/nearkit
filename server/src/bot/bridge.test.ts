import { describe, expect, it } from 'vitest'
import { BOB, bridgeApp, DEPOSIT_SOL, NEAR_HASH, SOL_ADDR } from '../bridge/testing'
import { createBridgeWorker } from '../bridge/worker'
import { ALICE } from './testing'
import { ONE, WRAP } from './walletTesting'
import { notifyBridgeOrder, REVIEW_TTL_MS } from './bridge'

/**
 * The Bridge to NEAR in Telegram, on the web's own Bridge (the same service, orders and worker): the
 * bot's home (Connect wallet opens the Mini App, Send manually, My bridge orders), Send manually step
 * by step to one deposit address per review, the orders only their own user sees, and the notices the
 * worker's status changes send, each once. Against the fake 1Click and the test chain: nothing real moves.
 */

type App = Awaited<ReturnType<typeof bridgeApp>>
const EVM_ADDR = '0x1111111111111111111111111111111111111111'

async function telegramBridge(options: { wallet?: boolean } = {}) {
  const app = await bridgeApp()
  app.h.deps.bridge = { service: app.bridge, store: app.store }
  const w = options.wallet === false ? null : await app.h.funded(ONE)
  if (w) app.h.chain.tokens.get(WRAP)?.registered.add(w.accountId)
  const worker = createBridgeWorker({
    bridge: app.bridge,
    store: app.store,
    instanceId: 'test',
    log: app.h.deps.log,
    onChange: async (o) => void (await notifyBridgeOrder(app.h.deps, o, (u, h, m) => app.h.app.notify(u, h, m))),
  })
  /** The worker's next pass, once every order is due. */
  const step = async () => {
    app.h.advance(130_000)
    await worker.tick()
    // Notices go out beside the worker's pass, not in it: wait for them before looking at the chat.
    await worker.idle()
  }
  const text = () => app.h.last()?.text ?? ''
  const data = (label: string) => app.h.buttons().find((b) => b.text.includes(label))?.data ?? ''
  const realQuotes = () => app.oc.quotes.filter((q) => q.dry === false).length
  /** Send manually through to the review: chain, (the one wallet), amount, refund address. */
  const toReview = async (chain = 'sol', amount = '1', source = SOL_ADDR) => {
    await app.h.press('brg:man')
    await app.h.press(`brg:ch:${chain}`)
    await app.h.say(amount)
    await app.h.say(source)
  }
  /** Send manually through to the deposit address. */
  const ordered = async () => {
    await toReview()
    await app.h.press(data('Create deposit address'))
    return (await app.store.ofUser(ALICE.id, 'testnet'))[0]
  }
  return { ...app, w, worker, step, text, data, realQuotes, toReview, ordered }
}

/** What Telegram sent `user` in their private chat, newest last. */
const chatOf = (app: App, user = ALICE) => app.h.fake.messages().filter((m) => m.chatId === user.id)

describe('the Bridge’s home in Telegram', () => {
  it('Connect wallet opens NEARKITS’ Mini App on its Bridge; Send manually and My bridge orders; nothing is quoted', async () => {
    const app = await telegramBridge()
    await app.h.say('/bridge')
    expect(app.text()).toMatch(/Bridge to NEAR/)
    expect(app.text()).toMatch(/NEARKITS 0\.25%, plus NEAR Intents’ own fee/)
    const buttons = app.h.buttons()
    expect(buttons.find((b) => b.text.includes('Connect wallet'))?.url).toBe('https://t.me/NearKitBot?startapp=bridge')
    expect(buttons.map((b) => b.data)).toEqual(expect.arrayContaining(['brg:man', 'brg:list', 'menu:home']))
    expect(app.oc.quotes).toHaveLength(0)
  })

  it('with no NEARKITS wallet it asks to create one first, and offers nothing to send to', async () => {
    const app = await telegramBridge({ wallet: false })
    await app.h.say('/bridge')
    expect(app.text()).toMatch(/You need a NEARKITS wallet/)
    expect(app.h.buttons().some((b) => b.data?.startsWith('cw:new:'))).toBe(true)
    expect(app.h.buttons().some((b) => b.data === 'brg:man')).toBe(false)
    // The first screen says the Bridge is one way to fund the wallet it asks to create.
    await app.h.say('/start')
    expect(app.text()).toContain('2. <b>Fund it</b>: send NEAR to it, or bring SOL, ETH or BNB with 🌉 Bridge to NEAR.')
  })

  it('the main menu offers Bridge to NEAR, $KITS and Community where the bridge runs', async () => {
    const app = await telegramBridge()
    await app.h.say('/start')
    const data = app.h.buttons().map((b) => b.data)
    expect(data).toEqual(expect.arrayContaining(['brg:home', 'kit:show', 'kit:community', 'menu:help']))
  })
})

describe('Send manually', () => {
  it('SOL: chain, amount, refund address, a live review with both fees and what happens to any other transfer, and no deposit address yet', async () => {
    const app = await telegramBridge()
    await app.h.press('brg:man')
    expect(app.h.buttons().map((b) => b.text)).toEqual(expect.arrayContaining(['Solana · SOL', 'Ethereum · ETH', 'BNB Chain · BNB']))
    await app.h.press('brg:ch:sol')
    expect(app.text()).toMatch(/How much SOL/)
    await app.h.say('abc')
    expect(app.text()).toMatch(/Send an amount of SOL above 0/)
    await app.h.say('1')
    expect(app.text()).toMatch(/your own Solana address for refunds/)
    await app.h.say('not-an-address')
    expect(app.text()).not.toMatch(/Review/)
    await app.h.say(SOL_ADDR)
    const review = app.text()
    expect(review).toMatch(/Review · SOL → NEAR/)
    expect(review).toMatch(/NEARKITS bridge fee \(0\.25%\): <b>0\.0025 SOL<\/b>/)
    expect(review).toMatch(/NEAR Intents fee \(0\.25%\): <b>0\.0025 SOL<\/b>/)
    expect(review).toMatch(/You receive: <b>≈ [\d.,]+ NEAR<\/b>/)
    expect(review).toMatch(/Less: NEAR Intents refunds it to your refund address by the deadline\. More: it bridges the order and refunds the excess there\./)
    expect(review).toMatch(/Another coin or another network isn’t this order’s and can be lost/)
    expect(review).not.toContain(DEPOSIT_SOL)
    expect(app.realQuotes()).toBe(0)
  })

  it('Create makes one order and shows its own deposit address, exact amount and deadlines; pressing it again shows the same order', async () => {
    const app = await telegramBridge()
    await app.toReview()
    const create = app.data('Create deposit address')
    await app.h.press(create)
    const orders = await app.store.ofUser(ALICE.id, 'testnet')
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ product: 'bridge', kind: 'nearkits', userId: ALICE.id, walletId: app.w?.id, sourceAddress: SOL_ADDR, depositAddress: DEPOSIT_SOL })
    expect(orders[0]?.requestKey).toMatch(/^tg-/)
    const screen = app.text()
    expect(screen).toContain(`<code>${DEPOSIT_SOL}</code>`)
    expect(screen).toMatch(/Send exactly <code>1<\/code> <b>SOL<\/b> on <b>Solana<\/b>/)
    expect(screen).toMatch(/The address closes at <b>\d\d:\d\d UTC<\/b>/)
    expect(app.h.buttons().map((b) => b.copy)).toEqual(expect.arrayContaining([DEPOSIT_SOL, '1']))
    // A double tap, or a press after a restart: the same order, and no second deposit address.
    await app.h.press(create)
    await app.h.press(create)
    expect(await app.store.ofUser(ALICE.id, 'testnet')).toHaveLength(1)
    expect(app.realQuotes()).toBe(1)
    expect(app.text()).toContain(DEPOSIT_SOL)
  })

  it('ETH and BNB from an EVM address: priced live and ordered on their own network; a Solana address is refused for them', async () => {
    const app = await telegramBridge()
    for (const [chain, name, symbol] of [
      ['eth', 'Ethereum', 'ETH'],
      ['bsc', 'BNB Chain', 'BNB'],
    ] as const) {
      await app.toReview(chain, '0.01', SOL_ADDR)
      expect(app.text()).not.toMatch(/Review/)
      await app.h.say(EVM_ADDR)
      expect(app.text()).toMatch(new RegExp(`Review · ${symbol} → NEAR`))
      expect(app.text()).toMatch(new RegExp(`Send only <b>${symbol}</b> on <b>${name}</b>`))
      await app.h.press(app.data('Create deposit address'))
      expect(app.text()).toMatch(/0x[0-9a-f]{40}/)
    }
    const orders = await app.store.ofUser(ALICE.id, 'testnet')
    expect(orders.map((o) => [o.chain, o.sourceAddress, /^0x[0-9a-f]{40}$/.test(o.depositAddress)])).toEqual([
      ['bsc', EVM_ADDR, true],
      ['eth', EVM_ADDR, true],
    ])
  })

  it('a frozen wallet is never a destination: with every wallet frozen, it says so and asks nothing', async () => {
    const app = await telegramBridge()
    if (!app.w) throw new Error('no wallet')
    await app.custody.store.setFrozen(app.w.id, 'suspicious activity')
    await app.h.press('brg:man')
    await app.h.press('brg:ch:sol')
    expect(app.text()).toMatch(/frozen by NEARKITS for your protection, so none can receive a bridge now/)
    expect(await app.h.deps.store.getSession(ALICE.id, ALICE.id)).toBeNull()
  })

  it('the refund address used last on a chain is offered next time', async () => {
    const app = await telegramBridge()
    await app.ordered()
    await app.h.press('brg:man')
    await app.h.press('brg:ch:sol')
    await app.h.say('0.5')
    const use = app.h.buttons().find((b) => b.text.startsWith('Use '))
    expect(use?.data).toMatch(/^brg:src:/)
    await app.h.press(use?.data ?? '')
    expect(app.text()).toMatch(/Review · SOL → NEAR/)
  })

  it('a review over 3 minutes old is priced again before any deposit address exists', async () => {
    const app = await telegramBridge()
    await app.toReview()
    const create = app.data('Create deposit address')
    app.h.advance(REVIEW_TTL_MS + 1_000)
    await app.h.press(create)
    expect(app.text()).toMatch(/over 3 minutes old/)
    expect(app.realQuotes()).toBe(0)
    expect(await app.store.ofUser(ALICE.id, 'testnet')).toHaveLength(0)
  })

  it('below NEAR Intents’ minimum: said plainly, nothing to create', async () => {
    const app = await telegramBridge()
    app.oc.state.refuse = { status: 400, message: 'Amount is too low for bridge, try at least 1000000' }
    await app.toReview()
    expect(app.text()).toMatch(/⚠️/)
    expect(app.h.buttons().some((b) => b.text.includes('Create deposit address'))).toBe(false)
  })

  it('the bridge kill switch: Send manually says it is paused, and a review made before can’t make an order', async () => {
    const app = await telegramBridge()
    await app.toReview()
    const create = app.data('Create deposit address')
    await app.custody.ops.set('bridge', true, 'incident', 'test')
    await app.h.press(create)
    expect(app.text()).toMatch(/Bridge is paused/)
    expect(await app.store.ofUser(ALICE.id, 'testnet')).toHaveLength(0)
    await app.h.press('brg:man')
    expect(app.text()).toMatch(/Bridge is paused/)
    await app.h.say('/bridge')
    expect(app.h.buttons().some((b) => b.data === 'brg:man')).toBe(false)
  })
})

describe('My bridge orders: only their own user sees them', () => {
  it('lists the order and opens its screen; another Telegram user can’t open it, its buttons, or its unwrap', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o) throw new Error('no order')
    await app.h.press('brg:list')
    expect(app.h.buttons().some((b) => b.data === `brg:o:${o.id}`)).toBe(true)
    await app.h.press(`brg:o:${o.id}`)
    expect(app.text()).toMatch(/Waiting for deposit/)
    const before = chatOf(app, BOB).length
    await app.h.press(`brg:o:${o.id}`, BOB)
    await app.h.press(`brg:uw:${o.id}`, BOB)
    const alerts = app.h.fake.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text)
    expect(alerts.filter((t) => t === 'That bridge order isn’t yours, or it’s gone.')).toHaveLength(2)
    expect(
      chatOf(app, BOB)
        .slice(before)
        .some((m) => m.text.includes(o.depositAddress)),
    ).toBe(false)
    await app.h.press('brg:list', BOB)
    expect(app.text()).toMatch(/No bridge orders yet/)
  })

  it('an open order past its quote window says not to send if nothing was sent yet', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    app.h.advance(6 * 60_000)
    await app.h.press(`brg:o:${o?.id}`)
    expect(app.text()).toMatch(/Haven’t sent yet\? Don’t: start a new bridge/)
  })
})

describe('notices: what the worker saw, each once', () => {
  it('deposit detected, then complete with the native NEAR in the wallet; repeats send nothing more', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o || !app.w) throw new Error('no order')
    const notices = () => chatOf(app).filter((m) => m.method === 'sendMessage' && /Deposit detected|Bridge complete/.test(m.text))
    app.status('KNOWN_DEPOSIT_TX')
    await app.step()
    expect(notices().map((m) => m.text)).toEqual([expect.stringMatching(/Deposit detected/)])
    app.status('PROCESSING')
    await app.step()
    expect(notices()).toHaveLength(1)
    const amount = 19n * ONE
    const wrap = app.h.chain.tokens.get(WRAP)
    wrap?.balances.set(app.w.accountId, amount)
    app.fast.wnear(NEAR_HASH(2), WRAP, app.w.accountId, amount)
    app.status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() })
    await app.step()
    await app.step()
    expect((await app.store.get(o.id))?.status).toBe('complete')
    const done = notices().at(-1)
    expect(done?.text).toMatch(/Bridge complete/)
    expect(done?.text).toMatch(/<b>19 NEAR<\/b> is in <b>Main<\/b>, native NEAR/)
    expect(done?.buttons.map((b) => b.data)).toEqual(expect.arrayContaining(['tr:buy', 'cw:home', `brg:o:${o.id}`]))
    await app.step()
    await app.bridge.step((await app.store.get(o.id))!)
    expect(notices()).toHaveLength(2)
    expect((await app.store.get(o.id))?.notified).toBe('complete')
    await app.h.press(`brg:o:${o.id}`)
    expect(app.text()).toMatch(/Completed: native NEAR available/)
    expect(app.text()).toMatch(/Received: <b>19 NEAR<\/b> \(native\)/)
  })

  it('bridged, not unwrapped: says so with Unwrap now; pressing it unwraps once and the completion follows', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o || !app.w) throw new Error('no order')
    const amount = 19n * ONE
    app.h.chain.tokens.get(WRAP)?.balances.set(app.w.accountId, amount)
    app.fast.wnear(NEAR_HASH(2), WRAP, app.w.accountId, amount)
    app.status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() })
    const account = app.h.chain.accounts.get(app.w.accountId)
    if (account) account.amount = 1n
    await app.step()
    await app.step()
    const stuck = chatOf(app).filter((m) => /Bridged, not unwrapped/.test(m.text))
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.text).toMatch(/19 wNEAR is in the wallet/)
    app.h.chain.fund(app.w.accountId, ONE)
    await app.h.press(`brg:uw:${o.id}`)
    expect((await app.store.get(o.id))?.status).toBe('unwrapping')
    await app.step()
    expect((await app.store.get(o.id))?.status).toBe('complete')
    expect(chatOf(app).filter((m) => /Bridge complete/.test(m.text))).toHaveLength(1)
    // Unwrapping again after the stop doesn't announce a deposit again.
    expect(chatOf(app).filter((m) => /Deposit detected/.test(m.text))).toHaveLength(1)
  })

  it('Unwrap now that fails again says so again (the bot promised a message), and the order stays unwrap-needed', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o || !app.w) throw new Error('no order')
    const amount = 19n * ONE
    app.h.chain.tokens.get(WRAP)?.balances.set(app.w.accountId, amount)
    app.fast.wnear(NEAR_HASH(2), WRAP, app.w.accountId, amount)
    app.status('SUCCESS', { destinationChainTxHashes: [{ hash: NEAR_HASH(2), explorerUrl: '' }], amountOut: amount.toString() })
    const account = app.h.chain.accounts.get(app.w.accountId)
    if (account) account.amount = 1n
    await app.step()
    await app.step()
    const stuck = () => chatOf(app).filter((m) => m.method === 'sendMessage' && /Bridged, not unwrapped/.test(m.text))
    expect(stuck()).toHaveLength(1)
    // Pressed with the wallet still out of NEAR for the fee: it fails again, and the user hears it.
    await app.h.press(`brg:uw:${o.id}`)
    await app.step()
    await app.step()
    expect((await app.store.get(o.id))?.status).toBe('unwrap-needed')
    expect(stuck()).toHaveLength(2)
    // Nothing else is announced: no second deposit notice, no completion.
    expect(chatOf(app).filter((m) => /Deposit detected/.test(m.text))).toHaveLength(1)
    expect(chatOf(app).filter((m) => /Bridge complete/.test(m.text))).toHaveLength(0)
  })

  it('refunded, and an order nobody paid into expiring: each said once, never as delivered', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o) throw new Error('no order')
    app.status('REFUNDED', { refundedAmount: '1000000000', refundReason: 'price moved', originChainTxHashes: [{ hash: 'refund-tx', explorerUrl: '' }] })
    await app.step()
    const refunded = chatOf(app).filter((m) => /Refunded/.test(m.text))
    expect(refunded).toHaveLength(1)
    expect(refunded[0]?.text).toMatch(/No NEAR was delivered/)
    await app.step()
    expect(chatOf(app).filter((m) => /Refunded/.test(m.text))).toHaveLength(1)

    // A second order, never paid: its address closes, and the user is told not to send to it.
    await app.toReview('sol', '0.5')
    await app.h.press(app.data('Create deposit address'))
    const second = (await app.store.ofUser(ALICE.id, 'testnet'))[0]
    if (!second) throw new Error('no second order')
    app.status('PENDING_DEPOSIT', {}, second.depositAddress)
    app.h.advance(31 * 60_000)
    await app.step()
    expect((await app.store.get(second.id))?.status).toBe('expired')
    expect(chatOf(app).filter((m) => /Bridge order expired/.test(m.text) && /Don’t send to that address any more/.test(m.text))).toHaveLength(1)
  })

  it('a slow Telegram never holds up the worker: the next order is stepped while a notice is still on its way', async () => {
    const app = await telegramBridge()
    const first = await app.ordered()
    await app.toReview('sol', '0.5')
    await app.h.press(app.data('Create deposit address'))
    const second = (await app.store.ofUser(ALICE.id, 'testnet'))[0]
    if (!first || !second) throw new Error('no orders')
    let release = () => undefined as void
    const held = new Promise<void>((r) => (release = r))
    const sent: string[] = []
    const worker = createBridgeWorker({
      bridge: app.bridge,
      store: app.store,
      instanceId: 'slow',
      log: app.h.deps.log,
      onChange: async (o) => {
        await held
        sent.push(o.id)
      },
    })
    app.status('KNOWN_DEPOSIT_TX', {}, first.depositAddress)
    app.status('KNOWN_DEPOSIT_TX', {}, second.depositAddress)
    app.h.advance(130_000)
    await worker.tick()
    // Both orders moved in one pass although the first notice hasn't gone yet.
    expect((await app.store.get(first.id))?.status).toBe('deposit-seen')
    expect((await app.store.get(second.id))?.status).toBe('deposit-seen')
    expect(sent).toEqual([])
    release()
    await worker.idle()
    expect(sent.sort()).toEqual([first.id, second.id].sort())
  })

  it('Telegram busy for a second: the notice waits and goes once; Telegram refusing it: it is not sent again by later steps', async () => {
    const app = await telegramBridge()
    const o = await app.ordered()
    if (!o) throw new Error('no order')
    const deposits = () => chatOf(app).filter((m) => /Deposit detected/.test(m.text))
    app.h.fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests', retryAfter: 1 })
    app.status('KNOWN_DEPOSIT_TX')
    await app.step()
    expect(deposits()).toHaveLength(1)
    app.status('PROCESSING')
    await app.step()
    expect(deposits()).toHaveLength(1)

    // A second order whose notice Telegram fails outright: at most once, so never repeated by a later step.
    await app.toReview('sol', '0.5')
    await app.h.press(app.data('Create deposit address'))
    const second = (await app.store.ofUser(ALICE.id, 'testnet'))[0]
    if (!second) throw new Error('no second order')
    app.h.fake.failNext('sendMessage', { code: 400, description: 'Bad Request: chat not found' })
    app.status('KNOWN_DEPOSIT_TX', {}, second.depositAddress)
    await app.step()
    app.status('PROCESSING', {}, second.depositAddress)
    await app.step()
    expect(deposits()).toHaveLength(1)
    expect((await app.store.get(second.id))?.notified).toBe('deposit')
  })
})
