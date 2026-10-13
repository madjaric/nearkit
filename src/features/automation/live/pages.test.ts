import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import { Toaster } from '@/components/ui/Toaster'
import type { AutomationFeatures, StrategyView } from '@/lib/automation/api'
import type { StrategyKind } from '@/lib/automation/config'
import CopyTradePage from '@/pages/CopyTradePage'
import DcaPage from '@/pages/DcaPage'
import LimitOrdersPage from '@/pages/LimitOrdersPage'
import SniperPage from '@/pages/SniperPage'
import { createMockServices } from '@/services/mock'
import { createNearKitWeb, type NearKitWalletList, type NearKitWebSession } from '@/services/nearkitWeb'
import { qk } from '@/services/queries'
import { memoryStorage } from '@/services/real/stores'
import { ServicesProvider } from '@/services/ServicesProvider'
import type { Capabilities, NearKitServices } from '@/services/types'
import { ConnectProvider } from '@/state/ConnectProvider'
import { SettingsProvider } from '@/state/SettingsProvider'
import { TradeDrawerProvider } from '@/state/TradeDrawerProvider'
import type { TokenListing } from '@/types/domain'

/**
 * Which automation page a user sees, rendered as the app renders it. The server-backed page appears
 * only with real services, a NEARKITS web session, and the kind switched on by NEARKITS' server;
 * otherwise the page is exactly what it was (drafts in real mode, the demo's own in the demo).
 */

const API = 'https://api.nearkits.test'
const TOKEN = 'T'.repeat(43)
const WEB: NearKitWebSession = { token: TOKEN, expiresAt: Date.now() + 3_600_000, userName: 'Tess', userHandle: 'tess' }

const CAPS: Capabilities = {
  mode: 'near',
  network: 'mainnet',
  networkLabel: 'Mainnet',
  explorerUrl: 'https://nearblocks.io',
  rpcUrls: [],
  prices: true,
  pnl: true,
  automation: 'drafts',
  execution: { enabled: true, simulated: false, reason: null, trading: { enabled: true, reason: null, router: 'aggregator', feeCharged: true, feeRecipient: 'fees.near' } },
  kitContract: null,
  configIssues: [],
}

const features = (enabled: StrategyKind[], paused = false): AutomationFeatures => ({
  enabled,
  paused,
  pausedReason: paused ? 'NEARKITS has paused automated trading' : null,
  limits: { maxTradeNear: 50, maxDailyNearPerUser: 200, maxSlippagePct: 5 },
})

const WALLETS: NearKitWalletList = {
  wallets: [{ id: 'w1', accountId: 'a'.repeat(64), name: 'Main', slot: 1, owner: null, frozen: false, createdAt: 1 }],
  limit: 10,
  canCreate: true,
}

const strategy = (o: Partial<StrategyView>): StrategyView => ({
  id: 's1',
  kind: 'limit',
  status: 'active',
  walletId: 'w1',
  walletName: 'Main',
  subject: 'usdt.tether-token.near',
  config: {
    kind: 'limit',
    limit: {
      type: 'limit-buy',
      token: { id: 'usdt.tether-token.near', symbol: 'USDt', decimals: 6 },
      amount: { kind: 'near', value: '2' },
      triggerPriceNear: '0.25',
      slippagePct: 1,
      expiresAt: null,
    },
  },
  statusReason: null,
  waiting: null,
  lastPriceNear: '0.3012',
  lastQuoteAt: Date.now() - 60_000,
  ocoGroup: null,
  attempts: 0,
  expiresAt: null,
  createdAt: Date.now() - 3_600_000,
  updatedAt: Date.now(),
  closedAt: null,
  ...o,
})

let tokens: TokenListing[]
beforeAll(async () => {
  tokens = await createMockServices().tokens.listTokens()
})

interface Setup {
  demo?: boolean
  signedIn?: boolean
  data?: [readonly unknown[], unknown][]
}

async function render(el: ReactNode, path: string, o: Setup = {}): Promise<string> {
  const base = createMockServices()
  const store = memoryStorage()
  if (o.signedIn !== false) store.set('nearkit:web-session:mainnet', JSON.stringify(WEB))
  const services: NearKitServices = o.demo
    ? base
    : {
        ...base,
        mode: 'near',
        capabilities: CAPS,
        nearkit: createNearKitWeb({ apiUrl: API, network: 'mainnet', store, fetchImpl: (async () => Promise.reject(new Error('no network in tests'))) as typeof fetch }),
      }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(qk.session, null)
  qc.setQueryData(qk.tokens, tokens)
  qc.setQueryData(qk.wallets, [])
  qc.setQueryData(qk.presets, [])
  qc.setQueryData(qk.orders, [])
  qc.setQueryData(qk.dca, [])
  qc.setQueryData(qk.copy, [])
  qc.setQueryData(qk.sniper, [])
  qc.setQueryData(qk.nearkitWallets(TOKEN), WALLETS)
  for (const [key, value] of o.data ?? []) qc.setQueryData(key, value)
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return renderToStaticMarkup(
    h(
      ServicesProvider,
      { services, children: null },
      h(QueryClientProvider, { client: qc }, h(SettingsProvider, null, h(Toaster, null, h(ConnectProvider, null, h(TradeDrawerProvider, null, h(RouterProvider, { router })))))),
    ),
  )
}

