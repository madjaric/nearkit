import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { telegramApprovalsOn } from '../bot/tradingWallet'
import { linkedAccountOf } from '../bot/wallet'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import type { TgUser } from '../telegram/types'
import { webRoutes } from './routes'

/**
 * Deleting and ordering NearKit wallets on NearKit web. Deleting is the bot's own path (only a
 * wallet that was never funded; the signer checks the chain itself before erasing its key; the
 * slot is free again). Ordering is how the user's wallets are listed everywhere; it changes no
 * wallet's account, key, owner, slot or funds.
 */

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }

async function webApp() {
  const h = await walletBot()
  const custody = h.custody
  const web = h.deps.web
  if (!web || !custody) throw new Error('web sign-in and custody must be on')
  const routes = webRoutes({
    sessions: web,
    custody,
    store: h.store,
    near: h.deps.near,
    network: h.config.network,
    now: h.deps.now,
    approvalsOn: () => telegramApprovalsOn(h.deps),
    linkedAccount: (userId) => linkedAccountOf(h.store, userId, h.config.network.id),
    notify: (userId, html, markup) => h.app.notify(userId, html, markup),
    log: h.deps.log,
  })
  const call = (path: string, body: unknown) => (routes[path] as Route)(body, {} as IncomingMessage) as Promise<Record<string, unknown>>
  const refused = (path: string, body: unknown) =>
    call(path, body).then(
      () => null,
      (e: { status?: number; code?: string; message?: string }) => ({ status: e.status, code: e.code, message: e.message }),
    )
  const signIn = async (user: TgUser = ALICE): Promise<string> => {
    await h.say('/web', user)
    const url = h.buttons().find((b) => b.url?.includes('#login='))?.url
    return String((await call('/api/web/login', { code: new URL(url ?? 'x:').hash.slice('#login='.length) })).token)
  }
  /** Alice's funded first wallet, then `more` made on the web (not funded). */
  const wallets = async (token: string, more: number) => {
    const main = await h.funded(3n * ONE)
    const ids = [main.id]
    for (let i = 0; i < more; i++) {
      const r = await call('/api/web/wallets/create', { session: token, name: `Degen ${i + 1}`, createKey: `web-manage-${String(i).padStart(4, '0')}` })
      ids.push((r.wallet as { id: string }).id)
    }
    return ids
  }
  const listed = async (token: string) =>
    ((await call('/api/web/wallets', { session: token })).wallets as { id: string; name: string; accountId: string; slot: number }[]).map((w) => w)
  return { h, custody, call, refused, signIn, wallets, listed }
}

describe('deleting a NEARKITS wallet on NEARKITS web', () => {
  it('an empty wallet goes the bot’s way: deleted, its slot free for a new one, and Telegram is told', async () => {
    const { h, custody, call, signIn, wallets, listed } = await webApp()
    const token = await signIn()
    const [, empty] = await wallets(token, 1)
    const before = await listed(token)
    const gone = before.find((w) => w.id === empty)
    const from = h.fake.messages().length
    expect(await call('/api/web/wallets/delete', { session: token, walletId: empty })).toEqual({ deleted: true, dustYocto: '0' })
    expect((await listed(token)).map((w) => w.id)).toEqual(before.filter((w) => w.id !== empty).map((w) => w.id))
    expect((await custody.store.wallet(empty as string))?.status).toBe('deleted')
    const notice = h.fake
      .messages()
      .slice(from)
      .find((m) => m.chatId === ALICE.id && m.text.includes('NEARKITS wallet deleted on NEARKITS web'))
    expect(notice?.text).toContain(gone?.name)
    // Its slot is free again.
    const again = (await call('/api/web/wallets/create', { session: token, name: 'Again', createKey: 'web-manage-again' })).wallet as { slot: number }
    expect(again.slot).toBe(gone?.slot)
  })

  it('a wallet holding 0.05 NEAR or more is not deleted: it says how to empty it, and nothing changes', async () => {
    const { custody, refused, signIn, wallets, listed } = await webApp()
    const token = await signIn()
    const [funded] = await wallets(token, 0)
    const r = await refused('/api/web/wallets/delete', { session: token, walletId: funded })
    expect(r).toMatchObject({ status: 409, code: 'funded' })
    expect(r?.message).toMatch(/holds 0\.05 NEAR or more/)
    expect(r?.message).toMatch(/dust \(under 0\.05 NEAR\)/)
    expect((await listed(token)).map((w) => w.id)).toContain(funded)
    expect((await custody.store.wallet(funded as string))?.status).toBe('active')
  })

  it('a wallet holding only dust (what sending everything leaves, under 0.05 NEAR) is deleted; the dust is named', async () => {
    const { h, custody, call, signIn, wallets } = await webApp()
    const token = await signIn()
    const created = await wallets(token, 3)
    const dusts = [7_500_000_000_000_000_000_000n, 40_000_000_000_000_000_000_000n, 49_999_000_000_000_000_000_000n]
    for (const [i, dust] of dusts.entries()) {
      const empty = created[i + 1]
      const w = (await custody.store.wallet(empty as string)) as { accountId: string }
      h.chain.fund(w.accountId, dust)
      const from = h.fake.messages().length
      expect(await call('/api/web/wallets/delete', { session: token, walletId: empty })).toEqual({ deleted: true, dustYocto: dust.toString() })
      expect((await custody.store.wallet(empty as string))?.status).toBe('deleted')
      expect(await h.signerVault?.key('testnet', w.accountId)).toMatchObject({ status: 'erased', eraseReason: 'deleted' })
      expect(
        h.fake
          .messages()
          .slice(from)
          .find((m) => m.chatId === ALICE.id)?.text,
      ).toMatch(/held only dust/)
    }
  })

  it('exactly 0.05 NEAR is a balance, and a token balance of any size keeps the wallet', async () => {
    const { h, custody, refused, signIn, wallets } = await webApp()
    const token = await signIn()
    const [, a, b] = await wallets(token, 2)
    const wa = (await custody.store.wallet(a as string)) as { accountId: string }
    const wb = (await custody.store.wallet(b as string)) as { accountId: string }
    h.chain.fund(wa.accountId, 50_000_000_000_000_000_000_000n)
    expect((await refused('/api/web/wallets/delete', { session: token, walletId: a }))?.message).toMatch(/holds 0\.05 NEAR or more/)
    h.chain.tokens.get(USDT)?.balances.set(wb.accountId, 1n)
    expect((await refused('/api/web/wallets/delete', { session: token, walletId: b }))?.message).toMatch(/holds tokens/)
    expect((await custody.store.wallet(a as string))?.status).toBe('active')
    expect((await custody.store.wallet(b as string))?.status).toBe('active')
  })

  it('another user’s wallet or a made-up id is refused before anything is read', async () => {
    const { refused, signIn, wallets } = await webApp()
    const alice = await signIn()
    const [, empty] = await wallets(alice, 1)
    const bob = await signIn(BOB)
    expect(await refused('/api/web/wallets/delete', { session: bob, walletId: empty })).toMatchObject({ status: 403 })
    expect(await refused('/api/web/wallets/delete', { session: alice, walletId: 'made-up-id' })).toMatchObject({ status: 403 })
  })
})

