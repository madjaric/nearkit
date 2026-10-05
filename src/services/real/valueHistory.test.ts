import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/config/env'
import { NETWORKS } from '@/config/networks'
import type { NearKitWeb, NearKitWebWallet } from '../nearkitWeb'
import { createNearServices } from './index'
import { memoryStorage } from './stores'
import { createFakeChain, fakeWallet } from './testing/fakeChain'

/**
 * The dashboard's portfolio value and its history on mainnet prices (NEAR at $5): the value of the
 * executable wallets (NearKit wallets with or without a browser wallet), recorded as it is read.
 */

const ONE = 10n ** 24n
const NK = 'a'.repeat(64)
const BROWSER = 'alice.near'
const MIN = 60_000

function setup(opts: { browser: boolean; web: boolean }) {
  let now = Date.UTC(2026, 9, 5, 12)
  const chain = createFakeChain({ accounts: { [NK]: { amount: 3n * ONE }, [BROWSER]: { amount: 2n * ONE } } })
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/ticker', () => ({ price: '5.00' }))
  chain.route('https://api.exchange.coinbase.com/products/NEAR-USD/stats', () => ({ open: '5', last: '5' }))
  chain.route('https://api.rhea.finance/list-token-price', () => ({}))
  const { env } = parseEnv({ VITE_NEAR_NETWORK: 'mainnet', VITE_NEARKIT_FEE_RECIPIENT: 'fees.example.near' })
  const wallet = fakeWallet(opts.browser ? { walletId: 'fake', walletName: 'Fake', accounts: [BROWSER], batch: true } : null)
  const list: NearKitWebWallet[] = [{ id: 'nk-1', accountId: NK, name: 'Main', slot: 1, owner: BROWSER, frozen: false, createdAt: 1 }]
  const unused = () => Promise.reject(new Error('not used here'))
  const nearkit = {
    available: true,
    session: () => (opts.web ? { token: 'T'.repeat(43), expiresAt: now + 60 * MIN, userName: 'Tess' } : null),
    wallets: async () => (opts.web ? { wallets: [...list], limit: 10, canCreate: true } : null),
    subscribe: () => () => undefined,
    login: unused,
    logout: async () => undefined,
  } as unknown as NearKitWeb
  const services = createNearServices({ env, network: NETWORKS.mainnet, fetch: chain.fetch, kv: memoryStorage(), wallet: async () => wallet.adapter, nearkit, now: () => now })
  return { services, advance: (ms: number) => (now += ms), wallet }
}

describe('the dashboard’s portfolio value', () => {
  it('signed in to NearKit web with no browser wallet: the NearKit wallets’ value, not “connect a wallet” zeros', async () => {
    const { services } = setup({ browser: false, web: true })
    const s = await services.portfolio.getSummary()
    expect(s.valueUsd).toBeCloseTo(15, 6)
    expect(s.executableWalletCount).toBe(1)
    expect(s.availableNear).toBeCloseTo(3, 6)
  })

  it('a browser wallet and NearKit wallets: both, as executable wallets', async () => {
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