const read = (html: string) =>
  html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => read(m[1] as string))

const RENDERS = { timeout: 30_000 }
const on = (kinds: StrategyKind[], paused = false): [readonly unknown[], unknown] => [qk.autoFeatures(TOKEN), features(kinds, paused)]
const list = (kind: StrategyKind, items: StrategyView[]): [readonly unknown[], unknown] => [[...qk.autoList(TOKEN), kind], items]

describe('Limit Orders, server-backed when NEARKITS switched it on', RENDERS, () => {
  it('signed in with limit orders on: the live form, NEARKITS wallets only, review before create, honest terms', async () => {
    const html = await render(h(LimitOrdersPage), '/limit-orders', { data: [on(['limit']), list('limit', [])] })
    const text = read(html)
    expect(text).toContain('Live · NEARKITS wallets')
    expect(text).toContain('NEARKITS wallet')
    expect(text).toContain('Main ·')
    expect(text).toContain('the price is not guaranteed')
    expect(buttons(html)).toContain('Review limit buy')
    expect(text).not.toMatch(/Drafts only|never fills/)
    expect(text).toContain('Nothing active')
  })

  it('lists orders with their state, last price seen, what they wait for, and only the controls the state allows', async () => {
    const html = await render(h(LimitOrdersPage), '/limit-orders', {
      data: [
        on(['limit']),
        list('limit', [strategy({ id: 's1', status: 'active', waiting: 'enough NEAR in the wallet' }), strategy({ id: 's2', status: 'submitted', lastPriceNear: '0.2499' })]),
      ],
    })
    const text = read(html)
    expect(text).toContain('Limit buy · 2 NEAR · ≤ 0.25 NEAR')
    expect(text).toContain('last price 0.3012 NEAR')
    expect(text).toContain('Waiting: enough NEAR in the wallet')
    expect(text).toContain('Submitted')
    // One order waits (pause, cancel); the other's trade is under way: no control until it settles.
    expect(buttons(html).filter((b) => b === 'Pause')).toHaveLength(1)
    expect(buttons(html).filter((b) => b === 'Cancel')).toHaveLength(1)
    expect(buttons(html)).toContain('Pause all my automations')
    expect(text).not.toMatch(/Filled|Confirmed on chain/)
  })

  it('NEARKITS’ kill switch is said, with its reason', async () => {
    const text = read(await render(h(LimitOrdersPage), '/limit-orders', { data: [on(['limit'], true), list('limit', [])] }))
    expect(text).toContain('NEARKITS has paused automated trading. Nothing triggers or trades until it resumes')
  })

  it('the kind not switched on: the page as it was (drafts in real mode)', async () => {
    const text = read(await render(h(LimitOrdersPage), '/limit-orders', { data: [on(['dca'])] }))
    expect(text).toContain('Drafts only · not monitored')
    expect(text).not.toContain('Live · NEARKITS wallets')
  })

  it('no NEARKITS session: the page as it was, whatever was read before', async () => {
    const text = read(await render(h(LimitOrdersPage), '/limit-orders', { signedIn: false, data: [on(['limit'])] }))
    expect(text).not.toContain('Live · NEARKITS wallets')
  })

  it('the demo is unaffected, even with a features answer in the cache', async () => {
    const text = read(await render(h(LimitOrdersPage), '/limit-orders', { demo: true, data: [on(['limit', 'copy', 'sniper', 'dca'])] }))
    expect(text).toContain('Not monitored')
    expect(text).not.toContain('Live · NEARKITS wallets')
  })
})

describe('Copy Trade, Sniper and DCA, server-backed when switched on', RENDERS, () => {
  it('Copy Trade: the rule form with its limits; NEARKITS wallets can’t be followed', async () => {
    const html = await render(h(CopyTradePage), '/copy-trade', { data: [on(['copy']), list('copy', [])] })
    const text = read(html)
    expect(text).toContain('Live · NEARKITS wallets')
    expect(text).toContain('Max exposure')
    expect(text).toContain('NEARKITS wallets can’t be followed')
    expect(buttons(html)).toContain('Review rule')
  })

  it('Sniper: notify only unless buying is chosen and confirmed', async () => {
    const html = await render(h(SniperPage), '/sniper', { data: [on(['sniper']), list('sniper', [])] })
    const text = read(html)
    expect(text).toContain('Live · NEARKITS wallets')
    expect(html).toMatch(/aria-checked="true"[^>]*>Notify only|Notify only/)
    expect(buttons(html)).toContain('Review sniper')
  })

  it('DCA: interval, start, end and slippage', async () => {
    const html = await render(h(DcaPage), '/dca', { data: [on(['dca']), list('dca', [])] })
    const text = read(html)
    expect(text).toContain('Live · NEARKITS wallets')
    expect(text).toContain('Every day')
    expect(buttons(html)).toContain('Review plan')
  })

  it('each page stays as it was when only another kind is on', async () => {
    expect(read(await render(h(CopyTradePage), '/copy-trade', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
    expect(read(await render(h(SniperPage), '/sniper', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
    expect(read(await render(h(DcaPage), '/dca', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
  })
})
