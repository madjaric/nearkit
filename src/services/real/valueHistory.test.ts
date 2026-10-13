import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import type { NearKitWeb, NearKitWebSession, NearKitWebWallet } from '../nearkitWeb'
import { LinkRequestError } from '../telegramLink'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet } from './testing/fakeChain'

/**
 * The dashboard's portfolio value and its history on mainnet prices (NEAR at $5): the value of the
 * executable wallets (NearKit wallets with or without a browser wallet), recorded as it is read.
 */

const ONE = 10n ** 24n
const NK = 'a'.repeat(64)
const NK2 = 'b'.repeat(64)
const BROWSER = 'alice.near'
const MIN = 60_000
const MAIN: NearKitWebWallet = { id: 'nk-1', accountId: NK, name: 'Main', slot: 1, owner: BROWSER, frozen: false, createdAt: 1 }
const DEGEN: NearKitWebWallet = { id: 'nk-2', accountId: NK2, name: 'Degen 1', slot: 2, owner: BROWSER, frozen: false, createdAt: 2 }

/**
 * `server`: how NEARKITS' server answers the wallet list from now on: `up`, `down` (unreachable),
 * or `end` (it ended the session: refused once with 401, signed out from then on, as nearkitWeb does).
 * `failBalance`: accounts whose NEAR balance the RPC can't read.
 */
function setup(opts: { browser: boolean; web: boolean; wallets?: NearKitWebWallet[]; failBalance?: string[] }) {
  let now = Date.UTC(2026, 9, 5, 12)
  const chain = createFakeChain({ accounts: { [NK]: { amount: 3n * ONE }, [NK2]: { amount: 4n * ONE }, [BROWSER]: { amount: 2n * ONE } } })
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  chain.route('https://api.rhea.finance/list-token-price', () => ({}))
  const failing = new Set(opts.failBalance ?? [])
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { params?: { request_type?: string; account_id?: string } }) : null
    if (body?.params?.request_type === 'view_account' && failing.has(String(body.params.account_id))) return new Response('bad gateway', { status: 502 })
    return chain.fetch(url, init)
  }) as typeof fetch
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' })
  const wallet = fakeWallet(opts.browser ? { walletId: 'fake', walletName: 'Fake', accounts: [BROWSER], batch: true } : null)
  const list: NearKitWebWallet[] = opts.wallets ?? [MAIN]
  const server = { mode: 'up' as 'up' | 'down' | 'end', ended: false }
  const session = (): NearKitWebSession | null => (opts.web && !server.ended ? { token: 'T'.repeat(43), expiresAt: now + 60 * MIN, userName: 'Tess', userHandle: 'tess' } : null)
  const unused = () => Promise.reject(new Error('not used here'))
  const nearkit = {
    available: true,
    session,
    ended: () => (server.ended ? { userName: 'Tess', userHandle: 'tess', at: now } : null),
    wallets: async () => {
      if (!session()) return null
      if (server.mode === 'down') throw new LinkRequestError(0, 'unreachable', 'The NEARKITS server can’t be reached right now. Try again in a moment.')
      if (server.mode === 'end') {
        server.ended = true
        throw new LinkRequestError(401, 'session', 'Your NEARKITS web session has ended. Sign in again: send /web to the NEARKITS bot.')
      }
      return { wallets: [...list], limit: 10, canCreate: true }
    },
    subscribe: () => () => undefined,
    login: unused,
    logout: async () => undefined,
  } as unknown as NearKitWeb
  const services = createNearServices({ env, network: NETWORKS.mainnet, fetch: fetchImpl, kv: memoryStorage(), wallet: async () => wallet.adapter, nearkit, now: () => now })
  return { services, advance: (ms: number) => (now += ms), wallet, server, failing }
}

describe('the dashboard’s portfolio value', () => {
  it('signed in to NEARKITS web with no browser wallet: the NEARKITS wallets’ value, not “connect a wallet” zeros', async () => {
    const { services } = setup({ browser: false, web: true })
    const s = await services.portfolio.getSummary()
    expect(s.valueUsd).toBeCloseTo(15, 6)
    expect(s.executableWalletCount).toBe(1)
    expect(s.availableNear).toBeCloseTo(3, 6)
  })

  it('a browser wallet and NEARKITS wallets: both, as executable wallets', async () => {
    const { services } = setup({ browser: true, web: true })
    await services.wallets.connect('fake')
    expect((await services.portfolio.getSummary()).valueUsd).toBeCloseTo(25, 6)
  })

  it('neither: nothing to value', async () => {
    const { services } = setup({ browser: false, web: false })
    expect((await services.portfolio.getSummary()).executableWalletCount).toBe(0)
    expect(await services.portfolio.getValueHistory(1)).toEqual([])
  })

  it('each read is recorded (one sample per 5 minutes): 1D is what was seen in the last 24 hours', async () => {
    const { services, advance } = setup({ browser: false, web: true })
    await services.portfolio.getSummary()
    advance(MIN)
    await services.portfolio.getSummary()
    advance(5 * MIN)
    await services.portfolio.getSummary()
    const day = await services.portfolio.getValueHistory(1)
    expect(day).toHaveLength(2)
    expect(day.every((p) => Math.abs(p.valueUsd - 15) < 1e-6)).toBe(true)
    expect((day[1]?.t ?? 0) - (day[0]?.t ?? 0)).toBe(6 * MIN)
    // A day later, the first samples are out of the 1D window but still in 7D.
    advance(25 * 60 * MIN)
    await services.portfolio.getSummary()
    expect(await services.portfolio.getValueHistory(1)).toHaveLength(1)
    expect(await services.portfolio.getValueHistory(7)).toHaveLength(3)
  })
})

