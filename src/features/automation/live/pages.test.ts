import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import { Toaster } from '@/components/ui/Toaster'
import type { AutomationFeatures, DetectionView, StrategyDetail, StrategyView } from '@/lib/automation/api'
import type { LimitConfig, SniperSettings, StrategyKind } from '@/lib/automation/config'
import CopyTradePage from '@/pages/CopyTradePage'
import DcaPage from '@/pages/DcaPage'
import DocsPage from '@/pages/DocsPage'
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
import { StrategyDetailPanel } from './parts'

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
/** What NEARKITS' server says it runs on its public /health (read without a session). */
const running = (kinds: StrategyKind[]): [readonly unknown[], unknown] => [qk.serverAutomation, kinds]

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

  it('the form leads (first in reading and focus order, the wide column); with nothing yet the list is one compact line, no empty tabs', async () => {
    const pages: [ReactNode, string, StrategyKind, RegExp, RegExp][] = [
      [h(LimitOrdersPage), '/limit-orders', 'limit', /New order/, /Your orders/],
      [h(DcaPage), '/dca', 'dca', /New DCA plan/, /Your DCA plans/],
      [h(CopyTradePage), '/copy-trade', 'copy', /New Copy Trade rule/, /Your Copy Trade rules/],
      [h(SniperPage), '/sniper', 'sniper', /New sniper/, /Your snipers/],
    ]
    for (const [el, path, kind, form, mine] of pages) {
      const html = await render(el, path, { data: [on([kind]), list(kind, [])] })
      const text = read(html)
      expect(text.search(form), path).toBeGreaterThan(-1)
      expect(text.search(form), path).toBeLessThan(text.search(mine))
      // The shared frame: a field grid that turns two-column by the form's own width.
      expect(html, path).toContain('data-form-grid')
      expect(html, path).toContain('xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]')
      expect(text, path).toContain('Nothing active Nothing running. Create one with the form.')
      expect(html, path).not.toMatch(/role="tab"/)
    }
    // With strategies, the tabs are back.
    const html = await render(h(LimitOrdersPage), '/limit-orders', { data: [on(['limit']), list('limit', [strategy({})])] })
    expect(html).toMatch(/role="tab"/)
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

  it('no NEARKITS session, the server runs limit orders (public /health): the live page asks to sign in; no drafts, no form, no "coming soon"', async () => {
    const html = await render(h(LimitOrdersPage), '/limit-orders', { signedIn: false, data: [running(['limit', 'dca', 'sniper', 'copy'])] })
    const text = read(html)
    expect(text).toContain('Live · NEARKITS wallets')
    expect(text).toContain('Sign in with Telegram to use Limit Orders')
    expect(text).toMatch(/NEARKITS wallets, run by NEARKITS’ server/)
    expect(text).not.toMatch(/Drafts only|not part of the public beta|coming soon/i)
    expect(buttons(html)).not.toContain('Review limit buy')
  })

  it('no NEARKITS session and the server doesn’t run it (another kind, or none): the page as it was', async () => {
    for (const kinds of [['dca'], []] as StrategyKind[][]) {
      const text = read(await render(h(LimitOrdersPage), '/limit-orders', { signedIn: false, data: [running(kinds)] }))
      expect(text).toContain('Drafts only · not monitored')
      expect(text).not.toContain('Live · NEARKITS wallets')
    }
  })

  it('while the answer that decides is on its way, neither drafts nor the live form flash up', async () => {
    // No session, the public answer not in yet; then a session whose own answer isn't in yet.
    for (const signedIn of [false, true]) {
      const html = await render(h(LimitOrdersPage), '/limit-orders', { signedIn })
      const text = read(html)
      expect(text).not.toMatch(/Drafts only|Review limit buy|Sign in with Telegram/)
      expect(html).toContain('aria-busy="true"')
    }
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

  it('without a NEARKITS session, each asks to sign in when the server runs it', async () => {
    for (const [page, path, feature] of [
      [CopyTradePage, '/copy-trade', 'Copy Trade'],
      [SniperPage, '/sniper', 'Sniper'],
      [DcaPage, '/dca', 'DCA'],
    ] as const) {
      const text = read(await render(h(page), path, { signedIn: false, data: [running(['limit', 'dca', 'sniper', 'copy'])] }))
      expect(text, feature).toContain(`Sign in with Telegram to use ${feature}`)
      expect(text, feature).toContain('Live · NEARKITS wallets')
      expect(text, feature).not.toMatch(/coming soon|not part of the public beta/i)
    }
  })

  it('each page stays as it was when only another kind is on', async () => {
    expect(read(await render(h(CopyTradePage), '/copy-trade', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
    expect(read(await render(h(SniperPage), '/sniper', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
    expect(read(await render(h(DcaPage), '/dca', { data: [on(['limit'])] }))).not.toContain('Live · NEARKITS wallets')
  })
})

const USDT_ID = 'usdt.tether-token.near'
const HASH = '7Hd2kq8yW3vX1sPzN5aBcDeFgHjKmNoPqRsTuVwXyZ1a'

const poolSniper = (o: Partial<SniperSettings> = {}): StrategyView =>
  strategy({
    kind: 'sniper',
    subject: 'new-pools',
    lastPriceNear: null,
    config: {
      kind: 'sniper',
      sniper: {
        target: 'new-pools',
        token: null,
        sources: ['nearly', 'meme-cooking'],
        minPoolNear: 5,
        maxBuys: 3,
        amountNear: 1,
        slippagePct: 1,
        maxImpactPct: 10,
        minLiquidityUsd: null,
        maxAttempts: 3,
        expiresAt: null,
        mode: 'notify',
        ...o,
      },
    },
  })

const detection = (o: Partial<DetectionView>): DetectionView => ({
  sourceKey: 'x',
  at: Date.now() - 60_000,
  side: null,
  token: null,
  tokenRaw: null,
  nearRaw: null,
  status: 'detected',
  reason: null,
  ...o,
})

const detail = (s: StrategyView, o: Partial<StrategyDetail> = {}): [readonly unknown[], unknown] => [
  qk.autoDetail(TOKEN, s.id),
  { strategy: s, executions: [], events: [], detections: [], ...o } satisfies StrategyDetail,
]

describe('Sniper: one token, or new pools', RENDERS, () => {
  it('the form starts on one token, notify only; the switch offers new pools', async () => {
    const html = await render(h(SniperPage), '/sniper', { data: [on(['sniper']), list('sniper', [])] })
    const text = read(html)
    expect(buttons(html)).toEqual(expect.arrayContaining(['One token', 'New pools', 'Notify only', 'Buy', 'Review sniper']))
    expect(html).toMatch(/aria-checked="true"[^>]*>One token</)
    expect(html).toMatch(/aria-checked="true"[^>]*>Notify only</)
    expect(text).toContain('Token contract')
    expect(text).toContain('or new pools as Ref DCL and Ref v2 create them')
  })

  it('lists a new-pools sniper in words, with what it waits for', async () => {
    const text = read(
      await render(h(SniperPage), '/sniper', {
        data: [
          on(['sniper']),
          list(
            'sniper',
            [poolSniper(), poolSniper({ mode: 'execute' })].map((s, i) => ({ ...s, id: `p${i}`, waiting: i ? 'This server doesn’t read new pools' : null })),
          ),
        ],
      }),
    )
    expect(text).toContain('Notify only: new pools from Nearly launches, meme.cooking · pool ≥ 5 NEAR · 1 NEAR each')
    expect(text).toContain('Buys up to 3 new tokens from Nearly launches, meme.cooking · pool ≥ 5 NEAR · 1 NEAR each')
    expect(text).toContain('Waiting: This server doesn’t read new pools')
  })

  it('the demo’s Sniper page is unaffected (no server, no new-pools switch)', async () => {
    const html = await render(h(SniperPage), '/sniper', { demo: true, data: [on(['limit', 'copy', 'sniper', 'dca'])] })
    expect(read(html)).not.toContain('Live · NEARKITS wallets')
    expect(buttons(html)).not.toContain('New pools')
  })

  it('detail: the pools it saw by exchange and pool id; "Seen" is not a trade; a buy is not confirmed before the chain says so', async () => {
    const s = poolSniper({ mode: 'execute' })
    const html = await render(h(StrategyDetailPanel, { id: s.id, onClose: () => undefined }), '/sniper', {
      data: [
        detail(s, {
          detections: [
            detection({ sourceKey: 'pool:dcl:abc.near|wrap.near|2000', side: 'buy', token: 'abc.near', status: 'detected', reason: 'Waiting for a route from a NEARKITS wallet' }),
            detection({ sourceKey: 'pool:ref:5123', side: 'buy', token: 'cook.meme-cooking.near', status: 'skipped', reason: 'The pool holds 2 NEAR, below this sniper’s 5 NEAR' }),
          ],
          executions: [
            {
              id: 'e1',
              side: 'buy',
              token: 'abc.near',
              status: 'submitted',
              amountInRaw: '1000000000000000000000000',
              expectedOutRaw: '5000',
              minOutRaw: '4950',
              nearRaw: null,
              tokenRaw: null,
              priceNear: null,
              txHashes: [HASH],
              message: 'Sniper buy of ABC (a new Nearly launch)',
              source: 'pool:dcl:abc.near|wrap.near|2000',
              createdAt: Date.now() - 30_000,
              updatedAt: Date.now(),
            },
          ],
        }),
      ],
    })
    const text = read(html)
    expect(text).toContain('New pools seen')
    expect(text).toContain('New pool')
    expect(text).toContain('Ref DCL pool abc.near|wrap.near|2000 · abc.near')
    expect(text).toContain('Ref v2 pool 5123')
    expect(text).toContain('Seen')
    expect(text).toContain('Waiting for a route from a NEARKITS wallet')
    expect(text).toContain('New pools from Nearly launches, meme.cooking')
    expect(text).toContain('Tokens bought (on chain) 0 of 3')
    expect(text).toContain('Submitted · not confirmed')
    expect(text).not.toMatch(/Confirmed on chain|Bought · confirmed|Filled/)
    expect(html).toContain(`href="https://nearblocks.io/txns/${HASH}"`)
  })

  it('detail of an empty new-pools sniper says pools from before it are never reported', async () => {
    const s = poolSniper()
    const text = read(await render(h(StrategyDetailPanel, { id: s.id, onClose: () => undefined }), '/sniper', { data: [detail(s)] }))
    expect(text).toContain('No new pool from its sources yet. Pools made before this sniper are never reported.')
    expect(text).not.toContain('Tokens bought')
  })
})

describe('Copy Trade detail: token-for-token swaps copied as NEAR legs', RENDERS, () => {
  it('the swap is "Seen", each leg names its side and links the followed account’s transaction', async () => {
    const s = strategy({
      kind: 'copy',
      subject: 'trader.near',
      lastPriceNear: null,
      waiting: 'FastNEAR’s index is 45 s behind the chain: trades seen late are not copied',
      config: {
        kind: 'copy',
        copy: {
          target: 'trader.near',
          copy: 'both',
          sizing: { mode: 'fixed', amountNear: 1 },
          maxTradeNear: 5,
          minTradeNear: null,
          maxExposureNear: 20,
          slippagePct: 1,
          minLiquidityUsd: null,
          exclude: [],
        },
      },
    })
    const html = await render(h(StrategyDetailPanel, { id: s.id, onClose: () => undefined }), '/copy-trade', {
      data: [
        detail(s, {
          detections: [
            detection({ sourceKey: HASH, token: USDT_ID, status: 'detected', reason: `A swap of abc.near for ${USDT_ID}: copied as NEAR trades` }),
            detection({
              sourceKey: `${HASH}:sell`,
              side: 'sell',
              token: 'abc.near',
              tokenRaw: '1000',
              status: 'skipped',
              reason: 'Nothing this rule bought of ABC is left to sell',
            }),
            detection({ sourceKey: `${HASH}:buy`, side: 'buy', token: USDT_ID, tokenRaw: '5000000', status: 'submitted' }),
          ],
        }),
      ],
    })
    const text = read(html)
    expect(text).toContain('Detected trades')
    expect(text).toContain('Copied sell leg')
    expect(text).toContain('Copied buy leg')
    expect(text).toContain('Seen')
    expect(text).toContain('copied as NEAR trades')
    expect(text).toContain('Waiting: FastNEAR’s index is 45 s behind the chain')
    expect(text).not.toMatch(/Copied · confirmed|Confirmed on chain/)
    // The leg rows link the transaction (before the colon), like every tx link.
    expect(html.match(new RegExp(`href="https://nearblocks.io/txns/${HASH}"`, 'g'))?.length).toBe(3)
    expect(html).not.toContain(`txns/${HASH}%3A`)
    // A long reason or wait wraps on a narrow screen instead of overflowing it.
    expect(html).toMatch(/class="[^"]*wrap-break-word[^"]*"[^>]*><span>Waiting: FastNEAR/)
  })
})

describe('Limit orders: a take profit / stop loss pair', RENDERS, () => {
  it('is tagged as a pair whose orders are cancelled together; each keeps its own Cancel', async () => {
    const tp = strategy({
      id: 'tp',
      ocoGroup: 'oco-1',
      config: {
        kind: 'limit',
        limit: {
          type: 'take-profit',
          token: { id: USDT_ID, symbol: 'USDt', decimals: 6 },
          amount: { kind: 'percent', value: 100 },
          triggerPriceNear: '0.5',
          slippagePct: 1,
          expiresAt: null,
        },
      },
    })
    const sl = {
      ...tp,
      id: 'sl',
      config: { kind: 'limit' as const, limit: { ...(tp.config as { kind: 'limit'; limit: LimitConfig }).limit, type: 'stop-loss' as const, triggerPriceNear: '0.2' } },
    }
    const html = await render(h(LimitOrdersPage), '/limit-orders', { data: [on(['limit']), list('limit', [tp, sl])] })
    expect(html).toContain('cancelling either cancels both')
    expect(buttons(html).filter((b) => b === 'Cancel')).toHaveLength(2)
  })
})

describe('the Documentation’s automation status, from the same answer the pages use', RENDERS, () => {
  const rows = (text: string) => text.slice(text.indexOf('Wallet presets'), text.indexOf('Telegram bot'))

  it('the server runs all four, no session: each live from NEARKITS wallets after Telegram sign-in; a browser wallet can’t run them', async () => {
    const text = read(await render(h(DocsPage), '/docs', { signedIn: false, data: [running(['limit', 'dca', 'sniper', 'copy'])] }))
    const status = rows(text)
    for (const area of ['Limit Orders (limit, take profit, stop loss)', 'DCA', 'Copy Trade', 'Sniper'])
      expect(status).toContain(`${area} Ready Live on mainnet: NEARKITS wallets, after Telegram sign-in`)
    expect(status).toContain('Automations from a connected browser wallet — Not supported: they run only from NEARKITS wallets')
    expect(text).toContain('Limit Orders, DCA, Copy Trade and the Sniper run on NEARKITS’ server on NEAR mainnet, from your NEARKITS wallets')
    expect(text).toContain('A browser wallet you connect can’t run them')
    // (The Telegram bot and NEARKITS wallets rows follow the test build, which names no bot or server.)
    expect(status.slice(status.indexOf('Limit Orders'))).not.toMatch(/COMING SOON|Not live on this site yet|Drafts/)
    expect(text.slice(text.indexOf('NEARKITS Volume Bot'))).not.toMatch(/coming soon/i)
  })

  it('the server runs only DCA: DCA live, the others as this build keeps them (drafts on the dev server)', async () => {
    const text = read(await render(h(DocsPage), '/docs', { signedIn: false, data: [running(['dca'])] }))
    expect(rows(text)).toContain('DCA Ready Live on mainnet')
    expect(rows(text)).toContain('Copy Trade Ready Drafts saved, nothing runs')
    expect(text).toContain('DCA runs on NEARKITS’ server on NEAR mainnet')
    expect(text).toContain('Limit Orders, Copy Trade and the Sniper are not running now')
  })

  it('the demo: simulated standby rules, and no browser-wallet row', async () => {
    const text = read(await render(h(DocsPage), '/docs', { demo: true }))
    expect(rows(text)).toContain('Sniper Ready Saved in standby, nothing runs')
    expect(text).not.toContain('Automations from a connected browser wallet')
    expect(text).toContain('saved as drafts in this browser (in standby in the demo)')
  })
})