describe('ordering NEARKITS wallets on NEARKITS web', () => {
  it('the order the user sets is kept by the server and used everywhere: the web list, Telegram’s My wallets, a Multi Buy’s legs', async () => {
    const { h, call, signIn, wallets, listed } = await webApp()
    const token = await signIn()
    const [a, b, c] = await wallets(token, 2)
    const before = await listed(token)
    expect(await call('/api/web/wallets/order', { session: token, walletIds: [c, a, b] })).toMatchObject({ wallets: [{ id: c }, { id: a }, { id: b }] })
    const after = await listed(token)
    expect(after.map((w) => w.id)).toEqual([c, a, b])
    // Nothing about a wallet changes: same account, name and slot.
    for (const w of after) expect(w).toEqual(before.find((x) => x.id === w.id))
    // Telegram lists them in that order too.
    await h.press('cw:list')
    const names = after.map((w) => w.name)
    const text = h.last()?.text ?? ''
    expect(names.map((n) => text.indexOf(n))).toEqual([...names.map((n) => text.indexOf(n))].sort((x, y) => x - y))
    // A Multi Buy quotes its legs in the same order.
    for (const id of [a, b, c]) h.chain.fund(after.find((w) => w.id === id)?.accountId as string, 3n * ONE)
    const quote = await call('/api/web/trade/quote', {
      session: token,
      side: 'buy',
      token: USDT,
      slippagePct: 1,
      legs: [a, b, c].map((walletId) => ({ walletId, amountIn: '0.1' })),
    })
    expect((quote.legs as { walletId: string }[]).map((l) => l.walletId)).toEqual([c, a, b])
    // A wallet made later goes last.
    const made = (await call('/api/web/wallets/create', { session: token, name: 'Later', createKey: 'web-manage-later' })).wallet as { id: string }
    expect((await listed(token)).map((w) => w.id)).toEqual([c, a, b, made.id])
  })

  it('an order that isn’t exactly the user’s own active wallets is refused and changes nothing', async () => {
    const { refused, signIn, wallets, listed } = await webApp()
    const alice = await signIn()
    const [a, b] = await wallets(alice, 1)
    const before = (await listed(alice)).map((w) => w.id)
    for (const walletIds of [[a], [a, a], [b, a, 'made-up-id'], 'not-a-list'])
      expect(await refused('/api/web/wallets/order', { session: alice, walletIds })).toMatchObject({ status: 400 })
    // Another user's wallets are not theirs to order.
    const bob = await signIn(BOB)
    expect(await refused('/api/web/wallets/order', { session: bob, walletIds: [b, a] })).toMatchObject({ status: 400 })
    expect((await listed(alice)).map((w) => w.id)).toEqual(before)
  })
})
