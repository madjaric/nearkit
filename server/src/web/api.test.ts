import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Route } from '../api/http'
import { ALICE } from '../bot/testing'
import type { TgUser } from '../telegram/types'
import { telegramApprovalsOn } from '../bot/tradingWallet'
import { linkedAccountOf } from '../bot/wallet'
import { walletBot } from '../bot/walletTesting'
import { MAX_ACTIVE_WALLETS_PER_USER } from '../custody/limits'
import { webRoutes } from './routes'

/**
 * NearKit web and the user's NearKit wallets: sign in with the bot's one-time link (no /link),
 * list, create and rename wallets. The server decides what a session may touch: only the
 * signed-in user's active NearKit wallets, never anything a client names or claims.
 */

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }

async function webApp(options: Parameters<typeof walletBot>[0] = {}) {
  const h = await walletBot(options)
  const web = h.deps.web
  if (!web || !h.custody) throw new Error('web sign-in and custody must be on')
  const routes = webRoutes({
    sessions: web,
    custody: h.custody,
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
  /** Signs `user` in the way a person does: /web in Telegram, then the one-time link. */
  const signIn = async (user: TgUser = ALICE): Promise<string> => {
    await h.say('/web', user)
    const url = h.buttons().find((b) => b.url?.includes('#login='))?.url
    if (!url) throw new Error('no sign-in link')
    const code = new URL(url).hash.slice('#login='.length)
    const r = await call('/api/web/login', { code })
    return String(r.token)
  }
  const toAlice = () =>
    h.fake
      .messages()
      .filter((m) => m.chatId === ALICE.id)
      .at(-1)?.text ?? ''
  return { h, call, signIn, toAlice }
}

describe('signing in to NearKit web', () => {
  it('the bot sends a one-time link that opens NearKit web’s wallets, and signs in once', async () => {
    const { h, call } = await webApp()
    await h.say('/web')
    expect(h.last()?.text).toMatch(/one-time sign-in link/i)
    const url = new URL(h.buttons().find((b) => b.url?.includes('#login='))?.url ?? 'x:')
    expect(url.pathname).toBe('/wallets')
    const code = url.hash.slice('#login='.length)
    const first = await call('/api/web/login', { code })
    expect(first).toMatchObject({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), user: { name: 'Alice' } })
    await expect(call('/api/web/login', { code })).rejects.toMatchObject({ status: 401 })
  })

  it('the website’s “Sign in with Telegram” deep link (/start web) sends the same one-time link', async () => {
    const { h, call } = await webApp()
    await h.say('/start web')
    const url = new URL(h.buttons().find((b) => b.url?.includes('#login='))?.url ?? 'x:')
    expect(url.pathname).toBe('/wallets')
    expect(await call('/api/web/login', { code: url.hash.slice('#login='.length) })).toMatchObject({ user: { name: 'Alice' } })
  })

  it('a missing, forged, signed-out or everywhere-signed-out session is refused', async () => {
    const { h, call, signIn } = await webApp()
    await expect(call('/api/web/wallets', {})).rejects.toMatchObject({ status: 400 })
    await expect(call('/api/web/wallets', { session: 'x'.repeat(43) })).rejects.toMatchObject({ status: 401, code: 'session' })
    const a = await signIn()
    await call('/api/web/logout', { session: a })
    await expect(call('/api/web/wallets', { session: a })).rejects.toMatchObject({ status: 401 })
    const b = await signIn()
    await h.press('web:out')
    expect(h.last()?.text).toMatch(/Signed out of NearKit web/)
    await expect(call('/api/web/wallets', { session: b })).rejects.toMatchObject({ status: 401 })
  })
})

describe('NearKit wallets on the web', () => {
  it('lists the user’s NearKit wallets with name, address and owner state', async () => {
    const { h, call, signIn } = await webApp()
    const w = await h.funded(2n * 10n ** 24n)
    const token = await signIn()
    const r = await call('/api/web/wallets', { session: token })
    expect(r).toMatchObject({
      limit: MAX_ACTIVE_WALLETS_PER_USER,
      canCreate: true,
      wallets: [{ id: w.id, accountId: w.accountId, name: 'Main', slot: 1, owner: 'alice.testnet', frozen: false }],
    })
  })

  it('creates a NearKit wallet from the web with its name, with no /link: executable at once, announced in Telegram, no key material', async () => {
    const { call, signIn, toAlice, h } = await webApp({ link: false })
    const token = await signIn()
    const r = await call('/api/web/wallets/create', { session: token, name: 'Degen 1', createKey: 'web-key-000001' })
    const created = r.wallet as Record<string, unknown>
    expect(created).toMatchObject({ name: 'Degen 1', owner: null, frozen: false })
    expect(String(created.accountId)).toMatch(/^[0-9a-f]{64}$/)
    // Nothing secret leaves the server: no key, no key reference.
    const text = JSON.stringify(r)
    for (const secret of ['ed25519:', 'keyRef', 'sealed', 'publicKey', 'privateKey', 'seed']) expect(text).not.toContain(secret)
    // It is the user's wallet in custody, with its name saved.
    const stored = await h.custody?.store.ownedWallet(ALICE.id, String(created.id))
    expect(stored).toMatchObject({ label: 'Degen 1', ownerAccount: null, status: 'active' })
    expect(toAlice()).toMatch(/Degen 1/)
    expect(toAlice()).toMatch(/NearKit web/)
    // The same Create press twice makes one wallet.
    const again = await call('/api/web/wallets/create', { session: token, name: 'Degen 1', createKey: 'web-key-000001' })
    expect((again.wallet as Record<string, unknown>).id).toBe(created.id)
    expect(((await call('/api/web/wallets', { session: token })).wallets as unknown[]).length).toBe(1)
  })

  it('keeps the 10-wallet limit', async () => {
    const { call, signIn } = await webApp({ link: false })
    const token = await signIn()
    for (let i = 0; i < MAX_ACTIVE_WALLETS_PER_USER; i++)
      await call('/api/web/wallets/create', { session: token, name: `W${i + 1}`, createKey: `web-key-${String(i).padStart(6, '0')}` })
    const r = await call('/api/web/wallets', { session: token })
    expect(r).toMatchObject({ canCreate: false })
    await expect(call('/api/web/wallets/create', { session: token, name: 'One too many', createKey: 'web-key-999999' })).rejects.toMatchObject({ status: 409, code: 'limit' })
  })

  it('rejects names that are empty or too long, and creates with the default name when none is given', async () => {
    const { call, signIn } = await webApp({ link: false })
    const token = await signIn()
    await expect(call('/api/web/wallets/create', { session: token, name: 'x'.repeat(25), createKey: 'web-key-000001' })).rejects.toMatchObject({ status: 400, code: 'name' })
    const r = await call('/api/web/wallets/create', { session: token, name: '', createKey: 'web-key-000002' })
    expect(r.wallet).toMatchObject({ name: 'Main' })
  })

  it('renames a wallet: only its label changes, never its account, key or owner', async () => {
    const { h, call, signIn } = await webApp()
    const w = await h.funded(2n * 10n ** 24n)
    const token = await signIn()
    const r = await call('/api/web/wallets/rename', { session: token, walletId: w.id, name: 'Long Term' })
    expect(r.wallet).toMatchObject({ id: w.id, accountId: w.accountId, name: 'Long Term', owner: w.ownerAccount })
    const after = await h.custody?.store.ownedWallet(ALICE.id, w.id)
    expect(after).toMatchObject({ accountId: w.accountId, publicKey: w.publicKey, keyRef: w.keyRef, ownerAccount: w.ownerAccount, label: 'Long Term' })
    // "-" is not special here: an empty name restores the default.
    const reset = await call('/api/web/wallets/rename', { session: token, walletId: w.id, name: '' })
    expect(reset.wallet).toMatchObject({ name: 'Main' })
  })

  it('never touches a wallet that isn’t the signed-in user’s: another user’s, a watch account, a made-up id', async () => {
    const { h, call, signIn } = await webApp()
    const alices = await h.funded(2n * 10n ** 24n)
    const bobToken = await signIn(BOB)
    for (const walletId of [alices.id, 'bottest.near', alices.accountId, 'made-up']) {
      await expect(call('/api/web/wallets/rename', { session: bobToken, walletId, name: 'Mine now' })).rejects.toMatchObject({ status: 403, code: 'not-executable' })
    }
    expect((await h.custody?.store.ownedWallet(ALICE.id, alices.id))?.label).toBeNull()
    expect(((await call('/api/web/wallets', { session: bobToken })).wallets as unknown[]).length).toBe(0)
  })
})
