import { describe, expect, it } from 'vitest'
import type { BridgeOrderView } from '@/lib/bridge/types'
import { ALICE } from '../bot/testing'
import { tradingWallet } from '../bot/tradingWallet'
import type { TradingWallet } from '../custody/store'
import { ONE, WRAP } from '../bot/walletTesting'
import { BOB, bridgeApp } from './testing'

/**
 * The Bridge from Telegram's Mini App, on NEARKITS' server: the page names the Telegram user with the
 * launch data Telegram signed for this bot (checked here with Telegram's Ed25519 key, never a user id
 * the page states), and only for an hour after it was opened. With it the page sees that user's own
 * NEARKITS wallets and bridges to one of them, exactly as a NEARKITS web session does. A review's
 * request key makes one order: asked again (a double tap, a resent request), it is the same order and
 * the same deposit address, never a second one.
 */

type App = Awaited<ReturnType<typeof bridgeApp>>

const registered = (app: App, account: string) => app.h.chain.tokens.get(WRAP)?.registered.add(account)
const realQuotes = (app: App) => app.oc.quotes.filter((q) => q.dry === false)

/** `user`'s NEARKITS wallet, created in the bot, funded and registered with wrap.near. */
async function walletOf(app: App, user: typeof BOB) {
  await app.h.press('cw:create', user)
  const w = (await tradingWallet(app.h.deps, user.id)) as TradingWallet
  app.h.chain.fund(w.accountId, ONE)
  registered(app, w.accountId)
  return w
}

async function aliceWallet() {
  const app = await bridgeApp()
  const w = await app.h.funded(ONE)
  registered(app, w.accountId)
  return { ...app, w }
}

describe('Telegram’s launch data names the user to the bridge', () => {
  it('lists the user’s own NEARKITS wallets for a fresh launch Telegram signed for this bot', async () => {
    const app = await aliceWallet()
    const telegram = await app.launch(ALICE)
    const r = (await app.call('/api/bridge/wallets', { telegram })) as { wallets: { id: string; accountId: string; name: string; frozen: boolean }[] }
    expect(r.wallets).toEqual([expect.objectContaining({ id: app.w.id, accountId: app.w.accountId, frozen: false })])
    // A NEARKITS web session names the same user the same way.
    expect(((await app.call('/api/bridge/wallets', { session: await app.signIn() })) as typeof r).wallets.map((w) => w.id)).toEqual([app.w.id])
  })

  it('refuses launch data that isn’t Telegram’s for this bot, was changed, is over an hour old, or is missing', async () => {
    const app = await aliceWallet()
    const other = await app.launch(ALICE, { botId: 999 })
    expect(await app.failure('/api/bridge/wallets', { telegram: other })).toMatchObject({ status: 401, code: 'telegram' })
    const genuine = await app.launch(ALICE)
    const changed = genuine.replace(encodeURIComponent('"id":101'), encodeURIComponent('"id":202'))
    expect(changed).not.toBe(genuine)
    expect(await app.failure('/api/bridge/wallets', { telegram: changed })).toMatchObject({ status: 401, code: 'telegram' })
    const old = await app.launch(ALICE, { ageMs: 61 * 60_000 })
    expect(await app.failure('/api/bridge/wallets', { telegram: old })).toMatchObject({ status: 401, code: 'telegram' })
    expect(await app.failure('/api/bridge/wallets', {})).toMatchObject({ status: 401, code: 'session' })
  })

  it('another Telegram user sees only their own wallets, and can’t bridge to Alice’s or read her order', async () => {
    const app = await aliceWallet()
    const alice = await app.launch(ALICE)
    const v = (await app.call('/api/bridge/start', { ...app.bridgeInput('', app.w.id), session: undefined, telegram: alice })) as unknown as BridgeOrderView
    const bob = await app.launch(BOB)
    expect(((await app.call('/api/bridge/wallets', { telegram: bob })) as { wallets: unknown[] }).wallets).toEqual([])
    expect(await app.failure('/api/bridge/start', { ...app.bridgeInput('', app.w.id), session: undefined, telegram: bob })).toMatchObject({ status: 403, code: 'not-executable' })
    expect(await app.failure('/api/bridge/order', { orderId: v.id, telegram: bob })).toMatchObject({ status: 404 })
    expect(((await app.call('/api/bridge/order', { orderId: v.id, telegram: alice })) as unknown as BridgeOrderView).id).toBe(v.id)
    expect(((await app.call('/api/bridge/orders', { telegram: alice })) as { orders: BridgeOrderView[] }).orders.map((o) => o.id)).toEqual([v.id])
  })
})

describe('a review’s request key makes one order', () => {
  it('asking again with the same key returns the same order and deposit address, and asks NEAR Intents for no second one', async () => {
    const app = await aliceWallet()
    const telegram = await app.launch(ALICE)
    const body = { ...app.bridgeInput('', app.w.id), session: undefined, telegram, requestKey: 'mini-app-review-0001' }
    const first = (await app.call('/api/bridge/start', body)) as unknown as BridgeOrderView
    const again = (await app.call('/api/bridge/start', body)) as unknown as BridgeOrderView
    expect(again.id).toBe(first.id)
    expect(again.depositAddress).toBe(first.depositAddress)
    expect(realQuotes(app)).toHaveLength(1)
    expect((await app.order(first.id)).requestKey).toBe('mini-app-review-0001')
    // A different review is a different order.
    const other = (await app.call('/api/bridge/start', { ...body, requestKey: 'mini-app-review-0002' })) as unknown as BridgeOrderView
    expect(other.id).not.toBe(first.id)
  })

  it('a key already used by another user, or for another order, is refused rather than shown', async () => {
    const app = await aliceWallet()
    const body = { ...app.bridgeInput('', app.w.id), session: undefined, telegram: await app.launch(ALICE), requestKey: 'mini-app-review-0003' }
    await app.call('/api/bridge/start', body)
    expect(await app.failure('/api/bridge/start', { ...body, amount: '2' })).toMatchObject({ status: 409, code: 'request' })
    const bobWallet = await walletOf(app, BOB)
    expect(
      await app.failure('/api/bridge/start', { ...app.bridgeInput('', bobWallet.id), session: undefined, telegram: await app.launch(BOB), requestKey: 'mini-app-review-0003' }),
    ).toMatchObject({ status: 409, code: 'request' })
    expect(await app.failure('/api/bridge/start', { ...body, requestKey: 'short' })).toMatchObject({ status: 400, code: 'request' })
  })
})
