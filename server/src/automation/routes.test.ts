import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { StrategyView } from '@/lib/automation/api'
import type { StrategyKind } from '@/lib/automation/config'
import type { Route } from '../api/http'
import { ALICE } from '../bot/testing'
import { ONE, USDT, walletBot } from '../bot/walletTesting'
import { silentLogger } from '../log'
import type { TgUser } from '../telegram/types'
import { webRoutes } from '../web/routes'
import { automationRoutes } from './routes'
import { createAutomationService } from './service'
import { AutomationStore } from './store'

/**
 * NEARKITS web's automation API, signed in the way a person does (/web in Telegram, the one-time link):
 * the session is the authorization, the server validates everything again, and nobody reaches another
 * user's automations.
 */

const BOB: TgUser = { id: 202, is_bot: false, first_name: 'Bob', username: 'bob', language_code: 'en' }
const TOKEN = { id: USDT, symbol: 'USDT', decimals: 6 }

async function app(enabled: StrategyKind[] = ['limit', 'copy', 'sniper', 'dca']) {
  const h = await walletBot()
  const web = h.deps.web as NonNullable<typeof h.deps.web>
  const store = new AutomationStore(h.db, h.deps.now)
  const service = createAutomationService({ store, custody: h.custody, near: h.deps.near, network: h.config.network, enabled: new Set(enabled), now: h.deps.now })
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
    ...automationRoutes({ sessions: web, service }),
  }
  const call = (path: string, body: unknown) => (routes[path] as Route)(body, {} as IncomingMessage) as Promise<Record<string, unknown>>
  const refused = (path: string, body: unknown) =>
    call(path, body).then(
      () => null,
      (e: { status?: number; code?: string; message?: string; detail?: { issues?: unknown[] } }) => ({
        status: e.status,
        code: e.code,
        message: e.message,
        issues: e.detail?.issues ?? null,
      }),
    )
  const signIn = async (user: TgUser = ALICE): Promise<string> => {
    await h.say('/web', user)
    const url = h.buttons().find((b) => b.url?.includes('#login='))?.url
    return String((await call('/api/web/login', { code: new URL(url ?? 'x:').hash.slice('#login='.length) })).token)
  }
  return { h, store, call, refused, signIn }
}

const limitBuy = (patch: Record<string, unknown> = {}) => ({
  kind: 'limit',
  limit: { type: 'limit-buy', token: TOKEN, amount: { kind: 'near', value: '1' }, triggerPriceNear: '0.24', slippagePct: 1, expiresAt: null, ...patch },
})

describe('the automation API', () => {
  it('without a session nothing answers; with one, the features NEARKITS switched on and its limits', async () => {
    const { call, refused, signIn } = await app(['limit'])
    expect(await refused('/api/web/auto/features', {})).toMatchObject({ status: 400 })
    expect(await refused('/api/web/auto/list', { session: 'x'.repeat(43) })).toMatchObject({ status: 401 })
    const token = await signIn()
    expect(await call('/api/web/auto/features', { session: token })).toMatchObject({ enabled: ['limit'], paused: false, limits: { maxSlippagePct: 5 } })
  })

  it('previews from a fresh quote, creates, lists, and shows the order’s detail with its audit trail', async () => {
    const { h, call, signIn } = await app()
    const w = await h.funded(5n * ONE)
    const token = await signIn()
    const preview = await call('/api/web/auto/preview', { session: token, walletId: w.id, config: limitBuy() })
    expect(preview).toMatchObject({ side: 'buy', amountIn: '1', wouldTrigger: false, priceNear: '0.25' })
    const created = (await call('/api/web/auto/create', { session: token, walletId: w.id, config: limitBuy() })).strategies as StrategyView[]
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ kind: 'limit', status: 'active', subject: USDT })
    const listed = (await call('/api/web/auto/list', { session: token })).strategies as StrategyView[]
    expect(listed.map((s) => s.id)).toEqual([created[0]?.id])
    const detail = await call('/api/web/auto/detail', { session: token, id: created[0]?.id })
    expect(detail).toMatchObject({ strategy: { id: created[0]?.id }, executions: [], events: [{ kind: 'created' }] })
  })

  it('validates again on the server: the fields to fix, never a coerced value', async () => {
    const { h, refused, signIn } = await app()
    const w = await h.funded(5n * ONE)
    const token = await signIn()
    const bad = await refused('/api/web/auto/create', { session: token, walletId: w.id, config: limitBuy({ slippagePct: 7, triggerPriceNear: '-1' }) })
    expect(bad).toMatchObject({ status: 400, code: 'state' })
    expect((bad?.issues as { field: string }[]).map((i) => i.field).sort()).toEqual(['slippagePct', 'triggerPriceNear'])
    // A token's decimals are the chain's, whatever the client says.
    expect(await refused('/api/web/auto/create', { session: token, walletId: w.id, config: limitBuy({ token: { ...TOKEN, decimals: 18 } }) })).toMatchObject({
      status: 400,
      code: 'token',
    })
  })

  it('a strategy belongs to its user: another session sees none of it and can’t pause, resume, cancel or read it', async () => {
    const { h, call, refused, signIn } = await app()
    const w = await h.funded(5n * ONE)
    const alice = await signIn()
    const id = ((await call('/api/web/auto/create', { session: alice, walletId: w.id, config: limitBuy() })).strategies as StrategyView[])[0]?.id
    const bob = await signIn(BOB)
    expect((await call('/api/web/auto/list', { session: bob })).strategies).toEqual([])
    for (const path of ['/api/web/auto/detail', '/api/web/auto/pause', '/api/web/auto/resume', '/api/web/auto/cancel'])
      expect(await refused(path, { session: bob, id })).toMatchObject({ status: 404, code: 'not-found' })
    // Nor create one from Alice's wallet.
    expect(await refused('/api/web/auto/create', { session: bob, walletId: w.id, config: limitBuy() })).toMatchObject({ status: 403, code: 'wallet' })
  })

  it('pause, resume, cancel and pause all; a kind that is switched off can’t be created', async () => {
    const { h, call, refused, signIn } = await app(['limit'])
    const w = await h.funded(5n * ONE)
    const token = await signIn()
    const id = ((await call('/api/web/auto/create', { session: token, walletId: w.id, config: limitBuy() })).strategies as StrategyView[])[0]?.id
    expect((await call('/api/web/auto/pause', { session: token, id })).strategy).toMatchObject({ status: 'paused' })
    expect((await call('/api/web/auto/resume', { session: token, id })).strategy).toMatchObject({ status: 'active' })
    expect(await call('/api/web/auto/pause-all', { session: token })).toEqual({ paused: 1 })
    expect((await call('/api/web/auto/cancel', { session: token, id })).strategy).toMatchObject({ status: 'cancelled' })
    // Cancelling again changes nothing (idempotent).
    expect((await call('/api/web/auto/cancel', { session: token, id })).strategy).toMatchObject({ status: 'cancelled' })
    const dca = { kind: 'dca', dca: { token: TOKEN, amountNear: 0.5, everySec: 3_600, startAt: h.deps.now(), endAt: null, slippagePct: 1, maxRuns: null } }
    expect(await refused('/api/web/auto/create', { session: token, walletId: w.id, config: dca })).toMatchObject({ status: 409, code: 'off' })
  })
})
