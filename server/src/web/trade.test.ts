import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { telegramApprovalsOn } from '../bot/tradingWallet'
import { linkedAccountOf } from '../bot/wallet'
import { LINKED, ONE, USDT, WRAP, walletBot } from '../bot/walletTesting'
import { readWallet } from '../custody/wallets'
import { maxNearWithdraw } from '../custody/withdraw'
import type { TgUser } from '../telegram/types'
import { webRunsSettled } from './execute'
import { webRoutes } from './routes'

/**
 * Trading and sending from NearKit web, with no Telegram step: the web session is the
 * authorization. The server decides everything a client could claim (which wallets are the
 * user's, what they are, who signs), quotes on its own, and each NearKit wallet then trades or
 * sends its own funds through the engine (fresh route, funds and registration checks, the
 * signer's policy, that wallet's key), exactly as a Confirm in Telegram would.
 */

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }

async function webApp(options: Parameters<typeof walletBot>[0] = {}) {
  const h = await walletBot(options)
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
  const signIn = async (user: TgUser = ALICE): Promise<string> => {
    await h.say('/web', user)
    const url = h.buttons().find((b) => b.url?.includes('#login='))?.url
    const code = new URL(url ?? 'x:').hash.slice('#login='.length)
    return String((await call('/api/web/login', { code })).token)
  }
  /** Alice's first NearKit wallet (funded), plus `more` created on the web and funded with NEAR. */
  const wallets = async (token: string, more: number, near = 3n * ONE) => {
    const main = await h.funded(near)
    const ids = [main.id]
    for (let i = 0; i < more; i++) {
      const r = await call('/api/web/wallets/create', { session: token, name: `Degen ${i + 1}`, createKey: `web-trade-${String(i).padStart(4, '0')}` })
      const w = r.wallet as { id: string; accountId: string }
      h.chain.fund(w.accountId, near)
      ids.push(w.id)
    }
    // Callers take the first few: at most the three made here.
    return ids as [string, string, string]
  }
  const account = async (walletId: string) => (await custody.store.ownedWallet(ALICE.id, walletId))?.accountId ?? ''
  const usdt = async (walletId: string) => h.chain.tokens.get(USDT)?.balances.get(await account(walletId)) ?? 0n
  const near = async (walletId: string) => h.chain.accounts.get(await account(walletId))?.amount ?? 0n
  const messages = () => h.fake.messages().length
  const quote = (token: string, side: 'buy' | 'sell', legs: { walletId: string; amountIn: string }[]) =>
    call('/api/web/trade/quote', { session: token, side, token: USDT, slippagePct: 1, legs })
  /** The legs the web shows now: what a user confirms. */
  const shown = async (token: string, groupId: unknown) =>
    ((await call('/api/web/trade/status', { session: token, groupId })).legs as { intentId: string; status: string }[])
      .filter((l) => l.status === 'quoted' || l.status === 'requoted')
      .map((l) => l.intentId)
  /** Executes what the web shows for a quoted trade, and waits for every wallet to finish. */
  const execute = async (token: string, groupId: unknown) => {
    const r = await call('/api/web/trade/execute', { session: token, groupId, intentIds: await shown(token, groupId) })
    await webRunsSettled()
    return r
  }
  const statuses = async (token: string, groupId: unknown) => ((await call('/api/web/trade/status', { session: token, groupId })).legs as { status: string }[]).map((l) => l.status)
  return { h, custody, call, signIn, wallets, usdt, near, account, messages, quote, execute, statuses, shown }
}