describe('several NEARKITS wallets, and a NEARKITS server that fails', () => {
  it('every NEARKITS wallet of the session counts: two wallets are one total, one NEAR figure, one history', async () => {
    const { services } = setup({ browser: false, web: true, wallets: [MAIN, DEGEN] })
    const s = await services.portfolio.getSummary()
    expect(s.executableWalletCount).toBe(2)
    expect(s.availableNear).toBeCloseTo(7, 6)
    expect(s.valueUsd).toBeCloseTo(35, 6)
    expect(s.unavailableWalletCount).toBe(0)
    const history = await services.portfolio.getValueHistory(1)
    expect(history.map((p) => Math.round(p.valueUsd))).toEqual([35])
  })

  it('the server fails after it listed them: they stay listed, marked unavailable, their on-chain value still counted; no history sample while it lasts', async () => {
    const { services, server, advance } = setup({ browser: false, web: true, wallets: [MAIN, DEGEN] })
    await services.portfolio.getSummary()
    advance(6 * MIN)
    server.mode = 'down'
    const listed = await services.wallets.listWallets()
    expect(listed.map((w) => [w.accountId, w.unavailable])).toEqual([
      [NK, expect.stringMatching(/NEARKITS server can’t be reached/)],
      [NK2, expect.stringMatching(/NEARKITS server can’t be reached/)],
    ])
    const s = await services.portfolio.getSummary()
    expect(s.executableWalletCount).toBe(2)
    expect(s.valueUsd).toBeCloseTo(35, 6)
    expect(s.unavailableWalletCount).toBe(2)
    // The chart keeps only what was read whole: the sample before the failure, none during it.
    expect(await services.portfolio.getValueHistory(1)).toHaveLength(1)
    advance(6 * MIN)
    server.mode = 'up'
    const back = await services.portfolio.getSummary()
    expect(back.unavailableWalletCount).toBe(0)
    expect((await services.wallets.listWallets()).every((w) => !w.unavailable)).toBe(true)
    expect(await services.portfolio.getValueHistory(1)).toHaveLength(2)
  })

  it('the server fails before it ever listed them: the portfolio read fails (never $0, no sample); pickers keep the browser wallet', async () => {
    const { services, server } = setup({ browser: true, web: true, wallets: [MAIN, DEGEN] })
    await services.wallets.connect('fake')
    server.mode = 'down'
    await expect(services.portfolio.getSummary()).rejects.toThrow(/NEARKITS wallets can’t be listed right now/)
    await expect(services.portfolio.listPositions()).rejects.toThrow(/NEARKITS wallets can’t be listed right now/)
    await expect(services.portfolio.getPnl('7d')).rejects.toThrow(/NEARKITS wallets can’t be listed right now/)
    await expect(services.wallets.listSnapshots()).rejects.toThrow(/NEARKITS wallets can’t be listed right now/)
    expect(await services.portfolio.getValueHistory(1)).toEqual([])
    expect((await services.wallets.listWallets()).map((w) => w.accountId)).toEqual([BROWSER])
  })

  it('the server ended the session: signed out of NEARKITS web, so no NEARKITS wallet is listed, and none is “unavailable”', async () => {
    const { services, server } = setup({ browser: true, web: true, wallets: [MAIN] })
    await services.wallets.connect('fake')
    expect((await services.wallets.listWallets()).map((w) => w.accountId)).toEqual([NK, BROWSER])
    server.mode = 'end'
    const after = await services.wallets.listWallets()
    expect(after.map((w) => [w.accountId, w.unavailable ?? null])).toEqual([[BROWSER, null]])
    const s = await services.portfolio.getSummary()
    expect(s.executableWalletCount).toBe(1)
    expect(s.unavailableWalletCount).toBe(0)
  })

  it('a wallet whose NEAR balance can’t be read is unavailable, never 0 NEAR, and no history sample is recorded meanwhile', async () => {
    const { services, failing, advance } = setup({ browser: false, web: true, wallets: [MAIN, DEGEN], failBalance: [NK2] })
    const snapshots = await services.wallets.listSnapshots()
    expect(snapshots.map((s) => [s.accountId, Boolean(s.unavailable)])).toEqual([
      [NK, false],
      [NK2, true],
    ])
    expect(snapshots.find((s) => s.accountId === NK2)?.unavailable).toMatch(/balance can’t be read/)
    const s = await services.portfolio.getSummary()
    expect(s.unavailableWalletCount).toBe(1)
    expect(await services.portfolio.getValueHistory(1)).toEqual([])
    // Read again once it answers: whole, and recorded.
    failing.clear()
    advance(6 * MIN)
    services.execution.forgetBalances([NK2])
    const whole = await services.portfolio.getSummary()
    expect(whole.unavailableWalletCount).toBe(0)
    expect(whole.valueUsd).toBeCloseTo(35, 6)
    expect(await services.portfolio.getValueHistory(1)).toHaveLength(1)
  })
})
