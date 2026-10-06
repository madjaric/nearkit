import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { defaultBotConfig } from '@/lib/volumeBot/config'
import type { Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import { silentLogger } from '../log'
import type { TgUser } from '../telegram/types'
import { webRoutes } from '../web/routes'
import { botRoutes } from './routes'

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }

async function app() {
  const h = await walletBot()
  const web = h.deps.web as NonNullable<typeof h.deps.web>
  const bots = h.deps.volumeBots as NonNullable<typeof h.deps.volumeBots>
  const notices: { userId: number; html: string }[] = []
  const routes: Record<string, Route> = {
    ...webRoutes({
      sessions: web,
      custody: h.custody,
      store: h.store,
      near: h.deps.near,
      network: h.config.network,
      now: h.deps.now,
      approvalsOn: async () => true,
      linkedAccount: async () => null,
      notify: async () => true,
      log: silentLogger,
    }),
    ...botRoutes({
      sessions: web,
      custody: h.custody,
      bots,
      near: h.deps.near,
      network: h.config.network,
      now: h.deps.now,
      notify: async (userId, html) => void notices.push({ userId, html }),
      log: silentLogger,
    }),
  }
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
  return { h, bots, call, refused, signIn, notices }
}

const configFor = (walletId: string) => {
  const c = defaultBotConfig('market-maker', { id: USDT, symbol: 'X', decimals: 0 }, [walletId])
  c.risk.minLiquidityUsd = 0
  return c
}

describe('the Volume Bot console API', () => {
  it('saves a configuration with the token as the chain names it; refuses a bad one, field by field', async () => {
    const { h, call, refused, signIn } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const saved = (await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string; symbol: string; status: string }
    expect(saved).toMatchObject({ symbol: 'USDT', status: 'draft' })
    const bad = { ...configFor(w.id), marketMaker: { minEdgeBps: 1, skew: 0.5, fairValueWindowSec: 3600 } }
    expect(await refused('/api/web/bots/save', { session: token, config: bad })).toMatchObject({
      status: 400,
      code: 'config',
      message: expect.stringMatching(/marketMaker\.minEdgeBps/),
    })
  })

  it('trades only from the user’s own active wallets: another user’s, a watch account or a made-up id is refused', async () => {
    const { h, refused, signIn } = await app()
    const alice = await signIn()
    const w = await h.funded(5n * ONE)
    const bob = await signIn(BOB)
    expect(await refused('/api/web/bots/save', { session: bob, config: configFor(w.id) })).toMatchObject({ status: 403 })
    expect(await refused('/api/web/bots/save', { session: alice, config: configFor('bottest.near') })).toMatchObject({ status: 403 })
  })

  it('start, pause, resume, stop: each once, with the owner told in Telegram when it starts; one live bot per token', async () => {
    const { h, call, refused, signIn, notices, bots } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    const twin = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    expect(((await call('/api/web/bots/start', { session: token, botId: id })).bot as { status: string }).status).toBe('running')
    expect(notices.at(-1)).toMatchObject({ userId: ALICE.id, html: expect.stringMatching(/Volume Bot started on NEARKITS web/) })
    expect(await refused('/api/web/bots/start', { session: token, botId: twin })).toMatchObject({ status: 409, code: 'busy-token' })
    expect(((await call('/api/web/bots/pause', { session: token, botId: id })).bot as { status: string }).status).toBe('paused')
    expect(await refused('/api/web/bots/pause', { session: token, botId: id })).toMatchObject({ status: 409 })
    expect(((await call('/api/web/bots/resume', { session: token, botId: id })).bot as { status: string }).status).toBe('running')
    expect(((await call('/api/web/bots/stop', { session: token, botId: id, emergency: true })).bot as { status: string }).status).toBe('stopping')
    expect((await bots.events(id)).map((e) => e.kind)).toEqual(expect.arrayContaining(['started', 'paused', 'resumed', 'emergency-stop']))
    // Live: no deleting or editing until it has stopped.
    expect(await refused('/api/web/bots/delete', { session: token, botId: id })).toMatchObject({ status: 409 })
  })

  it('a configuration changed on NEARKITS web is announced in Telegram: the token’s contract and the limits that now apply', async () => {
    const { h, call, signIn, notices } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    const before = notices.length
    const changed = configFor(w.id)
    changed.risk.maxSlippageBps = 900
    await call('/api/web/bots/save', { session: token, botId: id, config: changed })
    const n = notices.slice(before).find((x) => x.userId === ALICE.id)
    expect(n?.html).toMatch(/Volume Bot changed on NEARKITS web/)
    expect(n?.html).toContain(USDT)
    expect(n?.html).toMatch(/slippage 9(.00)?%/)
  })

  it('nothing starts while NEARKITS has paused the Volume Bot', async () => {
    const { h, call, refused, signIn } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    await h.custody.ops.set('volumebot', true, 'maintenance', 'test')
    expect(await refused('/api/web/bots/start', { session: token, botId: id })).toMatchObject({ status: 409, code: 'paused' })
  })

  it('the detail: configuration, metrics, wallets, trades, events and series; another user gets nothing', async () => {
    const { h, call, refused, signIn } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    const d = await call('/api/web/bots/detail', { session: token, botId: id })
    expect(d).toMatchObject({ config: { walletIds: [w.id] }, metrics: { trades: 0, volumeNear: 0 }, trades: [], wallets: [{ walletId: w.id, trades: 0 }] })
    const bob = await signIn(BOB)
    expect(await refused('/api/web/bots/detail', { session: bob, botId: id })).toMatchObject({ status: 404 })
  })
})

describe('/volume in Telegram', () => {
  it('shows the bot’s status with its controls; pause, resume and stop act on it', async () => {
    const { h, call, signIn, bots } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    await h.say('/volume')
    expect(h.last()?.text).toMatch(/Volume Bot · USDT/)
    expect(h.last()?.text).toMatch(/Not started/)
    await h.say('/volume start')
    expect((await bots.get(id))?.status).toBe('running')
    await h.press(h.button('Pause'))
    expect((await bots.get(id))?.status).toBe('paused')
    await h.say('/volume resume')
    expect((await bots.get(id))?.status).toBe('running')
    await h.say('/volume stop')
    expect((await bots.get(id))?.status).toBe('stopping')
    expect(h.last()?.text).not.toMatch(/ed25519:|secret|seed/i)
  })

  it('“Sign out of NEARKITS web everywhere” also pauses the bots running: one a stolen session started stops with it', async () => {
    const { h, call, signIn, bots, refused } = await app()
    const token = await signIn()
    const w = await h.funded(5n * ONE)
    const id = ((await call('/api/web/bots/save', { session: token, config: configFor(w.id) })).bot as { id: string }).id
    await call('/api/web/bots/start', { session: token, botId: id })
    expect((await bots.get(id))?.status).toBe('running')
    await h.press('web:out')
    expect((await bots.get(id))?.status).toBe('paused')
    expect(h.last()?.text).toMatch(/Volume Bot/)
    expect(await refused('/api/web/bots', { session: token })).toMatchObject({ status: 401 })
  })

  it('with no bot yet, points to the console on NEARKITS web', async () => {
    const { h } = await app()
    await h.say('/volume')
    expect(h.last()?.text).toMatch(/No bot yet/)
    expect(h.buttons().some((b) => b.url?.endsWith('/volume-bot/console'))).toBe(true)
  })
})