describe('trading from NearKit web: the web session authorizes, no Telegram step', () => {
  it('quotes each NearKit wallet on the server and sends nothing, not even a Telegram message', async () => {
    const { h, signIn, wallets, quote, messages } = await webApp()
    const token = await signIn()
    const [a, b, c] = await wallets(token, 2)
    const sent = h.chain.sent.length
    const before = messages()
    const r = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '0.2' },
      { walletId: c, amountIn: '0.3' },
    ])
    expect(r.groupId).toMatch(/^[A-Za-z0-9_-]{16}$/)
    const legs = r.legs as { walletId: string; name: string; amountOut: string; minOut: string; status: string }[]
    expect(legs.map((l) => [l.walletId, l.name, l.amountOut, l.status])).toEqual([
      [a, 'Main', '400000', 'quoted'],
      [b, 'Degen 1', '800000', 'quoted'],
      [c, 'Degen 2', '1200000', 'quoted'],
    ])
    // What the review shows comes from the server: route, fee, gas, expiry.
    expect(r).toMatchObject({ symbol: 'USDT', decimals: 6, fee: { charged: false }, path: ['NEAR', 'USDT'] })
    expect(Number(r.expiresAt)).toBeGreaterThan(h.deps.now())
    expect(h.chain.sent.length).toBe(sent)
    expect(messages()).toBe(before)
  })

  it('executes on the web’s own confirmation: each wallet trades its own NEAR with its own key, and the web follows each one', async () => {
    const { h, signIn, wallets, quote, execute, statuses, usdt, near, account, messages } = await webApp()
    const token = await signIn()
    const [a, b, c] = await wallets(token, 2)
    const before = { a: await near(a), b: await near(b), c: await near(c) }
    const r = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '0.2' },
      { walletId: c, amountIn: '0.3' },
    ])
    const told = messages()
    expect(await execute(token, r.groupId)).toEqual({ started: 3 })
    expect(await usdt(a)).toBe(400_000n)
    expect(await usdt(b)).toBe(800_000n)
    expect(await usdt(c)).toBe(1_200_000n)
    // Each wallet paid its own amount (plus its own gas), nothing more.
    const spent = { a: before.a - (await near(a)), b: before.b - (await near(b)), c: before.c - (await near(c)) }
    const fees = ONE / 100n
    expect(spent.a >= ONE / 10n && spent.a < ONE / 10n + fees).toBe(true)
    expect(spent.b >= ONE / 5n && spent.b < ONE / 5n + fees).toBe(true)
    expect(spent.c >= (3n * ONE) / 10n && spent.c < (3n * ONE) / 10n + fees).toBe(true)
    // Every transaction was signed by the wallet whose funds it moved.
    const swaps = h.chain.sent.filter((s) => s.tx.receiverId === WRAP)
    expect(swaps.map((s) => s.tx.signerId).sort()).toEqual([await account(a), await account(b), await account(c)].sort())
    expect(await statuses(token, r.groupId)).toEqual(['done', 'done', 'done'])
    // Telegram took no part: no review, no Confirm, no result message.
    expect(messages()).toBe(told)
  })

  it('a single buy and a single sell from one wallet take the same direct path', async () => {
    const { signIn, wallets, quote, execute, statuses, usdt, near } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const buy = await quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])
    await execute(token, buy.groupId)
    expect(await statuses(token, buy.groupId)).toEqual(['done'])
    expect(await usdt(a)).toBe(400_000n)
    const held = await near(a)
    const sell = await quote(token, 'sell', [{ walletId: a, amountIn: '0.4' }])
    await execute(token, sell.groupId)
    expect(await statuses(token, sell.groupId)).toEqual(['done'])
    expect(await usdt(a)).toBe(0n)
    expect(await near(a)).toBeGreaterThan(held)
  })

  it('one wallet that can’t pay fails on its own; the others still trade and only they report done', async () => {
    const { signIn, wallets, quote, execute, statuses, usdt } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    const r = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '50' },
    ])
    await execute(token, r.groupId)
    expect(await usdt(a)).toBe(400_000n)
    expect(await usdt(b)).toBe(0n)
    expect(await statuses(token, r.groupId)).toEqual(['done', 'failed'])
  })

  it('a worse price at execution sends nothing from that wallet: the web sees the new price, and it runs only when the web confirms again', async () => {
    const { h, call, signIn, wallets, quote, execute, statuses, usdt } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    const r = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '0.2' },
    ])
    const sent = h.chain.sent.length
    h.market.usdtPerNear = 3_900_000n
    await execute(token, r.groupId)
    expect(h.chain.sent.length).toBe(sent)
    const status = await call('/api/web/trade/status', { session: token, groupId: r.groupId })
    expect((status.legs as { status: string; amountOut: string }[]).map((l) => [l.status, l.amountOut])).toEqual([
      ['requoted', '390000'],
      ['requoted', '780000'],
    ])
    await execute(token, r.groupId)
    expect(await statuses(token, r.groupId)).toEqual(['done', 'done'])
    expect(await usdt(a)).toBe(390_000n)
    expect(await usdt(b)).toBe(780_000n)
  })

  it('a Multi Sell: each wallet sells its own tokens for NEAR', async () => {
    const { signIn, wallets, quote, execute, statuses, usdt } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    const buy = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '0.2' },
    ])
    await execute(token, buy.groupId)
    const sell = await quote(token, 'sell', [
      { walletId: a, amountIn: '0.4' },
      { walletId: b, amountIn: '0.8' },
    ])
    expect(sell.side).toBe('sell')
    await execute(token, sell.groupId)
    expect(await statuses(token, sell.groupId)).toEqual(['done', 'done'])
    expect(await usdt(a)).toBe(0n)
    expect(await usdt(b)).toBe(0n)
  })

  it('refuses any leg that isn’t the signed-in user’s own NearKit wallet, before anything is quoted', async () => {
    const { h, call, signIn, wallets, custody, quote, account } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const bob = await signIn(BOB)
    const before = h.fake.messages().length
    for (const walletId of ['bottest.near', LINKED, 'made-up', await account(a)]) {
      for (const side of ['buy', 'sell'] as const)
        await expect(
          quote(token, side, [
            { walletId: a, amountIn: '0.1' },
            { walletId, amountIn: '0.1' },
          ]),
        ).rejects.toMatchObject({ status: 403, code: 'not-executable' })
    }
    // Alice's wallet, from Bob's session.
    await expect(call('/api/web/trade/quote', { session: bob, side: 'buy', token: USDT, slippagePct: 1, legs: [{ walletId: a, amountIn: '0.1' }] })).rejects.toMatchObject({
      status: 403,
    })
    expect(await custody.store.quotedOf(a)).toEqual([])
    expect(h.fake.messages().length).toBe(before)
  })

  it('the client can’t declare what a wallet is: a claimed type, owner or account is ignored', async () => {
    const { signIn, wallets, quote, custody, account } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const claims = { source: 'nearkit', type: 'execution', access: 'signer', executable: true, owner: ALICE.id }
    await expect(quote(token, 'buy', [{ walletId: 'bottest.near', amountIn: '0.1', ...claims } as { walletId: string; amountIn: string }])).rejects.toMatchObject({ status: 403 })
    // A leg naming another account trades from the wallet the server knows, nothing else.
    const r = await quote(token, 'buy', [{ walletId: a, amountIn: '0.1', accountId: 'bottest.near', signerId: LINKED } as { walletId: string; amountIn: string }])
    const [intent] = await custody.store.intentsOfGroup(String(r.groupId))
    expect(intent?.walletId).toBe(a)
    expect((r.legs as { accountId: string }[])[0]?.accountId).toBe(await account(a))
  })

  it('another user’s session can’t execute, cancel or read a trade; nothing is sent', async () => {
    const { h, call, signIn, wallets, quote, custody } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    const r = await quote(token, 'buy', [
      { walletId: a, amountIn: '0.1' },
      { walletId: b, amountIn: '0.1' },
    ])
    const bob = await signIn(BOB)
    const sent = h.chain.sent.length
    const ids = (r.legs as { intentId: string }[]).map((l) => l.intentId)
    for (const path of ['/api/web/trade/execute', '/api/web/trade/cancel', '/api/web/trade/status'])
      await expect(call(path, { session: bob, groupId: r.groupId, intentIds: ids })).rejects.toMatchObject({ status: 404 })
    expect((await custody.store.intentsOfGroup(String(r.groupId))).map((i) => i.status)).toEqual(['quoted', 'quoted'])
    // Its own user can cancel it; then nothing is left to run.
    await call('/api/web/trade/cancel', { session: token, groupId: r.groupId })
    expect((await custody.store.intentsOfGroup(String(r.groupId))).map((i) => i.status)).toEqual(['cancelled', 'cancelled'])
    await expect(call('/api/web/trade/execute', { session: token, groupId: r.groupId, intentIds: ids })).rejects.toMatchObject({ status: 409, code: 'nothing-open' })
    expect(h.chain.sent.length).toBe(sent)
  })

  it('runs only the quotes the web confirmed: a new price runs only when its own id is confirmed', async () => {
    const { h, call, signIn, wallets, quote, statuses, usdt } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const r = await quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])
    const first = (r.legs as { intentId: string }[]).map((l) => l.intentId)
    h.market.usdtPerNear = 3_900_000n
    await call('/api/web/trade/execute', { session: token, groupId: r.groupId, intentIds: first })
    await webRunsSettled()
    expect(await statuses(token, r.groupId)).toEqual(['requoted'])
    // Confirming the old quote again (a double click) runs nothing: the new price wasn't confirmed.
    await expect(call('/api/web/trade/execute', { session: token, groupId: r.groupId, intentIds: first })).rejects.toMatchObject({ status: 409, code: 'nothing-open' })
    await webRunsSettled()
    expect(await usdt(a)).toBe(0n)
  })

  it('a frozen wallet doesn’t trade: refused at the quote, and at execution if it was frozen meanwhile', async () => {
    const { h, signIn, wallets, quote, execute, statuses, custody } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    await custody.store.setFrozen(a, 'test')
    await expect(quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])).rejects.toMatchObject({ status: 409, code: 'frozen' })
    const r = await quote(token, 'buy', [{ walletId: b, amountIn: '0.1' }])
    await custody.store.setFrozen(b, 'test')
    const sent = h.chain.sent.length
    await execute(token, r.groupId)
    expect(await statuses(token, r.groupId)).toEqual(['failed'])
    expect(h.chain.sent.length).toBe(sent)
  })

  it('while trading is paused nothing is prepared, and a quote made before the pause doesn’t run', async () => {
    const { h, call, signIn, wallets, quote, custody } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const r = await quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])
    await custody.ops.set('trading', true, 'maintenance', 'test')
    await expect(quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])).rejects.toMatchObject({ status: 409, code: 'paused' })
    const sent = h.chain.sent.length
    await expect(
      call('/api/web/trade/execute', { session: token, groupId: r.groupId, intentIds: (r.legs as { intentId: string }[]).map((l) => l.intentId) }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'paused',
    })
    expect(h.chain.sent.length).toBe(sent)
  })

  it('an expired quote isn’t executed, and an expired session isn’t accepted', async () => {
    const { h, call, signIn, wallets, quote } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const r = await quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])
    h.advance(61_000)
    await expect(
      call('/api/web/trade/execute', { session: token, groupId: r.groupId, intentIds: (r.legs as { intentId: string }[]).map((l) => l.intentId) }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'nothing-open',
    })
    h.advance(8 * 24 * 60 * 60_000)
    await expect(quote(token, 'buy', [{ walletId: a, amountIn: '0.1' }])).rejects.toMatchObject({ status: 401, code: 'session' })
  })
})

describe('Send from NearKit web: reviewed and executed on the web', () => {
  it('review, then send: the existing withdrawal path runs from the web, with no Telegram step', async () => {
    const { h, call, signIn, wallets, messages } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const before = messages()
    const r = await call('/api/web/send/review', { session: token, walletId: a, token: 'near', amount: '0.5', to: LINKED })
    expect(r.review).toMatchObject({ amount: (ONE / 2n).toString(), symbol: 'NEAR', to: LINKED, linked: true })
    const got = h.chain.accounts.get(LINKED)?.amount ?? 0n
    expect(await call('/api/web/send/execute', { session: token, intentId: r.intentId })).toEqual({ started: true })
    await webRunsSettled()
    expect((h.chain.accounts.get(LINKED)?.amount ?? 0n) - got).toBe(ONE / 2n)
    expect(await call('/api/web/send/status', { session: token, intentId: r.intentId })).toMatchObject({ status: 'done' })
    expect(messages()).toBe(before)
  })

  it('MAX: the server works out the most the wallet can send (NEAR keeps what the network fee needs)', async () => {
    const { h, call, signIn, wallets, custody } = await webApp()
    const token = await signIn()
    const [a] = await wallets(token, 0)
    const wallet = await custody.store.ownedWallet(ALICE.id, a)
    if (!wallet) throw new Error('no wallet')
    const available = (await readWallet(h.deps.near, wallet)).near
    if (available === null) throw new Error('unread')
    const r = await call('/api/web/send/review', { session: token, walletId: a, token: 'near', amount: 'max', to: LINKED })
    expect((r.review as { amount: string }).amount).toBe(maxNearWithdraw(available).toString())
    const got = h.chain.accounts.get(LINKED)?.amount ?? 0n
    await call('/api/web/send/execute', { session: token, intentId: r.intentId })
    await webRunsSettled()
    expect((h.chain.accounts.get(LINKED)?.amount ?? 0n) - got).toBe(maxNearWithdraw(available))
  })

  it('an address the custody model hasn’t approved gets nothing: the web is told how it gets approved', async () => {
    const owned = await webApp()
    const t1 = await owned.signIn()
    const [a] = await owned.wallets(t1, 0)
    await expect(owned.call('/api/web/send/review', { session: t1, walletId: a, token: 'near', amount: '0.5', to: 'bob.testnet' })).rejects.toMatchObject({
      status: 409,
      code: 'needs-approval',
      detail: { kind: 'owner', owner: LINKED },
    })
    // A wallet with no owner wallet: its Telegram account approves a new address once (Telegram signs it).
    const free = await webApp({ link: false })
    const t2 = await free.signIn()
    const r = await free.call('/api/web/wallets/create', { session: t2, name: 'Solo', createKey: 'web-solo-0001' })
    const solo = r.wallet as { id: string; accountId: string }
    free.h.chain.fund(solo.accountId, 2n * ONE)
    await expect(free.call('/api/web/send/review', { session: t2, walletId: solo.id, token: 'near', amount: '0.5', to: 'bob.testnet' })).rejects.toMatchObject({
      status: 409,
      code: 'needs-approval',
      detail: { kind: 'telegram', url: expect.stringMatching(/^https:\/\/t\.me\//) },
    })
    expect(await owned.custody.store.quotedOf(a)).toEqual([])
  })

  it('refuses a watch account, another user’s wallet or send, and a frozen wallet; says when withdrawals are paused', async () => {
    const { call, signIn, wallets, custody } = await webApp()
    const token = await signIn()
    const [a, b] = await wallets(token, 1)
    await expect(call('/api/web/send/review', { session: token, walletId: 'bottest.near', token: 'near', amount: '0.5', to: LINKED })).rejects.toMatchObject({ status: 403 })
    const bob = await signIn(BOB)
    await expect(call('/api/web/send/review', { session: bob, walletId: a, token: 'near', amount: '0.5', to: 'bob.testnet' })).rejects.toMatchObject({ status: 403 })
    const mine = await call('/api/web/send/review', { session: token, walletId: a, token: 'near', amount: '0.5', to: LINKED })
    await expect(call('/api/web/send/execute', { session: bob, intentId: mine.intentId })).rejects.toMatchObject({ status: 404 })
    await expect(call('/api/web/send/status', { session: bob, intentId: mine.intentId })).rejects.toMatchObject({ status: 404 })
    await custody.store.setFrozen(b, 'test')
    await expect(call('/api/web/send/review', { session: token, walletId: b, token: 'near', amount: '0.5', to: LINKED })).rejects.toMatchObject({ status: 409, code: 'frozen' })
    await custody.ops.set('withdrawals', true, 'maintenance', 'test')
    await expect(call('/api/web/send/review', { session: token, walletId: a, token: 'near', amount: '0.5', to: LINKED })).rejects.toMatchObject({ status: 409, code: 'paused' })
    // A send reviewed before the pause doesn't run after it.
    await expect(call('/api/web/send/execute', { session: token, intentId: mine.intentId })).rejects.toMatchObject({ status: 409, code: 'paused' })
  })
})
